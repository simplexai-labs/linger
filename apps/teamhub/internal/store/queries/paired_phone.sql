-- name: CreateMobilePairingInvite :one
INSERT INTO mobile_pairing_invites (id, account_id, token_hash, expires_at)
VALUES ($1, $2, $3, now() + sqlc.arg(lifetime)::interval)
RETURNING id, expires_at;

-- name: ConsumeMobilePairingInvite :one
-- Spends one live invite; a used or expired invite returns no row.
UPDATE mobile_pairing_invites
SET consumed_at = now()
WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
RETURNING id, account_id;

-- name: CreatePendingPairedPhone :one
INSERT INTO paired_phones (id, account_id, public_key, name, platform, confirmation_code)
VALUES ($1, $2, $3, $4, $5, $6)
RETURNING id;

-- name: CreatePhoneSession :one
-- A device Session has no idle renewal; the Gateway replaces it before it
-- expires.
INSERT INTO auth_sessions (id, account_id, token_hash, expires_at)
VALUES ($1, $2, $3, now() + sqlc.arg(lifetime)::interval)
RETURNING id;

-- name: GetPairedPhoneByKey :one
SELECT p.id, p.account_id, p.session_id, p.removed_at, p.approved_at, p.confirmation_code, p.created_at,
       s.token_hash AS session_token_hash, s.expires_at AS session_expires_at,
       s.revoked_at AS session_revoked_at
FROM paired_phones p
LEFT JOIN auth_sessions s ON s.id = p.session_id
WHERE p.public_key = $1
FOR UPDATE OF p;

-- name: DeletePendingPairedPhone :exec
DELETE FROM paired_phones WHERE id = $1 AND approved_at IS NULL;

-- name: ApprovePairedPhone :one
UPDATE paired_phones
SET approved_at = now(), session_id = $3, last_seen_at = now()
WHERE id = $1 AND account_id = $2 AND approved_at IS NULL AND removed_at IS NULL
  AND created_at > now() - sqlc.arg(pending_lifetime)::interval
RETURNING id;

-- name: ReplacePairedPhoneSession :exec
UPDATE paired_phones SET session_id = $2, last_seen_at = now() WHERE id = $1;

-- name: RevokePhoneSession :exec
UPDATE auth_sessions
SET revoked_at = coalesce(revoked_at, now()),
    revoked_reason = CASE WHEN revoked_at IS NULL THEN sqlc.arg(reason)::text ELSE revoked_reason END
WHERE id = $1;

-- name: TouchPairedPhone :exec
UPDATE paired_phones SET last_seen_at = now() WHERE id = $1 AND removed_at IS NULL;

-- name: ListPairedPhones :many
-- Pending phones older than the pending lifetime are left out; Resume or
-- the next approval attempt deletes them.
SELECT id, name, platform, created_at, last_seen_at, approved_at, confirmation_code,
       (push_grant IS NOT NULL)::boolean AS push_enabled
FROM paired_phones
WHERE account_id = $1 AND removed_at IS NULL
  AND (approved_at IS NOT NULL OR created_at > now() - sqlc.arg(pending_lifetime)::interval)
ORDER BY created_at DESC, id;

-- name: RemovePairedPhone :one
UPDATE paired_phones
SET removed_at = now(), push_grant = NULL, push_service_url = NULL
WHERE id = $1 AND account_id = $2 AND removed_at IS NULL
RETURNING session_id;

-- name: PairedPhoneExists :one
SELECT EXISTS (SELECT 1 FROM paired_phones WHERE id = $1 AND account_id = $2) AS exists;

-- name: GetPairedPhoneBySession :one
SELECT id, account_id FROM paired_phones
WHERE session_id = $1 AND removed_at IS NULL;

-- name: SetPairedPhonePushGrant :exec
UPDATE paired_phones
SET push_grant = sqlc.narg(push_grant), push_service_url = sqlc.narg(push_service_url)
WHERE id = $1 AND removed_at IS NULL;

-- name: ClearPairedPhonePushGrant :exec
-- The Push Service refused the grant: it expired or the phone uninstalled.
UPDATE paired_phones SET push_grant = NULL, push_service_url = NULL
WHERE id = $1 AND push_grant = $2;

-- name: ListPushTargetsForRoom :many
-- The phones of the Account that owns a Space's Human, with what each wants
-- to hear about and how far its Human has read the Room.
SELECT p.id, p.account_id, p.push_grant::text AS push_grant, p.push_service_url::text AS push_service_url,
       human.id AS human_actor_id, p.push_replies, p.push_decisions, p.push_when_active,
       coalesce(state.read_through_room_seq, 0)::bigint AS read_through_room_seq
FROM paired_phones p
JOIN actors human ON human.account_id = p.account_id AND human.kind = 'human'
LEFT JOIN room_member_states state ON state.room_id = sqlc.arg(room_id)::text AND state.actor_id = human.id
WHERE human.tenant_id = sqlc.arg(tenant_id)::text AND p.removed_at IS NULL AND p.approved_at IS NOT NULL
  AND p.push_grant IS NOT NULL;

-- name: SetPairedPhonePushPreferences :execrows
UPDATE paired_phones
SET push_replies = $2, push_decisions = $3, push_when_active = $4
WHERE id = $1 AND removed_at IS NULL;

-- name: GetMobilePushMessage :one
-- The facts a push job needs about one published Message: who wrote it and
-- where, whom it mentions, which Humans it asks to decide something,
-- whether a later Agent message in the Room supersedes it, and whether an
-- Agent is still working in the Room.
SELECT e.tenant_id, e.room_id, e.event_id, e.room_seq, e.occurred_at,
       m.id AS message_id, m.message_kind, m.mentioned_actor_ids,
       (author.kind = 'agent')::boolean AS from_agent,
       coalesce(r.direct_human_actor_id, '')::text AS direct_human_actor_id,
       (m.author_actor_id = r.direct_agent_actor_id)::boolean AS from_direct_agent,
       coalesce((
           SELECT array_agg(d.decider_actor_id ORDER BY d.decider_actor_id) FROM decisions d
           JOIN actors human ON human.id = d.decider_actor_id AND human.kind = 'human'
           WHERE d.message_id = m.id AND d.status = 'pending'
       ), '{}')::text[] AS decider_actor_ids,
       -- Only a direct chat's later reply speaks for this one: in a group,
       -- another Agent's message need not concern the Human at all.
       (r.direct_human_actor_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM room_events later
           JOIN messages lm ON lm.id = later.resource_id
           JOIN actors la ON la.id = lm.author_actor_id AND la.kind = 'agent'
           WHERE later.room_id = e.room_id AND later.event_type = 'message.created'
             AND later.room_seq > e.room_seq AND lm.message_kind = 'conversation'
       ))::boolean AS superseded,
       -- As the Room's running light: a queued Run may wait indefinitely for
       -- an offline Computer, and a Run that replied has said its piece.
       EXISTS (
           SELECT 1 FROM room_agent_runs run
           WHERE run.context_room_id = e.room_id AND run.status = 'running'
             AND NOT agent_local_run_replied(run.run_id)
       )::boolean AS run_active
FROM room_events e
JOIN messages m ON m.id = e.resource_id
JOIN actors author ON author.id = m.author_actor_id
JOIN rooms r ON r.id = e.room_id
WHERE e.event_id = $1 AND e.event_type = 'message.created' AND r.deleted_at IS NULL;
