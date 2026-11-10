-- Ingather: new-device check (8 Nov 2026)
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Additive only: creates two new tables. Nothing existing is changed or removed.
-- Safe to run twice.

CREATE TABLE IF NOT EXISTS trusted_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  device_hash VARCHAR(128) NOT NULL,
  device_label VARCHAR(160),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_used_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trusted_devices_church_device
  ON trusted_devices (church_id, device_hash);

CREATE TABLE IF NOT EXISTS device_login_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
  device_hash VARCHAR(128) NOT NULL,
  device_label VARCHAR(160),
  code_hash VARCHAR(128) NOT NULL,
  remember_login BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INTEGER NOT NULL DEFAULT 0,
  resend_count INTEGER NOT NULL DEFAULT 0,
  last_sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  consumed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_device_login_challenges_church
  ON device_login_challenges (church_id, created_at DESC);

-- Keep these tables private to the server. The backend connects as the table
-- owner, so it is not affected. Public API keys cannot read them.
ALTER TABLE trusted_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_login_challenges ENABLE ROW LEVEL SECURITY;

-- Check: should return 2 rows, trusted_devices and device_login_challenges
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('trusted_devices', 'device_login_challenges');
