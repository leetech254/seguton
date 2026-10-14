const { ROOM_DEFINITIONS, getDatabase, initializeDatabase, readSnapshot, cleanTenant } = require('../lib/database');
const { requireAdmin } = require('../lib/auth');

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
      if (!/^(?:\+254|0)[17]\d{8}$/.test(phone)) return res.status(400).json({ error: 'Enter a valid Kenyan phone number using +254 7xx/1xx or 07xx/01xx.' });
      if (!Number.isFinite(expected) || !Number.isFinite(paid) || paid < 0) return res.status(400).json({ error: 'Expected rent and payment must be valid numbers.' });
      if (await tenants.findOne({ houseNo: body.houseNo, status: 'accepted' })) return res.status(409).json({ error: `Room ${body.houseNo} is already occupied.` });
      if (await tenants.findOne({ idNumber: idNumber, status: { $in: ['pending', 'accepted'] } })) return res.status(409).json({ error: 'An active application already exists for this ID number.' });
      const tenant = { id: Date.now(), name: String(body.name).trim(), idNumber, phone: phone.startsWith('0') ? '+254' + phone.slice(1) : phone, houseNo: body.houseNo, dateEntered: body.dateEntered, expected, paid, balance: Math.max(0, expected - paid), status: 'pending', paymentHistory: paid > 0 ? [{ amount: paid, totalPaid: paid, date: new Date().toISOString(), source: 'Tenant registration' }] : [], timestamp: new Date().toLocaleString(), createdAt: new Date() };
      await tenants.insertOne(tenant);
      return res.status(201).json({ tenant: cleanTenant(tenant) });
    }

    if (req.method === 'PATCH') {
      const { id, status, paid, paymentAmount, action, confirmation } = req.body || {};
      if (!id || (status === undefined && paid === undefined && paymentAmount === undefined && action !== 'delete-payment-history')) return res.status(400).json({ error: 'A tenant ID and status or payment are required.' });
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
