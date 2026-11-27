-- name: ListMobileRelayNodes :many
SELECT id, url, label, kind, enabled, position, created_at
FROM mobile_relay_nodes
ORDER BY position, created_at;

-- name: EnsureOfficialMobileRelayNode :exec
-- Adds an official node once; a Human's choice to turn it off stays, and a
-- label or URL change in a release replaces the stored one.
INSERT INTO mobile_relay_nodes (id, url, label, kind, position)
VALUES ($1, $2, $3, 'official', $4)
ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, label = EXCLUDED.label, position = EXCLUDED.position;

-- name: CreateMobileRelayNode :one
-- A custom node goes after every node already listed. A URL already in the
-- list returns no row.
INSERT INTO mobile_relay_nodes (id, url, label, kind, position)
SELECT $1, $2, $3, 'custom', COALESCE(MAX(position), 0) + 1 FROM mobile_relay_nodes
ON CONFLICT (url) DO NOTHING
RETURNING id, url, label, kind, enabled, position, created_at;

-- name: SetMobileRelayNodeEnabled :one
UPDATE mobile_relay_nodes SET enabled = $2 WHERE id = $1
RETURNING id, url, label, kind, enabled, position, created_at;

-- name: DeleteCustomMobileRelayNode :execrows
DELETE FROM mobile_relay_nodes WHERE id = $1 AND kind = 'custom';

-- name: GetMobileRelayNodeKind :one
SELECT kind FROM mobile_relay_nodes WHERE id = $1;

-- name: DeleteCustomMobileRelayNodeByURL :exec
DELETE FROM mobile_relay_nodes WHERE url = $1 AND kind = 'custom';
