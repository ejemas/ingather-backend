-- Ingather: RSVP closing time for pre-events (9 Nov 2026)
-- Run once in Supabase: SQL Editor > New query > paste > Run.
-- Run this BEFORE pushing the backend that uses it.
-- Additive only: adds one empty column. Nothing existing is changed or removed.
-- Safe to run twice.
--
-- rsvp_closes_at: an optional earlier time the organizer picks for RSVPs to stop.
-- Empty means the default: RSVPs stop 12 hours after the event starts.

ALTER TABLE pre_events ADD COLUMN IF NOT EXISTS rsvp_closes_at TIMESTAMP;
