package externalsource

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
)

// Write policy values for external_connection_agent_grants.write_policy.
const (
	WritePolicyAuto        = "auto"
	WritePolicyAlwaysAllow = "always_allow"
	WritePolicyAlwaysAsk   = "always_ask"
)

func validWritePolicy(policy string) bool {
	switch policy {
	case WritePolicyAuto, WritePolicyAlwaysAllow, WritePolicyAlwaysAsk:
		return true
	default:
		return false
	}
}

type AgentConnectionAccess struct {
	AgentActorID      string
	AgentManagementID string
	AgentDisplayName  string
	TenantID          string
	Granted           bool
	WritePolicy       string
	Revision          int64
}

func (s *Service) ListAgentConnectionAccess(ctx context.Context, accountID, connectionID string) ([]AgentConnectionAccess, error) {
	if accountID == "" || connectionID == "" {
		return nil, ErrInvalid
	}
	var provider string
	if err := s.pool.QueryRow(ctx, `
		SELECT provider FROM external_connections
		WHERE id=$1 AND account_id=$2`, connectionID, accountID).Scan(&provider); errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}

	rows, err := s.pool.Query(ctx, `
		SELECT registration.actor_id,registration.agent_management_id,
		       registration.tenant_id,agent.display_name,
		       coalesce(delegation.status='active',false),
		       coalesce(delegation.write_policy,'auto'),
		       coalesce(delegation.revision,0)
		FROM agent_registrations registration
		JOIN actors grantor
		  ON grantor.account_id=$1
		 AND grantor.tenant_id=registration.tenant_id
		 AND grantor.kind='human'
		JOIN actors agent
		  ON agent.id=registration.actor_id
		 AND agent.tenant_id=registration.tenant_id
		 AND agent.kind='agent'
		LEFT JOIN external_connection_agent_grants delegation
		  ON delegation.connection_id=$2 AND delegation.agent_actor_id=registration.actor_id
		WHERE grantor.account_id=$1
		  AND registration.agent_type IN ('anotherme','general')
		  AND (registration.represented_human_actor_id=grantor.id OR delegation.id IS NOT NULL OR EXISTS (
		      SELECT 1 FROM active_room_members human_room JOIN active_room_members agent_room
		      ON agent_room.room_id=human_room.room_id AND agent_room.actor_id=registration.actor_id
		      WHERE human_room.actor_id=grantor.id AND human_room.tenant_id=registration.tenant_id))
		  AND registration.status='active'
		  AND registration.agent_management_id IS NOT NULL
		ORDER BY agent.display_name COLLATE "C",registration.actor_id`,
		accountID, connectionID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	access := make([]AgentConnectionAccess, 0)
	for rows.Next() {
		var item AgentConnectionAccess
		if err := rows.Scan(
			&item.AgentActorID, &item.AgentManagementID, &item.TenantID,
			&item.AgentDisplayName, &item.Granted, &item.WritePolicy, &item.Revision,
		); err != nil {
			return nil, err
		}
		access = append(access, item)
	}
	return access, rows.Err()
}

func (s *Service) SetAgentConnectionAccess(
	ctx context.Context,
	accountID, connectionID, agentActorID string,
	granted bool,
) (AgentConnectionAccess, error) {
	return s.SetAgentConnectionAccessWithPolicy(ctx, accountID, connectionID, agentActorID, granted, "")
}

