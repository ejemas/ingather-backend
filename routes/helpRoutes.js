const express = require('express');
const helpController = require('../controllers/helpController');
const auth = require('../middleware/auth');
const createRateLimiter = require('../middleware/rateLimit');

const router = express.Router();

// Stops runaway ticket or reply spam from one workspace.
const writeLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 30,
  keyGenerator: (req) => `help-write:church:${req.churchId || req.ip}`,
  message: 'You have sent a lot of messages in the last hour. Please wait a little, then try again.'
});

router.get('/tickets', auth, helpController.listTickets);
router.get('/events', auth, helpController.listEventOptions);
router.post('/tickets', auth, writeLimiter, helpController.createTicket);
router.get('/tickets/:number', auth, helpController.getTicket);
router.post('/tickets/:number/messages', auth, writeLimiter, helpController.replyToTicket);
router.put('/tickets/:number/solve', auth, helpController.solveTicket);

module.exports = router;
