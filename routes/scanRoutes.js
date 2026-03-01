const express = require('express');
const router = express.Router();
const scanController = require('../controllers/scanController');

// Get program info (public)
router.get('/program/:programId', scanController.getProgramInfo);

// Process scan (public)
router.post('/program/:programId', scanController.scanQR);

// Submit form data only (public)
router.post('/program/:programId/form', scanController.submitFormData);

// Update scan data (public)
router.put('/program/:programId/update-scan', scanController.updateScanData);

// Get scan records for a program (authenticated)
router.get('/program/:programId/scans', scanController.getScansForProgram);

module.exports = router;