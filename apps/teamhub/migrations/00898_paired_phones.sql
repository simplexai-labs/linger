-- +goose Up
-- Every statement here may run again: the mobile preview desktop build
-- (0.1.9-mobile.1) recorded these objects under 00894, and earlier builds of
-- this branch under 00895 or 00897, so goose can run this on a database that
-- has them.
-- Phones pair with this computer through the Mobile Gateway. A Pairing Invite
-- works once and only for ten minutes. A Paired Phone is identified by the
-- static key its session handshake proves; it stays pending until the Human
-- approves it after comparing its confirmation code, and then acts through
-- its own device Session, which no cookie can present because no raw token
-- exists for it.
CREATE TABLE IF NOT EXISTS mobile_pairing_invites (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS mobile_pairing_invites_account_id_idx ON mobile_pairing_invites (account_id);

CREATE TABLE IF NOT EXISTS paired_phones (
    id text PRIMARY KEY,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    public_key bytea NOT NULL UNIQUE CHECK (octet_length(public_key) = 32),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
    platform text NOT NULL CHECK (platform IN ('ios', 'android')),
    confirmation_code text NOT NULL CHECK (confirmation_code ~ '^[0-9]{6}$'),
    approved_at timestamptz,
    session_id text REFERENCES auth_sessions(id),
    push_grant text CHECK (char_length(push_grant) BETWEEN 1 AND 2048),
    push_service_url text CHECK (push_service_url ~ '^https://'),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    removed_at timestamptz,
    CHECK ((approved_at IS NULL) = (session_id IS NULL)),
    CHECK ((push_grant IS NULL) = (push_service_url IS NULL))
);

CREATE INDEX IF NOT EXISTS paired_phones_account_id_idx ON paired_phones (account_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS paired_phones_session_id_key ON paired_phones (session_id);

ALTER TABLE auth_sessions DROP CONSTRAINT IF EXISTS auth_sessions_revocation_reason_check;
ALTER TABLE auth_sessions ADD CONSTRAINT auth_sessions_revocation_reason_check CHECK (
    (revoked_at IS NULL AND revoked_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_reason = ANY (ARRAY['logout', 'password_reset', 'phone_removed', 'phone_rotated']))
);

-- A Message that may notify a phone enqueues its push job in the transaction
-- that publishes it, so a crash between the commit and the push loses
-- nothing. The job decides whether the Message qualifies; this trigger only
-- skips deployments without a phone that registered a push grant.
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION enqueue_mobile_push() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM paired_phones p
        JOIN actors human ON human.account_id = p.account_id AND human.kind = 'human'
        WHERE human.tenant_id = NEW.tenant_id
          AND p.removed_at IS NULL AND p.approved_at IS NOT NULL AND p.push_grant IS NOT NULL
    ) THEN
        INSERT INTO river_job (kind, queue, args, max_attempts)
        VALUES ('mobile.push', 'mobile',
                jsonb_build_object('event_id', NEW.event_id, 'tenant_id', NEW.tenant_id), 5);
        PERFORM notify_river_queue('mobile');
    END IF;
    RETURN NULL;
END;
$$;
-- +goose StatementEnd

DROP TRIGGER IF EXISTS room_events_mobile_push ON room_events;
CREATE TRIGGER room_events_mobile_push
    AFTER INSERT ON room_events
    FOR EACH ROW
    WHEN (NEW.event_type = 'message.created')
    EXECUTE FUNCTION enqueue_mobile_push();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'paired phones are forward-only'; END $$;
-- +goose StatementEnd
