const DEFAULT_TIMEOUT_MS = 8000;

function normalizePhone(value) {
  const compact = String(value || '').replace(/[\s-]/g, '');
  if (/^0[17]\d{8}$/.test(compact)) return '+254' + compact.slice(1);
  return /^\+254[17]\d{8}$/.test(compact) ? compact : null;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function sendResendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !to) return { channel: 'email', skipped: true };
  const response = await fetchWithTimeout('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.NOTIFICATION_FROM_EMAIL || 'SEGUTON <onboarding@resend.dev>',
      to: [to], subject, text
    })
  });
  if (!response.ok) throw new Error(`Email provider returned ${response.status}`);
  return { channel: 'email', sent: true };
}

async function sendEmail(tenant, subject, text) {
  return sendResendEmail(tenant.email, subject, text);
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
  const results = await Promise.allSettled([sendEmail(tenant, subject, text), sendSms(tenant, text)]);
  results.filter(result => result.status === 'rejected').forEach(result => console.error('SEGUTON notification failed:', result.reason?.message || result.reason));
  return results.map(result => result.status === 'fulfilled' ? result.value : { skipped: true });
}

async function notifyTenantAccountUpdate(tenant, event) {
  if (!tenant.email) return { skipped: true };
  const text = `Hello ${tenant.name},\n\n${event.title}\n\n${event.details}\n\nRoom: ${tenant.houseNo}.\nIf you did not make this change, contact SEGUTON Estate management.\n\nSEGUTON Estate`;
  try { return await sendResendEmail(tenant.email, `SEGUTON account update - ${tenant.houseNo}`, text); }
  catch (error) { console.error('SEGUTON tenant account notification failed:', error.message); return { skipped: true }; }
}

async function notifyAdmins(db, event) {
  if (!db || !process.env.RESEND_API_KEY) return { skipped: true };
  try {
    const admins = await db.collection('admins').find({ email: { $exists: true, $ne: '' } }, { projection: { email: 1 } }).toArray();
    const text = `SEGUTON Estate administrator update\n\n${event.title}\n${event.details}\n\nTime: ${new Date().toLocaleString()}\nSEGUTON Management Console`;
    const results = await Promise.allSettled(admins.map(admin => sendResendEmail(admin.email, `SEGUTON admin update: ${event.title}`, text)));
    results.filter(result => result.status === 'rejected').forEach(result => console.error('SEGUTON admin notification failed:', result.reason?.message || result.reason));
    return { sent: results.filter(result => result.status === 'fulfilled').length, attempted: admins.length };
  } catch (error) {
    console.error('SEGUTON admin notification lookup failed:', error.message);
    return { skipped: true };
  }
}

module.exports = { notifyTenant, notifyTenantAccountUpdate, notifyAdmins };
