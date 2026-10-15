const { ROOM_DEFINITIONS, getDatabase, initializeDatabase, readSnapshot, cleanTenant } = require('../lib/database');
const { requireAdmin } = require('../lib/auth');
const { notifyTenant, notifyAdmins } = require('../lib/notifications');

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
      const submittedExpected = Number(body.expected); const paid = Number(body.paid);
      const expected = Number(ROOM_DEFINITIONS[body.houseNo]);
      const idNumber = String(body.idNumber).trim();
      const name = String(body.name || '').trim();
      if (name.length < 2 || name.length > 120) return res.status(400).json({ error: 'Enter a valid full name.' });
      if (!/^\d{8}$/.test(idNumber)) return res.status(400).json({ error: 'Kenyan National ID number must contain exactly 8 digits.' });
      const phone = String(body.phone).replace(/[\s-]/g, '');
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^(?:\+254|0)[17]\d{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Kenyan phone number using +254 7xx/1xx or 07xx/01xx.' });
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!Number.isFinite(submittedExpected) || submittedExpected !== expected || !Number.isFinite(paid) || paid < 0) return res.status(400).json({ error: 'The selected room rent is invalid. Refresh the room list and try again.' });
      if (paid !== 0) return res.status(400).json({ error: 'Registration payments must be completed through the M-Pesa payment prompt.' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(body.dateEntered))) return res.status(400).json({ error: 'Enter a valid date entered.' });
      if (await tenants.findOne({ houseNo: body.houseNo, status: 'accepted' })) return res.status(409).json({ error: `Room ${body.houseNo} is already occupied.` });
      if (await tenants.findOne({ idNumber: idNumber, status: { $in: ['pending', 'accepted'] } })) return res.status(409).json({ error: 'An active application already exists for this ID number.' });
      const tenant = { id: Date.now() * 1000 + Math.floor(Math.random() * 1000), name, idNumber, email, phone: phone.startsWith('0') ? '+254' + phone.slice(1) : phone, notificationPreferences: { payments: true, charges: true, account: true }, houseNo: body.houseNo, dateEntered: body.dateEntered, monthlyRent: expected, expected, paid: 0, feesTotal: 0, balance: expected, status: 'pending', paymentHistory: [], feeHistory: [], timestamp: new Date().toLocaleString(), createdAt: new Date() };
      await tenants.insertOne(tenant);
      await notifyAdmins(db, { title: 'New tenant application', details: `${tenant.name} applied for room ${tenant.houseNo}. Tenant email: ${email || 'not provided'}.` });
      return res.status(201).json({ tenant: cleanTenant(tenant), emailNotificationsEnabled: Boolean(email) });
    }

    if (req.method === 'PATCH') {
      const { id, status, paid, paymentAmount, action, confirmation, month } = req.body || {};
      if (!id && !['delete-payment-history', 'generate-monthly-rent'].includes(action)) return res.status(400).json({ error: 'A tenant ID and status or payment are required.' });
      if (action === 'generate-monthly-rent') {
        const rentMonth = String(month || new Date().toISOString().slice(0, 7));
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(rentMonth)) return res.status(400).json({ error: 'Month must use YYYY-MM format.' });
        const accepted = await tenants.find({ status: 'accepted' }).toArray();
        let generated = 0; let skipped = 0; let total = 0; const notificationJobs = []; const adminUpdates = [];
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
            adminUpdates.push(`${record.name} (${record.houseNo}): Ksh ${monthlyRent.toLocaleString()}`);
            notificationJobs.push(notifyTenant({ ...record, expected: Number(record.expected || 0) + monthlyRent, balance: Math.max(0, Number(record.expected || 0) + monthlyRent - Number(record.paid || 0)) }, { title: `Monthly rent generated for ${rentMonth}`, amount: monthlyRent, balance: Math.max(0, Number(record.expected || 0) + monthlyRent - Number(record.paid || 0)), detail: 'Monthly rent', preference: 'charges' }));
          } else skipped += 1;
        }
        const notificationResults = await Promise.allSettled(notificationJobs);
        notificationResults.filter(result => result.status === 'rejected').forEach(result => console.error('SEGUTON notification error:', result.reason?.message || result.reason));
        await notifyAdmins(db, { title: `Monthly rent generated for ${rentMonth}`, details: adminUpdates.length ? adminUpdates.join('\n') : 'No new monthly rent charges were generated.' });
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
      if (action === 'delete-tenant') {
        if (confirmation !== 'DELETE TENANT') return res.status(400).json({ error: 'Type DELETE TENANT to confirm permanent tenant deletion.' });
        await tenants.deleteOne({ id: Number(id) });
        await notifyAdmins(db, { title: 'Tenant deleted', details: `${tenant.name} and all associated details were deleted. Room ${tenant.houseNo} was released.` });
        return res.status(200).json({ ok: true, releasedRoom: tenant.houseNo, message: `${tenant.name} was permanently removed and room ${tenant.houseNo} is available again.` });
      }
      if (action === 'delete-payment-history') {
        if (confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm payment-history deletion.' });
        await tenants.updateOne({ id: Number(id) }, { $set: { paid: 0, balance: Number(tenant.expected || 0), paymentHistory: [], stkPayments: [], updatedAt: new Date() } });
        await notifyAdmins(db, { title: 'Payment history deleted', details: `Payment history for ${tenant.name} (${tenant.houseNo}) was permanently deleted and their balance was reset.` });
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
          await notifyTenant({ ...tenant, expected: nextExpected, balance: Math.max(0, nextExpected - Number(tenant.paid || 0)) }, { title: `${category} fee added`, amount, balance: Math.max(0, nextExpected - Number(tenant.paid || 0)), detail: description || category, preference: 'charges' });
        } catch (error) { console.error('SEGUTON notification error:', error.message); }
        await notifyAdmins(db, { title: 'Tenant fee added', details: `${category} of Ksh ${amount.toLocaleString()} added to ${tenant.name} (${tenant.houseNo}). New balance: Ksh ${Math.max(0, nextExpected - Number(tenant.paid || 0)).toLocaleString()}.` });
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
      const updatedTenant = await tenants.findOne({ id: Number(id) });
      if (paymentAmount !== undefined || (paid !== undefined && Number(paid) > Number(tenant.paid || 0))) {
        const amount = paymentAmount !== undefined ? Number(paymentAmount) : Number(paid) - Number(tenant.paid || 0);
        await Promise.allSettled([
          notifyTenant(updatedTenant, { title: 'Payment recorded', amount, balance: Number(updatedTenant?.balance || 0), detail: 'Management payment', preference: 'payments' }),
          notifyAdmins(db, { title: 'Tenant payment recorded', details: `${tenant.name} paid Ksh ${amount.toLocaleString()} for ${tenant.houseNo}. New balance: Ksh ${Number(updatedTenant?.balance || 0).toLocaleString()}.` })
        ]);
      } else if (status !== undefined) {
        await Promise.allSettled([
          notifyTenant(updatedTenant, { title: `Application ${status}`, amount: 0, balance: Number(updatedTenant?.balance || 0), detail: `Room ${tenant.houseNo}`, preference: 'account' }),
          notifyAdmins(db, { title: `Tenant application ${status}`, details: `${tenant.name}'s application for ${tenant.houseNo} was marked ${status}.` })
        ]);
      }
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('SEGUTON data error:', error);
    return res.status(500).json({ error: 'Database or authentication service is unavailable. Check the database connection, SESSION_SECRET, network access, and permissions.' });
  }
};
