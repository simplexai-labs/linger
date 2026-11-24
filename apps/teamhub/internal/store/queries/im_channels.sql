-- name: ListIMChannelBindingsForActor :many
SELECT id, tenant_id, account_id, human_actor_id, provider, enabled,
       sealed_credentials, config_json, adapter_state_json,
       outbound_room_id, outbound_room_seq, pending_card_json,
       runtime_status, runtime_error_code, cooldown_until,
       last_inbound_at, last_outbound_at, created_at, updated_at
FROM im_channel_bindings
WHERE tenant_id = sqlc.arg(tenant_id)::text
  AND human_actor_id = sqlc.arg(human_actor_id)::text
ORDER BY created_at ASC;

-- name: GetIMChannelBindingForActor :one
SELECT id, tenant_id, account_id, human_actor_id, provider, enabled,
       sealed_credentials, config_json, adapter_state_json,
       outbound_room_id, outbound_room_seq, pending_card_json,
       runtime_status, runtime_error_code, cooldown_until,
       last_inbound_at, last_outbound_at, created_at, updated_at
FROM im_channel_bindings
WHERE tenant_id = sqlc.arg(tenant_id)::text
  AND human_actor_id = sqlc.arg(human_actor_id)::text
  AND provider = sqlc.arg(provider)::text;

-- name: GetIMChannelBindingByID :one
SELECT id, tenant_id, account_id, human_actor_id, provider, enabled,
       sealed_credentials, config_json, adapter_state_json,
       outbound_room_id, outbound_room_seq, pending_card_json,
       runtime_status, runtime_error_code, cooldown_until,
       last_inbound_at, last_outbound_at, created_at, updated_at
FROM im_channel_bindings
WHERE id = sqlc.arg(id)::text;

-- name: ListEnabledIMChannelBindings :many
SELECT b.id, b.tenant_id, b.account_id, b.human_actor_id, b.provider, b.enabled,
       b.sealed_credentials, b.config_json, b.adapter_state_json,
       b.outbound_room_id, b.outbound_room_seq, b.pending_card_json,
       b.runtime_status, b.runtime_error_code, b.cooldown_until,
       b.last_inbound_at, b.last_outbound_at, b.created_at, b.updated_at,
       reg.actor_id AS another_me_actor_id,
       room.id AS another_me_room_id
FROM im_channel_bindings b
LEFT JOIN agent_registrations reg
  ON reg.tenant_id = b.tenant_id
 AND reg.represented_human_actor_id = b.human_actor_id
 AND reg.agent_type = 'anotherme'
 AND reg.status = 'active'
LEFT JOIN rooms room
  ON room.tenant_id = reg.tenant_id
 AND room.channel_kind = b.provider
 AND room.channel_human_actor_id = reg.represented_human_actor_id
 AND room.channel_agent_actor_id = reg.actor_id
 AND room.deletion_started_at IS NULL
WHERE b.enabled = true
ORDER BY b.created_at ASC;

-- name: HasEnabledIMChannelBindingForRoom :one
SELECT EXISTS (
    SELECT 1
    FROM im_channel_bindings b
    LEFT JOIN agent_registrations reg
      ON reg.tenant_id = b.tenant_id
     AND reg.represented_human_actor_id = b.human_actor_id
     AND reg.agent_type = 'anotherme'
     AND reg.status = 'active'
    LEFT JOIN rooms room
      ON room.tenant_id = reg.tenant_id
     AND room.channel_kind = b.provider
     AND room.channel_human_actor_id = reg.represented_human_actor_id
     AND room.channel_agent_actor_id = reg.actor_id
     AND room.deletion_started_at IS NULL
    WHERE b.enabled = true
      AND (b.outbound_room_id = sqlc.arg(room_id)::text OR room.id = sqlc.arg(room_id)::text)
) AS has_binding;

-- name: UpsertIMChannelBinding :one
INSERT INTO im_channel_bindings (
    id, tenant_id, account_id, human_actor_id, provider, enabled,
    sealed_credentials, config_json, adapter_state_json,
    outbound_room_id, outbound_room_seq, pending_card_json,
    runtime_status, runtime_error_code, cooldown_until
)
VALUES (
    sqlc.arg(id)::text,
    sqlc.arg(tenant_id)::text,
    sqlc.arg(account_id)::text,
    sqlc.arg(human_actor_id)::text,
    sqlc.arg(provider)::text,
    true,
    sqlc.arg(sealed_credentials)::bytea,
    sqlc.arg(config_json)::jsonb,
    '{}'::jsonb,
    sqlc.narg(outbound_room_id)::text,
    sqlc.arg(outbound_room_seq)::bigint,
    NULL,
    'starting',
    NULL,
    NULL
)
ON CONFLICT (tenant_id, human_actor_id, provider) DO UPDATE
SET enabled = true,
    sealed_credentials = EXCLUDED.sealed_credentials,
    config_json = EXCLUDED.config_json,
    adapter_state_json = '{}'::jsonb,
    outbound_room_id = EXCLUDED.outbound_room_id,
    outbound_room_seq = EXCLUDED.outbound_room_seq,
    pending_card_json = NULL,
    runtime_status = 'starting',
    runtime_error_code = NULL,
    cooldown_until = NULL,
    updated_at = now()
