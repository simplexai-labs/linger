-- +goose Up
-- Channel Rooms isolate external messaging bridges (such as iMessage) into
-- their own Human + Another Me Room so they keep a separate Agent session
-- while remaining readable to Another Me, Memory, and Wiki.
ALTER TABLE rooms
  ADD COLUMN channel_kind text,
  ADD COLUMN channel_human_actor_id text,
  ADD COLUMN channel_agent_actor_id text;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_channel_kind_check
    CHECK (channel_kind IS NULL OR channel_kind = ANY (ARRAY['imessage'::text])),
  ADD CONSTRAINT rooms_channel_pair_shape
    CHECK ((channel_kind IS NULL) = (channel_human_actor_id IS NULL)
       AND (channel_kind IS NULL) = (channel_agent_actor_id IS NULL)),
  ADD CONSTRAINT rooms_channel_pair_distinct
    CHECK (channel_human_actor_id <> channel_agent_actor_id),
  ADD CONSTRAINT rooms_channel_exclusive
    CHECK (channel_kind IS NULL OR (direct_agent_actor_id IS NULL AND parent_room_id IS NULL)),
  ADD CONSTRAINT rooms_channel_human_actor_fkey
    FOREIGN KEY (channel_human_actor_id, tenant_id) REFERENCES actors(id, tenant_id),
  ADD CONSTRAINT rooms_channel_agent_actor_fkey
    FOREIGN KEY (channel_agent_actor_id, tenant_id) REFERENCES agent_registrations(actor_id, tenant_id);

CREATE UNIQUE INDEX rooms_channel_pair_key
  ON rooms (tenant_id, channel_human_actor_id, channel_agent_actor_id, channel_kind)
  WHERE channel_kind IS NOT NULL;

