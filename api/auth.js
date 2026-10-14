const { getDatabase, initializeDatabase } = require('../lib/database');
const { hashPassword, verifyPassword, setSession, clearSession, readSession, requireAdmin } = require('../lib/auth');

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validPassword(value) { return typeof value === 'string' && value.length >= 8; }
function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '+254' + compact.slice(1);
  return /^\+254[17]\d{8}$/.test(compact) ? compact : null;
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function publicAdmin(admin) { return { email: admin.email, phone: admin.phone, createdAt: admin.createdAt }; }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    const db = await getDatabase();
    await initializeDatabase(db);
    const admins = db.collection('admins');
    const adminCount = await admins.countDocuments();
    const session = readSession(req);

    if (req.method === 'GET') {
      return res.status(200).json({ setupRequired: adminCount === 0, authenticated: Boolean(session), user: session ? { email: session.email } : null });
    }

    const body = req.body || {};
    if (body.action === 'setup') {
      if (adminCount > 0) return res.status(409).json({ error: 'Administrator account already exists. Use login instead.' });
      const email = normalizeEmail(body.email);
      const phone = normalizePhone(body.phone);
      if (!validEmail(email) || !phone || !validPassword(body.password)) return res.status(400).json({ error: 'Enter a valid email, Kenyan phone number, and password with at least 8 characters.' });
      const admin = { email, phone, passwordHash: await hashPassword(body.password), createdAt: new Date(), updatedAt: new Date() };
      await admins.insertOne(admin);
      setSession(res, admin);
      return res.status(201).json({ user: publicAdmin(admin) });
    }

    if (body.action === 'login') {
      const email = normalizeEmail(body.email);
      const admin = await admins.findOne({ email });
      if (!admin || !await verifyPassword(String(body.password || ''), admin.passwordHash)) return res.status(401).json({ error: 'Incorrect email or password.' });
      setSession(res, admin);
      return res.status(200).json({ user: publicAdmin(admin) });
    }

    if (body.action === 'logout') {
      clearSession(res);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'change-password') {
      if (!requireAdmin(req, res)) return;
      const current = readSession(req);
      const admin = await admins.findOne({ email: current.email });
      if (!admin || !await verifyPassword(String(body.currentPassword || ''), admin.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
      if (!validPassword(body.newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      await admins.updateOne({ _id: admin._id }, { $set: { passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() } });
      setSession(res, admin);
      return res.status(200).json({ ok: true });
    }

    if (body.action === 'delete-account') {
      if (!requireAdmin(req, res)) return;
      if (body.confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm account removal.' });
      const current = readSession(req);
      const admin = await admins.findOne({ email: current.email });
      if (!admin || !await verifyPassword(String(body.password || ''), admin.passwordHash)) return res.status(401).json({ error: 'Password is incorrect.' });
      await admins.deleteOne({ _id: admin._id });
      clearSession(res);
      return res.status(200).json({ ok: true, message: 'Administrator account deleted. Tenant and room records were preserved.' });
    }

    return res.status(400).json({ error: 'Unknown authentication action.' });
  } catch (error) {
    console.error('SEGUTON auth error:', error);
    return res.status(500).json({ error: error.message.includes('SESSION_SECRET') ? error.message : 'Authentication service is unavailable. Check the database connection and SESSION_SECRET.' });
  }
};
