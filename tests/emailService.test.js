const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalToken = process.env.MAILERSEND_API_TOKEN;
const originalFrom = process.env.EMAIL_FROM;

process.env.MAILERSEND_API_TOKEN = 'mailer-send-test-token';
process.env.EMAIL_FROM = 'no-reply@ingather.app';

const emailService = require('../utils/emailService');

const response = ({ status = 202, headers = {}, body = '' } = {}) => ({
  status,
  headers: {
    get(name) {
      return headers[name.toLowerCase()] || null;
    }
  },
  text: async () => body
});

const withMockFetch = async (mock, callback) => {
  global.fetch = mock;
  try {
    await callback();
  } finally {
    global.fetch = originalFetch;
  }
};

test('MailerSend adapter sends the existing email content with the verified Ingather sender', async () => {
  await withMockFetch(async (url, options) => {
    assert.equal(url, 'https://api.mailersend.com/v1/email');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer mailer-send-test-token');

    const body = JSON.parse(options.body);
    assert.deepEqual(body.from, { email: 'no-reply@ingather.app', name: 'Ingather' });
    assert.deepEqual(body.to, [{ email: 'ada@example.com' }]);
    assert.equal(body.subject, 'Welcome');
    assert.equal(body.html, '<p>Hello Ada</p>');

    return response({ headers: { 'x-message-id': 'ms-message-1' } });
  }, async () => {
    const result = await emailService.sendMailerSendEmail({
      to: 'ada@example.com',
      subject: 'Welcome',
      html: '<p>Hello Ada</p>'
    });

    assert.deepEqual(result, { sent: true, id: 'ms-message-1' });
  });
});

test('MailerSend adapter rejects paused, suppressed, and rate-limited sends', async () => {
  const scenarios = [
    {
      providerResponse: response({
        headers: { 'x-message-id': 'paused-message', 'x-send-paused': 'true' }
      }),
      expected: 'paused'
    },
    {
      providerResponse: response({
        body: JSON.stringify({
          message: 'There are some warnings for your request.',
          warnings: [{ type: 'ALL_SUPPRESSED' }]
        })
      }),
      expected: 'There are some warnings'
    },
    {
      providerResponse: response({
        status: 429,
        body: JSON.stringify({ message: 'Daily request quota reached.' })
      }),
      expected: 'Daily request quota reached.'
    }
  ];

  for (const scenario of scenarios) {
    await withMockFetch(async () => scenario.providerResponse, async () => {
      const result = await emailService.sendMailerSendEmail({
        to: 'ada@example.com',
        subject: 'Welcome',
        html: '<p>Hello Ada</p>'
      });

      assert.equal(result.sent, false);
      assert.match(result.reason, new RegExp(scenario.expected));
    });
  }
});

test('MailerSend QR batch limits concurrent single-recipient requests to five and preserves partial failures', async () => {
  let active = 0;
  let maximumActive = 0;

  await withMockFetch(async (_url, options) => {
    const recipient = JSON.parse(options.body).to[0].email;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;

    if (recipient === 'guest-3@example.com') {
      return response({
        status: 422,
        body: JSON.stringify({ message: 'Recipient is invalid.' })
      });
    }

    return response({ headers: { 'x-message-id': `message-${recipient}` } });
  }, async () => {
    const emails = Array.from({ length: 12 }, (_, index) => ({
      email: `guest-${index}@example.com`,
      attendeeName: `Guest ${index}`,
      eventTitle: 'Ingather test event',
      checkinLink: `https://ingather.app/check-in/${index}`,
      checkinToken: `TOKEN${index}`
    }));
    const result = await emailService.sendRsvpQrEmailBatch({ emails });

    assert.equal(maximumActive, 5);
    assert.equal(result.sent, true);
    assert.equal(result.accepted.length, 11);
    assert.deepEqual(result.errors, [{ index: 3, message: 'Recipient is invalid.' }]);
  });
});

test.after(() => {
  global.fetch = originalFetch;

  if (originalToken === undefined) delete process.env.MAILERSEND_API_TOKEN;
  else process.env.MAILERSEND_API_TOKEN = originalToken;

  if (originalFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = originalFrom;
});
