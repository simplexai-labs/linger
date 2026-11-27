-- +goose Up
-- The mobile preview desktop build (0.1.9-mobile.1) recorded its own
-- migrations under versions 00894 to 00896, and earlier builds of this branch
-- under 00895 to 00899, 00897 to 00901 or 00898 to 00902. On such a database goose treats the
-- main-line migrations with those numbers as applied and never runs them, so
-- this does what 00894_room_handoff_reports, 00895_runtime_local_computers,
-- 00896_message_continues, 00897_drop_agent_templates and
-- 00898_voice_settings do where it is missing. Everywhere else it is already done and nothing changes.
CREATE TABLE IF NOT EXISTS room_handoffs (
  id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  origin_room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  human_actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  agent_actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'working' CHECK (state IN ('working','waiting_for_user','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS room_handoff_reports (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  handoff_id text NOT NULL REFERENCES room_handoffs(id) ON DELETE CASCADE,
  voice_session_id text REFERENCES voice_sessions(id) ON DELETE SET NULL,
  told_at timestamptz
);
CREATE INDEX IF NOT EXISTS room_handoffs_origin ON room_handoffs(origin_room_id,agent_actor_id,human_actor_id);
CREATE INDEX IF NOT EXISTS room_handoff_reports_handoff ON room_handoff_reports(handoff_id);
CREATE INDEX IF NOT EXISTS room_handoff_reports_voice ON room_handoff_reports(voice_session_id) WHERE told_at IS NULL;

CREATE OR REPLACE VIEW runtime_local_computers WITH (security_invoker = true) AS
SELECT
    computer_id,
    display_name,
    status,
    credential_generation,
    active_operations,
    runtime_inventory,
    workspace_grants,
    runtime_diagnostics,
    last_seen_at,
    removed_at,
    created_at,
    updated_at,
    daemon_id,
    daemon_public_key,
    daemon_identity_version,
    platform,
    daemon_version,
    recommended_version,
    owner_tenant_id,
    owner_actor_id
FROM local_computers;

ALTER TABLE public.messages
    ADD COLUMN IF NOT EXISTS continues boolean DEFAULT false NOT NULL;

-- 00897_drop_agent_templates.
ALTER TABLE agent_registrations
    DROP CONSTRAINT IF EXISTS agent_registrations_template_routines_check,
    DROP CONSTRAINT IF EXISTS agent_registrations_template_shape,
    DROP COLUMN IF EXISTS template_id,
    DROP COLUMN IF EXISTS template_routines,
    DROP COLUMN IF EXISTS template_installed_at;
DROP TABLE IF EXISTS agent_templates;

-- 00898_voice_settings.
CREATE TABLE IF NOT EXISTS public.voice_settings (
    account_id text NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
    tenant_id text NOT NULL,
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

CREATE TABLE IF NOT EXISTS public.local_computer_speech_snapshots (
    computer_id text PRIMARY KEY REFERENCES public.local_computers(computer_id) ON DELETE CASCADE,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    observed_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.voice_sessions
    ADD COLUMN IF NOT EXISTS speech_config jsonb CHECK (speech_config IS NULL OR jsonb_typeof(speech_config) = 'object');

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'the mobile preview repair is forward-only'; END $$;
-- +goose StatementEnd
