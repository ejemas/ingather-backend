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

const pool = require('./config/database');

// Auto-migrate: add organization type once and backfill existing accounts
pool.query(`
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'churches'
        AND column_name = 'organization_type'
    ) THEN
      ALTER TABLE churches ADD COLUMN IF NOT EXISTS organization_type VARCHAR(50);
      UPDATE churches SET organization_type = 'general' WHERE organization_type IS NULL;
    END IF;
  END;
  $$;
`)
  .then(() => console.log('Migration check: organization type column ready'))
  .catch(err => console.error('Migration warning (organization type):', err.message));

// Auto-migrate: add is_gifted column if it doesn't exist
pool.query(`
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS is_gifted BOOLEAN DEFAULT FALSE;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS personalized_message TEXT;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS email_address VARCHAR(255);
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS school VARCHAR(255);
`)
  .then(() => console.log('✅ Migration check: is_gifted column ready'))
  .catch(err => console.error('Migration warning:', err.message));

// Auto-migrate: add performance indexes for dashboard and program detail reads
pool.query(`
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS is_gifted BOOLEAN DEFAULT FALSE;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS personalized_message TEXT;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS email_address VARCHAR(255);
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS school VARCHAR(255);
  CREATE INDEX IF NOT EXISTS idx_attendees_program_time ON attendees(program_id, scan_time DESC);
  CREATE INDEX IF NOT EXISTS idx_attendees_program_winner_gifted ON attendees(program_id, is_winner, is_gifted);
`)
  .then(() => console.log('Migration check: performance indexes ready'))
  .catch(err => console.error('Migration warning (performance indexes):', err.message));

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

// Auto-migrate: add proxy check-in columns
pool.query(`
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS proxy_checkin_enabled BOOLEAN DEFAULT FALSE;
  ALTER TABLE scans ADD COLUMN IF NOT EXISTS proxy_host_fingerprint VARCHAR(500);
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS proxy_host_fingerprint VARCHAR(500);
  CREATE INDEX IF NOT EXISTS idx_attendees_proxy_host ON attendees(program_id, proxy_host_fingerprint);
  CREATE INDEX IF NOT EXISTS idx_scans_proxy_host ON scans(program_id, proxy_host_fingerprint);
`)
  .then(() => console.log('Migration check: proxy check-in columns ready'))
  .catch(err => console.error('Migration warning (proxy check-in):', err.message));

// Auto-migrate: add optional program flyer metadata columns if they don't exist
pool.query(`
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_type VARCHAR(30) DEFAULT 'standard';
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_url TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_storage_path TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_original_name VARCHAR(255);
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_flyer_config JSONB;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_background_url TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_background_storage_path TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_background_original_name VARCHAR(255);
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_logo_url TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_logo_storage_path TEXT;
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS personalized_logo_original_name VARCHAR(255);
`)
  .then(() => console.log('Migration check: program flyer columns ready'))
  .catch(err => console.error('Migration warning (program flyers):', err.message));

// Auto-migrate: add event sponsor tables and analytics tracking
pool.query(`
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS sponsor_display_mode TEXT NOT NULL DEFAULT 'carousel';
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS sponsor_expected_attendees INTEGER;
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'programs_sponsor_display_mode_check'
    ) THEN
      ALTER TABLE programs
      ADD CONSTRAINT programs_sponsor_display_mode_check
      CHECK (sponsor_display_mode IN ('carousel', 'distribution'));
    END IF;
  END;
  $$;
  CREATE TABLE IF NOT EXISTS event_sponsors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    sponsor_name TEXT NOT NULL,
    flyer_url TEXT NOT NULL,
    flyer_storage_path TEXT,
    flyer_original_name TEXT,
    cta_text TEXT NOT NULL,
    cta_link TEXT NOT NULL,
    booth_text TEXT,
    campaign_tag TEXT,
    tier TEXT,
    distribution_percentage INTEGER,
    click_count INTEGER NOT NULL DEFAULT 0,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT event_sponsors_distribution_percentage_check
      CHECK (distribution_percentage IS NULL OR distribution_percentage BETWEEN 1 AND 100),
    CONSTRAINT event_sponsors_cta_link_check
      CHECK (cta_link ~* '^https?://')
  );
  CREATE TABLE IF NOT EXISTS sponsor_click_events (
    id BIGSERIAL PRIMARY KEY,
    sponsor_id UUID NOT NULL REFERENCES event_sponsors(id) ON DELETE CASCADE,
    program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    campaign_tag TEXT,
    device_fingerprint_hash TEXT,
    clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_event_sponsors_program_id ON event_sponsors(program_id);
  CREATE INDEX IF NOT EXISTS idx_event_sponsors_program_active ON event_sponsors(program_id, is_active, display_order);
  CREATE INDEX IF NOT EXISTS idx_sponsor_click_events_program_time ON sponsor_click_events(program_id, clicked_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sponsor_click_events_sponsor_time ON sponsor_click_events(sponsor_id, clicked_at DESC);
`)
  .then(() => console.log('Migration check: event sponsor tables ready'))
  .catch(err => console.error('Migration warning (event sponsors):', err.message));

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
  CREATE INDEX IF NOT EXISTS idx_notification_reads_notification_church ON notification_reads(notification_id, church_id);
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
