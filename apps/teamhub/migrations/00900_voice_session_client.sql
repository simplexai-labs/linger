-- +goose Up
-- The client that publishes a VoiceSession's microphone. A mobile Live
-- session has no page, so the live voice offers it no page tools. IF NOT
-- EXISTS: a database from the mobile preview build or an earlier build of
-- this branch already has the column under another version.
ALTER TABLE voice_sessions
    ADD COLUMN IF NOT EXISTS client text NOT NULL DEFAULT 'web'
    CONSTRAINT voice_sessions_client_check CHECK (client = ANY (ARRAY['web'::text, 'mobile'::text]));

-- +goose Down
ALTER TABLE voice_sessions DROP COLUMN client;
