-- +goose Up
-- The mobile preview desktop build (0.1.9-mobile.1) recorded its own
-- migrations under versions 00894 to 00896. On such a database goose treats
-- 00894_room_handoff_reports as applied and never runs it, so this creates
-- its tables and indexes when they are missing. Everywhere else they exist
-- and nothing changes.
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

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'the mobile preview repair is forward-only'; END $$;
-- +goose StatementEnd
