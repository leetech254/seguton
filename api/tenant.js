const { getDatabase, initializeDatabase, cleanTenant } = require('../lib/database');
const { notifyTenantAccountUpdate, notifyAdmins } = require('../lib/notifications');
const { setTenantSession, readTenantSession, clearTenantSession } = require('../lib/auth');

function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '+254' + compact.slice(1);
  if (/^\+254[17]\d{8}$/.test(compact)) return compact;
  return null;
}

function notificationPreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  return { payments: source.payments !== false, charges: source.charges !== false, account: source.account !== false };
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
        : [],
    feeHistory: Array.isArray(data.feeHistory) ? data.feeHistory : [],
    feesTotal: Number(data.feesTotal || 0),
    email: data.email || '',
    notificationPreferences: notificationPreferences(data.notificationPreferences),
    monthlyRent: Number(data.monthlyRent || 0),
    rentCharges: Array.isArray(data.rentCharges) ? data.rentCharges : []
  };
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'POST,PATCH,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!['POST', 'PATCH'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });

  try {
    const body = req.body || {};
    const db = await getDatabase();
    await initializeDatabase(db);
    const tenantCollection = db.collection('tenants');

    if (req.method === 'POST' && body.action === 'logout') {
      clearTenantSession(res);
      return res.status(200).json({ ok: true, message: 'Tenant portal logged out safely.' });
    }
    if (req.method === 'POST' && body.action === 'session') {
      const session = readTenantSession(req);
      if (!session) return res.status(401).json({ error: 'Tenant session expired. Please sign in again.' });
      const ids = session.ids.map(id => Number.isNaN(Number(id)) ? id : Number(id));
      const sessionRecords = await tenantCollection.find({ id: { $in: ids }, status: { $in: ['pending', 'accepted'] } }).sort({ createdAt: -1 }).toArray();
      if (!sessionRecords.length) { clearTenantSession(res); return res.status(401).json({ error: 'Tenant record is no longer available. Please sign in again.' }); }
      return res.status(200).json({ tenants: sessionRecords.map(publicTenant), restored: true });
    }

    const name = String(body.name || '').trim();
    const idNumber = String(body.idNumber || '').trim();
    const phone = normalizePhone(body.phone);
    if (!name || !/^\d{8}$/.test(idNumber) || !phone) {
      return res.status(400).json({ error: 'Enter your full name, 8-digit National ID number, and valid Kenyan phone number.' });
    }

    const records = await tenantCollection.find({
      idNumber,
      phone,
      status: { $in: ['pending', 'accepted'] }
    }).sort({ createdAt: -1 }).toArray();
    const matches = records.filter((tenant) => String(tenant.name || '').toLowerCase() === name.toLowerCase());
    if (!matches.length) return res.status(401).json({ error: 'No matching tenant record was found. Check your name, ID number, and phone number.' });
    setTenantSession(res, matches);

    if (req.method === 'PATCH') {
      const email = String(body.email || '').trim().toLowerCase();
      const newPhone = normalizePhone(body.newPhone || body.phone);
      const preferences = notificationPreferences(body.notificationPreferences === undefined ? matches[0].notificationPreferences : body.notificationPreferences);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (!newPhone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number using +254 7xx/1xx or 07xx/01xx.' });
      const result = await tenantCollection.updateMany({ id: { $in: matches.map(record => record.id) } }, { $set: { email, phone: newPhone, notificationPreferences: preferences, updatedAt: new Date() } });
      setTenantSession(res, matches);
      await Promise.allSettled([
        notifyTenantAccountUpdate({ ...matches[0], email, phone: newPhone, notificationPreferences: preferences }, { title: 'Your contact details were updated', details: `Your notification email is now ${email || 'not set'}, your payment prompt number is ${newPhone}, and your email preferences were saved.` }),
        notifyAdmins(db, { title: 'Tenant contact details updated', details: `${matches[0].name} (${matches[0].houseNo}) changed their notification email to ${email || 'not set'} and payment phone to ${newPhone}. Email categories: payments ${preferences.payments ? 'on' : 'off'}, rent/fees ${preferences.charges ? 'on' : 'off'}, account updates ${preferences.account ? 'on' : 'off'}.` })
      ]);
      return res.status(200).json({ ok: true, updated: result.modifiedCount, email, phone: newPhone, notificationPreferences: preferences, message: 'Contact details and email preferences updated successfully.' });
    }

    return res.status(200).json({ tenants: matches.map(publicTenant) });
  } catch (error) {
    console.error('SEGUTON tenant portal error:', error);
    return res.status(500).json({ error: 'Tenant portal is temporarily unavailable. Please try again.' });
  }
};
