package agentruntimestate

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentmessages"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

const (
	recentMessagesLimit         = 5
	recentMessageMaxRunes       = 800
	recentMessagesTotalMaxRunes = 4000
)

func validSessionRecoveryReason(reason string) bool {
	return reason == "" || reason == "session_not_found" || reason == "context_too_long"
}

// recentMessagesForFreshSession returns up to five recent product messages
// preceding this Run's first input when the Context currently holds no
// persisted Runtime Session. On a retried attempt (attemptCount > 1), replies
// authored by this Agent after the Run's first input are also included so a
// restarted session sees what the failed attempt already posted. Active
// session resumes pay only one primary-key lookup and skip the history query.
func recentMessagesForFreshSession(
	ctx context.Context,
	queries *store.Queries,
	owner contextRecord,
	initial []StoredRuntimeInput,
	attemptCount int32,
) (*RecentMessages, error) {
	_, err := queries.GetAgentRuntimeSession(ctx, owner.ContextKey)
	if err == nil {
		return nil, nil
	}
	if !isNoRows(err) {
		return nil, err
	}
	inboxID := primaryRecentMessagesInbox(owner, initial)
	if inboxID == "" {
		return nil, nil
	}
	currentIDs := runInputMessageIDs(initial)
	currentSet := make(map[string]struct{}, len(currentIDs))
	for _, id := range currentIDs {
		currentSet[id] = struct{}{}
	}
	cursorID := ""
	cursorTime := pgtype.Timestamptz{Time: time.Unix(0, 0), Valid: true}
	var anchor *store.ReadAgentHistoryMessagesRow
	if len(currentIDs) > 0 {
		anchors, err := queries.ReadAgentHistoryMessages(ctx, store.ReadAgentHistoryMessagesParams{
			TenantID:   owner.TenantID,
			ActorID:    owner.AgentActorID,
			InboxID:    inboxID,
			InboxIds:   []string{},
			MessageIds: currentIDs,
			CursorTime: cursorTime,
			PageLimit:  int32(len(currentIDs) + 1),
		})
		if err != nil {
			return nil, err
		}
		if len(anchors) > 0 {
			earliest := anchors[0]
			for _, row := range anchors[1:] {
				if row.CreatedAt.Time.Before(earliest.CreatedAt.Time) ||
					(row.CreatedAt.Time.Equal(earliest.CreatedAt.Time) && row.MessageID < earliest.MessageID) {
					earliest = row
				}
			}
			anchor = &earliest
			cursorID = earliest.MessageID
			cursorTime = earliest.CreatedAt
		}
	}
	beforeRows, err := queries.ReadAgentHistoryMessages(ctx, store.ReadAgentHistoryMessagesParams{
		TenantID:   owner.TenantID,
		ActorID:    owner.AgentActorID,
		InboxID:    inboxID,
		InboxIds:   []string{},
		MessageIds: []string{},
		CursorID:   cursorID,
		CursorTime: cursorTime,
		PageLimit:  recentMessagesLimit + 1,
	})
	if err != nil {
		return nil, err
	}
	var afterAgentRows []store.ReadAgentHistoryMessagesRow
	if attemptCount > 1 && anchor != nil {
		latestRows, err := queries.ReadAgentHistoryMessages(ctx, store.ReadAgentHistoryMessagesParams{
			TenantID:   owner.TenantID,
			ActorID:    owner.AgentActorID,
			InboxID:    inboxID,
			InboxIds:   []string{},
			MessageIds: []string{},
			CursorTime: pgtype.Timestamptz{Time: time.Unix(0, 0), Valid: true},
			PageLimit:  int32(recentMessagesLimit + len(currentIDs) + 5),
		})
		if err != nil {
			return nil, err
		}
		for _, row := range latestRows {
			if row.CreatedAt.Time.Before(anchor.CreatedAt.Time) ||
				(row.CreatedAt.Time.Equal(anchor.CreatedAt.Time) && row.MessageID <= anchor.MessageID) {
				break
			}
			if _, isInput := currentSet[row.MessageID]; isInput {
				continue
			}
			if row.AuthorActorID == owner.AgentActorID {
				afterAgentRows = append(afterAgentRows, row)
			}
		}
	}
	combined := make([]store.ReadAgentHistoryMessagesRow, 0, len(afterAgentRows)+len(beforeRows))
	combined = append(combined, afterAgentRows...)
	combined = append(combined, beforeRows...)
	if len(combined) == 0 {
		return nil, nil
	}
	hasMore := false
	if len(combined) > recentMessagesLimit {
		hasMore = true
		combined = combined[:recentMessagesLimit]
	}
	nextCursor := ""
	if hasMore {
		oldest := combined[len(combined)-1]
		nextCursor = agentmessages.EncodeCursor(oldest.CreatedAt.Time, oldest.MessageID)
	}
	slices.Reverse(combined)
	messages := make([]RecentMessage, 0, len(combined))
	remainingBudget := recentMessagesTotalMaxRunes
	for _, row := range combined {
		maxRunes := min(recentMessageMaxRunes, remainingBudget)
		body, truncated := truncateRunes(row.Body, maxRunes)
		remainingBudget -= utf8.RuneCountInString(body)
		if remainingBudget < 0 {
			remainingBudget = 0
		}
		messages = append(messages, RecentMessage{
			MessageID:  row.MessageID,
			Author:     row.Author,
			AuthorKind: row.AuthorKind,
			Body:       body,
			Truncated:  truncated,
			CreatedAt:  row.CreatedAt.Time.UTC(),
		})
	}
	return &RecentMessages{
		InboxID:    inboxID,
		Messages:   messages,
		NextCursor: nextCursor,
	}, nil
}

