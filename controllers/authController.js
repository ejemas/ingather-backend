const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');

// Register Church
exports.register = async (req, res) => {
  try {
    const { churchName, branchName, email, password, location, logoUrl } = req.body;

    // Check if church already exists
    const churchExists = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [email]
    );

    if (churchExists.rows.length > 0) {
      return res.status(400).json({ error: 'Church with this email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Insert church
    const result = await pool.query(
      `INSERT INTO churches (church_name, branch_name, email, password, location, logo_url) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING id, church_name, branch_name, email, location, logo_url, created_at`,
      [churchName, branchName, email, hashedPassword, location, logoUrl || null]
    );

    const church = result.rows[0];

    // Create JWT token
    const token = jwt.sign(
      { churchId: church.id, email: church.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      message: 'Church registered successfully',
      token,
      church: {
        id: church.id,
        churchName: church.church_name,
        branchName: church.branch_name,
        email: church.email,
        location: church.location,
        logoUrl: church.logo_url
      }
    });
  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  }
};

// Login Church
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if church exists
    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const church = result.rows[0];

    // Verify password
    const isMatch = await bcrypt.compare(password, church.password);

    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    // Create JWT token
    const token = jwt.sign(
      { churchId: church.id, email: church.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Login successful',
      token,
      church: {
        id: church.id,
        churchName: church.church_name,
        branchName: church.branch_name,
        email: church.email,
        location: church.location,
        logoUrl: church.logo_url
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Server error during login' });
  }
};

// Get current church info
exports.getCurrentChurch = async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, church_name, branch_name, email, location, logo_url, created_at FROM churches WHERE id = $1',
      [req.churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    const church = result.rows[0];

    res.json({
      id: church.id,
      churchName: church.church_name,
      branchName: church.branch_name,
      email: church.email,
      location: church.location,
      logoUrl: church.logo_url,
      createdAt: church.created_at
    });
  } catch (error) {
    console.error('Get church error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
// Update church information
exports.updateChurch = async (req, res) => {
  try {
    const { churchName, branchName, location } = req.body;
    const churchId = req.churchId;

    const result = await pool.query(
      `UPDATE churches 
       SET church_name = $1, branch_name = $2, location = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING id, church_name, branch_name, email, location, logo_url`,
      [churchName, branchName, location, churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    const church = result.rows[0];

    res.json({
      message: 'Church information updated successfully',
      church: {
        id: church.id,
        churchName: church.church_name,
        branchName: church.branch_name,
        email: church.email,
        location: church.location,
        logoUrl: church.logo_url
      }
    });
  } catch (error) {
    console.error('Update church error:', error);
    res.status(500).json({ error: 'Server error updating church information' });
  }
};