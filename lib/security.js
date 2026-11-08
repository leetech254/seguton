const attempts = new Map();

function clientAddress(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.socket?.remoteAddress || 'unknown');
}

function applicationOrigin(req) {
  if (process.env.APP_URL) {
    try { return new URL(process.env.APP_URL).origin; } catch (error) { /* fall through */ }
  }
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return host ? `${protocol}://${host}` : null;
}

function originAllowed(req) {
  const origin = req.headers.origin;
  return !origin || !applicationOrigin(req) || origin === applicationOrigin(req);
}

function setSecurityHeaders(req, res, methods) {
  const origin = req.headers.origin;
  if (origin && originAllowed(req)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  return originAllowed(req);
}

function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfter: 0 };
  }
  current.count += 1;
  if (current.count > limit) return { allowed: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
  return { allowed: true, retryAfter: 0 };
}

function clearRateLimit(key) { attempts.delete(key); }

function rateLimitKey(req, scope, identity = '') { return `${scope}:${clientAddress(req)}:${String(identity).trim().toLowerCase()}`; }

module.exports = { clientAddress, setSecurityHeaders, originAllowed, consumeRateLimit, clearRateLimit, rateLimitKey };
