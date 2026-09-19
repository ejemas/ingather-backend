const COMMUNITY_PLATFORMS = new Set([
  'whatsapp',
  'instagram',
  'discord',
  'telegram',
  'facebook',
  'linkedin',
  'x',
  'other'
]);

const normalizeCommunityLinks = (value) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Community links must be an array.');
  if (value.length > 3) throw new Error('You can add up to 3 community links.');

  return value.map((item, index) => {
    const platform = String(item?.platform || '').trim().toLowerCase();
    const rawUrl = String(item?.url || '').trim();

    if (!COMMUNITY_PLATFORMS.has(platform)) {
      throw new Error(`Community link ${index + 1} has an unsupported platform.`);
    }

    if (!rawUrl) {
      throw new Error(`Community link ${index + 1} needs a URL.`);
    }
    if (rawUrl.length > 2048) {
      throw new Error(`Community link ${index + 1} URL is too long.`);
    }

    let url;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      throw new Error(`Community link ${index + 1} must be a valid URL.`);
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`Community link ${index + 1} must use http:// or https://.`);
    }

    return { platform, url: url.toString() };
  });
};

module.exports = { COMMUNITY_PLATFORMS, normalizeCommunityLinks };
