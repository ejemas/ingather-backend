const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { generateOTP, sendOTPEmail, sendPasswordResetEmail } = require('../utils/emailService');
const { hashInviteToken } = require('../utils/waitlistInviteService');

const OTP_MAX_ATTEMPTS = 5;
const VALID_ORGANIZATION_TYPES = new Set([
  'general',
  'techMeetup',
  'conference',
  'seminar',
  'bootcamp',
  'corporateEvent',
  'church',
  'communityGathering'
]);

const otpSecret = () => process.env.OTP_SECRET || process.env.JWT_SECRET || 'ingather-development-otp-secret';

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const isValidOrganizationType = (organizationType) => (
  typeof organizationType === 'string' && VALID_ORGANIZATION_TYPES.has(organizationType)
);

const mapChurchProfile = (church) => ({
  id: church.id,
  churchName: church.church_name,
  branchName: church.branch_name,
  email: church.email,
  location: church.location,
  logoUrl: church.logo_url,
  organizationType: church.organization_type || null,
  ...(church.created_at !== undefined ? { createdAt: church.created_at } : {})
});

const hashOtp = (email, otp, purpose) => {
  return crypto
    .createHmac('sha256', otpSecret())
    .update(`${normalizeEmail(email)}:${purpose}:${String(otp)}`)
    .digest('hex');
};

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
};

const otpMatches = (church, email, otp, purpose) => {
  if (!church.otp_code) return false;

  if (church.otp_code === String(otp)) {
    return true;
  }

  return safeEqual(church.otp_code, hashOtp(email, otp, purpose));
};

const hasOtpExpired = (church) => {
  return !church.otp_expires_at || new Date() > new Date(church.otp_expires_at);
};

const hasTooManyOtpAttempts = (church) => {
  return Number(church.otp_attempts || 0) >= OTP_MAX_ATTEMPTS;
};

const incrementOtpAttempts = (email) => {
  return pool.query(
    'UPDATE churches SET otp_attempts = COALESCE(otp_attempts, 0) + 1 WHERE email = $1',
    [normalizeEmail(email)]
  );
};

// Register Church
exports.register = async (req, res) => {
  let client;
  let transactionOpen = false;

  try {
    const { churchName, branchName, email, password, location, logoUrl, organizationType, inviteToken } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const selectedOrganizationType = isValidOrganizationType(organizationType) ? organizationType : null;
    const inviteTokenHash = inviteToken ? hashInviteToken(inviteToken) : null;

    client = await pool.connect();
    await client.query('BEGIN');
    transactionOpen = true;

    let inviteLead = null;

    if (inviteTokenHash) {
      const inviteResult = await client.query(
        `SELECT *
         FROM waitlist_leads
         WHERE invite_token_hash = $1
           AND status = 'invited'
           AND accepted_at IS NULL
           AND rejected_at IS NULL
           AND invite_expires_at > NOW()
         FOR UPDATE`,
        [inviteTokenHash]
      );

      if (inviteResult.rows.length === 0) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(403).json({ error: 'This invite link is invalid or has expired.' });
      }

      inviteLead = inviteResult.rows[0];

      if (normalizeEmail(inviteLead.email) !== normalizedEmail) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return res.status(403).json({ error: 'This invite link is tied to a different email address.' });
      }
    }

    // Check if church already exists
    const churchExists = await client.query(
      'SELECT * FROM churches WHERE email = $1',
      [normalizedEmail]
    );

    if (churchExists.rows.length > 0) {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return res.status(400).json({ error: 'Account with this email already exists' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Generate OTP
    const otp = generateOTP();
    const hashedOtp = hashOtp(normalizedEmail, otp, 'verify');
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Insert church with OTP
    const result = await client.query(
      `INSERT INTO churches (church_name, branch_name, email, password, location, logo_url, organization_type, is_verified, otp_code, otp_expires_at, otp_attempts, otp_purpose) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11) 
       RETURNING id, church_name, branch_name, email, location, organization_type`,
      [churchName, branchName, normalizedEmail, hashedPassword, location, logoUrl || null, selectedOrganizationType, false, hashedOtp, otpExpiresAt, 'verify']
    );

    if (inviteLead) {
      await client.query(
        `UPDATE waitlist_leads
         SET status = 'accepted',
             accepted_at = NOW(),
             accepted_church_id = $2,
             invite_token_hash = NULL
         WHERE id = $1`,
        [inviteLead.id, result.rows[0].id]
      );
    }

    await client.query('COMMIT');
    transactionOpen = false;

    // Send OTP email
    await sendOTPEmail(normalizedEmail, otp);
    console.log(`OTP sent to ${normalizedEmail}`);

    res.status(201).json({
      message: 'Registration successful. Please verify your email.',
      requiresVerification: true,
      email: result.rows[0].email,
      organizationType: result.rows[0].organization_type || null
    });
  } catch (error) {
    if (client && transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error('Register rollback error:', rollbackError);
      }
    }
    console.error('Register error:', error);
    res.status(500).json({ error: 'Server error during registration' });
  } finally {
    if (client) {
      client.release();
    }
  }
};

