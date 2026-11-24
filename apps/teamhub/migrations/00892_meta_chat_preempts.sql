-- +goose Up
-- In a Meta Context a chat never waits behind other work of that Context. A
-- chat is a Human's conversation Message that mentions the Agent (a direct
-- chat counts as a mention) or a hidden Message a Human waits on. It steers
-- into the running Run whichever Inbox that Run reads, it does not join a
-- queued Run that serves no chat, and a queued Run that serves a chat is
-- claimed before older queued Runs.
-- +goose StatementBegin
CREATE FUNCTION agent_runtime_input_is_chat(p_payload jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE
AS $$
SELECT EXISTS (
 SELECT 1 FROM jsonb_array_elements(
  CASE WHEN jsonb_typeof(p_payload->'acceptedNotification'->'messages')='array'
   THEN p_payload->'acceptedNotification'->'messages' ELSE '[]'::jsonb END) AS message(value)
 WHERE (message.value->>'messageKind'='agent_runtime' AND message.value->>'humanWaiting'='true')
  OR (message.value->>'messageKind'='conversation' AND message.value->>'authorType'='user'
   AND message.value->>'mentioned'='true'));
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION agent_local_run_serves_chat(p_run text) RETURNS boolean
LANGUAGE sql STABLE
AS $$
SELECT EXISTS (
 SELECT 1 FROM agent_local_run_inputs relation
 JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
 JOIN agent_execution_contexts context ON context.context_key=relation.context_key
 WHERE relation.run_id=p_run AND context.context_kind='meta' AND agent_runtime_input_is_chat(input.payload));
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE OR REPLACE FUNCTION place_agent_inbox_input(
 p_context text, p_inbox text, p_message text, p_input text, p_payload jsonb, p_targeted boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
 v_run text;
 v_candidate text;
 v_ordinal bigint := 0;
 v_chat boolean;
BEGIN
 v_chat := agent_runtime_input_is_chat(p_payload) AND EXISTS (
  SELECT 1 FROM agent_execution_contexts context WHERE context.context_key=p_context AND context.context_kind='meta');
 IF p_targeted OR v_chat THEN
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.context_key=p_context AND run.status='running' AND NOT run.cancellation_requested
   AND (v_chat OR EXISTS (
    SELECT 1 FROM agent_local_run_inputs relation
    JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
    WHERE relation.run_id=run.run_id AND input.payload->'sourceInboxIds' @> jsonb_build_array(p_inbox)));
  IF v_run IS NOT NULL THEN
   INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
    status,selection_result,steer_group_id)
   VALUES(p_context,p_input,p_payload,sha256(convert_to(p_payload::text,'UTF8')),'inbox',p_message,p_inbox,
    'steering','{"selected":"trusted_inbox_notification"}'::jsonb,'steer-'||replace(gen_random_uuid()::text,'-',''));
   PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.steered',p_context,0,0);
   RETURN;
  END IF;
 END IF;
 SELECT run.run_id INTO v_candidate FROM agent_local_runs run
 WHERE run.context_key=p_context AND run.status='queued'
 ORDER BY run.created_at DESC,run.run_id DESC LIMIT 1;
 IF v_candidate IS NOT NULL AND (NOT v_chat OR agent_local_run_serves_chat(v_candidate)) AND NOT EXISTS (
  SELECT 1 FROM agent_local_run_inputs relation
  JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
  WHERE relation.run_id=v_candidate AND (input.source_kind<>'inbox' OR input.source_inbox_id IS DISTINCT FROM p_inbox
   OR input.selection_result->>'selected' IS DISTINCT FROM 'trusted_inbox_notification')) THEN
  -- A Run being claimed or canceled keeps its Inputs; this Message starts the next one.
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.run_id=v_candidate AND run.context_key=p_context AND run.status='queued' AND NOT run.cancellation_requested
  FOR NO KEY UPDATE SKIP LOCKED;
 END IF;
 IF v_run IS NULL THEN
  v_run := 'local-run-'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO agent_local_runs(run_id,context_key,status) VALUES(v_run,p_context,'queued');
 ELSE
  SELECT coalesce(max(relation.ordinal)+1,0) INTO v_ordinal FROM agent_local_run_inputs relation
  WHERE relation.run_id=v_run AND relation.relation='initial';
 END IF;
 INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
  status,selection_result,local_run_id)
 VALUES(p_context,p_input,p_payload,sha256(convert_to(p_payload::text,'UTF8')),'inbox',p_message,p_inbox,
  'handled','{"selected":"trusted_inbox_notification","effective":"enqueue"}'::jsonb,v_run);
 INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
 VALUES(v_run,p_context,p_input,'initial',v_ordinal);
 PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.queued',p_context,0,0);
