const pool = require('../config/database');

// ──────────────────────────────────────────────
// GET /api/notifications
// Fetch all notifications for the logged-in church, with read status.
// ──────────────────────────────────────────────
exports.getNotifications = async (req, res) => {
  try {
    const churchId = req.churchId;

    const result = await pool.query(
      `SELECT n.id, n.title, n.message, n.created_at,
              CASE WHEN nr.id IS NOT NULL THEN true ELSE false END AS is_read
       FROM notifications n
       LEFT JOIN notification_reads nr
         ON nr.notification_id = n.id AND nr.church_id = $1
       ORDER BY n.created_at DESC`,
      [churchId]
    );

    const notifications = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      message: row.message,
      createdAt: row.created_at,
      isRead: row.is_read
    }));

    res.json({ notifications });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Server error fetching notifications' });
  }
};

// ──────────────────────────────────────────────
// GET /api/notifications/unread-count
// Return the number of unread notifications for the navbar badge.
// ──────────────────────────────────────────────
exports.getUnreadCount = async (req, res) => {
  try {
    const churchId = req.churchId;

    const result = await pool.query(
      `SELECT COUNT(*) AS unread
       FROM notifications n
       WHERE NOT EXISTS (
         SELECT 1 FROM notification_reads nr
         WHERE nr.notification_id = n.id AND nr.church_id = $1
       )`,
      [churchId]
    );

    res.json({ unreadCount: parseInt(result.rows[0].unread) });
  } catch (error) {
    console.error('Get unread count error:', error);
    res.status(500).json({ error: 'Server error fetching unread count' });
  }
};

// ──────────────────────────────────────────────
// PUT /api/notifications/mark-read
// Mark ALL notifications as read for this church.
// ──────────────────────────────────────────────
exports.markAllRead = async (req, res) => {
  try {
    const churchId = req.churchId;

    // Insert a read row for every notification that doesn't already have one.
    await pool.query(
      `INSERT INTO notification_reads (notification_id, church_id)
       SELECT n.id, $1
       FROM notifications n
       WHERE NOT EXISTS (
         SELECT 1 FROM notification_reads nr
         WHERE nr.notification_id = n.id AND nr.church_id = $1
       )`,
      [churchId]
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark read error:', error);
    res.status(500).json({ error: 'Server error marking notifications as read' });
  }
};

// ──────────────────────────────────────────────
// POST /api/notifications/broadcast
// Create a new system-wide broadcast notification.
// Secured by ADMIN_API_KEY header — founder-only endpoint.
// ──────────────────────────────────────────────
exports.createBroadcast = async (req, res) => {
  try {
    // Verify admin key
    const adminKey = req.header('X-Admin-Key');
    if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(403).json({ error: 'Unauthorized: invalid admin key' });
    }

    const { title, message } = req.body;

    if (!message || message.trim().length === 0) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const result = await pool.query(
      `INSERT INTO notifications (title, message)
       VALUES ($1, $2)
       RETURNING id, title, message, created_at`,
      [title || 'Ingather', message.trim()]
    );

    const notification = result.rows[0];

    console.log(`📢 Broadcast created: "${notification.title}" — ${notification.message.substring(0, 60)}…`);

    res.status(201).json({
      message: 'Broadcast notification created',
      notification: {
        id: notification.id,
        title: notification.title,
        message: notification.message,
        createdAt: notification.created_at
      }
    });
  } catch (error) {
    console.error('Create broadcast error:', error);
    res.status(500).json({ error: 'Server error creating broadcast' });
  }
};
