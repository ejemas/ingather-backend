const express = require('express');
const { body } = require('express-validator');
const waitlistController = require('../controllers/waitlistController');
const validate = require('../middleware/validation');
const createRateLimiter = require('../middleware/rateLimit');

const router = express.Router();

const waitlistLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 8,
  keyGenerator: (req) => `${req.ip}:waitlist:${String(req.body?.email || '').trim().toLowerCase()}`,
  message: 'Too many waitlist attempts. Please try again in a few minutes.'
});

router.get('/admin/leads', waitlistController.getAdminLeads);
router.post('/admin/leads/:id/invite', waitlistController.inviteLead);
router.post('/admin/leads/:id/reject', waitlistController.rejectLead);
router.post('/admin/leads/:id/revoke', waitlistController.revokeLead);

router.get('/invite/:token', waitlistController.validateInvite);

router.post(
  '/',
  waitlistLimiter,
  [
    body('firstName').trim().notEmpty().withMessage('First name is required').isLength({ max: 80 }),
    body('lastName').trim().notEmpty().withMessage('Last name is required').isLength({ max: 80 }),
    body('email').trim().isEmail().withMessage('Valid email is required').isLength({ max: 255 }),
    body('organizationName').optional({ nullable: true }).trim().isLength({ max: 180 }),
    body('eventSize').isIn(['1-50', '50-200', '200-500', '500+']).withMessage('Valid event size is required'),
    body('website').optional({ nullable: true }).trim().isLength({ max: 200 }),
    validate
  ],
  waitlistController.joinWaitlist
);

module.exports = router;
