-- +goose Up
-- How the deployment dictates without a Soniox key: what rewrites dictated
-- text, either the connected CLI on a model or an OpenAI-compatible API of the
-- deployment's own. One row for the whole deployment, like the voice provider
-- keys; no row means nobody chose yet, and dictation on the downloaded speech
-- model stays off until someone does.
--
-- polish_model is the CLI model whatever the source is, and the API settings
-- stay when the source goes back to the CLI, so a person can switch again
-- without entering the key twice. The key is sealed with
-- TEAMHUB_SECRET_ENCRYPTION_KEY like the voice provider keys.
CREATE TABLE voice_dictation_settings (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    polish_model text NOT NULL CHECK (polish_model <> '' AND char_length(polish_model) <= 100),
    polish_source text NOT NULL DEFAULT 'cli' CHECK (polish_source IN ('cli', 'api')),
    polish_api_base_url text CHECK (char_length(polish_api_base_url) <= 300),
    polish_api_model text CHECK (polish_api_model <> '' AND char_length(polish_api_model) <= 100),
    polish_api_key_ciphertext bytea,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT voice_dictation_api_complete CHECK (
        polish_source <> 'api'
        OR (polish_api_base_url IS NOT NULL AND polish_api_model IS NOT NULL AND polish_api_key_ciphertext IS NOT NULL)
    )
);

-- +goose Down
DROP TABLE voice_dictation_settings;
