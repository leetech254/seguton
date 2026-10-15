const crypto = require('crypto');
const { getDatabase, initializeDatabase } = require('../lib/database');
const { hashPassword, verifyPassword, setSession, clearSession, readSession, requireAdmin } = require('../lib/auth');
const { sendResendEmail } = require('../lib/notifications');

function normalizeEmail(value) { return String(value || '').trim().toLowerCase(); }
function validPassword(value) { return typeof value === 'string' && value.length >= 8; }
function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '+254' + compact.slice(1);
  return /^\+254[17]\d{8}$/.test(compact) ? compact : null;
}
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function publicAdmin(admin) { return { email: admin.email, phone: admin.phone, createdAt: admin.createdAt, emailVerified: Boolean(admin.emailVerified) }; }
function createToken() {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: crypto.createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 1000 * 60 * 30) };
}
function hashToken(token) { return crypto.createHash('sha256').update(String(token || '')).digest('hex'); }
function baseUrl(req) { return (process.env.APP_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`).replace(/\/$/, ''); }
function authUrl(req, action, token) { return `${baseUrl(req)}/api/auth?action=${action}&token=${encodeURIComponent(token)}`; }
async function sendAdminVerification(req, admin, token) {
  return sendResendEmail(admin.email, 'Verify your SEGUTON administrator email', `Hello,\n\nVerify your SEGUTON administrator email by opening this link:\n${authUrl(req, 'verify-email', token)}\n\nThis link expires in 30 minutes.\n\nSEGUTON Estate Management`);
}
async function sendPasswordReset(req, admin, token) {
  const resetUrl = `${baseUrl(req)}/?reset_token=${encodeURIComponent(token)}`;
  return sendResendEmail(admin.email, 'Reset your SEGUTON administrator password', `Hello,\n\nA password reset was requested for your SEGUTON administrator account. Open this link to choose a new password:\n${resetUrl}\n\nThis link expires in 30 minutes. If you did not request this, ignore this message.\n\nSEGUTON Estate Management`);
}
function htmlMessage(title, message) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif;padding:32px;color:#243447"><h1>${title}</h1><p>${message}</p><p>You can close this window and return to SEGUTON.</p></body></html>`;
}

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
      const action = String(req.query?.action || '');
      if (action === 'verify-email') {
        const admin = await admins.findOne({ emailVerificationTokenHash: hashToken(req.query?.token), emailVerificationExpiresAt: { $gt: new Date() } });
        if (!admin) { res.status(400).setHeader('Content-Type', 'text/html').end(htmlMessage('Verification link expired', 'Request a new verification email from the management login page.')); return; }
        await admins.updateOne({ _id: admin._id }, { $set: { emailVerified: true, updatedAt: new Date() }, $unset: { emailVerificationTokenHash: '', emailVerificationExpiresAt: '' } });
        res.status(200).setHeader('Content-Type', 'text/html').end(htmlMessage('Email verified', 'Your administrator email is verified. Return to SEGUTON and sign in.')); return;
      }
      if (action === 'reset-password') {
        const admin = await admins.findOne({ passwordResetTokenHash: hashToken(req.query?.token), passwordResetExpiresAt: { $gt: new Date() } });
        if (!admin) { res.status(400).setHeader('Content-Type', 'text/html').end(htmlMessage('Reset link expired', 'Request another password reset link from the management login page.')); return; }
        res.status(200).setHeader('Content-Type', 'text/html').end(htmlMessage('Reset link ready', 'Return to SEGUTON, enter the reset token from this link if the app requests it, and choose a new password.')); return;
      }
      return res.status(200).json({ setupRequired: adminCount === 0, authenticated: Boolean(session), user: session ? { email: session.email } : null });
    }

    const body = req.body || {};
    if (body.action === 'setup') {
      if (adminCount > 0) return res.status(409).json({ error: 'Administrator account already exists. Use login instead.' });
      if (!process.env.RESEND_API_KEY) return res.status(503).json({ error: 'Email verification is not configured. Add RESEND_API_KEY in Vercel before creating the administrator account.' });
      const email = normalizeEmail(body.email); const phone = normalizePhone(body.phone);
      if (!validEmail(email) || !phone || !validPassword(body.password)) return res.status(400).json({ error: 'Enter a valid email, Kenyan phone number, and password with at least 8 characters.' });
      const verification = createToken();
      const admin = { email, phone, passwordHash: await hashPassword(body.password), emailVerified: false, emailVerificationTokenHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt, createdAt: new Date(), updatedAt: new Date() };
      try { await sendAdminVerification(req, admin, verification.token); } catch (error) { return res.status(502).json({ error: 'Verification email could not be sent. Check your email sender configuration and try again.' }); }
      await admins.insertOne(admin);
      return res.status(201).json({ verificationRequired: true, email, message: 'Administrator created. Check your email and open the verification link before signing in.' });
    }

    if (body.action === 'login') {
      const email = normalizeEmail(body.email); const admin = await admins.findOne({ email });
      if (!admin || !await verifyPassword(String(body.password || ''), admin.passwordHash)) return res.status(401).json({ error: 'Incorrect email or password.' });
      if (admin.emailVerified !== true) return res.status(403).json({ error: 'Verify your administrator email before signing in.', verificationRequired: true });
      setSession(res, admin); return res.status(200).json({ user: publicAdmin(admin) });
    }

    if (body.action === 'resend-verification') {
      const email = normalizeEmail(body.email); const admin = await admins.findOne({ email });
      if (admin && admin.emailVerified !== true && process.env.RESEND_API_KEY) {
        const verification = createToken(); await admins.updateOne({ _id: admin._id }, { $set: { emailVerificationTokenHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt } });
        try { await sendAdminVerification(req, admin, verification.token); } catch (error) { console.error('SEGUTON verification resend failed:', error.message); }
      }
      return res.status(200).json({ ok: true, message: 'If that administrator email needs verification, a new link has been sent.' });
    }

    if (body.action === 'forgot-password') {
      const email = normalizeEmail(body.email); const admin = await admins.findOne({ email });
      if (admin && process.env.RESEND_API_KEY) { const reset = createToken(); await admins.updateOne({ _id: admin._id }, { $set: { passwordResetTokenHash: reset.hash, passwordResetExpiresAt: reset.expiresAt } }); try { await sendPasswordReset(req, admin, reset.token); } catch (error) { console.error('SEGUTON password reset email failed:', error.message); } }
      return res.status(200).json({ ok: true, message: 'If an administrator account exists for that email, password reset instructions have been sent.' });
    }

    if (body.action === 'reset-password') {
      const token = String(body.token || ''); const admin = await admins.findOne({ passwordResetTokenHash: hashToken(token), passwordResetExpiresAt: { $gt: new Date() } });
      if (!admin) return res.status(400).json({ error: 'This password reset link is invalid or expired. Request a new one.' });
      if (!validPassword(body.password)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      await admins.updateOne({ _id: admin._id }, { $set: { passwordHash: await hashPassword(body.password), emailVerified: true, updatedAt: new Date() }, $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' } });
      return res.status(200).json({ ok: true, message: 'Password reset successfully. You can now sign in.' });
    }

    if (body.action === 'logout') { clearSession(res); return res.status(200).json({ ok: true }); }
    if (body.action === 'change-password') {
      if (!requireAdmin(req, res)) return; const current = readSession(req); const admin = await admins.findOne({ email: current.email });
      if (!admin || !await verifyPassword(String(body.currentPassword || ''), admin.passwordHash)) return res.status(401).json({ error: 'Current password is incorrect.' });
      if (!validPassword(body.newPassword)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      await admins.updateOne({ _id: admin._id }, { $set: { passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() } }); setSession(res, admin); return res.status(200).json({ ok: true });
    }
    if (body.action === 'delete-account') {
      if (!requireAdmin(req, res)) return; if (body.confirmation !== 'DELETE') return res.status(400).json({ error: 'Type DELETE to confirm account removal.' });
      const current = readSession(req); const admin = await admins.findOne({ email: current.email });
      if (!admin || !await verifyPassword(String(body.password || ''), admin.passwordHash)) return res.status(401).json({ error: 'Password is incorrect.' });
      await admins.deleteOne({ _id: admin._id }); clearSession(res); return res.status(200).json({ ok: true, message: 'Administrator account deleted. Tenant and room records were preserved.' });
    }
    return res.status(400).json({ error: 'Unknown authentication action.' });
  } catch (error) {
    console.error('SEGUTON auth error:', error);
    return res.status(500).json({ error: error.message.includes('SESSION_SECRET') ? error.message : 'Authentication service is unavailable. Check the database connection and SESSION_SECRET.' });
  }
};
