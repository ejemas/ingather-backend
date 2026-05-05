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
    validate
  ],
  programController.createProgram
);

// Get all programs (protected)
router.get('/', auth, programController.getPrograms);

// Get dashboard stats with date filtering (protected)
router.get('/dashboard-stats', auth, programController.getDashboardStats);

// Get single program (protected)
router.get('/:id', auth, programController.getProgramById);

// Stop program (protected)
router.put('/:id/stop', auth, programController.stopProgram);

// Get attendees (protected)
router.get('/:id/attendees', auth, programController.getAttendees);

// Get attendance over time (protected)
router.get('/:id/attendance-data', auth, programController.getAttendanceOverTime);

// Get count-only statistics (protected)
router.get('/:id/count-stats', auth, programController.getCountOnlyStats);

// Mark winner as gifted (protected)
router.put('/:id/attendees/:attendeeId/gift-claimed', auth, programController.markWinnerGifted);

// Delete program (protected)
router.delete('/:id', auth, programController.deleteProgram);

module.exports = router;