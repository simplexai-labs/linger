package typedcard

import (
	"context"
	"time"
)

// ErrLocalComputerNotFound means the named Local Computer does not exist or is
// not owned by the acting Human in this Tenant.
var ErrLocalComputerNotFound = errLocalComputerNotFound()

type localComputerNotFoundError struct{}

func (localComputerNotFoundError) Error() string { return "local computer was not found" }

func errLocalComputerNotFound() error { return localComputerNotFoundError{} }

// LocalComputerAppGrant is one active persistent per-app desktop grant on a
// Local Computer.
type LocalComputerAppGrant struct {
	ID               string
	ComputerID       string
	AgentActorID     string
	AgentDisplayName string
	BundleID         string
	AppName          string
	CreatedAt        time.Time
}

// ListLocalComputerAppGrants returns every active persistent per-app desktop
// grant on one of the acting Human's Local Computers.
func (s *Service) ListLocalComputerAppGrants(
	ctx context.Context,
	tenantID, ownerActorID, computerID string,
) ([]LocalComputerAppGrant, error) {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM local_computers
		WHERE computer_id=$1 AND owner_tenant_id=$2 AND owner_actor_id=$3 AND status <> 'removed'
	)`, computerID, tenantID, ownerActorID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrLocalComputerNotFound
	}
	rows, err := s.pool.Query(ctx, `SELECT g.id, g.computer_id, g.agent_actor_id, coalesce(agent.display_name, ''),
		g.bundle_id, g.app_name, g.created_at
	FROM local_computer_app_grants g
	LEFT JOIN actors agent ON agent.id=g.agent_actor_id AND agent.tenant_id=g.tenant_id
	WHERE g.tenant_id=$1 AND g.computer_id=$2 AND g.owner_actor_id=$3 AND g.status='active'
	ORDER BY g.created_at DESC, g.id ASC`, tenantID, computerID, ownerActorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []LocalComputerAppGrant{}
	for rows.Next() {
		var grant LocalComputerAppGrant
		if err := rows.Scan(&grant.ID, &grant.ComputerID, &grant.AgentActorID, &grant.AgentDisplayName,
			&grant.BundleID, &grant.AppName, &grant.CreatedAt); err != nil {
			return nil, err
		}
		grant.CreatedAt = grant.CreatedAt.UTC()
		items = append(items, grant)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// RevokeLocalComputerAppGrant revokes one active persistent per-app desktop
// grant on one of the acting Human's Local Computers.
func (s *Service) RevokeLocalComputerAppGrant(
	ctx context.Context,
	tenantID, ownerActorID, computerID, grantID string,
) error {
	var exists bool
	if err := s.pool.QueryRow(ctx, `SELECT EXISTS(
		SELECT 1 FROM local_computers
		WHERE computer_id=$1 AND owner_tenant_id=$2 AND owner_actor_id=$3 AND status <> 'removed'
	)`, computerID, tenantID, ownerActorID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return ErrLocalComputerNotFound
	}
	tag, err := s.pool.Exec(ctx, `UPDATE local_computer_app_grants
	SET status='revoked', revoked_at=clock_timestamp(), updated_at=clock_timestamp()
	WHERE id=$1 AND tenant_id=$2 AND computer_id=$3 AND owner_actor_id=$4 AND status='active'`,
		grantID, tenantID, computerID, ownerActorID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}
