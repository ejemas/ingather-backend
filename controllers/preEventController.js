const crypto = require('crypto');
const QRCode = require('qrcode');
const pool = require('../config/database');
const { uploadEventFlyer, deleteEventFlyer } = require('../utils/supabaseStorage');
const { sendRsvpQrEmail, sendRsvpQrEmailBatch } = require('../utils/emailService');
const { normalizeCustomFieldSchema, validateCustomResponses } = require('../utils/customFields');
const {
  MAX_RSVP_IMPORT_ROWS,
  RSVP_IMPORT_CHUNK_SIZE,
  validateRsvpImportRows
} = require('../utils/rsvpImport');
const {
  QR_EMAIL_BATCH_LIMIT,
  completeQrEmailBatch,
  completeQrEmailSend,
  failQrEmailSend,
  getQrEmailQuota,
  reserveImportedQrEmailBatch,
  reserveQrEmailSend,
  shouldApplyQrEmailQuota
} = require('../utils/rsvpQrQuota');
const {
  RSVP_ANALYTICS_TIMEZONE,
  buildRsvpAnalytics
} = require('../utils/rsvpAnalytics');

const PUBLIC_FRONTEND_ORIGIN = 'https://ingather.app';
const QR_EMAIL_PREPARATION_CONCURRENCY = 5;

const RSVP_FIELD_LABELS = {
  emailAddress: 'Email Address',
  fullName: 'Full Name',
  phoneNumber: 'Phone Number',
  school: 'School',
  link: 'Link',
  textarea: 'Additional Response',
  organization: 'Organization',
  ticketType: 'Ticket Type',
  address: 'Address',
  firstTimer: 'First-Timer',
  department: 'Department',
  fellowship: 'Group',
  age: 'Age',
  sex: 'Gender'
};

const OPTIONAL_RSVP_FIELDS = [
  'fullName',
  'phoneNumber',
  'school',
  'link',
  'textarea',
  'organization',
  'ticketType',
  'address',
  'firstTimer',
  'department',
  'fellowship',
  'age',
  'sex'
];

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const getPublicRsvpUrl = (slug) => `${trimTrailingSlash(PUBLIC_FRONTEND_ORIGIN)}/rsvp/${slug}`;

const getRsvpCheckinUrl = (token) => `${trimTrailingSlash(PUBLIC_FRONTEND_ORIGIN)}/rsvp-checkin/${token}`;

const RSVP_TOKEN_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const normalizeRsvpCheckinToken = (token) => (
  String(token || '').trim().toUpperCase().replace(/[\s-]+/g, '')
);

const generateRsvpCheckinToken = () => {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, byte => RSVP_TOKEN_ALPHABET[byte % RSVP_TOKEN_ALPHABET.length]).join('');
};

const hashRsvpCheckinToken = (token) => (
  crypto.createHash('sha256').update(normalizeRsvpCheckinToken(token)).digest('hex')
);

const cleanText = (value, maxLength = 255) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
};

const normalizeEmail = (value) => cleanText(value, 255).toLowerCase();

const isValidEmail = (value) => {
  const email = normalizeEmail(value);
  return email.length > 0
    && email.length <= 255
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    && email.indexOf('@') === email.lastIndexOf('@');
};

const DEFAULT_TEXTAREA_LABEL = 'Additional Response';

const normalizeFieldConfig = (config = {}) => ({
  textareaLabel: typeof config.textareaLabel === 'string' && config.textareaLabel.trim()
    ? config.textareaLabel.trim().slice(0, 120)
    : DEFAULT_TEXTAREA_LABEL
});

const normalizeUrlField = (value) => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.toString();
  } catch (error) {
    return '';
  }
};

const normalizeRsvpFields = (fields = {}) => {
  const normalized = { emailAddress: true };
  OPTIONAL_RSVP_FIELDS.forEach((field) => {
    normalized[field] = Boolean(fields[field]);
  });
  return normalized;
};

const slugify = (value) => (
  cleanText(value, 90)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'pre-event'
);

const createCandidateSlug = (title) => `${slugify(title)}-${crypto.randomBytes(3).toString('hex')}`;

