const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');
const auth = require('../middleware/auth');

// Get all notifications for the logged-in church (protected)
router.get('/', auth, notificationController.getNotifications);

// Get unread notification count (protected)
router.get('/unread-count', auth, notificationController.getUnreadCount);

// Mark all notifications as read (protected)
router.put('/mark-read', auth, notificationController.markAllRead);

// Create a broadcast notification (admin-only, secured by X-Admin-Key header)
router.post('/broadcast', notificationController.createBroadcast);

module.exports = router;
