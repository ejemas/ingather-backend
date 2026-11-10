const test = require('node:test');
const assert = require('node:assert/strict');
const { isTokenStillValid, notePasswordChanged, resetSessionGuard } = require('../utils/sessionGuard');

const db = (changedAt, calls = { n: 0 }) => ({ calls, query: async () => { calls.n += 1; return { rows: [{ password_changed_at: changedAt }] }; } });

test('tokens from before a password change stop working; newer ones keep working', async () => {
  resetSessionGuard();
  const changed = new Date('2026-11-10T22:00:00Z');
  const fake = db(changed);
  assert.equal(await isTokenStillValid({ churchId: 1, iat: changed.getTime() / 1000 - 60 }, fake), false);
  assert.equal(await isTokenStillValid({ churchId: 1, iat: changed.getTime() / 1000 }, fake), true);
  assert.equal(await isTokenStillValid({ churchId: 1, iat: changed.getTime() / 1000 + 60 }, fake), true);
});

test('accounts that never changed their password are not affected', async () => {
  resetSessionGuard();
  assert.equal(await isTokenStillValid({ churchId: 2, iat: 1 }, db(null)), true);
});

test('the date is remembered for a minute, and a change applies at once', async () => {
  resetSessionGuard();
  const calls = { n: 0 };
  const fake = db(null, calls);
  await isTokenStillValid({ churchId: 3, iat: 100 }, fake);
  await isTokenStillValid({ churchId: 3, iat: 100 }, fake);
  assert.equal(calls.n, 1);
  notePasswordChanged(3, new Date(200 * 1000));
  assert.equal(await isTokenStillValid({ churchId: 3, iat: 100 }, fake), false);
});

test('a missing column (SQL not run yet) never locks anyone out', async () => {
  resetSessionGuard();
  const broken = { query: async () => { const e = new Error('column does not exist'); e.code = '42703'; throw e; } };
  assert.equal(await isTokenStillValid({ churchId: 4, iat: 1 }, broken), true);
});
