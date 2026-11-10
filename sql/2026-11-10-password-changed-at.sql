-- Ingather: sign out other devices after a password change (10 Nov 2026)
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Additive only: adds one empty column. Nothing existing is changed or removed. Safe to run twice.

ALTER TABLE churches ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
