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
exports.getAttendanceOverTime = async (req, res) => {
  try {
    const { id } = req.params;
    const churchId = req.churchId;

    // Verify program belongs to church and get start/end times
    const programCheck = await pool.query(
      'SELECT id, start_time, end_time FROM programs WHERE id = $1 AND church_id = $2',
      [id, churchId]
    );

    if (programCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Program not found' });
    }

    const program = programCheck.rows[0];

    // Fetch raw scan timestamps (let JS handle timezone conversion)
    const result = await pool.query(
      'SELECT scan_time FROM scans WHERE program_id = $1 ORDER BY scan_time',
      [id]
    );

    // Bucket scans by 30-minute intervals using local time (JS Date auto-converts to system timezone)
    const scanMap = {};
    result.rows.forEach(row => {
      const d = new Date(row.scan_time);
      const h = d.getHours();
      const m = d.getMinutes() < 30 ? 0 : 30;
      const label = `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
      scanMap[label] = (scanMap[label] || 0) + 1;
    });

    // Parse program start/end times to generate all 30-minute slots
    const parseTime = (timeStr) => {
      const str = typeof timeStr === 'string' ? timeStr : timeStr.toString();
      const parts = str.split(':');
      return { hours: parseInt(parts[0]), minutes: parseInt(parts[1]) };
    };

    const start = parseTime(program.start_time);
    const end = parseTime(program.end_time);

    // Round start down to nearest 30-min boundary
    const startMinutes = start.hours * 60 + (start.minutes < 30 ? 0 : 30);
    // Round end up to nearest 30-min boundary
    const endMinutes = end.hours * 60 + (end.minutes <= 0 ? 0 : end.minutes <= 30 ? 30 : 60);

    const attendanceData = [];
    for (let m = startMinutes; m <= endMinutes; m += 30) {
      const h = Math.floor(m / 60);
      const min = m % 60;
      const label = `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
      attendanceData.push({
        time: label,
        scans: scanMap[label] || 0
      });
    }

    res.json({ attendanceData });
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