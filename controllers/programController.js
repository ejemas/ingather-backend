const pool = require('../config/database');
const QRCode = require('qrcode');
const { uploadEventFlyer, deleteEventFlyer } = require('../utils/supabaseStorage');

const normalizeFlyerType = (flyerType) => (
  flyerType === 'personalized' ? 'personalized' : 'standard'
);

const normalizePersonalizedFlyerConfig = (config = {}) => {
  const template = typeof config.template === 'string' ? config.template.trim() : '';

  return {
    template,
    brandColor: typeof config.brandColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(config.brandColor)
      ? config.brandColor
      : '#E8590C',
    textColor: typeof config.textColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(config.textColor)
      ? config.textColor
      : '#FFFFFF',
    accentColor: typeof config.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(config.accentColor)
      ? config.accentColor
      : '#FFB86B'
  };
};

const mapChurch = (church) => ({
  id: church.id,
  churchName: church.church_name,
  branchName: church.branch_name,
  email: church.email,
  location: church.location,
  logoUrl: church.logo_url,
  organizationType: church.organization_type || null,
  createdAt: church.created_at
});

const mapProgramDetail = (program, counts = {}) => ({
  id: program.id,
  title: program.title,
  date: program.date,
  startTime: program.start_time,
  endTime: program.end_time,
  trackingMode: program.tracking_mode,
  dataFields: program.data_fields,
  giftingEnabled: program.gifting_enabled,
  totalWinners: program.total_winners,
  winnersSelected: program.winners_selected,
  winnersGifted: counts.winnersGifted || 0,
  flyerType: program.flyer_type || 'standard',
  personalizedFlyerConfig: program.personalized_flyer_config,
  personalizedBackgroundUrl: program.personalized_background_url,
  personalizedLogoUrl: program.personalized_logo_url,
  flyerUrl: program.flyer_url,
  qrCodeUrl: program.qr_code_url,
  isActive: program.is_active,
  totalScans: program.total_scans,
  attendeesCount: counts.attendeesCount || 0,
  firstTimersCount: counts.firstTimersCount || 0
});

const mapAttendee = (attendee) => ({
  id: attendee.id,
  fullName: attendee.full_name,
  phoneNumber: attendee.phone_number,
  address: attendee.address,
  firstTimer: attendee.first_timer,
  department: attendee.department,
  fellowship: attendee.fellowship,
  age: attendee.age,
  sex: attendee.sex,
  isWinner: attendee.is_winner,
  isGifted: attendee.is_gifted || false,
  scanTime: attendee.scan_time
});

const mapScan = (scan) => ({
  id: scan.id,
  gender: scan.gender,
  firstTimer: scan.first_timer,
  scanTime: scan.scan_time
});

const formatProgramTime = (time) => {
  const str = typeof time === 'string' ? time : time.toString();
  const parts = str.split(':');
  return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
};

const getChurchProfile = async (churchId) => {
  const result = await pool.query(
    'SELECT id, church_name, branch_name, email, location, logo_url, organization_type, created_at FROM churches WHERE id = $1',
    [churchId]
  );

  return result.rows.length > 0 ? mapChurch(result.rows[0]) : null;
};

const getUnreadCountForChurch = async (churchId) => {
  const result = await pool.query(
    `SELECT COUNT(*) AS unread
     FROM notifications n
     WHERE NOT EXISTS (
       SELECT 1 FROM notification_reads nr
       WHERE nr.notification_id = n.id AND nr.church_id = $1
     )`,
    [churchId]
  );

  return parseInt(result.rows[0].unread, 10);
};

