package agentregistry

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// starterAgent is the fixed definition of one Agent the starter workspace
// gives every new Human. Its Skills come from the Agent Type's catalog
// defaults; SkillBindings only adds explicit Skills on top of them.
type starterAgent struct {
	Name          string                           `json:"name"`
	Description   string                           `json:"description"`
	AvatarKey     string                           `json:"avatar_key"`
	Instructions  string                           `json:"instructions"`
	SkillBindings []httpapi.AgentSkillRegistration `json:"skill_bindings"`
}

var (
	//go:embed starter/research-analyst.json
	starterResearchAnalystJSON []byte
	//go:embed starter/code-reviewer.json
	starterCodeReviewerJSON []byte
)

// starterAgents returns the starter Agents in creation order; the first one
// joins the starter Room.
func starterAgents() ([]starterAgent, error) {
	agents := make([]starterAgent, 0, 2)
	for _, encoded := range [][]byte{starterResearchAnalystJSON, starterCodeReviewerJSON} {
		var agent starterAgent
		if err := json.Unmarshal(encoded, &agent); err != nil {
			return nil, fmt.Errorf("decode starter Agent: %w", err)
		}
		agents = append(agents, agent)
	}
	return agents, nil
}

// createStarterWorkspaceTx gives the Human the starter Agents on the Another
// Me's placement, each with its direct Room, and one group Room with their
// Another Me and the first starter Agent. A starter Agent that its Skills,
// placement or the Agent limit rule out is logged and skipped, so the others
// and the Another Me are still created; any other error fails the whole
// creation, which the next heartbeat retries.
func (s *Service) createStarterWorkspaceTx(ctx context.Context, tx pgx.Tx, human store.Actor, anotherMe store.AgentRegistration) error {
	agents, err := starterAgents()
	if err != nil {
		return err
	}
	var roomAgentID string
	for index, agent := range agents {
		actorID, err := s.createStarterAgentTx(ctx, tx, human, anotherMe, agent)
		if err != nil {
			return err
		}
		if index == 0 {
			roomAgentID = actorID
		}
	}
	if roomAgentID == "" {
		return nil
	}
	_, err = roomcreation.Create(ctx, s.queries.WithTx(tx), roomcreation.Spec{
		TenantID: human.TenantID, Name: starterRoomName, Creator: human, Owner: human,
		MemberActorIDs: []string{anotherMe.ActorID, roomAgentID},
	})
	return err
}

// createStarterAgentTx creates one starter Agent in its own savepoint and
// returns its Actor ID, or "" when it was skipped.
func (s *Service) createStarterAgentTx(ctx context.Context, tx pgx.Tx, human store.Actor, anotherMe store.AgentRegistration, agent starterAgent) (string, error) {
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return "", err
	}
	actorID, err := insertStarterAgent(ctx, savepoint, s.queries.WithTx(savepoint), human, anotherMe, agent)
	switch {
	case errors.Is(err, ErrAgentPlacementTargetUnavailable),
		errors.Is(err, ErrAgentRegistrationManifestNotFound), errors.Is(err, ErrSkillManifestNotCurrent),
		errors.Is(err, ErrInvalidAgentSkillRegistration), errors.Is(err, ErrAgentLimitReached):
		s.logger.Error("another_me.starter_agent_skipped", "tenant_id", human.TenantID,
			"human_actor_id", human.ID, "starter_agent", agent.Name, "error", err)
		return "", savepoint.Rollback(ctx)
	case err != nil:
		_ = savepoint.Rollback(ctx)
		return "", err
	}
	return actorID, savepoint.Commit(ctx)
}

// insertStarterAgent creates one starter Agent on the Another Me's placement
// and opens its direct Room with the Human.
func insertStarterAgent(ctx context.Context, tx pgx.Tx, queries *store.Queries, human store.Actor, anotherMe store.AgentRegistration, agent starterAgent) (string, error) {
	bindings, err := currentStarterSkillBindings(ctx, queries, human.TenantID, human.ID, agent.SkillBindings)
	if err != nil {
		return "", err
	}
	agentType := httpapi.CreatableAgentTypeGeneral
	visibility := httpapi.AgentVisibilityScopeSponsor
	description := strings.TrimSpace(agent.Description)
	avatarKey := strings.TrimSpace(agent.AvatarKey)
	runtime := agentRuntimeConfig(anotherMe)
	runtime.Model = strings.TrimSpace(runtime.Model)
	request := httpapi.TenantAgentCreateRequest{
		AgentType: &agentType, VisibilityScope: &visibility,
		Name: strings.TrimSpace(agent.Name), Description: &description,
		Instructions: strings.TrimSpace(agent.Instructions),
		Runtime:      runtime, SkillBindings: &bindings,
	}
	if avatarKey != "" {
		request.AvatarKey = &avatarKey
	}
	if err := NormalizeAgentRegistrationBindings(&request); err != nil {
		return "", err
	}
	actorID, _, err := insertTenantAgent(ctx, tx, queries, human.TenantID, human.ID, request)
	if err != nil {
		return "", err
	}
	actor, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: human.TenantID})
	if err != nil {
		return "", err
	}
	if _, err := roomcreation.OpenOrCreateDirectRoom(ctx, queries, roomcreation.DirectSpec{
		TenantID: human.TenantID, Human: human, Agent: actor, Name: actor.DisplayName,
	}); err != nil {
		return "", err
	}
	return actorID, nil
}

// currentStarterSkillBindings binds each explicit starter Skill at its current
// latest active version, since platform Skills accept only that version. A
// Skill the Human cannot bind is left out.
func currentStarterSkillBindings(ctx context.Context, queries *store.Queries, tenantID, humanActorID string, bindings []httpapi.AgentSkillRegistration) ([]httpapi.AgentSkillRegistration, error) {
	current := make([]httpapi.AgentSkillRegistration, 0, len(bindings))
	for _, binding := range bindings {
		rows, err := queries.ListBindableSkillManifests(ctx, store.ListBindableSkillManifestsParams{
			CallerActorID: humanActorID, TenantID: tenantID,
			CursorSkillID: binding.SkillId, PageLimit: 100,
		})
		if err != nil {
			return nil, err
		}
		// A platform Skill lists only its current version.
		var latest *store.ListBindableSkillManifestsRow
		for index := range rows {
			if rows[index].SkillID == binding.SkillId && rows[index].Availability == "active" {
				latest = &rows[index]
			}
		}
		if latest == nil {
			continue
		}
		current = append(current, httpapi.AgentSkillRegistration{
			Name: latest.Name, SkillId: latest.SkillID, ManifestVersion: latest.ManifestVersion,
		})
	}
	return current, nil
}
