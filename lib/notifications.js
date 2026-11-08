const DEFAULT_TIMEOUT_MS = 10000;
const MAX_EMAIL_RETRIES = 2;
const { normalizeKenyanPhone } = require('./phone');

function normalizePhone(value) { return normalizeKenyanPhone(value); }

function validSender(value) {
  const sender = String(value || '').trim();
  const local = "[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+";
  const domain = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+`;
  return new RegExp(`^(?:(?:[^<>]+\\s*)?<${local}@${domain}>|${local}@${domain})$`).test(sender);
}

function emailConfigurationError() {
  if (!process.env.RESEND_API_KEY) return 'RESEND_API_KEY is missing.';
  if (!process.env.NOTIFICATION_FROM_EMAIL) return 'NOTIFICATION_FROM_EMAIL is missing.';
  if (!validSender(process.env.NOTIFICATION_FROM_EMAIL)) {
    if (/https?:\/\//i.test(process.env.NOTIFICATION_FROM_EMAIL)) return 'NOTIFICATION_FROM_EMAIL must contain an email domain, not a URL. Use SEGUTON <notifications@seguton.yemtech.store> — remove https://.';
    return 'NOTIFICATION_FROM_EMAIL must be a valid email or display name such as SEGUTON <notifications@example.com>.';
  }
  if (!process.env.APP_URL) return 'APP_URL is missing.';
  try { new URL(process.env.APP_URL); } catch (error) { return 'APP_URL must be a complete public URL such as https://seguton.example.com.'; }
  return null;
}

function assertEmailConfiguration() {
  const error = emailConfigurationError();
  if (error) throw new Error(`Email configuration error: ${error}`);
}

function senderEmail(value) {
  const sender = String(value || '').trim();
  const displayMatch = sender.match(/<([^<>]+)>/);
  return displayMatch ? displayMatch[1].trim() : sender;
}
function canonicalSender() { return `SEGUTON <${senderEmail(process.env.NOTIFICATION_FROM_EMAIL)}>`; }

function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character])); }
function notificationEmailTemplate(kicker, heading, greeting, details, footer = 'If you did not expect this message, contact SEGUTON Estate management.') {
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head><body style="margin:0;background:#eef3f8;font-family:Arial,Helvetica,sans-serif;color:#243447"><div style="max-width:620px;margin:0 auto;padding:24px 15px"><div style="background:#102235;border-radius:16px 16px 0 0;padding:21px 23px;color:#f1c40f;font-size:21px;font-weight:800;letter-spacing:1px">🏠 SEGUTON <span style="display:block;color:#aebdca;font-size:10px;letter-spacing:1.5px;margin-top:5px">ESTATE MANAGEMENT</span></div><div style="background:#fff;padding:28px 23px;border-radius:0 0 16px 16px;box-shadow:0 8px 24px rgba(16,34,53,.12)"><p style="color:#9a7300;font-size:10px;font-weight:800;letter-spacing:1.4px;text-transform:uppercase;margin:0 0 10px">${escapeHtml(kicker)}</p><h1 style="font-size:24px;line-height:1.25;margin:0 0 16px;color:#243447">${escapeHtml(heading)}</h1><p style="font-size:15px;line-height:1.6;margin:0 0 16px;color:#526273">${escapeHtml(greeting)}</p><div style="background:#f6f8fa;border:1px solid #e5eaf0;border-radius:10px;padding:15px 16px;font-size:14px;line-height:1.7;color:#526273">${details}</div><p style="font-size:12px;line-height:1.5;color:#7b8794;margin:22px 0 0">${escapeHtml(footer)}</p></div><p style="text-align:center;color:#8a98a8;font-size:11px;margin:16px 0">SEGUTON Estate Management · Secure notifications</p></div></body></html>`;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function sendResendEmail(to, subject, text, html) {
  if (!process.env.RESEND_API_KEY || !to) return { channel: 'email', skipped: true };
  if (!process.env.NOTIFICATION_FROM_EMAIL) return { channel: 'email', skipped: true, reason: 'sender-not-configured' };
  if (!validSender(process.env.NOTIFICATION_FROM_EMAIL)) return { channel: 'email', skipped: true, reason: 'sender-invalid' };
  const payload = { from: canonicalSender(), to: [to], subject: String(subject || '').slice(0, 200), text: String(text || '').slice(0, 10000) };
  if (html) payload.html = String(html).slice(0, 30000);
  for (let attempt = 0; attempt <= MAX_EMAIL_RETRIES; attempt += 1) {
    let response;
    try {
      response = await fetchWithTimeout('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (error) {
      if (attempt === MAX_EMAIL_RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
      continue;
    }
    if (response.ok) {
      const result = await response.json().catch(() => ({}));
      return { channel: 'email', sent: true, id: result.id || null, attempts: attempt + 1 };
    }
    const providerBody = await response.text().catch(() => '');
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === MAX_EMAIL_RETRIES) {
      let detail = providerBody.slice(0, 500);
      try { const parsed = JSON.parse(providerBody); detail = parsed.message || parsed.error || detail; } catch (error) { /* Keep provider text. */ }
      throw new Error(`Email provider returned ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
  }
  return { channel: 'email', skipped: true };
}

async function sendRequiredResendEmail(to, subject, text, html) {
  assertEmailConfiguration();
  const result = await sendResendEmail(to, subject, text, html);
  if (!result.sent) throw new Error(`Email was not sent${result.reason ? `: ${result.reason}` : '.'}`);
  return result;
}

async function sendEmail(tenant, subject, text, html) {
  return sendResendEmail(tenant.email, subject, text, html);
}

async function sendSms(tenant, message) {
  const phone = normalizePhone(tenant.phone);
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME || !phone) return { channel: 'sms', skipped: true };
  const params = new URLSearchParams({ username: process.env.AT_USERNAME, to: phone, message });
  if (process.env.AT_SENDER_ID) params.set('from', process.env.AT_SENDER_ID);
  const response = await fetchWithTimeout('https://api.africastalking.com/version1/messaging', {
    method: 'POST', headers: { apiKey: process.env.AT_API_KEY, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: params
  });
  if (!response.ok) throw new Error(`SMS provider returned ${response.status}`);
  return { channel: 'sms', sent: true };
}

async function notifyTenant(tenant, event) {
  const amount = Number(event.amount || 0).toLocaleString();
  const balance = Number(event.balance || 0).toLocaleString();
  const subject = `${event.title} - SEGUTON ${tenant.houseNo}`;
  const text = `Hello ${tenant.name},\n\n${event.title}: Ksh ${amount}${event.detail ? ` (${event.detail})` : ''}.\nYour current balance is Ksh ${balance}.\nRoom: ${tenant.houseNo}.${event.receipt ? `\nReceipt: ${event.receipt}.` : ''}\n\nSEGUTON Estate`;
  const html = notificationEmailTemplate('TENANT ACCOUNT UPDATE', event.title, `Hello ${tenant.name}, here is an update for your SEGUTON tenant account.`, `<strong>Amount:</strong> Ksh ${escapeHtml(amount)}<br><strong>Current balance:</strong> Ksh ${escapeHtml(balance)}<br><strong>Room:</strong> ${escapeHtml(tenant.houseNo)}${event.detail ? `<br><strong>Details:</strong> ${escapeHtml(event.detail)}` : ''}${event.receipt ? `<br><strong>Receipt:</strong> ${escapeHtml(event.receipt)}` : ''}`);
  const preference = event.preference || 'account';
  const preferences = tenant.notificationPreferences || {};
  const emailEnabled = preferences[preference] !== false;
  const results = await Promise.allSettled([emailEnabled ? sendEmail(tenant, subject, text, html) : Promise.resolve({ channel: 'email', skipped: true, reason: 'preference-disabled' }), sendSms(tenant, text)]);
  results.filter(result => result.status === 'rejected').forEach(result => console.error('SEGUTON notification failed:', result.reason?.message || result.reason));
  return results.map(result => result.status === 'fulfilled' ? result.value : { skipped: true });
}

async function notifyTenantAccountUpdate(tenant, event) {
  if (!tenant.email || tenant.notificationPreferences?.account === false) return { skipped: true, reason: 'preference-disabled' };
  const text = `Hello ${tenant.name},\n\n${event.title}\n\n${event.details}\n\nRoom: ${tenant.houseNo}.\nIf you did not make this change, contact SEGUTON Estate management.\n\nSEGUTON Estate`;
  const html = notificationEmailTemplate('ACCOUNT & CONTACT', event.title, `Hello ${tenant.name}, your SEGUTON account has been updated.`, `${escapeHtml(event.details)}<br><strong>Room:</strong> ${escapeHtml(tenant.houseNo)}`);
  try { return await sendResendEmail(tenant.email, `SEGUTON account update - ${tenant.houseNo}`, text, html); }
  catch (error) { console.error('SEGUTON tenant account notification failed:', error.message); return { skipped: true }; }
}

async function notifyAdmins(db, event) {
  if (!db || !process.env.RESEND_API_KEY) return { skipped: true };
  try {
    const admins = await db.collection('admins').find({ email: { $exists: true, $ne: '' }, emailVerified: true }, { projection: { email: 1 } }).toArray();
    const text = `SEGUTON Estate administrator update\n\n${event.title}\n${event.details}\n\nTime: ${new Date().toLocaleString()}\nSEGUTON Management Console`;
    const html = notificationEmailTemplate('ADMINISTRATOR ALERT', event.title, 'A new event was recorded in the SEGUTON management console.', `${escapeHtml(event.details)}<br><strong>Time:</strong> ${escapeHtml(new Date().toLocaleString())}`);
    const results = await Promise.allSettled(admins.map(admin => sendResendEmail(admin.email, `SEGUTON admin update: ${event.title}`, text, html)));
    results.filter(result => result.status === 'rejected').forEach(result => console.error('SEGUTON admin notification failed:', result.reason?.message || result.reason));
    const delivered = results.filter(result => result.status === 'fulfilled' && result.value?.sent).length;
    const skipped = results.filter(result => result.status === 'fulfilled' && result.value?.skipped).length;
    return { sent: delivered, skipped, failed: results.length - delivered - skipped, attempted: admins.length };
  } catch (error) {
    console.error('SEGUTON admin notification lookup failed:', error.message);
    return { skipped: true };
  }
}

module.exports = { sendResendEmail, sendRequiredResendEmail, assertEmailConfiguration, emailConfigurationError, notifyTenant, notifyTenantAccountUpdate, notifyAdmins };
