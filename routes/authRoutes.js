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

module.exports = router;