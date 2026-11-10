-- Ingather Help centre: tickets organizers send to the Ingather team, and the replies.
-- Safe to run more than once. It only creates new things; no existing table is changed.
-- Run it in Supabase: SQL Editor -> New query -> paste -> Run.

-- Ticket numbers start at #1001.
CREATE SEQUENCE IF NOT EXISTS help_ticket_number_seq START WITH 1001;

CREATE TABLE IF NOT EXISTS help_tickets (
    id SERIAL PRIMARY KEY,
    ticket_number INTEGER NOT NULL UNIQUE DEFAULT nextval('help_ticket_number_seq'),
    church_id INTEGER NOT NULL REFERENCES churches(id) ON DELETE CASCADE,
    topic VARCHAR(20) NOT NULL
        CHECK (topic IN ('checkin', 'rsvp', 'account', 'extras', 'data', 'other')),
    subject VARCHAR(160) NOT NULL,

    -- Which event it is about (optional). The title is kept so the ticket
    -- still reads well if the event is deleted later.
    event_kind VARCHAR(12) CHECK (event_kind IN ('program', 'pre_event')),
    program_id INTEGER REFERENCES programs(id) ON DELETE SET NULL,
    pre_event_id INTEGER REFERENCES pre_events(id) ON DELETE SET NULL,
    event_title VARCHAR(255),

    -- "My event is happening now"
    is_urgent BOOLEAN NOT NULL DEFAULT FALSE,

    -- waiting = waiting for Ingather, replied = Ingather replied, solved
    status VARCHAR(12) NOT NULL DEFAULT 'waiting'
        CHECK (status IN ('waiting', 'replied', 'solved')),

    -- Where replies are emailed (the organizer's account email when the ticket was sent).
    contact_email VARCHAR(255) NOT NULL,

    -- For the admin dashboard: who on the Ingather team is handling it.
    assigned_admin_id INTEGER,
    assigned_admin_name VARCHAR(120),

    -- Orange dot for the organizer when Ingather has replied, and "new" for the team.
    organizer_unread BOOLEAN NOT NULL DEFAULT FALSE,
    admin_unread BOOLEAN NOT NULL DEFAULT TRUE,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    solved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS help_ticket_messages (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES help_tickets(id) ON DELETE CASCADE,

    -- organizer = the person who sent the ticket, admin = someone on the Ingather team
    author_type VARCHAR(12) NOT NULL CHECK (author_type IN ('organizer', 'admin')),
    author_admin_id INTEGER,
    author_name VARCHAR(120),

    body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000),

    -- Optional screenshot, kept in the private "help-screenshots" storage bucket.
    attachment_path TEXT,
    attachment_name VARCHAR(255),
    attachment_type VARCHAR(40),
    attachment_size INTEGER,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Organizer list (Open / Solved tabs) and the admin queue (urgent first, oldest waiting first).
CREATE INDEX IF NOT EXISTS idx_help_tickets_church ON help_tickets (church_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_help_tickets_queue ON help_tickets (status, is_urgent DESC, last_message_at);
CREATE INDEX IF NOT EXISTS idx_help_ticket_messages_ticket ON help_ticket_messages (ticket_id, created_at);

-- The tables are only reached through the Ingather server, never straight from a browser.
-- Turning row level security on (with no policies) blocks Supabase's public API from them.
ALTER TABLE help_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE help_ticket_messages ENABLE ROW LEVEL SECURITY;

-- Private storage bucket for screenshots (PNG or JPEG, up to 5 MB).
-- Private means nobody can open a screenshot without a short-lived link from the server.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('help-screenshots', 'help-screenshots', false, 5242880, ARRAY['image/png', 'image/jpeg'])
ON CONFLICT (id) DO NOTHING;
