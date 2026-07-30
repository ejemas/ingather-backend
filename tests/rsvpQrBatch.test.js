const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../config/database');
const {
  QR_EMAIL_BATCH_LIMIT,
  completeQrEmailBatch,
  reserveImportedQrEmailBatch
} = require('../utils/rsvpQrQuota');

test('bulk reservation selects only the remaining allowance in oldest-first order', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  let released = false;

  pool.connect = async () => ({
    query: async (sql, params = []) => {
      const statement = String(sql);
      statements.push(statement);

      if (statement === 'BEGIN' || statement === 'COMMIT') return { rows: [] };
      if (statement.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (statement.includes('Reservation expired before completion')) return { rows: [] };
      if (statement.includes('WITH bounds AS')) {
        return {
          rows: [{
            sent_count: '70',
            reserved_count: '5',
            resets_at: '2026-07-31T23:00:00.000Z'
          }]
        };
      }
      if (statement.includes('SELECT rsvp.*')) {
        assert.equal(params[0], 42);
        assert.equal(params[1], 25);
        assert.match(statement, /registration_source = 'import'/);
        assert.match(statement, /checkin_qr_sent_at IS NULL/);
        assert.match(statement, /status = 'pre_registered'/);
        assert.match(statement, /ORDER BY rsvp\.created_at ASC, rsvp\.id ASC/);
        assert.match(statement, /active_send\.status = 'reserved'/);
        return {
          rows: [
            { id: 10, email_address: 'first@example.com', created_at: new Date('2026-07-30T08:00:00Z') },
            { id: 11, email_address: 'second@example.com', created_at: new Date('2026-07-30T08:01:00Z') },
            { id: 12, email_address: 'third@example.com', created_at: new Date('2026-07-30T08:02:00Z') }
          ]
        };
      }
      if (statement.includes('INSERT INTO rsvp_qr_email_sends')) {
        assert.deepEqual(params, [7, 42, [10, 11, 12]]);
        return {
          rows: [
            { id: 101, rsvp_id: 10 },
            { id: 102, rsvp_id: 11 },
            { id: 103, rsvp_id: 12 }
          ]
        };
      }

      throw new Error(`Unexpected query: ${statement}`);
    },
    release: () => {
      released = true;
    }
  });

  try {
    assert.equal(QR_EMAIL_BATCH_LIMIT, 100);
    const result = await reserveImportedQrEmailBatch({
      churchId: 7,
      preEventId: 42,
      maxCount: 100
    });

    assert.deepEqual(result.reservations.map(row => row.reservation_id), [101, 102, 103]);
    assert.equal(result.quota.used, 78);
    assert.equal(result.quota.remaining, 22);
    assert.equal(released, true);
    assert.equal(statements.some(statement => statement.includes('FOR UPDATE OF rsvp SKIP LOCKED')), true);
  } finally {
    pool.connect = originalConnect;
  }
});

test('bulk completion persists successful tokens and releases failed reservations', async () => {
  const originalConnect = pool.connect;
  const originalQuery = pool.query;
  const statements = [];
  let released = false;

  pool.connect = async () => ({
    query: async (sql, params = []) => {
      const statement = String(sql);
      statements.push(statement);

      if (statement === 'BEGIN' || statement === 'COMMIT') return { rows: [] };
      if (statement.includes('UPDATE pre_event_rsvps AS rsvp')) {
        assert.deepEqual(params, [[10, 11], ['hash-10', 'hash-11']]);
        return { rows: [] };
      }
      if (statement.includes("SET status = 'sent'")) {
        assert.deepEqual(params, [[101, 102]]);
        return { rows: [] };
      }
      if (statement.includes("SET status = 'failed'")) {
        assert.deepEqual(params, [[103], ['Provider rejected recipient.']]);
        return { rows: [] };
      }

      throw new Error(`Unexpected transactional query: ${statement}`);
    },
    release: () => {
      released = true;
    }
  });
  pool.query = async (sql) => {
    const statement = String(sql);
    if (statement.includes('WITH bounds AS')) {
      return {
        rows: [{
          sent_count: '2',
          reserved_count: '0',
          resets_at: '2026-07-31T23:00:00.000Z'
        }]
      };
    }
    throw new Error(`Unexpected pool query: ${statement}`);
  };

  try {
    const quota = await completeQrEmailBatch({
      churchId: 7,
      successes: [
        { reservationId: 101, rsvpId: 10, tokenHash: 'hash-10' },
        { reservationId: 102, rsvpId: 11, tokenHash: 'hash-11' }
      ],
      failures: [
        { reservationId: 103, reason: 'Provider rejected recipient.' }
      ]
    });

    assert.equal(quota.limit, 100);
    assert.equal(quota.used, 2);
    assert.equal(quota.remaining, 98);
    assert.equal(released, true);
  } finally {
    pool.connect = originalConnect;
    pool.query = originalQuery;
  }
});
