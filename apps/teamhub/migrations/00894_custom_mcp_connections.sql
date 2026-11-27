-- +goose Up
CREATE TABLE public.custom_mcp_connections (
    connection_id text PRIMARY KEY REFERENCES public.external_connections(id) ON DELETE CASCADE,
    tenant_id text NOT NULL,
    owner_actor_id text NOT NULL,
    endpoint text NOT NULL,
    encrypted_token bytea,
    tools jsonb NOT NULL CHECK (jsonb_typeof(tools) = 'array'),
    FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE
);

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'custom MCP connection migration is forward-only';
END $$;
-- +goose StatementEnd
