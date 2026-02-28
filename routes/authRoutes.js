const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const authController = require('../controllers/authController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validation');

// Register
router.post(
  '/register',
  [
    body('churchName').notEmpty().withMessage('Church name is required'),
    body('branchName').notEmpty().withMessage('Branch name is required'),
    body('email').isEmail().withMessage('Valid email is required'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('location').notEmpty().withMessage('Location is required'),
    validate
  ],
  authController.register
);

// Login
router.post(
  '/login',
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

// Verify OTP
router.post(
  '/verify-otp',
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
  [
    body('email').isEmail().withMessage('Valid email is required'),
    validate
  ],
  authController.resendOtp
);

// Forgot Password
router.post(
  '/forgot-password',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    validate
  ],
  authController.forgotPassword
);

// Reset Password
router.post(
  '/reset-password',
  [
    body('email').isEmail().withMessage('Valid email is required'),
    body('otp').notEmpty().withMessage('OTP is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    validate
  ],
  authController.resetPassword
);

module.exports = router;