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
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Admin-Key'],
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
const preEventRoutes = require('./routes/preEventRoutes');
const waitlistRoutes = require('./routes/waitlistRoutes');
const rsvpScannerRoutes = require('./routes/rsvpScannerRoutes');

// API Routes
app.get('/', (req, res) => {
  res.json({ message: 'Ingather API is running!' });
});

app.use('/api/auth', authRoutes);
app.use('/api/programs', programRoutes);
app.use('/api/scan', scanRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/pre-events', preEventRoutes);
app.use('/api/waitlist', waitlistRoutes);
app.use('/api/rsvp-scanner', rsvpScannerRoutes);

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
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS link_url TEXT;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS textarea_response TEXT;
`)
  .then(() => console.log('✅ Migration check: is_gifted column ready'))
  .catch(err => console.error('Migration warning:', err.message));

// Auto-migrate: add performance indexes for dashboard and program detail reads
pool.query(`
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS is_gifted BOOLEAN DEFAULT FALSE;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS personalized_message TEXT;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS email_address VARCHAR(255);
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS school VARCHAR(255);
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS link_url TEXT;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS textarea_response TEXT;
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
  ALTER TABLE programs ADD COLUMN IF NOT EXISTS data_field_config JSONB DEFAULT '{}'::jsonb;
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

// Auto-migrate: create pre-event RSVP tables if they don't exist
pool.query(`
  CREATE TABLE IF NOT EXISTS pre_events (
    id SERIAL PRIMARY KEY,
    church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
    program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    event_date TIMESTAMP NOT NULL,
    description TEXT,
    venue_name VARCHAR(255),
    city VARCHAR(120),
    discover_enabled BOOLEAN DEFAULT FALSE,
    banner_url TEXT,
    banner_storage_path TEXT,
    banner_original_name VARCHAR(255),
    rsvp_fields JSONB NOT NULL DEFAULT '{"emailAddress":true}'::jsonb,
    rsvp_field_config JSONB DEFAULT '{}'::jsonb,
    slug VARCHAR(160) UNIQUE NOT NULL,
    is_rsvp_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pre_event_rsvps (
    id SERIAL PRIMARY KEY,
    pre_event_id INTEGER NOT NULL REFERENCES pre_events(id) ON DELETE CASCADE,
    email_address VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    phone_number VARCHAR(50),
    school VARCHAR(255),
    link_url TEXT,
    textarea_response TEXT,
    organization VARCHAR(255),
    ticket_type VARCHAR(120),
    address TEXT,
    first_timer BOOLEAN DEFAULT FALSE,
    department VARCHAR(100),
    fellowship VARCHAR(100),
    age INTEGER,
    sex VARCHAR(20),
    custom_answers JSONB DEFAULT '{}'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'pre_registered',
    registration_type VARCHAR(30) NOT NULL DEFAULT 'rsvp',
    checked_in_at TIMESTAMP,
    checkin_token_hash TEXT,
    checkin_qr_sent_at TIMESTAMPTZ,
    checkin_qr_last_sent_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pre_event_rsvps_status_check CHECK (status IN ('pre_registered', 'checked_in')),
    CONSTRAINT pre_event_rsvps_registration_type_check CHECK (registration_type IN ('rsvp'))
  );
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL;
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS venue_name VARCHAR(255);
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS city VARCHAR(120);
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS discover_enabled BOOLEAN DEFAULT FALSE;
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS banner_storage_path TEXT;
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS banner_original_name VARCHAR(255);
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS rsvp_fields JSONB NOT NULL DEFAULT '{"emailAddress":true}'::jsonb;
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS rsvp_field_config JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS is_rsvp_active BOOLEAN DEFAULT TRUE;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS custom_answers JSONB DEFAULT '{}'::jsonb;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS link_url TEXT;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS textarea_response TEXT;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS address TEXT;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS first_timer BOOLEAN DEFAULT FALSE;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS department VARCHAR(100);
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS fellowship VARCHAR(100);
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS age INTEGER;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS sex VARCHAR(20);
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS checkin_token_hash TEXT;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS checkin_qr_sent_at TIMESTAMPTZ;
  ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS checkin_qr_last_sent_at TIMESTAMPTZ;
  ALTER TABLE pre_event_rsvps DROP CONSTRAINT IF EXISTS pre_event_rsvps_status_check;
  ALTER TABLE pre_event_rsvps ADD CONSTRAINT pre_event_rsvps_status_check CHECK (status IN ('pre_registered', 'checked_in'));
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS pre_event_rsvp_id INTEGER REFERENCES pre_event_rsvps(id) ON DELETE SET NULL;
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'checked_in';
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS registration_type VARCHAR(30) NOT NULL DEFAULT 'walk_in';
  ALTER TABLE attendees ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
  UPDATE attendees SET status = 'checked_in' WHERE status IS NULL;
  UPDATE attendees SET registration_type = CASE
    WHEN proxy_host_fingerprint IS NOT NULL THEN 'proxy'
    WHEN device_fingerprint LIKE 'manual-%' THEN 'manual'
    ELSE COALESCE(registration_type, 'walk_in')
  END
  WHERE registration_type IS NULL OR registration_type = 'walk_in';
  UPDATE attendees SET checked_in_at = COALESCE(checked_in_at, scan_time, CURRENT_TIMESTAMP);
  ALTER TABLE attendees DROP CONSTRAINT IF EXISTS attendees_status_check;
  ALTER TABLE attendees ADD CONSTRAINT attendees_status_check CHECK (status IN ('pre_registered', 'checked_in'));
  ALTER TABLE attendees DROP CONSTRAINT IF EXISTS attendees_registration_type_check;
  ALTER TABLE attendees ADD CONSTRAINT attendees_registration_type_check CHECK (registration_type IN ('rsvp', 'walk_in', 'manual', 'proxy'));
  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = 'attendees_pre_event_rsvp_id_fkey'
    ) THEN
      ALTER TABLE attendees
        ADD CONSTRAINT attendees_pre_event_rsvp_id_fkey
        FOREIGN KEY (pre_event_rsvp_id) REFERENCES pre_event_rsvps(id) ON DELETE SET NULL;
    END IF;
  END;
  $$;
  ALTER TABLE pre_events ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pre_event_rsvps ENABLE ROW LEVEL SECURITY;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_event_rsvps_unique_email ON pre_event_rsvps(pre_event_id, email_address);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_event_rsvps_checkin_token_hash ON pre_event_rsvps(checkin_token_hash) WHERE checkin_token_hash IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_pre_event_rsvp_unique ON attendees(pre_event_rsvp_id) WHERE pre_event_rsvp_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_pre_events_church_date ON pre_events(church_id, event_date DESC);
  CREATE INDEX IF NOT EXISTS idx_pre_events_discover_date ON pre_events(discover_enabled, is_rsvp_active, event_date ASC);
  CREATE INDEX IF NOT EXISTS idx_pre_events_program_id ON pre_events(program_id);
  CREATE INDEX IF NOT EXISTS idx_pre_events_slug ON pre_events(slug);
  CREATE INDEX IF NOT EXISTS idx_pre_event_rsvps_event_time ON pre_event_rsvps(pre_event_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_attendees_program_checked_in ON attendees(program_id, checked_in_at DESC);
`)
  .then(() => console.log('Migration check: pre-event RSVP tables ready'))
  .catch(err => console.error('Migration warning (pre-events):', err.message));

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

// Auto-migrate: invite-only waitlist table
pool.query(`
  CREATE EXTENSION IF NOT EXISTS "pgcrypto";
  CREATE TABLE IF NOT EXISTS waitlist_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    organization_name TEXT,
    event_size TEXT NOT NULL,
    upcoming_event_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending',
    invite_token_hash TEXT,
    invite_expires_at TIMESTAMPTZ,
    invited_at TIMESTAMPTZ,
    accepted_at TIMESTAMPTZ,
    rejected_at TIMESTAMPTZ,
    accepted_church_id INTEGER REFERENCES churches(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT waitlist_leads_event_size_check
      CHECK (event_size IN ('1-50', '50-200', '200-500', '500+')),
    CONSTRAINT waitlist_leads_status_check
      CHECK (status IN ('pending', 'invited', 'accepted', 'rejected'))
  );
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS upcoming_event_at TIMESTAMPTZ;
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMPTZ;
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ;
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;
  ALTER TABLE waitlist_leads ADD COLUMN IF NOT EXISTS accepted_church_id INTEGER REFERENCES churches(id) ON DELETE SET NULL;
  ALTER TABLE waitlist_leads DROP CONSTRAINT IF EXISTS waitlist_leads_status_check;
  UPDATE waitlist_leads SET status = 'accepted' WHERE status = 'approved';
  ALTER TABLE waitlist_leads
    ADD CONSTRAINT waitlist_leads_status_check
    CHECK (status IN ('pending', 'invited', 'accepted', 'rejected'));
  CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_leads_email_lower
    ON waitlist_leads (LOWER(email));
  CREATE INDEX IF NOT EXISTS idx_waitlist_leads_created_at
    ON waitlist_leads (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_waitlist_leads_status_created
    ON waitlist_leads (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_waitlist_leads_invite_hash
    ON waitlist_leads (invite_token_hash)
    WHERE invite_token_hash IS NOT NULL;
  ALTER TABLE waitlist_leads ENABLE ROW LEVEL SECURITY;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      GRANT INSERT ON waitlist_leads TO anon;
      DROP POLICY IF EXISTS waitlist_leads_public_insert ON waitlist_leads;
      CREATE POLICY waitlist_leads_public_insert
        ON waitlist_leads
        FOR INSERT
        TO anon
        WITH CHECK (true);
    END IF;
  END;
  $$;
`)
  .then(() => console.log('Migration check: waitlist table ready'))
  .catch(err => console.error('Migration warning (waitlist):', err.message));

server.listen(PORT, () => {
  console.log(`
🚀 Server is running on port ${PORT}
🌐 Frontend URL: ${process.env.FRONTEND_URL}
📊 Database: ${process.env.DB_NAME}
  `);
});
