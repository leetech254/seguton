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
      const required = ['name', 'idNumber', 'houseNo', 'dateEntered', 'expected', 'paid'];
      if (required.some((field) => body[field] === undefined || body[field] === '')) return res.status(400).json({ error: 'All tenant fields are required.' });
      if (!Object.prototype.hasOwnProperty.call(ROOM_DEFINITIONS, body.houseNo)) return res.status(400).json({ error: 'Unknown room.' });
      const expected = Number(body.expected); const paid = Number(body.paid);
      if (!Number.isFinite(expected) || !Number.isFinite(paid) || paid < 0) return res.status(400).json({ error: 'Expected rent and payment must be valid numbers.' });
      if (await tenants.findOne({ houseNo: body.houseNo, status: 'accepted' })) return res.status(409).json({ error: `Room ${body.houseNo} is already occupied.` });
      if (await tenants.findOne({ idNumber: String(body.idNumber).trim(), status: { $in: ['pending', 'accepted'] } })) return res.status(409).json({ error: 'An active application already exists for this ID number.' });
      const tenant = { id: Date.now(), name: String(body.name).trim(), idNumber: String(body.idNumber).trim(), houseNo: body.houseNo, dateEntered: body.dateEntered, expected, paid, balance: expected - paid, status: 'pending', timestamp: new Date().toLocaleString(), createdAt: new Date() };
      await tenants.insertOne(tenant);
      return res.status(201).json({ tenant: cleanTenant(tenant) });
    }

    if (req.method === 'PATCH') {
      const { id, status, paid } = req.body || {};
      if (!id || (status === undefined && paid === undefined)) return res.status(400).json({ error: 'A tenant ID and status or payment are required.' });
      if (status !== undefined && !['accepted', 'declined'].includes(status)) return res.status(400).json({ error: 'Invalid tenant status.' });
      if (paid !== undefined && (!Number.isFinite(Number(paid)) || Number(paid) < 0)) return res.status(400).json({ error: 'Payment must be a non-negative number.' });
      const tenant = await tenants.findOne({ id: Number(id) });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
      if (status === 'accepted' && await tenants.findOne({ houseNo: tenant.houseNo, status: 'accepted', id: { $ne: Number(id) } })) return res.status(409).json({ error: `Room ${tenant.houseNo} is already occupied.` });
      const update = { updatedAt: new Date() };
      if (status !== undefined) update.status = status;
      if (paid !== undefined) { update.paid = Number(paid); update.balance = Number(tenant.expected) - Number(paid); }
      await tenants.updateOne({ id: Number(id) }, { $set: update });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (error) {
    console.error('SEGUTON data error:', error);
    return res.status(500).json({ error: 'Database or authentication service is unavailable. Check the database connection, SESSION_SECRET, network access, and permissions.' });
  }
};
