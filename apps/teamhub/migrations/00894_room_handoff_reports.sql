-- +goose Up
CREATE TABLE room_handoffs (
  id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  origin_room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  room_id text NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  human_actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  agent_actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'working' CHECK (state IN ('working','waiting_for_user','completed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE room_handoff_reports (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  handoff_id text NOT NULL REFERENCES room_handoffs(id) ON DELETE CASCADE,
  voice_session_id text REFERENCES voice_sessions(id) ON DELETE SET NULL,
  told_at timestamptz
);
CREATE INDEX room_handoffs_origin ON room_handoffs(origin_room_id,agent_actor_id,human_actor_id);
CREATE INDEX room_handoff_reports_handoff ON room_handoff_reports(handoff_id);
CREATE INDEX room_handoff_reports_voice ON room_handoff_reports(voice_session_id) WHERE told_at IS NULL;

-- +goose Down
DROP TABLE room_handoff_reports;
DROP TABLE room_handoffs;
