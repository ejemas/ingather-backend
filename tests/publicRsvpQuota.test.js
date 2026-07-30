const test = require('node:test');
const assert = require('node:assert/strict');

test('public RSVP sends and persists its QR without touching the quota ledger', async () => {
  const pool = require('../config/database');
  const emailService = require('../utils/emailService');
  const storage = require('../utils/supabaseStorage');
  const controllerPath = require.resolve('../controllers/preEventController');
  const original = {
    query: pool.query,
    connect: pool.connect,
    sendRsvpQrEmail: emailService.sendRsvpQrEmail,
    uploadEventFlyer: storage.uploadEventFlyer,
    deleteEventFlyer: storage.deleteEventFlyer
  };
  const queries = [];
  let released = false;

  const rsvp = {
    id: 84,
    pre_event_id: 42,
    email_address: 'ada@example.com',
    full_name: null,
    status: 'pre_registered',
    registration_type: 'rsvp',
    registration_source: 'public',
    created_at: new Date('2026-07-30T10:00:00.000Z')
  };

  pool.query = async (sql, params = []) => {
    const statement = String(sql);
    queries.push(statement);

    if (statement.includes('WHERE pe.slug = $1')) {
      return {
        rows: [{
          id: 42,
          church_id: 7,
          church_name: 'InGather Test',
          title: 'Builder Summit',
          event_date: new Date('2026-08-01T09:00:00.000Z'),
          is_rsvp_active: true,
          rsvp_fields: { emailAddress: true },
          custom_form_schema: [],
          virtual_attendance_enabled: false
        }]
      };
    }

    if (statement.includes('INSERT INTO pre_event_rsvps')) {
      assert.equal(params[17], 'public');
      return { rows: [rsvp] };
    }

    if (statement.includes('SELECT * FROM pre_event_rsvps WHERE id = $1')) {
      return {
        rows: [{
          ...rsvp,
          checkin_token_hash: 'persisted-token-hash',
          checkin_qr_sent_at: new Date(),
          checkin_qr_last_sent_at: new Date()
        }]
      };
    }

    throw new Error(`Unexpected pool query: ${statement}`);
  };

  pool.connect = async () => ({
    query: async (sql) => {
      const statement = String(sql);
      queries.push(statement);
      if (
        statement === 'BEGIN'
        || statement === 'COMMIT'
        || statement.includes('UPDATE pre_event_rsvps')
      ) {
        return { rows: [] };
      }
      throw new Error(`Unexpected transactional query: ${statement}`);
    },
    release: () => {
      released = true;
    }
  });

  emailService.sendRsvpQrEmail = async () => ({ sent: true, id: 'email-1' });
  storage.uploadEventFlyer = async () => ({ flyerUrl: 'https://example.com/qr.png' });
  storage.deleteEventFlyer = async () => {};

  delete require.cache[controllerPath];
  const preEventController = require(controllerPath);
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
    await preEventController.submitPublicRsvp(
      {
        params: { slug: 'builder-summit' },
        body: { formData: { emailAddress: 'ada@example.com' } }
      },
      response
    );

    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.qrEmailSent, true);
    assert.equal(response.payload.emailWarning, null);
    assert.equal(response.payload.rsvp.registrationSource, 'public');
    assert.equal(released, true);
    assert.equal(queries.some(query => query.includes('rsvp_qr_email_sends')), false);
    assert.equal(queries.some(query => query.includes('pg_advisory_xact_lock')), false);
    assert.equal(queries.some(query => query.includes('UPDATE pre_event_rsvps')), true);
  } finally {
    pool.query = original.query;
    pool.connect = original.connect;
    emailService.sendRsvpQrEmail = original.sendRsvpQrEmail;
    storage.uploadEventFlyer = original.uploadEventFlyer;
    storage.deleteEventFlyer = original.deleteEventFlyer;
    delete require.cache[controllerPath];
  }
});