const createUniqueSlug = async (title) => {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const slug = createCandidateSlug(title);
    const result = await pool.query('SELECT id FROM pre_events WHERE slug = $1 LIMIT 1', [slug]);
    if (result.rows.length === 0) return slug;
  }
  return `${slugify(title)}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
};

const parseEventDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
};

const normalizeProgramId = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const normalizeAttendanceMode = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['physical', 'virtual'].includes(normalized) ? normalized : null;
};

const mapPreEvent = (row, extras = {}) => ({
  id: row.id,
  programId: row.program_id || null,
  title: row.title,
  eventDate: row.event_date,
  description: row.description || '',
  venueName: row.venue_name || '',
  city: row.city || '',
  bannerUrl: row.banner_url || null,
  bannerOriginalName: row.banner_original_name || null,
  rsvpFields: normalizeRsvpFields(row.rsvp_fields || {}),
  rsvpFieldConfig: normalizeFieldConfig(row.rsvp_field_config || {}),
  customFormSchema: normalizeCustomFieldSchema(row.custom_form_schema || []),
  virtualAttendanceEnabled: row.virtual_attendance_enabled === true,
  slug: row.slug,
  publicUrl: getPublicRsvpUrl(row.slug),
  discoverEnabled: row.discover_enabled === true,
  isRsvpActive: row.is_rsvp_active !== false,
  rsvpCount: parseInt(row.rsvp_count || extras.rsvpCount || 0, 10),
  churchName: row.church_name || row.organizer_name || '',
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const mapRsvp = (row) => ({
  id: row.id,
  preEventId: row.pre_event_id,
  emailAddress: row.email_address,
  fullName: row.full_name || '',
  phoneNumber: row.phone_number || '',
  school: row.school || '',
  linkUrl: row.link_url || '',
  textareaResponse: row.textarea_response || '',
  organization: row.organization || '',
  ticketType: row.ticket_type || '',
  address: row.address || '',
  firstTimer: Boolean(row.first_timer),
  department: row.department || '',
  fellowship: row.fellowship || '',
  age: row.age,
  sex: row.sex || '',
  customAnswers: row.custom_answers || {},
  status: row.status || 'pre_registered',
  registrationType: row.registration_type || 'rsvp',
  registrationSource: row.registration_source || 'legacy',
  attendanceMode: row.attendance_mode || null,
  checkedInAt: row.checked_in_at || null,
  checkinQrSentAt: row.checkin_qr_sent_at || null,
  checkinQrLastSentAt: row.checkin_qr_last_sent_at || null,
  hasCheckinQr: Boolean(row.checkin_token_hash),
  createdAt: row.created_at
});

const sendCheckinQrForRsvp = async ({ preEvent, rsvp, token }) => {
  let reservationId = null;

  try {
    if (shouldApplyQrEmailQuota(rsvp.registration_source)) {
      const reservation = await reserveQrEmailSend({
        churchId: preEvent.church_id,
        preEventId: preEvent.id,
        rsvpId: rsvp.id
      });
      reservationId = reservation.reservationId;
    }

    const checkinToken = normalizeRsvpCheckinToken(token || generateRsvpCheckinToken());
    const checkinTokenHash = hashRsvpCheckinToken(checkinToken);
    const checkinLink = getRsvpCheckinUrl(checkinToken);
    const qrDataUrl = await QRCode.toDataURL(checkinLink, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320
    });
    let qrImageUrl = null;

    try {
      const uploadedQr = await uploadEventFlyer({
        churchId: preEvent.church_id,
        dataUrl: qrDataUrl,
        folder: 'rsvp-qr'
      });
      qrImageUrl = uploadedQr.flyerUrl;
    } catch (uploadError) {
      console.error('RSVP QR image upload failed:', uploadError.message);
    }

    const emailResult = await sendRsvpQrEmail({
      email: rsvp.email_address,
      attendeeName: rsvp.full_name,
      eventTitle: preEvent.title,
      eventDate: preEvent.event_date,
      organizerName: preEvent.church_name,
      qrImageUrl,
      checkinLink,
      checkinToken
    });

    if (!emailResult.sent) {
      const quota = await failQrEmailSend(reservationId, emailResult.reason);
      reservationId = null;
      return { ...emailResult, tokenHash: checkinTokenHash, quota };
    }

    const quota = await completeQrEmailSend({
      reservationId,
      rsvpId: rsvp.id,
      tokenHash: checkinTokenHash
    });
    reservationId = null;
    return { ...emailResult, tokenHash: checkinTokenHash, quota };
  } catch (error) {
    if (reservationId) {
      await failQrEmailSend(reservationId, error.message).catch(() => null);
    }
    throw error;
  }
};

const mapWithConcurrency = async (items, concurrency, worker) => {
  const results = new Array(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
};

const prepareImportedQrEmail = async (preEvent, rsvp) => {
  try {
    const checkinToken = generateRsvpCheckinToken();
    const checkinTokenHash = hashRsvpCheckinToken(checkinToken);
    const checkinLink = getRsvpCheckinUrl(checkinToken);
    const qrDataUrl = await QRCode.toDataURL(checkinLink, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 320
    });
    const uploadedQr = await uploadEventFlyer({
      churchId: preEvent.church_id,
      dataUrl: qrDataUrl,
      folder: 'rsvp-qr'
    });

    return {
      prepared: true,
      reservationId: rsvp.reservation_id,
      rsvpId: rsvp.id,
      emailAddress: rsvp.email_address,
      tokenHash: checkinTokenHash,
      qrStoragePath: uploadedQr.flyerStoragePath,
      email: {
        email: rsvp.email_address,
        attendeeName: rsvp.full_name,
        eventTitle: preEvent.title,
        eventDate: preEvent.event_date,
        organizerName: preEvent.church_name,
        qrImageUrl: uploadedQr.flyerUrl,
        checkinLink,
        checkinToken
      }
    };
  } catch (error) {
    return {
      prepared: false,
      reservationId: rsvp.reservation_id,
      rsvpId: rsvp.id,
      emailAddress: rsvp.email_address,
      reason: error.message || 'QR image preparation failed.'
    };
  }
};

const cleanupPreparedQrAssets = async (items) => {
  await Promise.allSettled(
    items
      .filter(item => item?.qrStoragePath)
      .map(item => deleteEventFlyer(item.qrStoragePath))
  );
};

const getOwnedPreEventRow = async (churchId, id) => {
  const result = await pool.query(
    `SELECT pre_event.*, church.church_name
     FROM pre_events pre_event
     JOIN churches church ON church.id = pre_event.church_id
     WHERE pre_event.id = $1 AND pre_event.church_id = $2`,
    [id, churchId]
  );
  return result.rows[0] || null;
};

const countRemainingImportedQrEmails = async (preEventId) => {
  const result = await pool.query(
    `SELECT COUNT(*) AS count
     FROM pre_event_rsvps
     WHERE pre_event_id = $1
       AND registration_source = 'import'
       AND checkin_qr_sent_at IS NULL
       AND status = 'pre_registered'`,
    [preEventId]
  );
  return parseInt(result.rows[0]?.count || '0', 10);
};

const validateLinkedProgram = async (churchId, programId) => {
  const normalizedProgramId = normalizeProgramId(programId);
  if (!normalizedProgramId) return null;

  const result = await pool.query(
    'SELECT id FROM programs WHERE id = $1 AND church_id = $2 LIMIT 1',
    [normalizedProgramId, churchId]
  );

  if (result.rows.length === 0) {
    throw new Error('Linked live program was not found in this workspace.');
  }

  return normalizedProgramId;
};

const validateRsvpPayload = (fields, customFormSchema = [], formData = {}, virtualAttendanceEnabled = false) => {
  const normalizedFields = normalizeRsvpFields(fields);
  const emailAddress = normalizeEmail(formData.emailAddress || formData.email);

  if (!isValidEmail(emailAddress)) {
    throw new Error('A valid email address is required.');
  }

  const payload = {
    emailAddress,
    fullName: null,
    phoneNumber: null,
    school: null,
    linkUrl: null,
    textareaResponse: null,
    organization: null,
    ticketType: null,
    address: null,
    firstTimer: false,
    department: null,
    fellowship: null,
    age: null,
    sex: null,
    attendanceMode: null
  };

  const attendanceMode = normalizeAttendanceMode(formData.attendanceMode);
  if (virtualAttendanceEnabled && !attendanceMode) {
    throw new Error('Please select how you will attend.');
  }
  payload.attendanceMode = virtualAttendanceEnabled ? attendanceMode : null;

  OPTIONAL_RSVP_FIELDS.forEach((field) => {
    if (field === 'link') {
      const linkUrl = normalizeUrlField(formData.linkUrl || formData.link);
      if (normalizedFields.link && !linkUrl) {
        throw new Error('Link must be a valid http or https URL.');
      }
      payload.linkUrl = linkUrl || null;
      return;
    }

    if (field === 'textarea') {
      const response = cleanText(formData.textareaResponse, 5000);
      if (normalizedFields.textarea && !response) {
        throw new Error('Additional response is required.');
      }
      payload.textareaResponse = response || null;
      return;
    }

    if (field === 'firstTimer') {
      payload.firstTimer = Boolean(formData.firstTimer);
      return;
    }

    if (field === 'age') {
      const rawAge = String(formData.age ?? '').trim();
      if (normalizedFields.age && !rawAge) {
        throw new Error('Age is required.');
      }
      if (rawAge) {
        const age = Number(rawAge);
        if (!Number.isInteger(age) || age < 1 || age > 120) {
          throw new Error('Age must be a number between 1 and 120.');
        }
        payload.age = age;
      }
      return;
    }

    const maxLength = field === 'phoneNumber' ? 50 : field === 'address' ? 1000 : 255;
    const value = cleanText(formData[field], maxLength);
    if (normalizedFields[field] && !value) {
      throw new Error(`${RSVP_FIELD_LABELS[field]} is required.`);
    }

    if (field === 'sex' && value && !['Male', 'Female'].includes(value)) {
      throw new Error('Please select a valid gender.');
    }

    payload[field] = value || null;
  });

  const customValidation = validateCustomResponses(customFormSchema, formData.customResponses || {});
  if (Object.keys(customValidation.errors).length > 0) {
    const firstError = Object.values(customValidation.errors)[0];
    const error = new Error(firstError || 'Please complete the required custom fields.');
    error.customErrors = customValidation.errors;
    throw error;
  }

  payload.customAnswers = customValidation.values;

  return payload;
};

const insertPreEventRsvp = async (preEvent, payload, registrationSource) => {
  const result = await pool.query(
    `INSERT INTO pre_event_rsvps (
      pre_event_id, email_address, full_name, phone_number, school,
      link_url, textarea_response, organization, ticket_type, address, first_timer,
      department, fellowship, age, sex, custom_answers, attendance_mode, status, registration_type, registration_source
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, 'pre_registered', 'rsvp', $18)
    RETURNING *`,
    [
      preEvent.id,
      payload.emailAddress,
      payload.fullName,
      payload.phoneNumber,
      payload.school,
      payload.linkUrl,
      payload.textareaResponse,
      payload.organization,
      payload.ticketType,
      payload.address,
      payload.firstTimer,
      payload.department,
      payload.fellowship,
      payload.age,
      payload.sex,
      JSON.stringify(payload.customAnswers || {}),
      payload.attendanceMode,
      registrationSource
    ]
  );

  return result.rows[0];
};

const sendAndRefreshRsvpQr = async (preEvent, rsvp, token) => {
  const emailResult = await sendCheckinQrForRsvp({ preEvent, rsvp, token });
  if (!emailResult.sent) return { emailResult, rsvp };

  const refreshed = await pool.query('SELECT * FROM pre_event_rsvps WHERE id = $1', [rsvp.id]);
  return {
    emailResult,
    rsvp: refreshed.rows[0] || {
      ...rsvp,
      checkin_token_hash: emailResult.tokenHash,
      checkin_qr_sent_at: new Date(),
      checkin_qr_last_sent_at: new Date()
    }
  };
};

exports.createPreEvent = async (req, res) => {
  let uploadedBanner = null;

  try {
    const title = cleanText(req.body.title, 255);
    const eventDate = parseEventDate(req.body.eventDate);
    const description = cleanText(req.body.description, 5000);
    const venueName = cleanText(req.body.venueName, 255);
    const city = cleanText(req.body.city, 120);
    const discoverEnabled = parseBoolean(req.body.discoverEnabled, false);
    const rsvpFields = normalizeRsvpFields(req.body.rsvpFields);
    const rsvpFieldConfig = normalizeFieldConfig(req.body.rsvpFieldConfig || {});
    const customFormSchema = normalizeCustomFieldSchema(req.body.customFormSchema || []);
    const virtualAttendanceEnabled = parseBoolean(req.body.virtualAttendanceEnabled, false);
    const isRsvpActive = req.body.isRsvpActive !== false;
    const linkedProgramId = await validateLinkedProgram(req.churchId, req.body.programId);

    if (!title) {
      return res.status(400).json({ error: 'Event name is required.' });
    }

    if (!eventDate) {
      return res.status(400).json({ error: 'A valid event date and time is required.' });
    }

    if (req.body.banner?.dataUrl) {
      uploadedBanner = await uploadEventFlyer({
        churchId: req.churchId,
        dataUrl: req.body.banner.dataUrl,
        folder: 'pre-events'
      });
    }

    const slug = await createUniqueSlug(title);

    const result = await pool.query(
      `INSERT INTO pre_events (
        church_id, program_id, title, event_date, description, venue_name, city, discover_enabled,
        banner_url, banner_storage_path, banner_original_name, rsvp_fields, rsvp_field_config, custom_form_schema, virtual_attendance_enabled, slug, is_rsvp_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb, $15, $16, $17)
      RETURNING *`,
      [
        req.churchId,
        linkedProgramId,
        title,
        eventDate,
        description || null,
        venueName || null,
        city || null,
        discoverEnabled,
        uploadedBanner?.flyerUrl || null,
        uploadedBanner?.flyerStoragePath || null,
        cleanText(req.body.banner?.originalName, 255) || null,
        JSON.stringify(rsvpFields),
        JSON.stringify(rsvpFieldConfig),
        JSON.stringify(customFormSchema),
        virtualAttendanceEnabled,
        slug,
        isRsvpActive
      ]
    );

    return res.status(201).json({ preEvent: mapPreEvent(result.rows[0]) });
  } catch (error) {
    if (uploadedBanner?.flyerStoragePath) {
      deleteEventFlyer(uploadedBanner.flyerStoragePath).catch(deleteError => {
        console.error('Pre-event banner cleanup failed:', deleteError.message);
      });
    }

    const isValidationError = /Linked live program/i.test(error.message || '');
    console.error('Create pre-event error:', error);
    return res.status(isValidationError ? 400 : 500).json({ error: error.message || 'Server error creating pre-event.' });
  }
};

exports.getPreEvents = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pe.*, COUNT(per.id) AS rsvp_count
       FROM pre_events pe
       LEFT JOIN pre_event_rsvps per ON per.pre_event_id = pe.id
       WHERE pe.church_id = $1
       GROUP BY pe.id
       ORDER BY pe.event_date DESC, pe.created_at DESC`,
      [req.churchId]
    );

    return res.json({ preEvents: result.rows.map(mapPreEvent) });
  } catch (error) {
    console.error('Get pre-events error:', error);
    return res.status(500).json({ error: 'Server error fetching pre-events.' });
  }
};

