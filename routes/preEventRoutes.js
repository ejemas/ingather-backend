const express = require('express');
const { body, param } = require('express-validator');
const preEventController = require('../controllers/preEventController');
const auth = require('../middleware/auth');
const validate = require('../middleware/validation');

const router = express.Router();

const preEventValidators = [
  body('title').notEmpty().withMessage('Event name is required'),
  body('eventDate').notEmpty().withMessage('Event date and time is required'),
  body('description').optional({ nullable: true }).isString().withMessage('Description must be text'),
  body('venueName').optional({ nullable: true }).isString().withMessage('Venue name must be text'),
  body('city').optional({ nullable: true }).isString().withMessage('City must be text'),
  body('programId').optional({ nullable: true, checkFalsy: true }).isInt().withMessage('Linked program must be a valid program'),
  body('rsvpFields').optional().isObject().withMessage('RSVP fields must be an object'),
  body('rsvpFieldConfig').optional().isObject().withMessage('RSVP field config must be an object'),
  body('discoverEnabled').optional().isBoolean().withMessage('Discover visibility must be true or false'),
  body('virtualAttendanceEnabled').optional().isBoolean().withMessage('Virtual attendance tracking must be true or false'),
  body('isRsvpActive').optional().isBoolean().withMessage('RSVP active value must be true or false')
];

router.get('/discover', preEventController.getDiscoverPreEvents);

router.get(
  '/public/:slug',
  [param('slug').isLength({ min: 3 }).withMessage('Invalid RSVP link'), validate],
  preEventController.getPublicPreEvent
);

router.post(
  '/public/:slug/rsvps',
  [
    param('slug').isLength({ min: 3 }).withMessage('Invalid RSVP link'),
    body('formData').optional().isObject().withMessage('RSVP form data must be an object'),
    validate
  ],
  preEventController.submitPublicRsvp
);

router.post('/', auth, preEventValidators, validate, preEventController.createPreEvent);
router.get('/', auth, preEventController.getPreEvents);
router.get('/qr-email-quota', auth, preEventController.getQrEmailQuota);

router.get(
  '/:id',
  auth,
  [param('id').isInt().withMessage('Invalid pre-event ID'), validate],
  preEventController.getPreEventById
);

router.post(
  '/:id/rsvps/import',
  auth,
  [
    param('id').isInt().withMessage('Invalid pre-event ID'),
    body('rows')
      .isArray({ min: 1, max: 5000 })
      .withMessage('Import between 1 and 5,000 attendee rows'),
    validate
  ],
  preEventController.importPreEventRsvps
);

router.post(
  '/:id/rsvps/send-imported-qr-batch',
  auth,
  [
    param('id').isInt().withMessage('Invalid pre-event ID'),
    validate
  ],
  preEventController.sendImportedRsvpQrBatch
);

router.post(
  '/:id/rsvps/:rsvpId/resend-qr',
  auth,
  [
    param('id').isInt().withMessage('Invalid pre-event ID'),
    param('rsvpId').isInt().withMessage('Invalid RSVP ID'),
    validate
  ],
  preEventController.resendRsvpQrEmail
);

router.post(
  '/:id/rsvps/manual',
  auth,
  [
    param('id').isInt().withMessage('Invalid pre-event ID'),
    body('formData').optional().isObject().withMessage('RSVP form data must be an object'),
    body('sendQrEmail').optional().isBoolean().withMessage('Send QR email must be true or false'),
    validate
  ],
  preEventController.createManualRsvp
);

router.put(
  '/:id',
  auth,
  [
    param('id').isInt().withMessage('Invalid pre-event ID'),
    ...preEventValidators,
    validate
  ],
  preEventController.updatePreEvent
);

router.delete(
  '/:id',
  auth,
  [param('id').isInt().withMessage('Invalid pre-event ID'), validate],
  preEventController.deletePreEvent
);

module.exports = router;
