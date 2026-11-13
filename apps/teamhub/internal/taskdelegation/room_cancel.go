package taskdelegation

import (
	"context"
	"errors"
	"slices"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/taskexecution"
)

// Statuses CancelFromRoom reports.
const (
	RoomTaskCanceled   = "canceled"
	RoomTaskNotRunning = "not_running"
)

// CancelFromRoom lets a Human member of a Room cancel one of the Tasks
// running for it. The Task is stopped as its Meta's task stop does, so it
// stays resumable. A Task its Meta delegated tells the Meta who canceled it;
// a task a Live call started is canceled as Live's own cancel does, since
// its callback stream carries its reports and it has no Meta. A Task that is
// not running for this Room is left alone and reported not_running.
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
	index := slices.IndexFunc(running, func(row store.ListRoomRunningTasksRow) bool { return row.ID == taskID })
	if index < 0 {
		return RoomTaskNotRunning, nil
	}
	revision, err := StopTask(ctx, tx, queries, room.TenantID, taskID, human.ID)
	if err != nil {
		return "", mapTaskExecutionError(err)
	}
	if running[index].Live {
		if _, err := queries.CancelVoiceLiveTask(ctx, taskID); err != nil {
			return "", err
		}
	} else if revision > 0 {
		if err := taskexecution.NotifyMetaOfHumanCancel(ctx, queries, taskID, human); err != nil {
			return "", mapTaskExecutionError(err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return RoomTaskCanceled, nil
}
