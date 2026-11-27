package voice

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentroomhandoff"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// voiceLiveHandoffGistRunes bounds the instruction a handoff preview shows.
const voiceLiveHandoffGistRunes = 120

// voiceLiveHandedOffNext tells the voice an accepted handoff is under way,
// not finished, in its own tone.
const voiceLiveHandedOffNext = "You passed the request to the Room and they are on it now; it is not finished. Tell the user in one warm first-person sentence where you passed it and that you will bring back what comes of it, without repeating an acknowledgement you already said. Questions and results arrive later as Room reports."

func (s *Service) handOffVoiceLiveRoom(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args struct {
		RoomID      string              `json:"room_id"`
		Instruction string              `json:"instruction"`
		HandoffID   string              `json:"handoff_id"`
		Confirmed   voicelive.LooseBool `json:"confirmed"`
	}
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || strings.TrimSpace(args.Instruction) == "" || args.RoomID == "" || utf8.RuneCountInString(args.Instruction) > agentroomhandoff.MaxInstructionRunes {
		return "", voicelive.ErrInvalid
	}
	direct, err := s.queries.GetAnotherMeDirectRoomAgent(ctx, store.GetAnotherMeDirectRoomAgentParams{RoomID: session.RoomID, TenantID: session.TenantID})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (direct.AgentActorID != session.Agent.ID || direct.HumanActorID != session.HumanActorID) {
		return voicelive.ErrorOutput("anotherme_direct_chat_required"), nil
	}
	if err != nil {
		return "", err
	}
	room, err := s.queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: args.RoomID, AccountID: textValue(session.AccountID)})
	if errors.Is(err, pgx.ErrNoRows) || err == nil && (room.TenantID != session.TenantID || room.DeletionStartedAt.Valid || room.DirectAgentActorID.Valid || room.ParentRoomID.Valid || room.ID == session.RoomID) {
		return voicelive.ErrorOutput("room_unavailable"), nil
	}
	if err != nil {
		return "", err
	}
	if _, err := s.queries.GetRoomHandoffMember(ctx, store.GetRoomHandoffMemberParams{RoomID: room.ID, ActorID: session.Agent.ID}); errors.Is(err, pgx.ErrNoRows) {
		return voicelive.Output(map[string]string{"error": "agent_not_in_room", "room_id": room.ID, "actor_id": session.Agent.ID, "next": "Use add_room_members to invite yourself after the user confirms, then retry the handoff."}), nil
	} else if err != nil {
		return "", err
	}
	// The preview names the Room and the gist only, so the voice asks in its
	// own words instead of reading the whole instruction out; the full
	// instruction still binds the confirmation.
	instruction := strings.TrimSpace(args.Instruction)
	gist, cut := voicelive.Truncate(strings.Join(strings.Fields(instruction), " "), voiceLiveHandoffGistRunes)
	if cut {
		gist += "…"
	}
	prompt := voicelive.NeedsConfirmation("Pass to the room “" + room.Name + "”: " + gist)
	key := prompt + "\x00" + instruction + "\x00" + room.ID + "\x00" + args.HandoffID
	if confirmed, err := s.voiceLiveConfirmed(ctx, session, request, bool(args.Confirmed), key); err != nil || !confirmed {
		return prompt, err
	}
	digest := sha256.Sum256([]byte(session.ID + "\x00" + request.TurnId + "\x00" + room.ID + "\x00" + strings.TrimSpace(args.Instruction) + "\x00" + args.HandoffID))
	result, err := agentroomhandoff.HandOffLive(ctx, s.pool, session.ID, agentroomhandoff.Input{InvocationID: "agent-invocation-sha256:" + hex.EncodeToString(digest[:]), RoomID: room.ID, Instruction: args.Instruction, HandoffID: args.HandoffID})
	switch {
	case errors.Is(err, agentroomhandoff.ErrInvalid):
		return "", voicelive.ErrInvalid
	case errors.Is(err, agentroomhandoff.ErrNotFromDirectChat):
		return voicelive.ErrorOutput("anotherme_direct_chat_required"), nil
	case errors.Is(err, agentroomhandoff.ErrRoomUnavailable):
		return voicelive.ErrorOutput("room_or_handoff_unavailable"), nil
	case errors.Is(err, agentroomhandoff.ErrIdempotencyConflict):
		return voicelive.ErrorOutput("conflict"), nil
	case err != nil:
		return "", err
	}
	return voicelive.Output(map[string]any{"status": "accepted", "room_id": room.ID, "room": room.Name, "handoff_id": result.HandoffID, "next": voiceLiveHandedOffNext}), nil
}

func (s *Service) ackVoiceLiveRoomReports(ctx context.Context, session voicelive.Session, request teamhubinternal.VoiceLiveToolCall) (string, error) {
	var args struct {
		MessageIDs []string `json:"message_ids"`
	}
	if voicelive.DecodeArguments(request.Arguments, &args) != nil || len(args.MessageIDs) == 0 || len(args.MessageIDs) > 50 {
		return "", voicelive.ErrInvalid
	}
	if err := s.queries.MarkVoiceLiveRoomReportsTold(ctx, store.MarkVoiceLiveRoomReportsToldParams{VoiceSessionID: session.ID, MessageIds: args.MessageIDs}); err != nil {
		return "", err
	}
	return voicelive.Output(map[string]string{"status": "acknowledged"}), nil
}
