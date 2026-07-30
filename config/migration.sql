-- Migration: Add email verification and OTP fields to churches table
-- Run this against your existing database

-- Migration: Account setup organization type
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

ALTER TABLE churches ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_code VARCHAR(255);
ALTER TABLE churches ALTER COLUMN otp_code TYPE VARCHAR(255);
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_attempts INTEGER DEFAULT 0;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_purpose VARCHAR(30);

-- Migration: Add composite index for daily attendance aggregation (Attendance Overtime chart)
CREATE INDEX IF NOT EXISTS idx_programs_date ON programs(church_id, date);

-- Migration: Add composite index for 30-minute time-series bucketing (Attendance Overtime per-program chart)
CREATE INDEX IF NOT EXISTS idx_scans_time ON scans(program_id, scan_time);
CREATE INDEX IF NOT EXISTS idx_attendees_program_time ON attendees(program_id, scan_time DESC);
CREATE INDEX IF NOT EXISTS idx_attendees_program_winner_gifted ON attendees(program_id, is_winner, is_gifted);

-- Migration: System Notifications (broadcast table + per-church read tracking)
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

CREATE INDEX IF NOT EXISTS idx_notification_reads_church ON notification_reads(church_id);
CREATE INDEX IF NOT EXISTS idx_notification_reads_notification_church ON notification_reads(notification_id, church_id);

-- Migration: Expand logo_url column to TEXT to support base64-encoded images
-- VARCHAR(500) is too small for base64 data (~30-50K characters)
ALTER TABLE churches ALTER COLUMN logo_url TYPE TEXT;

-- Migration: Optional event flyer metadata for programs
ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_url TEXT;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_storage_path TEXT;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS flyer_original_name VARCHAR(255);

-- Migration: Event sponsor flyers and sponsor engagement analytics
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

-- Migration: Scan session tokens for public scan follow-up mutations
ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_token_hash VARCHAR(128);
ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_token_expires_at TIMESTAMP;

-- Migration: Proxy check-in / scan for others
ALTER TABLE programs ADD COLUMN IF NOT EXISTS proxy_checkin_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE scans ADD COLUMN IF NOT EXISTS proxy_host_fingerprint VARCHAR(500);
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS proxy_host_fingerprint VARCHAR(500);
CREATE INDEX IF NOT EXISTS idx_attendees_proxy_host ON attendees(program_id, proxy_host_fingerprint);
CREATE INDEX IF NOT EXISTS idx_scans_proxy_host ON scans(program_id, proxy_host_fingerprint);

-- Migration: Device fingerprint control for collect-data programs
ALTER TABLE programs ADD COLUMN IF NOT EXISTS strict_device_fingerprinting BOOLEAN DEFAULT TRUE;
ALTER TABLE programs ALTER COLUMN strict_device_fingerprinting SET DEFAULT TRUE;
UPDATE programs SET strict_device_fingerprinting = TRUE WHERE strict_device_fingerprinting IS NULL;
ALTER TABLE programs ALTER COLUMN strict_device_fingerprinting SET NOT NULL;

ALTER TABLE attendees ADD COLUMN IF NOT EXISTS scan_id INTEGER;
ALTER TABLE scans DROP CONSTRAINT IF EXISTS scans_program_id_device_fingerprint_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'attendees_scan_id_fkey'
  ) THEN
    ALTER TABLE attendees
      ADD CONSTRAINT attendees_scan_id_fkey
      FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE SET NULL;
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_scan_id_unique ON attendees(scan_id) WHERE scan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scans_program_device_time ON scans(program_id, device_fingerprint, scan_time DESC);

-- Migration: Pre-Event RSVP module
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
    virtual_attendance_enabled BOOLEAN DEFAULT FALSE,
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
    registration_source VARCHAR(20) NOT NULL DEFAULT 'legacy',
    checked_in_at TIMESTAMP,
    attendance_mode VARCHAR(20),
    checkin_token_hash TEXT,
    checkin_qr_sent_at TIMESTAMPTZ,
    checkin_qr_last_sent_at TIMESTAMPTZ,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pre_event_rsvps_status_check CHECK (status IN ('pre_registered', 'checked_in')),
    CONSTRAINT pre_event_rsvps_registration_type_check CHECK (registration_type IN ('rsvp')),
    CONSTRAINT pre_event_rsvps_registration_source_check CHECK (registration_source IN ('public', 'manual', 'import', 'legacy')),
    CONSTRAINT pre_event_rsvps_attendance_mode_check CHECK (attendance_mode IS NULL OR attendance_mode IN ('physical', 'virtual'))
);

