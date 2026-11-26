-- name: GetVoiceSettings :one
SELECT account_id, tenant_id, speech_provider, local_computer_id, local_model_id,
       language, silence_timeout_seconds, use_gpu, keep_loaded_seconds, updated_at
FROM voice_settings
WHERE account_id = sqlc.arg(account_id)::text
  AND tenant_id = sqlc.arg(tenant_id)::text;

-- name: UpsertVoiceSettings :one
INSERT INTO voice_settings(
  account_id, tenant_id, speech_provider, local_computer_id, local_model_id,
  language, silence_timeout_seconds, use_gpu, keep_loaded_seconds, updated_at
) VALUES (
  sqlc.arg(account_id)::text,
  sqlc.arg(tenant_id)::text,
  sqlc.arg(speech_provider)::text,
  sqlc.narg(local_computer_id)::text,
  sqlc.narg(local_model_id)::text,
  sqlc.arg(language)::text,
  sqlc.arg(silence_timeout_seconds)::integer,
  sqlc.arg(use_gpu)::boolean,
  sqlc.arg(keep_loaded_seconds)::integer,
  clock_timestamp()
)
ON CONFLICT (account_id, tenant_id) DO UPDATE
SET speech_provider = EXCLUDED.speech_provider,
    local_computer_id = EXCLUDED.local_computer_id,
    local_model_id = EXCLUDED.local_model_id,
    language = EXCLUDED.language,
    silence_timeout_seconds = EXCLUDED.silence_timeout_seconds,
    use_gpu = EXCLUDED.use_gpu,
    keep_loaded_seconds = EXCLUDED.keep_loaded_seconds,
    updated_at = EXCLUDED.updated_at
RETURNING account_id, tenant_id, speech_provider, local_computer_id, local_model_id,
          language, silence_timeout_seconds, use_gpu, keep_loaded_seconds, updated_at;

-- name: ListOwnedLocalSpeechComputers :many
SELECT computer.computer_id, computer.display_name, computer.status, computer.last_seen_at,
       speech.snapshot AS speech_snapshot
FROM local_computers computer
LEFT JOIN local_computer_speech_snapshots speech
  ON speech.computer_id = computer.computer_id
WHERE computer.owner_tenant_id = sqlc.arg(tenant_id)::text
  AND computer.owner_actor_id = sqlc.arg(owner_actor_id)::text
  AND computer.status <> 'removed'
ORDER BY computer.last_seen_at DESC NULLS LAST, computer.computer_id ASC;

-- name: HasAnyAvailableLocalSpeechComputer :one
SELECT EXISTS (
  SELECT 1
  FROM local_computers computer
  JOIN local_computer_speech_snapshots speech
    ON speech.computer_id = computer.computer_id
  WHERE computer.status <> 'removed'
    AND (speech.snapshot->>'available')::boolean = true
) OR EXISTS (
  SELECT 1
  FROM voice_settings
  WHERE speech_provider = 'local'
);
