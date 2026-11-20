package agentruntimestate

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/messagecreation"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const maxFallbackReplyRunes = 50000

// DeliverFallbackReplyInput carries a Room Run's non-empty final assistant text
// when the Agent did not invoke the message command.
type DeliverFallbackReplyInput struct {
	ContextKey string
	Epoch      string
	RunID      string
	Text       string
	InboxID    string
}

// DeliverFallbackReplyResult reports whether the Room now holds a reply for the Run.
type DeliverFallbackReplyResult struct {
	Delivered   bool
	AlreadySent bool
	MessageID   string
}

// DeliverFallbackReply idempotently publishes a running Room Run's final
// assistant text into its authorized Room or Thread when the Run has not
// already posted a conversation Message.
func (s *Service) DeliverFallbackReply(
	ctx context.Context,
	input DeliverFallbackReplyInput,
) (DeliverFallbackReplyResult, error) {
	if strings.TrimSpace(input.ContextKey) == "" || strings.TrimSpace(input.RunID) == "" {
		return DeliverFallbackReplyResult{}, ErrInvalid
	}
	text := strings.TrimSpace(input.Text)
	if text == "" {
		return DeliverFallbackReplyResult{}, ErrInvalid
	}
	if utf8.RuneCountInString(text) > maxFallbackReplyRunes {
		return DeliverFallbackReplyResult{}, ErrResponseTooLarge
	}
	return executeEpochTx(ctx, s, input.Epoch, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (DeliverFallbackReplyResult, error) {
		contextRow, err := lockContext(ctx, queries, input.ContextKey)
		if err != nil {
			return DeliverFallbackReplyResult{}, err
		}
		if contextRow.ContextKind != "meta" || !contextRow.RoomID.Valid || contextRow.TerminatedAt.Valid {
			return DeliverFallbackReplyResult{}, ErrInboxNotAuthorized
		}
		if err := requireContextAuthority(ctx, queries, contextRow); err != nil {
			return DeliverFallbackReplyResult{}, err
		}
		run, err := queries.GetAgentLocalRun(ctx, store.GetAgentLocalRunParams{
			ContextKey: input.ContextKey, RunID: input.RunID,
		})
		if isNoRows(err) {
			return DeliverFallbackReplyResult{}, ErrNotFound
		}
		if err != nil {
			return DeliverFallbackReplyResult{}, err
		}
		if run.Status != "running" || run.CancellationRequested {
			return DeliverFallbackReplyResult{}, ErrConflict
		}
		if run.Epoch.String != input.Epoch {
			return DeliverFallbackReplyResult{}, ErrFenced
		}
		roomID, err := resolveFallbackReplyRoomID(ctx, queries, contextRow, input.InboxID)
		if err != nil {
			return DeliverFallbackReplyResult{}, err
		}
		fallbackMessageID := fallbackReplyMessageID(input.ContextKey, input.RunID)
		fallbackInvocationID := fallbackReplyInvocationID(input.ContextKey, input.RunID)

		existingID, err := queries.GetAgentLocalRunMessage(ctx, store.GetAgentLocalRunMessageParams{
			TenantID:      contextRow.TenantID,
			LocalRunID:    input.RunID,
			AuthorActorID: contextRow.AgentActorID,
		})
		if err == nil {
			return DeliverFallbackReplyResult{
				Delivered:   true,
				AlreadySent: existingID != fallbackMessageID,
				MessageID:   existingID,
			}, nil
		}
		if !isNoRows(err) {
			return DeliverFallbackReplyResult{}, err
		}
		if _, err := queries.GetMessageInRoom(ctx, store.GetMessageInRoomParams{
			ID: fallbackMessageID, RoomID: roomID,
		}); err == nil {
			return DeliverFallbackReplyResult{
				Delivered: true,
				MessageID: fallbackMessageID,
			}, nil
		} else if !isNoRows(err) {
			return DeliverFallbackReplyResult{}, err
		}

		author, err := queries.GetActor(ctx, store.GetActorParams{
			ID: contextRow.AgentActorID, TenantID: contextRow.TenantID,
		})
		if err != nil {
			return DeliverFallbackReplyResult{}, err
		}
		content, err := messagecreation.Normalize([]messagecreation.Segment{{
			Type: "text", Content: text,
		}})
		if err != nil {
			if errors.Is(err, messagecreation.ErrInvalid) {
				return DeliverFallbackReplyResult{}, ErrInvalid
			}
			return DeliverFallbackReplyResult{}, err
		}
		created, err := messagecreation.Create(ctx, queries, messagecreation.Draft{
			ID:           fallbackMessageID,
			TenantID:     contextRow.TenantID,
			RoomID:       roomID,
			Author:       author,
			Content:      content,
			TrustedRunID: input.RunID,
		})
		if err != nil {
			if errors.Is(err, messagecreation.ErrInvalid) {
				return DeliverFallbackReplyResult{}, ErrInvalid
			}
			return DeliverFallbackReplyResult{}, err
		}
		if _, err := RecordPresentationOutput(ctx, queries, PresentationOutput{
			LocalRunID:   input.RunID,
			TenantID:     contextRow.TenantID,
			RoomID:       roomID,
			AgentActorID: contextRow.AgentActorID,
			InvocationID: fallbackInvocationID,
			OutputID:     created.Message.ID,
			OutputKind:   "message",
			Surface:      "room_timeline",
			MessageID:    created.Message.ID,
			Continues:    false,
		}); err != nil {
			return DeliverFallbackReplyResult{}, err
		}
		return DeliverFallbackReplyResult{
			Delivered: true,
			MessageID: created.Message.ID,
		}, nil
	})
}

func resolveFallbackReplyRoomID(
	ctx context.Context,
	queries *store.Queries,
	contextRow contextRecord,
	inboxID string,
) (string, error) {
	if inboxID == "" {
		return contextRow.RoomID.String, nil
	}
	if roomID, ok := strings.CutPrefix(inboxID, "room:"); ok {
		if roomID == "" || roomID != contextRow.RoomID.String {
			return "", ErrInboxNotAuthorized
		}
		return roomID, nil
	}
	if threadID, ok := strings.CutPrefix(inboxID, "thread:"); ok {
		if threadID == "" {
			return "", ErrInvalid
		}
		thread, err := queries.GetThreadRoomByRoomID(ctx, threadID)
		if isNoRows(err) {
			return "", ErrInboxNotAuthorized
		}
		if err != nil {
			return "", err
		}
		if thread.TenantID != contextRow.TenantID || thread.ParentRoomID != contextRow.RoomID.String {
			return "", ErrInboxNotAuthorized
		}
		return threadID, nil
	}
	return "", ErrInvalid
}

func fallbackReplyMessageID(contextKey, runID string) string {
	digest := sha256.Sum256([]byte("fallback_reply:" + contextKey + "\x00" + runID))
	return "message_" + hex.EncodeToString(digest[:16])
}

func fallbackReplyInvocationID(contextKey, runID string) string {
	digest := sha256.Sum256([]byte("fallback_reply:" + contextKey + "\x00" + runID))
	return "agent-invocation-sha256:" + hex.EncodeToString(digest[:])
}
