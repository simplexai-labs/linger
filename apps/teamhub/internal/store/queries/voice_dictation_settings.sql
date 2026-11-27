-- name: GetVoiceDictationSettings :one
SELECT polish_model, polish_source, polish_api_base_url, polish_api_model, polish_api_key_ciphertext
FROM voice_dictation_settings WHERE singleton;

-- name: SaveVoiceDictationCLI :exec
INSERT INTO voice_dictation_settings (singleton, polish_model, polish_source)
VALUES (true, $1, 'cli')
ON CONFLICT (singleton) DO UPDATE SET polish_model = EXCLUDED.polish_model, polish_source = 'cli', updated_at = now();

-- name: SaveVoiceDictationAPI :exec
INSERT INTO voice_dictation_settings (singleton, polish_model, polish_source, polish_api_base_url, polish_api_model, polish_api_key_ciphertext)
VALUES (true, $1, 'api', $2, $3, $4)
ON CONFLICT (singleton) DO UPDATE SET
    polish_source = 'api',
    polish_api_base_url = EXCLUDED.polish_api_base_url,
    polish_api_model = EXCLUDED.polish_api_model,
    polish_api_key_ciphertext = EXCLUDED.polish_api_key_ciphertext,
    updated_at = now();
