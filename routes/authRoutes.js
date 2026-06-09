const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validation');
const createRateLimiter = require('../middleware/rateLimit');

const emailKey = (req) => `${req.ip}:${String(req.body?.email || '').toLowerCase()}`;
const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 8 });
const loginLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 12, keyGenerator: emailKey });
const otpVerifyLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 8, keyGenerator: emailKey });
const otpSendLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 4, keyGenerator: emailKey });
const passwordResetLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 6, keyGenerator: emailKey });
const organizationTypes = [
  'general',
  'techMeetup',
  'conference',
  'seminar',
  'bootcamp',
  'corporateEvent',
  'church',
  'communityGathering'
];

const isInviteOnlyMode = () => process.env.INVITE_ONLY_MODE !== 'false';

const blockRegistrationWhenInviteOnly = (req, res, next) => {
  if (!isInviteOnlyMode()) {
    return next();
  }

  if (req.body?.inviteToken) {
    return next();
  }

  return res.status(403).json({
    error: 'Ingather is currently invite-only. Join the waitlist to request access.',
    inviteOnly: true
  });
};

// Register
router.post(
  '/register',
  registerLimiter,
  blockRegistrationWhenInviteOnly,
  [
    body('churchName').notEmpty().withMessage('Church name is required'),
    body('branchName').notEmpty().withMessage('Branch name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('location').notEmpty().withMessage('Location is required'),
    body('inviteToken').optional({ nullable: true }).isLength({ min: 20, max: 200 }).withMessage('Valid invite token is required'),
    body('organizationType')
      .optional({ nullable: true })
      .isIn(organizationTypes)
      .withMessage('Valid organization type is required'),
    validate
  ],
  authController.register
);

// Login
router.post(
  '/login',
  loginLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').notEmpty().withMessage('Password is required'),
    validate
  ],
  authController.login
);

// Get current church (protected)
router.get('/me', auth, authController.getCurrentChurch);

// Update church info (protected)
router.put('/update', auth, authController.updateChurch);

// Update organization type for account setup (protected)
router.put(
  '/organization-type',
  auth,
  [
    body('organizationType')
      .isIn(organizationTypes)
      .withMessage('Valid organization type is required'),
    validate
  ],
  authController.updateOrganizationType
);

// Change password (protected)
router.put('/change-password', auth, authController.changePassword);

// Verify OTP
router.post(
  '/verify-otp',
  otpVerifyLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
    validate
  ],
  authController.verifyOtp
);

// Resend OTP
router.post(
  '/resend-otp',
  otpSendLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    validate
  ],
  authController.resendOtp
);

// Forgot Password
router.post(
  '/forgot-password',
  passwordResetLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    validate
  ],
  authController.forgotPassword
);

// Reset Password
router.post(
  '/reset-password',
  passwordResetLimiter,
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    validate
  ],
  authController.resetPassword
);

module.exports = router;
