package typedcard

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// CreationApprovalSubmission is an Agent's Room creation request: what it
// sent, what TeamHub made of it, and the Room it froze for the decision. It
// is the decision's stored request.
type CreationApprovalSubmission struct {
	SubmissionID        string          `json:"submission_id"`
	CallerInput         json.RawMessage `json:"caller_input"`
	EffectivePayload    json.RawMessage `json:"effective_payload"`
	FulfillmentSnapshot json.RawMessage `json:"fulfillment_snapshot"`
}

type CreationApprovalInTxInput struct {
	RoomID               string
	AgentManagementID    string
	ExpectedAgentActorID string
	ExpectedTenantID     string
	IdempotencyOperation string
	CallerInputHash      []byte
	Submission           CreationApprovalSubmission
	BeforeCreate         CreationApprovalBeforeCreate
}

type CreationApprovalSource struct {
	TenantID          string
	AgentActorID      string
	AgentManagementID string
	CreatedByActorID  string
	DecisionOwner     store.Actor
}

type CreationApprovalBeforeCreate func(
	context.Context,
	*store.Queries,
	CreationApprovalSource,
	*CreationApprovalSubmission,
) error

func roomCreationTitle(name string) string {
	return fmt.Sprintf("Request to create a collaboration room: %s", name)
}

func normalizeCreationApprovalSubmission(input CreationApprovalSubmission) (CreationApprovalSubmission, error) {
	input.SubmissionID = strings.TrimSpace(input.SubmissionID)
	if input.SubmissionID == "" || len(input.SubmissionID) > 200 ||
		!jsonObject(input.CallerInput) || !jsonObject(input.EffectivePayload) ||
		!jsonObject(input.FulfillmentSnapshot) {
		return CreationApprovalSubmission{}, ErrInvalid
	}
	return input, nil
}

func jsonObject(value json.RawMessage) bool {
	if len(value) == 0 || !json.Valid(value) {
		return false
	}
	var object map[string]json.RawMessage
	return json.Unmarshal(value, &object) == nil && object != nil
}

func lookupCreationApprovalReplay(
	ctx context.Context,
	queries *store.Queries,
	agentActorID, operation, submissionID string,
	callerInputHash []byte,
) (CreateResult, bool, error) {
	record, err := queries.GetRoomCreationSubmissionReplay(ctx, store.GetRoomCreationSubmissionReplayParams{
		AgentActorID: agentActorID, SubmissionID: submissionID, Operation: operation,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return CreateResult{}, false, nil
	}
	if err != nil {
		return CreateResult{}, false, err
	}
	if !bytes.Equal(record.RequestHash, callerInputHash) {
		return CreateResult{}, false, ErrIdempotencyConflict
	}
	return CreateResult{
		Status: int(record.ResponseStatus.Int32), Body: record.ResponseBody, Replay: true,
		MessageID: record.MessageID, DecisionID: record.ID,
	}, true, nil
}

// roomCreationCardView is a Room creation card's title and view: the frozen
// Room, and once approved, the Room it created.
func roomCreationCardView(view, rawResult []byte) (string, json.RawMessage, error) {
	var proposal roomCreationProposal
	if err := json.Unmarshal(view, &proposal); err != nil {
		return "", nil, err
	}
	var result struct {
		Data struct {
			CreatedRoomID string `json:"created_room_id"`
		} `json:"data"`
	}
	if len(rawResult) > 0 {
		if err := json.Unmarshal(rawResult, &result); err != nil {
			return "", nil, err
		}
	}
	encoded, err := json.Marshal(struct {
		roomCreationProposal
		CreatedRoomID string `json:"created_room_id,omitempty"`
	}{proposal, result.Data.CreatedRoomID})
	return roomCreationTitle(proposal.Name), encoded, err
}

type roomCreationProposal struct {
	OriginRoomID           string                    `json:"origin_room_id"`
	Name                   string                    `json:"name"`
	Description            *string                   `json:"description,omitempty"`
	MemberIDs              []string                  `json:"member_ids"`
	InitialMessageSegments []messagecreation.Segment `json:"initial_message_segments"`
}
