-- +goose Up
-- The mobile preview desktop build (0.1.9-mobile.1) recorded its own
-- migrations under versions 00894 to 00896, and earlier builds of this branch
-- under 00895 to 00899. On such a database goose treats 00894 to 00896 as
-- applied and never runs them, so this creates what 00894_room_handoff_reports,
-- 00895_runtime_local_computers and 00896_message_continues make when it is
-- missing. Everywhere else it exists and nothing changes.
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

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'the mobile preview repair is forward-only'; END $$;
-- +goose StatementEnd
