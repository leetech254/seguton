const crypto = require('crypto');
const { getDatabase, initializeDatabase } = require('../lib/database');
const { setSecurityHeaders, consumeRateLimit, rateLimitKey } = require('../lib/security');
const { normalizeKenyanPhone, phoneVariants } = require('../lib/phone');

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

function publicError(payload, status) {
  const message = payload?.message || payload?.error;
  if (status === 402) return 'LeeTec wallet balance is insufficient to start this payment. Top up the LeeTec wallet and try again.';
  if (status === 412) return 'No active LeeTec payout method is configured. Add and activate a Till or PayBill in LeeTec Workspace.';
  if (status === 401 || status === 403) return 'LeeTec API authentication failed. Check the server-side API key.';
  return message || 'LeeTec rejected the STK Push request.';
}

module.exports = async (req, res) => {
  if (!setSecurityHeaders(req, res, 'POST,OPTIONS')) return res.status(403).json({ error: 'Origin is not allowed.' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

	const apiKey = process.env.LEETEC_API_KEY;
	const baseUrl = (process.env.LEETEC_BASE_URL || 'https://leetec.online').replace(/\/$/, '');
	if (!apiKey) return res.status(503).json({ error: 'STK Push is not configured. Add LEETEC_API_KEY in Vercel.' });

  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const idNumber = String(body.idNumber || '').trim();
    const phone = normalizeKenyanPhone(body.phone, 'mpesa');
    const amount = Number(body.amount);
    if (!name || !/^\d{8}$/.test(idNumber) || !phone || !Number.isInteger(amount) || amount < 1 || amount > 1500000) {
      return res.status(400).json({ error: 'Enter valid tenant details and a whole-KES payment amount between Ksh 1 and Ksh 1,500,000.' });
    }
    const pushLimit = consumeRateLimit(rateLimitKey(req, 'stk-push', `${idNumber}:${phone}`), 3, 15 * 60 * 1000);
    if (!pushLimit.allowed) return res.status(429).setHeader('Retry-After', pushLimit.retryAfter).json({ error: 'Too many payment prompts. Try again later.' });

    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');
    const tenant = await tenants.findOne({ id: Number(body.tenantId), idNumber, phone: { $in: phoneVariants(phone) }, status: { $in: ['pending', 'accepted'] } });
    if (!tenant || String(tenant.name || '').toLowerCase() !== name.toLowerCase()) return res.status(401).json({ error: 'Tenant details could not be verified.' });

    const balance = Math.max(0, Number(tenant.expected || 0) - Number(tenant.paid || 0));
    if (balance < 1) return res.status(400).json({ error: 'This tenant account has no outstanding balance.' });
    if (amount > balance) return res.status(400).json({ error: `Payment cannot exceed the current balance of Ksh ${balance.toLocaleString()}.` });

    const requestId = crypto.randomUUID();
	const accountReference = `SEG${String(tenant.id).slice(-7)}${Date.now().toString(36).toUpperCase()}`.replace(/[^A-Z0-9]/g, '').slice(0, 12);
	const requestBody = { phoneNumber: phone, amount, accountReference, requestId };

    const response = await fetchWithTimeout(`${baseUrl}/api/v1/stkpush`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': requestId,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });
    const payload = await response.json().catch(() => ({}));
    const checkoutRequestId = payload.checkoutRequestId || payload.CheckoutRequestID || payload.checkout_request_id || null;
    if (!response.ok || payload.status === 'FAILED' || (!checkoutRequestId && !payload.requestId)) {
      return res.status(502).json({ error: publicError(payload, response.status), code: payload.code || null });
    }

    const pendingPayment = {
      requestId: payload.requestId || requestId,
      checkoutRequestId,
      accountReference,
      phone,
      amount,
      status: String(payload.status || 'PENDING').toUpperCase(),
      date: new Date().toISOString(),
      source: 'LeeTec M-Pesa STK Push'
    };
    await tenants.updateOne({ id: tenant.id }, { $push: { stkPayments: pendingPayment } });
    return res.status(202).json({ ok: true, message: 'STK prompt sent. Check your phone and enter your M-Pesa PIN.', requestId: pendingPayment.requestId, checkoutRequestId });
  } catch (error) {
    console.error('SEGUTON LeeTec STK push error:', error);
    return res.status(502).json({ error: 'Unable to send the STK prompt right now. Check the LeeTec transaction status before retrying.' });
  }
};
