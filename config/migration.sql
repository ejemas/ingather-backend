-- Migration: Add email verification and OTP fields to churches table
-- Run this against your existing database

ALTER TABLE churches ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);
ALTER TABLE churches ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;

-- Migration: Add composite index for daily attendance aggregation (Attendance Overtime chart)
CREATE INDEX IF NOT EXISTS idx_programs_date ON programs(church_id, date);

-- Migration: Add composite index for 30-minute time-series bucketing (Attendance Overtime per-program chart)
CREATE INDEX IF NOT EXISTS idx_scans_time ON scans(program_id, scan_time);

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
