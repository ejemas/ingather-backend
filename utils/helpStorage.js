// Help ticket screenshots, kept in a private Supabase Storage bucket.
// Nobody can open a screenshot without a short-lived signed link from this server.
const crypto = require('crypto');

const DEFAULT_BUCKET = 'help-screenshots';
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const SIGNED_URL_SECONDS = 60 * 60;

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');
const encodePath = (path) => path.split('/').map((part) => encodeURIComponent(part)).join('/');

const getConfig = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Screenshot storage is not configured on the server.');
  }
  return {
    supabaseUrl: trimTrailingSlash(supabaseUrl),
    serviceRoleKey,
    bucket: process.env.SUPABASE_HELP_BUCKET || DEFAULT_BUCKET
  };
};

// Accepts "data:image/png;base64,..." or "data:image/jpeg;base64,...". Returns null when there is no screenshot.
const parseScreenshot = (dataUrl) => {
  if (dataUrl === undefined || dataUrl === null || dataUrl === '') return null;
  const match = typeof dataUrl === 'string'
    ? dataUrl.match(/^data:(image\/(?:png|jpeg|jpg));base64,([A-Za-z0-9+/=]+)$/)
    : null;
  if (!match) {
    const error = new Error('Screenshots must be PNG or JPEG images.');
    error.status = 400;
    throw error;
  }
  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length === 0 || buffer.length > MAX_SCREENSHOT_BYTES) {
    const error = new Error('That screenshot is too large. Use one under 5 MB.');
    error.status = 400;
    throw error;
  }
  return { buffer, mimeType, size: buffer.length };
};

const cleanFileName = (name, mimeType) => {
  const base = String(name || '').split(/[\\/]/).pop().replace(/[^\w.\- ]+/g, '').trim().slice(0, 120);
  if (base) return base;
  return mimeType === 'image/png' ? 'screenshot.png' : 'screenshot.jpg';
};

const uploadHelpScreenshot = async ({ churchId, ticketNumber, screenshot, fileName }) => {
  const { supabaseUrl, serviceRoleKey, bucket } = getConfig();
  const extension = screenshot.mimeType === 'image/png' ? 'png' : 'jpg';
  const path = `church-${churchId}/ticket-${ticketNumber}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const response = await fetch(`${supabaseUrl}/storage/v1/object/${bucket}/${encodePath(path)}`, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': screenshot.mimeType,
      'x-upsert': 'false'
    },
    body: screenshot.buffer
  });

  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`Screenshot upload failed: ${message || response.statusText}`);
  }

  return {
    path,
    name: cleanFileName(fileName, screenshot.mimeType),
    type: screenshot.mimeType,
    size: screenshot.size
  };
};

// Turns stored paths into links that work for an hour. Missing or failed ones come back as null.
const signHelpScreenshots = async (paths) => {
  const wanted = [...new Set((paths || []).filter(Boolean))];
  if (wanted.length === 0) return {};
  let config;
  try {
    config = getConfig();
  } catch (error) {
    return {};
  }
  const { supabaseUrl, serviceRoleKey, bucket } = config;

  try {
    const response = await fetch(`${supabaseUrl}/storage/v1/object/sign/${bucket}`, {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_SECONDS, paths: wanted })
    });
    if (!response.ok) return {};
    const rows = await response.json();
    const urls = {};
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const signed = row.signedURL || row.signedUrl;
      if (row.path && signed) urls[row.path] = `${supabaseUrl}/storage/v1${signed.startsWith('/') ? '' : '/'}${signed}`;
    });
    return urls;
  } catch (error) {
    return {};
  }
};

module.exports = {
  MAX_SCREENSHOT_BYTES,
  parseScreenshot,
  uploadHelpScreenshot,
  signHelpScreenshots
};
