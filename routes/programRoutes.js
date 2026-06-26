const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const programController = require('../controllers/programController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validation');

// Create program (protected)
router.post(
  '/',
  auth,
  [
    body('programTitle').notEmpty().withMessage('Program title is required'),
    body('date').notEmpty().withMessage('Date is required'),
    body('startTime').notEmpty().withMessage('Start time is required'),
    body('endTime').notEmpty().withMessage('End time is required'),
    body('trackingMode').isIn(['count-only', 'collect-data']).withMessage('Invalid tracking mode'),
    body('dataFieldConfig').optional().isObject().withMessage('Data field config must be an object'),
    body('flyerType').optional().isIn(['standard', 'personalized']).withMessage('Invalid flyer type'),
    body('sponsorDisplayMode').optional().isIn(['carousel', 'distribution']).withMessage('Invalid sponsor display mode'),
    body('strictDeviceFingerprinting').optional().isBoolean().withMessage('Invalid strict device fingerprinting value'),
    validate
  ],
  programController.createProgram
);

// Get all programs (protected)
router.get('/', auth, programController.getPrograms);

// Get dashboard stats with date filtering (protected)
router.get('/dashboard-stats', auth, programController.getDashboardStats);

// Get dashboard bootstrap data with church, notifications, and stats (protected)
router.get('/dashboard-bootstrap', auth, programController.getDashboardBootstrap);

// Get program detail bootstrap data (protected)
router.get('/:id/detail-bootstrap', auth, programController.getProgramDetailBootstrap);

// Get sponsor engagement analytics (protected)
router.get('/:id/sponsor-analytics', auth, programController.getSponsorAnalytics);

// Create a shareable RSVP scanner link (protected)
router.get('/:id/rsvp-scanner-link', auth, programController.getRsvpScannerLink);

// Get single program (protected)
router.get('/:id', auth, programController.getProgramById);

// Update strict device fingerprinting setting (protected)
router.put(
  '/:id/strict-device-fingerprinting',
  auth,
  [
    body('strictDeviceFingerprinting').isBoolean().withMessage('Strict device fingerprinting value is required'),
    validate
  ],
  programController.updateStrictDeviceFingerprinting
);

// Stop program (protected)
router.put('/:id/stop', auth, programController.stopProgram);

// Get attendees (protected)
router.get('/:id/attendees', auth, programController.getAttendees);

// Manually add attendee/check-in (protected)
router.post(
  '/:id/attendees/manual',
  auth,
  [
    body('formData').isObject().withMessage('Attendee data is required'),
    validate
  ],
  programController.addManualAttendee
);

router.post(
  '/:id/rsvp-qr-checkin',
  auth,
  [
    body('token').notEmpty().withMessage('RSVP QR token is required'),
    validate
  ],
  programController.checkInRsvpQr
);

// Get attendance over time (protected)
router.get('/:id/attendance-data', auth, programController.getAttendanceOverTime);

// Get count-only statistics (protected)
router.get('/:id/count-stats', auth, programController.getCountOnlyStats);

// Mark winner as gifted (protected)
router.put('/:id/attendees/:attendeeId/gift-claimed', auth, programController.markWinnerGifted);

// Delete program (protected)
router.delete('/:id', auth, programController.deleteProgram);

module.exports = router;
