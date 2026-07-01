const crypto = require('crypto');
const pool = require('../config/database');
const { normalizeCustomFieldSchema, validateCustomResponses } = require('../utils/customFields');

const SCAN_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const scanTokenSecret = () => process.env.SCAN_TOKEN_SECRET || process.env.JWT_SECRET || 'ingather-development-scan-secret';

const createScanSessionToken = () => crypto.randomBytes(32).toString('base64url');

const hashScanSessionToken = (token) => {
  return crypto
    .createHmac('sha256', scanTokenSecret())
    .update(String(token || ''))
    .digest('hex');
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  if (left.length !== right.length) return false;

  return crypto.timingSafeEqual(left, right);
};

const normalizeDeviceFingerprint = (deviceFingerprint) => {
  if (typeof deviceFingerprint !== 'string') return null;

  const trimmed = deviceFingerprint.trim();
  if (!trimmed || trimmed.length > 500) return null;

  return trimmed;
};

const cleanText = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeCollectedEmail = (value) => cleanText(value).toLowerCase();

const isValidCollectedEmail = (value) => {
  const email = normalizeCollectedEmail(value);
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

const getScanSessionToken = (req) => {
  return req.body?.scanSessionToken || req.get('x-scan-session-token');
};

const getScanSessionId = (req) => {
  return req.body?.scanSessionId || req.get('x-scan-session-id');
};

const normalizeScanSessionId = (scanSessionId) => {
  const parsed = Number(scanSessionId);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
};

const verifyScanSession = async (client, programId, scanSessionId, deviceFingerprint, token) => {
  const normalizedFingerprint = normalizeDeviceFingerprint(deviceFingerprint);
  const normalizedScanSessionId = normalizeScanSessionId(scanSessionId);

  if (!normalizedFingerprint || !normalizedScanSessionId || !token) {
    return { status: 401, error: 'Valid scan session is required.' };
  }

  const scanResult = await client.query(
    `SELECT *
     FROM scans
     WHERE id = $1
       AND program_id = $2
       AND device_fingerprint = $3
       AND proxy_host_fingerprint IS NULL`,
    [normalizedScanSessionId, programId, normalizedFingerprint]
  );

  if (scanResult.rows.length === 0) {
    return { status: 400, error: 'No scan record found. Please scan the QR code first.' };
  }

  const scan = scanResult.rows[0];

  if (!scan.scan_token_hash || !scan.scan_token_expires_at) {
    return { status: 401, error: 'Scan session has expired. Please scan the QR code again.' };
  }

  if (new Date() > new Date(scan.scan_token_expires_at)) {
    return { status: 401, error: 'Scan session has expired. Please scan the QR code again.' };
  }

  if (!safeEqual(scan.scan_token_hash, hashScanSessionToken(token))) {
    return { status: 403, error: 'Invalid scan session.' };
  }

  return { scan, deviceFingerprint: normalizedFingerprint };
};

const getSharedDeviceCheckins = async (db, programId) => {
  const result = await db.query(
    `SELECT COALESCE(SUM(device_count - 1), 0) AS shared_device_checkins
     FROM (
       SELECT device_fingerprint, COUNT(*) AS device_count
       FROM attendees
       WHERE program_id = $1
         AND proxy_host_fingerprint IS NULL
         AND device_fingerprint NOT LIKE 'manual-%'
         AND device_fingerprint NOT LIKE 'proxy-%'
       GROUP BY device_fingerprint
       HAVING COUNT(*) > 1
     ) duplicate_devices`,
    [programId]
  );

  return parseInt(result.rows[0].shared_device_checkins, 10) || 0;
};

const parsePersonalizedTemplates = (config = {}) => {
  const fromArray = Array.isArray(config.templates)
    ? config.templates.map(message => String(message || '').trim()).filter(Boolean)
    : [];

  if (fromArray.length > 0) return fromArray;

  return String(config.template || '')
    .split(/\r?\n/)
    .map(message => message.trim())
    .filter(Boolean);
};

const getFirstName = (fullName) => {
  const firstName = String(fullName || '').trim().split(/\s+/)[0];
  return firstName || 'Friend';
};

const personalizeTemplate = (template, firstName) => (
  String(template || '[FirstName], you are welcome and deeply valued.')
    .replace(/\[FirstName\]/gi, firstName)
);

const selectPersonalizedMessage = (program, formData) => {
  if (program.flyer_type !== 'personalized') return null;

  const templates = parsePersonalizedTemplates(program.personalized_flyer_config || {});
  if (templates.length === 0) return null;

  const selectedTemplate = templates[Math.floor(Math.random() * templates.length)];
  return personalizeTemplate(selectedTemplate, getFirstName(formData.fullName));
};

const getCountStats = async (programId) => {
  const statsResult = await pool.query(
    `SELECT 
      COUNT(CASE WHEN gender = 'male' THEN 1 END) as male_count,
      COUNT(CASE WHEN gender = 'female' THEN 1 END) as female_count,
      COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
     FROM scans WHERE program_id = $1`,
    [programId]
  );

  return {
    maleCount: parseInt(statsResult.rows[0].male_count, 10),
    femaleCount: parseInt(statsResult.rows[0].female_count, 10),
    firstTimerCount: parseInt(statsResult.rows[0].first_timer_count, 10)
  };
};

const mapSponsor = (sponsor) => ({
  id: sponsor.id,
  sponsorName: sponsor.sponsor_name,
  flyerUrl: sponsor.flyer_url,
  ctaText: sponsor.cta_text,
  ctaLink: sponsor.cta_link,
  boothText: sponsor.booth_text,
  campaignTag: sponsor.campaign_tag,
  tier: sponsor.tier,
  distributionPercentage: sponsor.distribution_percentage,
  clickCount: parseInt(sponsor.click_count || 0, 10),
  displayOrder: sponsor.display_order
});

const getSponsorsForProgram = async (programId) => {
  const result = await pool.query(
    `SELECT *
     FROM event_sponsors
     WHERE program_id = $1 AND is_active = true
     ORDER BY
       CASE WHEN tier IS NULL OR tier = '' THEN 1 ELSE 0 END,
       tier ASC,
       display_order ASC,
       created_at ASC`,
    [programId]
  );

  return result.rows.map(mapSponsor);
};

const buildAttendeeStats = async (db, programId) => {
  const result = await db.query(
    `SELECT
      COUNT(*) as total,
      COUNT(CASE WHEN sex = 'Male' THEN 1 END) as male_count,
      COUNT(CASE WHEN sex = 'Female' THEN 1 END) as female_count,
      COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
     FROM attendees
     WHERE program_id = $1
       AND status = 'checked_in'`,
    [programId]
  );

  return {
    attendeeMaleCount: parseInt(result.rows[0].male_count, 10),
    attendeeFemaleCount: parseInt(result.rows[0].female_count, 10),
    attendeeFirstTimerCount: parseInt(result.rows[0].first_timer_count, 10),
    attendeeTotal: parseInt(result.rows[0].total, 10)
  };
};

const mapFastTrackAttendee = (attendee) => ({
  id: attendee.id,
  fullName: attendee.full_name || '',
  emailAddress: attendee.email_address || '',
  school: attendee.school || '',
  linkUrl: attendee.link_url || '',
  textareaResponse: attendee.textarea_response || '',
  phoneNumber: attendee.phone_number || '',
  address: attendee.address || '',
  firstTimer: Boolean(attendee.first_timer),
  department: attendee.department || '',
  fellowship: attendee.fellowship || '',
  age: attendee.age || '',
  sex: attendee.sex || '',
  status: attendee.status || 'checked_in',
  registrationType: attendee.registration_type || 'rsvp',
  attendanceMode: attendee.attendance_mode || 'physical',
  checkedInAt: attendee.checked_in_at || attendee.scan_time,
  customResponses: attendee.custom_responses || {},
  scanTime: attendee.scan_time
});

const hashToPercentageBucket = (programId, deviceFingerprint) => {
  const hash = crypto
    .createHash('sha256')
    .update(`${programId}:${deviceFingerprint || crypto.randomUUID()}`)
    .digest('hex');
  const value = parseInt(hash.slice(0, 8), 16);
  return (value / 0xffffffff) * 100;
};

const selectDistributedSponsor = (programId, deviceFingerprint, sponsors) => {
  if (sponsors.length === 0) return null;

  const bucket = hashToPercentageBucket(programId, deviceFingerprint);
  let cursor = 0;

  for (const sponsor of sponsors) {
    cursor += Number(sponsor.distributionPercentage || 0);
    if (bucket < cursor) return sponsor;
  }

  return sponsors[sponsors.length - 1];
};

const buildSponsorPlacement = async (programId, sponsorDisplayMode, deviceFingerprint) => {
  const sponsors = await getSponsorsForProgram(programId);
  if (sponsors.length === 0) return null;

  if (sponsorDisplayMode === 'distribution') {
    return {
      mode: 'distribution',
      sponsor: selectDistributedSponsor(programId, deviceFingerprint, sponsors)
    };
  }

  return {
    mode: 'carousel',
    sponsors
  };
};

const hashDeviceFingerprintForAnalytics = (fingerprint) => {
  if (!fingerprint) return null;
  return crypto
    .createHmac('sha256', scanTokenSecret())
    .update(String(fingerprint))
    .digest('hex');
};

// Handle QR scan
exports.scanQR = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { programId } = req.params;
    const deviceFingerprint = normalizeDeviceFingerprint(req.body.deviceFingerprint);

    if (!deviceFingerprint) {
      return res.status(400).json({ error: 'A valid device fingerprint is required' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const programResult = await client.query(
      'SELECT id, tracking_mode, is_active, sponsor_display_mode, strict_device_fingerprinting FROM programs WHERE id = $1',
      [programId]
    );

    if (programResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programResult.rows[0];

    if (!program.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This program is no longer active' });
    }

    const scanSessionToken = createScanSessionToken();
    const tokenExpiresAt = new Date(Date.now() + SCAN_TOKEN_TTL_MS);
    const useStrictDeviceFingerprinting = program.tracking_mode !== 'collect-data' || program.strict_device_fingerprinting !== false;

    if (useStrictDeviceFingerprinting) {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        [`scan:${programId}:${deviceFingerprint}`]
      );

      const existingScan = await client.query(
        `SELECT id
         FROM scans
         WHERE program_id = $1
           AND device_fingerprint = $2
           AND proxy_host_fingerprint IS NULL
         LIMIT 1`,
        [programId, deviceFingerprint]
      );

      if (existingScan.rows.length > 0) {
        await client.query('ROLLBACK');
        transactionStarted = false;
        return res.status(400).json({
          error: 'This device has already scanned this program',
          alreadyScanned: true
        });
      }
    }

    const scanInsert = await client.query(
      `INSERT INTO scans 
       (program_id, device_fingerprint, gender, first_timer, scan_token_hash, scan_token_expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        programId,
        deviceFingerprint,
        req.body.gender || null,
        req.body.firstTimer || false,
        hashScanSessionToken(scanSessionToken),
        tokenExpiresAt
      ]
    );

    const updatedProgram = await client.query(
      'UPDATE programs SET total_scans = total_scans + 1 WHERE id = $1 RETURNING total_scans',
      [programId]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    const totalScans = updatedProgram.rows[0].total_scans;
    const sponsorPlacement = await buildSponsorPlacement(programId, program.sponsor_display_mode || 'carousel', deviceFingerprint);
    res.json({
      success: true,
      trackingMode: program.tracking_mode,
      totalScans,
      firstScan: true,
      isFirstTimer: req.body.firstTimer || false,
      scanSessionId: scanInsert.rows[0].id,
      scanSessionToken,
      scanSessionExpiresAt: tokenExpiresAt,
      sponsorPlacement
    });

    setImmediate(async () => {
      try {
        const countStats = await getCountStats(programId);
        const io = req.app.get('io');
        io.emit(`program-${programId}-update`, {
          totalScans,
          ...countStats,
          timestamp: new Date()
        });
      } catch (statsError) {
        console.error('Post-scan stats update warning:', statsError);
      }
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK');
    }
    console.error('Scan error:', error);

    if (error.code === '23505') {
      return res.status(400).json({
        error: 'This device has already scanned this program',
        alreadyScanned: true
      });
    }

    return res.status(500).json({ error: 'Server error processing scan' });
  } finally {
    client.release();
  }
};

// Get program info for scan page (public endpoint)
exports.getProgramInfo = async (req, res) => {
  try {
    const { programId } = req.params;

    const result = await pool.query(
      `SELECT p.*, c.church_name, c.logo_url as church_logo 
       FROM programs p 
       JOIN churches c ON p.church_id = c.id 
       WHERE p.id = $1`,
      [programId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = result.rows[0];
    const linkedPreEventResult = await pool.query(
      `SELECT id
       FROM pre_events
       WHERE program_id = $1
       LIMIT 1`,
      [programId]
    );

    return res.json({
      id: program.id,
      title: program.title,
      churchName: program.church_name,
      churchLogo: program.church_logo,
      date: program.date,
      startTime: program.start_time,
      endTime: program.end_time,
      trackingMode: program.tracking_mode,
      dataFields: program.data_fields,
      dataFieldConfig: normalizeFieldConfig(program.data_field_config || {}),
      customFormSchema: normalizeCustomFieldSchema(program.custom_form_schema || []),
      giftingEnabled: program.gifting_enabled,
      totalWinners: program.total_winners,
      winnersSelected: program.winners_selected,
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
      sponsorDisplayMode: program.sponsor_display_mode || 'carousel',
      proxyCheckinEnabled: program.proxy_checkin_enabled || false,
      strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
      fastTrackRsvpEnabled: program.tracking_mode === 'collect-data' && linkedPreEventResult.rows.length > 0,
      isActive: program.is_active
    });
  } catch (error) {
    console.error('Get program info error:', error);
    return res.status(500).json({ error: 'Server error' });
  }
};

// Submit form data only (scan already recorded)
exports.submitFormData = async (req, res) => {
  const client = await pool.connect();

  try {
    const { programId } = req.params;
    const { deviceFingerprint, formData } = req.body;

    await client.query('BEGIN');

    const programResult = await client.query(
      'SELECT * FROM programs WHERE id = $1',
      [programId]
    );

    if (programResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programResult.rows[0];

    if (!program.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This program is no longer active' });
    }

    const dataFields = program.data_fields || {};

    const session = await verifyScanSession(client, programId, getScanSessionId(req), deviceFingerprint, getScanSessionToken(req));
    if (session.error) {
      await client.query('ROLLBACK');
      return res.status(session.status).json({ error: session.error });
    }

    const attendeeCheck = await client.query(
      'SELECT id FROM attendees WHERE scan_id = $1',
      [session.scan.id]
    );

    if (attendeeCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Form already submitted for this scan' });
    }

    const errors = {};
    if (dataFields.emailAddress) {
      if (!normalizeCollectedEmail(formData.emailAddress)) errors.emailAddress = 'Email address is required';
      else if (!isValidCollectedEmail(formData.emailAddress)) errors.emailAddress = 'Enter a valid email address';
    }
    if (dataFields.school && !cleanText(formData.school)) errors.school = 'School is required';
    if (dataFields.link && !normalizeUrlField(formData.linkUrl || formData.link)) errors.linkUrl = 'Enter a valid link starting with http:// or https://';
    if (dataFields.textarea && !cleanText(formData.textareaResponse)) errors.textareaResponse = 'Response is required';
    const customValidation = validateCustomResponses(program.custom_form_schema || [], formData.customResponses || {});
    Object.assign(errors, customValidation.errors);

    if (Object.keys(errors).length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please complete the required attendee fields', errors });
    }

    let isWinner = false;
    const personalizedMessage = selectPersonalizedMessage(program, formData);
    const emailAddress = dataFields.emailAddress ? normalizeCollectedEmail(formData.emailAddress) : null;
    const school = dataFields.school ? cleanText(formData.school) : null;
    const linkUrl = dataFields.link ? normalizeUrlField(formData.linkUrl || formData.link) : null;
    const textareaResponse = dataFields.textarea ? cleanText(formData.textareaResponse).slice(0, 5000) : null;

    if (program.gifting_enabled && program.winners_selected < program.total_winners) {
      isWinner = Math.random() > 0.5;

      if (isWinner) {
        await client.query(
          'UPDATE programs SET winners_selected = winners_selected + 1 WHERE id = $1',
          [programId]
        );
      }
    }

    await client.query(
      `INSERT INTO attendees
       (program_id, full_name, email_address, school, link_url, textarea_response, phone_number, address, first_timer, department, fellowship, age, sex, is_winner, device_fingerprint, scan_id, personalized_message, status, registration_type, checked_in_at, attendance_mode, custom_responses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'checked_in', 'walk_in', CURRENT_TIMESTAMP, 'physical', $18::jsonb)`,
      [
        programId,
        formData.fullName || null,
        emailAddress,
        school,
        linkUrl,
        textareaResponse,
        formData.phoneNumber || null,
        formData.address || null,
        formData.firstTimer || false,
        formData.department || null,
        formData.fellowship || null,
        formData.age || null,
        formData.sex || null,
        isWinner,
        session.deviceFingerprint,
        session.scan.id,
        personalizedMessage,
        JSON.stringify(customValidation.values)
      ]
    );

    await client.query('COMMIT');

    const [attendeeStats, sharedDeviceCheckins] = await Promise.all([
      pool.query(
        `SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN sex = 'Male' THEN 1 END) as male_count,
          COUNT(CASE WHEN sex = 'Female' THEN 1 END) as female_count,
          COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
         FROM attendees WHERE program_id = $1`,
        [programId]
      ),
      getSharedDeviceCheckins(pool, programId)
    ]);

    const io = req.app.get('io');
    io.emit(`program-${programId}-update`, {
      attendeeMaleCount: parseInt(attendeeStats.rows[0].male_count, 10),
      attendeeFemaleCount: parseInt(attendeeStats.rows[0].female_count, 10),
      attendeeFirstTimerCount: parseInt(attendeeStats.rows[0].first_timer_count, 10),
      attendeeTotal: parseInt(attendeeStats.rows[0].total, 10),
      sharedDeviceCheckins,
      timestamp: new Date()
    });

    const sponsorPlacement = await buildSponsorPlacement(programId, program.sponsor_display_mode || 'carousel', session.deviceFingerprint);

    return res.json({
      success: true,
      isWinner,
      giftingEnabled: program.gifting_enabled,
      personalizedMessage,
      sharedDeviceCheckins,
      sponsorPlacement
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit form error:', error);
    if (error.code === '23505') {
      return res.status(400).json({ error: 'Form already submitted for this scan' });
    }
    return res.status(500).json({ error: 'Server error submitting form' });
  } finally {
    client.release();
  }
};

// Fast-track a pre-registered RSVP attendee into the live check-in table.
exports.submitFastTrackRsvp = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { programId } = req.params;
    const { deviceFingerprint } = req.body;
    const emailAddress = normalizeCollectedEmail(req.body.emailAddress);

    if (!isValidCollectedEmail(emailAddress)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const programResult = await client.query(
      'SELECT * FROM programs WHERE id = $1',
      [programId]
    );

    if (programResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programResult.rows[0];

    if (!program.is_active) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'This program is no longer active' });
    }

    if (program.tracking_mode !== 'collect-data') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Fast-track check-in is only available for collect-data programs' });
    }

    const session = await verifyScanSession(client, programId, getScanSessionId(req), deviceFingerprint, getScanSessionToken(req));
    if (session.error) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(session.status).json({ error: session.error });
    }

    const attendeeCheck = await client.query(
      'SELECT id FROM attendees WHERE scan_id = $1',
      [session.scan.id]
    );

    if (attendeeCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Check-in already completed for this scan' });
    }

    const rsvpResult = await client.query(
      `SELECT per.*
       FROM pre_event_rsvps per
       JOIN pre_events pe ON pe.id = per.pre_event_id
       WHERE pe.program_id = $1
         AND per.email_address = $2
       ORDER BY pe.event_date DESC, per.created_at DESC
       LIMIT 1
       FOR UPDATE OF per`,
      [programId, emailAddress]
    );

    if (rsvpResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({
        error: 'No pre-registration was found for this email. Please complete the full check-in form.',
        fastTrackNotFound: true
      });
    }

    const rsvp = rsvpResult.rows[0];

    if (rsvp.status === 'checked_in') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({
        error: 'This RSVP has already checked in.',
        alreadyCheckedIn: true
      });
    }

    const existingRsvpAttendee = await client.query(
      'SELECT id FROM attendees WHERE pre_event_rsvp_id = $1 LIMIT 1',
      [rsvp.id]
    );

    if (existingRsvpAttendee.rows.length > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({
        error: 'This RSVP has already checked in.',
        alreadyCheckedIn: true
      });
    }

    const attendeeFormData = {
      fullName: rsvp.full_name || '',
      emailAddress: rsvp.email_address || '',
      school: rsvp.school || '',
      linkUrl: rsvp.link_url || '',
      textareaResponse: rsvp.textarea_response || '',
      customResponses: rsvp.custom_answers || {},
      phoneNumber: rsvp.phone_number || '',
      address: rsvp.address || '',
      firstTimer: Boolean(rsvp.first_timer),
      department: rsvp.department || '',
      fellowship: rsvp.fellowship || '',
      age: rsvp.age || '',
      sex: rsvp.sex || ''
    };
    const personalizedMessage = selectPersonalizedMessage(program, attendeeFormData);
    const checkedInAt = new Date();

    await client.query(
      `UPDATE scans
       SET gender = $1,
           first_timer = $2
       WHERE id = $3 AND program_id = $4`,
      [
        rsvp.sex ? String(rsvp.sex).toLowerCase() : null,
        Boolean(rsvp.first_timer),
        session.scan.id,
        programId
      ]
    );

    const attendeeResult = await client.query(
      `INSERT INTO attendees
       (program_id, full_name, email_address, school, link_url, textarea_response, phone_number, address, first_timer,
        department, fellowship, age, sex, is_winner, device_fingerprint, scan_id,
        personalized_message, pre_event_rsvp_id, status, registration_type, checked_in_at, attendance_mode, custom_responses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, $14, $15, $16, $17, 'checked_in', 'rsvp', $18, $19, $20::jsonb)
       RETURNING *`,
      [
        programId,
        cleanText(rsvp.full_name) || null,
        emailAddress,
        cleanText(rsvp.school) || null,
        cleanText(rsvp.link_url) || null,
        cleanText(rsvp.textarea_response).slice(0, 5000) || null,
        cleanText(rsvp.phone_number) || null,
        cleanText(rsvp.address) || null,
        Boolean(rsvp.first_timer),
        cleanText(rsvp.department) || null,
        cleanText(rsvp.fellowship) || null,
        rsvp.age || null,
        cleanText(rsvp.sex) || null,
        session.deviceFingerprint,
        session.scan.id,
        personalizedMessage,
        rsvp.id,
        checkedInAt,
        rsvp.attendance_mode || 'physical',
        JSON.stringify(rsvp.custom_answers || {})
      ]
    );

    await client.query(
      `UPDATE pre_event_rsvps
       SET status = 'checked_in',
           checked_in_at = $1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $2`,
      [checkedInAt, rsvp.id]
    );

    const attendeeStats = await buildAttendeeStats(client, programId);
    const sharedDeviceCheckins = await getSharedDeviceCheckins(client, programId);

    await client.query('COMMIT');
    transactionStarted = false;

    const io = req.app.get('io');
    io?.emit(`program-${programId}-update`, {
      ...attendeeStats,
      sharedDeviceCheckins,
      timestamp: new Date()
    });

    const sponsorPlacement = await buildSponsorPlacement(programId, program.sponsor_display_mode || 'carousel', session.deviceFingerprint);

    return res.status(201).json({
      success: true,
      fastTrack: true,
      attendee: mapFastTrackAttendee(attendeeResult.rows[0]),
      isWinner: false,
      giftingEnabled: false,
      personalizedMessage,
      sharedDeviceCheckins,
      sponsorPlacement
    });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    console.error('Fast-track RSVP check-in error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This RSVP has already checked in.', alreadyCheckedIn: true });
    }
    return res.status(500).json({ error: 'Server error completing fast-track check-in' });
  } finally {
    client.release();
  }
};

// Submit a proxy attendee from an already checked-in host device.
exports.submitProxyAttendee = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { programId } = req.params;
    const hostDeviceFingerprint = normalizeDeviceFingerprint(req.body.hostDeviceFingerprint);
    const formData = req.body.formData || {};

    if (!hostDeviceFingerprint) {
      return res.status(400).json({ error: 'A valid host device fingerprint is required' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const programResult = await client.query(
      'SELECT * FROM programs WHERE id = $1',
      [programId]
    );

    if (programResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programResult.rows[0];
    const dataFields = program.data_fields || {};

    if (!program.is_active) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'This program is no longer active' });
    }

    if (program.tracking_mode !== 'collect-data' || !program.proxy_checkin_enabled) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Proxy check-in is not enabled for this program' });
    }

    const hostAttendeeResult = await client.query(
      `SELECT id FROM attendees
       WHERE program_id = $1 AND device_fingerprint = $2 AND proxy_host_fingerprint IS NULL
       LIMIT 1`,
      [programId, hostDeviceFingerprint]
    );

    if (hostAttendeeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(403).json({ error: 'Host attendee must complete check-in before adding guests' });
    }

    const proxyCountResult = await client.query(
      'SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND proxy_host_fingerprint = $2',
      [programId, hostDeviceFingerprint]
    );
    const proxyCount = parseInt(proxyCountResult.rows[0].count, 10);

    if (proxyCount >= 3) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Proxy check-in limit reached', proxyCount, remaining: 0 });
    }

    const cleanText = (value) => (typeof value === 'string' ? value.trim() : '');
    const errors = {};

    if (dataFields.fullName && !cleanText(formData.fullName)) errors.fullName = 'Full name is required';
    if (dataFields.emailAddress) {
      if (!normalizeCollectedEmail(formData.emailAddress)) errors.emailAddress = 'Email address is required';
      else if (!isValidCollectedEmail(formData.emailAddress)) errors.emailAddress = 'Enter a valid email address';
    }
    if (dataFields.school && !cleanText(formData.school)) errors.school = 'School is required';
    if (dataFields.link && !normalizeUrlField(formData.linkUrl || formData.link)) errors.linkUrl = 'Enter a valid link starting with http:// or https://';
    if (dataFields.textarea && !cleanText(formData.textareaResponse)) errors.textareaResponse = 'Response is required';
    if (dataFields.phoneNumber && !cleanText(formData.phoneNumber)) errors.phoneNumber = 'Phone number is required';
    if (dataFields.address && !cleanText(formData.address)) errors.address = 'Address is required';
    if (dataFields.department && !cleanText(formData.department)) errors.department = 'Department is required';
    if (dataFields.sex && !cleanText(formData.sex)) errors.sex = 'Please select gender';

    const customValidation = validateCustomResponses(program.custom_form_schema || [], formData.customResponses || {});
    Object.assign(errors, customValidation.errors);

    const age = formData.age === '' || formData.age === null || formData.age === undefined
      ? null
      : Number(formData.age);

    if (dataFields.age && age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) {
      errors.age = 'Age must be a valid number';
    }

    if (Object.keys(errors).length > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Please complete the required attendee fields', errors });
    }

    const proxyDeviceFingerprint = `proxy-${programId}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const firstTimer = Boolean(formData.firstTimer);
    const sex = cleanText(formData.sex) || null;
    const emailAddress = dataFields.emailAddress ? normalizeCollectedEmail(formData.emailAddress) : null;
    const school = dataFields.school ? cleanText(formData.school) : null;
    const linkUrl = dataFields.link ? normalizeUrlField(formData.linkUrl || formData.link) : null;
    const textareaResponse = dataFields.textarea ? cleanText(formData.textareaResponse).slice(0, 5000) : null;

    const scanResult = await client.query(
      `INSERT INTO scans
       (program_id, device_fingerprint, gender, first_timer, proxy_host_fingerprint)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [programId, proxyDeviceFingerprint, sex ? sex.toLowerCase() : null, firstTimer, hostDeviceFingerprint]
    );

    const updatedProgram = await client.query(
      'UPDATE programs SET total_scans = total_scans + 1 WHERE id = $1 RETURNING total_scans',
      [programId]
    );

    const attendeeResult = await client.query(
      `INSERT INTO attendees
       (program_id, full_name, email_address, school, link_url, textarea_response, phone_number, address, first_timer, department, fellowship, age, sex, is_winner, device_fingerprint, proxy_host_fingerprint, scan_id, status, registration_type, checked_in_at, attendance_mode, custom_responses)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, $14, $15, $16, 'checked_in', 'proxy', CURRENT_TIMESTAMP, 'physical', $17::jsonb)
       RETURNING *`,
      [
        programId,
        cleanText(formData.fullName) || null,
        emailAddress,
        school,
        linkUrl,
        textareaResponse,
        cleanText(formData.phoneNumber) || null,
        cleanText(formData.address) || null,
        firstTimer,
        cleanText(formData.department) || null,
        cleanText(formData.fellowship) || null,
        age,
        sex,
        proxyDeviceFingerprint,
        hostDeviceFingerprint,
        scanResult.rows[0].id,
        JSON.stringify(customValidation.values)
      ]
    );

    const attendeeStats = await client.query(
      `SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN sex = 'Male' THEN 1 END) as male_count,
        COUNT(CASE WHEN sex = 'Female' THEN 1 END) as female_count,
        COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
       FROM attendees WHERE program_id = $1`,
      [programId]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    const totalScans = parseInt(updatedProgram.rows[0].total_scans, 10);
    const savedProxyCount = proxyCount + 1;
    const stats = {
      attendeeMaleCount: parseInt(attendeeStats.rows[0].male_count, 10),
      attendeeFemaleCount: parseInt(attendeeStats.rows[0].female_count, 10),
      attendeeFirstTimerCount: parseInt(attendeeStats.rows[0].first_timer_count, 10),
      attendeeTotal: parseInt(attendeeStats.rows[0].total, 10)
    };

    const io = req.app.get('io');
    io?.emit(`program-${programId}-update`, {
      totalScans,
      ...stats,
      timestamp: new Date()
    });

    return res.status(201).json({
      success: true,
      attendee: {
        id: attendeeResult.rows[0].id,
        fullName: attendeeResult.rows[0].full_name,
        proxyHostFingerprint: attendeeResult.rows[0].proxy_host_fingerprint
      },
      proxyCount: savedProxyCount,
      remaining: Math.max(0, 3 - savedProxyCount),
      totalScans,
      ...stats
    });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    console.error('Proxy check-in error:', error);
    return res.status(500).json({ error: 'Server error adding proxy attendee' });
  } finally {
    client.release();
  }
};

// Update existing scan with gender and first-timer data
exports.updateScanData = async (req, res) => {
  const client = await pool.connect();

  try {
    const { programId } = req.params;
    const { deviceFingerprint, gender, firstTimer } = req.body;

    const session = await verifyScanSession(client, programId, getScanSessionId(req), deviceFingerprint, getScanSessionToken(req));
    if (session.error) {
      return res.status(session.status).json({ error: session.error });
    }

    const result = await client.query(
      `UPDATE scans 
       SET gender = $1, first_timer = $2 
       WHERE id = $3 AND program_id = $4
       RETURNING *`,
      [gender, Boolean(firstTimer), session.scan.id, programId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Scan not found' });
    }

    const countStats = await getCountStats(programId);

    const io = req.app.get('io');
    io.emit(`program-${programId}-update`, {
      ...countStats,
      timestamp: new Date()
    });

    return res.json({
      success: true,
      message: 'Scan data updated successfully'
    });
  } catch (error) {
    console.error('Update scan error:', error);
    return res.status(500).json({ error: 'Server error updating scan data' });
  } finally {
    client.release();
  }
};

// Track a sponsor click from the public post-check-in experience
exports.trackSponsorClick = async (req, res) => {
  const client = await pool.connect();

  try {
    const { sponsorId } = req.params;
    const { deviceFingerprint } = req.body || {};

    await client.query('BEGIN');

    const sponsorResult = await client.query(
      `UPDATE event_sponsors
       SET click_count = click_count + 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND is_active = true
       RETURNING id, program_id, campaign_tag, click_count`,
      [sponsorId]
    );

    if (sponsorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sponsor not found' });
    }

    const sponsor = sponsorResult.rows[0];

    await client.query(
      `INSERT INTO sponsor_click_events
       (sponsor_id, program_id, campaign_tag, device_fingerprint_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        sponsor.id,
        sponsor.program_id,
        sponsor.campaign_tag,
        hashDeviceFingerprintForAnalytics(deviceFingerprint)
      ]
    );

    await client.query('COMMIT');

    return res.json({
      success: true,
      clickCount: parseInt(sponsor.click_count, 10)
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Track sponsor click error:', error);
    return res.status(500).json({ error: 'Server error tracking sponsor click' });
  } finally {
    client.release();
  }
};

// Get scan records for a program (for count-only table)
exports.getScansForProgram = async (req, res) => {
  try {
    const { programId } = req.params;

    const programCheck = await pool.query(
      'SELECT id FROM programs WHERE id = $1 AND church_id = $2',
      [programId, req.churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const result = await pool.query(
      `SELECT id, gender, first_timer, scan_time 
       FROM scans 
       WHERE program_id = $1 
       ORDER BY scan_time DESC`,
      [programId]
    );

    return res.json({
      scans: result.rows.map(scan => ({
        id: scan.id,
        gender: scan.gender,
        firstTimer: scan.first_timer,
        scanTime: scan.scan_time
      }))
    });
  } catch (error) {
    console.error('Get scans error:', error);
    return res.status(500).json({ error: 'Server error fetching scans' });
  }
};
