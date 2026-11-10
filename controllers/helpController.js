// Help centre for organizers: send a ticket, read the conversation, write back, mark it solved.
// Replies from the Ingather team are stored in the same tables (author_type = 'admin')
// and will be written by the admin dashboard.
const pool = require('../config/database');
const { parseScreenshot, uploadHelpScreenshot, signHelpScreenshots } = require('../utils/helpStorage');
const { sendHelpTeamEmail, sendHelpReceiptEmail } = require('../utils/emailService');

const TOPICS = {
  checkin: 'Check-in and QR codes',
  rsvp: 'RSVP pages and passes',
  account: 'Account and sign-in',
  extras: 'Flyers, gifts and sponsors',
  data: 'Reports and exports',
  other: 'Something else'
};
const SUBJECT_MAX = 160;
const MESSAGE_MAX = 5000;
const REOPEN_DAYS = 14;

const cleanText = (value) => (typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim() : '');

// Checks what the organizer typed. Returns { values } or { errors } with messages for each field.
const readTicketInput = (body = {}) => {
  const errors = {};
  const topic = Object.prototype.hasOwnProperty.call(TOPICS, body.topic) ? body.topic : '';
  const subject = cleanText(body.subject).replace(/\s+/g, ' ');
  const message = cleanText(body.message);

  if (!topic) errors.topic = 'Pick what it is about.';
  if (!subject) errors.subject = 'Add a short subject.';
  else if (subject.length > SUBJECT_MAX) errors.subject = `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (!message) errors.message = 'Tell us a little about the problem.';
  else if (message.length > MESSAGE_MAX) errors.message = `Keep it under ${MESSAGE_MAX} characters.`;

  const kind = body.eventKind === 'program' || body.eventKind === 'pre_event' ? body.eventKind : null;
  const eventId = Number.parseInt(body.eventId, 10);

  if (Object.keys(errors).length) return { errors };
  return {
    values: {
      topic,
      subject,
      message,
      urgent: body.urgent === true || body.urgent === 'true',
      event: kind && Number.isInteger(eventId) && eventId > 0 ? { kind, id: eventId } : null
    }
  };
};

const readReplyInput = (body = {}) => {
  const message = cleanText(body.message);
  if (!message) return { errors: { message: 'Write a reply first.' } };
  if (message.length > MESSAGE_MAX) return { errors: { message: `Keep it under ${MESSAGE_MAX} characters.` } };
  return { values: { message } };
};

// A solved ticket can be reopened by writing back within 14 days.
const canReopen = (ticket, now = new Date()) => {
  if (ticket.status !== 'solved') return true;
  if (!ticket.solved_at) return true;
  return now.getTime() - new Date(ticket.solved_at).getTime() <= REOPEN_DAYS * 24 * 60 * 60 * 1000;
};

const parseTicketNumber = (value) => {
  const number = Number.parseInt(String(value || '').replace(/^#/, ''), 10);
  return Number.isInteger(number) && number > 0 ? number : null;
};

const fail = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

const mapTicket = (row) => ({
  number: row.ticket_number,
  subject: row.subject,
  topic: row.topic,
  topicLabel: TOPICS[row.topic] || TOPICS.other,
  eventKind: row.event_kind,
  eventId: row.event_kind === 'program' ? row.program_id : row.event_kind === 'pre_event' ? row.pre_event_id : null,
  eventTitle: row.event_title,
  urgent: row.is_urgent,
  status: row.status,
  unread: row.organizer_unread,
  contactEmail: row.contact_email,
  createdAt: row.created_at,
  lastMessageAt: row.last_message_at,
  solvedAt: row.solved_at,
  canReopen: canReopen(row)
});

const getChurch = async (db, churchId) => {
  const result = await db.query('SELECT id, church_name, email FROM churches WHERE id = $1', [churchId]);
  return result.rows[0] || null;
};

// Makes sure the chosen event belongs to this organizer, and returns its title.
const resolveEvent = async (db, churchId, event) => {
  if (!event) return null;
  const sql = event.kind === 'program'
    ? 'SELECT title FROM programs WHERE id = $1 AND church_id = $2'
    : 'SELECT title FROM pre_events WHERE id = $1 AND church_id = $2';
  const result = await db.query(sql, [event.id, churchId]);
  return result.rows[0] ? { ...event, title: result.rows[0].title } : null;
};

const loadTicket = async (db, churchId, number, { lock = false } = {}) => {
  const result = await db.query(
    `SELECT * FROM help_tickets WHERE church_id = $1 AND ticket_number = $2 ${lock ? 'FOR UPDATE' : ''}`,
    [churchId, number]
  );
  return result.rows[0] || null;
};

const loadThread = async (db, ticket, churchName) => {
  const result = await db.query(
    'SELECT * FROM help_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC',
    [ticket.id]
  );
  const links = await signHelpScreenshots(result.rows.map((row) => row.attachment_path));
  return result.rows.map((row) => ({
    id: row.id,
    author: row.author_type,
    authorName: row.author_type === 'admin' ? (row.author_name || 'Ingather team') : (row.author_name || churchName || 'You'),
    body: row.body,
    createdAt: row.created_at,
    screenshot: row.attachment_path ? { name: row.attachment_name, url: links[row.attachment_path] || null } : null
  }));
};

const detailPayload = async (db, ticket, church) => ({
  ticket: mapTicket(ticket),
  messages: await loadThread(db, ticket, church?.church_name)
});

// Emails never hold up the answer to the organizer.
const notifyLater = (task) => {
  setImmediate(() => {
    Promise.resolve().then(task).catch((error) => console.error('Help email warning:', error.message));
  });
};

exports.listTickets = async (req, res) => {
  try {
    const [tickets, church] = await Promise.all([
      pool.query(
        `SELECT * FROM help_tickets WHERE church_id = $1
         ORDER BY (status = 'solved'), organizer_unread DESC, last_message_at DESC
         LIMIT 200`,
        [req.churchId]
      ),
      getChurch(pool, req.churchId)
    ]);
    return res.json({
      tickets: tickets.rows.map(mapTicket),
      contactEmail: church?.email || req.email || null
    });
  } catch (error) {
    console.error('List help tickets error:', error);
    return fail(res, 500, 'We could not load your tickets. Please try again.');
  }
};

// Recent and upcoming events for the "Which event?" picker.
exports.listEventOptions = async (req, res) => {
  try {
    const [programs, preEvents] = await Promise.all([
      pool.query(
        `SELECT id, title, date, is_active FROM programs
         WHERE church_id = $1 AND (is_active = true OR date >= CURRENT_DATE - INTERVAL '60 days')
         ORDER BY is_active DESC, date DESC LIMIT 20`,
        [req.churchId]
      ),
      pool.query(
        `SELECT id, title, event_date FROM pre_events
         WHERE church_id = $1 AND event_date >= CURRENT_TIMESTAMP - INTERVAL '60 days'
         ORDER BY event_date DESC LIMIT 20`,
        [req.churchId]
      )
    ]);
    return res.json({
      events: [
        ...programs.rows.map((row) => ({ kind: 'program', id: row.id, title: row.title, date: row.date, live: row.is_active })),
        ...preEvents.rows.map((row) => ({ kind: 'pre_event', id: row.id, title: row.title, date: row.event_date, live: false }))
      ]
    });
  } catch (error) {
    console.error('List help event options error:', error);
    return res.json({ events: [] });
  }
};

exports.createTicket = async (req, res) => {
  const input = readTicketInput(req.body);
  if (input.errors) return fail(res, 400, 'Please complete the highlighted fields.', { errors: input.errors });

  let screenshot;
  try {
    screenshot = parseScreenshot(req.body.screenshot);
  } catch (error) {
    return fail(res, error.status || 400, error.message, { errors: { screenshot: error.message } });
  }

  const client = await pool.connect();
  let started = false;
  try {
    const church = await getChurch(client, req.churchId);
    if (!church) return fail(res, 404, 'We could not find your workspace. Please log in again.');
    const event = await resolveEvent(client, req.churchId, input.values.event);
    const { topic, subject, message, urgent } = input.values;

    await client.query('BEGIN');
    started = true;
    const created = await client.query(
      `INSERT INTO help_tickets
        (church_id, topic, subject, event_kind, program_id, pre_event_id, event_title, is_urgent, contact_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        req.churchId, topic, subject,
        event ? event.kind : null,
        event?.kind === 'program' ? event.id : null,
        event?.kind === 'pre_event' ? event.id : null,
        event ? event.title : null,
        urgent,
        church.email
      ]
    );
    const ticket = created.rows[0];

    let attachment = null;
    if (screenshot) {
      try {
        attachment = await uploadHelpScreenshot({ churchId: req.churchId, ticketNumber: ticket.ticket_number, screenshot, fileName: req.body.screenshotName });
      } catch (uploadError) {
        console.error('Help screenshot upload error:', uploadError.message);
        await client.query('ROLLBACK');
        started = false;
        return fail(res, 502, 'We could not upload your screenshot. Try again, or send the ticket without it.', { errors: { screenshot: 'Upload failed. Try again or remove it.' } });
      }
    }

    await client.query(
      `INSERT INTO help_ticket_messages (ticket_id, author_type, author_name, body, attachment_path, attachment_name, attachment_type, attachment_size)
       VALUES ($1, 'organizer', $2, $3, $4, $5, $6, $7)`,
      [ticket.id, church.church_name, message, attachment?.path || null, attachment?.name || null, attachment?.type || null, attachment?.size || null]
    );
    await client.query('COMMIT');
    started = false;

    notifyLater(() => Promise.allSettled([
      sendHelpTeamEmail({
        ticketNumber: ticket.ticket_number, subject, organizerName: church.church_name, organizerEmail: church.email,
        topicLabel: TOPICS[topic], eventTitle: event?.title || '', message, urgent, followUp: false, hasScreenshot: Boolean(attachment)
      }),
      sendHelpReceiptEmail({ email: church.email, organizerName: church.church_name, ticketNumber: ticket.ticket_number, subject, message, urgent })
    ]));

    return res.status(201).json({ ticket: mapTicket(ticket) });
  } catch (error) {
    if (started) await client.query('ROLLBACK').catch(() => {});
    console.error('Create help ticket error:', error);
    return fail(res, 500, 'We could not send your ticket. Please try again.');
  } finally {
    client.release();
  }
};

