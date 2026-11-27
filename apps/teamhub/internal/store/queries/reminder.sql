-- name: ResolveReminderHumanRoomAuthority :one
SELECT room.tenant_id, caller.id AS actor_id, membership.role
FROM rooms room
JOIN actors caller
  ON caller.tenant_id=room.tenant_id
 AND caller.account_id=sqlc.arg(account_id)::text
 AND caller.kind='human'
JOIN room_members membership
  ON membership.room_id=room.id
 AND membership.actor_id=caller.id
WHERE room.id=sqlc.arg(room_id)::text
  AND room.deleted_at IS NULL
  AND room_actor_participating(room.id, caller.id)
FOR KEY SHARE OF membership;

-- name: CountRoomReminders :one
-- A one-shot Routine that already fired is done and does not count.
SELECT count(*)::bigint
FROM room_reminders
WHERE room_id=sqlc.arg(room_id)::text AND tenant_id=sqlc.arg(tenant_id)::text
  AND (cadence_kind<>'once' OR enabled);

-- name: CreateRoomReminder :one
INSERT INTO room_reminders (
    id, tenant_id, room_id, created_by_actor_id, name, instruction, mention_actor_id,
    cadence_kind, timezone, hour, minute, weekdays, interval_minutes, run_at,
    enabled, next_run_at, template_agent_actor_id, template_routine_key, "trigger",
    tracking_item_id, tracking_purpose
) VALUES (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(room_id), sqlc.arg(created_by_actor_id),
    sqlc.arg(name), sqlc.arg(instruction), sqlc.narg(mention_actor_id), sqlc.narg(cadence_kind), sqlc.arg(timezone),
    sqlc.narg(hour), sqlc.narg(minute), sqlc.narg(weekdays)::text[], sqlc.narg(interval_minutes),
    sqlc.narg(run_at), sqlc.arg(enabled), sqlc.narg(next_run_at), sqlc.narg(template_agent_actor_id),
    sqlc.narg(template_routine_key), sqlc.narg(trigger_spec)::jsonb,
    sqlc.narg(tracking_item_id), sqlc.narg(tracking_purpose)
)
RETURNING *;

