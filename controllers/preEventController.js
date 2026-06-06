const crypto = require('crypto');
const pool = require('../config/database');
const { uploadEventFlyer, deleteEventFlyer } = require('../utils/supabaseStorage');

const PUBLIC_FRONTEND_ORIGIN = 'https://ingather.app';

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

const cleanText = (value, maxLength = 255) => {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
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

const mapPreEvent = (row, extras = {}) => ({
  id: row.id,
  programId: row.program_id || null,
  title: row.title,
  eventDate: row.event_date,
  description: row.description || '',
  bannerUrl: row.banner_url || null,
  bannerOriginalName: row.banner_original_name || null,
  rsvpFields: normalizeRsvpFields(row.rsvp_fields || {}),
  rsvpFieldConfig: normalizeFieldConfig(row.rsvp_field_config || {}),
  slug: row.slug,
  publicUrl: getPublicRsvpUrl(row.slug),
  isRsvpActive: row.is_rsvp_active !== false,
  rsvpCount: parseInt(row.rsvp_count || extras.rsvpCount || 0, 10),
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
  checkedInAt: row.checked_in_at || null,
  createdAt: row.created_at
});

const getOwnedPreEventRow = async (churchId, id) => {
  const result = await pool.query(
    'SELECT * FROM pre_events WHERE id = $1 AND church_id = $2',
    [id, churchId]
  );
  return result.rows[0] || null;
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

const validateRsvpPayload = (fields, formData = {}) => {
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
    sex: null
  };

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

    if (field === 'sex' && value && !['Male', 'Female', 'Other'].includes(value)) {
      throw new Error('Please select a valid gender.');
    }

    payload[field] = value || null;
  });

  return payload;
};

const buildVelocity = (rows) => {
  const lookup = rows.reduce((map, row) => {
    map[row.date_key] = parseInt(row.count, 10);
    return map;
  }, {});

  return Array.from({ length: 14 }).map((_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - (13 - index));
    const dateKey = date.toISOString().slice(0, 10);
    return {
      date: dateKey,
      label: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      registrations: lookup[dateKey] || 0
    };
  });
};

exports.createPreEvent = async (req, res) => {
  let uploadedBanner = null;

  try {
    const title = cleanText(req.body.title, 255);
    const eventDate = parseEventDate(req.body.eventDate);
    const description = cleanText(req.body.description, 5000);
    const rsvpFields = normalizeRsvpFields(req.body.rsvpFields);
    const rsvpFieldConfig = normalizeFieldConfig(req.body.rsvpFieldConfig || {});
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
        church_id, program_id, title, event_date, description, banner_url, banner_storage_path,
        banner_original_name, rsvp_fields, rsvp_field_config, slug, is_rsvp_active
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)
      RETURNING *`,
      [
        req.churchId,
        linkedProgramId,
        title,
        eventDate,
        description || null,
        uploadedBanner?.flyerUrl || null,
        uploadedBanner?.flyerStoragePath || null,
        cleanText(req.body.banner?.originalName, 255) || null,
        JSON.stringify(rsvpFields),
        JSON.stringify(rsvpFieldConfig),
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

    const [rsvpsResult, velocityResult] = await Promise.all([
      pool.query(
        `SELECT *
         FROM pre_event_rsvps
         WHERE pre_event_id = $1
         ORDER BY created_at DESC`,
        [preEvent.id]
      ),
      pool.query(
        `SELECT to_char(created_at::date, 'YYYY-MM-DD') AS date_key, COUNT(*) AS count
         FROM pre_event_rsvps
         WHERE pre_event_id = $1
           AND created_at >= (CURRENT_DATE - INTERVAL '13 days')
         GROUP BY created_at::date
         ORDER BY created_at::date ASC`,
        [preEvent.id]
      )
    ]);

    const rsvps = rsvpsResult.rows.map(mapRsvp);
    const todayKey = new Date().toISOString().slice(0, 10);
    return res.json({
      preEvent: mapPreEvent(preEvent, { rsvpCount: rsvps.length }),
      rsvps,
      analytics: {
        totalRsvps: rsvps.length,
        todayRsvps: rsvps.filter((rsvp) => {
          const submittedAt = new Date(rsvp.createdAt);
          return !Number.isNaN(submittedAt.getTime()) && submittedAt.toISOString().slice(0, 10) === todayKey;
        }).length,
        velocity: buildVelocity(velocityResult.rows)
      }
    });
  } catch (error) {
    console.error('Get pre-event detail error:', error);
    return res.status(500).json({ error: 'Server error fetching pre-event.' });
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
    const rsvpFields = normalizeRsvpFields(req.body.rsvpFields || existing.rsvp_fields);
    const rsvpFieldConfig = normalizeFieldConfig(req.body.rsvpFieldConfig || existing.rsvp_field_config || {});
    const linkedProgramId = Object.prototype.hasOwnProperty.call(req.body, 'programId')
      ? await validateLinkedProgram(req.churchId, req.body.programId)
      : existing.program_id || null;
    const isRsvpActive = typeof req.body.isRsvpActive === 'boolean'
      ? req.body.isRsvpActive
      : existing.is_rsvp_active !== false;

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
           banner_url = COALESCE($5, banner_url),
           banner_storage_path = COALESCE($6, banner_storage_path),
           banner_original_name = COALESCE($7, banner_original_name),
           rsvp_fields = $8::jsonb,
           rsvp_field_config = $9::jsonb,
           is_rsvp_active = $10,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $11 AND church_id = $12
       RETURNING *`,
      [
        title,
        linkedProgramId,
        eventDate,
        description || null,
        uploadedBanner?.flyerUrl || null,
        uploadedBanner?.flyerStoragePath || null,
        req.body.banner?.dataUrl ? cleanText(req.body.banner?.originalName, 255) || null : null,
        JSON.stringify(rsvpFields),
        JSON.stringify(rsvpFieldConfig),
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
      `SELECT id, title, event_date, description, banner_url, rsvp_fields, slug, is_rsvp_active
       FROM pre_events
       WHERE slug = $1`,
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

exports.submitPublicRsvp = async (req, res) => {
  try {
    const eventResult = await pool.query(
      'SELECT * FROM pre_events WHERE slug = $1',
      [req.params.slug]
    );

    if (eventResult.rows.length === 0) {
      return res.status(404).json({ error: 'RSVP page not found.' });
    }

    const preEvent = eventResult.rows[0];
    if (preEvent.is_rsvp_active === false) {
      return res.status(403).json({ error: 'RSVPs are currently closed for this event.' });
    }

    const payload = validateRsvpPayload(preEvent.rsvp_fields, req.body.formData || req.body);

    const result = await pool.query(
      `INSERT INTO pre_event_rsvps (
        pre_event_id, email_address, full_name, phone_number, school,
        link_url, textarea_response, organization, ticket_type, address, first_timer,
        department, fellowship, age, sex, status, registration_type
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 'pre_registered', 'rsvp')
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
        payload.sex
      ]
    );

    return res.status(201).json({
      success: true,
      message: 'Your access is secured. See you there!',
      rsvp: mapRsvp(result.rows[0])
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This email has already secured access for this event.' });
    }

    const isValidationError = /required|valid email|valid http|age must|valid gender/i.test(error.message || '');
    if (isValidationError) {
      return res.status(400).json({ error: error.message });
    }

    console.error('Submit public RSVP error:', error);
    return res.status(500).json({ error: 'Server error submitting RSVP.' });
  }
};
