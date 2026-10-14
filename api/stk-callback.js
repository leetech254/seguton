const { getDatabase, initializeDatabase } = require('../lib/database');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });
  if (process.env.COURTNEY_CALLBACK_SECRET && req.query?.secret !== process.env.COURTNEY_CALLBACK_SECRET) return res.status(401).json({ error: 'Unauthorized callback.' });
  try {
    const body = req.body || {};
    const data = body.data || body;
    const transactionId = data.transactionId || body.transactionId;
    const checkoutRequestId = data.checkoutRequestId || data.checkout_request_id || body.checkoutRequestId;
    const status = String(data.status || '').toLowerCase();
    const successful = status === 'completed' || body.event === 'payment.success' || data.event === 'payment.success';
    const failed = status === 'failed' || status === 'cancelled' || body.event === 'payment.failed' || body.event === 'payment.cancelled';
    if (!transactionId && !checkoutRequestId) return res.status(400).json({ error: 'Missing payment identifier.' });

    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');
    const selector = transactionId ? { 'stkPayments.transactionId': transactionId } : { 'stkPayments.checkoutRequestId': checkoutRequestId };
    const tenant = await tenants.findOne(selector);
    if (!tenant) return res.status(200).json({ ok: true, ignored: true });
    const payment = (tenant.stkPayments || []).find(item => (transactionId && item.transactionId === transactionId) || (checkoutRequestId && item.checkoutRequestId === checkoutRequestId));
    if (!payment || payment.status === 'completed') return res.status(200).json({ ok: true, duplicate: true });

    const paymentStatus = successful ? 'completed' : failed ? status : 'pending';
    if (paymentStatus === 'pending') return res.status(200).json({ ok: true, pending: true });
    const paymentFilter = { id: tenant.id, stkPayments: { $elemMatch: { ...(transactionId ? { transactionId } : { checkoutRequestId }), status: { $ne: 'completed' } } } };
    if (paymentStatus === 'completed') {
      const amount = Number(payment.amount || data.amountKes || 0);
      await tenants.updateOne(paymentFilter, {
        $inc: { paid: amount },
        $push: { paymentHistory: { amount, totalPaid: Number(tenant.paid || 0) + amount, date: new Date().toISOString(), source: 'M-Pesa STK Push', receipt: data.mpesaReceipt || null } },
        $set: { 'stkPayments.$.status': 'completed', 'stkPayments.$.receipt': data.mpesaReceipt || null, 'stkPayments.$.completedAt': new Date() }
      });
      const updated = await tenants.findOne({ id: tenant.id });
      if (updated) await tenants.updateOne({ id: tenant.id }, { $set: { balance: Math.max(0, Number(updated.expected || 0) - Number(updated.paid || 0)) } });
    } else {
      await tenants.updateOne(paymentFilter, { $set: { 'stkPayments.$.status': paymentStatus, 'stkPayments.$.resultDescription': data.resultDesc || null, 'stkPayments.$.updatedAt': new Date() } });
    }
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('SEGUTON STK callback error:', error);
    return res.status(500).json({ error: 'Callback processing failed.' });
  }
};
