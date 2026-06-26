const express = require('express');
const { body, param } = require('express-validator');
const programController = require('../controllers/programController');
const validate = require('../middleware/validation');

const router = express.Router();

router.get(
  '/:scannerToken',
  [param('scannerToken').isLength({ min: 16 }).withMessage('Invalid RSVP scanner link'), validate],
  programController.getPublicRsvpScanner
);

router.post(
  '/:scannerToken/check-in',
  [
    param('scannerToken').isLength({ min: 16 }).withMessage('Invalid RSVP scanner link'),
    body('token').notEmpty().withMessage('RSVP token is required'),
    validate
  ],
  programController.publicRsvpScannerCheckIn
);

module.exports = router;
