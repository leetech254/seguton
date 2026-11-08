const crypto = require('crypto');
const { getDatabase, initializeDatabase } = require('../lib/database');
const { hashPassword, verifyPassword, setSession, clearSession, readSession, requireAdmin } = require('../lib/auth');
const { sendResendEmail, sendRequiredResendEmail, assertEmailConfiguration } = require('../lib/notifications');
const { setSecurityHeaders, consumeRateLimit, clearRateLimit, rateLimitKey } = require('../lib/security');

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
function baseUrl(req) {
  const configured = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  return new URL(configured).origin;
}
function authUrl(req, action, token) {
  const url = new URL('/api/auth', baseUrl(req));
  url.searchParams.set('action', action); url.searchParams.set('token', token);
  return url.toString();
}
async function sendAdminVerification(req, admin, token) {
  const url = authUrl(req, 'verify-email', token);
  return sendRequiredResendEmail(admin.email, 'Verify your SEGUTON administrator email', `Hello,\n\nVerify your SEGUTON administrator email by opening this link:\n${url}\n\nThis link expires in 30 minutes.\n\nSEGUTON Estate Management`, emailTemplate('Verify your administrator email', 'Confirm your SEGUTON management account', 'Open the button below to verify your email and activate administrator login. This link expires in 30 minutes.', 'Verify administrator email', url, 'If you did not create this account, you can ignore this email.'));
}
async function sendPasswordReset(req, admin, token) {
  const resetUrlObject = new URL('/', baseUrl(req)); resetUrlObject.searchParams.set('reset_token', token);
  const resetUrl = resetUrlObject.toString();
  return sendRequiredResendEmail(admin.email, 'Reset your SEGUTON administrator password', `Hello,\n\nA password reset was requested for your SEGUTON administrator account. Open this link to choose a new password:\n${resetUrl}\n\nThis link expires in 30 minutes. If you did not request this, ignore this message.\n\nSEGUTON Estate Management`, emailTemplate('Reset your administrator password', 'Password reset requested', 'Use the secure button below to choose a new administrator password. This link expires in 30 minutes.', 'Reset administrator password', resetUrl, 'If you did not request this reset, ignore this email and your password will remain unchanged.'));
}
async function sendEmailChangeConfirmation(req, email, token) {
  const url = authUrl(req, 'confirm-email-change', token);
  return sendRequiredResendEmail(email, 'Confirm your SEGUTON administrator email change', `Hello,\n\nConfirm this new email address for your SEGUTON administrator account by opening this link:\n${url}\n\nThis link expires in 30 minutes. Your current administrator email remains active until confirmation.\n\nSEGUTON Estate Management`, emailTemplate('Confirm your new email', 'Confirm your SEGUTON email change', 'You requested a new email address for administrator notifications and login. Confirm it below; your current email remains active until then.', 'Confirm new email address', url, 'If you did not request this change, ignore this email. Your current administrator email remains active.'));
}
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character])); }
function emailTemplate(title, heading, message, buttonLabel, buttonUrl, footer) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;background:#eef3f8;font-family:Arial,Helvetica,sans-serif;color:#243447"><div style="max-width:620px;margin:0 auto;padding:28px 16px"><div style="background:#102235;border-radius:16px 16px 0 0;padding:22px 24px;color:#f1c40f;font-size:22px;font-weight:800;letter-spacing:1px">🏠 SEGUTON <span style="display:block;color:#aebdca;font-size:11px;letter-spacing:1.5px;margin-top:5px">ESTATE MANAGEMENT</span></div><div style="background:#fff;padding:32px 24px;border-radius:0 0 16px 16px;box-shadow:0 8px 24px rgba(16,34,53,.12)"><p style="color:#9a7300;font-size:11px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;margin:0 0 10px">${escapeHtml(title)}</p><h1 style="font-size:26px;line-height:1.2;margin:0 0 14px;color:#243447">${escapeHtml(heading)}</h1><p style="font-size:16px;line-height:1.6;margin:0 0 24px;color:#526273">${escapeHtml(message)}</p><a href="${escapeHtml(buttonUrl)}" style="display:inline-block;background:#f1c40f;color:#17283c;text-decoration:none;font-weight:800;border-radius:10px;padding:14px 18px">${escapeHtml(buttonLabel)}</a><p style="font-size:12px;line-height:1.5;color:#7b8794;margin:26px 0 0">${escapeHtml(footer)}</p><p style="font-size:12px;line-height:1.5;color:#9aa6b2;margin:18px 0 0">If the button does not work, copy and paste the link from the plain-text version of this email into your browser.</p></div><p style="text-align:center;color:#8a98a8;font-size:11px;margin:18px 0">SEGUTON Estate Management · Secure administrator notifications</p></div></body></html>`;
}
function htmlMessage(title, message) {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#eef3f8;font-family:Arial,sans-serif;padding:32px;color:#243447"><main style="max-width:620px;margin:auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.1)"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p>You can close this window and return to SEGUTON.</p></main></body></html>`;
}

