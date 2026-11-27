package agentregistry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/account"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/collaboration"
	idgen "github.com/simplexai-labs/linger/apps/teamhub/internal/ids"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/skill"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// Another Me is a template Agent. TeamHub creates it once per Human, in the
// transaction that first records the Human's Computer online with a ready
// Runtime and a writable workspace: the Agent itself, its direct Chat with the
// opening and the profile setup card, and the starter workspace. Until then
// the Human has no Another Me, and nothing waits or polls for the Computer.
// A change to the template reaches existing Another Mes through a migration.
const (
	anotherMeInstructions = `You are a private delegate for the Human you represent. Help them organize work, coordinate with other Agents, and act only within explicit TeamHub authority. Never claim to be the Human, never inherit external credentials implicitly, and ask for approval whenever required by product policy.`
	anotherMeGreeting     = "Hi %s, I'm Linger — your personal AI."
	anotherMeChatName     = "Chat"

	starterRoomName = "Getting Started"
)

// anotherMeCreateFailure marks the Computer whose latest Another Me creation
// attempt failed while placement was otherwise eligible, so GET /another-me
// can report create_failed without exposing internal server errors.
type anotherMeCreateFailure struct {
	ComputerID string
}

// anotherMePlacementState deduplicates repeated identical skip logs across
// heartbeats and retains the latest creation failure per Human until Another Me
// exists or placement becomes blocked for another reason.
type anotherMePlacementState struct {
	mu             sync.Mutex
	lastSkipped    map[string]string
	createFailures map[string]anotherMeCreateFailure
}

func anotherMeOwnerKey(tenantID, humanActorID string) string {
	return tenantID + "\x00" + humanActorID
}

func anotherMeSkipKey(tenantID, humanActorID, computerID string) string {
	return tenantID + "\x00" + humanActorID + "\x00" + computerID
}

func (st *anotherMePlacementState) shouldLogSkip(tenantID, humanActorID, computerID, signature string) bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.lastSkipped == nil {
		st.lastSkipped = make(map[string]string)
	}
	key := anotherMeSkipKey(tenantID, humanActorID, computerID)
	if st.lastSkipped[key] == signature {
		return false
	}
	st.lastSkipped[key] = signature
	delete(st.createFailures, anotherMeOwnerKey(tenantID, humanActorID))
	return true
}

func (st *anotherMePlacementState) recordCreateFailure(tenantID, humanActorID, computerID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.createFailures == nil {
		st.createFailures = make(map[string]anotherMeCreateFailure)
	}
	st.createFailures[anotherMeOwnerKey(tenantID, humanActorID)] = anotherMeCreateFailure{
		ComputerID: computerID,
	}
	delete(st.lastSkipped, anotherMeSkipKey(tenantID, humanActorID, computerID))
}

func (st *anotherMePlacementState) lastCreateFailure(tenantID, humanActorID string) *anotherMeCreateFailure {
	st.mu.Lock()
	defer st.mu.Unlock()
	failure, ok := st.createFailures[anotherMeOwnerKey(tenantID, humanActorID)]
	if !ok {
		return nil
	}
	copyFailure := failure
	return &copyFailure
}

func (st *anotherMePlacementState) clearOwner(tenantID, humanActorID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	ownerKey := anotherMeOwnerKey(tenantID, humanActorID)
	delete(st.createFailures, ownerKey)
	prefix := ownerKey + "\x00"
	for key := range st.lastSkipped {
		if strings.HasPrefix(key, prefix) {
			delete(st.lastSkipped, key)
		}
	}
}

// EnsureAnotherMe is the Computer online hook and runs on every observation of
// an online Computer; the primary-key read keeps it cheap once the Another Me
// exists. A failure to create the Another Me is logged and leaves the
// observation committed without it, so a broken template never blocks a
// Computer from connecting, and the next heartbeat tries again.
func (s *Service) EnsureAnotherMe(ctx context.Context, tx pgx.Tx, computer agentruntimestate.LocalComputer) error {
	owner := computer.Owner
	_, err := s.queries.WithTx(tx).GetAgentRegistration(ctx, store.GetAgentRegistrationParams{
		ActorID: stableAnotherMeActorID(owner.TenantID, owner.OwnerActorID), TenantID: owner.TenantID,
	})
	if err == nil {
		s.anotherMeState.clearOwner(owner.TenantID, owner.OwnerActorID)
		return nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return err
	}
	savepoint, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	created, err := s.createAnotherMeTx(ctx, savepoint, computer)
	if err != nil {
		if s.logger != nil {
			s.logger.Error("another_me.create_failed", "tenant_id", owner.TenantID,
				"human_actor_id", owner.OwnerActorID, "computer_id", computer.ComputerID, "error", err)
		}
		s.anotherMeState.recordCreateFailure(owner.TenantID, owner.OwnerActorID, computer.ComputerID)
		return savepoint.Rollback(ctx)
	}
	if err := savepoint.Commit(ctx); err != nil {
		return err
	}
	if created {
		s.anotherMeState.clearOwner(owner.TenantID, owner.OwnerActorID)
	}
	return nil
}

