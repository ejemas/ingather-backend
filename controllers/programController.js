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
      scanTime: attendee.scan_time
    }));

    res.json({ attendees });
  } catch (error) {
    console.error('Get attendees error:', error);
    res.status(500).json({ error: 'Server error fetching attendees' });
  }
};

// Get attendance over time (for chart)
exports.getAttendanceOverTime = async (req, res) => {
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

    // Get scans grouped by 30-minute intervals
    const result = await pool.query(
      `SELECT 
        TO_CHAR(DATE_TRUNC('hour', scan_time) + 
          INTERVAL '30 min' * FLOOR(EXTRACT(MINUTE FROM scan_time) / 30), 'HH24:MI') as time_interval,
        COUNT(*) as scan_count
       FROM scans 
       WHERE program_id = $1 
       GROUP BY time_interval 
       ORDER BY time_interval`,
      [id]
    );

    const attendanceData = result.rows.map(row => ({
      time: row.time_interval,
      scans: parseInt(row.scan_count)
    }));

    res.json({ attendanceData });
  } catch (error) {
    console.error('Get attendance over time error:', error);
    res.status(500).json({ error: 'Server error fetching attendance data' });
  }
};