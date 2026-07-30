const test = require('node:test');
const assert = require('node:assert/strict');

test('bulk QR controller records provider partial success and preserves failed guests', async () => {
  const pool = require('../config/database');
  const emailService = require('../utils/emailService');
  const quotaService = require('../utils/rsvpQrQuota');
  const storage = require('../utils/supabaseStorage');
  const controllerPath = require.resolve('../controllers/preEventController');
  const original = {
    query: pool.query,
    completeQrEmailBatch: quotaService.completeQrEmailBatch,
    reserveImportedQrEmailBatch: quotaService.reserveImportedQrEmailBatch,
    sendRsvpQrEmailBatch: emailService.sendRsvpQrEmailBatch,
    uploadEventFlyer: storage.uploadEventFlyer,
    deleteEventFlyer: storage.deleteEventFlyer
  };
  const reconciliations = [];
  const deletedPaths = [];
  let batchRequest = null;

  pool.query = async (sql) => {
    const statement = String(sql);
    if (statement.includes('FROM pre_events pre_event')) {
      return {
        rows: [{
          id: 42,
          church_id: 7,
          church_name: 'InGather Test',
          title: 'Builder Summit',
          event_date: new Date('2026-08-01T09:00:00.000Z')
        }]
      };
    }
    if (statement.includes('SELECT COUNT(*) AS count')) {
      return { rows: [{ count: '1' }] };
    }
    throw new Error(`Unexpected pool query: ${statement}`);
  };
  quotaService.reserveImportedQrEmailBatch = async () => ({
    reservations: [
      {
        id: 10,
        reservation_id: 101,
        email_address: 'first@example.com',
        full_name: 'First Guest'
      },
      {
        id: 11,
        reservation_id: 102,
        email_address: 'second@example.com',
        full_name: 'Second Guest'
      }
    ],
    quota: {
      limit: 100,
      used: 2,
      remaining: 98,
      timezone: 'Africa/Lagos',
      resetsAt: '2026-07-31T23:00:00.000Z'
    }
  });
  quotaService.completeQrEmailBatch = async (payload) => {
    reconciliations.push(payload);
    return {
      limit: 100,
      used: 1,
      remaining: 99,
      timezone: 'Africa/Lagos',
      resetsAt: '2026-07-31T23:00:00.000Z'
    };
  };
  storage.uploadEventFlyer = async () => ({
    flyerUrl: 'https://example.com/qr.png',
    flyerStoragePath: 'church-7/rsvp-qr/qr.png'
  });
  storage.deleteEventFlyer = async (path) => {
    deletedPaths.push(path);
  };
  emailService.sendRsvpQrEmailBatch = async (request) => {
    batchRequest = request;
    return {
      sent: true,
      accepted: [{ id: 'email-1' }],
      errors: [{ index: 1, message: 'Provider rejected recipient.' }]
    };
  };

  delete require.cache[controllerPath];
  const controller = require(controllerPath);
  const response = {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return payload;
    }
  };

  try {
    await controller.sendImportedRsvpQrBatch(
      {
        churchId: 7,
        params: { id: '42' }
      },
      response
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.payload.summary, {
      selected: 2,
      sent: 1,
      failed: 1,
      remainingUnsent: 1
    });
    assert.equal(response.payload.quota.remaining, 99);
    assert.equal(batchRequest.emails.length, 2);
    assert.match(batchRequest.idempotencyKey, /^rsvp-qr-42-/);
    assert.equal(reconciliations.length, 1);
    assert.equal(reconciliations[0].successes.length, 1);
    assert.equal(reconciliations[0].failures.length, 1);
    assert.equal(reconciliations[0].failures[0].rsvpId, 11);
    assert.deepEqual(deletedPaths, ['church-7/rsvp-qr/qr.png']);
  } finally {
    pool.query = original.query;
    quotaService.completeQrEmailBatch = original.completeQrEmailBatch;
    quotaService.reserveImportedQrEmailBatch = original.reserveImportedQrEmailBatch;
    emailService.sendRsvpQrEmailBatch = original.sendRsvpQrEmailBatch;
    storage.uploadEventFlyer = original.uploadEventFlyer;
    storage.deleteEventFlyer = original.deleteEventFlyer;
    delete require.cache[controllerPath];
  }
});
