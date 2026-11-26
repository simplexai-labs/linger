package typedcard

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/idempotency"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// RoomCreated is the response body of a Room an Agent created at once.
type RoomCreated struct {
	Accepted         bool                          `json:"accepted"`
	Status           string                        `json:"status"`
	RoomID           string                        `json:"room_id"`
	SkippedArtifacts []roomCreationSkippedArtifact `json:"skipped_artifacts"`
}

// RoomCreatedStatus is the status of a Room created without an approval card.
const RoomCreatedStatus = "created"

// CreateRoomInTx creates an Agent's requested Room at once in the caller's
// transaction, owned by the Agent's Sponsor, with the same snapshot,
// Documents, initial message and handoff an approved creation card makes. A
// retried submission replays its response.
func (s *Service) CreateRoomInTx(ctx context.Context, tx pgx.Tx, input CreationApprovalInTxInput) (CreateResult, error) {
	command, err := normalizeCreationApprovalSubmission(input.Submission)
	if err != nil {
		return CreateResult{}, err
	}
	if s == nil || tx == nil || input.RoomID == "" || input.AgentManagementID == "" ||
		strings.TrimSpace(input.IdempotencyOperation) == "" || len(input.IdempotencyOperation) > 300 ||
		len(input.CallerInputHash) != sha256.Size {
		return CreateResult{}, ErrInvalid
	}
	operation := strings.TrimSpace(input.IdempotencyOperation)
	queries := store.New(tx)
	if err := queries.AcquireAdvisoryTransactionLock(ctx, "room-membership|"+input.RoomID); err != nil {
		return CreateResult{}, err
	}
	source, err := queries.ResolveCreationApprovalAgentSource(ctx, store.ResolveCreationApprovalAgentSourceParams{
		RoomID: input.RoomID, AgentManagementID: input.AgentManagementID,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, ErrNotFound
	}
	if err != nil {
		return CreateResult{}, err
	}
	if input.ExpectedAgentActorID != "" && source.AgentActorID != input.ExpectedAgentActorID ||
		input.ExpectedTenantID != "" && source.TenantID != input.ExpectedTenantID {
		return CreateResult{}, ErrForbidden
	}
	key := idempotency.AgentKey(source.AgentActorID, operation, command.SubmissionID)
	if err := idempotency.Lock(ctx, tx, key); err != nil {
		return CreateResult{}, err
	}
	// A submission made before Rooms were created at once replays its card.
	if replay, found, err := lookupCreationApprovalReplay(
		ctx, queries, source.AgentActorID, operation, command.SubmissionID, input.CallerInputHash,
	); err != nil || found {
		return replay, err
	}
	record, found, err := idempotency.Lookup(ctx, tx, key, input.CallerInputHash)
	if errors.Is(err, idempotency.ErrConflict) {
		return CreateResult{}, ErrIdempotencyConflict
	}
	if err != nil {
		return CreateResult{}, err
	}
	if found {
		return CreateResult{Status: record.Status, Body: record.Body, Replay: true}, nil
	}
	owner, err := queries.GetActor(ctx, store.GetActorParams{ID: source.CreatedByActorID, TenantID: source.TenantID})
	if err != nil {
		return CreateResult{}, err
	}
	if !owner.AccountID.Valid {
		return CreateResult{}, ErrForbidden
	}
	if input.BeforeCreate != nil {
		if err := input.BeforeCreate(ctx, queries, CreationApprovalSource{
			TenantID: source.TenantID, AgentActorID: source.AgentActorID,
			AgentManagementID: input.AgentManagementID, CreatedByActorID: source.CreatedByActorID,
			DecisionOwner: owner,
		}, &command); err != nil {
			return CreateResult{}, err
		}
		if command, err = normalizeCreationApprovalSubmission(command); err != nil {
			return CreateResult{}, err
		}
	}
	room, err := createSnapshotRoom(ctx, tx, queries, snapshotRoomSpec{
		tenantID: source.TenantID, originRoomID: input.RoomID, agentActorID: source.AgentActorID,
		accountID: owner.AccountID.String, owner: owner, snapshot: command.FulfillmentSnapshot,
		bindingKey: "room-create-artifacts:" + operation + ":" + command.SubmissionID,
	})
	if err != nil {
		return CreateResult{}, err
	}
	roomID := room.created.Room.ID
	text, err := roomCreationHandoffText(input.RoomID, roomID, room.snapshot.Description, room.delivered, nil)
	if err != nil {
		return CreateResult{}, err
	}
	// The handoff shares the initial message's transaction and Room topic, so
	// the Agent's new Room Context accepts both in one batch and wakes once.
	handoff, err := messagecreation.CardHandoff(ctx, queries, messagecreation.Draft{
		TenantID: source.TenantID, RoomID: roomID, Author: owner, HumanWaiting: true,
	}, room.agent, text)
	if err != nil {
		return CreateResult{}, err
	}
	if _, err := messagecreation.Publish(ctx, queries, handoff); err != nil {
		return CreateResult{}, err
	}
	body, err := json.Marshal(RoomCreated{Accepted: true, Status: RoomCreatedStatus, RoomID: roomID, SkippedArtifacts: room.skipped})
	if err != nil {
		return CreateResult{}, err
	}
	if err := idempotency.Save(ctx, tx, key, input.CallerInputHash, idempotency.Record{
		ResourceID: roomID, Status: http.StatusOK, Body: body,
	}); err != nil {
		return CreateResult{}, err
	}
	return CreateResult{Status: http.StatusOK, Body: body}, nil
}
