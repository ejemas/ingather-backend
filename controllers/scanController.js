const pool = require('../config/database');

// Handle QR scan


// Handle QR scan
exports.scanQR = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { programId } = req.params;
    const { deviceFingerprint, formData } = req.body;

    await client.query('BEGIN');

    // Check if program exists and is active
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

    // Check if device already scanned
    const scanCheck = await client.query(
      'SELECT * FROM scans WHERE program_id = $1 AND device_fingerprint = $2',
      [programId, deviceFingerprint]
    );

    if (scanCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ 
        error: 'This device has already scanned this program',
        alreadyScanned: true 
      });
    }

    // Insert scan record (NEW SCAN)
    await client.query(
      'INSERT INTO scans (program_id, device_fingerprint) VALUES ($1, $2)',
      [programId, deviceFingerprint]
    );

    // Increment total scans
    await client.query(
      'UPDATE programs SET total_scans = total_scans + 1 WHERE id = $1',
      [programId]
    );

    await client.query('COMMIT');

    // Get updated total scans for real-time update
    const updatedProgram = await client.query(
      'SELECT total_scans FROM programs WHERE id = $1',
      [programId]
    );

    const totalScans = updatedProgram.rows[0].total_scans;

    // Emit real-time update via Socket.io
    const io = req.app.get('io');
    io.emit(`program-${programId}-update`, {
      totalScans: totalScans,
      timestamp: new Date()
    });

    // Return success with tracking mode info
    res.json({
      success: true,
      trackingMode: program.tracking_mode,
      totalScans: totalScans,
      firstScan: true // Important: tells frontend this is a new scan
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Scan error:', error);
    
    if (error.code === '23505') { // Unique constraint violation
      res.status(400).json({ 
        error: 'This device has already scanned this program',
        alreadyScanned: true 
      });
    } else {
      res.status(500).json({ error: 'Server error processing scan' });
    }
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

    res.json({
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
      isActive: program.is_active
    });
  } catch (error) {
    console.error('Get program info error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};


// Submit form data only (scan already recorded)
exports.submitFormData = async (req, res) => {
  const client = await pool.connect();
  
  try {
    const { programId } = req.params;
    const { deviceFingerprint, formData } = req.body;

    await client.query('BEGIN');

    // Check if program exists and is active
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

    // Verify that this device has scanned (to prevent form submission without scan)
    const scanCheck = await client.query(
      'SELECT * FROM scans WHERE program_id = $1 AND device_fingerprint = $2',
      [programId, deviceFingerprint]
    );

    if (scanCheck.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'No scan record found. Please scan the QR code first.' });
    }

    // Check if form already submitted by this device
    const attendeeCheck = await client.query(
      'SELECT * FROM attendees WHERE program_id = $1 AND device_fingerprint = $2',
      [programId, deviceFingerprint]
    );

    if (attendeeCheck.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Form already submitted for this scan' });
    }

    let isWinner = false;

    // Determine if user is a winner (lucky dip)
    if (program.gifting_enabled && program.winners_selected < program.total_winners) {
      // Random selection
      isWinner = Math.random() > 0.5;
      
      if (isWinner) {
        await client.query(
          'UPDATE programs SET winners_selected = winners_selected + 1 WHERE id = $1',
          [programId]
        );
      }
    }

    // Insert attendee data
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
        deviceFingerprint
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      isWinner: isWinner,
      giftingEnabled: program.gifting_enabled
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Submit form error:', error);
    res.status(500).json({ error: 'Server error submitting form' });
  } finally {
    client.release();
  }
};