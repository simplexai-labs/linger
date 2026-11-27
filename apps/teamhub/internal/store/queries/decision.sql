-- name: ListDecisionsByMessages :many
-- A card page never reads a permission card's screenshot.
SELECT id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,alter_ego_task_id,status,
       request,view,answer,result,expires_at,decided_at,decided_by_actor_id,finished_at,created_at,
       (screenshot IS NOT NULL)::boolean AS has_screenshot
FROM decisions
WHERE message_id=ANY(sqlc.arg(message_ids)::text[]);

-- name: InsertDecision :one
-- A lifetime of zero seconds makes a card that waits until it is answered.
INSERT INTO decisions (id,tenant_id,room_id,message_id,kind,requested_by_actor_id,decider_actor_id,
    alter_ego_task_id,request,view,expires_at,screenshot,screenshot_media_type)
VALUES (sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(room_id)::text,sqlc.arg(message_id)::text,
    sqlc.arg(kind)::text,sqlc.arg(requested_by_actor_id)::text,sqlc.arg(decider_actor_id)::text,
    sqlc.narg(alter_ego_task_id)::text,sqlc.arg(request)::jsonb,sqlc.arg(view)::jsonb,
    CASE WHEN sqlc.arg(lifetime_seconds)::float8>0
      THEN clock_timestamp()+make_interval(secs => sqlc.arg(lifetime_seconds)::float8) END,
    sqlc.narg(screenshot)::bytea,sqlc.narg(screenshot_media_type)::text)
RETURNING expires_at;

-- name: LocateDecision :one
SELECT tenant_id,room_id FROM decisions WHERE id=$1;

-- name: GetDecisionAuthority :one
-- Any member of the card's Room sees the decision; the caller row names the
-- member deciding it. requester_visibility_scope is the requesting Agent's.
-- A connection authorization stays open while authorizing, so the Human can
-- still cancel the OAuth they started.
SELECT decision.message_id,decision.decider_actor_id,caller.id AS caller_actor_id,card.version AS card_version,
       decision.kind,decision.tenant_id,decision.room_id,decision.requested_by_actor_id,
       coalesce(decision.alter_ego_task_id,'')::text AS alter_ego_task_id,decision.request,decision.view,decision.status,
       ((decision.status='pending' OR decision.kind='connection_auth' AND decision.status='authorizing')
         AND (decision.expires_at IS NULL OR decision.expires_at>clock_timestamp()))::boolean AS open,
       coalesce(registration.visibility_scope,'')::text AS requester_visibility_scope
FROM decisions decision
JOIN message_cards card ON card.message_id=decision.message_id
LEFT JOIN agent_registrations registration
  ON registration.actor_id=decision.requested_by_actor_id AND registration.tenant_id=decision.tenant_id
JOIN actors caller
  ON caller.tenant_id=decision.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN active_room_members membership
  ON membership.room_id=collaboration_membership_room_id(decision.room_id)
 AND membership.actor_id=caller.id
WHERE decision.id=sqlc.arg(decision_id)::text
FOR UPDATE OF decision, card;

-- name: GetHumanRoomMemberActor :one
SELECT actor.*
FROM actors actor
JOIN active_room_members membership
  ON membership.actor_id=actor.id
 AND membership.tenant_id=actor.tenant_id
 AND membership.room_id=collaboration_membership_room_id(sqlc.arg(room_id)::text)
WHERE actor.id=sqlc.arg(actor_id)::text
  AND actor.tenant_id=sqlc.arg(tenant_id)::text
  AND actor.kind=sqlc.arg(kind)::text;

-- name: GetRoomCreationSubmissionReplay :one
SELECT decision.id,decision.message_id,idempotency.request_hash,
       idempotency.response_status,idempotency.response_body
FROM decisions decision
JOIN command_replays idempotency
  ON idempotency.scope='agent:'||decision.requested_by_actor_id
 AND idempotency.resource_id=decision.message_id
WHERE decision.kind='room_creation'
  AND decision.requested_by_actor_id=sqlc.arg(agent_actor_id)::text
  AND decision.request->>'submission_id'=sqlc.arg(submission_id)::text
  AND idempotency.operation=sqlc.arg(operation)::text
  AND idempotency.key=sqlc.arg(submission_id)::text;