// Login Church
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    // Check if church exists
    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [normalizedEmail]
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
      church: mapChurchProfile(church)
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
    const normalizedEmail = normalizeEmail(email);

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const church = result.rows[0];

    if (church.is_verified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    if (church.otp_purpose && church.otp_purpose !== 'verify') {
      return res.status(400).json({ error: 'Please request a new verification code.' });
    }

    if (hasTooManyOtpAttempts(church)) {
      return res.status(429).json({ error: 'Too many invalid attempts. Please request a new code.' });
    }

    if (hasOtpExpired(church)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    if (!otpMatches(church, normalizedEmail, otp, 'verify')) {
      await incrementOtpAttempts(normalizedEmail);
      return res.status(400).json({ error: 'Invalid OTP code' });
    }

    // Mark as verified and clear OTP
    await pool.query(
      'UPDATE churches SET is_verified = true, otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_purpose = NULL WHERE email = $1',
      [normalizedEmail]
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
    const normalizedEmail = normalizeEmail(email);

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [normalizedEmail]
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
    const hashedOtp = hashOtp(normalizedEmail, otp, 'verify');
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'UPDATE churches SET otp_code = $1, otp_expires_at = $2, otp_attempts = 0, otp_purpose = $3 WHERE email = $4',
      [hashedOtp, otpExpiresAt, 'verify', normalizedEmail]
    );

    await sendOTPEmail(normalizedEmail, otp);
    console.log(`OTP resent to ${normalizedEmail}`);

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
    const normalizedEmail = normalizeEmail(email);

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      // Return success anyway to prevent email enumeration
      return res.json({ message: 'If an account exists with this email, an OTP has been sent.' });
    }

    // Generate OTP
    const otp = generateOTP();
    const hashedOtp = hashOtp(normalizedEmail, otp, 'reset');
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      'UPDATE churches SET otp_code = $1, otp_expires_at = $2, otp_attempts = 0, otp_purpose = $3 WHERE email = $4',
      [hashedOtp, otpExpiresAt, 'reset', normalizedEmail]
    );

    await sendPasswordResetEmail(normalizedEmail, otp);
    console.log(`Password reset OTP sent to ${normalizedEmail}`);

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
    const normalizedEmail = normalizeEmail(email);

    const result = await pool.query(
      'SELECT * FROM churches WHERE email = $1',
      [normalizedEmail]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const church = result.rows[0];

    if (church.otp_purpose && church.otp_purpose !== 'reset') {
      return res.status(400).json({ error: 'Please request a new password reset code.' });
    }

    if (hasTooManyOtpAttempts(church)) {
      return res.status(429).json({ error: 'Too many invalid attempts. Please request a new code.' });
    }

    if (hasOtpExpired(church)) {
      return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
    }

    if (!otpMatches(church, normalizedEmail, otp, 'reset')) {
      await incrementOtpAttempts(normalizedEmail);
      return res.status(400).json({ error: 'Invalid OTP code' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password and clear OTP
    await pool.query(
      'UPDATE churches SET password = $1, otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_purpose = NULL WHERE email = $2',
      [hashedPassword, normalizedEmail]
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
      'SELECT id, church_name, branch_name, email, location, logo_url, organization_type, created_at FROM churches WHERE id = $1',
      [req.churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    res.json(mapChurchProfile(result.rows[0]));
  } catch (error) {
    console.error('Get church error:', error);
    res.status(500).json({ error: 'Server error' });
  }
};
// Update church information
exports.updateChurch = async (req, res) => {
  try {
    const { churchName, branchName, location, logoUrl } = req.body;
    const churchId = req.churchId;

    // If logoUrl is provided, update it too; otherwise keep existing
    let result;
    if (logoUrl !== undefined) {
      result = await pool.query(
        `UPDATE churches 
         SET church_name = $1, branch_name = $2, location = $3, logo_url = $4, updated_at = CURRENT_TIMESTAMP
         WHERE id = $5
         RETURNING id, church_name, branch_name, email, location, logo_url, organization_type`,
        [churchName, branchName, location, logoUrl, churchId]
      );
    } else {
      result = await pool.query(
        `UPDATE churches 
         SET church_name = $1, branch_name = $2, location = $3, updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING id, church_name, branch_name, email, location, logo_url, organization_type`,
        [churchName, branchName, location, churchId]
      );
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    res.json({
      message: 'Workspace information updated successfully',
      church: mapChurchProfile(result.rows[0])
    });
  } catch (error) {
    console.error('Update church error:', error);
    res.status(500).json({ error: 'Server error updating church information' });
  }
};

// Update organization type for account setup and template personalization
exports.updateOrganizationType = async (req, res) => {
  try {
    const { organizationType } = req.body;

    if (!isValidOrganizationType(organizationType)) {
      return res.status(400).json({ error: 'Please choose a valid organization type.' });
    }

    const result = await pool.query(
      `UPDATE churches
       SET organization_type = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, church_name, branch_name, email, location, logo_url, organization_type`,
      [organizationType, req.churchId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    return res.json({
      message: 'Organization type updated successfully',
      church: mapChurchProfile(result.rows[0])
    });
  } catch (error) {
    console.error('Update organization type error:', error);
    return res.status(500).json({ error: 'Server error updating organization type' });
  }
};

// Change Password (authenticated)
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const churchId = req.churchId;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters' });
    }

    // Get church
    const result = await pool.query('SELECT * FROM churches WHERE id = $1', [churchId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    const church = result.rows[0];

    // Verify current password
    const isMatch = await bcrypt.compare(currentPassword, church.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password
    await pool.query(
      'UPDATE churches SET password = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [hashedPassword, churchId]
    );

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error changing password' });
  }
};