exports.getPreEventById = async (req, res) => {
  try {
    const preEvent = await getOwnedPreEventRow(req.churchId, req.params.id);
    if (!preEvent) {
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    const [rsvpsResult, qrEmailQuota] = await Promise.all([
      pool.query(
        `SELECT per.*,
                to_char(
                  timezone($2, timezone(current_setting('TimeZone'), per.created_at)),
                  'YYYY-MM-DD'
                ) AS registration_date_key
         FROM pre_event_rsvps per
         WHERE per.pre_event_id = $1
         ORDER BY per.created_at DESC`,
        [preEvent.id, RSVP_ANALYTICS_TIMEZONE]
      ),
      getQrEmailQuota(req.churchId)
    ]);

    const rsvps = rsvpsResult.rows.map(mapRsvp);
    return res.json({
      preEvent: mapPreEvent(preEvent, { rsvpCount: rsvps.length }),
      rsvps,
      analytics: buildRsvpAnalytics(rsvpsResult.rows),
      qrEmailQuota
    });
  } catch (error) {
    console.error('Get pre-event detail error:', error);
    return res.status(500).json({ error: 'Server error fetching pre-event.' });
  }
};

exports.getQrEmailQuota = async (req, res) => {
  try {
    const quota = await getQrEmailQuota(req.churchId);
    return res.json(quota);
  } catch (error) {
    console.error('Get RSVP QR email quota error:', error);
    return res.status(500).json({ error: 'Unable to load the QR email allowance.' });
  }
};

exports.importPreEventRsvps = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const rows = req.body.rows;
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'Add at least one attendee row to import.' });
    }
    if (rows.length > MAX_RSVP_IMPORT_ROWS) {
      return res.status(400).json({ error: `A single import can contain at most ${MAX_RSVP_IMPORT_ROWS.toLocaleString()} attendees.` });
    }

    const validation = validateRsvpImportRows(rows);

    await client.query('BEGIN');
    transactionStarted = true;

    const preEventResult = await client.query(
      'SELECT id FROM pre_events WHERE id = $1 AND church_id = $2',
      [req.params.id, req.churchId]
    );
    if (preEventResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    const lockResult = await client.query(
      'SELECT pg_try_advisory_xact_lock($1::integer, $2::integer) AS acquired',
      [Number(req.churchId), Number(req.params.id)]
    );
    if (!lockResult.rows[0]?.acquired) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ error: 'Another attendee import is already running for this event.' });
    }

    const errors = [...validation.errors];
    let duplicateCount = validation.duplicateCount;
    let candidates = validation.validRows;

    if (candidates.length > 0) {
      const existingResult = await client.query(
        `SELECT email_address
         FROM pre_event_rsvps
         WHERE pre_event_id = $1
           AND LOWER(email_address) = ANY($2::text[])`,
        [req.params.id, candidates.map(row => row.emailAddress)]
      );
      const existingEmails = new Set(existingResult.rows.map(row => normalizeEmail(row.email_address)));

      candidates = candidates.filter((row) => {
        if (!existingEmails.has(row.emailAddress)) return true;
        duplicateCount += 1;
        errors.push({
          sourceRow: row.sourceRow,
          emailAddress: row.emailAddress,
          type: 'duplicate',
          reason: 'This email is already registered for the event.'
        });
        return false;
      });
    }

    let importedCount = 0;
    for (let index = 0; index < candidates.length; index += RSVP_IMPORT_CHUNK_SIZE) {
      const chunk = candidates.slice(index, index + RSVP_IMPORT_CHUNK_SIZE);
      const insertResult = await client.query(
        `INSERT INTO pre_event_rsvps
         (pre_event_id, full_name, email_address, status, registration_type, registration_source)
         SELECT $1, imported.full_name, imported.email_address, 'pre_registered', 'rsvp', 'import'
         FROM UNNEST($2::text[], $3::text[]) AS imported(full_name, email_address)
         ON CONFLICT (pre_event_id, email_address) DO NOTHING
         RETURNING email_address`,
        [
          req.params.id,
          chunk.map(row => row.fullName),
          chunk.map(row => row.emailAddress)
        ]
      );

      const insertedEmails = new Set(insertResult.rows.map(row => normalizeEmail(row.email_address)));
      importedCount += insertedEmails.size;
      chunk.forEach((row) => {
        if (insertedEmails.has(row.emailAddress)) return;
        duplicateCount += 1;
        errors.push({
          sourceRow: row.sourceRow,
          emailAddress: row.emailAddress,
          type: 'duplicate',
          reason: 'This email was registered while the import was running.'
        });
      });
    }

    await client.query('COMMIT');
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      summary: {
        received: validation.received,
        imported: importedCount,
        invalid: validation.invalidCount,
        duplicates: duplicateCount
      },
      errors
    });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    console.error('Pre-event RSVP import error:', error);
    return res.status(500).json({ error: 'Unable to import attendees. No rows were added.' });
  } finally {
    client.release();
  }
};

