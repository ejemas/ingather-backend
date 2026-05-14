// Force IPv4 DNS resolution — Render cannot reach Gmail SMTP over IPv6
// Server v1.1 — Notifications system added
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const http = require('http');
const socketIo = require('socket.io');
require('dotenv').config();

const app = express();
const server = http.createServer(app);

app.set('trust proxy', 1);
app.disable('x-powered-by');

const configuredOrigins = (process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

const allowedOrigins = [
  process.env.FRONTEND_URL,
  ...configuredOrigins,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://ingather.app',
  'https://www.ingather.app'
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
};

const io = socketIo(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

// Middleware
app.use(cors(corsOptions));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// Make io accessible to routes
app.set('io', io);

// Import routes
const authRoutes = require('./routes/authRoutes');
const programRoutes = require('./routes/programRoutes');
const scanRoutes = require('./routes/scanRoutes');
const notificationRoutes = require('./routes/notificationRoutes');

// API Routes
app.get('/', (req, res) => {
  res.json({ message: 'Ingather API is running!' });
});

app.use('/api/auth', authRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/notifications', notificationRoutes);

// Socket.io connection
io.on('connection', (socket) => {
  console.log('✅ New client connected:', socket.id);

  // Join program room for real-time updates
  socket.on('join-program', (programId) => {
    socket.join(`program-${programId}`);
    console.log(`Client ${socket.id} joined program ${programId}`);
  });

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

// Auto-migrate: add is_gifted column if it doesn't exist
const pool = require('./config/database');
pool.query(`ALTER TABLE attendees ADD COLUMN IF NOT EXISTS is_gifted BOOLEAN DEFAULT FALSE`)
  .then(() => console.log('✅ Migration check: is_gifted column ready'))
  .catch(err => console.error('Migration warning:', err.message));

// Auto-migrate: add security columns needed by scan tokens and OTP hardening
pool.query(`
  ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_token_hash VARCHAR(128);
  ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_token_expires_at TIMESTAMP;
  ALTER TABLE churches ALTER COLUMN otp_code TYPE VARCHAR(255);
  ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_attempts INTEGER DEFAULT 0;
  ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_purpose VARCHAR(30);
`)
  .then(() => console.log('Migration check: security columns ready'))
  .catch(err => console.error('Migration warning (security columns):', err.message));

// Auto-migrate: add optional program flyer metadata columns if they don't exist
pool.query(`
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_url TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_storage_path TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_original_name VARCHAR(255);
`)
  .then(() => console.log('Migration check: program flyer columns ready'))
  .catch(err => console.error('Migration warning (program flyers):', err.message));

// Auto-migrate: create notifications tables if they don't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL DEFAULT 'Ingather',
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS notification_reads (
    id SERIAL PRIMARY KEY,
    notification_id INTEGER REFERENCES notifications(id) ON DELETE CASCADE,
    church_id INTEGER REFERENCES churches(id) ON DELETE CASCADE,
    read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(notification_id, church_id)
  );
`)
  .then(() => console.log('✅ Migration check: notifications tables ready'))
  .catch(err => console.error('Migration warning (notifications):', err.message));

server.listen(PORT, () => {
  console.log(`
🚀 Server is running on port ${PORT}
🌐 Frontend URL: ${process.env.FRONTEND_URL}
📊 Database: ${process.env.DB_NAME}
  `);
});
