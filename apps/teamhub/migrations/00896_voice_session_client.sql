-- +goose Up
-- The client that publishes a VoiceSession's microphone. A mobile Live
-- session has no page, so the live voice offers it no page tools.
ALTER TABLE voice_sessions
    ADD COLUMN client text NOT NULL DEFAULT 'web'
    CONSTRAINT voice_sessions_client_check CHECK (client = ANY (ARRAY['web'::text, 'mobile'::text]));

-- +goose Down
ALTER TABLE voice_sessions DROP COLUMN client;
