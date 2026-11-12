const crypto = require('crypto');
const { getDatabase, initializeDatabase } = require('../lib/database');
const { notifyTenant, notifyAdmins } = require('../lib/notifications');
const { normalizeKenyanPhone } = require('../lib/phone');
const { setSecurityHeaders } = require('../lib/security');

function readRawBody(req) {
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string') return Promise.resolve(Buffer.from(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function validSignature(rawBody, supplied) {
  const secret = process.env.LEETEC_WEBHOOK_SECRET;
  if (!secret || !supplied) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  if (!setSecurityHeaders(req, res, 'POST,OPTIONS')) return res.status(403).json({ error: 'Origin is not allowed.' });
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (!process.env.LEETEC_WEBHOOK_SECRET) return res.status(503).json({ error: 'LeeTec webhook verification is not configured.' });

  try {
    const rawBody = await readRawBody(req);
    if (!validSignature(rawBody, req.headers['x-leetec-signature'])) return res.status(401).json({ error: 'Invalid LeeTec webhook signature.' });

    const body = JSON.parse(rawBody.toString('utf8'));
    const eventName = String(req.headers['x-leetec-event'] || '');
    const deliveryId = String(req.headers['x-leetec-delivery'] || '');
    if (!deliveryId || deliveryId !== String(body.id || '') || eventName !== String(body.event || '')) {
      return res.status(400).json({ error: 'Invalid LeeTec webhook delivery headers.' });
    }

    const data = body.data || {};
    const requestId = String(data.requestId || body.requestId || '');
    const checkoutRequestId = String(data.checkoutRequestId || data.CheckoutRequestID || body.checkoutRequestId || '');
    const status = String(data.status || '').toUpperCase();
    if (!requestId && !checkoutRequestId) return res.status(400).json({ error: 'Missing LeeTec payment identifier.' });

    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');
    const selector = requestId ? { 'stkPayments.requestId': requestId } : { 'stkPayments.checkoutRequestId': checkoutRequestId };
    const tenant = await tenants.findOne(selector);
    if (!tenant) return res.status(200).json({ ok: true, ignored: true });

    const payment = (tenant.stkPayments || []).find(item =>
      (requestId && item.requestId === requestId) || (checkoutRequestId && item.checkoutRequestId === checkoutRequestId)
    );
    if (!payment || payment.status === 'SUCCESS') return res.status(200).json({ ok: true, duplicate: true });

    const isSuccess = eventName === 'payment.success' && status === 'SUCCESS';
    const finalStatus = ['SUCCESS', 'FAILED', 'CANCELLED', 'MANUAL_REVIEW'].includes(status) ? status : 'PENDING';
    if (!isSuccess && finalStatus === 'PENDING') return res.status(200).json({ ok: true, pending: true });

      const paymentFilter = {
      id: tenant.id,
      stkPayments: { $elemMatch: { ...(requestId ? { requestId } : { checkoutRequestId }), status: { $ne: 'SUCCESS' } } }
    };

    if (isSuccess) {
      const amount = Number(payment.amount || data.amount || 0);
      const expectedReference = String(payment.accountReference || '');
      const receivedReference = String(data.accountReference || '');
      const receivedPhoneRaw = String(data.phoneNumber || data.phone || '').trim();
      const receivedPhone = receivedPhoneRaw ? normalizeKenyanPhone(receivedPhoneRaw, 'mpesa') : '';
      const expectedPhone = normalizeKenyanPhone(payment.phone, 'mpesa');
      if (!Number.isInteger(amount) || amount < 1 || (receivedReference && receivedReference !== expectedReference) || (receivedPhoneRaw && (!receivedPhone || receivedPhone !== expectedPhone))) {
        return res.status(422).json({ error: 'LeeTec payment reconciliation failed.' });
      }
      if (amount > Math.max(0, Number(tenant.expected || 0) - Number(tenant.paid || 0))) {
        await tenants.updateOne({ id: tenant.id, [`stkPayments.${requestId ? 'requestId' : 'checkoutRequestId'}`]: requestId || checkoutRequestId }, { $set: { 'stkPayments.$.status': 'MANUAL_REVIEW', 'stkPayments.$.updatedAt': new Date() } });
        return res.status(409).json({ error: 'Payment exceeds the current tenant balance and was held for administrator review.' });
      }
      const newPaid = Number(tenant.paid || 0) + amount;
      const paymentUpdate = await tenants.updateOne({ ...paymentFilter, paid: { $lte: Number(tenant.expected || 0) - amount } }, {
        $inc: { paid: amount },
        $push: { paymentHistory: { amount, totalPaid: newPaid, date: new Date().toISOString(), source: 'LeeTec M-Pesa STK Push', receipt: data.mpesaReceipt || data.receipt || null } },
        $set: { 'stkPayments.$.status': 'SUCCESS', 'stkPayments.$.receipt': data.mpesaReceipt || data.receipt || null, 'stkPayments.$.deliveryId': deliveryId, 'stkPayments.$.completedAt': new Date() }
      });
      if (!paymentUpdate.modifiedCount) {
        const current = await tenants.findOne({ id: tenant.id }, { projection: { stkPayments: 1 } });
        const currentPayment = (current?.stkPayments || []).find(item =>
          (requestId && item.requestId === requestId) || (checkoutRequestId && item.checkoutRequestId === checkoutRequestId)
        );
        if (currentPayment?.status === 'SUCCESS') return res.status(200).json({ ok: true, duplicate: true });
        await tenants.updateOne(paymentFilter, { $set: { 'stkPayments.$.status': 'MANUAL_REVIEW', 'stkPayments.$.updatedAt': new Date() } });
        return res.status(409).json({ error: 'Payment exceeds the current balance and was held for administrator review.' });
      }
      const updated = await tenants.findOne({ id: tenant.id });
      if (updated) {
        const balance = Math.max(0, Number(updated.expected || 0) - Number(updated.paid || 0));
        await tenants.updateOne({ id: tenant.id }, { $set: { balance } });
        await Promise.allSettled([
          notifyTenant({ ...updated, balance }, { title: 'M-Pesa payment received', amount, balance, detail: 'LeeTec STK Push payment', receipt: data.mpesaReceipt || data.receipt || null, preference: 'payments' }),
          notifyAdmins(db, { title: 'M-Pesa payment received', details: `${updated.name} paid Ksh ${amount.toLocaleString()} for ${updated.houseNo}. New balance: Ksh ${balance.toLocaleString()}${data.mpesaReceipt || data.receipt ? `. Receipt: ${data.mpesaReceipt || data.receipt}.` : '.'}` })
        ]);
      }
    } else {
      await tenants.updateOne(paymentFilter, { $set: { 'stkPayments.$.status': finalStatus, 'stkPayments.$.deliveryId': deliveryId, 'stkPayments.$.resultDescription': data.resultDescription || data.resultDesc || null, 'stkPayments.$.updatedAt': new Date() } });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('SEGUTON LeeTec webhook error:', error);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
};

module.exports.config = { api: { bodyParser: false } };
