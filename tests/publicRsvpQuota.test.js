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
          // A week ahead, so the page is still taking RSVPs whenever the test runs.
          event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
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

  // Sending is held until the test lets it go, to prove the guest is answered before the email finishes.
  let releaseEmail;
  const emailGate = new Promise((resolve) => { releaseEmail = resolve; });
  emailService.sendRsvpQrEmail = async () => {
    await emailGate;
    return { sent: true, id: 'email-1' };
  };

  try {
    const background = preEventController.submitPublicRsvp(
      {
        params: { slug: 'builder-summit' },
        body: { formData: { emailAddress: 'ada@example.com' } }
      },
      response
    );

    // The guest's answer arrives while the email is still on its way.
    for (let i = 0; i < 20 && !response.payload; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.qrEmailQueued, true);
    assert.equal(response.payload.sentTo, 'ada@example.com');
    assert.equal(response.payload.emailWarning, null);
    assert.equal(response.payload.rsvp.registrationSource, 'public');
    assert.equal(queries.some(query => query.includes('UPDATE pre_event_rsvps')), false);

    // Then the email goes out and the pass is recorded as sent.
    releaseEmail();
    await background;
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

test('a repeat RSVP with the same email gets a clear "already registered" answer', async () => {
  const pool = require('../config/database');
  const controllerPath = require.resolve('../controllers/preEventController');
  const originalQuery = pool.query;

  pool.query = async (sql) => {
    const statement = String(sql);
    if (statement.includes('WHERE pe.slug = $1')) {
      return {
        rows: [{
          id: 42,
          church_id: 7,
          church_name: 'InGather Test',
          title: 'Builder Summit',
          event_date: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          is_rsvp_active: true,
          rsvp_fields: { emailAddress: true },
          custom_form_schema: [],
          virtual_attendance_enabled: false
        }]
      };
    }
    if (statement.includes('INSERT INTO pre_event_rsvps')) {
      const duplicate = new Error('duplicate key value violates unique constraint');
      duplicate.code = '23505';
      throw duplicate;
    }
    throw new Error(`Unexpected pool query: ${statement}`);
  };

  delete require.cache[controllerPath];
  const preEventController = require(controllerPath);
  const response = {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return payload; }
  };

  try {
    await preEventController.submitPublicRsvp(
      { params: { slug: 'builder-summit' }, body: { formData: { emailAddress: 'ada@example.com' } } },
      response
    );
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.code, 'ALREADY_REGISTERED');
    assert.match(response.payload.error, /already RSVP'd with this email/);
    assert.match(response.payload.error, /spam folder/);
  } finally {
    pool.query = originalQuery;
    delete require.cache[controllerPath];
  }
});
