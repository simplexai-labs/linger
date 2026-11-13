package taskexecution

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// Conversation is what a Task's Agent was told and the cards its AlterEgo
// raised, for a person who can read the Task.
type Conversation struct {
	TenantID string
	Inputs   []store.ListTaskConversationInputsRow
	Cards    []store.ListTaskConversationCardsRow
}

// GetConversationForHuman reads a Task's conversation for an Account that can
// read the Task.
func (s *Service) GetConversationForHuman(ctx context.Context, accountID, taskID string) (Conversation, error) {
	if strings.TrimSpace(accountID) == "" || strings.TrimSpace(taskID) == "" {
		return Conversation{}, ErrInvalid
	}
	tx, err := s.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return Conversation{}, err
	}
	defer tx.Rollback(ctx)
	queries := store.New(tx)
	item, err := queries.GetWorkItemForHuman(ctx, store.GetWorkItemForHumanParams{ID: taskID, AccountID: accountID})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (item.Kind != "task" || !item.TaskExecutionGeneration.Valid)) {
		return Conversation{}, ErrNotFound
	}
	if err != nil {
		return Conversation{}, err
	}
	inputs, err := queries.ListTaskConversationInputs(ctx, taskID)
	if err != nil {
		return Conversation{}, err
	}
	cards, err := queries.ListTaskConversationCards(ctx, store.ListTaskConversationCardsParams{
		TenantID: item.TenantID, TaskID: taskID,
	})
	if err != nil {
		return Conversation{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Conversation{}, err
	}
	return Conversation{TenantID: item.TenantID, Inputs: inputs, Cards: cards}, nil
}
