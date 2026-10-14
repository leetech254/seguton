const { getDatabase, initializeDatabase, cleanTenant } = require('../lib/database');

function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '+254' + compact.slice(1);
  if (/^\+254[17]\d{8}$/.test(compact)) return compact;
  return null;
}

function publicTenant(tenant) {
  const data = cleanTenant(tenant);
  return {
    id: data.id,
    name: data.name,
    idNumber: data.idNumber,
    phone: data.phone,
    houseNo: data.houseNo,
    dateEntered: data.dateEntered,
    expected: Number(data.expected || 0),
    paid: Number(data.paid || 0),
    balance: Number(data.balance || 0),
    status: data.status,
    paymentHistory: Array.isArray(data.paymentHistory) && data.paymentHistory.length
      ? data.paymentHistory
      : Number(data.paid || 0) > 0
        ? [{ amount: Number(data.paid), totalPaid: Number(data.paid), date: data.createdAt || new Date().toISOString(), source: 'Recorded payment' }]
        : []
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const idNumber = String(body.idNumber || '').trim();
    const phone = normalizePhone(body.phone);
    if (!name || !/^\d{8}$/.test(idNumber) || !phone) {
      return res.status(400).json({ error: 'Enter your full name, 8-digit National ID number, and valid Kenyan phone number.' });
    }

    const db = await getDatabase();
    await initializeDatabase(db);
    const records = await db.collection('tenants').find({
      idNumber,
      phone,
      status: { $in: ['pending', 'accepted'] }
    }).sort({ createdAt: -1 }).toArray();
    const matches = records.filter((tenant) => String(tenant.name || '').toLowerCase() === name.toLowerCase());
    if (!matches.length) return res.status(401).json({ error: 'No matching tenant record was found. Check your name, ID number, and phone number.' });

    return res.status(200).json({ tenants: matches.map(publicTenant) });
  } catch (error) {
    console.error('SEGUTON tenant portal error:', error);
    return res.status(500).json({ error: 'Tenant portal is temporarily unavailable. Please try again.' });
  }
};
