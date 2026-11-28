-- +goose Up
-- Persistent per-app desktop control grants on a Local Computer.
CREATE TABLE public.local_computer_app_grants (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
    computer_id text NOT NULL REFERENCES public.local_computers(computer_id) ON DELETE CASCADE,
    owner_actor_id text NOT NULL,
    agent_actor_id text NOT NULL,
    bundle_id text NOT NULL CHECK (length(btrim(bundle_id)) >= 1 AND length(bundle_id) <= 255),
    app_name text NOT NULL CHECK (length(btrim(app_name)) >= 1 AND length(app_name) <= 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamp with time zone NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamp with time zone,
    CHECK ((status = 'active') = (revoked_at IS NULL)),
    FOREIGN KEY (owner_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE,
    FOREIGN KEY (agent_actor_id, tenant_id) REFERENCES public.actors(id, tenant_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX local_computer_app_grants_active_unique_idx
    ON public.local_computer_app_grants (tenant_id, computer_id, agent_actor_id, bundle_id)
    WHERE status = 'active';

CREATE INDEX local_computer_app_grants_computer_owner_idx
    ON public.local_computer_app_grants (tenant_id, computer_id, owner_actor_id, status);

-- +goose Down
DROP TABLE public.local_computer_app_grants;
