const test = require('node:test');
const assert = require('node:assert');
const { endOverduePrograms, autoEndMiddleware, autoEndAtSql, resetSweepThrottle } = require('../utils/autoEndPrograms');

const fakeDb = (rows = []) => {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push({ sql, params }); return { rows }; } };
};

test('the cut-off is 12 hours after the end time, in Nigeria time, with overnight events ending the next day', () => {
  const sql = autoEndAtSql('p');
  assert.match(sql, /INTERVAL '12 hours'/);
  assert.match(sql, /AT TIME ZONE 'Africa\/Lagos'/);
  assert.match(sql, /end_time <= p\.start_time THEN INTERVAL '1 day'/);
});

test('checks one event when given an id, and ignores bad ids', async () => {
  const db = fakeDb([{ id: 4 }]);
  const emitted = [];
  const ended = await endOverduePrograms(db, { programId: '4', io: { emit: (name, data) => emitted.push([name, data]) } });
  assert.deepStrictEqual(ended, [4]);
  assert.deepStrictEqual(db.calls[0].params, [4]);
  assert.match(db.calls[0].sql, /is_active = true/);
  assert.strictEqual(emitted[0][0], 'program-4-update');
  assert.strictEqual(emitted[0][1].isActive, false);

  const db2 = fakeDb();
  assert.deepStrictEqual(await endOverduePrograms(db2, { programId: 'abc' }), []);
  assert.strictEqual(db2.calls.length, 0);
});

test('guest requests always check their event; organizer requests sweep at most once a minute', async () => {
  resetSweepThrottle();
  const db = fakeDb();
  const mw = autoEndMiddleware(db);
  const app = { get: () => null };
  let nexts = 0;
  const next = () => { nexts += 1; };
  await mw({ params: { programId: '9' }, app }, {}, next);
  await mw({ params: { programId: '9' }, app }, {}, next);
  await mw({ params: {}, app }, {}, next);
  await mw({ params: {}, app }, {}, next);
  assert.strictEqual(nexts, 4);
  assert.strictEqual(db.calls.length, 3);
});

test('a database problem never blocks the request', async () => {
  resetSweepThrottle();
  const mw = autoEndMiddleware({ query: async () => { throw new Error('down'); } });
  let called = false;
  const original = console.error;
  console.error = () => {};
  await mw({ params: { programId: '2' }, app: { get: () => null } }, {}, () => { called = true; });
  console.error = original;
  assert.strictEqual(called, true);
});