// SetAgentConnectionAccessWithPolicy grants or revokes an Agent's access to a
// Connection and optionally sets its write policy. An empty writePolicy keeps
// the current policy when active or defaults to "auto"; revoking always resets
// write_policy to "auto".
func (s *Service) SetAgentConnectionAccessWithPolicy(
	ctx context.Context,
	accountID, connectionID, agentActorID string,
	granted bool,
	writePolicy string,
) (AgentConnectionAccess, error) {
	if accountID == "" || connectionID == "" || agentActorID == "" {
		return AgentConnectionAccess{}, ErrInvalid
	}
	if writePolicy != "" && !validWritePolicy(writePolicy) {
		return AgentConnectionAccess{}, ErrInvalid
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return AgentConnectionAccess{}, err
	}
	defer tx.Rollback(ctx)

	access, err := s.setAgentConnectionAccessInTx(ctx, tx, accountID, connectionID, agentActorID, granted, writePolicy)
	if err != nil {
		return AgentConnectionAccess{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return AgentConnectionAccess{}, err
	}
	return access, nil
}

// SetAgentConnectionWritePolicyInTx updates write_policy on an active Agent
// grant inside the caller's transaction.
func (s *Service) SetAgentConnectionWritePolicyInTx(
	ctx context.Context,
	tx pgx.Tx,
	accountID, connectionID, agentActorID, policy string,
) error {
	if tx == nil || accountID == "" || connectionID == "" || agentActorID == "" || !validWritePolicy(policy) {
		return ErrInvalid
	}
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "connection-grant:"+connectionID+":"+agentActorID); err != nil {
		return err
	}
	var connectionOwnerAccountID string
	if err := tx.QueryRow(ctx, `
		SELECT account_id FROM external_connections
		WHERE id=$1 FOR SHARE`, connectionID).Scan(&connectionOwnerAccountID); errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	} else if err != nil {
		return err
	}
	if connectionOwnerAccountID != accountID {
		return ErrNotFound
	}
	var currentPolicy string
	err := tx.QueryRow(ctx, `
		SELECT grant_row.write_policy
		FROM external_connection_agent_grants grant_row
		WHERE grant_row.connection_id=$1
		  AND grant_row.agent_actor_id=$2
		  AND grant_row.status='active'
		FOR UPDATE OF grant_row`,
		connectionID, agentActorID,
	).Scan(&currentPolicy)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotActive
	}
	if err != nil {
		return err
	}
	if currentPolicy == policy {
		return nil
	}
	_, err = tx.Exec(ctx, `
		UPDATE external_connection_agent_grants
		SET write_policy=$3,revision=revision+1,updated_at=now()
		WHERE connection_id=$1 AND agent_actor_id=$2 AND status='active'`,
		connectionID, agentActorID, policy,
	)
	return mapDatabaseError(err)
}

func (s *Service) SupportsAgentTools(appKey string) bool {
	_, ok := s.agentToolsApp(appKey)
	return ok
}

func (s *Service) GrantAgentConnectionInTx(ctx context.Context, tx pgx.Tx, accountID, connectionID, agentActorID string) error {
	_, err := s.setAgentConnectionAccessInTx(ctx, tx, accountID, connectionID, agentActorID, true, "")
	return err
}

// ConnectionAuthorizationSettleArgs settles the authorization cards that wait on
// one Connection. The transaction that activates the Connection queues it, so
// a waiting Agent wakes as soon as the Connection can be used. It only reads
// and writes the database, so it runs on the default queue.
type ConnectionAuthorizationSettleArgs struct {
	ConnectionID string `json:"connection_id"`
}

func (ConnectionAuthorizationSettleArgs) Kind() string { return "typedcard.connection_auth_settle" }

func (ConnectionAuthorizationSettleArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 5, UniqueOpts: jobs.UniqueUnfinished}
}

