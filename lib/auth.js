const crypto = require('crypto');
const bcrypt = require('bcryptjs');

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters in Vercel');
  return secret;
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret()).update(value).digest('base64url');
}

function createSession(user) {
  const payload = Buffer.from(JSON.stringify({ id: String(user._id || user.id), email: user.email, exp: Date.now() + 1000 * 60 * 60 * 12 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readSession(req) {
  const cookies = String(req.headers.cookie || '').split(';').reduce((result, item) => {
    const index = item.indexOf('=');
    if (index > -1) result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1));
    return result;
  }, {});
  const token = cookies.seguton_session;
  if (!token) return null;
  const [payload, signature] = token.split('.');
  const expected = sign(payload);
  if (!payload || !signature || signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}

function setSession(res, user) {
  res.setHeader('Set-Cookie', `seguton_session=${encodeURIComponent(createSession(user))}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', 'seguton_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
}

async function hashPassword(password) { return bcrypt.hash(password, 12); }
async function verifyPassword(password, hash) { return bcrypt.compare(password, hash); }

function requireAdmin(req, res) {
  const session = readSession(req);
  if (!session) { res.status(401).json({ error: 'Administrator login required' }); return null; }
  return session;
}

module.exports = { hashPassword, verifyPassword, setSession, clearSession, readSession, requireAdmin };
