const express = require('express');
const router = express.Router();
const scanController = require('../controllers/scanController');
const auth = require('../middleware/auth');
const createRateLimiter = require('../middleware/rateLimit');

const parsePositiveInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const sanitizeKeyPart = (value, fallback = 'unknown') => {
  const text = String(value || '').trim();
  return text ? text.slice(0, 500) : fallback;
};

const getClientIp = (req) => sanitizeKeyPart(req.ip || req.socket?.remoteAddress, 'unknown-ip');
const getProgramId = (req) => sanitizeKeyPart(req.params?.programId, 'unknown-program');
const getSponsorId = (req) => sanitizeKeyPart(req.params?.sponsorId, 'unknown-sponsor');
const getDeviceFingerprint = (req) => sanitizeKeyPart(
  req.body?.deviceFingerprint || req.body?.hostDeviceFingerprint || req.get('x-device-fingerprint'),
  `missing-device:${getClientIp(req)}`
);

const scanReadIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SCAN_READ_IP_LIMIT, 1200),
  keyGenerator: (req) => `scan-read:ip:${getClientIp(req)}`,
  message: 'This event page is receiving too many requests. Please wait a moment and try again.'
});

const scanReadProgramLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SCAN_READ_PROGRAM_LIMIT, 3000),
  keyGenerator: (req) => `scan-read:program:${getProgramId(req)}`,
  message: 'This event page is receiving too many requests. Please wait a moment and try again.'
});

const scanWriteIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SCAN_WRITE_IP_LIMIT, 900),
  keyGenerator: (req) => `scan-write:ip:${getClientIp(req)}`,
  message: 'This event is receiving many check-ins right now. Please wait a moment and try again.'
});

const scanWriteProgramLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SCAN_WRITE_PROGRAM_LIMIT, 900),
  keyGenerator: (req) => `scan-write:program:${getProgramId(req)}`,
  message: 'This event is receiving many check-ins right now. Please wait a moment and try again.'
});

const scanWriteDeviceLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SCAN_WRITE_DEVICE_LIMIT, 12),
  keyGenerator: (req) => `scan-write:program:${getProgramId(req)}:device:${getDeviceFingerprint(req)}`,
  message: 'This device is sending check-ins too quickly. Please wait a moment and try again.'
});

const sponsorClickIpLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SPONSOR_CLICK_IP_LIMIT, 600),
  keyGenerator: (req) => `sponsor-click:ip:${getClientIp(req)}`,
  message: 'Sponsor links are receiving many clicks right now. Please wait a moment and try again.'
});

const sponsorClickSponsorLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SPONSOR_CLICK_SPONSOR_LIMIT, 900),
  keyGenerator: (req) => `sponsor-click:sponsor:${getSponsorId(req)}`,
  message: 'Sponsor links are receiving many clicks right now. Please wait a moment and try again.'
});

const sponsorClickDeviceLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: parsePositiveInteger(process.env.SPONSOR_CLICK_DEVICE_LIMIT, 20),
  keyGenerator: (req) => `sponsor-click:sponsor:${getSponsorId(req)}:device:${getDeviceFingerprint(req)}`,
  message: 'This device is opening sponsor links too quickly. Please wait a moment and try again.'
});

const scanReadLimiters = [scanReadIpLimiter, scanReadProgramLimiter];
const scanWriteLimiters = [scanWriteIpLimiter, scanWriteProgramLimiter, scanWriteDeviceLimiter];
const sponsorClickLimiters = [sponsorClickIpLimiter, sponsorClickSponsorLimiter, sponsorClickDeviceLimiter];

// Get program info (public)
router.get('/program/:programId', ...scanReadLimiters, scanController.getProgramInfo);

// Process scan (public)
router.post('/program/:programId', ...scanWriteLimiters, scanController.scanQR);

// Submit form data only (public)
router.post('/program/:programId/form', ...scanWriteLimiters, scanController.submitFormData);

// Submit proxy attendee check-in (public)
router.post('/program/:programId/proxy', ...scanWriteLimiters, scanController.submitProxyAttendee);

// Update scan data (public)
router.put('/program/:programId/update-scan', ...scanWriteLimiters, scanController.updateScanData);

// Track sponsor CTA/flyer clicks (public)
router.post('/sponsors/:sponsorId/click', ...sponsorClickLimiters, scanController.trackSponsorClick);

// Get scan records for a program (authenticated)
router.get('/program/:programId/scans', auth, scanController.getScansForProgram);

module.exports = router;
