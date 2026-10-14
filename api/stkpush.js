const { getDatabase, initializeDatabase } = require('../lib/database');

function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '+254' + compact.slice(1);
  if (/^\+254[17]\d{8}$/.test(compact)) return compact;
  return null;
}

function callbackBase(req) {
  if (process.env.COURTNEY_CALLBACK_BASE_URL) return process.env.COURTNEY_CALLBACK_BASE_URL.replace(/\/$/, '');
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${protocol}://${host}`;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const apiKey = process.env.COURTNEY_API_KEY;
  const apiSecret = process.env.COURTNEY_API_SECRET;
  const accountId = Number(process.env.COURTNEY_ACCOUNT_ID);
  const baseUrl = (process.env.COURTNEY_BASE_URL || 'https://courtneytech.xyz/api').replace(/\/$/, '');
  if (!apiKey || !apiSecret || !Number.isInteger(accountId)) {
    return res.status(503).json({ error: 'STK Push is not configured yet. Add COURTNEY_API_KEY, COURTNEY_API_SECRET, and COURTNEY_ACCOUNT_ID in Vercel.' });
  }

  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const idNumber = String(body.idNumber || '').trim();
    const phone = normalizePhone(body.phone);
    const amount = Math.floor(Number(body.amount));
    if (!name || !/^\d{8}$/.test(idNumber) || !phone || !Number.isInteger(amount) || amount < 1) {
      return res.status(400).json({ error: 'Enter valid tenant details and a payment amount of at least Ksh 1.' });
    }

    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');
    const tenant = await tenants.findOne({ id: Number(body.tenantId), idNumber, phone, status: { $in: ['pending', 'accepted'] } });
    if (!tenant || String(tenant.name || '').toLowerCase() !== name.toLowerCase()) return res.status(401).json({ error: 'Tenant details could not be verified.' });
    const balance = Math.max(0, Number(tenant.expected || 0) - Number(tenant.paid || 0));
    if (balance < 1) return res.status(400).json({ error: 'This tenant account has no outstanding balance.' });
    if (amount > balance) return res.status(400).json({ error: `Payment cannot exceed the current balance of Ksh ${balance.toLocaleString()}.` });

    const reference = `R${String(tenant.id).slice(-10)}`.slice(0, 12);
    const callbackSecret = process.env.COURTNEY_CALLBACK_SECRET ? `?secret=${encodeURIComponent(process.env.COURTNEY_CALLBACK_SECRET)}` : '';
    const response = await fetch(`${baseUrl}/v2/stkpush`, {
      method: 'POST',
      headers: { 'X-API-Key': apiKey, 'X-API-Secret': apiSecret, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payment_account_id: accountId,
        phone,
        amount,
        reference,
        description: 'Rent payment',
        callback_url: `${callbackBase(req)}/api/stk-callback${callbackSecret}`,
        success_callback_url: `${callbackBase(req)}/api/stk-callback${callbackSecret}`
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.success === false) {
      return res.status(502).json({ error: payload.message || 'The STK Push provider rejected the request.' });
    }

    const pendingPayment = {
      transactionId: payload.transactionId || null,
      checkoutRequestId: payload.checkoutRequestId || payload.checkout_request_id || null,
      amount,
      status: 'pending',
      date: new Date().toISOString(),
      source: 'STK Push'
    };
    await tenants.updateOne({ id: tenant.id }, { $push: { stkPayments: pendingPayment } });
    return res.status(202).json({ ok: true, message: 'STK prompt sent. Check your phone and enter your M-Pesa PIN.', checkoutRequestId: pendingPayment.checkoutRequestId });
  } catch (error) {
    console.error('SEGUTON STK push error:', error);
    return res.status(502).json({ error: 'Unable to send the STK prompt right now. Please try again.' });
  }
};
