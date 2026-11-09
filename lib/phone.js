function normalizeKenyanPhone(value, format = 'international') {
  const compact = String(value || '').trim().replace(/[\s().-]/g, '');
  let digits = compact;
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00254')) digits = digits.slice(2);
  if (/^0[17]\d{8}$/.test(digits)) digits = `254${digits.slice(1)}`;
  if (!/^254[17]\d{8}$/.test(digits)) return null;
  return format === 'mpesa' ? digits : `+${digits}`;
}

function phoneVariants(value) {
  const international = normalizeKenyanPhone(value, 'international');
  if (!international) return [];
  const digits = international.slice(1);
  const local = `0${digits.slice(3)}`;
  return [international, digits, local];
}

module.exports = { normalizeKenyanPhone, phoneVariants };
