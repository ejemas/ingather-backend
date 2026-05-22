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

-- Migration: Scan session tokens for public scan follow-up mutations
ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_token_hash VARCHAR(128);
ALTER TABLE scans ADD COLUMN IF NOT EXISTS scan_token_expires_at TIMESTAMP;
