const { getDatabase, initializeDatabase } = require('../lib/database');
const { notifyTenant, notifyAdmins } = require('../lib/notifications');
const { setSecurityHeaders, consumeRateLimit, rateLimitKey } = require('../lib/security');

function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '254' + compact.slice(1);
  if (/^\+254[17]\d{8}$/.test(compact)) return compact.slice(1);
  if (/^254[17]\d{8}$/.test(compact)) return compact;
  return null;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
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
    const requestId = String(body.requestId || '').trim();
    const name = String(body.name || '').trim();
    const idNumber = String(body.idNumber || '').trim();
    const phone = normalizePhone(body.phone);
    const tenantId = Number(body.tenantId);
    if (!requestId || !name || !/^\d{8}$/.test(idNumber) || !phone || !Number.isSafeInteger(tenantId)) {
      return res.status(400).json({ error: 'Invalid payment status request.' });
    }
    const statusLimit = consumeRateLimit(rateLimitKey(req, 'payment-status', requestId), 12, 10 * 60 * 1000);
    if (!statusLimit.allowed) return res.status(429).setHeader('Retry-After', statusLimit.retryAfter).json({ error: 'Too many payment status checks. Try again later.' });

    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');
    const tenant = await tenants.findOne({ id: tenantId, idNumber, phone: { $in: [phone, '+254' + phone.slice(3)] }, status: { $in: ['pending', 'accepted'] } });
    if (!tenant || String(tenant.name || '').toLowerCase() !== name.toLowerCase()) return res.status(401).json({ error: 'Tenant details could not be verified.' });

    const payment = (tenant.stkPayments || []).find(item => item.requestId === requestId);
    if (!payment) return res.status(404).json({ error: 'Payment request was not found.' });
    if (payment.status === 'SUCCESS') return res.status(200).json({ ok: true, status: 'SUCCESS', final: true });

    const response = await fetchWithTimeout(`${baseUrl}/api/v1/transactions/status?requestId=${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    const statusPayload = await response.json().catch(() => ({}));
    if (!response.ok) return res.status(502).json({ error: statusPayload.message || statusPayload.error || 'LeeTec payment status could not be checked.' });

    const status = String(statusPayload.status || 'PENDING').toUpperCase();
    if (status !== 'SUCCESS') {
      if (['FAILED', 'CANCELLED', 'MANUAL_REVIEW'].includes(status)) {
        await tenants.updateOne({ id: tenant.id, 'stkPayments.requestId': requestId, 'stkPayments.status': { $ne: 'SUCCESS' } }, { $set: { 'stkPayments.$.status': status, 'stkPayments.$.updatedAt': new Date() } });
      }
      return res.status(200).json({ ok: true, status, final: Boolean(statusPayload.final) });
    }

    const amount = Number(payment.amount);
    const receivedReference = String(statusPayload.accountReference || '');
    if (!Number.isInteger(amount) || amount < 1 || (receivedReference && receivedReference !== String(payment.accountReference || ''))) {
      return res.status(422).json({ error: 'LeeTec payment reconciliation failed.' });
    }
    if (amount > Math.max(0, Number(tenant.expected || 0) - Number(tenant.paid || 0))) {
      await tenants.updateOne({ id: tenant.id, 'stkPayments.requestId': requestId }, { $set: { 'stkPayments.$.status': 'MANUAL_REVIEW', 'stkPayments.$.updatedAt': new Date() } });
      return res.status(409).json({ error: 'Payment succeeded but exceeds the current tenant balance. It was held for administrator review.' });
    }

    const newPaid = Number(tenant.paid || 0) + amount;
    const receipt = statusPayload.mpesaReceipt || statusPayload.receipt || null;
    const update = await tenants.updateOne(
      { id: tenant.id, stkPayments: { $elemMatch: { requestId, status: { $ne: 'SUCCESS' } } } },
      {
        $inc: { paid: amount },
        $push: { paymentHistory: { amount, totalPaid: newPaid, date: new Date().toISOString(), source: 'LeeTec M-Pesa STK Push', receipt } },
        $set: { 'stkPayments.$.status': 'SUCCESS', 'stkPayments.$.receipt': receipt, 'stkPayments.$.completedAt': new Date() }
      }
    );
    if (!update.modifiedCount) return res.status(200).json({ ok: true, status: 'SUCCESS', final: true, duplicate: true });

    const updated = await tenants.findOne({ id: tenant.id });
    if (updated) {
      const balance = Math.max(0, Number(updated.expected || 0) - Number(updated.paid || 0));
      await tenants.updateOne({ id: tenant.id }, { $set: { balance } });
      await Promise.allSettled([
        notifyTenant({ ...updated, balance }, { title: 'M-Pesa payment received', amount, balance, detail: 'LeeTec STK Push payment', receipt, preference: 'payments' }),
        notifyAdmins(db, { title: 'M-Pesa payment received', details: `${updated.name} paid Ksh ${amount.toLocaleString()} for ${updated.houseNo}. New balance: Ksh ${balance.toLocaleString()}${receipt ? `. Receipt: ${receipt}.` : '.'}` })
      ]);
    }
    return res.status(200).json({ ok: true, status: 'SUCCESS', final: true });
  } catch (error) {
    console.error('SEGUTON LeeTec status error:', error);
    return res.status(500).json({ error: 'Payment status check failed.' });
  }
};