// createAnotherMeTx creates the Human's Another Me on this Computer, unless
// it already exists or the Computer has no ready Runtime with a writable
// workspace yet. It returns created=true when the Another Me exists on return.
func (s *Service) createAnotherMeTx(ctx context.Context, tx pgx.Tx, computer agentruntimestate.LocalComputer) (bool, error) {
	queries := s.queries.WithTx(tx)
	owner := computer.Owner
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "another-me|"+owner.TenantID+"|"+owner.OwnerActorID); err != nil {
		return false, err
	}
	actorID := stableAnotherMeActorID(owner.TenantID, owner.OwnerActorID)
	_, err := queries.GetAgentRegistration(ctx, store.GetAgentRegistrationParams{ActorID: actorID, TenantID: owner.TenantID})
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	human, err := queries.GetActor(ctx, store.GetActorParams{ID: owner.OwnerActorID, TenantID: owner.TenantID})
	if err != nil {
		return false, err
	}
	if human.Kind != "human" || !human.AccountID.Valid {
		return false, nil
	}
	row, err := queries.GetAgentRuntimeLocalComputer(ctx, computer.ComputerID)
	if err != nil {
		return false, err
	}
	now := time.Now()
	if row.LastSeenAt.Valid && row.LastSeenAt.Time.After(now) {
		now = row.LastSeenAt.Time
	}
	projected, err := projectStoredLocalComputerForPlacement(row, owner.TenantID, now)
	if err != nil {
		return false, err
	}
	preferredRuntime, err := storedPreferredRuntime(row.RuntimeDiagnostics)
	if err != nil {
		return false, err
	}
	placement, blocker := evaluateAnotherMeLocalPlacement([]httpapi.LocalComputer{projected}, preferredRuntime)
	if blocker != nil {
		s.logAnotherMePlacementSkipped(owner.TenantID, owner.OwnerActorID, projected, blocker)
		return false, nil
	}
	if err := queries.AcquireUnifiedSkillPolicyExclusiveLock(ctx); err != nil {
		return false, err
	}
	registration, err := CreateAgentRegistration(ctx, queries, AgentRegistrationSpec{
		DisplayName: "Linger",
		CreateAgentRegistrationParams: store.CreateAgentRegistrationParams{
			ActorID: actorID, TenantID: owner.TenantID, AgentManagementID: idgen.New("agent"),
			Description:  account.AnotherMeDescription(human.DisplayName),
			Instructions: anotherMeInstructions, RuntimeModel: placement.Model,
			RuntimeReasoningEffort: textValue(placement.ReasoningEffort),
			ComputerID:             placement.ComputerID,
			LocalRuntimeType:       placement.RuntimeType,
			WorkspaceGrantID:       placement.WorkspaceGrantID,
			CreatedByActorID:       human.ID,
			VisibilityScope:        "sponsor", AgentType: "anotherme",
			RepresentedHumanActorID: textValue(human.ID),
			ReceivesAllMessages:     true,
		},
	})
	if err != nil {
		return false, err
	}
	if err := skill.ValidateEffectiveInTx(ctx, tx, skill.Identity{
		AgentActorID: registration.ActorID, TenantID: registration.TenantID, AgentType: registration.AgentType,
	}); err != nil {
		return false, err
	}
	agent, err := queries.GetActor(ctx, store.GetActorParams{ID: actorID, TenantID: owner.TenantID})
	if err != nil {
		return false, err
	}
	chat, err := roomcreation.OpenOrCreateDirectRoom(ctx, queries, roomcreation.DirectSpec{
		TenantID: owner.TenantID, Human: human, Agent: agent, Name: anotherMeChatName,
	})
	if err != nil {
		return false, err
	}
	if err := collaboration.PostAgentOpening(ctx, queries, owner.TenantID, chat.Room.ID, human, agent,
		fmt.Sprintf(anotherMeGreeting, collaboration.GreetingName(human.DisplayName)), typedcard.ProfileSetupAppsOpening()); err != nil {
		return false, err
	}
	if err := createTenantAgentDirectoryDeliveries(ctx, queries, owner.TenantID); err != nil {
		return false, err
	}
	if err := createTenantAnotherMeDeliveries(ctx, queries, owner.TenantID); err != nil {
		return false, err
	}
	if err := s.createStarterWorkspaceTx(ctx, tx, human, registration); err != nil {
		return false, err
	}
	return true, nil
}

