const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RSVP_ANALYTICS_TIMEZONE,
  buildRsvpAnalytics,
  getDateKeyInTimeZone
} = require('../utils/rsvpAnalytics');

test('Lagos calendar date advances at 23:00 UTC', () => {
  assert.equal(RSVP_ANALYTICS_TIMEZONE, 'Africa/Lagos');
  assert.equal(
    getDateKeyInTimeZone('2026-07-29T23:30:00.000Z'),
    '2026-07-30'
  );
});

test('analytics count every RSVP source and group only the active 14-day window', () => {
  const analytics = buildRsvpAnalytics(
    [
      { registration_date_key: '2026-07-30', source: 'import' },
      { registration_date_key: '2026-07-30', source: 'public' },
      { registration_date_key: '2026-07-29', source: 'manual' },
      { registration_date_key: '2026-07-16', source: 'import' }
    ],
    new Date('2026-07-29T23:30:00.000Z')
  );

  assert.equal(analytics.totalRsvps, 4);
  assert.equal(analytics.todayRsvps, 2);
  assert.equal(analytics.velocity.length, 14);
  assert.equal(analytics.velocity[0].date, '2026-07-17');
  assert.deepEqual(
    analytics.velocity.slice(-2).map(day => ({
      date: day.date,
      registrations: day.registrations
    })),
    [
      { date: '2026-07-29', registrations: 1 },
      { date: '2026-07-30', registrations: 2 }
    ]
  );
});