const buildDashboardStatsPayload = async (churchId, startDate, endDate) => {
  let dateFilter = '';
  const params = [churchId];
  let paramIndex = 2;

  if (startDate && endDate) {
    dateFilter = ` AND p.date >= $${paramIndex}::date AND p.date <= $${paramIndex + 1}::date`;
    params.push(startDate, endDate);
    paramIndex += 2;
  } else if (startDate) {
    dateFilter = ` AND p.date >= $${paramIndex}::date`;
    params.push(startDate);
    paramIndex += 1;
  } else if (endDate) {
    dateFilter = ` AND p.date <= $${paramIndex}::date`;
    params.push(endDate);
    paramIndex += 1;
  }

  const today = new Date().toISOString().split('T')[0];
  const upcomingParams = [churchId, today];
  let upcomingDateFilter = '';
  let upcomingParamIndex = 3;

  if (startDate && endDate) {
    upcomingDateFilter = ` AND p.date >= $${upcomingParamIndex}::date AND p.date <= $${upcomingParamIndex + 1}::date`;
    upcomingParams.push(startDate, endDate);
  } else if (endDate) {
    upcomingDateFilter = ` AND p.date <= $${upcomingParamIndex}::date`;
    upcomingParams.push(endDate);
  }

  const [
    summaryResult,
    upcomingResult,
    scanStatsResult,
    attendeeStatsResult,
    chartResult,
    programsResult
  ] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) as total_programs, COALESCE(SUM(total_scans), 0) as total_attendance
       FROM programs p
       WHERE p.church_id = $1${dateFilter}`,
      params
    ),
    pool.query(
      `SELECT COUNT(*) as upcoming_count
       FROM programs p
       WHERE p.church_id = $1 AND p.date > $2 AND p.is_active = true${upcomingDateFilter}`,
      upcomingParams
    ),
    pool.query(
      `SELECT
        COUNT(CASE WHEN s.gender = 'male' THEN 1 END) as male_count,
        COUNT(CASE WHEN s.gender = 'female' THEN 1 END) as female_count,
        COUNT(CASE WHEN s.first_timer = true THEN 1 END) as first_timer_count,
        COUNT(*) as total_scans_with_data
       FROM scans s
       JOIN programs p ON s.program_id = p.id
       WHERE p.church_id = $1${dateFilter}`,
      params
    ),
    pool.query(
      `SELECT
        COUNT(CASE WHEN a.sex = 'Male' THEN 1 END) as male_count,
        COUNT(CASE WHEN a.sex = 'Female' THEN 1 END) as female_count,
        COUNT(CASE WHEN a.first_timer = true THEN 1 END) as first_timer_count,
        COUNT(*) as total_attendees
       FROM attendees a
       JOIN programs p ON a.program_id = p.id
       WHERE p.church_id = $1${dateFilter}`,
      params
    ),
    pool.query(
      `SELECT p.date,
              SUM(p.total_scans) AS daily_attendance,
              COUNT(*) AS program_count
       FROM programs p
       WHERE p.church_id = $1${dateFilter}
       GROUP BY p.date
       ORDER BY p.date ASC`,
      params
    ),
    pool.query(
      `SELECT * FROM programs p
       WHERE p.church_id = $1${dateFilter}
       ORDER BY p.date DESC, p.start_time DESC`,
      params
    )
  ]);

  const totalMale = parseInt(scanStatsResult.rows[0].male_count, 10) + parseInt(attendeeStatsResult.rows[0].male_count, 10);
  const totalFemale = parseInt(scanStatsResult.rows[0].female_count, 10) + parseInt(attendeeStatsResult.rows[0].female_count, 10);
  const totalFirstTimer = parseInt(scanStatsResult.rows[0].first_timer_count, 10) + parseInt(attendeeStatsResult.rows[0].first_timer_count, 10);
  const totalPeople = totalMale + totalFemale + totalFirstTimer;

  return {
    totalPrograms: parseInt(summaryResult.rows[0].total_programs, 10),
    totalAttendance: parseInt(summaryResult.rows[0].total_attendance, 10),
    upcomingPrograms: parseInt(upcomingResult.rows[0].upcoming_count, 10),
    genderBreakdown: {
      femalePercent: totalPeople > 0 ? Math.round((totalFemale / totalPeople) * 100) : 0,
      malePercent: totalPeople > 0 ? Math.round((totalMale / totalPeople) * 100) : 0,
      firstTimerPercent: totalPeople > 0 ? Math.round((totalFirstTimer / totalPeople) * 100) : 0,
      femaleCount: totalFemale,
      maleCount: totalMale,
      firstTimerCount: totalFirstTimer
    },
    attendanceOvertime: chartResult.rows.map(row => {
      const date = new Date(row.date + 'T00:00:00');
      return {
        name: `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${date.getDate()}`,
        date: row.date,
        attendance: parseInt(row.daily_attendance, 10) || 0,
        programCount: parseInt(row.program_count, 10)
      };
    }),
    recentPrograms: programsResult.rows.map(program => ({
      id: program.id,
      title: program.title,
      date: program.date,
      startTime: program.start_time,
      endTime: program.end_time,
      trackingMode: program.tracking_mode,
      totalScans: program.total_scans,
      isActive: program.is_active,
      giftingEnabled: program.gifting_enabled,
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
      createdAt: program.created_at
    }))
  };
};

const buildAttendanceOverTimePayload = async (programId, program) => {
  const [bucketResult, rangeResult] = await Promise.all([
    pool.query(
      `SELECT
        to_char(scan_time, 'HH24') || ':' ||
        CASE
          WHEN EXTRACT(MINUTE FROM scan_time) < 30 THEN '00'
          ELSE '30'
        END AS time_bucket,
        COUNT(*) AS count
      FROM scans
      WHERE program_id = $1
      GROUP BY 1
      ORDER BY 1`,
      [programId]
    ),
    pool.query(
      `SELECT
        to_char(MIN(scan_time), 'HH24') || ':' ||
        CASE
          WHEN EXTRACT(MINUTE FROM MIN(scan_time)) < 30 THEN '00'
          ELSE '30'
        END AS min_bucket,
        to_char(MAX(scan_time), 'HH24') || ':' ||
        CASE
          WHEN EXTRACT(MINUTE FROM MAX(scan_time)) < 30 THEN '00'
          ELSE '30'
        END AS max_bucket
      FROM scans
      WHERE program_id = $1`,
      [programId]
    )
  ]);

  return {
    buckets: bucketResult.rows.map(row => ({
      time: row.time_bucket,
      scans: parseInt(row.count, 10)
    })),
    startTime: formatProgramTime(program.start_time),
    endTime: formatProgramTime(program.end_time),
    scanRangeStart: rangeResult.rows[0].min_bucket || null,
    scanRangeEnd: rangeResult.rows[0].max_bucket || null
  };
};

const buildCountOnlyStatsPayload = async (programId) => {
  const result = await pool.query(
    `SELECT
      COUNT(CASE WHEN gender = 'male' THEN 1 END) as male_count,
      COUNT(CASE WHEN gender = 'female' THEN 1 END) as female_count,
      COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
     FROM scans
     WHERE program_id = $1`,
    [programId]
  );

  return {
    maleCount: parseInt(result.rows[0].male_count, 10),
    femaleCount: parseInt(result.rows[0].female_count, 10),
    firstTimerCount: parseInt(result.rows[0].first_timer_count, 10)
  };
};

// Create Program
exports.createProgram = async (req, res) => {
  try {
    const {
      programTitle,
      date,
      startTime,
      endTime,
      trackingMode,
      dataFields,
      enableGifting,
      numberOfWinners,
      eventFlyer,
      flyerType: requestedFlyerType,
      personalizedFlyerConfig,
      personalizedBackground,
      personalizedLogo
    } = req.body;

    const churchId = req.churchId;
    const flyerType = normalizeFlyerType(requestedFlyerType);
    const resolvedDataFields = { ...(dataFields || {}) };
    const resolvedTrackingMode = flyerType === 'personalized' ? 'collect-data' : trackingMode;
    const resolvedPersonalizedConfig = normalizePersonalizedFlyerConfig(personalizedFlyerConfig);
    let uploadedFlyer = null;
    let uploadedPersonalizedBackground = null;
    let uploadedPersonalizedLogo = null;

    if (flyerType === 'personalized') {
      resolvedDataFields.fullName = true;

      if (!resolvedPersonalizedConfig.template) {
        return res.status(400).json({ error: 'Personalized flyer message is required' });
      }
    }

    if (flyerType === 'standard' && eventFlyer?.dataUrl) {
      uploadedFlyer = await uploadEventFlyer({
        churchId,
        dataUrl: eventFlyer.dataUrl
      });
    }

    if (flyerType === 'personalized' && personalizedBackground?.dataUrl) {
      uploadedPersonalizedBackground = await uploadEventFlyer({
        churchId,
        dataUrl: personalizedBackground.dataUrl
      });
    }

    if (flyerType === 'personalized' && personalizedLogo?.dataUrl) {
      uploadedPersonalizedLogo = await uploadEventFlyer({
        churchId,
        dataUrl: personalizedLogo.dataUrl
      });
    }

    const personalizedConfigForStorage = flyerType === 'personalized'
      ? {
          ...resolvedPersonalizedConfig,
          backgroundUrl: uploadedPersonalizedBackground?.flyerUrl || null,
          logoUrl: uploadedPersonalizedLogo?.flyerUrl || null
        }
      : null;

    // Insert program
    let result;
    try {
      result = await pool.query(
        `INSERT INTO programs 
         (church_id, title, date, start_time, end_time, tracking_mode, data_fields, gifting_enabled, total_winners, flyer_type, flyer_url, flyer_storage_path, flyer_original_name, personalized_flyer_config, personalized_background_url, personalized_background_storage_path, personalized_background_original_name, personalized_logo_url, personalized_logo_storage_path, personalized_logo_original_name) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20) 
         RETURNING *`,
        [
          churchId,
          programTitle,
          date,
          startTime,
          endTime,
          resolvedTrackingMode,
          JSON.stringify(resolvedDataFields),
          enableGifting || false,
          numberOfWinners || 0,
          flyerType,
          uploadedFlyer?.flyerUrl || null,
          uploadedFlyer?.flyerStoragePath || null,
          eventFlyer?.originalName || null,
          personalizedConfigForStorage ? JSON.stringify(personalizedConfigForStorage) : null,
          uploadedPersonalizedBackground?.flyerUrl || null,
          uploadedPersonalizedBackground?.flyerStoragePath || null,
          personalizedBackground?.originalName || null,
          uploadedPersonalizedLogo?.flyerUrl || null,
          uploadedPersonalizedLogo?.flyerStoragePath || null,
          personalizedLogo?.originalName || null
        ]
      );
    } catch (error) {
      if (uploadedFlyer?.flyerStoragePath) {
        deleteEventFlyer(uploadedFlyer.flyerStoragePath).catch(deleteError => {
          console.error('Flyer cleanup warning:', deleteError.message);
        });
      }
      if (uploadedPersonalizedBackground?.flyerStoragePath) {
        deleteEventFlyer(uploadedPersonalizedBackground.flyerStoragePath).catch(deleteError => {
          console.error('Personalized flyer cleanup warning:', deleteError.message);
        });
      }
      if (uploadedPersonalizedLogo?.flyerStoragePath) {
        deleteEventFlyer(uploadedPersonalizedLogo.flyerStoragePath).catch(deleteError => {
          console.error('Personalized logo cleanup warning:', deleteError.message);
        });
      }
      throw error;
    }

    const program = result.rows[0];

    // Generate QR Code URL
    const qrCodeUrl = `${process.env.FRONTEND_URL}/scan/${program.id}`;

    // Update program with QR code URL
    await pool.query(
      'UPDATE programs SET qr_code_url = $1 WHERE id = $2',
      [qrCodeUrl, program.id]
    );

    // Generate QR code image as base64
    const qrCodeImage = await QRCode.toDataURL(qrCodeUrl);

    res.status(201).json({
      message: 'Program created successfully',
      program: {
        id: program.id,
        title: program.title,
        date: program.date,
        startTime: program.start_time,
        endTime: program.end_time,
        trackingMode: program.tracking_mode,
        dataFields: program.data_fields,
        giftingEnabled: program.gifting_enabled,
        totalWinners: program.total_winners,
        flyerType: program.flyer_type,
        personalizedFlyerConfig: program.personalized_flyer_config,
        personalizedBackgroundUrl: program.personalized_background_url,
        personalizedLogoUrl: program.personalized_logo_url,
        flyerUrl: program.flyer_url,
        qrCodeUrl: qrCodeUrl,
        qrCodeImage: qrCodeImage,
        isActive: program.is_active,
        totalScans: program.total_scans
      }
    });
  } catch (error) {
    console.error('Create program error:', error);
    const isFlyerError = error.message?.includes('flyer') || error.message?.includes('Flyer') || error.message?.includes('Supabase');
    res.status(isFlyerError ? 400 : 500).json({
      error: isFlyerError ? error.message : 'Server error creating program'
    });
  }
};

// Get all programs for a church
exports.getPrograms = async (req, res) => {
  try {
    const churchId = req.churchId;

    const result = await pool.query(
      `SELECT * FROM programs WHERE church_id = $1 ORDER BY date DESC, start_time DESC`,
      [churchId]
    );

    const programs = result.rows.map(program => ({
      id: program.id,
      title: program.title,
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
      qrCodeUrl: program.qr_code_url,
      isActive: program.is_active,
      totalScans: program.total_scans,
      createdAt: program.created_at
    }));

    res.json({ programs });
  } catch (error) {
    console.error('Get programs error:', error);
    res.status(500).json({ error: 'Server error fetching programs' });
  }
};

// Get dashboard bootstrap data in one request
exports.getDashboardBootstrap = async (req, res) => {
  try {
    const churchId = req.churchId;
    const { startDate, endDate } = req.query;

    const [church, unreadCount, stats] = await Promise.all([
      getChurchProfile(churchId),
      getUnreadCountForChurch(churchId),
      buildDashboardStatsPayload(churchId, startDate, endDate)
    ]);

    if (!church) {
      return res.status(404).json({ error: 'Church not found' });
    }

    return res.json({ church, unreadCount, stats });
  } catch (error) {
    console.error('Get dashboard bootstrap error:', error);
    return res.status(500).json({ error: 'Server error fetching dashboard bootstrap' });
  }
};

// Get single program details
exports.getProgramById = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    const result = await pool.query(
      'SELECT * FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = result.rows[0];

    // Get attendees count
    const attendeesResult = await pool.query(
      'SELECT COUNT(*) FROM attendees WHERE program_id = $1',
      [id]
    );

    // Get first timers count
    const firstTimersResult = await pool.query(
      'SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND first_timer = true',
      [id]
    );

    // Get winners gifted count
    const winnersGiftedResult = await pool.query(
      'SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND is_winner = true AND is_gifted = true',
      [id]
    );

    res.json({
      id: program.id,
      title: program.title,
      date: program.date,
      startTime: program.start_time,
      endTime: program.end_time,
      trackingMode: program.tracking_mode,
      dataFields: program.data_fields,
      giftingEnabled: program.gifting_enabled,
      totalWinners: program.total_winners,
      winnersSelected: program.winners_selected,
      winnersGifted: parseInt(winnersGiftedResult.rows[0].count),
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
      qrCodeUrl: program.qr_code_url,
      isActive: program.is_active,
      totalScans: program.total_scans,
      attendeesCount: parseInt(attendeesResult.rows[0].count),
      firstTimersCount: parseInt(firstTimersResult.rows[0].count)
    });
  } catch (error) {
    console.error('Get program error:', error);
    res.status(500).json({ error: 'Server error fetching program' });
  }
};

// Get program detail bootstrap data in one request
exports.getProgramDetailBootstrap = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    const [church, unreadCount, programResult] = await Promise.all([
      getChurchProfile(churchId),
      getUnreadCountForChurch(churchId),
      pool.query(
        'SELECT * FROM programs WHERE id = $1 AND church_id = $2',
        [id, churchId]
      )
    ]);

    if (!church) {
      return res.status(404).json({ error: 'Church not found' });
    }

    if (programResult.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programResult.rows[0];
    const isCountOnly = program.tracking_mode === 'count-only';

    const [
      attendeesCountResult,
      firstTimersResult,
      winnersGiftedResult,
      attendeesResult,
      attendanceData,
      countOnlyStats,
      countOnlyScansResult
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM attendees WHERE program_id = $1', [id]),
      pool.query('SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND first_timer = true', [id]),
      pool.query('SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND is_winner = true AND is_gifted = true', [id]),
      pool.query('SELECT * FROM attendees WHERE program_id = $1 ORDER BY scan_time DESC', [id]),
      buildAttendanceOverTimePayload(id, program),
      isCountOnly ? buildCountOnlyStatsPayload(id) : Promise.resolve(null),
      isCountOnly
        ? pool.query(
            `SELECT id, gender, first_timer, scan_time
             FROM scans
             WHERE program_id = $1
             ORDER BY scan_time DESC`,
            [id]
          )
        : Promise.resolve({ rows: [] })
    ]);

    return res.json({
      church,
      unreadCount,
      program: mapProgramDetail(program, {
        attendeesCount: parseInt(attendeesCountResult.rows[0].count, 10),
        firstTimersCount: parseInt(firstTimersResult.rows[0].count, 10),
        winnersGifted: parseInt(winnersGiftedResult.rows[0].count, 10)
      }),
      attendees: attendeesResult.rows.map(mapAttendee),
      attendanceData,
      countOnlyStats,
      countOnlyScans: countOnlyScansResult.rows.map(mapScan)
    });
  } catch (error) {
    console.error('Get program detail bootstrap error:', error);
    return res.status(500).json({ error: 'Server error fetching program detail bootstrap' });
  }
};

// Stop program (disable QR code)
exports.stopProgram = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    const result = await pool.query(
      'UPDATE programs SET is_active = false WHERE id = $1 AND church_id = $2 RETURNING *',
      [id, churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    res.json({ message: 'Program stopped successfully' });
  } catch (error) {
    console.error('Stop program error:', error);
    res.status(500).json({ error: 'Server error stopping program' });
  }
};

// Get attendees for a program
exports.getAttendees = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    // Verify program belongs to church
    const programCheck = await pool.query(
      'SELECT id FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const result = await pool.query(
      'SELECT * FROM attendees WHERE program_id = $1 ORDER BY scan_time DESC',
      [id]
    );

    const attendees = result.rows.map(attendee => ({
      id: attendee.id,
      fullName: attendee.full_name,
      phoneNumber: attendee.phone_number,
      address: attendee.address,
      firstTimer: attendee.first_timer,
      department: attendee.department,
      fellowship: attendee.fellowship,
      age: attendee.age,
      sex: attendee.sex,
      isWinner: attendee.is_winner,
      isGifted: attendee.is_gifted || false,
      scanTime: attendee.scan_time
    }));

    res.json({ attendees });
  } catch (error) {
    console.error('Get attendees error:', error);
    res.status(500).json({ error: 'Server error fetching attendees' });
  }
};

// Get attendance over time (for chart)
// Uses simple SQL math for 30-minute bucketing (compatible with all PG versions).
// scan_time is TIMESTAMP WITHOUT TIME ZONE — PostgreSQL stores it using the
// session timezone (Africa/Lagos = WAT/UTC+1), so it is already local time.
// No manual offset is needed.
exports.getAttendanceOverTime = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    // Verify program ownership and fetch start/end times
    const programCheck = await pool.query(
      'SELECT id, start_time, end_time FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programCheck.rows[0];

    // 30-minute bucketing — scan_time is already in local time, no offset needed.
    const result = await pool.query(
      `SELECT
        to_char(scan_time, 'HH24') || ':' ||
        CASE
          WHEN EXTRACT(MINUTE FROM scan_time) < 30 THEN '00'
          ELSE '30'
        END AS time_bucket,
        COUNT(*) AS count
      FROM scans
      WHERE program_id = $1
      GROUP BY 1
      ORDER BY 1`,
      [id]
    );

    const buckets = result.rows.map(row => ({
      time: row.time_bucket,
      scans: parseInt(row.count)
    }));

    // Also get the actual min/max scan bucket times so the frontend can
    // extend the chart skeleton to cover all scans (not just the program window).
    const rangeResult = await pool.query(
      `SELECT
        to_char(MIN(scan_time), 'HH24') || ':' ||
        CASE
          WHEN EXTRACT(MINUTE FROM MIN(scan_time)) < 30 THEN '00'
          ELSE '30'
        END AS min_bucket,
        to_char(MAX(scan_time), 'HH24') || ':' ||
        CASE
          WHEN EXTRACT(MINUTE FROM MAX(scan_time)) < 30 THEN '00'
          ELSE '30'
        END AS max_bucket
      FROM scans
      WHERE program_id = $1`,
      [id]
    );

    const scanRange = rangeResult.rows[0];

    // Format start/end times as HH:MM for the frontend skeleton generator
    const formatTime = (t) => {
      const str = typeof t === 'string' ? t : t.toString();
      const parts = str.split(':');
      return `${parts[0].padStart(2, '0')}:${parts[1].padStart(2, '0')}`;
    };

    console.log(`📊 Chart data: program=${id}, buckets=${buckets.length}, start=${formatTime(program.start_time)}, end=${formatTime(program.end_time)}, scanRange=${scanRange.min_bucket}-${scanRange.max_bucket}`);

    res.json({
      buckets,
      startTime: formatTime(program.start_time),
      endTime: formatTime(program.end_time),
      scanRangeStart: scanRange.min_bucket || null,
      scanRangeEnd: scanRange.max_bucket || null
    });
  } catch (error) {
    console.error('Get attendance over time error:', error);
    res.status(500).json({ error: 'Server error fetching attendance data' });
  }
};

// Get count-only statistics
exports.getCountOnlyStats = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    // Verify program belongs to church
    const programCheck = await pool.query(
      'SELECT id, tracking_mode FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    // Get gender breakdown
    const genderStats = await pool.query(
      `SELECT 
        COUNT(CASE WHEN gender = 'male' THEN 1 END) as male_count,
        COUNT(CASE WHEN gender = 'female' THEN 1 END) as female_count,
        COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
       FROM scans 
       WHERE program_id = $1`,
      [id]
    );

    res.json({
      stats: {
        maleCount: parseInt(genderStats.rows[0].male_count),
        femaleCount: parseInt(genderStats.rows[0].female_count),
        firstTimerCount: parseInt(genderStats.rows[0].first_timer_count)
      }
    });
  } catch (error) {
    console.error('Get count-only stats error:', error);
    res.status(500).json({ error: 'Server error fetching statistics' });
  }
};

// Mark winner as gifted
exports.markWinnerGifted = async (req, res) => {
  try {
    const { id, attendeeId } = req.params;
    const churchId = req.churchId;

    // Verify program belongs to church
    const programCheck = await pool.query(
      'SELECT id FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    // Update the attendee's is_gifted status
    const result = await pool.query(
      'UPDATE attendees SET is_gifted = true WHERE id = $1 AND program_id = $2 AND is_winner = true RETURNING *',
      [attendeeId, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Winner not found' });
    }

    // Get updated winners gifted count
    const giftedCount = await pool.query(
      'SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND is_winner = true AND is_gifted = true',
      [id]
    );

    // Emit real-time update
    const io = req.app.get('io');
    io.emit(`program-${id}-update`, {
      winnersGifted: parseInt(giftedCount.rows[0].count),
      giftedAttendeeId: parseInt(attendeeId),
      timestamp: new Date()
    });

    res.json({
      success: true,
      winnersGifted: parseInt(giftedCount.rows[0].count)
    });
  } catch (error) {
    console.error('Mark winner gifted error:', error);
    res.status(500).json({ error: 'Server error marking winner as gifted' });
  }
};

// Get dashboard statistics with date-range filtering
exports.getDashboardStats = async (req, res) => {
  try {
    const churchId = req.churchId;
    const { startDate, endDate } = req.query;

    console.log(`📊 Dashboard stats request: churchId=${churchId}, startDate=${startDate}, endDate=${endDate}`);

    // Build date filter clause — use explicit ::date cast for reliable comparison
    let dateFilter = '';
    const params = [churchId];
    let paramIndex = 2;

    if (startDate && endDate) {
      dateFilter = ` AND p.date >= $${paramIndex}::date AND p.date <= $${paramIndex + 1}::date`;
      params.push(startDate, endDate);
      paramIndex += 2;
    } else if (startDate) {
      dateFilter = ` AND p.date >= $${paramIndex}::date`;
      params.push(startDate);
      paramIndex += 1;
    } else if (endDate) {
      dateFilter = ` AND p.date <= $${paramIndex}::date`;
      params.push(endDate);
      paramIndex += 1;
    }

    // 1. Total Programs & Total Attendance in range
    const summaryResult = await pool.query(
      `SELECT COUNT(*) as total_programs, COALESCE(SUM(total_scans), 0) as total_attendance
       FROM programs p
       WHERE p.church_id = $1${dateFilter}`,
      params
    );

    const totalPrograms = parseInt(summaryResult.rows[0].total_programs);
    const totalAttendance = parseInt(summaryResult.rows[0].total_attendance);

    console.log(`📊 Found ${totalPrograms} programs, ${totalAttendance} total attendance in range`);

    // 2. Upcoming Programs (date > today AND within range)
    const today = new Date().toISOString().split('T')[0];
    const upcomingParams = [churchId, today];
    let upcomingDateFilter = '';
    let upcomingParamIndex = 3;

    if (startDate && endDate) {
      upcomingDateFilter = ` AND p.date >= $${upcomingParamIndex}::date AND p.date <= $${upcomingParamIndex + 1}::date`;
      upcomingParams.push(startDate, endDate);
    } else if (endDate) {
      upcomingDateFilter = ` AND p.date <= $${upcomingParamIndex}::date`;
      upcomingParams.push(endDate);
    }

    const upcomingResult = await pool.query(
      `SELECT COUNT(*) as upcoming_count
       FROM programs p
       WHERE p.church_id = $1 AND p.date > $2 AND p.is_active = true${upcomingDateFilter}`,
      upcomingParams
    );

    const upcomingPrograms = parseInt(upcomingResult.rows[0].upcoming_count);

    // 3. Gender / First-Timer breakdown from scans table (for count-only programs)
    const scanStatsResult = await pool.query(
      `SELECT 
        COUNT(CASE WHEN s.gender = 'male' THEN 1 END) as male_count,
        COUNT(CASE WHEN s.gender = 'female' THEN 1 END) as female_count,
        COUNT(CASE WHEN s.first_timer = true THEN 1 END) as first_timer_count,
        COUNT(*) as total_scans_with_data
       FROM scans s
       JOIN programs p ON s.program_id = p.id
       WHERE p.church_id = $1${dateFilter}`,
      params
    );

    // 4. Gender / First-Timer breakdown from attendees table (for collect-data programs)
    const attendeeStatsResult = await pool.query(
      `SELECT 
        COUNT(CASE WHEN a.sex = 'Male' THEN 1 END) as male_count,
        COUNT(CASE WHEN a.sex = 'Female' THEN 1 END) as female_count,
        COUNT(CASE WHEN a.first_timer = true THEN 1 END) as first_timer_count,
        COUNT(*) as total_attendees
       FROM attendees a
       JOIN programs p ON a.program_id = p.id
       WHERE p.church_id = $1${dateFilter}`,
      params
    );

    // Combine gender stats from both sources
    const totalMale = parseInt(scanStatsResult.rows[0].male_count) + parseInt(attendeeStatsResult.rows[0].male_count);
    const totalFemale = parseInt(scanStatsResult.rows[0].female_count) + parseInt(attendeeStatsResult.rows[0].female_count);
    const totalFirstTimer = parseInt(scanStatsResult.rows[0].first_timer_count) + parseInt(attendeeStatsResult.rows[0].first_timer_count);
    const totalPeople = totalMale + totalFemale + totalFirstTimer;

    const genderBreakdown = {
      femalePercent: totalPeople > 0 ? Math.round((totalFemale / totalPeople) * 100) : 0,
      malePercent: totalPeople > 0 ? Math.round((totalMale / totalPeople) * 100) : 0,
      firstTimerPercent: totalPeople > 0 ? Math.round((totalFirstTimer / totalPeople) * 100) : 0,
      femaleCount: totalFemale,
      maleCount: totalMale,
      firstTimerCount: totalFirstTimer
    };

    // 5. Attendance over time — aggregate daily attendance across all programs
    const chartResult = await pool.query(
      `SELECT p.date,
              SUM(p.total_scans) AS daily_attendance,
              COUNT(*) AS program_count
       FROM programs p
       WHERE p.church_id = $1${dateFilter}
       GROUP BY p.date
       ORDER BY p.date ASC`,
      params
    );

    const attendanceOvertime = chartResult.rows.map(row => {
      const d = new Date(row.date + 'T00:00:00');
      const dayLabel = d.toLocaleDateString('en-US', { weekday: 'short' });
      const dayNum = d.getDate();
      return {
        name: `${dayLabel} ${dayNum}`,
        date: row.date,
        attendance: parseInt(row.daily_attendance) || 0,
        programCount: parseInt(row.program_count)
      };
    });

    // 6. Recent Programs in range
    const programsResult = await pool.query(
      `SELECT * FROM programs p
       WHERE p.church_id = $1${dateFilter}
       ORDER BY p.date DESC, p.start_time DESC`,
      params
    );

    const recentPrograms = programsResult.rows.map(program => ({
      id: program.id,
      title: program.title,
      date: program.date,
      startTime: program.start_time,
      endTime: program.end_time,
      trackingMode: program.tracking_mode,
      totalScans: program.total_scans,
      isActive: program.is_active,
      giftingEnabled: program.gifting_enabled,
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
      createdAt: program.created_at
    }));

    res.json({
      totalPrograms,
      totalAttendance,
      upcomingPrograms,
      genderBreakdown,
      attendanceOvertime,
      recentPrograms
    });
  } catch (error) {
    console.error('Get dashboard stats error:', error);
    res.status(500).json({ error: 'Server error fetching dashboard statistics' });
  }
};

// Delete a completed program
exports.deleteProgram = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    // Verify program belongs to church and is not active
    const programCheck = await pool.query(
      'SELECT id, is_active, flyer_storage_path, personalized_background_storage_path, personalized_logo_storage_path FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    if (programCheck.rows[0].is_active) {
      return res.status(400).json({ error: 'Cannot delete an active program. Stop it first.' });
    }

    // Delete program (CASCADE will remove attendees and scans)
    await pool.query('DELETE FROM programs WHERE id = $1', [id]);

    if (programCheck.rows[0].flyer_storage_path) {
      deleteEventFlyer(programCheck.rows[0].flyer_storage_path).catch(deleteError => {
        console.error('Flyer cleanup warning:', deleteError.message);
      });
    }

    if (programCheck.rows[0].personalized_background_storage_path) {
      deleteEventFlyer(programCheck.rows[0].personalized_background_storage_path).catch(deleteError => {
        console.error('Personalized flyer cleanup warning:', deleteError.message);
      });
    }

    if (programCheck.rows[0].personalized_logo_storage_path) {
      deleteEventFlyer(programCheck.rows[0].personalized_logo_storage_path).catch(deleteError => {
        console.error('Personalized logo cleanup warning:', deleteError.message);
      });
    }

    res.json({ success: true, message: 'Program deleted successfully' });
  } catch (error) {
    console.error('Delete program error:', error);
    res.status(500).json({ error: 'Server error deleting program' });
  }
};