exports.sendImportedRsvpQrBatch = async (req, res) => {
  try {
    const preEvent = await getOwnedPreEventRow(req.churchId, req.params.id);
    if (!preEvent) {
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    const reservation = await reserveImportedQrEmailBatch({
      churchId: req.churchId,
      preEventId: preEvent.id,
      maxCount: QR_EMAIL_BATCH_LIMIT
    });
    const selectedRsvps = reservation.reservations;

    if (selectedRsvps.length === 0) {
      return res.json({
        success: true,
        summary: {
          selected: 0,
          sent: 0,
          failed: 0,
          remainingUnsent: await countRemainingImportedQrEmails(preEvent.id)
        },
        errors: [],
        quota: reservation.quota
      });
    }

    const preparationResults = await mapWithConcurrency(
      selectedRsvps,
      QR_EMAIL_PREPARATION_CONCURRENCY,
      rsvp => prepareImportedQrEmail(preEvent, rsvp)
    );
    const preparedEmails = preparationResults.filter(result => result.prepared);
    const failures = preparationResults
      .filter(result => !result.prepared)
      .map(result => ({
        reservationId: result.reservationId,
        rsvpId: result.rsvpId,
        emailAddress: result.emailAddress,
        reason: result.reason || 'QR image preparation failed.'
      }));

    if (preparedEmails.length === 0) {
      const quota = await completeQrEmailBatch({
        churchId: req.churchId,
        failures
      });
      return res.json({
        success: true,
        summary: {
          selected: selectedRsvps.length,
          sent: 0,
          failed: failures.length,
          remainingUnsent: await countRemainingImportedQrEmails(preEvent.id)
        },
        errors: failures.map(({ rsvpId, emailAddress, reason }) => ({ rsvpId, emailAddress, reason })),
        quota
      });
    }

    const idempotencyHash = crypto
      .createHash('sha256')
      .update(preparedEmails.map(item => item.reservationId).join(','))
      .digest('hex')
      .slice(0, 48);
    let batchResult;
    try {
      batchResult = await sendRsvpQrEmailBatch({
        emails: preparedEmails.map(item => item.email),
        idempotencyKey: `rsvp-qr-${preEvent.id}-${idempotencyHash}`
      });
    } catch (providerError) {
      batchResult = {
        sent: false,
        accepted: [],
        errors: [],
        reason: providerError.message || 'The email provider rejected the QR email batch.'
      };
    }

    if (!batchResult.sent) {
      const providerFailures = preparedEmails.map(item => ({
        reservationId: item.reservationId,
        rsvpId: item.rsvpId,
        emailAddress: item.emailAddress,
        reason: batchResult.reason || 'The email provider rejected the QR email batch.'
      }));
      const allFailures = [...failures, ...providerFailures];
      const quota = await completeQrEmailBatch({
        churchId: req.churchId,
        failures: allFailures
      });
      await cleanupPreparedQrAssets(preparedEmails);

      return res.status(502).json({
        error: batchResult.reason || 'The email provider rejected the QR email batch.',
        summary: {
          selected: selectedRsvps.length,
          sent: 0,
          failed: allFailures.length,
          remainingUnsent: await countRemainingImportedQrEmails(preEvent.id)
        },
        errors: allFailures.map(({ rsvpId, emailAddress, reason }) => ({ rsvpId, emailAddress, reason })),
        quota
      });
    }

    const providerErrorByIndex = new Map(
      batchResult.errors
        .filter(error => Number.isInteger(Number(error.index)))
        .map(error => [Number(error.index), error.message || 'The email provider rejected this recipient.'])
    );
    const successes = [];
    const providerRejectedItems = [];
    let acceptedIndex = 0;

    preparedEmails.forEach((item, index) => {
      const providerError = providerErrorByIndex.get(index);
      if (providerError) {
        failures.push({
          reservationId: item.reservationId,
          rsvpId: item.rsvpId,
          emailAddress: item.emailAddress,
          reason: providerError
        });
        providerRejectedItems.push(item);
        return;
      }

      if (!batchResult.accepted[acceptedIndex]) {
        failures.push({
          reservationId: item.reservationId,
          rsvpId: item.rsvpId,
          emailAddress: item.emailAddress,
          reason: 'The email provider did not confirm this recipient.'
        });
        providerRejectedItems.push(item);
        return;
      }

      acceptedIndex += 1;
      successes.push({
        reservationId: item.reservationId,
        rsvpId: item.rsvpId,
        tokenHash: item.tokenHash
      });
    });

    const quota = await completeQrEmailBatch({
      churchId: req.churchId,
      successes,
      failures
    });
    await cleanupPreparedQrAssets(providerRejectedItems);

    return res.json({
      success: true,
      summary: {
        selected: selectedRsvps.length,
        sent: successes.length,
        failed: failures.length,
        remainingUnsent: await countRemainingImportedQrEmails(preEvent.id)
      },
      errors: failures.map(({ rsvpId, emailAddress, reason }) => ({ rsvpId, emailAddress, reason })),
      quota
    });
  } catch (error) {
    console.error('Send imported RSVP QR batch error:', error);
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Unable to send imported RSVP QR emails.',
      code: error.code || null,
      quota: error.quota || null
    });
  }
};

