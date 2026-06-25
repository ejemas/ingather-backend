const pool = require('../config/database');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { uploadEventFlyer, deleteEventFlyer } = require('../utils/supabaseStorage');

const CANONICAL_PUBLIC_FRONTEND_ORIGIN = 'https://ingather.app';

const trimTrailingSlash = (value) => String(value || '').replace(/\/+$/, '');

const getPublicScanUrl = (programId) => (
  `${trimTrailingSlash(CANONICAL_PUBLIC_FRONTEND_ORIGIN)}/scan/${programId}`
);

const hashRsvpCheckinToken = (token) => (
  crypto.createHash('sha256').update(String(token || '')).digest('hex')
);

const extractRsvpCheckinToken = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    const match = parsed.pathname.match(/\/rsvp-checkin\/([^/?#]+)/);
    if (match) return decodeURIComponent(match[1]);
  } catch (error) {
    // Not a URL; treat as raw token.
  }

  const pathMatch = raw.match(/rsvp-checkin\/([^/?#]+)/);
  if (pathMatch) return decodeURIComponent(pathMatch[1]);
  return raw;
};

const normalizeFlyerType = (flyerType) => (
  flyerType === 'personalized' ? 'personalized' : 'standard'
);

const parsePersonalizedTemplates = (value) => (
  String(value || '')
    .split(/\r?\n/)
    .map(message => message.trim())
    .filter(Boolean)
);

const normalizeCollectedEmail = (value) => (
  typeof value === 'string' ? value.trim().toLowerCase() : ''
);

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

const normalizePersonalizedFlyerConfig = (config = {}) => {
  const templatesFromArray = Array.isArray(config.templates)
    ? config.templates.map(message => String(message || '').trim()).filter(Boolean)
    : [];
  const templates = templatesFromArray.length > 0
    ? templatesFromArray
    : parsePersonalizedTemplates(config.template);
  const template = templates[0] || '';

  return {
    template,
    templates,
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

const normalizeSponsorDisplayMode = (mode) => (
  mode === 'distribution' ? 'distribution' : 'carousel'
);

const cleanOptionalText = (value, maxLength = 255) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
};

const cleanRequiredText = (value, label, maxLength = 255) => {
  const cleaned = cleanOptionalText(value, maxLength);
  if (!cleaned) {
    throw new Error(`${label} is required`);
  }
  return cleaned;
};

const normalizeSponsorUrl = (value) => {
  const cleaned = cleanRequiredText(value, 'Sponsor CTA link', 1000);
  try {
    const url = new URL(cleaned);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Invalid sponsor CTA link');
    }
    return url.toString();
  } catch (error) {
    throw new Error('Sponsor CTA link must be a valid http or https URL');
  }
};

const normalizeSponsors = (sponsors = [], displayMode = 'carousel') => {
  if (!Array.isArray(sponsors)) {
    throw new Error('Sponsors must be an array');
  }

  const normalized = sponsors
    .filter(sponsor => sponsor && typeof sponsor === 'object')
    .map((sponsor, index) => {
      const percentage = sponsor.distributionPercentage === '' || sponsor.distributionPercentage === null || sponsor.distributionPercentage === undefined
        ? null
        : Number(sponsor.distributionPercentage);

      if (displayMode === 'distribution' && (!Number.isInteger(percentage) || percentage < 1 || percentage > 100)) {
        throw new Error('Each distribution sponsor must have a percentage between 1 and 100');
      }

      if (!sponsor.flyer?.dataUrl) {
        throw new Error('Each sponsor needs a flyer image');
      }

      return {
        sponsorName: cleanRequiredText(sponsor.sponsorName, 'Sponsor name'),
        ctaText: cleanRequiredText(sponsor.ctaText || 'Learn More', 'Sponsor CTA text', 80),
        ctaLink: normalizeSponsorUrl(sponsor.ctaLink),
        boothText: cleanOptionalText(sponsor.boothText, 160),
        campaignTag: cleanOptionalText(sponsor.campaignTag, 160),
        tier: displayMode === 'carousel' ? cleanOptionalText(sponsor.tier, 120) : null,
        distributionPercentage: displayMode === 'distribution' ? percentage : null,
        displayOrder: index,
        flyer: sponsor.flyer
      };
    });

  if (normalized.length > 12) {
    throw new Error('You can add up to 12 sponsors per program');
  }

  if (displayMode === 'distribution' && normalized.length > 0) {
    const total = normalized.reduce((sum, sponsor) => sum + sponsor.distributionPercentage, 0);
    if (total !== 100) {
      throw new Error('Sponsor distribution percentages must add up to exactly 100');
    }
  }

  return normalized;
};

const mapSponsor = (sponsor) => ({
  id: sponsor.id,
  programId: sponsor.program_id,
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

const getDateOnly = (value) => {
  if (!value) return '';
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};

const getTodayDateOnly = () => new Date().toISOString().split('T')[0];

const getProgramStatus = (program, today = getTodayDateOnly()) => {
  if (!program.is_active) return 'completed';
  return getDateOnly(program.date) > today ? 'upcoming' : 'active';
};

const buildProgramListQueryParts = (churchId, startDate, endDate, today = getTodayDateOnly()) => {
  const params = [churchId];
  let datePredicate = '';
  let paramIndex = 2;

  if (startDate && endDate) {
    datePredicate = `p.date >= $${paramIndex}::date AND p.date <= $${paramIndex + 1}::date`;
    params.push(startDate, endDate);
    paramIndex += 2;
  } else if (startDate) {
    datePredicate = `p.date >= $${paramIndex}::date`;
    params.push(startDate);
    paramIndex += 1;
  } else if (endDate) {
    datePredicate = `p.date <= $${paramIndex}::date`;
    params.push(endDate);
    paramIndex += 1;
  }

  if (!datePredicate) {
    return {
      whereClause: 'p.church_id = $1',
      params
    };
  }

  params.push(today);
  return {
    whereClause: `p.church_id = $1 AND (${datePredicate} OR (p.is_active = true AND p.date > $${paramIndex}::date))`,
    params
  };
};

const mapProgramDetail = (program, counts = {}) => ({
  id: program.id,
  title: program.title,
  date: program.date,
  startTime: program.start_time,
  endTime: program.end_time,
  trackingMode: program.tracking_mode,
  dataFields: program.data_fields,
  dataFieldConfig: normalizeFieldConfig(program.data_field_config || {}),
  giftingEnabled: program.gifting_enabled,
  totalWinners: program.total_winners,
  winnersSelected: program.winners_selected,
  winnersGifted: counts.winnersGifted || 0,
  flyerType: program.flyer_type || 'standard',
  personalizedFlyerConfig: program.personalized_flyer_config,
  personalizedBackgroundUrl: program.personalized_background_url,
  personalizedLogoUrl: program.personalized_logo_url,
  flyerUrl: program.flyer_url,
  sponsorDisplayMode: program.sponsor_display_mode || 'carousel',
  sponsorExpectedAttendees: program.sponsor_expected_attendees,
  proxyCheckinEnabled: program.proxy_checkin_enabled || false,
  strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
  qrCodeUrl: getPublicScanUrl(program.id),
  isActive: program.is_active,
  totalScans: program.total_scans,
  attendeesCount: counts.attendeesCount || 0,
  firstTimersCount: counts.firstTimersCount || 0,
  sharedDeviceCheckins: counts.sharedDeviceCheckins || 0,
  linkedPreEventCount: counts.linkedPreEventCount || 0
});

const mapAttendee = (attendee) => ({
  id: attendee.id,
  fullName: attendee.full_name,
  emailAddress: attendee.email_address,
  school: attendee.school,
  linkUrl: attendee.link_url || '',
  textareaResponse: attendee.textarea_response || '',
  phoneNumber: attendee.phone_number,
  address: attendee.address,
  firstTimer: attendee.first_timer,
  department: attendee.department,
  fellowship: attendee.fellowship,
  age: attendee.age,
  sex: attendee.sex,
  isWinner: attendee.is_winner,
  isGifted: attendee.is_gifted || false,
  personalizedMessage: attendee.personalized_message || null,
  proxyHostFingerprint: attendee.proxy_host_fingerprint || null,
  scanId: attendee.scan_id || null,
  preEventRsvpId: attendee.pre_event_rsvp_id || null,
  status: attendee.status || 'checked_in',
  registrationType: attendee.registration_type || (attendee.proxy_host_fingerprint ? 'proxy' : attendee.device_fingerprint?.startsWith('manual-') ? 'manual' : 'walk_in'),
  checkedInAt: attendee.checked_in_at || attendee.scan_time,
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

  const today = getTodayDateOnly();
  const upcomingParams = [churchId, today];
  const programListQuery = buildProgramListQueryParts(churchId, startDate, endDate, today);

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
       WHERE p.church_id = $1 AND p.date > $2::date AND p.is_active = true`,
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
       WHERE ${programListQuery.whereClause}
       ORDER BY p.date DESC, p.start_time DESC`,
      programListQuery.params
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
      status: getProgramStatus(program, today),
      giftingEnabled: program.gifting_enabled,
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
      sponsorDisplayMode: program.sponsor_display_mode || 'carousel',
      sponsorExpectedAttendees: program.sponsor_expected_attendees,
      proxyCheckinEnabled: program.proxy_checkin_enabled || false,
      strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
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
      dataFieldConfig,
      enableGifting,
      numberOfWinners,
      eventFlyer,
      flyerType: requestedFlyerType,
      personalizedFlyerConfig,
      personalizedBackground,
      personalizedLogo,
      sponsorDisplayMode: requestedSponsorDisplayMode,
      sponsorExpectedAttendees,
      proxyCheckinEnabled,
      strictDeviceFingerprinting,
      sponsors: requestedSponsors
    } = req.body;

    const churchId = req.churchId;
    const flyerType = normalizeFlyerType(requestedFlyerType);
    const sponsorDisplayMode = normalizeSponsorDisplayMode(requestedSponsorDisplayMode);
    const normalizedSponsors = normalizeSponsors(requestedSponsors || [], sponsorDisplayMode);
    const normalizedSponsorExpectedAttendees = sponsorDisplayMode === 'distribution' && sponsorExpectedAttendees !== '' && sponsorExpectedAttendees !== null && sponsorExpectedAttendees !== undefined
      ? Number(sponsorExpectedAttendees)
      : null;
    const resolvedDataFields = { ...(dataFields || {}) };
    const resolvedDataFieldConfig = normalizeFieldConfig(dataFieldConfig || {});
    const resolvedTrackingMode = flyerType === 'personalized' ? 'collect-data' : trackingMode;
    const normalizedProxyCheckinEnabled = resolvedTrackingMode === 'collect-data' && proxyCheckinEnabled === true;
    const normalizedStrictDeviceFingerprinting = resolvedTrackingMode !== 'collect-data' || strictDeviceFingerprinting !== false;
    const resolvedPersonalizedConfig = normalizePersonalizedFlyerConfig(personalizedFlyerConfig);
    let uploadedFlyer = null;
    let uploadedPersonalizedBackground = null;
    let uploadedPersonalizedLogo = null;
    const uploadedSponsors = [];

    if (sponsorDisplayMode === 'distribution' && normalizedSponsors.length > 0) {
      if (!Number.isInteger(normalizedSponsorExpectedAttendees) || normalizedSponsorExpectedAttendees < 1) {
        return res.status(400).json({ error: 'Expected attendees is required for percentage distribution sponsors' });
      }
    }

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

    for (const sponsor of normalizedSponsors) {
      const uploadedSponsorFlyer = await uploadEventFlyer({
        churchId,
        dataUrl: sponsor.flyer.dataUrl,
        folder: 'sponsors'
      });

      uploadedSponsors.push({
        ...sponsor,
        flyerUrl: uploadedSponsorFlyer.flyerUrl,
        flyerStoragePath: uploadedSponsorFlyer.flyerStoragePath,
        flyerOriginalName: sponsor.flyer.originalName || null
      });
    }

    const personalizedConfigForStorage = flyerType === 'personalized'
      ? {
          ...resolvedPersonalizedConfig,
          backgroundUrl: uploadedPersonalizedBackground?.flyerUrl || null,
          logoUrl: uploadedPersonalizedLogo?.flyerUrl || null
        }
      : null;

    // Insert program and sponsors atomically.
    let result;
    const client = await pool.connect();
    let transactionStarted = false;
    try {
      await client.query('BEGIN');
      transactionStarted = true;

      result = await client.query(
        `INSERT INTO programs
         (church_id, title, date, start_time, end_time, tracking_mode, data_fields, data_field_config, gifting_enabled, total_winners, flyer_type, flyer_url, flyer_storage_path, flyer_original_name, personalized_flyer_config, personalized_background_url, personalized_background_storage_path, personalized_background_original_name, personalized_logo_url, personalized_logo_storage_path, personalized_logo_original_name, sponsor_display_mode, sponsor_expected_attendees, proxy_checkin_enabled, strict_device_fingerprinting)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
         RETURNING *`,
        [
          churchId,
          programTitle,
          date,
          startTime,
          endTime,
          resolvedTrackingMode,
          JSON.stringify(resolvedDataFields),
          JSON.stringify(resolvedDataFieldConfig),
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
          personalizedLogo?.originalName || null,
          sponsorDisplayMode,
          normalizedSponsorExpectedAttendees,
          normalizedProxyCheckinEnabled,
          normalizedStrictDeviceFingerprinting
        ]
      );

      const program = result.rows[0];

      for (const sponsor of uploadedSponsors) {
        await client.query(
          `INSERT INTO event_sponsors
           (program_id, sponsor_name, flyer_url, flyer_storage_path, flyer_original_name, cta_text, cta_link, booth_text, campaign_tag, tier, distribution_percentage, display_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            program.id,
            sponsor.sponsorName,
            sponsor.flyerUrl,
            sponsor.flyerStoragePath,
            sponsor.flyerOriginalName,
            sponsor.ctaText,
            sponsor.ctaLink,
            sponsor.boothText,
            sponsor.campaignTag,
            sponsor.tier,
            sponsor.distributionPercentage,
            sponsor.displayOrder
          ]
        );
      }

      // Generate QR Code URL
      const qrCodeUrl = getPublicScanUrl(program.id);

      // Update program with QR code URL
      await client.query(
        'UPDATE programs SET qr_code_url = $1 WHERE id = $2',
        [qrCodeUrl, program.id]
      );

      await client.query('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await client.query('ROLLBACK');
      }
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
      uploadedSponsors.forEach(sponsor => {
        if (sponsor.flyerStoragePath) {
          deleteEventFlyer(sponsor.flyerStoragePath).catch(deleteError => {
            console.error('Sponsor flyer cleanup warning:', deleteError.message);
          });
        }
      });
      throw error;
    } finally {
      client.release();
    }

    const program = result.rows[0];

    const qrCodeUrl = getPublicScanUrl(program.id);

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
      sponsorDisplayMode: program.sponsor_display_mode,
      sponsorExpectedAttendees: program.sponsor_expected_attendees,
      proxyCheckinEnabled: program.proxy_checkin_enabled || false,
      strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
      sponsors: uploadedSponsors.map((sponsor, index) => ({
          id: index,
          sponsorName: sponsor.sponsorName,
          flyerUrl: sponsor.flyerUrl,
          ctaText: sponsor.ctaText,
          ctaLink: sponsor.ctaLink,
          boothText: sponsor.boothText,
          campaignTag: sponsor.campaignTag,
          tier: sponsor.tier,
          distributionPercentage: sponsor.distributionPercentage
        })),
        qrCodeUrl: qrCodeUrl,
        qrCodeImage: qrCodeImage,
        isActive: program.is_active,
        totalScans: program.total_scans
      }
    });
  } catch (error) {
    console.error('Create program error:', error);
    const isFlyerError = error.message?.includes('flyer') || error.message?.includes('Flyer') || error.message?.includes('Supabase') || error.message?.includes('Sponsor') || error.message?.includes('sponsor') || error.message?.includes('distribution');
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
      sponsorDisplayMode: program.sponsor_display_mode || 'carousel',
      sponsorExpectedAttendees: program.sponsor_expected_attendees,
      proxyCheckinEnabled: program.proxy_checkin_enabled || false,
      strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
      qrCodeUrl: getPublicScanUrl(program.id),
      isActive: program.is_active,
      status: getProgramStatus(program),
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

    const linkedPreEventResult = await pool.query(
      'SELECT COUNT(*) FROM pre_events WHERE program_id = $1',
      [id]
    );

    const sharedDeviceCheckins = await getSharedDeviceCheckins(pool, id);

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
      sponsorDisplayMode: program.sponsor_display_mode || 'carousel',
      sponsorExpectedAttendees: program.sponsor_expected_attendees,
      proxyCheckinEnabled: program.proxy_checkin_enabled || false,
      strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
      qrCodeUrl: getPublicScanUrl(program.id),
      isActive: program.is_active,
      totalScans: program.total_scans,
      attendeesCount: parseInt(attendeesResult.rows[0].count),
      firstTimersCount: parseInt(firstTimersResult.rows[0].count),
      sharedDeviceCheckins,
      linkedPreEventCount: parseInt(linkedPreEventResult.rows[0].count, 10)
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
      countOnlyScansResult,
      sharedDeviceCheckins,
      linkedPreEventResult
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM attendees WHERE program_id = $1', [id]),
      pool.query('SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND first_timer = true', [id]),
      pool.query('SELECT COUNT(*) FROM attendees WHERE program_id = $1 AND is_winner = true AND is_gifted = true', [id]),
      pool.query(
        `SELECT *
         FROM attendees
         WHERE program_id = $1
           AND status = 'checked_in'
         ORDER BY COALESCE(checked_in_at, scan_time) DESC`,
        [id]
      ),
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
        : Promise.resolve({ rows: [] }),
      getSharedDeviceCheckins(pool, id),
      pool.query('SELECT COUNT(*) FROM pre_events WHERE program_id = $1', [id])
    ]);

    return res.json({
      church,
      unreadCount,
      program: mapProgramDetail(program, {
        attendeesCount: parseInt(attendeesCountResult.rows[0].count, 10),
        firstTimersCount: parseInt(firstTimersResult.rows[0].count, 10),
        winnersGifted: parseInt(winnersGiftedResult.rows[0].count, 10),
        sharedDeviceCheckins,
        linkedPreEventCount: parseInt(linkedPreEventResult.rows[0].count, 10)
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

exports.updateStrictDeviceFingerprinting = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;
    const { strictDeviceFingerprinting } = req.body;

    if (typeof strictDeviceFingerprinting !== 'boolean') {
      return res.status(400).json({ error: 'Strict device fingerprinting value is required' });
    }

    const result = await pool.query(
      `UPDATE programs
       SET strict_device_fingerprinting = $1
       WHERE id = $2 AND church_id = $3 AND tracking_mode = 'collect-data'
       RETURNING id, strict_device_fingerprinting`,
      [strictDeviceFingerprinting, id, churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Collect-data program not found' });
    }

    return res.json({
      success: true,
      strictDeviceFingerprinting: result.rows[0].strict_device_fingerprinting !== false
    });
  } catch (error) {
    console.error('Update strict device fingerprinting error:', error);
    return res.status(500).json({
      error: error.message || 'Server error updating device fingerprinting setting'
    });
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
      `SELECT *
       FROM attendees
       WHERE program_id = $1
         AND status = 'checked_in'
       ORDER BY COALESCE(checked_in_at, scan_time) DESC`,
      [id]
    );

    const attendees = result.rows.map(mapAttendee);

    res.json({ attendees });
  } catch (error) {
    console.error('Get attendees error:', error);
    res.status(500).json({ error: 'Server error fetching attendees' });
  }
};

exports.addManualAttendee = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { id } = req.params;
    const churchId = req.churchId;
    const formData = req.body.formData || {};

    await client.query('BEGIN');
    transactionStarted = true;

    const programResult = await client.query(
      'SELECT * FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programResult.rows[0];
    const dataFields = program.data_fields || {};

    if (!program.is_active) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This program is no longer active' });
    }

    if (program.tracking_mode !== 'collect-data') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Manual attendee entry is only available for collect-data programs' });
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

    const age = formData.age === '' || formData.age === null || formData.age === undefined
      ? null
      : Number(formData.age);

    if (dataFields.age && age !== null && (!Number.isInteger(age) || age < 0 || age > 130)) {
      errors.age = 'Age must be a valid number';
    }

    if (Object.keys(errors).length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please complete the required attendee fields', errors });
    }

    let isWinner = false;

    if (program.gifting_enabled && program.winners_selected < program.total_winners) {
      isWinner = Math.random() > 0.5;

      if (isWinner) {
        await client.query(
          'UPDATE programs SET winners_selected = winners_selected + 1 WHERE id = $1',
          [id]
        );
      }
    }

    const deviceFingerprint = `manual-${id}-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`;
    const firstTimer = Boolean(formData.firstTimer);
    const sex = cleanText(formData.sex) || null;
    const emailAddress = dataFields.emailAddress ? normalizeCollectedEmail(formData.emailAddress) : null;
    const school = dataFields.school ? cleanText(formData.school) : null;
    const linkUrl = dataFields.link ? normalizeUrlField(formData.linkUrl || formData.link) : null;
    const textareaResponse = dataFields.textarea ? cleanText(formData.textareaResponse).slice(0, 5000) : null;

    const scanResult = await client.query(
      `INSERT INTO scans
       (program_id, device_fingerprint, gender, first_timer)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, deviceFingerprint, sex ? sex.toLowerCase() : null, firstTimer]
    );

    const updatedProgram = await client.query(
      'UPDATE programs SET total_scans = total_scans + 1 WHERE id = $1 RETURNING total_scans',
      [id]
    );

    const attendeeResult = await client.query(
      `INSERT INTO attendees
       (program_id, full_name, email_address, school, link_url, textarea_response, phone_number, address, first_timer, department, fellowship, age, sex, is_winner, device_fingerprint, scan_id, status, registration_type, checked_in_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, 'checked_in', 'manual', CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        id,
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
        isWinner,
        deviceFingerprint,
        scanResult.rows[0].id
      ]
    );

    const attendeeStats = await client.query(
      `SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN sex = 'Male' THEN 1 END) as male_count,
        COUNT(CASE WHEN sex = 'Female' THEN 1 END) as female_count,
        COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
       FROM attendees WHERE program_id = $1`,
      [id]
    );

    await client.query('COMMIT');
    transactionStarted = false;

    const totalScans = parseInt(updatedProgram.rows[0].total_scans, 10);
    const attendee = mapAttendee(attendeeResult.rows[0]);
    const stats = {
      attendeeMaleCount: parseInt(attendeeStats.rows[0].male_count, 10),
      attendeeFemaleCount: parseInt(attendeeStats.rows[0].female_count, 10),
      attendeeFirstTimerCount: parseInt(attendeeStats.rows[0].first_timer_count, 10),
      attendeeTotal: parseInt(attendeeStats.rows[0].total, 10)
    };

    const io = req.app.get('io');
    io?.emit(`program-${id}-update`, {
      totalScans,
      ...stats,
      timestamp: new Date()
    });

    return res.status(201).json({
      success: true,
      attendee,
      totalScans,
      isWinner,
      ...stats
    });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    console.error('Manual attendee entry error:', error);
    return res.status(500).json({ error: 'Server error adding manual attendee' });
  } finally {
    client.release();
  }
};

exports.checkInRsvpQr = async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const { id } = req.params;
    const churchId = req.churchId;
    const token = extractRsvpCheckinToken(req.body.token);

    if (!token || token.length < 20) {
      return res.status(400).json({ error: 'A valid RSVP QR token is required.' });
    }

    const programResult = await client.query(
      'SELECT * FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programResult.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found.' });
    }

    const program = programResult.rows[0];
    if (program.is_active === false) {
      return res.status(400).json({ error: 'This event has ended, so RSVP QR check-ins are disabled.' });
    }

    await client.query('BEGIN');
    transactionStarted = true;

    const tokenHash = hashRsvpCheckinToken(token);
    const rsvpResult = await client.query(
      `SELECT per.*
       FROM pre_event_rsvps per
       JOIN pre_events pe ON pe.id = per.pre_event_id
       WHERE pe.program_id = $1
         AND pe.church_id = $2
         AND per.checkin_token_hash = $3
       LIMIT 1
       FOR UPDATE OF per`,
      [id, churchId, tokenHash]
    );

    if (rsvpResult.rows.length === 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'This RSVP QR code is not valid for this live event.' });
    }

    const rsvp = rsvpResult.rows[0];
    if (rsvp.status === 'checked_in') {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ error: 'This RSVP has already checked in.', alreadyCheckedIn: true });
    }

    const duplicateResult = await client.query(
      'SELECT id FROM attendees WHERE pre_event_rsvp_id = $1 LIMIT 1',
      [rsvp.id]
    );

    if (duplicateResult.rows.length > 0) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(409).json({ error: 'This RSVP has already checked in.', alreadyCheckedIn: true });
    }

    const checkedInAt = new Date();
    const deviceFingerprint = `rsvp-qr-${id}-${rsvp.id}-${crypto.randomBytes(8).toString('hex')}`;
    const firstTimer = Boolean(rsvp.first_timer);
    const sex = cleanOptionalText(rsvp.sex);

    const scanResult = await client.query(
      `INSERT INTO scans
       (program_id, device_fingerprint, gender, first_timer)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [id, deviceFingerprint, sex ? sex.toLowerCase() : null, firstTimer]
    );

    const updatedProgram = await client.query(
      'UPDATE programs SET total_scans = total_scans + 1 WHERE id = $1 RETURNING total_scans',
      [id]
    );

    const attendeeResult = await client.query(
      `INSERT INTO attendees
       (program_id, full_name, email_address, school, link_url, textarea_response, phone_number, address, first_timer,
        department, fellowship, age, sex, is_winner, device_fingerprint, scan_id, pre_event_rsvp_id,
        status, registration_type, checked_in_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, false, $14, $15, $16, 'checked_in', 'rsvp', $17)
       RETURNING *`,
      [
        id,
        cleanOptionalText(rsvp.full_name),
        normalizeCollectedEmail(rsvp.email_address),
        cleanOptionalText(rsvp.school),
        cleanOptionalText(rsvp.link_url, 1000),
        cleanOptionalText(rsvp.textarea_response, 5000),
        cleanOptionalText(rsvp.phone_number, 50),
        cleanOptionalText(rsvp.address, 1000),
        firstTimer,
        cleanOptionalText(rsvp.department, 100),
        cleanOptionalText(rsvp.fellowship, 100),
        rsvp.age || null,
        sex,
        deviceFingerprint,
        scanResult.rows[0].id,
        rsvp.id,
        checkedInAt
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

    const attendeeStats = await client.query(
      `SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN sex = 'Male' THEN 1 END) as male_count,
        COUNT(CASE WHEN sex = 'Female' THEN 1 END) as female_count,
        COUNT(CASE WHEN first_timer = true THEN 1 END) as first_timer_count
       FROM attendees WHERE program_id = $1`,
      [id]
    );

    const sharedDeviceCheckins = await getSharedDeviceCheckins(client, id);

    await client.query('COMMIT');
    transactionStarted = false;

    const totalScans = parseInt(updatedProgram.rows[0].total_scans, 10);
    const attendee = mapAttendee(attendeeResult.rows[0]);
    const stats = {
      attendeeMaleCount: parseInt(attendeeStats.rows[0].male_count, 10),
      attendeeFemaleCount: parseInt(attendeeStats.rows[0].female_count, 10),
      attendeeFirstTimerCount: parseInt(attendeeStats.rows[0].first_timer_count, 10),
      attendeeTotal: parseInt(attendeeStats.rows[0].total, 10)
    };

    const io = req.app.get('io');
    io?.emit(`program-${id}-update`, {
      totalScans,
      ...stats,
      sharedDeviceCheckins,
      timestamp: new Date()
    });

    return res.status(201).json({
      success: true,
      attendee,
      totalScans,
      sharedDeviceCheckins,
      ...stats
    });
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    console.error('RSVP QR check-in error:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This RSVP has already checked in.', alreadyCheckedIn: true });
    }
    return res.status(500).json({ error: 'Server error checking in RSVP QR.' });
  } finally {
    client.release();
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

// Get sponsor engagement analytics for a program
exports.getSponsorAnalytics = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    const programCheck = await pool.query(
      'SELECT id FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const sponsorsResult = await pool.query(
      `SELECT
        s.*,
        COUNT(ce.id) FILTER (WHERE ce.clicked_at::date = CURRENT_DATE) AS today_clicks
       FROM event_sponsors s
       LEFT JOIN sponsor_click_events ce ON ce.sponsor_id = s.id
       WHERE s.program_id = $1 AND s.is_active = true
       GROUP BY s.id
       ORDER BY s.click_count DESC, s.display_order ASC`,
      [id]
    );

    const sponsors = sponsorsResult.rows.map(row => ({
      ...mapSponsor(row),
      todayClicks: parseInt(row.today_clicks || 0, 10)
    }));

    const totalClicks = sponsors.reduce((sum, sponsor) => sum + sponsor.clickCount, 0);
    const todayClicks = sponsors.reduce((sum, sponsor) => sum + sponsor.todayClicks, 0);
    const topSponsor = sponsors.length > 0 ? sponsors[0] : null;

    return res.json({
      sponsorCount: sponsors.length,
      totalClicks,
      todayClicks,
      topSponsor,
      sponsors
    });
  } catch (error) {
    console.error('Get sponsor analytics error:', error);
    return res.status(500).json({ error: 'Server error fetching sponsor analytics' });
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

    // 2. Upcoming Programs (active programs dated after today)
    const today = getTodayDateOnly();
    const upcomingParams = [churchId, today];
    const programListQuery = buildProgramListQueryParts(churchId, startDate, endDate, today);

    const upcomingResult = await pool.query(
      `SELECT COUNT(*) as upcoming_count
       FROM programs p
       WHERE p.church_id = $1 AND p.date > $2::date AND p.is_active = true`,
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
       WHERE ${programListQuery.whereClause}
       ORDER BY p.date DESC, p.start_time DESC`,
      programListQuery.params
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
      status: getProgramStatus(program, today),
      giftingEnabled: program.gifting_enabled,
      flyerType: program.flyer_type || 'standard',
      personalizedFlyerConfig: program.personalized_flyer_config,
      personalizedBackgroundUrl: program.personalized_background_url,
      personalizedLogoUrl: program.personalized_logo_url,
      flyerUrl: program.flyer_url,
      sponsorDisplayMode: program.sponsor_display_mode || 'carousel',
      sponsorExpectedAttendees: program.sponsor_expected_attendees,
      proxyCheckinEnabled: program.proxy_checkin_enabled || false,
      strictDeviceFingerprinting: program.strict_device_fingerprinting !== false,
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