-- name: GetTaskOriginRoomID :one
SELECT room_id FROM work_item_room_links
WHERE work_item_id=sqlc.arg(work_item_id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND link_type='origin';

-- name: HumanAndAgentShareRoom :one
SELECT (
  EXISTS(
    SELECT 1 FROM active_room_members member
    JOIN actors actor ON actor.id=member.actor_id AND actor.tenant_id=member.tenant_id AND actor.kind='human'
    WHERE member.room_id=sqlc.arg(room_id)::text AND member.tenant_id=sqlc.arg(tenant_id)::text
      AND member.actor_id=sqlc.arg(human_actor_id)::text
  )
  AND EXISTS(
    SELECT 1 FROM active_room_members member
    WHERE member.room_id=sqlc.arg(room_id)::text AND member.tenant_id=sqlc.arg(tenant_id)::text
      AND member.actor_id=sqlc.arg(agent_actor_id)::text
  )
)::boolean;

-- name: GetPendingProfileSetupCard :one
-- The AnotherMe setup card still open in its Direct Room. The pending
-- requester index keeps this cheap on the Human's message path.
SELECT message_id FROM decisions
WHERE requested_by_actor_id=sqlc.arg(agent_actor_id)::text AND status='pending'
  AND room_id=sqlc.arg(room_id)::text AND kind IN ('profile_setup_apps','profile_setup_sources')
ORDER BY created_at DESC,id DESC
LIMIT 1;

-- name: ListProfileSetupReminderCards :many
-- The open AnotherMe setup cards whose AnotherMe holds an active grant to the
-- active Connection for the card's Human: the setups a reminder may concern.
SELECT decision.id AS decision_id,decision.room_id
FROM external_connection_agent_grants grant_row
JOIN external_connections connection
  ON connection.id=grant_row.connection_id AND connection.status='active'
JOIN decisions decision
  ON decision.requested_by_actor_id=grant_row.agent_actor_id AND decision.tenant_id=grant_row.tenant_id
 AND decision.decider_actor_id=grant_row.represented_human_actor_id
 AND decision.kind IN ('profile_setup_apps','profile_setup_sources') AND decision.status='pending'
WHERE grant_row.connection_id=sqlc.arg(connection_id)::text AND grant_row.status='active'
ORDER BY decision.id;

-- name: LockPendingProfileSetupCard :one
-- Locks one AnotherMe setup card while it is still open, after the Room
-- membership lock, as a decision answer does.
SELECT decision.message_id,decision.tenant_id,decision.decider_actor_id,decision.requested_by_actor_id
FROM decisions decision
WHERE decision.id=sqlc.arg(decision_id)::text AND decision.status='pending'
  AND decision.kind IN ('profile_setup_apps','profile_setup_sources')
FOR UPDATE;

-- name: ProfileOfferedInRoom :one
-- Whether a setup status AnotherMe read already offered the Profile: one
-- written while the Human had an app granted to AnotherMe. A status written
-- with no app granted only told AnotherMe to wait. Links and files arrive only
-- with the status that finishes setup, after which no card is left to check.
SELECT EXISTS(
  SELECT 1 FROM messages message
  JOIN decisions decision
    ON decision.message_id=message.card_context_message_id AND decision.room_id=message.room_id
   AND decision.kind IN ('profile_setup_apps','profile_setup_sources')
  WHERE message.room_id=sqlc.arg(room_id)::text AND message.author_actor_id=sqlc.arg(human_actor_id)::text
    AND message.message_kind='agent_runtime'
    AND EXISTS(SELECT 1 FROM external_connection_agent_grants grant_row
      WHERE grant_row.agent_actor_id=sqlc.arg(agent_actor_id)::text AND grant_row.tenant_id=decision.tenant_id
        AND grant_row.created_at<=message.created_at
        AND (grant_row.revoked_at IS NULL OR grant_row.revoked_at>message.created_at))
)::boolean;

-- name: PersonalProfileNotStarted :one
-- Whether the Human has no Personal Profile and none is being written.
SELECT (
  NOT EXISTS(SELECT 1 FROM personal_profile_currents
    WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text)
  AND NOT EXISTS(SELECT 1 FROM personal_profile_builds
    WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text
      AND expires_at>clock_timestamp())
  AND NOT EXISTS(SELECT 1 FROM personal_profile_generations
    WHERE tenant_id=sqlc.arg(tenant_id)::text AND owner_actor_id=sqlc.arg(owner_actor_id)::text
      AND status IN ('queued','running'))
)::boolean;

-- name: HumanWroteInRoom :one
-- Whether the Human has written in the Room themselves: published
-- conversation Messages that are not a card's recorded result.
SELECT EXISTS(
  SELECT 1 FROM messages
  WHERE room_id=sqlc.arg(room_id)::text AND author_actor_id=sqlc.arg(human_actor_id)::text
    AND message_kind='conversation' AND room_seq IS NOT NULL AND card_context_message_id IS NULL
)::boolean;

-- name: LockExternalConnectionForAuthorizationSettlement :one
-- Locks a Connection row while settling an authorizing connection_auth card.
SELECT status,
       (reauthorization_upstream_id IS NOT NULL)::boolean AS reauthorizing,
       coalesce(status_error_code, '')::text AS status_error_code,
       coalesce(remote_principal_key, '')::text AS remote_principal_key
FROM external_connections
WHERE id=sqlc.arg(id)::text
  AND account_id=sqlc.arg(account_id)::text
  AND provider=sqlc.arg(provider)::text
FOR SHARE;

-- name: LockCanonicalExternalConnectionForPrincipal :one
-- Resolves the non-revoked canonical Connection that superseded a duplicate
-- pending candidate during recovery.
SELECT id,
       status,
       (reauthorization_upstream_id IS NOT NULL)::boolean AS reauthorizing
FROM external_connections
WHERE account_id=sqlc.arg(account_id)::text
  AND provider=sqlc.arg(provider)::text
  AND remote_principal_key=sqlc.arg(remote_principal_key)::text
  AND status<>'revoked'
FOR SHARE;

-- name: FinishSettledConnectionAuthDecision :exec
-- Finalizes a settled connection_auth decision, optionally rebinding
-- answer.connection_id to the canonical Connection when a duplicate candidate
-- recovered an existing account.
UPDATE decisions
SET status=sqlc.arg(status)::text,
    answer=CASE
      WHEN sqlc.arg(rebound_connection_id)::text<>''
        THEN jsonb_set(coalesce(answer, '{}'::jsonb), '{connection_id}', to_jsonb(sqlc.arg(rebound_connection_id)::text))
      ELSE answer
    END,
    finished_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text;
