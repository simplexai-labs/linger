package externalsource

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
)

type AgentToolConnection struct {
	// AgentActorID is the Agent whose grant authorized this connection.
	AgentActorID         string
	AccountID            string
	UserID               string
	ID                   string
	AppKey               string
	DisplayName          string
	IdentityLabel        string
	ToolkitSlug          string
	UpstreamConnectionID string
	// RemoteTeamID is the workspace the connection was verified in, such as
	// a Discord bot's server; empty when the app has none.
	RemoteTeamID string
	Revision     int64
	// GrantRevision pins custom tool approvals across revocation and regrant.
	GrantRevision int64
}

func (s *Service) ListGrantedAgentToolConnectionsInTx(
	ctx context.Context,
	tx pgx.Tx,
	agentActorID, tenantID, connectionID, appKey string,
) ([]AgentToolConnection, error) {
	if tx == nil || agentActorID == "" || tenantID == "" {
		return nil, ErrInvalid
	}
	rows, err := tx.Query(ctx, `
		SELECT connection.account_id,connection.id,connection.provider,
		       coalesce(connection.identity_label,''),coalesce(connection.toolkit_slug,''),
		       connection.upstream_connection_id,coalesce(connection.remote_team_id,''),connection.revision,
		       CASE WHEN connection.provider=$5 THEN delegation.revision ELSE 0 END
		FROM external_connection_agent_grants delegation
		JOIN external_connections connection ON connection.id=delegation.connection_id
		JOIN agent_registrations registration
		  ON registration.actor_id=delegation.agent_actor_id
		 AND registration.tenant_id=delegation.tenant_id
		JOIN actors represented
		  ON represented.id=delegation.represented_human_actor_id
		 AND represented.tenant_id=delegation.tenant_id
		 AND represented.kind='human'
		 AND represented.account_id=connection.account_id
		WHERE delegation.agent_actor_id=$1 AND delegation.tenant_id=$2
		  AND delegation.status='active'
		  AND registration.status='active'
		  AND registration.agent_type IN ('anotherme','general')
		  AND connection.status='active'
		  AND (connection.provider<>$5 OR EXISTS(SELECT 1 FROM custom_mcp_connections m
		      WHERE m.connection_id=connection.id AND m.tenant_id=delegation.tenant_id AND m.owner_actor_id=represented.id))
		  AND ($3='' OR connection.id=$3)
		  AND ($4='' OR connection.provider=$4)
		ORDER BY CASE connection.provider WHEN 'gmail' THEN 0 WHEN 'slack' THEN 1 ELSE 2 END,
		         connection.created_at,connection.id`,
		agentActorID, tenantID, connectionID, appKey, CustomMCPAppKey,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	connections := make([]AgentToolConnection, 0)
	for rows.Next() {
		var connection AgentToolConnection
		if err := rows.Scan(
			&connection.AccountID, &connection.ID, &connection.AppKey, &connection.IdentityLabel,
			&connection.ToolkitSlug, &connection.UpstreamConnectionID, &connection.RemoteTeamID, &connection.Revision,
			&connection.GrantRevision,
		); err != nil {
			return nil, err
		}
		app, ok := s.agentToolsApp(connection.AppKey)
		if !ok || connection.ToolkitSlug != toolkitForApp(connection.AppKey) {
			continue
		}
		connection.AgentActorID = agentActorID
		connection.UserID = s.managed.client.UserIDForAccount(connection.AccountID)
		connection.DisplayName = app.DisplayName
		if connection.AppKey == CustomMCPAppKey {
			connection.DisplayName = connection.IdentityLabel
		}
		connections = append(connections, connection)
	}
	return connections, rows.Err()
}

func (s *Service) LockGrantedAgentToolConnectionInTx(
	ctx context.Context,
	tx pgx.Tx,
	agentActorID, tenantID, connectionID string,
) (AgentToolConnection, error) {
	if tx == nil || agentActorID == "" || tenantID == "" || connectionID == "" {
		return AgentToolConnection{}, ErrInvalid
	}
	var eligible bool
	if err := tx.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM external_connection_agent_grants
			WHERE connection_id=$1 AND agent_actor_id=$2 AND tenant_id=$3 AND status='active'
		)`, connectionID, agentActorID, tenantID).Scan(&eligible); err != nil {
		return AgentToolConnection{}, err
	}
	if !eligible {
		return AgentToolConnection{}, ErrNotFound
	}
	var connection AgentToolConnection
	var status string
	if err := tx.QueryRow(ctx, `
		SELECT account_id,id,provider,coalesce(identity_label,''),coalesce(toolkit_slug,''),
		       upstream_connection_id,coalesce(remote_team_id,''),revision,status
		FROM external_connections
		WHERE id=$1
		FOR SHARE`, connectionID).Scan(
		&connection.AccountID, &connection.ID, &connection.AppKey, &connection.IdentityLabel,
		&connection.ToolkitSlug, &connection.UpstreamConnectionID, &connection.RemoteTeamID, &connection.Revision, &status,
	); errors.Is(err, pgx.ErrNoRows) {
		return AgentToolConnection{}, ErrNotFound
	} else if err != nil {
		return AgentToolConnection{}, err
	}
	var grantRevision int64
	if err := tx.QueryRow(ctx, `
		SELECT delegation.revision
		FROM external_connection_agent_grants delegation
		JOIN agent_registrations registration
		  ON registration.actor_id=delegation.agent_actor_id
		 AND registration.tenant_id=delegation.tenant_id
		JOIN actors represented
		  ON represented.id=delegation.represented_human_actor_id
		 AND represented.tenant_id=delegation.tenant_id
		 AND represented.kind='human'
		WHERE delegation.connection_id=$1
		  AND delegation.agent_actor_id=$2 AND delegation.tenant_id=$3
		  AND delegation.status='active'
		  AND registration.status='active'
		  AND registration.agent_type IN ('anotherme','general')
		  AND represented.account_id=$4
		  AND ($5<>$6 OR EXISTS(SELECT 1 FROM custom_mcp_connections m
		      WHERE m.connection_id=$1 AND m.tenant_id=delegation.tenant_id AND m.owner_actor_id=represented.id))
		FOR SHARE OF delegation,registration,represented`,
		connectionID, agentActorID, tenantID, connection.AccountID, connection.AppKey, CustomMCPAppKey,
	).Scan(&grantRevision); errors.Is(err, pgx.ErrNoRows) {
		return AgentToolConnection{}, ErrNotFound
	} else if err != nil {
		return AgentToolConnection{}, err
	}
	app, ok := s.agentToolsApp(connection.AppKey)
	if status != "active" || !ok || connection.ToolkitSlug != toolkitForApp(connection.AppKey) {
		return AgentToolConnection{}, ErrNotActive
	}
	connection.AgentActorID = agentActorID
	connection.UserID = s.managed.client.UserIDForAccount(connection.AccountID)
	connection.DisplayName = app.DisplayName
	if connection.AppKey == CustomMCPAppKey {
		connection.DisplayName = connection.IdentityLabel
		connection.GrantRevision = grantRevision
	}
	return connection, nil
}
