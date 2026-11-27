package agentregistry

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// starterAgent is the fixed definition of one Agent the starter workspace
// gives every new Human. Its Skills come from the Agent Type's catalog
// defaults; SkillIDs only adds explicit Skills on top of them, each bound at
// its current version when the Agent is created.
type starterAgent struct {
	Name         string   `json:"name"`
	Description  string   `json:"description"`
	AvatarKey    string   `json:"avatar_key"`
	Instructions string   `json:"instructions"`
	SkillIDs     []string `json:"skill_ids"`
}

var (
	//go:embed starter/research-analyst.json
	starterResearchAnalystJSON []byte
	//go:embed starter/code-reviewer.json
	starterCodeReviewerJSON []byte
)

// starterAgents returns the starter Agents in creation order; the first one
// joins the starter Room. The embedded definitions are decoded and validated
// once.
var starterAgents = sync.OnceValues(func() ([]starterAgent, error) {
	agents := make([]starterAgent, 0, 2)
	for _, encoded := range [][]byte{starterResearchAnalystJSON, starterCodeReviewerJSON} {
		agent, err := decodeStarterAgent(encoded)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	return agents, nil
})

// decodeStarterAgent rejects unknown fields and anything an Agent creation
// request would reject, so a bad edit fails in tests rather than when a new
// Human first connects a Computer.
func decodeStarterAgent(encoded []byte) (starterAgent, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var agent starterAgent
	if err := decoder.Decode(&agent); err != nil {
		return starterAgent{}, fmt.Errorf("decode starter Agent: %w", err)
	}
	agent.Name = strings.TrimSpace(agent.Name)
	agent.Description = strings.TrimSpace(agent.Description)
	agent.AvatarKey = strings.TrimSpace(agent.AvatarKey)
	agent.Instructions = strings.TrimSpace(agent.Instructions)
	fail := func(reason string) (starterAgent, error) {
		return starterAgent{}, fmt.Errorf("starter Agent %q: %s", agent.Name, reason)
	}
	switch {
	case agent.Name == "" || !utf8.ValidString(agent.Name) || utf8.RuneCountInString(agent.Name) > MaxNameRunes:
		return fail("name must be 1 to 120 characters")
	case !utf8.ValidString(agent.Description) || utf8.RuneCountInString(agent.Description) > MaxDescriptionRunes:
		return fail("description exceeds 1000 characters")
	case agent.Instructions == "" || !utf8.ValidString(agent.Instructions) || utf8.RuneCountInString(agent.Instructions) > MaxInstructionsRunes:
		return fail("instructions must be 1 to 50000 characters")
	case agent.AvatarKey != "" && !ValidAgentAvatarKey(agent.AvatarKey):
		return fail("avatar_key is not a valid avatar selection")
	}
	seen := make(map[string]struct{}, len(agent.SkillIDs))
	for _, skillID := range agent.SkillIDs {
		if strings.TrimSpace(skillID) != skillID || skillID == "" {
			return fail("skill_ids holds an empty or padded Skill ID")
		}
		if _, duplicate := seen[skillID]; duplicate {
			return fail(fmt.Sprintf("skill_ids repeats %q", skillID))
		}
		seen[skillID] = struct{}{}
	}
	return agent, nil
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
		if s.logger != nil {
			s.logger.Error("another_me.starter_agent_skipped", "tenant_id", human.TenantID,
				"human_actor_id", human.ID, "starter_agent", agent.Name, "error", err)
		}
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
	bindings, err := currentStarterSkillBindings(ctx, queries, human.TenantID, human.ID, agent.SkillIDs)
	if err != nil {
		return "", err
	}
	agentType := httpapi.CreatableAgentTypeGeneral
	visibility := httpapi.AgentVisibilityScopeSponsor
	description := agent.Description
	avatarKey := agent.AvatarKey
	runtime := agentRuntimeConfig(anotherMe)
	runtime.Model = strings.TrimSpace(runtime.Model)
	request := httpapi.TenantAgentCreateRequest{
		AgentType: &agentType, VisibilityScope: &visibility,
		Name: agent.Name, Description: &description,
		Instructions: agent.Instructions,
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
func currentStarterSkillBindings(ctx context.Context, queries *store.Queries, tenantID, humanActorID string, skillIDs []string) ([]httpapi.AgentSkillRegistration, error) {
	current := make([]httpapi.AgentSkillRegistration, 0, len(skillIDs))
	for _, skillID := range skillIDs {
		rows, err := queries.ListBindableSkillManifests(ctx, store.ListBindableSkillManifestsParams{
			CallerActorID: humanActorID, TenantID: tenantID,
			CursorSkillID: skillID, PageLimit: 100,
		})
		if err != nil {
			return nil, err
		}
		// A platform Skill lists only its current version.
		var latest *store.ListBindableSkillManifestsRow
		for index := range rows {
			if rows[index].SkillID == skillID && rows[index].Availability == "active" {
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
