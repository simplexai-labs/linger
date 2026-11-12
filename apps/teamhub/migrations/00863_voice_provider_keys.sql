-- +goose Up
-- Voice provider API keys saved in the product, one row per provider, sealed
-- with TEAMHUB_SECRET_ENCRYPTION_KEY like composio_settings. TeamHub reads a
-- row each time voice needs the key, so every replica sees a save at once; a
-- provider's environment variable wins over its row.
CREATE TABLE voice_provider_keys (
    provider text PRIMARY KEY CHECK (provider IN ('soniox', 'xai')),
    api_key_ciphertext bytea NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- +goose Down
DROP TABLE voice_provider_keys;