END;
$$;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION place_agent_inbox_input(
 p_context text, p_inbox text, p_message text, p_input text, p_payload jsonb, p_targeted boolean)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
 v_run text;
 v_candidate text;
 v_ordinal bigint := 0;
BEGIN
 IF p_targeted THEN
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.context_key=p_context AND run.status='running' AND NOT run.cancellation_requested
   AND EXISTS (
    SELECT 1 FROM agent_local_run_inputs relation
    JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
    WHERE relation.run_id=run.run_id AND input.payload->'sourceInboxIds' @> jsonb_build_array(p_inbox));
  IF v_run IS NOT NULL THEN
   INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
    status,selection_result,steer_group_id)
   VALUES(p_context,p_input,p_payload,sha256(convert_to(p_payload::text,'UTF8')),'inbox',p_message,p_inbox,
    'steering','{"selected":"trusted_inbox_notification"}'::jsonb,'steer-'||replace(gen_random_uuid()::text,'-',''));
   PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.steered',p_context,0,0);
   RETURN;
  END IF;
 END IF;
 SELECT run.run_id INTO v_candidate FROM agent_local_runs run
 WHERE run.context_key=p_context AND run.status='queued'
 ORDER BY run.created_at DESC,run.run_id DESC LIMIT 1;
 IF v_candidate IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_local_run_inputs relation
  JOIN agent_runtime_inputs input ON input.context_key=relation.context_key AND input.input_id=relation.input_id
  WHERE relation.run_id=v_candidate AND (input.source_kind<>'inbox' OR input.source_inbox_id IS DISTINCT FROM p_inbox
   OR input.selection_result->>'selected' IS DISTINCT FROM 'trusted_inbox_notification')) THEN
  -- A Run being claimed or canceled keeps its Inputs; this Message starts the next one.
  SELECT run.run_id INTO v_run FROM agent_local_runs run
  WHERE run.run_id=v_candidate AND run.context_key=p_context AND run.status='queued' AND NOT run.cancellation_requested
  FOR NO KEY UPDATE SKIP LOCKED;
 END IF;
 IF v_run IS NULL THEN
  v_run := 'local-run-'||replace(gen_random_uuid()::text,'-','');
  INSERT INTO agent_local_runs(run_id,context_key,status) VALUES(v_run,p_context,'queued');
 ELSE
  SELECT coalesce(max(relation.ordinal)+1,0) INTO v_ordinal FROM agent_local_run_inputs relation
  WHERE relation.run_id=v_run AND relation.relation='initial';
 END IF;
 INSERT INTO agent_runtime_inputs(context_key,input_id,payload,payload_hash,source_kind,source_message_id,source_inbox_id,
  status,selection_result,local_run_id)
 VALUES(p_context,p_input,p_payload,sha256(convert_to(p_payload::text,'UTF8')),'inbox',p_message,p_inbox,
  'handled','{"selected":"trusted_inbox_notification","effective":"enqueue"}'::jsonb,v_run);
 INSERT INTO agent_local_run_inputs(run_id,context_key,input_id,relation,ordinal)
 VALUES(v_run,p_context,p_input,'initial',v_ordinal);
 PERFORM publish_teamhub_realtime_wake('agent-inbox:all','run.queued',p_context,0,0);
END;
$$;
-- +goose StatementEnd
DROP FUNCTION agent_local_run_serves_chat(text);
DROP FUNCTION agent_runtime_input_is_chat(jsonb);
