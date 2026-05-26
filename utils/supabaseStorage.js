const crypto = require('crypto');

const DEFAULT_BUCKET = 'event-flyers';
const MAX_FLYER_BYTES = 260 * 1024;
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');

const encodeStoragePath = (path) => (
  path
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
);

const getStorageConfig = () => {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const bucket = process.env.SUPABASE_EVENT_FLYER_BUCKET || DEFAULT_BUCKET;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  }

  return {
    supabaseUrl: trimTrailingSlash(supabaseUrl),
    serviceRoleKey,
    bucket
  };
};

const parseDataUrl = (dataUrl) => {
  if (typeof dataUrl !== 'string') {
    throw new Error('Flyer payload is invalid.');
  }

  const match = dataUrl.match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) {
    throw new Error('Flyer must be a valid JPEG, PNG, or WebP image.');
  }

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    throw new Error('Flyer file type is not supported.');
  }

  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > MAX_FLYER_BYTES) {
    throw new Error('Compressed flyer is still too large. Please use a smaller image.');
  }

  return { buffer, mimeType };
};

const getExtension = (mimeType) => {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
};

const normalizeStorageFolder = (folder) => (
  String(folder || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-zA-Z0-9/_-]/g, '-')
);

const uploadEventFlyer = async ({ churchId, dataUrl, folder = '' }) => {
  const { supabaseUrl, serviceRoleKey, bucket } = getStorageConfig();
  const { buffer, mimeType } = parseDataUrl(dataUrl);
  const extension = getExtension(mimeType);
  const folderPrefix = normalizeStorageFolder(folder);
  const scopedFolder = folderPrefix ? `${folderPrefix}/` : '';
  const storagePath = `church-${churchId}/${scopedFolder}${Date.now()}-${crypto.randomUUID()}.${extension}`;
  const encodedPath = encodeStoragePath(storagePath);
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${encodedPath}`;

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': mimeType,
      'cache-control': '31536000',
      'x-upsert': 'false'
    },
    body: buffer
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Supabase flyer upload failed: ${message || response.statusText}`);
  }

  return {
    flyerUrl: `${supabaseUrl}/storage/v1/object/public/${bucket}/${encodedPath}`,
    flyerStoragePath: storagePath
  };
};

const deleteEventFlyer = async (storagePath) => {
  if (!storagePath) return;

  const { supabaseUrl, serviceRoleKey, bucket } = getStorageConfig();
  const deleteUrl = `${supabaseUrl}/storage/v1/object/${bucket}`;

  const response = await fetch(deleteUrl, {
    method: 'DELETE',
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prefixes: [storagePath] })
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`Supabase flyer delete failed: ${message || response.statusText}`);
  }
};

module.exports = {
  uploadEventFlyer,
  deleteEventFlyer,
  MAX_FLYER_BYTES
};
