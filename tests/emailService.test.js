const test = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;
const originalToken = process.env.ZEPTOMAIL_API_TOKEN;
const originalFrom = process.env.EMAIL_FROM;

process.env.ZEPTOMAIL_API_TOKEN = 'zepto-test-token';
process.env.EMAIL_FROM = 'no-reply@ingather.app';

const emailService = require('../utils/emailService');

const ZEPTOMAIL_URL = 'https://cpaas.zoho.com/v1.1/email';

const response = ({ status = 200, headers = {}, body = '' } = {}) => ({
  status,
  headers: {
    get(name) {
      return headers[name.toLowerCase()] || null;
    }
  },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body))
});

const withMockFetch = async (mock, callback) => {
  global.fetch = mock;
  try {
    await callback();
  } finally {
    global.fetch = originalFetch;
  }
};

test('ZeptoMail adapter sends the email with the Ingather sender and Zoho auth header', async () => {
  await withMockFetch(async (url, options) => {
    assert.equal(url, ZEPTOMAIL_URL);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Zoho-enczapikey zepto-test-token');

    const body = JSON.parse(options.body);
    assert.deepEqual(body.from, { address: 'no-reply@ingather.app', name: 'Ingather' });
    assert.deepEqual(body.to, [{ email_address: { address: 'ada@example.com', name: 'Ada' } }]);
    assert.equal(body.subject, 'Welcome');
    assert.equal(body.htmlbody, '<p>Hello Ada</p>');

    return response({ body: { data: [{ request_id: 'zm-request-1' }] } });
  }, async () => {
    const result = await emailService.sendZeptoMailEmail({
      to: 'ada@example.com',
      recipientName: 'Ada',
      subject: 'Welcome',
      html: '<p>Hello Ada</p>'
    });

    assert.deepEqual(result, { sent: true, id: 'zm-request-1' });
  });
});

