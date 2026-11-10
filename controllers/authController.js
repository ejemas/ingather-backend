const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../config/database');
const { notePasswordChanged } = require('../utils/sessionGuard');
const {
  generateOTP,
  sendDeviceCodeEmail,
  sendOTPEmail,
  sendPasswordResetEmail,
  sendSigninAlertEmail
} = require('../utils/emailService');
const { hashInviteToken } = require('../utils/waitlistInviteService');
const { getPasswordProblem } = require('../utils/passwordPolicy');
const { uploadEventFlyer, deleteEventFlyer } = require('../utils/supabaseStorage');
const {
  DEVICE_CODE_MAX_ATTEMPTS,
  DEVICE_CODE_MAX_RESENDS,
  DEVICE_CODE_RESEND_GAP_MS,
  DEVICE_CODE_TTL_MS,
  TRUSTED_DEVICE_DAYS,
  describeDevice,
  formatLagosTime,
  hashDeviceCode,
  hashDeviceId,
  isDeviceCheckEnabled,
  isMissingTableError,
  maskEmail,
  safeEqualHex
} = require('../utils/deviceCheck');

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

const LOGIN_TOKEN_DAYS = 7;
const REMEMBERED_LOGIN_TOKEN_DAYS = 30;

const signLoginToken = (church, remember) => jwt.sign(
  { churchId: church.id, email: church.email },
  process.env.JWT_SECRET,
  { expiresIn: `${remember ? REMEMBERED_LOGIN_TOKEN_DAYS : LOGIN_TOKEN_DAYS}d` }
);

// Saves a new password and records when it changed, which signs out other devices.
// Falls back to the old update if the password_changed_at column has not been added yet.
const savePassword = async (whereSql, params) => {
  try {
    const result = await pool.query(`UPDATE churches SET ${whereSql.set}, password_changed_at = NOW() WHERE ${whereSql.where} RETURNING id, password_changed_at`, params);
    if (result.rows[0]) notePasswordChanged(result.rows[0].id, result.rows[0].password_changed_at);
    return result.rows[0] || null;
  } catch (error) {
    if (error.code !== '42703') throw error;
    const result = await pool.query(`UPDATE churches SET ${whereSql.set} WHERE ${whereSql.where} RETURNING id`, params);
    return result.rows[0] || null;
  }
};

const getFrontendBaseUrl = () => (process.env.FRONTEND_URL || 'https://ingather.app').replace(/\/+$/, '');

const isTrueFlag = (value) => value === true || value === 'true' || value === 1 || value === '1';

