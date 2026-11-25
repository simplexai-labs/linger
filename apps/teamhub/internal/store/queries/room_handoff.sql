-- name: IsRunStartedByDirectChatHuman :one
-- Whether the Agent's running Run in its direct chat carries something the
-- Human did there: a Message they wrote, or the result of a card they
-- decided themselves. TeamHub also writes Messages in the Human's name with a
-- card's context, such as a reminder about a card still pending, so a card's
-- context alone proves nothing; its decision must name the Human. Quiet
-- wakes, Routine fires and Task callbacks carry neither. A Room input names
-- the Messages it carries in payload invocationMessageIds.
SELECT EXISTS (
  SELECT 1
  FROM agent_local_runs run
  JOIN agent_execution_contexts context ON context.context_key=run.context_key
  JOIN agent_local_run_inputs relation ON relation.run_id=run.run_id
  JOIN agent_runtime_inputs input
    ON input.context_key=relation.context_key AND input.input_id=relation.input_id
  JOIN messages message ON message.room_id=sqlc.arg(room_id)::text
   AND (input.source_message_id=message.id
        OR jsonb_typeof(input.payload->'invocationMessageIds')='array'
           AND input.payload->'invocationMessageIds' @> to_jsonb(message.id))
  WHERE run.run_id=sqlc.arg(run_id)::text AND run.status='running'
    AND run.status_room_id=sqlc.arg(room_id)::text
    AND context.tenant_id=sqlc.arg(tenant_id)::text
    AND context.agent_actor_id=sqlc.arg(agent_actor_id)::text
    AND message.author_actor_id=sqlc.arg(human_actor_id)::text
    AND (
      message.message_kind='conversation' AND message.card_context_message_id IS NULL
      OR EXISTS (
        SELECT 1 FROM decisions decision
        WHERE decision.message_id=message.card_context_message_id
          AND decision.room_id=message.room_id
          AND decision.decided_by_actor_id=sqlc.arg(human_actor_id)::text
      )
    )
)::boolean;

-- name: CreateRoomHandoff :exec
INSERT INTO room_handoffs(id,tenant_id,origin_room_id,room_id,human_actor_id,agent_actor_id)
VALUES(sqlc.arg(id)::text,sqlc.arg(tenant_id)::text,sqlc.arg(origin_room_id)::text,
  sqlc.arg(room_id)::text,sqlc.arg(human_actor_id)::text,sqlc.arg(agent_actor_id)::text);

-- name: GetRoomHandoff :one
SELECT * FROM room_handoffs WHERE id=sqlc.arg(id)::text FOR UPDATE;

-- name: SetRoomHandoffState :exec
UPDATE room_handoffs SET state=sqlc.arg(state)::text WHERE id=sqlc.arg(id)::text;

-- name: CreateRoomHandoffReport :exec
INSERT INTO room_handoff_reports(message_id,handoff_id,voice_session_id)
SELECT sqlc.arg(message_id)::text,handoff.id,(
 SELECT voice.id FROM voice_sessions voice
 WHERE voice.room_id=handoff.origin_room_id AND voice.created_by_actor_id=handoff.human_actor_id
   AND voice.live_agent_actor_id=handoff.agent_actor_id AND voice.tenant_id=handoff.tenant_id
   AND voice.purpose='chat_live' AND voice.status IN ('provisioning','connected','reconnecting')
   AND voice.live_lease_until>clock_timestamp()
 ORDER BY voice.created_at DESC,voice.id LIMIT 1
)
FROM room_handoffs handoff WHERE handoff.id=sqlc.arg(handoff_id)::text;

-- name: ListVoiceLiveRoomReports :many
-- Private reports remain in the direct chat after the call ends. Only new,
-- untold reports for this Human's AnotherMe are spoken during this call.
SELECT report.message_id,handoff.id AS handoff_id,handoff.room_id,room.name AS room_name,
  handoff.state,message.body
FROM room_handoff_reports report
JOIN room_handoffs handoff ON handoff.id=report.handoff_id
JOIN messages message ON message.id=report.message_id
JOIN rooms room ON room.id=handoff.room_id AND room.deletion_started_at IS NULL AND room.deleted_at IS NULL
JOIN voice_sessions voice ON voice.id=sqlc.arg(voice_session_id)::text AND report.voice_session_id=voice.id
  AND voice.room_id=handoff.origin_room_id AND voice.created_by_actor_id=handoff.human_actor_id
  AND voice.live_agent_actor_id=handoff.agent_actor_id AND voice.tenant_id=handoff.tenant_id
JOIN active_room_members human ON human.room_id=room.id AND human.actor_id=handoff.human_actor_id
JOIN active_room_members agent ON agent.room_id=room.id AND agent.actor_id=handoff.agent_actor_id
WHERE report.told_at IS NULL
AND NOT EXISTS (
 SELECT 1 FROM room_member_states state WHERE state.room_id=room.id AND state.left_at IS NOT NULL
 AND (state.actor_id=human.actor_id AND state.participation_epoch_id=human.membership_epoch_id
   OR state.actor_id=agent.actor_id AND state.participation_epoch_id=agent.membership_epoch_id)
)
ORDER BY message.created_at,message.id LIMIT 50;

-- name: MarkVoiceLiveRoomReportsTold :exec
UPDATE room_handoff_reports report SET told_at=clock_timestamp()
FROM room_handoffs handoff,voice_sessions voice
WHERE report.handoff_id=handoff.id
  AND report.message_id=ANY(sqlc.arg(message_ids)::text[]) AND report.told_at IS NULL
  AND voice.id=sqlc.arg(voice_session_id)::text AND voice.room_id=handoff.origin_room_id
  AND voice.created_by_actor_id=handoff.human_actor_id AND voice.live_agent_actor_id=handoff.agent_actor_id
  AND voice.tenant_id=handoff.tenant_id AND report.voice_session_id=voice.id;

-- name: GetRoomHandoffMember :one
-- A departed member must rejoin before continuing a cross-Room request.
SELECT actor.id,actor.tenant_id,actor.kind,actor.display_name,actor.account_id,actor.handle,actor.created_at
FROM active_room_members member
JOIN actors actor ON actor.id=member.actor_id AND actor.tenant_id=member.tenant_id
JOIN rooms room ON room.id=member.room_id AND room.deleted_at IS NULL AND room.deletion_started_at IS NULL
LEFT JOIN room_member_states state ON state.room_id=member.room_id AND state.actor_id=member.actor_id
  AND state.participation_epoch_id=member.membership_epoch_id
WHERE member.room_id=sqlc.arg(room_id)::text AND member.actor_id=sqlc.arg(actor_id)::text AND state.left_at IS NULL
FOR KEY SHARE OF member;

-- name: ListAgentMessageRoomHandoffs :many
-- Attach routing only to reports the history read already authorized.
SELECT report.message_id,handoff.id AS handoff_id,handoff.room_id,room.name AS room_name,handoff.state
FROM room_handoff_reports report
JOIN room_handoffs handoff ON handoff.id=report.handoff_id
JOIN rooms room ON room.id=handoff.room_id
WHERE report.message_id=ANY(sqlc.arg(message_ids)::text[])
  AND handoff.agent_actor_id=sqlc.arg(actor_id)::text AND handoff.tenant_id=sqlc.arg(tenant_id)::text;
