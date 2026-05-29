const express = require('express');
const router = express.Router();
const scanController = require('../controllers/scanController');
const auth = require('../middleware/auth');
const createRateLimiter = require('../middleware/rateLimit');

const scanReadLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 120 });
const scanWriteLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 60 });

// Get program info (public)
router.get('/program/:programId', scanReadLimiter, scanController.getProgramInfo);

// Process scan (public)
router.post('/program/:programId', scanWriteLimiter, scanController.scanQR);

// Submit form data only (public)
router.post('/program/:programId/form', scanWriteLimiter, scanController.submitFormData);

// Submit proxy attendee check-in (public)
router.post('/program/:programId/proxy', scanWriteLimiter, scanController.submitProxyAttendee);

// Update scan data (public)
router.put('/program/:programId/update-scan', scanWriteLimiter, scanController.updateScanData);

// Track sponsor CTA/flyer clicks (public)
router.post('/sponsors/:sponsorId/click', scanWriteLimiter, scanController.trackSponsorClick);

// Get scan records for a program (authenticated)
router.get('/program/:programId/scans', auth, scanController.getScansForProgram);

module.exports = router;
