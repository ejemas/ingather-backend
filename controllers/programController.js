const pool = require('../config/database');
const QRCode = require('qrcode');

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
      numberOfWinners
    } = req.body;

    const churchId = req.churchId;

    // Insert program
    const result = await pool.query(
      `INSERT INTO programs 
       (church_id, title, date, start_time, end_time, tracking_mode, data_fields, gifting_enabled, total_winners) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING *`,
      [
        churchId,
        programTitle,
        date,
        startTime,
        endTime,
        trackingMode,
        JSON.stringify(dataFields),
        enableGifting || false,
        numberOfWinners || 0
      ]
    );

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
        qrCodeUrl: qrCodeUrl,
        qrCodeImage: qrCodeImage,
        isActive: program.is_active,
        totalScans: program.total_scans
      }
    });
  } catch (error) {
    console.error('Create program error:', error);
    res.status(500).json({ error: 'Server error creating program' });
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
      'SELECT id, is_active FROM programs WHERE id = $1 AND church_id = $2',
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

    res.json({ success: true, message: 'Program deleted successfully' });
  } catch (error) {
    console.error('Delete program error:', error);
    res.status(500).json({ error: 'Server error deleting program' });
  }
};