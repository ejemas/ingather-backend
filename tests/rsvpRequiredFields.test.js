const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRsvpPayload } = require('../controllers/preEventController');

const fields = { phoneNumber: true, age: true, link: true, textarea: true };

test('enabled RSVP fields stay required when no required config is saved', () => {
  assert.throws(
    () => validateRsvpPayload(fields, [], { emailAddress: 'ada@example.com' }, false, {}),
    /Phone Number is required\./
  );
  assert.throws(
    () => validateRsvpPayload({ age: true }, [], { emailAddress: 'ada@example.com' }, false, undefined),
    /Age is required\./
  );
});

test('fields marked optional can be left blank but still validate provided values', () => {
  const fieldConfig = {
    requiredFields: { phoneNumber: false, age: false, link: false, textarea: false }
  };

  const payload = validateRsvpPayload(fields, [], { emailAddress: 'Ada@Example.com' }, false, fieldConfig);
  assert.equal(payload.emailAddress, 'ada@example.com');
  assert.equal(payload.phoneNumber, null);
  assert.equal(payload.age, null);
  assert.equal(payload.linkUrl, null);
  assert.equal(payload.textareaResponse, null);

  assert.throws(
    () => validateRsvpPayload(fields, [], { emailAddress: 'ada@example.com', linkUrl: 'not a link' }, false, fieldConfig),
    /valid http/
  );
  assert.throws(
    () => validateRsvpPayload(fields, [], { emailAddress: 'ada@example.com', age: '400' }, false, fieldConfig),
    /Age must be/
  );
});

test('email stays required even when every optional field is optional', () => {
  assert.throws(
    () => validateRsvpPayload(fields, [], {}, false, { requiredFields: { phoneNumber: false } }),
    /valid email/
  );
});
