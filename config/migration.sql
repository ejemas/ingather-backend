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