// connectionActivatedTx runs in the transaction that makes a Connection active.
// On its first activation only the AnotherMe that represents the owner may use
// it; every other Agent asks with an authorization card. A grant the owner
// revoked is never restored.
func (s *Service) connectionActivatedTx(ctx context.Context, tx pgx.Tx, accountID, connectionID, previousStatus string) error {
	if previousStatus == "active" {
		return nil
	}
	if previousStatus == "pending" {
		var provider string
		if err := tx.QueryRow(ctx, `SELECT provider FROM external_connections WHERE id=$1 AND account_id=$2`, connectionID, accountID).Scan(&provider); err != nil {
			return err
		}
		if s.SupportsAgentTools(provider) {
			rows, err := tx.Query(ctx, `
				SELECT registration.actor_id
				FROM agent_registrations registration
				JOIN actors owner
				  ON owner.id=registration.represented_human_actor_id
				 AND owner.tenant_id=registration.tenant_id
				 AND owner.account_id=$1
				 AND owner.kind='human'
				WHERE registration.agent_type='anotherme'
				  AND registration.status='active'
				  AND registration.agent_management_id IS NOT NULL
				  AND NOT EXISTS(SELECT 1 FROM external_connection_agent_grants grant_row WHERE grant_row.connection_id=$2 AND grant_row.agent_actor_id=registration.actor_id)
				ORDER BY registration.actor_id`, accountID, connectionID)
			if err != nil {
				return err
			}
			agents, err := pgx.CollectRows(rows, pgx.RowTo[string])
			if err != nil {
				return err
			}
			for _, agentActorID := range agents {
				if _, err = s.setAgentConnectionAccessInTx(ctx, tx, accountID, connectionID, agentActorID, true, ""); err != nil {
					return err
				}
			}
			if len(agents) > 0 {
				if err := jobs.InsertTx(ctx, tx, ProfileSetupReminderArgs{ConnectionID: connectionID},
					&river.InsertOpts{ScheduledAt: time.Now().Add(ProfileSetupReminderDelay)}); err != nil {
					return err
				}
			}
		}
	}
	return jobs.InsertTx(ctx, tx, ConnectionAuthorizationSettleArgs{ConnectionID: connectionID}, nil)
}

// ProfileSetupReminderDelay is how long after a Connection's first activation
// AnotherMe is reminded about an unfinished Profile setup. It leaves a Human
// who connected from the setup card time to finish the cards themselves.
const ProfileSetupReminderDelay = 10 * time.Minute

// ProfileSetupReminderArgs reminds the AnotherMe granted a newly active
// Connection to offer the Human's Profile while setup is unfinished. The
// transaction that first activates the Connection queues it.
type ProfileSetupReminderArgs struct {
	ConnectionID string `json:"connection_id"`
}

// Kind names the reminder job.
func (ProfileSetupReminderArgs) Kind() string { return "typedcard.profile_setup_reminder" }

// InsertOpts keeps one unfinished reminder per Connection.
func (ProfileSetupReminderArgs) InsertOpts() river.InsertOpts {
	return river.InsertOpts{Queue: jobs.QueueDefault, MaxAttempts: 5, UniqueOpts: jobs.UniqueUnfinished}
}

