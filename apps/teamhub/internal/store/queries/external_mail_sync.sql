-- name: ListMailSyncConnections :many
-- The mail Connections whose snapshot completed at their current revision
-- and whose sync position is before due.
SELECT id, revision
FROM external_connections
WHERE provider IN ('gmail', 'outlook', 'feishu_mail') AND status = 'active'
  AND mail_import_status = 'completed' AND mail_import_revision = revision
  AND mail_synced_until < sqlc.arg(due)::timestamptz
ORDER BY id;

-- name: GetMailSync :one
-- One Connection's sync position while it is still active at the revision
-- its sync was queued for.
SELECT account_id, mail_import_tenant_id::text AS tenant_id, provider, upstream_connection_id,
       coalesce(remote_principal_key, '')::text AS mailbox,
       mail_synced_until::timestamptz AS synced_until
FROM external_connections
WHERE id = sqlc.arg(id)::text AND revision = sqlc.arg(revision)::bigint AND status = 'active'
  AND mail_import_status = 'completed' AND mail_import_revision = revision
  AND mail_synced_until IS NOT NULL;

-- name: AdvanceMailSync :execrows
-- Moves the sync position from the one the sync read on from. No row means
-- the Connection changed meanwhile.
UPDATE external_connections
SET mail_synced_until = sqlc.arg(synced_until)::timestamptz
WHERE id = sqlc.arg(id)::text AND revision = sqlc.arg(revision)::bigint AND status = 'active'
  AND mail_import_status = 'completed' AND mail_import_revision = revision
  AND mail_synced_until = sqlc.arg(previous)::timestamptz;

-- name: GetFeishuMailComputerTarget :one
-- The Computer whose lark-cli serves an Account's Feishu Mail: one the
-- Account's Human runs their active AnotherMe on and that is online, most
-- recently seen first. Feishu Mail reads and sends through the owner's own
-- lark-cli login.
SELECT computer.owner_tenant_id::text AS tenant_id,
       computer.owner_actor_id::text AS owner_actor_id,
       computer.computer_id::text AS computer_id,
       registration.agent_management_id::text AS agent_management_id
FROM actors human
JOIN agent_registrations registration ON registration.tenant_id=human.tenant_id
  AND registration.represented_human_actor_id=human.id
  AND registration.agent_type='anotherme' AND registration.status='active'
  AND registration.agent_management_id IS NOT NULL
JOIN local_computers computer ON computer.computer_id=registration.computer_id
  AND computer.owner_tenant_id=human.tenant_id AND computer.owner_actor_id=human.id
  AND computer.status='online' AND computer.removed_at IS NULL
WHERE human.account_id=sqlc.arg(account_id)::text AND human.kind='human'
ORDER BY computer.last_seen_at DESC NULLS LAST, computer.computer_id
LIMIT 1;

-- name: GetExternalUpstreamAccount :one
SELECT account_id FROM external_connection_upstreams WHERE upstream_id=sqlc.arg(upstream_id)::text;

-- name: GetFeishuUpstreamPrincipal :one
-- The identity of the connection a Feishu upstream serves; empty until the
-- connection is identified. A reauthorization candidate is not the
-- connection's upstream yet: its identity is compared when it completes.
SELECT coalesce(remote_principal_key,'')::text AS remote_principal_key
FROM external_connections
WHERE upstream_connection_id=sqlc.arg(upstream_id)::text;
