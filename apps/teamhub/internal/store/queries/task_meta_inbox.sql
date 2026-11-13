-- name: EnsureTaskMetaInbox :exec
INSERT INTO task_meta_inboxes(task_id,tenant_id,agent_actor_id)
VALUES($1,$2,$3)
ON CONFLICT(task_id,agent_actor_id) DO NOTHING;

-- name: GetTaskMetaInboxForUpdate :one
SELECT task_id,tenant_id,agent_actor_id,through_seq,created_at,updated_at
FROM task_meta_inboxes
WHERE task_id=$1 AND tenant_id=$2 AND agent_actor_id=$3
FOR UPDATE;

-- name: CreateTaskMetaMessage :one
INSERT INTO task_meta_messages(
    id,tenant_id,task_id,agent_actor_id,meta_seq,author_actor_id,body,segments,source
)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
RETURNING id,tenant_id,task_id,agent_actor_id,meta_seq,author_actor_id,body,segments,created_at,source;

-- name: SetTaskMetaInboxThroughSeq :execrows
UPDATE task_meta_inboxes
SET through_seq=$4,updated_at=now()
WHERE task_id=$1 AND tenant_id=$2 AND agent_actor_id=$3 AND through_seq<$4;

-- name: ListTaskConversationInputs :many
-- Every input the Task's own Agent received in its current generation, in
-- delivery order. Other participants hold copies of the same inputs.
SELECT message.id,message.author_actor_id,author.kind AS author_kind,
       author.display_name AS author_display_name,message.body,message.source,message.created_at
FROM work_items item
JOIN task_execution_generations generation
  ON generation.task_id=item.id AND generation.tenant_id=item.tenant_id
 AND generation.generation=item.task_execution_generation
JOIN task_meta_messages message
  ON message.task_id=item.id AND message.tenant_id=item.tenant_id
 AND message.agent_actor_id=generation.result_agent_actor_id
JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
WHERE item.id=sqlc.arg(task_id)::text
ORDER BY message.meta_seq
LIMIT 500;

-- name: ListTaskConversationCards :many
-- Every card the Task's AlterEgo raised, answered or not, by its card Message.
SELECT id,room_id,message_id,created_at
FROM decisions
WHERE tenant_id=sqlc.arg(tenant_id)::text AND alter_ego_task_id=sqlc.arg(task_id)::text
ORDER BY created_at,id
LIMIT 200;