CREATE TABLE IF NOT EXISTS rsvp_qr_email_sends (
    id BIGSERIAL PRIMARY KEY,
    church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
    pre_event_id INTEGER NOT NULL REFERENCES pre_events(id) ON DELETE CASCADE,
    rsvp_id INTEGER REFERENCES pre_event_rsvps(id) ON DELETE SET NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'reserved',
    failure_reason TEXT,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    sent_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT rsvp_qr_email_sends_status_check CHECK (status IN ('reserved', 'sent', 'failed'))
);

ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS venue_name VARCHAR(255);
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS city VARCHAR(120);
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS discover_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS banner_storage_path TEXT;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS banner_original_name VARCHAR(255);
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS rsvp_fields JSONB NOT NULL DEFAULT '{"emailAddress":true}'::jsonb;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS rsvp_field_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS virtual_attendance_enabled BOOLEAN DEFAULT FALSE;
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
ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS attendance_mode VARCHAR(20);
ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS registration_source VARCHAR(20) NOT NULL DEFAULT 'legacy';
ALTER TABLE pre_event_rsvps DROP CONSTRAINT IF EXISTS pre_event_rsvps_registration_source_check;
ALTER TABLE pre_event_rsvps ADD CONSTRAINT pre_event_rsvps_registration_source_check
  CHECK (registration_source IN ('public', 'manual', 'import', 'legacy'));
ALTER TABLE pre_event_rsvps DROP CONSTRAINT IF EXISTS pre_event_rsvps_status_check;
ALTER TABLE pre_event_rsvps ADD CONSTRAINT pre_event_rsvps_status_check CHECK (status IN ('pre_registered', 'checked_in'));
ALTER TABLE pre_event_rsvps DROP CONSTRAINT IF EXISTS pre_event_rsvps_attendance_mode_check;
ALTER TABLE pre_event_rsvps ADD CONSTRAINT pre_event_rsvps_attendance_mode_check CHECK (attendance_mode IS NULL OR attendance_mode IN ('physical', 'virtual'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_event_rsvps_checkin_token_hash
  ON pre_event_rsvps(checkin_token_hash)
  WHERE checkin_token_hash IS NOT NULL;

ALTER TABLE attendees ADD COLUMN IF NOT EXISTS pre_event_rsvp_id INTEGER REFERENCES pre_event_rsvps(id) ON DELETE SET NULL;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS status VARCHAR(30) NOT NULL DEFAULT 'checked_in';
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS registration_type VARCHAR(30) NOT NULL DEFAULT 'walk_in';
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS attendance_mode VARCHAR(20) DEFAULT 'physical';
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
ALTER TABLE attendees DROP CONSTRAINT IF EXISTS attendees_attendance_mode_check;
ALTER TABLE attendees ADD CONSTRAINT attendees_attendance_mode_check CHECK (attendance_mode IS NULL OR attendance_mode IN ('physical', 'virtual'));
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
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_pre_event_rsvp_unique ON attendees(pre_event_rsvp_id) WHERE pre_event_rsvp_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pre_events_church_date ON pre_events(church_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_pre_events_discover_date ON pre_events(discover_enabled, is_rsvp_active, event_date ASC);
CREATE INDEX IF NOT EXISTS idx_pre_events_program_id ON pre_events(program_id);
CREATE INDEX IF NOT EXISTS idx_pre_events_slug ON pre_events(slug);
CREATE INDEX IF NOT EXISTS idx_pre_event_rsvps_event_time ON pre_event_rsvps(pre_event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rsvp_qr_email_sends_church_time
    ON rsvp_qr_email_sends(church_id, status, reserved_at DESC, sent_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvp_qr_email_sends_active_rsvp
    ON rsvp_qr_email_sends(rsvp_id)
    WHERE status = 'reserved' AND rsvp_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendees_program_checked_in ON attendees(program_id, checked_in_at DESC);

-- Migration: Link and editable textarea data fields
ALTER TABLE programs ADD COLUMN IF NOT EXISTS data_field_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS custom_form_schema JSONB DEFAULT '[]'::jsonb;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS link_url TEXT;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS textarea_response TEXT;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS custom_responses JSONB DEFAULT '{}'::jsonb;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS rsvp_field_config JSONB DEFAULT '{}'::jsonb;
ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS custom_form_schema JSONB DEFAULT '[]'::jsonb;
ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS link_url TEXT;
ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS textarea_response TEXT;
ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS custom_answers JSONB DEFAULT '{}'::jsonb;

-- Migration: Invite-only waitlist leads
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
ALTER TABLE waitlist_leads ADD CONSTRAINT waitlist_leads_status_check
  CHECK (status IN ('pending', 'invited', 'accepted', 'rejected'));

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
CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_leads_email_lower ON waitlist_leads (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_waitlist_leads_created_at ON waitlist_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waitlist_leads_status_created ON waitlist_leads (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_waitlist_leads_invite_hash ON waitlist_leads (invite_token_hash) WHERE invite_token_hash IS NOT NULL;