// Uploads the logo chosen at sign-up. Never blocks registration: on any
// problem the workspace is still created and the logo can be added later.
const saveSignupLogo = async (churchId, logoDataUrl) => {
  if (!logoDataUrl || typeof logoDataUrl !== 'string') return null;
  try {
    const uploaded = await uploadEventFlyer({ churchId, dataUrl: logoDataUrl, folder: 'logo' });
    await pool.query('UPDATE churches SET logo_url = $1 WHERE id = $2', [uploaded.flyerUrl, churchId]);
    return uploaded.flyerUrl;
  } catch (error) {
    console.error('Sign-up logo upload failed:', error.message);
    return null;
  }
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
    const { churchName, branchName, email, password, location, logoUrl, logoDataUrl, organizationType, inviteToken } = req.body;

    const passwordIssue = getPasswordProblem(password);
    if (passwordIssue) {
      return res.status(400).json({ error: passwordIssue });
    }
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
      if (!churchExists.rows[0].is_verified) {
        // The workspace was created earlier but the email was never verified
        return res.status(409).json({
          error: 'This email already has a workspace waiting to be verified. Enter the code from your email, or press Resend code.',
          requiresVerification: true,
          email: churchExists.rows[0].email
        });
      }
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

    // From here the workspace exists, so nothing below may turn this into an error:
    // a failed logo or email must not leave the person with a "server error" and a
    // used-up invite. They can resend the code from the next screen.

    // Save the sign-up logo, if one was chosen (never blocks registration)
    await saveSignupLogo(result.rows[0].id, logoDataUrl);

    // Send OTP email
    let emailSent = true;
    try {
      await sendOTPEmail(normalizedEmail, otp);
      console.log(`OTP sent to ${normalizedEmail}`);
    } catch (emailError) {
      emailSent = false;
      console.error('Register: workspace created but the verification email failed:', emailError.message);
    }

    res.status(201).json({
      message: emailSent
        ? 'Registration successful. Please verify your email.'
        : 'Workspace created, but we could not send the code. Press Resend code.',
      requiresVerification: true,
      emailSent,
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
    const { email, password, deviceId, remember } = req.body;
    const normalizedEmail = normalizeEmail(email);
    const rememberLogin = isTrueFlag(remember);

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

    // New-device check (only when DEVICE_CHECK_ENABLED=true)
    if (isDeviceCheckEnabled()) {
      const challenge = await startDeviceChallenge({
        church,
        deviceId,
        userAgent: req.get('user-agent'),
        rememberLogin
      });

      if (challenge && challenge.error) {
        return res.status(challenge.status || 500).json({ error: challenge.error });
      }

      if (challenge) {
        return res.json(challenge);
      }
    }

    const token = signLoginToken(church, rememberLogin);

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

    const passwordIssue = getPasswordProblem(newPassword);
    if (passwordIssue) {
      return res.status(400).json({ error: passwordIssue });
    }

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
    // Also signs out every device that was signed in with the old password.
    await savePassword(
      { set: 'password = $1, otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0, otp_purpose = NULL', where: 'email = $2' },
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
const cleanProfileText = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Only remove logo files this workspace owns in our own storage bucket.
const removeStoredLogo = (churchId, logoUrl) => {
  const match = /\/storage\/v1\/object\/public\/[^/]+\/(church-(\d+)\/logo\/[^?#]+)$/.exec(String(logoUrl || ''));
  if (!match || Number(match[2]) !== Number(churchId)) return;
  deleteEventFlyer(decodeURIComponent(match[1])).catch((error) => {
    console.error('Old logo cleanup warning:', error.message);
  });
};

exports.updateChurch = async (req, res) => {
  try {
    const churchId = req.churchId;
    const churchName = cleanProfileText(req.body.churchName, 120);
    const branchName = cleanProfileText(req.body.branchName, 120);
    const location = cleanProfileText(req.body.location, 200);
    const { logoUrl } = req.body;

    const fieldErrors = {};
    if (!churchName) fieldErrors.churchName = 'Add your organisation name.';
    if (!branchName) fieldErrors.branchName = 'Add a team, branch or location.';
    if (Object.keys(fieldErrors).length > 0) {
      return res.status(400).json({ error: 'Fill in the fields marked in red to save.', fieldErrors });
    }

    // Logos now go through PUT /auth/logo. A logoUrl here is only accepted as a
    // web link or null so large images are never stored in the database.
    const acceptLogo = logoUrl === null || (typeof logoUrl === 'string' && /^https:\/\//i.test(logoUrl));

    let result;
    if (acceptLogo) {
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

// Upload or replace the workspace logo (already resized in the browser).
exports.updateLogo = async (req, res) => {
  try {
    const churchId = req.churchId;
    const { logoDataUrl } = req.body;
    if (typeof logoDataUrl !== 'string' || !/^data:image\/(png|jpe?g|webp);base64,/i.test(logoDataUrl)) {
      return res.status(400).json({ error: 'Use a PNG, JPG or WebP image.' });
    }

    const current = await pool.query('SELECT logo_url FROM churches WHERE id = $1', [churchId]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }

    let uploaded;
    try {
      uploaded = await uploadEventFlyer({ churchId, dataUrl: logoDataUrl, folder: 'logo' });
    } catch (uploadError) {
      console.error('Logo upload failed:', uploadError.message);
      const tooLarge = /too large/i.test(uploadError.message);
      return res.status(tooLarge ? 413 : 400).json({
        error: tooLarge ? 'That file is too big. Use an image under 5 MB.' : 'We could not upload that image. Try a PNG or JPG.'
      });
    }

    const result = await pool.query(
      `UPDATE churches SET logo_url = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2
       RETURNING id, church_name, branch_name, email, location, logo_url, organization_type`,
      [uploaded.flyerUrl, churchId]
    );
    removeStoredLogo(churchId, current.rows[0].logo_url);

    return res.json({ message: 'Logo updated', church: mapChurchProfile(result.rows[0]) });
  } catch (error) {
    console.error('Update logo error:', error);
    return res.status(500).json({ error: 'Server error updating logo' });
  }
};

exports.removeLogo = async (req, res) => {
  try {
    const churchId = req.churchId;
    const current = await pool.query('SELECT logo_url FROM churches WHERE id = $1', [churchId]);
    if (current.rows.length === 0) {
      return res.status(404).json({ error: 'Church not found' });
    }
    const result = await pool.query(
      `UPDATE churches SET logo_url = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, church_name, branch_name, email, location, logo_url, organization_type`,
      [churchId]
    );
    removeStoredLogo(churchId, current.rows[0].logo_url);
    return res.json({ message: 'Logo removed', church: mapChurchProfile(result.rows[0]) });
  } catch (error) {
    console.error('Remove logo error:', error);
    return res.status(500).json({ error: 'Server error removing logo' });
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

    const passwordIssue = getPasswordProblem(newPassword);
    if (passwordIssue) {
      return res.status(400).json({ error: passwordIssue });
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
      return res.status(400).json({
        error: 'That password is not right. Try again or reset it from the sign-in page.',
        code: 'WRONG_CURRENT_PASSWORD'
      });
    }

    if (await bcrypt.compare(newPassword, church.password)) {
      return res.status(400).json({ error: 'Pick a new password that is different from your current one.', code: 'SAME_PASSWORD' });
    }

    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Update password. Other devices are signed out; this one gets a fresh sign-in so it stays in.
    await savePassword({ set: 'password = $1, updated_at = CURRENT_TIMESTAMP', where: 'id = $2' }, [hashedPassword, churchId]);
    const remembered = Boolean(req.tokenExp) && (req.tokenExp * 1000 - Date.now()) > (LOGIN_TOKEN_DAYS + 1) * 24 * 60 * 60 * 1000;

    res.json({ message: 'Password changed successfully', token: signLoginToken(church, remembered), otherDevicesSignedOut: true });
  } catch (error) {
    console.error('Change password error:', error);
    res.status(500).json({ error: 'Server error changing password' });
  }
};


/* ------------------------------------------------------------------
 * New-device check
 * ------------------------------------------------------------------ */

// Returns null when the device is already trusted (or the check cannot run
// because its tables are missing), an object to send back when a code was
// emailed, or { error, status } when the code could not be sent.
const startDeviceChallenge = async ({ church, deviceId, userAgent, rememberLogin }) => {
  const deviceHash = hashDeviceId(deviceId);
  const deviceLabel = describeDevice(userAgent);

  try {
    const trusted = await pool.query(
      `UPDATE trusted_devices
       SET last_used_at = NOW()
       WHERE church_id = $1 AND device_hash = $2 AND expires_at > NOW()
       RETURNING id`,
      [church.id, deviceHash]
    );

    if (trusted.rows.length > 0) {
      return null;
    }

    const challengeResult = await pool.query(
      `INSERT INTO device_login_challenges
         (church_id, device_hash, device_label, code_hash, remember_login, expires_at)
       VALUES ($1, $2, $3, 'pending', $4, NOW() + INTERVAL '10 minutes')
       RETURNING id`,
      [church.id, deviceHash, deviceLabel, Boolean(rememberLogin)]
    );
    const challengeId = challengeResult.rows[0].id;
    const code = generateOTP();

    await pool.query(
      'UPDATE device_login_challenges SET code_hash = $1 WHERE id = $2',
      [hashDeviceCode(challengeId, code), challengeId]
    );

    const emailResult = await sendDeviceCodeEmail({
      email: church.email,
      code,
      deviceLabel,
      time: formatLagosTime()
    });

    if (!emailResult.sent) {
      await pool.query('UPDATE device_login_challenges SET consumed_at = NOW() WHERE id = $1', [challengeId]);
      return { status: 503, error: "We couldn't send your sign-in code. Please try again in a minute." };
    }

    return {
      requiresDeviceVerification: true,
      challengeId,
      maskedEmail: maskEmail(church.email),
      deviceLabel,
      expiresInSeconds: Math.round(DEVICE_CODE_TTL_MS / 1000),
      resendInSeconds: Math.round(DEVICE_CODE_RESEND_GAP_MS / 1000)
    };
  } catch (error) {
    if (isMissingTableError(error)) {
      console.warn('Device check is on but its tables are missing. Run the device check SQL script. Logging in without the check.');
      return null;
    }
    throw error;
  }
};

const loadChallenge = async (challengeId) => {
  if (!/^[0-9a-f-]{36}$/i.test(String(challengeId || ''))) return null;
  const result = await pool.query(
    `SELECT dlc.*, c.email, c.church_name, c.is_verified,
            (dlc.expires_at <= NOW()) AS is_expired,
            EXTRACT(EPOCH FROM (NOW() - dlc.last_sent_at)) AS seconds_since_send
     FROM device_login_challenges dlc
     JOIN churches c ON c.id = dlc.church_id
     WHERE dlc.id = $1`,
    [challengeId]
  );
  return result.rows[0] || null;
};

// Confirm a new device with the emailed code
exports.verifyDevice = async (req, res) => {
  try {
    const { challengeId, code, deviceId, rememberDevice } = req.body;
    const challenge = await loadChallenge(challengeId);

    if (!challenge || challenge.consumed_at) {
      return res.status(400).json({ error: 'This sign-in has ended. Please log in again.', restart: true });
    }

    if (!safeEqualHex(challenge.device_hash, hashDeviceId(deviceId))) {
      return res.status(400).json({ error: 'Please finish signing in on the device that asked for the code.', restart: true });
    }

    if (challenge.is_expired) {
      return res.status(410).json({ error: 'This code has expired. Send a new one to keep going.', expired: true });
    }

    if (Number(challenge.attempts) >= DEVICE_CODE_MAX_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many wrong codes. Send a new one to keep going.', expired: true });
    }

    if (!safeEqualHex(challenge.code_hash, hashDeviceCode(challenge.id, code))) {
      const updated = await pool.query(
        'UPDATE device_login_challenges SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts',
        [challenge.id]
      );
      const attemptsLeft = Math.max(0, DEVICE_CODE_MAX_ATTEMPTS - Number(updated.rows[0]?.attempts || 0));
      return res.status(400).json({
        error: attemptsLeft > 0
          ? `That code isn't right. You have ${attemptsLeft} ${attemptsLeft === 1 ? 'try' : 'tries'} left.`
          : 'Too many wrong codes. Send a new one to keep going.',
        attemptsLeft,
        expired: attemptsLeft === 0
      });
    }

    const consumed = await pool.query(
      'UPDATE device_login_challenges SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL RETURNING id',
      [challenge.id]
    );
    if (consumed.rows.length === 0) {
      return res.status(400).json({ error: 'This sign-in has ended. Please log in again.', restart: true });
    }

    if (isTrueFlag(rememberDevice)) {
      await pool.query(
        `INSERT INTO trusted_devices (church_id, device_hash, device_label, expires_at)
         VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)
         ON CONFLICT (church_id, device_hash)
         DO UPDATE SET device_label = EXCLUDED.device_label, last_used_at = NOW(), expires_at = EXCLUDED.expires_at`,
        [challenge.church_id, challenge.device_hash, challenge.device_label, String(TRUSTED_DEVICE_DAYS)]
      );
    }

    const churchResult = await pool.query('SELECT * FROM churches WHERE id = $1', [challenge.church_id]);
    const church = churchResult.rows[0];
    if (!church) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const token = signLoginToken(church, challenge.remember_login);

    // Security alert to the account email. A failure here never blocks sign-in.
    sendSigninAlertEmail({
      email: church.email,
      workspaceName: church.church_name,
      deviceLabel: challenge.device_label,
      time: formatLagosTime(),
      resetLink: `${getFrontendBaseUrl()}/forgot-password`
    }).catch((error) => console.error('Sign-in alert email error:', error.message));

    return res.json({
      message: 'Login successful',
      token,
      church: mapChurchProfile(church)
    });
  } catch (error) {
    console.error('Verify device error:', error);
    return res.status(500).json({ error: 'Server error while checking your code' });
  }
};

// Send a fresh code for the same sign-in
exports.resendDeviceCode = async (req, res) => {
  try {
    const { challengeId, deviceId } = req.body;
    const challenge = await loadChallenge(challengeId);

    if (!challenge || challenge.consumed_at) {
      return res.status(400).json({ error: 'This sign-in has ended. Please log in again.', restart: true });
    }

    if (!safeEqualHex(challenge.device_hash, hashDeviceId(deviceId))) {
      return res.status(400).json({ error: 'Please finish signing in on the device that asked for the code.', restart: true });
    }

    // Time maths is done by the database, so server and database time zones never disagree
    const sinceLastSend = Number(challenge.seconds_since_send || 0) * 1000;
    if (sinceLastSend < DEVICE_CODE_RESEND_GAP_MS) {
      return res.status(429).json({
        error: 'Please wait a moment before asking for another code.',
        resendInSeconds: Math.ceil((DEVICE_CODE_RESEND_GAP_MS - sinceLastSend) / 1000)
      });
    }

    if (Number(challenge.resend_count) >= DEVICE_CODE_MAX_RESENDS) {
      return res.status(429).json({ error: 'Too many codes sent. Please log in again.', restart: true });
    }

    const code = generateOTP();
    await pool.query(
      `UPDATE device_login_challenges
       SET code_hash = $1, attempts = 0, resend_count = resend_count + 1,
           last_sent_at = NOW(), expires_at = NOW() + INTERVAL '10 minutes'
       WHERE id = $2`,
      [hashDeviceCode(challenge.id, code), challenge.id]
    );

    const emailResult = await sendDeviceCodeEmail({
      email: challenge.email,
      code,
      deviceLabel: challenge.device_label,
      time: formatLagosTime()
    });

    if (!emailResult.sent) {
      return res.status(503).json({ error: "We couldn't send a new code. Please try again in a minute." });
    }

    return res.json({
      message: 'A new code is on its way.',
      expiresInSeconds: Math.round(DEVICE_CODE_TTL_MS / 1000),
      resendInSeconds: Math.round(DEVICE_CODE_RESEND_GAP_MS / 1000)
    });
  } catch (error) {
    console.error('Resend device code error:', error);
    return res.status(500).json({ error: 'Server error while sending a new code' });
  }
};