-- name: GetRoomReminder :one
SELECT *
FROM room_reminders
WHERE id=sqlc.arg(id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND room_id=sqlc.arg(room_id)::text;

-- name: GetRoomReminderRoomID :one
-- The Room a Routine write authorizes in; the Routine row is locked afterwards.
SELECT room_id
FROM room_reminders
WHERE id=sqlc.arg(id)::text;

-- name: ListRoomReminders :many
SELECT *
FROM room_reminders
WHERE room_id=sqlc.arg(room_id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND (
    sqlc.narg(cursor_created_at)::timestamptz IS NULL
    OR (created_at, id) < (sqlc.narg(cursor_created_at)::timestamptz, sqlc.narg(cursor_id)::text)
  )
ORDER BY created_at DESC, id DESC
LIMIT sqlc.arg(list_limit)::int;

-- name: UpdateRoomReminder :one
UPDATE room_reminders
SET name=sqlc.arg(name),
    instruction=sqlc.arg(instruction),
    mention_actor_id=sqlc.narg(mention_actor_id),
    cadence_kind=sqlc.arg(cadence_kind),
    timezone=sqlc.arg(timezone),
    hour=sqlc.narg(hour),
    minute=sqlc.narg(minute),
    weekdays=sqlc.narg(weekdays)::text[],
    interval_minutes=sqlc.narg(interval_minutes),
    run_at=sqlc.narg(run_at),
    enabled=sqlc.arg(enabled),
    next_run_at=sqlc.narg(next_run_at),
    revision=revision+1,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND room_id=sqlc.arg(room_id)::text
  AND revision=sqlc.arg(expected_revision)::bigint
  AND (NOT sqlc.arg(enabled)::boolean OR template_agent_actor_id IS NULL OR EXISTS (
      SELECT 1 FROM agent_registrations registration
      WHERE registration.actor_id=room_reminders.template_agent_actor_id AND registration.status='active'
  ))
RETURNING *;

-- name: DeleteRoomReminder :one
DELETE FROM room_reminders
WHERE id=sqlc.arg(id)::text
  AND tenant_id=sqlc.arg(tenant_id)::text
  AND room_id=sqlc.arg(room_id)::text
  AND revision=sqlc.arg(expected_revision)::bigint
RETURNING *;

-- name: DeleteTrackingItemRoomReminders :many
-- The Routines serving Tracking Items about to be deleted go first, so each
-- deletion is recorded in its Room instead of cascading silently.
DELETE FROM room_reminders
WHERE tenant_id=sqlc.arg(tenant_id)::text
  AND tracking_item_id=ANY(sqlc.arg(tracking_item_ids)::text[])
RETURNING *;

-- name: DeleteTemplateRoomReminders :many
DELETE FROM room_reminders
WHERE template_routine_key=sqlc.arg(template_routine_key)::text
RETURNING *;

-- name: LockDueRoomReminderOccurrence :one
-- Locks one scheduled occurrence. An edited, paused, deleted, or already advanced
-- Reminder has no row at this due time, so its stale job does nothing.
SELECT reminder.*
FROM room_reminders reminder
JOIN rooms room ON room.id=reminder.room_id AND room.tenant_id=reminder.tenant_id
WHERE reminder.id=sqlc.arg(id)::text
  AND reminder.enabled
  AND reminder.next_run_at=sqlc.arg(due_at)::timestamptz
  AND room.deleted_at IS NULL
FOR UPDATE OF reminder;

-- name: ListOverdueRoomReminderOccurrences :many
SELECT reminder.id, reminder.next_run_at
FROM room_reminders reminder
JOIN rooms room ON room.id=reminder.room_id AND room.tenant_id=reminder.tenant_id
WHERE reminder.enabled
  AND reminder.next_run_at<clock_timestamp()-interval '2 minutes'
  AND room.deleted_at IS NULL
ORDER BY reminder.next_run_at, reminder.id;

-- name: LockRoomReminder :one
-- NO KEY UPDATE still lets a listener poll record deliveries, which reference
-- the Routine, while a write holds it.
SELECT *
FROM room_reminders
WHERE id=sqlc.arg(id)::text AND tenant_id=sqlc.arg(tenant_id)::text AND room_id=sqlc.arg(room_id)::text
FOR NO KEY UPDATE;

-- name: AdvanceRoomReminderSchedule :one
UPDATE room_reminders
SET next_run_at=sqlc.arg(next_run_at)::timestamptz,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text
  AND enabled
  AND next_run_at=sqlc.arg(expected_next_run_at)::timestamptz
RETURNING *;

-- name: FinishRoomReminderSchedule :one
-- A one-shot Routine past its occurrence is done: disabled, nothing scheduled.
UPDATE room_reminders
SET enabled=false,
    next_run_at=NULL,
    revision=revision+1,
    updated_at=clock_timestamp()
WHERE id=sqlc.arg(id)::text
  AND enabled
  AND next_run_at=sqlc.arg(expected_next_run_at)::timestamptz
RETURNING *;

-- name: ResolveReminderAgentRoomAuthority :one
SELECT room.tenant_id, caller.id AS actor_id, membership.role
FROM rooms room
JOIN actors caller
  ON caller.tenant_id=room.tenant_id
 AND caller.id=sqlc.arg(actor_id)::text
 AND caller.kind='agent'
JOIN agent_registrations registration
  ON registration.actor_id=caller.id
 AND registration.tenant_id=caller.tenant_id
 AND registration.agent_management_id=sqlc.arg(agent_management_id)::text
 AND registration.status='active'
JOIN room_members membership
  ON membership.room_id=room.id
 AND membership.actor_id=caller.id
WHERE room.id=sqlc.arg(room_id)::text
  AND room.deleted_at IS NULL
  AND room_actor_participating(room.id, caller.id)
FOR KEY SHARE OF membership, registration;

-- name: ListActiveHumanRoomMemberIDs :many
SELECT actor.id
FROM active_room_members membership
JOIN actors actor
  ON actor.id=membership.actor_id
 AND actor.tenant_id=membership.tenant_id
WHERE membership.room_id=sqlc.arg(room_id)::text
  AND membership.tenant_id=sqlc.arg(tenant_id)::text
  AND actor.kind='human'
ORDER BY actor.id;

-- name: GetLatestActiveHumanMessageAuthorID :one
SELECT actor.id
FROM messages message
JOIN actors actor
  ON actor.id=message.author_actor_id
 AND actor.tenant_id=message.tenant_id
JOIN active_room_members membership
  ON membership.room_id=message.room_id
 AND membership.tenant_id=message.tenant_id
 AND membership.actor_id=actor.id
WHERE message.room_id=sqlc.arg(room_id)::text
  AND message.tenant_id=sqlc.arg(tenant_id)::text
  AND message.message_kind='conversation'
  AND actor.kind='human'
  AND message.created_at<=sqlc.arg(before)::timestamptz
ORDER BY message.created_at DESC, message.id DESC
LIMIT 1;

-- name: GetAgentOwnedTrackingItem :one
-- A Tracking Item of the Human this AnotherMe represents.
SELECT item.id, item.content
FROM memory_index.tracking_items item
JOIN agent_registrations registration ON registration.represented_human_actor_id=item.owner_actor_id
 AND registration.tenant_id=item.tenant_id
WHERE item.id=sqlc.arg(id)::text AND registration.actor_id=sqlc.arg(agent_actor_id)::text
  AND registration.agent_type='anotherme' AND registration.status<>'revoked';

-- name: IsTrackingItemClosed :one
-- A Routine serving a done Tracking Item has nothing left to do.
SELECT EXISTS (
  SELECT 1 FROM memory_index.tracking_items WHERE id=sqlc.arg(id)::text AND status='done'
)::boolean;

-- name: GetHumanActorTenantID :one
SELECT tenant_id FROM actors WHERE id=sqlc.arg(id)::text AND kind='human';

-- name: GetRoutineLatestOccurrenceState :one
-- Reports the Routine's newest undelivered quiet wake and newest trigger
-- Message (and whether that Message reached a terminal Run), so the scheduler
-- can skip overlapping fires without blocking forever after 24 hours.
WITH latest_wake AS (
    SELECT wake.created_at
    FROM proactive_pending_wakes wake
    WHERE wake.room_id=sqlc.arg(room_id)::text
      AND wake.fired_routine_id=sqlc.arg(routine_id)::text
      AND wake.delivered_at IS NULL
    ORDER BY wake.created_at DESC, wake.id DESC
    LIMIT 1
),
latest_message AS (
    SELECT m.id, m.created_at, m.mentioned_actor_ids
    FROM messages m
    WHERE m.room_id=sqlc.arg(room_id)::text
      AND m.fired_routine_id=sqlc.arg(routine_id)::text
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
)
SELECT
    (SELECT created_at FROM latest_wake)::timestamptz AS latest_undelivered_wake_at,
    (SELECT created_at FROM latest_message)::timestamptz AS latest_message_created_at,
    coalesce((
        SELECT (
            EXISTS (
                SELECT 1
                FROM agent_runtime_inputs input
                JOIN agent_local_run_inputs relation
                  ON relation.context_key=input.context_key
                 AND relation.input_id=input.input_id
                JOIN agent_local_runs run
                  ON run.context_key=relation.context_key
                 AND run.run_id=relation.run_id
                WHERE input.source_kind='inbox'
                  AND input.source_message_id=lm.id
                  AND run.status IN ('succeeded', 'failed', 'canceled')
            )
            OR EXISTS (
                SELECT 1
                FROM agent_execution_contexts ctx
                JOIN agent_runtime_inputs input
                  ON input.context_key=ctx.context_key
                JOIN agent_local_run_inputs relation
                  ON relation.context_key=input.context_key
                 AND relation.input_id=input.input_id
                JOIN agent_local_runs run
                  ON run.context_key=relation.context_key
                 AND run.run_id=relation.run_id
                WHERE ctx.context_kind='meta'
                  AND ctx.room_id=sqlc.arg(room_id)::text
                  AND ctx.agent_actor_id=ANY(lm.mentioned_actor_ids)
                  AND input.source_kind='inbox'
                  AND input.created_at>=lm.created_at
                  AND jsonb_typeof(input.payload->'invocationMessageIds')='array'
                  AND (input.payload->'invocationMessageIds') ? lm.id
                  AND run.status IN ('succeeded', 'failed', 'canceled')
            )
        )
        FROM latest_message lm
    ), false)::boolean AS latest_message_terminal;

-- name: PauseAgentTemplateOriginRoutines :many
UPDATE room_reminders
SET enabled=false, next_run_at=NULL, revision=revision+1, updated_at=clock_timestamp()
WHERE template_agent_actor_id=$1
RETURNING *;
