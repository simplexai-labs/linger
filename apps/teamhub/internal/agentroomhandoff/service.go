// Package agentroomhandoff hands a Human's request from the direct chat with
// their AnotherMe to that AnotherMe's Context in another Room. An Agent writes
// only in its Context Room, so the direct chat never posts in the other Room:
// it leaves a hidden handoff there that wakes the AnotherMe's own Context,
// which then decides what to say to that Room.
package agentroomhandoff

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentauth"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomcreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
)

const (
	toolName             = "hand_off_to_room"
	idempotencyOperation = "hand_off_to_room"
	// MaxInstructionRunes bounds the instruction the receiving Context reads.
	MaxInstructionRunes = 8000
)

var (
	// ErrInvalid reports a malformed request.
	ErrInvalid = errors.New("Room handoff input is invalid")
	// ErrNotFromDirectChat reports a caller that is not an AnotherMe Meta in
	// its direct chat with its Human.
	ErrNotFromDirectChat = fmt.Errorf("%w: only an AnotherMe hands off from its direct chat", agentauth.ErrForbidden)
	// ErrNotRequestedByHuman reports a Run that nothing the Human did in the
	// direct chat started, such as a proactive wake, Routine or Task report.
	ErrNotRequestedByHuman = fmt.Errorf("%w: only a turn the Human started hands off", agentauth.ErrForbidden)
	// ErrRoomUnavailable reports a target Room that is missing, being
	// deleted, the direct chat itself, or lacks the AnotherMe or its Human.
	ErrRoomUnavailable = errors.New("Room handoff target is unavailable")
	// ErrIdempotencyConflict reports an invocation reused with other input.
	ErrIdempotencyConflict = errors.New("Room handoff invocation was reused with different input")
	// ErrUnavailable reports a receipt that no longer matches current facts.
	ErrUnavailable = errors.New("Room handoff service is unavailable")

	invocationPattern = regexp.MustCompile(`^agent-invocation-sha256:[a-f0-9]{64}$`)
	roomIDPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`)
)

// Input is one handoff request.
type Input struct {
	InvocationID string
	RoomID       string
	Instruction  string
	HandoffID    string
}

// Result is the handoff in the target Room.
type Result struct {
	InboxID   string
	HandoffID string
	Replay    bool
}

type receipt struct {
	InboxID   string `json:"inbox_id"`
	HandoffID string `json:"handoff_id"`
}

// Service posts Room handoffs.
type Service struct {
	pool       *pgxpool.Pool
	authorizer *agentauth.Service
}

// New builds the Service.
func New(pool *pgxpool.Pool, authorizer *agentauth.Service) *Service {
	return &Service{pool: pool, authorizer: authorizer}
}

// HandOff posts the handoff in input.RoomID, or returns the receipt of the
// same invocation.
func (s *Service) HandOff(ctx context.Context, token string, input Input) (Result, error) {
	if err := validateInput(input); err != nil {
		return Result{}, err
	}
	if s == nil || s.pool == nil || s.authorizer == nil {
		return Result{}, ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	authorization, err := s.authorizer.AuthorizeInTx(ctx, tx, token, toolName)
	if err != nil {
		return Result{}, err
	}
	queries := store.New(tx)
	directRoomID, err := directChat(ctx, queries, authorization)
	if err != nil {
		return Result{}, err
	}

	result, err := handOffInTx(ctx, tx, handoffCaller{authorization.TenantID, authorization.UserArtifactOwnerActorID, authorization.AgentActorID}, directRoomID, input, func() error {
		return requireHumanRequest(ctx, queries, authorization, directRoomID, authorization.UserArtifactOwnerActorID)
	})
	if err != nil {
		return Result{}, err
	}
	return result, tx.Commit(ctx)
}

// HandOffLive uses the active call's own Human and AnotherMe without starting
// a direct-chat Meta. It rechecks the lease in the publishing transaction.
func HandOffLive(ctx context.Context, pool *pgxpool.Pool, sessionID string, input Input) (Result, error) {
	if err := validateInput(input); err != nil {
		return Result{}, err
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Result{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	current, err := queries.LockVoiceLiveSessionCurrent(ctx, sessionID)
	if err != nil {
		return Result{}, err
	}
	if !current {
		return Result{}, voicelive.ErrNotFound
	}
	session, err := voicelive.ActiveSession(ctx, queries, sessionID)
	if err != nil {
		return Result{}, err
	}
	direct, err := queries.GetAnotherMeDirectRoomAgent(ctx, store.GetAnotherMeDirectRoomAgentParams{RoomID: session.RoomID, TenantID: session.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (direct.AgentActorID != session.Agent.ID || direct.HumanActorID != session.HumanActorID) {
		return Result{}, ErrNotFromDirectChat
	}
	if err != nil {
		return Result{}, err
	}
	result, err := handOffInTx(ctx, tx, handoffCaller{session.TenantID, session.HumanActorID, session.Agent.ID}, session.RoomID, input, nil)
	if err != nil {
		return Result{}, err
	}
	return result, tx.Commit(ctx)
}

type handoffCaller struct{ tenant, human, agent string }

func validateInput(input Input) error {
	if !invocationPattern.MatchString(input.InvocationID) || !roomIDPattern.MatchString(input.RoomID) ||
		(input.HandoffID != "" && !roomIDPattern.MatchString(input.HandoffID)) || strings.TrimSpace(input.Instruction) == "" || utf8.RuneCountInString(input.Instruction) > MaxInstructionRunes {
		return ErrInvalid
	}
	return nil
}

func handOffInTx(ctx context.Context, tx pgx.Tx, caller handoffCaller, directRoomID string, input Input, verifyHuman func() error) (Result, error) {
	queries := store.New(tx)
	instruction := strings.TrimSpace(input.Instruction)
	payload := input.RoomID + "\x00" + instruction
	if input.HandoffID != "" {
		payload += "\x00" + input.HandoffID
	}
	requestHash := sha256.Sum256([]byte(payload))
	key := idempotency.AgentKey(caller.agent, idempotencyOperation,
		agentauth.IdempotencyKey(idempotencyOperation, input.InvocationID))
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return Result{}, err
	}
	record, found, err := idempotency.Lookup(ctx, tx, key, requestHash[:])
	if errors.Is(err, idempotency.ErrConflict) {
		return Result{}, ErrIdempotencyConflict
	}
	if err != nil {
		return Result{}, err
	}
	if found {
		var stored receipt
		if json.Unmarshal(record.Body, &stored) != nil || record.InvocationID != input.InvocationID ||
			stored.HandoffID != record.ResourceID || stored.InboxID != "room:"+input.RoomID {
			return Result{}, ErrUnavailable
		}
		return Result{InboxID: stored.InboxID, HandoffID: stored.HandoffID, Replay: true}, nil
	}

	if verifyHuman != nil {
		if err := verifyHuman(); err != nil {
			return Result{}, err
		}
	}
	// Departure and admission serialize with the instruction's publication.
	if err := roomcreation.LockMemberships(ctx, queries, directRoomID, input.RoomID); err != nil {
		return Result{}, err
	}
	humanActor, agentActor, err := targetMembers(ctx, queries, caller, directRoomID, input.RoomID)
	if err != nil {
		return Result{}, err
	}
	messageID := handoffMessageID(caller.agent, input.InvocationID)
	handoffID := messageID
	if input.HandoffID != "" {
		existing, err := queries.GetRoomHandoff(ctx, input.HandoffID)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && (existing.TenantID != caller.tenant || existing.AgentActorID != caller.agent || existing.HumanActorID != caller.human || existing.OriginRoomID != directRoomID || existing.RoomID != input.RoomID) {
			return Result{}, ErrRoomUnavailable
		}
		if err != nil {
			return Result{}, err
		}
		handoffID = existing.ID
	}
	text, err := handoffText(handoffID, directRoomID, input.RoomID, instruction, caller.human, time.Now())
	if err != nil {
		return Result{}, err
	}
	// The Human speaks the hidden message so the AnotherMe does not ignore it
	// as its own; the mention wakes only that AnotherMe's Context.
	persisted, err := messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		ID: messageID, TenantID: caller.tenant, RoomID: input.RoomID, Author: humanActor,
		HumanWaiting: true,
	}, agentActor, text)
	if err != nil {
		return Result{}, err
	}
	if _, err := messagecreation.Publish(ctx, queries, persisted); err != nil {
		return Result{}, err
	}
	if input.HandoffID == "" {
		err = queries.CreateRoomHandoff(ctx, store.CreateRoomHandoffParams{ID: handoffID, TenantID: caller.tenant, OriginRoomID: directRoomID, RoomID: input.RoomID, HumanActorID: caller.human, AgentActorID: caller.agent})
	} else {
		err = queries.SetRoomHandoffState(ctx, store.SetRoomHandoffStateParams{ID: handoffID, State: "working"})
	}
	if err != nil {
		return Result{}, err
	}
	stored := receipt{InboxID: "room:" + input.RoomID, HandoffID: handoffID}
	body, err := json.Marshal(stored)
	if err != nil {
		return Result{}, err
	}
	if err := idempotency.Save(ctx, tx, key, requestHash[:], idempotency.Record{
		ResourceID: handoffID, Status: http.StatusOK, Body: body, InvocationID: input.InvocationID,
	}); err != nil {
		return Result{}, err
	}
	return Result{InboxID: stored.InboxID, HandoffID: handoffID}, nil
}

// directChat returns the caller's Context Room when it is the AnotherMe's
// live direct chat with its Human.
func directChat(ctx context.Context, queries *store.Queries, authorization agentauth.Authorization) (string, error) {
	human := authorization.UserArtifactOwnerActorID
	if authorization.AgentType != "anotherme" || authorization.ParticipantTaskID != "" ||
		authorization.Target.Kind != "room" || authorization.RoomID == "" || human == "" {
		return "", ErrNotFromDirectChat
	}
	direct, err := queries.GetDirectRoomByPair(ctx, store.GetDirectRoomByPairParams{
		TenantID: authorization.TenantID, HumanActorID: human, AgentActorID: authorization.AgentActorID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFromDirectChat
	}
	if err != nil {
		return "", err
	}
	if direct.ID != authorization.RoomID || direct.DeletionStartedAt.Valid {
		return "", ErrNotFromDirectChat
	}
	return direct.ID, nil
}

// requireHumanRequest admits only the Run the request names when it carries
// a message the Human wrote, or a card they decided, in the direct chat. A
// proactive wake, Routine or Task callback runs there too, often on content
// from outside (mail, events, documents), and must not reach other Rooms.
func requireHumanRequest(
	ctx context.Context,
	queries *store.Queries,
	authorization agentauth.Authorization,
	directRoomID, human string,
) error {
	runID := messagecreation.RunClaim(ctx)
	if runID == "" {
		return ErrNotRequestedByHuman
	}
	started, err := queries.IsRunStartedByDirectChatHuman(ctx, store.IsRunStartedByDirectChatHumanParams{
		RoomID: directRoomID, RunID: runID, TenantID: authorization.TenantID,
		AgentActorID: authorization.AgentActorID, HumanActorID: human,
	})
	if err != nil {
		return err
	}
	if !started {
		return ErrNotRequestedByHuman
	}
	return nil
}

// targetMembers locks the live target Room and returns its Human and
// AnotherMe members, key-share locked until the handoff commits.
func targetMembers(
	ctx context.Context,
	queries *store.Queries,
	caller handoffCaller,
	directRoomID, roomID string,
) (store.Actor, store.Actor, error) {
	if roomID == directRoomID {
		return store.Actor{}, store.Actor{}, ErrRoomUnavailable
	}
	if thread, err := queries.GetThreadRoomByRoomID(ctx, roomID); err == nil && thread.RoomID == roomID {
		return store.Actor{}, store.Actor{}, ErrRoomUnavailable
	} else if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return store.Actor{}, store.Actor{}, err
	}
	active, err := queries.LockActiveRoomForMutation(ctx, roomID)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && active != roomID {
		return store.Actor{}, store.Actor{}, ErrRoomUnavailable
	}
	if err != nil {
		return store.Actor{}, store.Actor{}, err
	}
	member := func(actorID, kind string) (store.Actor, error) {
		actor, err := queries.GetRoomHandoffMember(ctx, store.GetRoomHandoffMemberParams{RoomID: roomID, ActorID: actorID})
		if errors.Is(err, pgx.ErrNoRows) {
			return store.Actor{}, ErrRoomUnavailable
		}
		if err != nil {
			return store.Actor{}, err
		}
		if actor.TenantID != caller.tenant || actor.Kind != kind {
			return store.Actor{}, ErrRoomUnavailable
		}
		return actor, nil
	}
	humanActor, err := member(caller.human, "human")
	if err != nil {
		return store.Actor{}, store.Actor{}, err
	}
	agentActor, err := member(caller.agent, "agent")
	if err != nil {
		return store.Actor{}, store.Actor{}, err
	}
	return humanActor, agentActor, nil
}

// handoffMessageID derives the hidden message from the invocation, so one
// invocation posts at most one handoff.
func handoffMessageID(agentActorID, invocationID string) string {
	digest := sha256.Sum256([]byte("room-handoff:" + agentActorID + ":" + invocationID))
	return "message_" + hex.EncodeToString(digest[:16])
}

func handoffText(handoffID, directRoomID, roomID, instruction, humanActorID string, requestedAt time.Time) (string, error) {
	payload, err := json.Marshal(struct {
		Kind          string    `json:"kind"`
		HandoffID     string    `json:"handoff_id"`
		OriginRoomID  string    `json:"origin_room_id"`
		OriginInboxID string    `json:"origin_room_inbox_id"`
		RoomInboxID   string    `json:"room_inbox_id"`
		Instruction   string    `json:"instruction"`
		RequestedBy   string    `json:"requested_by"`
		RequestedAt   time.Time `json:"requested_at"`
	}{
		"room_handoff", handoffID, directRoomID, "room:" + directRoomID, "room:" + roomID,
		instruction, humanActorID, requestedAt.UTC(),
	})
	if err != nil {
		return "", err
	}
	prompt := fmt.Sprintf(`<room-handoff-pattern>
Your Human asked for this in your direct chat, and you there handed it to you here. Carry out the
instruction in this Room: read this Room's history with teamhub message read, then post here and
mention each Agent who should act. Reply only to the Inbox room:%s. Messages of the direct chat are
not copied into this Room. When the work is done or needs your Human's decision, tell them with
teamhub message direct --handoff %s --handoff-state waiting_for_user (a question) or
--handoff-state completed (a result). Use working for a useful progress update. Keep following this
request as new Room messages arrive until it is completed or the Human asks you to stop. Do not
relay every message. Pass the handoff ID only in --handoff; in the private message, name this Room
and include enough context for the Human to answer.
Never hand this work back.
</room-handoff-pattern>`, roomID, handoffID)
	return " Room handoff=" + string(payload) + "\n" + prompt, nil
}
