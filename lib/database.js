const { MongoClient } = require('mongodb');

const ROOM_DEFINITIONS = {
  S1: 4500, S4: 4500, S5: 4500, A1: 4500, B1: 4500, B2: 4500,
  B3: 4500, B4: 4500, B5: 4500, B6: 4500, B7: 4500, B8: 4500,
  B9: 4500, C1: 7000
};

let databasePromise;
let initializationPromise;

async function getDatabase() {
  const uri = process.env.MONGODB_URI || process.env.MONGODB_URL || process.env.MONGO_URI;
  if (!uri) throw new Error('MONGODB_URI is not configured in Vercel.');
  if (!databasePromise) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, maxPoolSize: 10 });
    databasePromise = client.connect().then(() => client.db(process.env.MONGODB_DB || 'seguton')).catch((error) => {
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
      db.collection('admins').createIndex({ email: 1 }, { unique: true }),
      rooms.bulkWrite(Object.entries(ROOM_DEFINITIONS).map(([id, rent]) => ({
        updateOne: { filter: { id }, update: { $set: { rent }, $setOnInsert: { id, type: 'Rooms', createdAt: new Date() } }, upsert: true }
      })))
    ]).catch((error) => { initializationPromise = undefined; throw error; });
  }
  await initializationPromise;
}

function cleanTenant(tenant) {
  if (!tenant) return tenant;
  const { _id, ...data } = tenant;
  return data;
}

async function readSnapshot(db) {
  const [tenantRecords, roomRecords] = await Promise.all([
    db.collection('tenants').find({}).sort({ createdAt: -1 }).toArray(),
    db.collection('rooms').find({}).sort({ id: 1 }).toArray()
  ]);
  const tenants = tenantRecords.map(cleanTenant);
  const rooms = roomRecords.map(({ _id, id, type, rent }) => {
    const accepted = tenants.find((tenant) => tenant.houseNo === id && tenant.status === 'accepted');
    return { id, type: type || 'Rooms', rent: Number(rent || ROOM_DEFINITIONS[id] || 0), status: accepted ? 'occupied' : 'available', tenant: accepted ? accepted.name : '' };
  });
  return { tenants, rooms };
}

module.exports = { ROOM_DEFINITIONS, getDatabase, initializeDatabase, readSnapshot, cleanTenant };
