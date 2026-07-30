const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MAX_RSVP_IMPORT_ROWS,
  RSVP_IMPORT_CHUNK_SIZE,
  validateRsvpImportRows
} = require('../utils/rsvpImport');
const {
  buildQuotaResponse,
  shouldApplyQrEmailQuota
} = require('../utils/rsvpQrQuota');

test('RSVP import constants match the API contract', () => {
  assert.equal(MAX_RSVP_IMPORT_ROWS, 5000);
  assert.equal(RSVP_IMPORT_CHUNK_SIZE, 500);
});

test('server validation normalizes emails and skips duplicate rows', () => {
  const result = validateRsvpImportRows([
    { sourceRow: 2, fullName: ' Ada Okafor ', emailAddress: 'ADA@EXAMPLE.COM ' },
    { sourceRow: 3, fullName: 'Second Ada', emailAddress: 'ada@example.com' },
    { sourceRow: 4, fullName: '', emailAddress: 'missing@example.com' }
  ]);

  assert.deepEqual(result.validRows, [
    { sourceRow: 2, fullName: 'Ada Okafor', emailAddress: 'ada@example.com' }
  ]);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.invalidCount, 1);
});

test('quota response includes reservations and never returns a negative remainder', () => {
  assert.deepEqual(
    buildQuotaResponse({ sent: 98, reserved: 2, resetsAt: '2026-07-30T00:00:00.000Z' }),
    {
      limit: 100,
      used: 100,
      remaining: 0,
      timezone: 'Africa/Lagos',
      resetsAt: '2026-07-30T00:00:00.000Z'
    }
  );
});

test('only public-link RSVP records bypass the QR email quota', () => {
  assert.equal(shouldApplyQrEmailQuota('public'), false);
  assert.equal(shouldApplyQrEmailQuota('manual'), true);
  assert.equal(shouldApplyQrEmailQuota('import'), true);
  assert.equal(shouldApplyQrEmailQuota('legacy'), true);
  assert.equal(shouldApplyQrEmailQuota(undefined), true);
});