func primaryRecentMessagesInbox(owner contextRecord, initial []StoredRuntimeInput) string {
	for _, input := range initial {
		if validRecentMessagesInbox(input.SourceInboxID) {
			return input.SourceInboxID
		}
		var payload struct {
			SourceInboxIDs []string `json:"sourceInboxIds"`
		}
		if json.Unmarshal(input.Payload, &payload) == nil {
			for _, inboxID := range payload.SourceInboxIDs {
				if validRecentMessagesInbox(inboxID) {
					return inboxID
				}
			}
		}
	}
	if owner.RoomID.Valid && owner.RoomID.String != "" {
		return "room:" + owner.RoomID.String
	}
	if owner.TaskID.Valid && owner.TaskID.String != "" {
		return "task:" + owner.TaskID.String
	}
	return ""
}

func validRecentMessagesInbox(id string) bool {
	for _, prefix := range []string{"room:", "thread:", "task:", "meta:", "taskmeta:"} {
		if strings.HasPrefix(id, prefix) && len(id) > len(prefix) {
			return true
		}
	}
	return false
}

func runInputMessageIDs(inputs []StoredRuntimeInput) []string {
	seen := make(map[string]struct{}, len(inputs))
	ids := make([]string, 0, len(inputs))
	add := func(id string) {
		id = strings.TrimSpace(id)
		if id == "" {
			return
		}
		if _, exists := seen[id]; exists {
			return
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	for _, input := range inputs {
		add(input.SourceMessageID)
		var payload struct {
			InvocationMessageIDs []string `json:"invocationMessageIds"`
		}
		if json.Unmarshal(input.Payload, &payload) == nil {
			for _, id := range payload.InvocationMessageIDs {
				add(id)
			}
		}
	}
	return ids
}

func truncateRunes(text string, maxRunes int) (string, bool) {
	if maxRunes <= 0 {
		return "", text != ""
	}
	count := 0
	for index := range text {
		if count == maxRunes {
			return strings.TrimRight(text[:index], " \t\r\n") + "...", true
		}
		count++
	}
	return text, false
}
