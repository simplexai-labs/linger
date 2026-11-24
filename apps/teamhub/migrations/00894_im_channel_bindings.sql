-- +goose Up
-- Expand Channel Room kinds so network IM providers (WeChat, WhatsApp,
-- Telegram, Discord, Slack) share the same isolated Room model as iMessage.
ALTER TABLE rooms
    DROP CONSTRAINT rooms_channel_kind_check,
    ADD CONSTRAINT rooms_channel_kind_check
        CHECK (channel_kind IS NULL OR channel_kind = ANY (ARRAY[
            'imessage'::text,
            'wechat'::text,
            'whatsapp'::text,
            'telegram'::text,
            'discord'::text,
            'slack'::text
        ]));

-- IM channel bindings connect a Human Actor's isolated Channel Room with
-- Another Me to an external network IM account (for example WeChat ClawBot,
-- WhatsApp Agents, Telegram, Discord, or Slack). Credentials are sealed with
-- secretbox; adapter cursors and outbound watermarks live here so Node Services
-- stays stateless.
CREATE TABLE im_channel_bindings (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    human_actor_id text NOT NULL REFERENCES actors(id) ON DELETE CASCADE,
    provider text NOT NULL CHECK (provider IN ('wechat', 'whatsapp', 'telegram', 'discord', 'slack')),
    enabled boolean NOT NULL DEFAULT true,
    sealed_credentials bytea NOT NULL,
    config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    adapter_state_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    outbound_room_id text,
    outbound_room_seq bigint NOT NULL DEFAULT 0,
    pending_card_json jsonb,
    runtime_status text NOT NULL DEFAULT 'starting'
        CHECK (runtime_status IN ('starting', 'connected', 'cooldown', 'conflict', 'auth_expired', 'disconnected', 'error')),
    runtime_error_code text,
    cooldown_until timestamp with time zone,
    last_inbound_at timestamp with time zone,
    last_outbound_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT im_channel_bindings_actor_provider_unique UNIQUE (tenant_id, human_actor_id, provider)
);

CREATE INDEX idx_im_channel_bindings_enabled
    ON im_channel_bindings (updated_at DESC)
    WHERE enabled = true;

CREATE INDEX idx_im_channel_bindings_outbound_room
    ON im_channel_bindings (outbound_room_id)
    WHERE enabled = true AND outbound_room_id IS NOT NULL;

-- +goose Down
DROP TABLE im_channel_bindings;

ALTER TABLE rooms
    DROP CONSTRAINT rooms_channel_kind_check,
    ADD CONSTRAINT rooms_channel_kind_check
        CHECK (channel_kind IS NULL OR channel_kind = ANY (ARRAY['imessage'::text]));
