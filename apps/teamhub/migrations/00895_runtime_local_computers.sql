-- +goose Up
-- Expose only the columns the runtime owns. Older TeamHub processes can still
-- use the base table during a rolling upgrade.
CREATE VIEW runtime_local_computers WITH (security_invoker = true) AS
SELECT
    computer_id,
    display_name,
    status,
    credential_generation,
    active_operations,
    runtime_inventory,
    workspace_grants,
    runtime_diagnostics,
    last_seen_at,
    removed_at,
    created_at,
    updated_at,
    daemon_id,
    daemon_public_key,
    daemon_identity_version,
    platform,
    daemon_version,
    recommended_version,
    owner_tenant_id,
    owner_actor_id
FROM local_computers;

-- +goose Down
DROP VIEW runtime_local_computers;
