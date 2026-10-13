const { MongoClient } = require('mongodb');

const ROOM_DEFINITIONS = {
  S1: 9480, S4: 18740, S5: 4740, A1: 4500, B1: 9440, B2: 10320,
  B3: 4740, B4: 5360, B5: 18220, B6: 4500, B7: 4620, B8: 9240,
  B9: 18000, C1: 51280
};

let databasePromise;
let initializationPromise;

async function getDatabase() {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured in Vercel. Add MONGODB_URI in the deployed environment.');
  if (!databasePromise) {
    const client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      maxPoolSize: 10
    });
    databasePromise = client.connect()
      .then(() => client.db(process.env.MONGODB_DB || 'seguton'))
      .catch((error) => {
        databasePromise = undefined;
        throw error;
      });
  }
  return databasePromise;
}

async function initializeDatabase(db) {
  if (!initializationPromise) {
    const tenants = db.collection('tenants');
    const rooms = db.collection('rooms');
    initializationPromise = Promise.all([
      tenants.createIndex({ id: 1 }, { unique: true }),
      tenants.createIndex({ houseNo: 1, status: 1 }),
      tenants.createIndex({ idNumber: 1 }),
      rooms.createIndex({ id: 1 }, { unique: true }),
      rooms.bulkWrite(Object.entries(ROOM_DEFINITIONS).map(([id, rent]) => ({
        updateOne: {
          filter: { id },
          update: { $setOnInsert: { id, type: 'Rooms', rent, createdAt: new Date() } },
          upsert: true
        }
      })))
    ]).catch((error) => {
      initializationPromise = undefined;
      throw error;
    });
  }
  await initializationPromise;
}

async function readSnapshot(db) {
  const [tenantRecords, roomRecords] = await Promise.all([
    db.collection('tenants').find({}).sort({ createdAt: -1 }).toArray(),
    db.collection('rooms').find({}).sort({ id: 1 }).toArray()
  ]);
  const tenants = tenantRecords.map(cleanTenant);
  const rooms = roomRecords.map(({ _id, id, type, rent }) => {
    const accepted = tenants.find((tenant) => tenant.houseNo === id && tenant.status === 'accepted');
    return {
      id,
      type: type || 'Rooms',
      rent: Number(rent || ROOM_DEFINITIONS[id] || 0),
      status: accepted ? 'occupied' : 'available',
      tenant: accepted ? accepted.name : ''
    };
  });
  return { tenants, rooms };
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
    const db = await getDatabase();
    await initializeDatabase(db);
    const tenants = db.collection('tenants');

    if (req.method === 'GET') {
      const snapshot = await readSnapshot(db);
      return res.status(200).json({ ...snapshot, database: 'connected', roomCount: snapshot.rooms.length });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const required = ['name', 'idNumber', 'houseNo', 'dateEntered', 'expected', 'paid'];
      if (required.some((field) => body[field] === undefined || body[field] === '')) {
        return res.status(400).json({ error: 'name, idNumber, houseNo, dateEntered, expected and paid are required' });
      }
      if (!Object.prototype.hasOwnProperty.call(ROOM_DEFINITIONS, body.houseNo)) {
        return res.status(400).json({ error: 'Unknown room' });
      }
      const expected = Number(body.expected);
      const paid = Number(body.paid);
      if (!Number.isFinite(expected) || !Number.isFinite(paid) || paid < 0) {
        return res.status(400).json({ error: 'expected and paid must be valid numbers' });
      }
      const existing = await tenants.findOne({ houseNo: body.houseNo, status: 'accepted' });
      if (existing) return res.status(409).json({ error: `Room ${body.houseNo} is already occupied` });
      const duplicateId = await tenants.findOne({ idNumber: String(body.idNumber).trim(), status: { $in: ['pending', 'accepted'] } });
      if (duplicateId) return res.status(409).json({ error: 'An active application already exists for this ID number' });

      const tenant = {
        id: Date.now(),
        name: String(body.name).trim(),
        idNumber: String(body.idNumber).trim(),
        houseNo: body.houseNo,
        dateEntered: body.dateEntered,
        expected,
        paid,
        balance: expected - paid,
        status: 'pending',
        timestamp: new Date().toLocaleString(),
        createdAt: new Date()
      };
      await tenants.insertOne(tenant);
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
      const tenant = await tenants.findOne({ id: Number(id) });
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
      if (status === 'accepted') {
        const occupied = await tenants.findOne({ houseNo: tenant.houseNo, status: 'accepted', id: { $ne: Number(id) } });
        if (occupied) return res.status(409).json({ error: `Room ${tenant.houseNo} is already occupied` });
      }
      const update = { updatedAt: new Date() };
      if (status !== undefined) update.status = status;
      if (paid !== undefined) {
        update.paid = Number(paid);
        update.balance = Number(tenant.expected) - Number(paid);
      }
      await tenants.updateOne({ id: Number(id) }, { $set: update });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('SEGUTON API error:', error);
    const message = error.message || 'Unknown database error';
    return res.status(500).json({
      error: message.includes('MONGODB_URI') ? message : 'MongoDB connection failed. Verify MONGODB_URI, MONGODB_DB, Atlas network access, and database permissions.',
      hint: 'Redeploy after changing Vercel environment variables. Atlas Network Access must allow the deployed Vercel function.'
    });
  }
};
