-- Churches Table
CREATE TABLE IF NOT EXISTS churches (
    id SERIAL PRIMARY KEY,
    church_name VARCHAR(255) NOT NULL,
    branch_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    logo_url TEXT,
    organization_type VARCHAR(50),
    is_verified BOOLEAN DEFAULT FALSE,
    otp_code VARCHAR(255),
    otp_expires_at TIMESTAMP,
    otp_attempts INTEGER DEFAULT 0,
    otp_purpose VARCHAR(30),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Programs Table
CREATE TABLE IF NOT EXISTS programs (
    id SERIAL PRIMARY KEY,
    church_id INTEGER REFERENCES churches(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    date DATE NOT NULL,
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    tracking_mode VARCHAR(50) NOT NULL, -- 'count-only' or 'collect-data'
    data_fields JSONB, -- Store selected fields as JSON
    data_field_config JSONB DEFAULT '{}'::jsonb,
    gifting_enabled BOOLEAN DEFAULT FALSE,
    total_winners INTEGER DEFAULT 0,
    winners_selected INTEGER DEFAULT 0,
    flyer_type VARCHAR(30) DEFAULT 'standard',
    flyer_url TEXT,
    flyer_storage_path TEXT,
    flyer_original_name VARCHAR(255),
    personalized_flyer_config JSONB,
    personalized_background_url TEXT,
    personalized_background_storage_path TEXT,
    personalized_background_original_name VARCHAR(255),
    personalized_logo_url TEXT,
    personalized_logo_storage_path TEXT,
    personalized_logo_original_name VARCHAR(255),
    sponsor_display_mode TEXT DEFAULT 'carousel' CHECK (sponsor_display_mode IN ('carousel', 'distribution')),
    sponsor_expected_attendees INTEGER,
    proxy_checkin_enabled BOOLEAN DEFAULT FALSE,
    strict_device_fingerprinting BOOLEAN DEFAULT TRUE,
    qr_code_url VARCHAR(500),
    is_active BOOLEAN DEFAULT TRUE,
    total_scans INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Event Sponsors Table
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

-- Sponsor click events power date-based ROI analytics.
CREATE TABLE IF NOT EXISTS sponsor_click_events (
    id BIGSERIAL PRIMARY KEY,
    sponsor_id UUID NOT NULL REFERENCES event_sponsors(id) ON DELETE CASCADE,
    program_id INTEGER NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    campaign_tag TEXT,
    device_fingerprint_hash TEXT,
    clicked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Attendees Table
CREATE TABLE IF NOT EXISTS attendees (
    id SERIAL PRIMARY KEY,
    program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
    full_name VARCHAR(255),
    email_address VARCHAR(255),
    school VARCHAR(255),
    link_url TEXT,
    textarea_response TEXT,
    phone_number VARCHAR(50),
    address TEXT,
    first_timer BOOLEAN DEFAULT FALSE,
    department VARCHAR(100),
    fellowship VARCHAR(100),
    age INTEGER,
    sex VARCHAR(20),
    is_winner BOOLEAN DEFAULT FALSE,
    is_gifted BOOLEAN DEFAULT FALSE,
    personalized_message TEXT,
    device_fingerprint VARCHAR(500) NOT NULL,
    proxy_host_fingerprint VARCHAR(500),
    scan_id INTEGER,
    pre_event_rsvp_id INTEGER,
    status VARCHAR(30) NOT NULL DEFAULT 'checked_in',
    registration_type VARCHAR(30) NOT NULL DEFAULT 'walk_in',
    checked_in_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Scans Table (for tracking all scans, even anonymous ones)
CREATE TABLE IF NOT EXISTS scans (
    id SERIAL PRIMARY KEY,
    program_id INTEGER REFERENCES programs(id) ON DELETE CASCADE,
    device_fingerprint VARCHAR(500) NOT NULL,
    gender VARCHAR(20),
    first_timer BOOLEAN DEFAULT FALSE,
    scan_token_hash VARCHAR(128),
    scan_token_expires_at TIMESTAMP,
    proxy_host_fingerprint VARCHAR(500),
    scan_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Pre-Event RSVP configuration table
CREATE TABLE IF NOT EXISTS pre_events (
    id SERIAL PRIMARY KEY,
    church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
    program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
    title VARCHAR(255) NOT NULL,
    event_date TIMESTAMP NOT NULL,
    description TEXT,
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

-- Pre-Event RSVP attendee records. These stay separate from live scans/attendees.
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
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT pre_event_rsvps_status_check CHECK (status IN ('pre_registered', 'checked_in')),
    CONSTRAINT pre_event_rsvps_registration_type_check CHECK (registration_type IN ('rsvp'))
);

ALTER TABLE pre_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_event_rsvps ENABLE ROW LEVEL SECURITY;

-- Invite-only waitlist leads. Public inserts are handled by the Express API;
-- RLS remains enabled as defense in depth for Supabase-exposed schemas.
CREATE TABLE IF NOT EXISTS waitlist_leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    organization_name TEXT,
    event_size TEXT NOT NULL,
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

ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL;
ALTER TABLE pre_event_rsvps ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP;
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
ALTER TABLE pre_event_rsvps DROP CONSTRAINT IF EXISTS pre_event_rsvps_status_check;
ALTER TABLE pre_event_rsvps ADD CONSTRAINT pre_event_rsvps_status_check CHECK (status IN ('pre_registered', 'checked_in'));

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

ALTER TABLE programs ADD COLUMN IF NOT EXISTS strict_device_fingerprinting BOOLEAN DEFAULT TRUE;
ALTER TABLE programs ALTER COLUMN strict_device_fingerprinting SET DEFAULT TRUE;
UPDATE programs SET strict_device_fingerprinting = TRUE WHERE strict_device_fingerprinting IS NULL;
ALTER TABLE programs ALTER COLUMN strict_device_fingerprinting SET NOT NULL;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS scan_id INTEGER;
ALTER TABLE scans DROP CONSTRAINT IF EXISTS scans_program_id_device_fingerprint_key;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'attendees_scan_id_fkey'
    ) THEN
        ALTER TABLE attendees
            ADD CONSTRAINT attendees_scan_id_fkey
            FOREIGN KEY (scan_id) REFERENCES scans(id) ON DELETE SET NULL;
    END IF;
END $$;

-- Indexes for performance
CREATE INDEX idx_programs_church_id ON programs(church_id);
CREATE INDEX idx_attendees_program_id ON attendees(program_id);
CREATE INDEX idx_attendees_program_time ON attendees(program_id, scan_time DESC);
CREATE INDEX idx_attendees_program_winner_gifted ON attendees(program_id, is_winner, is_gifted);
CREATE INDEX idx_attendees_proxy_host ON attendees(program_id, proxy_host_fingerprint);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_scan_id_unique ON attendees(scan_id) WHERE scan_id IS NOT NULL;
CREATE INDEX idx_scans_program_id ON scans(program_id);
CREATE INDEX idx_scans_device ON scans(device_fingerprint);
CREATE INDEX idx_scans_proxy_host ON scans(program_id, proxy_host_fingerprint);
CREATE INDEX IF NOT EXISTS idx_scans_program_device_time ON scans(program_id, device_fingerprint, scan_time DESC);
CREATE INDEX idx_programs_date ON programs(church_id, date);
CREATE INDEX idx_scans_time ON scans(program_id, scan_time);
CREATE INDEX IF NOT EXISTS idx_event_sponsors_program_id ON event_sponsors(program_id);
CREATE INDEX IF NOT EXISTS idx_event_sponsors_program_active ON event_sponsors(program_id, is_active, display_order);
CREATE INDEX IF NOT EXISTS idx_sponsor_click_events_program_time ON sponsor_click_events(program_id, clicked_at DESC);
CREATE INDEX IF NOT EXISTS idx_sponsor_click_events_sponsor_time ON sponsor_click_events(sponsor_id, clicked_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pre_event_rsvps_unique_email ON pre_event_rsvps(pre_event_id, email_address);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendees_pre_event_rsvp_unique
    ON attendees(pre_event_rsvp_id)
    WHERE pre_event_rsvp_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pre_events_program_id ON pre_events(program_id);
CREATE INDEX IF NOT EXISTS idx_attendees_program_checked_in ON attendees(program_id, checked_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_pre_events_church_date ON pre_events(church_id, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_pre_events_slug ON pre_events(slug);
CREATE INDEX IF NOT EXISTS idx_pre_event_rsvps_event_time ON pre_event_rsvps(pre_event_id, created_at DESC);