RETURNING id, tenant_id, account_id, human_actor_id, provider, enabled,
          sealed_credentials, config_json, adapter_state_json,
          outbound_room_id, outbound_room_seq, pending_card_json,
          runtime_status, runtime_error_code, cooldown_until,
          last_inbound_at, last_outbound_at, created_at, updated_at;

-- name: SetIMChannelBindingEnabled :one
UPDATE im_channel_bindings
SET enabled = sqlc.arg(enabled)::boolean,
    runtime_status = CASE WHEN sqlc.arg(enabled)::boolean THEN 'starting' ELSE 'disconnected' END,
    runtime_error_code = NULL,
    cooldown_until = NULL,
    outbound_room_id = sqlc.narg(outbound_room_id)::text,
    outbound_room_seq = sqlc.arg(outbound_room_seq)::bigint,
    pending_card_json = NULL,
    updated_at = now()
WHERE tenant_id = sqlc.arg(tenant_id)::text
  AND human_actor_id = sqlc.arg(human_actor_id)::text
  AND provider = sqlc.arg(provider)::text
RETURNING id, tenant_id, account_id, human_actor_id, provider, enabled,
          sealed_credentials, config_json, adapter_state_json,
          outbound_room_id, outbound_room_seq, pending_card_json,
          runtime_status, runtime_error_code, cooldown_until,
          last_inbound_at, last_outbound_at, created_at, updated_at;

-- name: DeleteIMChannelBinding :execrows
DELETE FROM im_channel_bindings
WHERE tenant_id = sqlc.arg(tenant_id)::text
  AND human_actor_id = sqlc.arg(human_actor_id)::text
  AND provider = sqlc.arg(provider)::text;

-- name: UpdateIMChannelRuntimeState :one
UPDATE im_channel_bindings
SET runtime_status = COALESCE(sqlc.narg(runtime_status)::text, runtime_status),
    runtime_error_code = CASE
        WHEN sqlc.arg(set_runtime_error_code)::boolean THEN sqlc.narg(runtime_error_code)::text
        ELSE runtime_error_code
    END,
    cooldown_until = CASE
        WHEN sqlc.arg(clear_cooldown)::boolean THEN NULL
        WHEN sqlc.narg(cooldown_until)::timestamptz IS NOT NULL THEN sqlc.narg(cooldown_until)::timestamptz
        ELSE cooldown_until
    END,
    adapter_state_json = CASE
        WHEN sqlc.narg(adapter_state_patch)::jsonb IS NOT NULL
        THEN adapter_state_json || sqlc.narg(adapter_state_patch)::jsonb
        ELSE adapter_state_json
    END,
    outbound_room_id = COALESCE(sqlc.narg(outbound_room_id)::text, outbound_room_id),
    outbound_room_seq = GREATEST(outbound_room_seq, COALESCE(sqlc.narg(outbound_room_seq)::bigint, 0)),
    pending_card_json = CASE
        WHEN sqlc.arg(clear_pending_card)::boolean THEN NULL
        WHEN sqlc.narg(pending_card_json)::jsonb IS NOT NULL THEN sqlc.narg(pending_card_json)::jsonb
        ELSE pending_card_json
    END,
    last_inbound_at = CASE
        WHEN sqlc.arg(touch_inbound)::boolean THEN now()
        ELSE last_inbound_at
    END,
    last_outbound_at = CASE
        WHEN sqlc.arg(touch_outbound)::boolean THEN now()
        ELSE last_outbound_at
    END,
    updated_at = now()
WHERE id = sqlc.arg(id)::text
RETURNING id, tenant_id, account_id, human_actor_id, provider, enabled,
          sealed_credentials, config_json, adapter_state_json,
          outbound_room_id, outbound_room_seq, pending_card_json,
          runtime_status, runtime_error_code, cooldown_until,
          last_inbound_at, last_outbound_at, created_at, updated_at;

-- name: ClearIMChannelPendingCard :exec
UPDATE im_channel_bindings
SET pending_card_json = NULL,
    updated_at = now()
WHERE id = sqlc.arg(id)::text;

-- name: MergeIMChannelAdapterState :exec
UPDATE im_channel_bindings
SET adapter_state_json = CASE
        WHEN sqlc.narg(adapter_state_patch)::jsonb IS NOT NULL
        THEN adapter_state_json || sqlc.narg(adapter_state_patch)::jsonb
        ELSE adapter_state_json
    END,
    last_inbound_at = now(),
    updated_at = now()
WHERE id = sqlc.arg(id)::text;