func (s *Service) setAgentConnectionAccessInTx(ctx context.Context, tx pgx.Tx, accountID, connectionID, agentActorID string, granted bool, writePolicy string) (AgentConnectionAccess, error) {
	// Serialize the initially absent grant as well as updates to an existing grant.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, "connection-grant:"+connectionID+":"+agentActorID); err != nil {
		return AgentConnectionAccess{}, err
	}
	var connectionStatus, provider string
	if err := tx.QueryRow(ctx, `
		SELECT status,provider FROM external_connections
		WHERE id=$1 AND account_id=$2
		FOR SHARE`, connectionID, accountID).Scan(&connectionStatus, &provider); errors.Is(err, pgx.ErrNoRows) {
		return AgentConnectionAccess{}, ErrNotFound
	} else if err != nil {
		return AgentConnectionAccess{}, err
	}
	if _, supported := s.agentToolsApp(provider); granted && !supported {
		return AgentConnectionAccess{}, ErrInvalid
	}
	if granted && connectionStatus != "active" {
		return AgentConnectionAccess{}, ErrNotActive
	}

	var access AgentConnectionAccess
	// Legacy column represented_human_actor_id records the Human granting this connection.
	var grantingHumanActorID string
	if err := tx.QueryRow(ctx, `
		SELECT registration.actor_id,registration.agent_management_id,
		       registration.tenant_id,agent.display_name,
		       grantor.id
		FROM agent_registrations registration
		JOIN actors grantor
		  ON grantor.account_id=$2
		 AND grantor.tenant_id=registration.tenant_id
		 AND grantor.kind='human'
		JOIN actors agent
		  ON agent.id=registration.actor_id
		 AND agent.tenant_id=registration.tenant_id
		 AND agent.kind='agent'
		WHERE registration.actor_id=$1
		  AND grantor.account_id=$2
		  AND registration.agent_type IN ('anotherme','general')
		  AND (registration.represented_human_actor_id=grantor.id OR EXISTS (
		      SELECT 1 FROM active_room_members human_room JOIN active_room_members agent_room
		      ON agent_room.room_id=human_room.room_id AND agent_room.actor_id=registration.actor_id
		      WHERE human_room.actor_id=grantor.id AND human_room.tenant_id=registration.tenant_id)
		      OR (NOT $3 AND EXISTS(SELECT 1 FROM external_connection_agent_grants g WHERE g.connection_id=$4 AND g.agent_actor_id=registration.actor_id)))
		  AND registration.status='active'
		  AND registration.agent_management_id IS NOT NULL
		FOR SHARE OF registration,grantor,agent`, agentActorID, accountID, granted, connectionID).Scan(
		&access.AgentActorID, &access.AgentManagementID, &access.TenantID,
		&access.AgentDisplayName, &grantingHumanActorID,
	); errors.Is(err, pgx.ErrNoRows) {
		return AgentConnectionAccess{}, ErrNotFound
	} else if err != nil {
		return AgentConnectionAccess{}, err
	}

	var grantID, status, currentPolicy string
	err := tx.QueryRow(ctx, `
		SELECT id,status,write_policy,revision
		FROM external_connection_agent_grants
		WHERE connection_id=$1 AND agent_actor_id=$2
		FOR UPDATE`, connectionID, agentActorID).Scan(&grantID, &status, &currentPolicy, &access.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		if !granted {
			access.Granted = false
			access.WritePolicy = WritePolicyAuto
			return access, nil
		}
		targetPolicy := WritePolicyAuto
		if writePolicy != "" {
			targetPolicy = writePolicy
		}
		access.Revision = 1
		access.WritePolicy = targetPolicy
		_, err = tx.Exec(ctx, `
			INSERT INTO external_connection_agent_grants(
				id,connection_id,tenant_id,agent_actor_id,represented_human_actor_id,status,write_policy
			) VALUES($1,$2,$3,$4,$5,'active',$6)`,
			idgen.New("external_connection_agent_grant"), connectionID, access.TenantID,
			agentActorID, grantingHumanActorID, targetPolicy,
		)
	} else if err == nil {
		access.Granted = status == "active"
		targetPolicy := currentPolicy
		if !granted {
			targetPolicy = WritePolicyAuto
		} else if writePolicy != "" {
			targetPolicy = writePolicy
		} else if !access.Granted {
			targetPolicy = WritePolicyAuto
		}
		if access.Granted != granted || currentPolicy != targetPolicy {
			access.Revision++
			_, err = tx.Exec(ctx, `
				UPDATE external_connection_agent_grants
				SET status=CASE WHEN $3 THEN 'active' ELSE 'revoked' END,
				    write_policy=$5,
				    revision=$4,updated_at=now(),
				    revoked_at=CASE WHEN $3 THEN NULL ELSE now() END
				WHERE id=$1 AND revision=$2`, grantID, access.Revision-1, granted, access.Revision, targetPolicy)
		}
		access.WritePolicy = targetPolicy
	}
	if err != nil {
		return AgentConnectionAccess{}, mapDatabaseError(err)
	}
	access.Granted = granted
	return access, nil
}
