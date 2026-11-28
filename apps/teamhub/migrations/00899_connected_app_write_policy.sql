-- +goose Up
-- Per-agent write approval policy for delegated external app connections.
ALTER TABLE public.external_connection_agent_grants
    ADD COLUMN write_policy text NOT NULL DEFAULT 'auto'
        CHECK (write_policy IN ('auto', 'always_allow', 'always_ask'));

-- +goose Down
ALTER TABLE public.external_connection_agent_grants
    DROP COLUMN write_policy;
