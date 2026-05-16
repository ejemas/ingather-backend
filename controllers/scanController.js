const crypto = require('crypto');
const pool = require('../config/database');

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

const getScanSessionToken = (req) => {
  return req.body?.scanSessionToken || req.get('x-scan-session-token');
};

const verifyScanSession = async (client, programId, deviceFingerprint, token) => {
  const normalizedFingerprint = normalizeDeviceFingerprint(deviceFingerprint);

  if (!normalizedFingerprint || !token) {
    return { status: 401, error: 'Valid scan session is required.' };
  }

  const scanResult = await client.query(
    'SELECT * FROM scans WHERE program_id = $1 AND device_fingerprint = $2',
    [programId, normalizedFingerprint]
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
      'SELECT id, tracking_mode, is_active FROM programs WHERE id = $1',
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

    const scanInsert = await client.query(
      `INSERT INTO scans 
       (program_id, device_fingerprint, gender, first_timer, scan_token_hash, scan_token_expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (program_id, device_fingerprint) DO NOTHING
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

    if (scanInsert.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({
        error: 'This device has already scanned this program',
        alreadyScanned: true
      });
    }

    const updatedProgram = await client.query(
      'UPDATE programs SET total_scans = total_scans + 1 WHERE id = $1 RETURNING total_scans',
      [programId]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    const totalScans = updatedProgram.rows[0].total_scans;
    res.json({
      success: true,
      trackingMode: program.tracking_mode,
      totalScans,
      firstScan: true,
      isFirstTimer: req.body.firstTimer || false,
      scanSessionToken,
      scanSessionExpiresAt: tokenExpiresAt
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
      giftingEnabled: program.gifting_enabled,
      totalWinners: program.total_winners,
      winnersSelected: program.winners_selected,
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
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

    const session = await verifyScanSession(client, programId, deviceFingerprint, getScanSessionToken(req));
    if (session.error) {
      await client.query('ROLLBACK');
      return res.status(session.status).json({ error: session.error });
    }

    const attendeeCheck = await client.query(
      'SELECT id FROM attendees WHERE program_id = $1 AND device_fingerprint = $2',
      [programId, session.deviceFingerprint]
    );

    if (attendeeCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Form already submitted for this scan' });
    }

    let isWinner = false;

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
       (program_id, full_name, phone_number, address, first_timer, department, fellowship, age, sex, is_winner, device_fingerprint) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        programId,
        formData.fullName || null,
        formData.phoneNumber || null,
        formData.address || null,
        formData.firstTimer || false,
        formData.department || null,
        formData.fellowship || null,
        formData.age || null,
        formData.sex || null,
        isWinner,
        session.deviceFingerprint
      ]
    );

    await client.query('COMMIT');

    const attendeeStats = await pool.query(
      `SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN sex = 'Male' THEN 1 END) as male_count,
        COUNT(CASE WHEN sex = 'Female' THEN 1 END) as female_count,
        COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
       FROM attendees WHERE program_id = $1`,
      [programId]
    );

    const io = req.app.get('io');
    io.emit(`program-${programId}-update`, {
      attendeeMaleCount: parseInt(attendeeStats.rows[0].male_count, 10),
      attendeeFemaleCount: parseInt(attendeeStats.rows[0].female_count, 10),
      attendeeFirstTimerCount: parseInt(attendeeStats.rows[0].first_timer_count, 10),
      attendeeTotal: parseInt(attendeeStats.rows[0].total, 10),
      timestamp: new Date()
    });

    return res.json({
      success: true,
      isWinner,
      giftingEnabled: program.gifting_enabled
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit form error:', error);
    return res.status(500).json({ error: 'Server error submitting form' });
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

    const session = await verifyScanSession(client, programId, deviceFingerprint, getScanSessionToken(req));
    if (session.error) {
      return res.status(session.status).json({ error: session.error });
    }

    const result = await client.query(
      `UPDATE scans 
       SET gender = $1, first_timer = $2 
       WHERE program_id = $3 AND device_fingerprint = $4
       RETURNING *`,
      [gender, Boolean(firstTimer), programId, session.deviceFingerprint]
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
