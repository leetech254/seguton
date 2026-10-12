const { MongoClient } = require('mongodb');

const rentPrices = {
  S1: 9480, S4: 18740, S5: 4740, A1: 4500, B1: 9440, B2: 10320,
  B3: 4740, B4: 5360, B5: 18220, B6: 4500, B7: 4620, B8: 9240,
  B9: 18000, C1: 51280
};

let cachedClient;
let cachedDb;

async function getDb() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }
  if (cachedDb) return cachedDb;
  cachedClient = cachedClient || new MongoClient(process.env.MONGODB_URI);
  if (!cachedClient.topology?.isConnected()) await cachedClient.connect();
  cachedDb = cachedClient.db(process.env.MONGODB_DB || 'seguton');
  return cachedDb;
}

function roomList(tenants) {
  return Object.keys(rentPrices).map((id) => {
    const accepted = tenants.find((tenant) => tenant.houseNo === id && tenant.status === 'accepted');
    return {
      id,
      type: 'Rooms',
      status: accepted ? 'occupied' : 'available',
      tenant: accepted ? accepted.name : ''
    };
  });
}

function cleanTenant(tenant) {
  if (!tenant) return tenant;
  const { _id, ...data } = tenant;
  return data;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const db = await getDb();
    const tenantsCollection = db.collection('tenants');
    await tenantsCollection.createIndex({ id: 1 }, { unique: true });
    await tenantsCollection.createIndex({ houseNo: 1, status: 1 });
    await tenantsCollection.createIndex({ idNumber: 1 });

    if (req.method === 'GET') {
      const tenants = (await tenantsCollection.find({}).sort({ createdAt: -1 }).toArray()).map(cleanTenant);
      return res.status(200).json({ tenants, rooms: roomList(tenants) });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const required = ['name', 'idNumber', 'houseNo', 'dateEntered', 'expected', 'paid'];
      if (required.some((field) => body[field] === undefined || body[field] === '')) {
        return res.status(400).json({ error: 'name, idNumber, houseNo, dateEntered, expected and paid are required' });
      }
      if (!rentPrices[body.houseNo]) return res.status(400).json({ error: 'Unknown room' });
      const existing = await tenantsCollection.findOne({ houseNo: body.houseNo, status: 'accepted' });
      if (existing) return res.status(409).json({ error: `Room ${body.houseNo} is already occupied` });
      const duplicateId = await tenantsCollection.findOne({ idNumber: String(body.idNumber).trim(), status: { $in: ['pending', 'accepted'] } });
      if (duplicateId) return res.status(409).json({ error: 'An active application already exists for this ID number' });

      const tenant = {
        id: Date.now(),
        name: String(body.name).trim(),
        idNumber: String(body.idNumber).trim(),
        houseNo: body.houseNo,
        dateEntered: body.dateEntered,
        expected: Number(body.expected),
        paid: Number(body.paid),
        balance: Number(body.expected) - Number(body.paid),
        status: 'pending',
        timestamp: new Date().toLocaleString(),
        createdAt: new Date()
      };
      await tenantsCollection.insertOne(tenant);
      return res.status(201).json({ tenant: cleanTenant(tenant) });
    }

    if (req.method === 'PATCH') {
      const { id, status, paid } = req.body || {};
      if (!id || (status === undefined && paid === undefined)) {
        return res.status(400).json({ error: 'id and status or paid are required' });
      }
      if (status !== undefined && !['accepted', 'declined'].includes(status)) {
        return res.status(400).json({ error: 'status must be accepted or declined' });
      }
      if (paid !== undefined && (!Number.isFinite(Number(paid)) || Number(paid) < 0)) {
        return res.status(400).json({ error: 'paid must be a non-negative number' });
      }
      const tenant = await tenantsCollection.findOne({ id: Number(id) });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      if (status === 'accepted') {
        const occupied = await tenantsCollection.findOne({ houseNo: tenant.houseNo, status: 'accepted', id: { $ne: Number(id) } });
        if (occupied) return res.status(409).json({ error: `Room ${tenant.houseNo} is already occupied` });
      }
      const update = { updatedAt: new Date() };
      if (status !== undefined) update.status = status;
      if (paid !== undefined) {
        update.paid = Number(paid);
        update.balance = Number(tenant.expected) - Number(paid);
      }
      await tenantsCollection.updateOne({ id: Number(id) }, { $set: update });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Database is unavailable. Check MONGODB_URI and MONGODB_DB.' });
  }
};
