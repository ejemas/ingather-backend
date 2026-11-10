const test = require('node:test');
const assert = require('node:assert/strict');
const { _test } = require('../controllers/helpController');
const { buildHelpTeamEmailHtml, buildHelpReceiptEmailHtml, buildHelpReplyEmailHtml } = require('../utils/emailService');
const { parseScreenshot } = require('../utils/helpStorage');

const { readTicketInput, readReplyInput, canReopen, parseTicketNumber } = _test;

test('a ticket needs a topic, a subject and a message', () => {
  const { errors } = readTicketInput({ topic: 'nope', subject: '  ', message: '' });
  assert.ok(errors.topic && errors.subject && errors.message);
  const { values } = readTicketInput({ topic: 'checkin', subject: '  Scanner   says used ', message: ' Two guests\r\n', urgent: 'true', eventKind: 'program', eventId: '12' });
  assert.equal(values.subject, 'Scanner says used');
  assert.equal(values.message, 'Two guests');
  assert.equal(values.urgent, true);
  assert.deepEqual(values.event, { kind: 'program', id: 12 });
});

test('long subjects and messages are refused, and odd event values are dropped', () => {
  assert.ok(readTicketInput({ topic: 'other', subject: 'x'.repeat(161), message: 'y' }).errors.subject);
  assert.ok(readTicketInput({ topic: 'other', subject: 'x', message: 'y'.repeat(5001) }).errors.message);
  assert.equal(readTicketInput({ topic: 'other', subject: 'x', message: 'y', eventKind: 'table', eventId: 3 }).values.event, null);
  assert.ok(readReplyInput({ message: '   ' }).errors.message);
});

test('a solved ticket can be reopened for 14 days', () => {
  const now = new Date('2026-11-20T12:00:00Z');
  assert.equal(canReopen({ status: 'replied' }, now), true);
  assert.equal(canReopen({ status: 'solved', solved_at: '2026-11-10T12:00:00Z' }, now), true);
  assert.equal(canReopen({ status: 'solved', solved_at: '2026-11-05T11:00:00Z' }, now), false);
});

test('ticket numbers are read from the link', () => {
  assert.equal(parseTicketNumber('1044'), 1044);
  assert.equal(parseTicketNumber('#1044'), 1044);
  assert.equal(parseTicketNumber('abc'), null);
});

test('screenshots must be PNG or JPEG', () => {
  assert.equal(parseScreenshot(''), null);
  assert.equal(parseScreenshot('data:image/png;base64,' + Buffer.from('x').toString('base64')).mimeType, 'image/png');
  assert.throws(() => parseScreenshot('data:image/gif;base64,AAAA'), /PNG or JPEG/);
});

test('help emails escape what organizers type', () => {
  const team = buildHelpTeamEmailHtml({ ticketNumber: 1044, subject: '<b>hi</b>', organizerName: 'Org', organizerEmail: 'a@b.c', topicLabel: 'Something else', message: '<script>x</script>', urgent: true });
  assert.ok(!team.includes('<script>x</script>') && team.includes('&lt;script&gt;'));
  assert.ok(team.includes('Urgent ticket'));
  assert.ok(buildHelpReceiptEmailHtml({ ticketNumber: 1044, subject: 's', message: 'm' }).includes('https://ingather.app/help/1044'));
  assert.ok(buildHelpReplyEmailHtml({ ticketNumber: 1044, subject: 's', adminName: 'Ada', reply: 'r' }).includes('Ada'));
});