CREATE INDEX rooms_channel_agent_idx
  ON rooms (channel_agent_actor_id)
  WHERE channel_agent_actor_id IS NOT NULL;

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.agent_inbox_message_disposition(p_tenant text, p_agent text, p_context text, p_inbox text, p_message text) RETURNS TABLE(disposition text, mentioned boolean)
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE
   WHEN message.canceled
     OR message.message_kind<>'conversation' AND (message.message_kind<>'agent_runtime' OR NOT message.mentioned)
     OR runtime.request->>'context_key' IS DISTINCT FROM p_context AND runtime.id IS NOT NULL
     THEN 'ignore'
   WHEN runtime.request->>'kind'='native_question' THEN 'runtime_response'
   WHEN message.author_kind='agent' AND message.author_actor_id=p_agent THEN 'skip'
   WHEN message.mentioned THEN 'notify'
   -- An Agent that receives every message hears each Room and Task message
   -- except a Human's decision result; a Thread wakes only the Agents its
   -- Messages mention.
   WHEN registration.receives_all_messages AND NOT message.in_thread
     AND NOT (message.message_kind='conversation' AND message.author_kind='human'
       AND message.card_context_message_id IS NOT NULL) THEN 'notify'
   ELSE 'skip' END,
  message.mentioned
 FROM (
  SELECT message.id,message.author_actor_id,message.message_kind,message.card_context_message_id,author.kind AS author_kind,
   coalesce(p_agent=ANY(message.mentioned_actor_ids),false)
   -- A Human's own words in a direct chat or Channel Room, or a Thread under
   -- it, address its Agent whether or not the client wrote the @: an API call,
   -- channel bridge, or forward must wake it and hold it to a reply.
   OR (message.message_kind='conversation' AND message.card_context_message_id IS NULL
    AND EXISTS(SELECT 1 FROM rooms room JOIN rooms owner_room ON owner_room.id=coalesce(room.parent_room_id,room.id)
     WHERE room.id=message.room_id
      AND ((owner_room.direct_agent_actor_id=p_agent AND owner_room.direct_human_actor_id=message.author_actor_id)
        OR (owner_room.channel_agent_actor_id=p_agent AND owner_room.channel_human_actor_id=message.author_actor_id)))) AS mentioned,
   EXISTS(SELECT 1 FROM room_agent_message_cancellations cancellation WHERE cancellation.agent_actor_id=p_agent
     AND cancellation.message_id=message.id) AS canceled,
   EXISTS(SELECT 1 FROM rooms thread WHERE thread.id=message.room_id AND thread.parent_room_id IS NOT NULL) AS in_thread
  FROM messages message JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
  WHERE message.id=p_message AND message.tenant_id=p_tenant
    AND NOT starts_with(coalesce(p_inbox,''),'meta:') AND NOT starts_with(coalesce(p_inbox,''),'taskmeta:')
 ) message
 LEFT JOIN LATERAL (SELECT decision.id,decision.request->'runtime' AS request FROM decisions decision
  WHERE decision.message_id=message.card_context_message_id AND decision.request ? 'runtime'
    AND message.message_kind='agent_runtime') runtime ON true
 LEFT JOIN agent_registrations registration ON registration.actor_id=p_agent AND registration.tenant_id=p_tenant
 UNION ALL
 -- A Task's alterEgo reads the private stream its coordinating Meta writes.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM agent_execution_contexts context
   WHERE context.context_key=p_context AND context.context_kind='alter_ego') THEN 'notify' ELSE 'skip' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_messages message
 WHERE starts_with(p_inbox,'meta:') AND message.id=p_message AND message.tenant_id=p_tenant
 UNION ALL
 -- A report from a Task a call started is the live voice's to tell while
 -- its owner's call in that Room holds this Meta; it never wakes the Meta as
 -- well. Another user's call leaves it to the Meta.
 SELECT CASE WHEN EXISTS(SELECT 1 FROM voice_live_tasks task
   JOIN voice_sessions voice ON voice.room_id=task.room_id AND voice.created_by_actor_id=task.owner_actor_id
   JOIN agent_execution_contexts context ON context.context_key=p_context AND context.context_kind='meta'
    AND context.tenant_id=voice.tenant_id AND context.agent_actor_id=voice.live_agent_actor_id
   WHERE task.work_item_id=message.task_id AND voice.purpose='chat_live'
    AND voice.status IN ('provisioning','connected','reconnecting') AND voice.live_lease_until>now()
    AND (context.room_id=voice.room_id OR context.room_id=task.home_room_id))
   THEN 'ignore' ELSE 'notify' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_callback_messages message
 WHERE starts_with(p_inbox,'taskmeta:') AND message.id=p_message AND message.tenant_id=p_tenant;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.agent_inbox_message_disposition(p_tenant text, p_agent text, p_context text, p_inbox text, p_message text) RETURNS TABLE(disposition text, mentioned boolean)
    LANGUAGE sql STABLE
    AS $$
 SELECT CASE
   WHEN message.canceled
     OR message.message_kind<>'conversation' AND (message.message_kind<>'agent_runtime' OR NOT message.mentioned)
     OR runtime.request->>'context_key' IS DISTINCT FROM p_context AND runtime.id IS NOT NULL
     THEN 'ignore'
   WHEN runtime.request->>'kind'='native_question' THEN 'runtime_response'
   WHEN message.author_kind='agent' AND message.author_actor_id=p_agent THEN 'skip'
   WHEN message.mentioned THEN 'notify'
   WHEN registration.receives_all_messages AND NOT message.in_thread
     AND NOT (message.message_kind='conversation' AND message.author_kind='human'
       AND message.card_context_message_id IS NOT NULL) THEN 'notify'
   ELSE 'skip' END,
  message.mentioned
 FROM (
  SELECT message.id,message.author_actor_id,message.message_kind,message.card_context_message_id,author.kind AS author_kind,
   coalesce(p_agent=ANY(message.mentioned_actor_ids),false)
   OR (message.message_kind='conversation' AND message.card_context_message_id IS NULL
    AND EXISTS(SELECT 1 FROM rooms room JOIN rooms direct ON direct.id=coalesce(room.parent_room_id,room.id)
     WHERE room.id=message.room_id AND direct.direct_agent_actor_id=p_agent
      AND direct.direct_human_actor_id=message.author_actor_id)) AS mentioned,
   EXISTS(SELECT 1 FROM room_agent_message_cancellations cancellation WHERE cancellation.agent_actor_id=p_agent
     AND cancellation.message_id=message.id) AS canceled,
   EXISTS(SELECT 1 FROM rooms thread WHERE thread.id=message.room_id AND thread.parent_room_id IS NOT NULL) AS in_thread
  FROM messages message JOIN actors author ON author.id=message.author_actor_id AND author.tenant_id=message.tenant_id
  WHERE message.id=p_message AND message.tenant_id=p_tenant
    AND NOT starts_with(coalesce(p_inbox,''),'meta:') AND NOT starts_with(coalesce(p_inbox,''),'taskmeta:')
 ) message
 LEFT JOIN LATERAL (SELECT decision.id,decision.request->'runtime' AS request FROM decisions decision
  WHERE decision.message_id=message.card_context_message_id AND decision.request ? 'runtime'
    AND message.message_kind='agent_runtime') runtime ON true
 LEFT JOIN agent_registrations registration ON registration.actor_id=p_agent AND registration.tenant_id=p_tenant
 UNION ALL
 SELECT CASE WHEN EXISTS(SELECT 1 FROM agent_execution_contexts context
   WHERE context.context_key=p_context AND context.context_kind='alter_ego') THEN 'notify' ELSE 'skip' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_messages message
 WHERE starts_with(p_inbox,'meta:') AND message.id=p_message AND message.tenant_id=p_tenant
 UNION ALL
 SELECT CASE WHEN EXISTS(SELECT 1 FROM voice_live_tasks task
   JOIN voice_sessions voice ON voice.room_id=task.room_id AND voice.created_by_actor_id=task.owner_actor_id
   JOIN agent_execution_contexts context ON context.context_key=p_context AND context.context_kind='meta'
    AND context.tenant_id=voice.tenant_id AND context.agent_actor_id=voice.live_agent_actor_id
   WHERE task.work_item_id=message.task_id AND voice.purpose='chat_live'
    AND voice.status IN ('provisioning','connected','reconnecting') AND voice.live_lease_until>now()
    AND (context.room_id=voice.room_id OR context.room_id=task.home_room_id))
   THEN 'ignore' ELSE 'notify' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_callback_messages message
 WHERE starts_with(p_inbox,'taskmeta:') AND message.id=p_message AND message.tenant_id=p_tenant;
$$;
-- +goose StatementEnd

DROP INDEX IF EXISTS rooms_channel_agent_idx;
DROP INDEX IF EXISTS rooms_channel_pair_key;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_channel_agent_actor_fkey,
  DROP CONSTRAINT IF EXISTS rooms_channel_human_actor_fkey,
  DROP CONSTRAINT IF EXISTS rooms_channel_exclusive,
  DROP CONSTRAINT IF EXISTS rooms_channel_pair_distinct,
  DROP CONSTRAINT IF EXISTS rooms_channel_pair_shape,
  DROP CONSTRAINT IF EXISTS rooms_channel_kind_check,
  DROP COLUMN IF EXISTS channel_agent_actor_id,
  DROP COLUMN IF EXISTS channel_human_actor_id,
  DROP COLUMN IF EXISTS channel_kind;
