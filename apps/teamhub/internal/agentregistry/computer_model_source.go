package agentregistry

import (
	"context"
	"errors"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// BusyComputerAgent is an Agent on a Computer with running work that a
// model-source switch would end.
type BusyComputerAgent struct {
	AgentID, Name string
}

// ComputerRuntimeSwitch moves every active Agent the owner placed on one
// Computer to the Runtime and model the Computer serves after a model-source
// switch. TerminateWork ends their running work; without it an Agent with
// running work stays where it is.
type ComputerRuntimeSwitch struct {
	TenantID, OwnerActorID, ComputerID  string
	RuntimeType, Model, ReasoningEffort string
	TerminateWork                       bool
}

// ComputerRuntimeSwitchResult counts the Agents moved, lists the Runs that
// were ended for the switch, and names the Agents left behind because they
// have running work.
type ComputerRuntimeSwitchResult struct {
	UpdatedAgents  int
	TerminatedRuns []agentruntimestate.TerminatedLocalRun
	BusyAgents     []BusyComputerAgent
}

// BusyComputerAgents lists the owner's Agents on a Computer that hold running
// work, so a switch can be refused before the Computer changes.
func (s *Service) BusyComputerAgents(ctx context.Context, tenantID, ownerActorID, computerID string) ([]BusyComputerAgent, error) {
	placements, err := s.queries.ListAgentRunnerPlacementsOnComputer(ctx, computerID)
	if err != nil {
		return nil, err
	}
	var busy []BusyComputerAgent
	for _, placement := range placements {
		if placement.TenantID != tenantID || placement.CreatedByActorID != ownerActorID {
			continue
		}
		pending, err := s.queries.HasPendingAgentLocalWork(ctx, store.HasPendingAgentLocalWorkParams{TenantID: tenantID, AgentActorID: placement.ActorID})
		if err != nil {
			return nil, err
		}
		if !pending {
			continue
		}
		agent, err := busyComputerAgent(ctx, s.queries, tenantID, placement.ActorID, placement.AgentManagementID)
		if err != nil {
			return nil, err
		}
		busy = append(busy, agent)
	}
	return busy, nil
}

// SwitchComputerRuntime applies a model-source switch to the Agents on the
// Computer in one transaction: each keeps its Computer and workspace grant,
// and a new Runtime type starts a new Runtime Assignment. An Agent that
// already runs the target, or still has running work, is left alone; the
// Computer has already switched, so the others move regardless.
func (s *Service) SwitchComputerRuntime(ctx context.Context, input ComputerRuntimeSwitch) (ComputerRuntimeSwitchResult, error) {
	if input.TenantID == "" || input.OwnerActorID == "" || input.ComputerID == "" || input.RuntimeType == "" || input.Model == "" {
		return ComputerRuntimeSwitchResult{}, errors.New("invalid Computer Runtime switch")
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ComputerRuntimeSwitchResult{}, err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	// Ordered by Agent, so concurrent switches take the Agents' locks in the
	// same order.
	placements, err := queries.ListAgentRunnerPlacementsOnComputer(ctx, input.ComputerID)
	if err != nil {
		return ComputerRuntimeSwitchResult{}, err
	}
	var (
		result  ComputerRuntimeSwitchResult
		updated []string
	)
	for _, placement := range placements {
		if placement.TenantID != input.TenantID || placement.CreatedByActorID != input.OwnerActorID {
			continue
		}
		// The locks the Agent update takes, in its order.
		if err := queries.AcquireAdvisoryTransactionLock(ctx, input.TenantID+"|agent-update|"+placement.ActorID); err != nil {
			return ComputerRuntimeSwitchResult{}, err
		}
		if err := queries.AcquireAdvisoryTransactionLock(ctx, "agent-skill-bindings|"+placement.ActorID); err != nil {
			return ComputerRuntimeSwitchResult{}, err
		}
		row, err := queries.GetAgentRegistrationForUpdate(ctx, store.GetAgentRegistrationForUpdateParams{ActorID: placement.ActorID, TenantID: input.TenantID})
		if err != nil {
			return ComputerRuntimeSwitchResult{}, err
		}
		if row.Status != "active" || row.ComputerID.String != input.ComputerID {
			continue
		}
		if input.TerminateWork {
			ended, err := agentruntimestate.TerminateLocalWorkForModelSourceSwitch(ctx, queries, input.TenantID, placement.ActorID)
			if err != nil {
				return ComputerRuntimeSwitchResult{}, err
			}
			result.TerminatedRuns = append(result.TerminatedRuns, ended...)
		}
		pending, err := queries.HasPendingAgentLocalWork(ctx, store.HasPendingAgentLocalWorkParams{TenantID: input.TenantID, AgentActorID: placement.ActorID})
		if err != nil {
			return ComputerRuntimeSwitchResult{}, err
		}
		if pending {
			agent, err := busyComputerAgent(ctx, queries, input.TenantID, placement.ActorID, row.AgentManagementID.String)
			if err != nil {
				return ComputerRuntimeSwitchResult{}, err
			}
			result.BusyAgents = append(result.BusyAgents, agent)
			continue
		}
		if row.LocalRuntimeType.String == input.RuntimeType && row.RuntimeModel == input.Model &&
			row.RuntimeReasoningEffort.String == input.ReasoningEffort {
			continue
		}
		changed, err := queries.ApplyAgentConfigurationUpdate(ctx, store.ApplyAgentConfigurationUpdateParams{
			ActorID: placement.ActorID, TenantID: input.TenantID,
			ExpectedRevision: row.ConfigurationRevision, NextRevision: row.ConfigurationRevision + 1,
			Description: row.Description, Instructions: row.Instructions,
			RuntimeModel: input.Model, RuntimeReasoningEffort: textValue(input.ReasoningEffort),
			ComputerID: input.ComputerID, LocalRuntimeType: input.RuntimeType, WorkspaceGrantID: row.WorkspaceGrantID.String,
		})
		if err != nil {
			return ComputerRuntimeSwitchResult{}, err
		}
		if changed != 1 {
			return ComputerRuntimeSwitchResult{}, ErrAgentConfigurationConflict
		}
		if shouldClearAnotherMeBackgroundFailures(
			row.AgentType, row.ComputerID.String, row.LocalRuntimeType.String, row.RuntimeModel,
			input.ComputerID, input.RuntimeType, input.Model,
		) {
			if err := clearAnotherMeBackgroundFailuresTx(ctx, queries, input.TenantID, placement.ActorID); err != nil {
				return ComputerRuntimeSwitchResult{}, err
			}
		}
		updated = append(updated, row.AgentManagementID.String)
	}
	if len(updated) > 0 {
		if err := createTenantAgentDirectoryDeliveries(ctx, queries, input.TenantID); err != nil {
			return ComputerRuntimeSwitchResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return ComputerRuntimeSwitchResult{}, err
	}
	for _, agentID := range updated {
		s.NotifyAgentRegistrationChanged(ctx, agentID)
	}
	result.UpdatedAgents = len(updated)
	return result, nil
}

func busyComputerAgent(ctx context.Context, queries *store.Queries, tenantID, actorID, agentID string) (BusyComputerAgent, error) {
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: tenantID})
	if err != nil {
		return BusyComputerAgent{}, err
	}
	return BusyComputerAgent{AgentID: agentID, Name: actor.DisplayName}, nil
}
