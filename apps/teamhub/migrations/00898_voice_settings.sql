-- +goose Up
-- Per-account voice transcription preferences, per-Computer local speech
-- snapshots, and per-VoiceSession resolved speech dispatch config.
CREATE TABLE public.voice_settings (
    account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    speech_provider text NOT NULL DEFAULT 'auto'
        CHECK (speech_provider IN ('auto', 'local', 'cloud')),
    local_computer_id text,
    local_model_id text,
    language text NOT NULL DEFAULT 'auto',
    silence_timeout_seconds integer NOT NULL DEFAULT 0
        CHECK (silence_timeout_seconds >= 0 AND silence_timeout_seconds <= 300),
    use_gpu boolean NOT NULL DEFAULT true,
    keep_loaded_seconds integer NOT NULL DEFAULT 900
        CHECK (keep_loaded_seconds >= -1 AND keep_loaded_seconds <= 86400),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account_id, tenant_id)
);

CREATE TABLE public.local_computer_speech_snapshots (
    computer_id text PRIMARY KEY REFERENCES public.local_computers(computer_id) ON DELETE CASCADE,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    observed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.voice_sessions
    ADD COLUMN speech_config jsonb CHECK (speech_config IS NULL OR jsonb_typeof(speech_config) = 'object');

-- +goose Down
ALTER TABLE public.voice_sessions
    DROP COLUMN speech_config;

DROP TABLE public.local_computer_speech_snapshots;

DROP TABLE public.voice_settings;