module.exports = async (req, res) => {
  if (!setSecurityHeaders(req, res, 'GET,POST,OPTIONS')) return res.status(403).json({ error: 'Origin is not allowed.' });
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
        if (!admin) { res.status(400).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Verification link expired', 'Request a new verification email from the management login page.')); return; }
        await admins.updateOne({ _id: admin._id }, { $set: { emailVerified: true, updatedAt: new Date() }, $unset: { emailVerificationTokenHash: '', emailVerificationExpiresAt: '' } });
        res.status(200).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Email verified', 'Your administrator email is verified. Return to SEGUTON and sign in.')); return;
      }
      if (action === 'confirm-email-change') {
        const admin = await admins.findOne({ pendingEmailTokenHash: hashToken(req.query?.token), pendingEmailExpiresAt: { $gt: new Date() } });
        if (!admin) { res.status(400).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Email change link expired', 'Request a new administrator email change link from SEGUTON settings.')); return; }
        const nextEmail = normalizeEmail(admin.pendingEmail);
        if (!validEmail(nextEmail) || await admins.findOne({ email: nextEmail, _id: { $ne: admin._id } })) { res.status(409).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Email change unavailable', 'That email address is already in use. Return to SEGUTON and request a different address.')); return; }
        await admins.updateOne({ _id: admin._id }, { $set: { email: nextEmail, emailVerified: true, updatedAt: new Date() }, $unset: { pendingEmail: '', pendingEmailTokenHash: '', pendingEmailExpiresAt: '' } });
        const currentSession = readSession(req);
        if (currentSession && currentSession.id === String(admin._id)) setSession(res, { ...admin, email: nextEmail });
        try { await sendResendEmail(nextEmail, 'SEGUTON administrator email updated', 'Your SEGUTON administrator email has been updated successfully. If you did not make this change, contact estate management immediately.'); } catch (error) { console.error('SEGUTON email-change confirmation failed:', error.message); }
        res.status(200).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Email updated', 'Your administrator email has been updated. Return to SEGUTON and sign in with the new email address.')); return;
      }
      if (action === 'reset-password') {
        const admin = await admins.findOne({ passwordResetTokenHash: hashToken(req.query?.token), passwordResetExpiresAt: { $gt: new Date() } });
        if (!admin) { res.status(400).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Reset link expired', 'Request another password reset link from the management login page.')); return; }
        res.status(200).setHeader('Cache-Control', 'no-store').setHeader('Referrer-Policy', 'no-referrer').setHeader('Content-Type', 'text/html').end(htmlMessage('Reset link ready', 'Return to SEGUTON, enter the reset token from this link if the app requests it, and choose a new password.')); return;
      }
      return res.status(200).json({ setupRequired: adminCount === 0, authenticated: Boolean(session), user: session ? { email: session.email } : null });
    }

    const body = req.body || {};
    if (body.action === 'setup') {
      const setupLimit = consumeRateLimit(rateLimitKey(req, 'admin-setup', body.email), 3, 15 * 60 * 1000);
      if (!setupLimit.allowed) return res.status(429).setHeader('Retry-After', setupLimit.retryAfter).json({ error: 'Too many setup attempts. Try again later.' });
      if (adminCount > 0) return res.status(409).json({ error: 'Administrator account already exists. Use login instead.' });
      try { assertEmailConfiguration(); } catch (error) { return res.status(503).json({ error: error.message }); }
      const email = normalizeEmail(body.email); const phone = normalizePhone(body.phone);
      if (!validEmail(email) || !phone || !validPassword(body.password)) return res.status(400).json({ error: 'Enter a valid email, Kenyan phone number, and password with at least 8 characters.' });
      const verification = createToken();
      const admin = { email, phone, passwordHash: await hashPassword(body.password), emailVerified: false, emailVerificationTokenHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt, createdAt: new Date(), updatedAt: new Date() };
      try { await sendAdminVerification(req, admin, verification.token); } catch (error) { console.error('SEGUTON administrator verification delivery failed:', error.message); return res.status(502).json({ error: 'Verification email could not be sent. Confirm that your Resend API key, verified sender domain, and recipient address are correct, then try again.' }); }
      await admins.insertOne(admin);
      return res.status(201).json({ verificationRequired: true, email, message: 'Administrator created. Check your email and open the verification link before signing in.' });
    }

    if (body.action === 'login') {
      const email = normalizeEmail(body.email);
      const loginKey = rateLimitKey(req, 'admin-login', email);
      const loginLimit = consumeRateLimit(loginKey, 6, 15 * 60 * 1000);
      if (!loginLimit.allowed) return res.status(429).setHeader('Retry-After', loginLimit.retryAfter).json({ error: 'Too many login attempts. Try again later.' });
      const admin = await admins.findOne({ email });
      if (!admin || !await verifyPassword(String(body.password || ''), admin.passwordHash)) return res.status(401).json({ error: 'Incorrect email or password.' });
      if (admin.emailVerified !== true) return res.status(403).json({ error: 'Verify your administrator email before signing in.', verificationRequired: true });
      clearRateLimit(loginKey);
      setSession(res, admin); return res.status(200).json({ user: publicAdmin(admin) });
    }

    if (body.action === 'resend-verification') {
      const resendLimit = consumeRateLimit(rateLimitKey(req, 'admin-resend', body.email), 3, 15 * 60 * 1000);
      if (!resendLimit.allowed) return res.status(429).setHeader('Retry-After', resendLimit.retryAfter).json({ error: 'Too many verification requests. Try again later.' });
      const email = normalizeEmail(body.email); const admin = await admins.findOne({ email });
      if (admin && admin.emailVerified !== true) {
        try { assertEmailConfiguration(); } catch (error) { return res.status(503).json({ error: error.message }); }
        const verification = createToken(); await admins.updateOne({ _id: admin._id }, { $set: { emailVerificationTokenHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt } });
        try { await sendAdminVerification(req, admin, verification.token); } catch (error) { console.error('SEGUTON verification resend failed:', error.message); return res.status(502).json({ error: 'Verification email could not be delivered. Verify your Resend sender/domain configuration and try again.' }); }
      }
      return res.status(200).json({ ok: true, message: 'If that administrator email needs verification, a new link has been sent. Check your inbox and spam folder.' });
    }

    if (body.action === 'forgot-password') {
      const resetLimit = consumeRateLimit(rateLimitKey(req, 'admin-reset', body.email), 3, 15 * 60 * 1000);
      if (!resetLimit.allowed) return res.status(429).setHeader('Retry-After', resetLimit.retryAfter).json({ error: 'Too many password-reset requests. Try again later.' });
      const email = normalizeEmail(body.email); const admin = await admins.findOne({ email });
      if (admin) { try { assertEmailConfiguration(); } catch (error) { console.error('SEGUTON password reset configuration error:', error.message); return res.status(200).json({ ok: true, message: 'If an administrator account exists for that email, password reset instructions have been sent.' }); } const reset = createToken(); await admins.updateOne({ _id: admin._id }, { $set: { passwordResetTokenHash: reset.hash, passwordResetExpiresAt: reset.expiresAt } }); try { await sendPasswordReset(req, admin, reset.token); } catch (error) { console.error('SEGUTON password reset email failed:', error.message); } }
      return res.status(200).json({ ok: true, message: 'If an administrator account exists for that email, password reset instructions have been sent.' });
    }

    if (body.action === 'reset-password') {
      const resetSubmitLimit = consumeRateLimit(rateLimitKey(req, 'admin-reset-submit'), 5, 15 * 60 * 1000);
      if (!resetSubmitLimit.allowed) return res.status(429).setHeader('Retry-After', resetSubmitLimit.retryAfter).json({ error: 'Too many reset attempts. Request a new link later.' });
      const token = String(body.token || ''); const admin = await admins.findOne({ passwordResetTokenHash: hashToken(token), passwordResetExpiresAt: { $gt: new Date() } });
      if (!admin) return res.status(400).json({ error: 'This password reset link is invalid or expired. Request a new one.' });
      if (!validPassword(body.password)) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
      await admins.updateOne({ _id: admin._id }, { $set: { passwordHash: await hashPassword(body.password), emailVerified: true, updatedAt: new Date() }, $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' } });
      return res.status(200).json({ ok: true, message: 'Password reset successfully. You can now sign in.' });
    }

    if (body.action === 'logout') { clearSession(res); return res.status(200).json({ ok: true }); }
    if (body.action === 'request-email-change') {
      if (!requireAdmin(req, res)) return;
      const current = readSession(req); const admin = await admins.findOne({ email: current.email });
      if (!admin) return res.status(401).json({ error: 'Administrator session is no longer valid. Sign in again.' });
      const limit = consumeRateLimit(rateLimitKey(req, 'admin-email-change', body.email), 3, 30 * 60 * 1000);
      if (!limit.allowed) return res.status(429).setHeader('Retry-After', limit.retryAfter).json({ error: 'Too many email-change requests. Try again later.' });
      try { assertEmailConfiguration(); } catch (error) { return res.status(503).json({ error: error.message }); }
      const nextEmail = normalizeEmail(body.email);
      if (!validEmail(nextEmail)) return res.status(400).json({ error: 'Enter a valid email address.' });
      if (nextEmail === admin.email) return res.status(400).json({ error: 'Enter a different email address.' });
      if (await admins.findOne({ email: nextEmail, _id: { $ne: admin._id } })) return res.status(409).json({ error: 'That email address is already in use.' });
      const change = createToken();
      try { await sendEmailChangeConfirmation(req, nextEmail, change.token); } catch (error) { console.error('SEGUTON email-change request failed:', error.message); return res.status(502).json({ error: 'Confirmation email could not be delivered. Verify the Resend sender/domain configuration and try again.' }); }
      await admins.updateOne({ _id: admin._id }, { $set: { pendingEmail: nextEmail, pendingEmailTokenHash: change.hash, pendingEmailExpiresAt: change.expiresAt, updatedAt: new Date() } });
      try { await sendResendEmail(admin.email, 'SEGUTON administrator email change requested', `A request was made to change your SEGUTON administrator email. Your current email remains active until the new address is confirmed. If you did not request this, sign in and change your password immediately.`); } catch (error) { console.error('SEGUTON old-email change alert failed:', error.message); }
      return res.status(200).json({ ok: true, message: 'Confirmation sent to the new email address. Your current email remains active until you confirm the change.' });
    }
    if (body.action === 'add-admin') {
      if (!requireAdmin(req, res)) return;
      const limit = consumeRateLimit(rateLimitKey(req, 'admin-add', body.email), 3, 30 * 60 * 1000);
      if (!limit.allowed) return res.status(429).setHeader('Retry-After', limit.retryAfter).json({ error: 'Too many secondary-admin requests. Try again later.' });
      try { assertEmailConfiguration(); } catch (error) { return res.status(503).json({ error: error.message }); }
      const email = normalizeEmail(body.email); const phone = normalizePhone(body.phone);
      if (!validEmail(email) || !phone || !validPassword(body.password)) return res.status(400).json({ error: 'Enter a valid email, Kenyan phone number, and password with at least 8 characters.' });
      if (await admins.findOne({ email })) return res.status(409).json({ error: 'That administrator email is already in use.' });
      const verification = createToken();
      const secondary = { email, phone, passwordHash: await hashPassword(body.password), emailVerified: false, emailVerificationTokenHash: verification.hash, emailVerificationExpiresAt: verification.expiresAt, createdAt: new Date(), updatedAt: new Date() };
      try { await sendAdminVerification(req, secondary, verification.token); } catch (error) { console.error('SEGUTON secondary administrator delivery failed:', error.message); return res.status(502).json({ error: 'The secondary administrator verification email could not be delivered. Check the Resend sender/domain configuration and try again.' }); }
      try { await admins.insertOne(secondary); } catch (error) { if (error?.code === 11000) return res.status(409).json({ error: 'That administrator email is already in use.' }); throw error; }
      return res.status(201).json({ ok: true, email, message: 'Secondary administrator created. They must verify the email link before signing in.' });
    }
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
