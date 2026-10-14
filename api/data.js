const { ROOM_DEFINITIONS, getDatabase, initializeDatabase, readSnapshot, cleanTenant } = require('../lib/database');
const { requireAdmin } = require('../lib/auth');
const { notifyTenant } = require('../lib/notifications');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');

    const publicRoomsRequest = req.method === 'GET' && req.query && req.query.view === 'rooms';
    if (req.method === 'GET' && !publicRoomsRequest && !requireAdmin(req, res)) return;
    if (req.method === 'PATCH' && !requireAdmin(req, res)) return;

    if (req.method === 'GET') {
      const snapshot = await readSnapshot(db);
      if (publicRoomsRequest) return res.status(200).json({ rooms: snapshot.rooms.map(({ id, type, rent, status }) => ({ id, type, rent, status })), roomCount: snapshot.rooms.length });
      return res.status(200).json({ ...snapshot, database: 'connected', roomCount: snapshot.rooms.length });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const required = ['name', 'idNumber', 'phone', 'houseNo', 'dateEntered', 'expected', 'paid'];
      if (required.some((field) => body[field] === undefined || body[field] === '')) return res.status(400).json({ error: 'All tenant fields are required.' });
      if (!Object.prototype.hasOwnProperty.call(ROOM_DEFINITIONS, body.houseNo)) return res.status(400).json({ error: 'Unknown room.' });
      const expected = Number(body.expected); const paid = Number(body.paid);
      const idNumber = String(body.idNumber).trim();
      if (!/^\d{8}$/.test(idNumber)) return res.status(400).json({ error: 'Kenyan National ID number must contain exactly 8 digits.' });
      const phone = String(body.phone).replace(/[\s-]/g, '');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^(?:\+254|0)[17]\d{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Kenyan phone number using +254 7xx/1xx or 07xx/01xx.' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!Number.isFinite(expected) || !Number.isFinite(paid) || paid < 0) return res.status(400).json({ error: 'Expected rent and payment must be valid numbers.' });
      if (await tenants.findOne({ houseNo: body.houseNo, status: 'accepted' })) return res.status(409).json({ error: `Room ${body.houseNo} is already occupied.` });
      if (await tenants.findOne({ idNumber: idNumber, status: { $in: ['pending', 'accepted'] } })) return res.status(409).json({ error: 'An active application already exists for this ID number.' });
      const tenant = { id: Date.now(), name: String(body.name).trim(), idNumber, email, phone: phone.startsWith('0') ? '+254' + phone.slice(1) : phone, houseNo: body.houseNo, dateEntered: body.dateEntered, monthlyRent: expected, expected, paid, feesTotal: 0, balance: Math.max(0, expected - paid), status: 'pending', paymentHistory: paid > 0 ? [{ amount: paid, totalPaid: paid, date: new Date().toISOString(), source: 'Tenant registration' }] : [], feeHistory: [], timestamp: new Date().toLocaleString(), createdAt: new Date() };
      await tenants.insertOne(tenant);
      return res.status(201).json({ tenant: cleanTenant(tenant) });
    }

    if (req.method === 'PATCH') {
      const { id, status, paid, paymentAmount, action, confirmation, month } = req.body || {};
      if (!id && !['delete-payment-history', 'generate-monthly-rent'].includes(action)) return res.status(400).json({ error: 'A tenant ID and status or payment are required.' });
      if (action === 'generate-monthly-rent') {
        const rentMonth = String(month || new Date().toISOString().slice(0, 7));
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rentMonth)) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
        const accepted = await tenants.find({ status: 'accepted' }).toArray();
        let generated = 0; let skipped = 0; let total = 0; const notificationJobs = [];
        for (const record of accepted) {
          const monthlyRent = Number(record.monthlyRent || record.expected || 0);
          if (!Number.isFinite(monthlyRent) || monthlyRent <= 0) { skipped += 1; continue; }
          const result = await tenants.updateOne(
            { id: record.id, status: 'accepted', 'rentCharges.month': { $ne: rentMonth } },
            {
              $inc: { expected: monthlyRent },
              $set: { monthlyRent, balance: Math.max(0, Number(record.expected || 0) + monthlyRent - Number(record.paid || 0)), updatedAt: new Date() },
              $push: { rentCharges: { month: rentMonth, amount: monthlyRent, generatedAt: new Date().toISOString(), source: 'Monthly rent generation' } }
            }
          );
          if (result.modifiedCount) {
            generated += 1; total += monthlyRent;
            notificationJobs.push(notifyTenant({ ...record, expected: Number(record.expected || 0) + monthlyRent, balance: Math.max(0, Number(record.expected || 0) + monthlyRent - Number(record.paid || 0)) }, { title: `Monthly rent generated for ${rentMonth}`, amount: monthlyRent, balance: Math.max(0, Number(record.expected || 0) + monthlyRent - Number(record.paid || 0)), detail: 'Monthly rent' }));
          } else skipped += 1;
        }
        const notificationResults = await Promise.allSettled(notificationJobs);
        notificationResults.filter(result => result.status === 'rejected').forEach(result => console.error('SEGUTON notification error:', result.reason?.message || result.reason));
        return res.status(200).json({ ok: true, month: rentMonth, generated, skipped, total, notificationsAttempted: notificationJobs.length, message: generated ? `Generated Ksh ${total.toLocaleString()} for ${generated} tenant${generated === 1 ? '' : 's'}.` : `Monthly rent for ${rentMonth} was already generated.` });
      }
      if (action === 'add-fee') {
        const amount = Number(req.body.feeAmount);
        const category = String(req.body.feeCategory || '').trim();
        if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Fee amount must be greater than zero.' });
        if (!category || category.length > 60) return res.status(400).json({ error: 'Select a valid fee category.' });
      }
      if (status !== undefined && !['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid tenant status.' });
      if (paid !== undefined && (!Number.isFinite(Number(paid)) || Number(paid) < 0)) return res.status(400).json({ error: 'Payment must be a non-negative number.' });
      if (paymentAmount !== undefined && (!Number.isFinite(Number(paymentAmount)) || Number(paymentAmount) <= 0)) return res.status(400).json({ error: 'Payment amount must be greater than zero.' });
      const tenant = await tenants.findOne({ id: Number(id) });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
      if (action === 'delete-payment-history') {
        if (confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm payment-history deletion.' });
        await tenants.updateOne({ id: Number(id) }, { $set: { paid: 0, balance: Number(tenant.expected || 0), paymentHistory: [], stkPayments: [], updatedAt: new Date() } });
        return res.status(200).json({ ok: true, message: 'Payment history deleted and tenant balance reset.' });
      }
      if (action === 'add-fee') {
        if (tenant.status !== 'accepted') return res.status(400).json({ error: 'Fees can only be added to an accepted tenant.' });
        const amount = Number(req.body.feeAmount);
        const category = String(req.body.feeCategory).trim();
        const description = String(req.body.feeDescription || '').trim().slice(0, 200);
        const nextExpected = Number(tenant.expected || 0) + amount;
        await tenants.updateOne({ id: Number(id) }, {
          $inc: { expected: amount, feesTotal: amount },
          $set: { balance: Math.max(0, nextExpected - Number(tenant.paid || 0)), updatedAt: new Date() },
          $push: { feeHistory: { category, amount, description, date: new Date().toISOString(), source: 'Management fee' } }
        });
        try {
          await notifyTenant({ ...tenant, expected: nextExpected, balance: Math.max(0, nextExpected - Number(tenant.paid || 0)) }, { title: `${category} fee added`, amount, balance: Math.max(0, nextExpected - Number(tenant.paid || 0)), detail: description || category });
        } catch (error) { console.error('SEGUTON notification error:', error.message); }
        return res.status(200).json({ ok: true, message: `${category} fee of Ksh ${amount.toLocaleString()} added.` });
      }
      if (status === 'accepted' && await tenants.findOne({ houseNo: tenant.houseNo, status: 'accepted', id: { $ne: Number(id) } })) return res.status(409).json({ error: `Room ${tenant.houseNo} is already occupied.` });
      const update = { updatedAt: new Date() };
      if (status !== undefined) update.status = status;
      const nextPaid = paymentAmount !== undefined ? Number(tenant.paid || 0) + Number(paymentAmount) : paid !== undefined ? Number(paid) : undefined;
      if (nextPaid !== undefined) { update.paid = nextPaid; update.balance = Math.max(0, Number(tenant.expected) - nextPaid); }
      const operation = { $set: update };
      if (paymentAmount !== undefined || (paid !== undefined && Number(paid) > Number(tenant.paid || 0))) {
        const amount = paymentAmount !== undefined ? Number(paymentAmount) : Number(paid) - Number(tenant.paid || 0);
        operation.$push = { paymentHistory: { amount, totalPaid: nextPaid, date: new Date().toISOString(), source: 'Management' } };
      }
      await tenants.updateOne({ id: Number(id) }, operation);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('SEGUTON data error:', error);
    return res.status(500).json({ error: 'Database or authentication service is unavailable. Check the database connection, SESSION_SECRET, network access, and permissions.' });
  }
};
