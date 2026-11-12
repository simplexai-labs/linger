-- name: GetVoiceProviderKey :one
SELECT api_key_ciphertext FROM voice_provider_keys WHERE provider = $1;

-- name: UpsertVoiceProviderKey :exec
INSERT INTO voice_provider_keys (provider, api_key_ciphertext) VALUES ($1, $2)
ON CONFLICT (provider) DO UPDATE SET api_key_ciphertext = excluded.api_key_ciphertext, updated_at = now();
