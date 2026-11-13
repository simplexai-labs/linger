package taskdelegation

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/jobs"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/typedcard"
)

// Statuses CancelFromRoom reports.
const (
	RoomTaskCanceled   = "canceled"
	RoomTaskNotRunning = "not_running"
)

// CancelFromRoom lets a Human member of a Room cancel one of the Tasks
// running for it. The Task is stopped as its Meta's task stop does, so it
// stays resumable, and the Meta is told who canceled it. A Task that is no
// longer running is left alone and reported not_running.
func (s *Service) CancelFromRoom(ctx context.Context, accountID, roomID, taskID string) (string, error) {
	if s == nil || s.pool == nil {
		return "", ErrUnavailable
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	queries := store.New(tx)
	account := pgtype.Text{String: accountID, Valid: accountID != ""}
	room, err := queries.GetRoomForAccount(ctx, store.GetRoomForAccountParams{ID: roomID, AccountID: account})
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	human, err := queries.GetHumanActor(ctx, store.GetHumanActorParams{TenantID: room.TenantID, AccountID: account})
	if err != nil {
		return "", err
	}
	running, err := queries.ListRoomRunningTasks(ctx, store.ListRoomRunningTasksParams{RoomID: roomID, TenantID: room.TenantID})
	if err != nil {
		return "", err
	}
	if !slices.ContainsFunc(running, func(row store.ListRoomRunningTasksRow) bool { return row.ID == taskID }) {
		return RoomTaskNotRunning, nil
	}
	if _, err := taskexecution.CancelTaskByHuman(ctx, queries, taskID, human); err != nil {
		return "", mapTaskExecutionError(err)
	}
	// Canceling expires the cards the AlterEgo was waiting on.
	if err := jobs.InsertTx(ctx, tx, typedcard.StoppedTaskApprovalsArgs{TenantID: room.TenantID, TaskID: taskID}, nil); err != nil {
		return "", err
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return RoomTaskCanceled, nil
}