test('ZeptoMail adapter keeps a token that already has the Zoho prefix', async () => {
  process.env.ZEPTOMAIL_API_TOKEN = 'Zoho-enczapikey already-prefixed';
  try {
    await withMockFetch(async (_url, options) => {
      assert.equal(options.headers.Authorization, 'Zoho-enczapikey already-prefixed');
      return response({ body: { data: [{ request_id: 'zm-request-2' }] } });
    }, async () => {
      const result = await emailService.sendZeptoMailEmail({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>' });
      assert.equal(result.sent, true);
    });
  } finally {
    process.env.ZEPTOMAIL_API_TOKEN = 'zepto-test-token';
  }
});

test('ZeptoMail adapter reports provider errors, rate limits and timeouts as not sent', async () => {
  const scenarios = [
    {
      mock: async () => response({ status: 401, body: { error: { message: 'Invalid API Token found' } } }),
      expected: /Invalid API Token found/
    },
    {
      mock: async () => response({ status: 429, body: { message: 'Daily request quota reached.' } }),
      expected: /Daily request quota reached\./
    },
    {
      mock: async () => response({ status: 500, body: '' }),
      expected: /ZeptoMail rejected the email request \(500\)/
    },
    {
      mock: async () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      },
      expected: /timed out/
    }
  ];

  for (const scenario of scenarios) {
    await withMockFetch(scenario.mock, async () => {
      const result = await emailService.sendZeptoMailEmail({
        to: 'ada@example.com',
        subject: 'Welcome',
        html: '<p>Hello Ada</p>'
      });

      assert.equal(result.sent, false);
      assert.match(result.reason, scenario.expected);
    });
  }
});

test('ZeptoMail adapter refuses to send when no Zoho token is configured', async () => {
  const saved = process.env.ZEPTOMAIL_API_TOKEN;
  delete process.env.ZEPTOMAIL_API_TOKEN;
  try {
    let called = false;
    await withMockFetch(async () => {
      called = true;
      return response();
    }, async () => {
      const result = await emailService.sendZeptoMailEmail({ to: 'ada@example.com', subject: 'Hi', html: '<p>Hi</p>' });
      assert.equal(result.sent, false);
      assert.match(result.reason, /ZEPTOMAIL_API_TOKEN/);
      assert.equal(called, false);
    });
  } finally {
    process.env.ZEPTOMAIL_API_TOKEN = saved;
  }
});

test('QR batch limits concurrent single-recipient requests to five and preserves partial failures', async () => {
  let active = 0;
  let maximumActive = 0;

  await withMockFetch(async (_url, options) => {
    const recipient = JSON.parse(options.body).to[0].email_address.address;
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;

    if (recipient === 'guest-3@example.com') {
      return response({ status: 422, body: { message: 'Recipient is invalid.' } });
    }

    return response({ body: { data: [{ request_id: `message-${recipient}` }] } });
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

test('Code emails show each digit and the 10 minute expiry', () => {
  const verify = emailService.buildVerificationEmailHtml('482913');
  const reset = emailService.buildPasswordResetEmailHtml('730154');

  for (const digit of '482913') assert.match(verify, new RegExp(`>${digit}</td>`));
  assert.match(verify, /Verify your email/);
  assert.match(verify, /10 minutes/);
  assert.match(reset, /Reset your password/);
  assert.match(reset, />7<\/td>/);
});

test('Invite email carries the link, the email it is tied to, and escapes names', () => {
  const html = emailService.buildWaitlistInviteEmailHtml({
    email: 'frank@organization.com',
    firstName: '<script>Frank</script>',
    inviteLink: 'https://ingather.app/register?invite=abc&x=1'
  });

  assert.match(html, /href="https:\/\/ingather\.app\/register\?invite=abc&amp;x=1"/);
  assert.match(html, /frank@organization\.com/);
  assert.match(html, /&lt;script&gt;Frank&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test('RSVP pass email includes the QR, backup code and details, and works without a QR image', () => {
  const details = {
    email: 'chiamaka@example.com',
    attendeeName: 'Chiamaka Eze',
    eventTitle: 'Lagos Builders Summit',
    eventDate: new Date('2026-11-14T09:00:00'),
    organizerName: 'Lagos Builders Community',
    venueName: 'Landmark Centre',
    city: 'Lagos',
    qrImageUrl: 'https://storage.example.com/qr.png',
    checkinLink: 'https://ingather.app/rsvp-checkin/token-1',
    checkinToken: 'A7K9Q2M4'
  };

  const payload = emailService.buildRsvpQrEmailPayload(details);
  assert.equal(payload.to, 'chiamaka@example.com');
  assert.equal(payload.subject, 'Your check-in QR for Lagos Builders Summit');
  assert.match(payload.html, /src="https:\/\/storage\.example\.com\/qr\.png"/);
  assert.match(payload.html, /A7K9Q2M4/);
  assert.match(payload.html, /Landmark Centre, Lagos/);
  assert.match(payload.html, /Hi Chiamaka,/);
  assert.match(payload.html, /Open my pass/);

  const withoutQr = emailService.buildRsvpQrEmailPayload({ ...details, qrImageUrl: null });
  assert.match(withoutQr.html, /Your QR image could not be attached/);
  assert.match(withoutQr.html, /A7K9Q2M4/);
});

test('New-device code and sign-in alert emails show the device and time, and escape values', () => {
  const code = emailService.buildDeviceCodeEmailHtml({ code: '482913', deviceLabel: 'Chrome on <iPhone>', time: 'Sun, 8 Nov, 3:42 pm' });
  for (const digit of '482913') assert.match(code, new RegExp(`>${digit}</td>`));
  assert.match(code, /Chrome on &lt;iPhone&gt;/);
  assert.match(code, /Sun, 8 Nov, 3:42 pm/);

  const alert = emailService.buildSigninAlertEmailHtml({
    workspaceName: 'Ejemas & Co',
    deviceLabel: 'Chrome on iPhone',
    time: 'Sun, 8 Nov, 3:42 pm',
    resetLink: 'https://ingather.app/forgot-password'
  });
  assert.match(alert, /Ejemas &amp; Co was just opened on a new device/);
  assert.match(alert, /href="https:\/\/ingather\.app\/forgot-password"/);
  assert.match(alert, /This wasn't me|This wasn&#39;t me/);
});

test.after(() => {
  global.fetch = originalFetch;

  if (originalToken === undefined) delete process.env.ZEPTOMAIL_API_TOKEN;
  else process.env.ZEPTOMAIL_API_TOKEN = originalToken;

  if (originalFrom === undefined) delete process.env.EMAIL_FROM;
  else process.env.EMAIL_FROM = originalFrom;
});