exports.updatePreEvent = async (req, res) => {
  let uploadedBanner = null;

  try {
    const existing = await getOwnedPreEventRow(req.churchId, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    const title = cleanText(req.body.title ?? existing.title, 255);
    const eventDate = parseEventDate(req.body.eventDate ?? existing.event_date);
    const description = cleanText(req.body.description ?? existing.description, 5000);
    const venueName = cleanText(req.body.venueName ?? existing.venue_name, 255);
    const city = cleanText(req.body.city ?? existing.city, 120);
    const rsvpFields = normalizeRsvpFields(req.body.rsvpFields || existing.rsvp_fields);
    const rsvpFieldConfig = normalizeFieldConfig(req.body.rsvpFieldConfig || existing.rsvp_field_config || {});
    const customFormSchema = normalizeCustomFieldSchema(
      Object.prototype.hasOwnProperty.call(req.body, 'customFormSchema')
        ? req.body.customFormSchema
        : existing.custom_form_schema || []
    );
    const virtualAttendanceEnabled = typeof req.body.virtualAttendanceEnabled === 'boolean'
      ? req.body.virtualAttendanceEnabled
      : existing.virtual_attendance_enabled === true;
    const linkedProgramId = Object.prototype.hasOwnProperty.call(req.body, 'programId')
      ? await validateLinkedProgram(req.churchId, req.body.programId)
      : existing.program_id || null;
    const isRsvpActive = typeof req.body.isRsvpActive === 'boolean'
      ? req.body.isRsvpActive
      : existing.is_rsvp_active !== false;
    const discoverEnabled = typeof req.body.discoverEnabled === 'boolean'
      ? req.body.discoverEnabled
      : existing.discover_enabled === true;

    if (!title) {
      return res.status(400).json({ error: 'Event name is required.' });
    }

    if (!eventDate) {
      return res.status(400).json({ error: 'A valid event date and time is required.' });
    }

    if (req.body.banner?.dataUrl) {
      uploadedBanner = await uploadEventFlyer({
        churchId: req.churchId,
        dataUrl: req.body.banner.dataUrl,
        folder: 'pre-events'
      });
    }

    const result = await pool.query(
      `UPDATE pre_events
       SET title = $1,
           program_id = $2,
           event_date = $3,
           description = $4,
           venue_name = $5,
           city = $6,
           discover_enabled = $7,
           banner_url = COALESCE($8, banner_url),
           banner_storage_path = COALESCE($9, banner_storage_path),
           banner_original_name = COALESCE($10, banner_original_name),
           rsvp_fields = $11::jsonb,
           rsvp_field_config = $12::jsonb,
           custom_form_schema = $13::jsonb,
           virtual_attendance_enabled = $14,
           is_rsvp_active = $15,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $16 AND church_id = $17
       RETURNING *`,
      [
        title,
        linkedProgramId,
        eventDate,
        description || null,
        venueName || null,
        city || null,
        discoverEnabled,
        uploadedBanner?.flyerUrl || null,
        uploadedBanner?.flyerStoragePath || null,
        req.body.banner?.dataUrl ? cleanText(req.body.banner?.originalName, 255) || null : null,
        JSON.stringify(rsvpFields),
        JSON.stringify(rsvpFieldConfig),
        JSON.stringify(customFormSchema),
        virtualAttendanceEnabled,
        isRsvpActive,
        existing.id,
        req.churchId
      ]
    );

    if (uploadedBanner?.flyerStoragePath && existing.banner_storage_path) {
      deleteEventFlyer(existing.banner_storage_path).catch(deleteError => {
        console.error('Old pre-event banner cleanup failed:', deleteError.message);
      });
    }

    return res.json({ preEvent: mapPreEvent(result.rows[0]) });
  } catch (error) {
    if (uploadedBanner?.flyerStoragePath) {
      deleteEventFlyer(uploadedBanner.flyerStoragePath).catch(deleteError => {
        console.error('Pre-event banner cleanup failed:', deleteError.message);
      });
    }

    const isValidationError = /Linked live program/i.test(error.message || '');
    console.error('Update pre-event error:', error);
    return res.status(isValidationError ? 400 : 500).json({ error: error.message || 'Server error updating pre-event.' });
  }
};

exports.deletePreEvent = async (req, res) => {
  try {
    const existing = await getOwnedPreEventRow(req.churchId, req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    await pool.query('DELETE FROM pre_events WHERE id = $1 AND church_id = $2', [existing.id, req.churchId]);

    if (existing.banner_storage_path) {
      deleteEventFlyer(existing.banner_storage_path).catch(deleteError => {
        console.error('Deleted pre-event banner cleanup failed:', deleteError.message);
      });
    }

    return res.json({ message: 'Pre-event deleted successfully.' });
  } catch (error) {
    console.error('Delete pre-event error:', error);
    return res.status(500).json({ error: 'Server error deleting pre-event.' });
  }
};

exports.getPublicPreEvent = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pe.id, pe.title, pe.event_date, pe.description, pe.venue_name, pe.city,
              pe.banner_url, pe.rsvp_fields, pe.rsvp_field_config, pe.custom_form_schema, pe.slug, pe.is_rsvp_active,
              pe.discover_enabled, pe.virtual_attendance_enabled, c.church_name, COUNT(per.id) AS rsvp_count
       FROM pre_events pe
       JOIN churches c ON c.id = pe.church_id
       LEFT JOIN pre_event_rsvps per ON per.pre_event_id = pe.id
       WHERE pe.slug = $1
       GROUP BY pe.id, c.church_name`,
      [req.params.slug]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'RSVP page not found.' });
    }

    return res.json({ preEvent: mapPreEvent(result.rows[0]) });
  } catch (error) {
    console.error('Get public pre-event error:', error);
    return res.status(500).json({ error: 'Server error fetching RSVP page.' });
  }
};

exports.getDiscoverPreEvents = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit || '24', 10) || 24, 1), 60);
    const city = cleanText(req.query.city, 120);
    const params = [limit];
    let cityFilter = '';

    if (city) {
      params.push(city);
      cityFilter = ` AND LOWER(pe.city) = LOWER($${params.length})`;
    }

    const result = await pool.query(
      `SELECT pe.id, pe.title, pe.event_date, pe.description, pe.venue_name, pe.city,
              pe.banner_url, pe.custom_form_schema, pe.slug, pe.is_rsvp_active, pe.discover_enabled,
              pe.virtual_attendance_enabled, c.church_name, COUNT(per.id) AS rsvp_count
       FROM pre_events pe
       JOIN churches c ON c.id = pe.church_id
       LEFT JOIN pre_event_rsvps per ON per.pre_event_id = pe.id
       WHERE pe.discover_enabled = TRUE
         AND pe.is_rsvp_active = TRUE
         AND pe.event_date >= (CURRENT_TIMESTAMP - INTERVAL '12 hours')
         ${cityFilter}
       GROUP BY pe.id, c.church_name
       ORDER BY pe.event_date ASC, pe.created_at DESC
       LIMIT $1`,
      params
    );

    return res.json({ preEvents: result.rows.map(mapPreEvent) });
  } catch (error) {
    console.error('Get discover pre-events error:', error);
    return res.status(500).json({ error: 'Server error fetching discover events.' });
  }
};

exports.submitPublicRsvp = async (req, res) => {
  try {
    const eventResult = await pool.query(
      `SELECT pe.*, c.church_name
       FROM pre_events pe
       JOIN churches c ON c.id = pe.church_id
       WHERE pe.slug = $1`,
      [req.params.slug]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'RSVP page not found.' });
    }

    const preEvent = eventResult.rows[0];
    if (preEvent.is_rsvp_active === false) {
      return res.status(403).json({ error: 'RSVPs are currently closed for this event.' });
    }

    const payload = validateRsvpPayload(
      preEvent.rsvp_fields,
      preEvent.custom_form_schema || [],
      req.body.formData || req.body,
      preEvent.virtual_attendance_enabled === true
    );

    let rsvp = await insertPreEventRsvp(preEvent, payload, 'public');
    const emailToken = generateRsvpCheckinToken();
    let qrEmail = { sent: false };
    try {
      const sendResult = await sendAndRefreshRsvpQr(preEvent, rsvp, emailToken);
      qrEmail = sendResult.emailResult;
      rsvp = sendResult.rsvp;
    } catch (emailError) {
      console.error('RSVP QR email send failed:', emailError.message);
      qrEmail = { sent: false, reason: emailError.message };
    }

    return res.status(201).json({
      success: true,
      message: 'Your access is secured. See you there!',
      qrEmailSent: Boolean(qrEmail.sent),
      emailWarning: !qrEmail.sent ? (qrEmail.reason || 'Your QR email could not be sent yet.') : null,
      rsvp: mapRsvp(rsvp)
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This email has already secured access for this event.' });
    }

    const isValidationError = /required|valid email|valid http|age must|valid gender|invalid option|select how/i.test(error.message || '');
    if (isValidationError) {
      return res.status(400).json({ error: error.message });
    }

    console.error('Submit public RSVP error:', error);
    return res.status(500).json({ error: 'Server error submitting RSVP.' });
  }
};

exports.createManualRsvp = async (req, res) => {
  try {
    const preEvent = await getOwnedPreEventRow(req.churchId, req.params.id);
    if (!preEvent) {
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    const payload = validateRsvpPayload(
      preEvent.rsvp_fields,
      preEvent.custom_form_schema || [],
      req.body.formData || {},
      preEvent.virtual_attendance_enabled === true
    );

    let rsvp = await insertPreEventRsvp(preEvent, payload, 'manual');
    let qrEmail = { sent: false };
    const shouldSendQrEmail = req.body.sendQrEmail !== false;

    if (shouldSendQrEmail) {
      try {
        const sendResult = await sendAndRefreshRsvpQr(preEvent, rsvp, generateRsvpCheckinToken());
        qrEmail = sendResult.emailResult;
        rsvp = sendResult.rsvp;
      } catch (emailError) {
        console.error('Manual RSVP QR email send failed:', emailError.message);
        qrEmail = { sent: false, reason: emailError.message };
      }
    }

    return res.status(201).json({
      success: true,
      message: shouldSendQrEmail && !qrEmail.sent
        ? 'RSVP added, but the QR email was not sent. You can resend it from the table.'
        : 'RSVP added successfully.',
      qrEmailSent: Boolean(qrEmail.sent),
      emailWarning: shouldSendQrEmail && !qrEmail.sent ? (qrEmail.reason || 'QR email was not sent.') : null,
      quota: qrEmail.quota || null,
      qrEmailQuota: qrEmail.quota || null,
      rsvp: mapRsvp(rsvp)
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This email has already secured access for this event.' });
    }

    const isValidationError = /required|valid email|valid http|age must|valid gender|invalid option|select how/i.test(error.message || '');
    if (isValidationError) {
      return res.status(400).json({ error: error.message, customErrors: error.customErrors || null });
    }

    console.error('Create manual RSVP error:', error);
    return res.status(500).json({ error: 'Server error adding RSVP manually.' });
  }
};

exports.resendRsvpQrEmail = async (req, res) => {
  try {
    const preEvent = await getOwnedPreEventRow(req.churchId, req.params.id);
    if (!preEvent) {
      return res.status(404).json({ error: 'Pre-event not found.' });
    }

    const rsvpResult = await pool.query(
      `SELECT *
       FROM pre_event_rsvps
       WHERE id = $1 AND pre_event_id = $2`,
      [req.params.rsvpId, preEvent.id]
    );

    if (rsvpResult.rows.length === 0) {
      return res.status(404).json({ error: 'RSVP record not found.' });
    }

    const rsvp = rsvpResult.rows[0];
    if (rsvp.status === 'checked_in') {
      return res.status(400).json({ error: 'This RSVP has already checked in.' });
    }

    const emailResult = await sendCheckinQrForRsvp({ preEvent, rsvp });
    if (!emailResult.sent) {
      return res.status(500).json({
        error: emailResult.reason || 'Failed to send RSVP QR email.',
        quota: emailResult.quota || null
      });
    }

    const refreshed = await pool.query('SELECT * FROM pre_event_rsvps WHERE id = $1', [rsvp.id]);
    return res.json({
      success: true,
      message: 'RSVP QR email resent.',
      rsvp: mapRsvp(refreshed.rows[0]),
      quota: emailResult.quota || null
    });
  } catch (error) {
    console.error('Resend RSVP QR email error:', error);
    return res.status(error.statusCode || 500).json({
      error: error.statusCode ? error.message : 'Server error resending RSVP QR email.',
      code: error.code || null,
      quota: error.quota || null
    });
  }
};
