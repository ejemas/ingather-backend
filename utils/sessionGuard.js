// Signs out other devices after a password change or reset.
// A sign-in token issued before the account's password_changed_at is no longer accepted.
// The date is kept in memory for a minute so this adds almost no work to each request.
const pool = require('../config/database');

const CACHE_MS = 60 * 1000;
const MISSING_COLUMN_RETRY_MS = 10 * 60 * 1000;
const cache = new Map();
let columnMissingUntil = 0;

const getPasswordChangedAt = async (churchId, db = pool) => {
  const hit = cache.get(churchId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.changedAt;
  if (Date.now() < columnMissingUntil) return null;
  try {
    const result = await db.query('SELECT password_changed_at FROM churches WHERE id = $1', [churchId]);
    const value = result.rows[0]?.password_changed_at;
    const changedAt = value ? new Date(value).getTime() : null;
    cache.set(churchId, { changedAt, at: Date.now() });
    return changedAt;
  } catch (error) {
    // Before the SQL script is run the column does not exist yet. Never lock people out because of that.
    if (error.code === '42703') columnMissingUntil = Date.now() + MISSING_COLUMN_RETRY_MS;
    else console.error('Session check warning:', error.message);
    return null;
  }
};

// True when the token was issued after the last password change (or there never was one).
const isTokenStillValid = async (decoded, db = pool) => {
  if (!decoded?.churchId || !decoded.iat) return true;
  const changedAt = await getPasswordChangedAt(decoded.churchId, db);
  if (!changedAt) return true;
  // iat is in whole seconds, so allow the second in which the change happened.
  return decoded.iat * 1000 + 1000 >= changedAt;
};

// Called right after a password change so this server applies it at once, not after the cache expires.
const notePasswordChanged = (churchId, changedAt = new Date()) => {
  cache.set(Number(churchId), { changedAt: new Date(changedAt).getTime(), at: Date.now() });
};

const resetSessionGuard = () => { cache.clear(); columnMissingUntil = 0; };

module.exports = { isTokenStillValid, notePasswordChanged, getPasswordChangedAt, resetSessionGuard };