exports.getTicket = async (req, res) => {
  const number = parseTicketNumber(req.params.number);
  if (!number) return fail(res, 404, 'We could not find that ticket.');
  try {
    const ticket = await loadTicket(pool, req.churchId, number);
    if (!ticket) return fail(res, 404, 'We could not find that ticket.');
    if (ticket.organizer_unread) {
      await pool.query('UPDATE help_tickets SET organizer_unread = false WHERE id = $1', [ticket.id]);
      ticket.organizer_unread = false;
    }
    const church = await getChurch(pool, req.churchId);
    return res.json(await detailPayload(pool, ticket, church));
  } catch (error) {
    console.error('Get help ticket error:', error);
    return fail(res, 500, 'We could not load this ticket. Please try again.');
  }
};

exports.replyToTicket = async (req, res) => {
  const number = parseTicketNumber(req.params.number);
  if (!number) return fail(res, 404, 'We could not find that ticket.');
  const input = readReplyInput(req.body);
  if (input.errors) return fail(res, 400, input.errors.message, { errors: input.errors });

  let screenshot;
  try {
    screenshot = parseScreenshot(req.body.screenshot);
  } catch (error) {
    return fail(res, error.status || 400, error.message, { errors: { screenshot: error.message } });
  }

  const client = await pool.connect();
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    const ticket = await loadTicket(client, req.churchId, number, { lock: true });
    if (!ticket) {
      await client.query('ROLLBACK');
      started = false;
      return fail(res, 404, 'We could not find that ticket.');
    }
    if (!canReopen(ticket)) {
      await client.query('ROLLBACK');
      started = false;
      return fail(res, 409, `This ticket was solved more than ${REOPEN_DAYS} days ago. Send a new ticket instead.`, { closed: true });
    }

    const church = await getChurch(client, req.churchId);
    let attachment = null;
    if (screenshot) {
      try {
        attachment = await uploadHelpScreenshot({ churchId: req.churchId, ticketNumber: ticket.ticket_number, screenshot, fileName: req.body.screenshotName });
      } catch (uploadError) {
        console.error('Help screenshot upload error:', uploadError.message);
        await client.query('ROLLBACK');
        started = false;
        return fail(res, 502, 'We could not upload your screenshot. Try again, or send the reply without it.', { errors: { screenshot: 'Upload failed. Try again or remove it.' } });
      }
    }

    await client.query(
      `INSERT INTO help_ticket_messages (ticket_id, author_type, author_name, body, attachment_path, attachment_name, attachment_type, attachment_size)
       VALUES ($1, 'organizer', $2, $3, $4, $5, $6, $7)`,
      [ticket.id, church?.church_name || null, input.values.message, attachment?.path || null, attachment?.name || null, attachment?.type || null, attachment?.size || null]
    );
    const updated = await client.query(
      `UPDATE help_tickets
       SET status = 'waiting', solved_at = NULL, admin_unread = true, organizer_unread = false,
           last_message_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [ticket.id]
    );
    await client.query('COMMIT');
    started = false;

    const fresh = updated.rows[0];
    notifyLater(() => sendHelpTeamEmail({
      ticketNumber: fresh.ticket_number, subject: fresh.subject, organizerName: church?.church_name || 'An organizer',
      organizerEmail: fresh.contact_email, topicLabel: TOPICS[fresh.topic], eventTitle: fresh.event_title || '',
      message: input.values.message, urgent: fresh.is_urgent, followUp: true, hasScreenshot: Boolean(attachment)
    }));

    return res.status(201).json(await detailPayload(pool, fresh, church));
  } catch (error) {
    if (started) await client.query('ROLLBACK').catch(() => {});
    console.error('Reply to help ticket error:', error);
    return fail(res, 500, 'We could not send your reply. Please try again.');
  } finally {
    client.release();
  }
};

exports.solveTicket = async (req, res) => {
  const number = parseTicketNumber(req.params.number);
  if (!number) return fail(res, 404, 'We could not find that ticket.');
  try {
    const updated = await pool.query(
      `UPDATE help_tickets
       SET status = 'solved', solved_at = COALESCE(solved_at, NOW()), organizer_unread = false, updated_at = NOW()
       WHERE church_id = $1 AND ticket_number = $2
       RETURNING *`,
      [req.churchId, number]
    );
    if (!updated.rows[0]) return fail(res, 404, 'We could not find that ticket.');
    const church = await getChurch(pool, req.churchId);
    return res.json(await detailPayload(pool, updated.rows[0], church));
  } catch (error) {
    console.error('Solve help ticket error:', error);
    return fail(res, 500, 'We could not update this ticket. Please try again.');
  }
};

exports._test = { readTicketInput, readReplyInput, canReopen, parseTicketNumber, TOPICS };
