const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const { generateOTP, sendOTPEmail, sendPasswordResetEmail } = require('../utils/emailService');

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

    // Generate OTP
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Insert church with OTP
    const result = await pool.query(
      `INSERT INTO churches (church_name, branch_name, email, password, location, logo_url, is_verified, otp_code, otp_expires_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
       RETURNING id, church_name, branch_name, email, location`,
      [churchName, branchName, email, hashedPassword, location, logoUrl || null, false, otp, otpExpiresAt]
    );

    // Send OTP email
    await sendOTPEmail(email, otp);
    console.log(`📧 OTP sent to ${email}`);

    res.status(201).json({
      message: 'Registration successful. Please verify your email.',
      requiresVerification: true,
      email: result.rows[0].email
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

    // Check if email is verified
    if (!church.is_verified) {
      return res.status(403).json({
        error: 'Email not verified. Please verify your email to continue.',
        requiresVerification: true,
        email: church.email
      });
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

// Verify OTP
exports.verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const church = result.rows[0];

    if (church.is_verified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    // Check OTP match
    if (church.otp_code !== otp) {
      return res.status(400).json({ error: 'Invalid OTP code' });
    }

    // Check OTP expiry
    if (new Date() > new Date(church.otp_expires_at)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Mark as verified and clear OTP
    await pool.query(
      'UPDATE churches SET is_verified = true, otp_code = NULL, otp_expires_at = NULL WHERE email = $1',
      [email]
    );

    res.json({ message: 'Email verified successfully! You can now login.' });
  } catch (error) {
    console.error('Verify OTP error:', error);
    res.status(500).json({ error: 'Server error during verification' });
  }
};

// Resend OTP
exports.resendOtp = async (req, res) => {
  try {
    const { email } = req.body;

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const church = result.rows[0];

    if (church.is_verified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'UPDATE churches SET otp_code = $1, otp_expires_at = $2 WHERE email = $3',
      [otp, otpExpiresAt, email]
    );

    await sendOTPEmail(email, otp);
    console.log(`📧 OTP resent to ${email}`);

    res.json({ message: 'A new OTP has been sent to your email.' });
  } catch (error) {
    console.error('Resend OTP error:', error);
    res.status(500).json({ error: 'Server error while resending OTP' });
  }
};

// Forgot Password - send OTP
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      // Return success anyway to prevent email enumeration
      return res.json({ message: 'If an account exists with this email, an OTP has been sent.' });
    }

    // Generate OTP
    const otp = generateOTP();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'UPDATE churches SET otp_code = $1, otp_expires_at = $2 WHERE email = $3',
      [otp, otpExpiresAt, email]
    );

    await sendPasswordResetEmail(email, otp);
    console.log(`📧 Password reset OTP sent to ${email}`);

    res.json({ message: 'If an account exists with this email, an OTP has been sent.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Server error during password reset request' });
  }
};

// Reset Password
exports.resetPassword = async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const church = result.rows[0];

    // Check OTP match
    if (church.otp_code !== otp) {
      return res.status(400).json({ error: 'Invalid OTP code' });
    }

    // Check OTP expiry
    if (new Date() > new Date(church.otp_expires_at)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password and clear OTP
    await pool.query(
      'UPDATE churches SET password = $1, otp_code = NULL, otp_expires_at = NULL WHERE email = $2',
      [hashedPassword, email]
    );

    res.json({ message: 'Password reset successfully! You can now login with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({ error: 'Server error during password reset' });
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