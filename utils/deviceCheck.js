// New-device check for organizer logins.
// Turned on only when DEVICE_CHECK_ENABLED=true, so it can be switched off
// instantly from Render's environment settings if anything goes wrong.

const crypto = require('crypto');

const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const DEVICE_CODE_MAX_ATTEMPTS = 5;
const DEVICE_CODE_RESEND_GAP_MS = 30 * 1000;
const DEVICE_CODE_MAX_RESENDS = 5;
const TRUSTED_DEVICE_DAYS = 30;

const isDeviceCheckEnabled = () => String(process.env.DEVICE_CHECK_ENABLED || '').trim().toLowerCase() === 'true';

const deviceSecret = () => process.env.OTP_SECRET || process.env.JWT_SECRET || 'ingather-development-device-secret';

const normalizeDeviceId = (deviceId) => {
  const value = String(deviceId || '').trim();
  return /^[A-Za-z0-9-]{16,100}$/.test(value) ? value : '';
};

// A device with no id (very old browser, private mode) gets a one-off hash,
// so it is always treated as new and can never be remembered.
const hashDeviceId = (deviceId) => {
  const id = normalizeDeviceId(deviceId) || `anonymous-${crypto.randomUUID()}`;
  return crypto.createHmac('sha256', deviceSecret()).update(`device:${id}`).digest('hex');
};

const hashDeviceCode = (challengeId, code) => crypto
  .createHmac('sha256', deviceSecret())
  .update(`device-code:${challengeId}:${String(code || '').trim()}`)
  .digest('hex');

const safeEqualHex = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
};

const describeDevice = (userAgent) => {
  const ua = String(userAgent || '');
  let browser = 'A browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/SamsungBrowser/.test(ua)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
  else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let platform = 'an unknown device';
  if (/iPhone/.test(ua)) platform = 'iPhone';
  else if (/iPad/.test(ua)) platform = 'iPad';
  else if (/Android/.test(ua)) platform = 'Android';
  else if (/Windows/.test(ua)) platform = 'Windows';
  else if (/Macintosh|Mac OS X/.test(ua)) platform = 'Mac';
  else if (/Linux/.test(ua)) platform = 'Linux';

  return `${browser} on ${platform}`.slice(0, 160);
};

const maskEmail = (email) => {
  const [local = '', domain = ''] = String(email || '').split('@');
  if (!domain) return '';
  const first = local.slice(0, 1);
  const last = local.length > 2 ? local.slice(-1) : '';
  return `${first}•••${last}@${domain}`;
};

const formatLagosTime = (date = new Date()) => new Date(date).toLocaleString('en-GB', {
  timeZone: 'Africa/Lagos',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
});

const isMissingTableError = (error) => error && error.code === '42P01';

module.exports = {
  DEVICE_CODE_MAX_ATTEMPTS,
  DEVICE_CODE_MAX_RESENDS,
  DEVICE_CODE_RESEND_GAP_MS,
  DEVICE_CODE_TTL_MS,
  TRUSTED_DEVICE_DAYS,
  describeDevice,
  formatLagosTime,
  hashDeviceCode,
  hashDeviceId,
  isDeviceCheckEnabled,
  isMissingTableError,
  maskEmail,
  normalizeDeviceId,
  safeEqualHex
};
