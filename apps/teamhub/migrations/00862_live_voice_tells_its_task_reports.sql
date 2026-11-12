-- +goose Up
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
   coalesce(p_agent=ANY(message.mentioned_actor_ids),false) AS mentioned,
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
 -- A report from a Task a call started is the live voice's to tell while the
 -- call holds the Meta foreground; it never wakes the Meta as well.
 SELECT CASE WHEN voice_live_owns_context(p_context)
   AND EXISTS(SELECT 1 FROM voice_live_tasks task WHERE task.work_item_id=message.task_id)
   THEN 'ignore' ELSE 'notify' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_callback_messages message
 WHERE starts_with(p_inbox,'taskmeta:') AND message.id=p_message AND message.tenant_id=p_tenant;
$$;
-- +goose StatementEnd

ALTER TABLE task_meta_callback_messages DROP COLUMN non_actionable;

-- +goose Down
ALTER TABLE task_meta_callback_messages ADD COLUMN non_actionable boolean DEFAULT false NOT NULL;

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
   coalesce(p_agent=ANY(message.mentioned_actor_ids),false) AS mentioned,
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
 SELECT CASE WHEN message.non_actionable THEN 'ignore' ELSE 'notify' END,
  agent_inbox_directly_mentions(message.segments,p_agent)
 FROM task_meta_callback_messages message
 WHERE starts_with(p_inbox,'taskmeta:') AND message.id=p_message AND message.tenant_id=p_tenant;
$$;
-- +goose StatementEnd