func (s *Service) logAnotherMePlacementSkipped(tenantID, humanActorID string, computer httpapi.LocalComputer, blocker *httpapi.AnotherMePlacementBlocker) {
	if blocker == nil {
		return
	}
	runtimes := formatPlacementRuntimesForLog(blocker.Runtimes)
	platform := ""
	if computer.Platform != nil {
		platform = string(*computer.Platform)
	}
	signature := fmt.Sprintf("%s|%s|%t|%s", blocker.Reason, computer.Status, computer.UpgradeRequired, strings.Join(runtimes, ","))
	if !s.anotherMeState.shouldLogSkip(tenantID, humanActorID, computer.ComputerId, signature) {
		return
	}
	if s.logger == nil {
		return
	}
	args := []any{
		"tenant_id", tenantID,
		"human_actor_id", humanActorID,
		"computer_id", computer.ComputerId,
		"computer_status", string(computer.Status),
		"upgrade_required", computer.UpgradeRequired,
		"reason", string(blocker.Reason),
	}
	if platform != "" {
		args = append(args, "platform", platform)
	}
	if len(runtimes) > 0 {
		args = append(args, "runtimes", runtimes)
	}
	s.logger.Warn("another_me.placement_skipped", args...)
}

// AnotherMe returns the Human's Another Me and its Chat. Both are absent
// until the Human's Computer first comes online with a ready Runtime; while
// absent, PlacementBlocker explains why TeamHub skipped or failed creating it
// across the Human's registered Computers. pgx.ErrNoRows reports a Human that
// is not in the Space.
func (s *Service) AnotherMe(ctx context.Context, accountID, tenantID string) (httpapi.AnotherMe, error) {
	human, err := s.queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: tenantID, AccountID: textValue(accountID)})
	if err != nil {
		return httpapi.AnotherMe{}, err
	}
	chat, err := s.queries.GetAnotherMeChat(ctx, store.GetAnotherMeChatParams{TenantID: tenantID, HumanActorID: human.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		blocker, blockerErr := s.anotherMePlacementBlocker(ctx, tenantID, human.ID)
		if blockerErr != nil {
			return httpapi.AnotherMe{}, blockerErr
		}
		return httpapi.AnotherMe{PlacementBlocker: blocker}, nil
	}
	if err != nil {
		return httpapi.AnotherMe{}, err
	}
	model := httpapi.AnotherMe{AgentActorId: &chat.AgentActorID}
	if chat.RoomID.Valid {
		model.RoomId = &chat.RoomID.String
	}
	model.BackgroundFailure, err = anotherMeBackgroundFailure(ctx, s.queries, tenantID, chat.AgentActorID)
	if err != nil {
		return httpapi.AnotherMe{}, err
	}
	return model, nil
}

func (s *Service) anotherMePlacementBlocker(ctx context.Context, tenantID, humanActorID string) (*httpapi.AnotherMePlacementBlocker, error) {
	rows, err := s.queries.ListOwnedLocalComputers(ctx, store.ListOwnedLocalComputersParams{
		TenantID:     tenantID,
		OwnerActorID: humanActorID,
	})
	if err != nil {
		return nil, err
	}
	return anotherMePlacementBlockerFromRows(rows, tenantID, time.Now(), s.anotherMeState.lastCreateFailure(tenantID, humanActorID))
}

func anotherMePlacementBlockerFromRows(rows []store.RuntimeLocalComputer, tenantID string, now time.Time, lastFailure *anotherMeCreateFailure) (*httpapi.AnotherMePlacementBlocker, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	computers := make([]httpapi.LocalComputer, 0, len(rows))
	for _, row := range rows {
		rowNow := now
		if row.LastSeenAt.Valid && row.LastSeenAt.Time.After(rowNow) {
			rowNow = row.LastSeenAt.Time
		}
		projected, err := projectStoredLocalComputerForPlacement(row, tenantID, rowNow)
		if err != nil {
			return nil, err
		}
		computers = append(computers, projected)
	}
	_, blocker := evaluateAnotherMeLocalPlacement(computers, "")
	if blocker != nil {
		return blocker, nil
	}
	if lastFailure != nil {
		result := &httpapi.AnotherMePlacementBlocker{
			Reason: httpapi.CreateFailed,
		}
		if lastFailure.ComputerID != "" {
			computerID := lastFailure.ComputerID
			result.ComputerId = &computerID
		}
		return result, nil
	}
	return nil, nil
}

func stableAnotherMeActorID(tenantID, humanActorID string) string {
	digest := sha256.Sum256([]byte("another-me-actor\x00" + tenantID + "\x00" + humanActorID))
	return "actor_anotherme_" + hex.EncodeToString(digest[:16])
}
