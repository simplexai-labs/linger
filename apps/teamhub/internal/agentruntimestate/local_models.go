package agentruntimestate

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// maxLocalModelsSnapshotBytes bounds one stored snapshot. The contract caps a
// snapshot at 256 models and 65 pools, which stays far below it.
const maxLocalModelsSnapshotBytes = 4 << 20

// RecordLocalModelsInput is the latest model library a Computer reported.
// Snapshot is the JSON object the Agent Service forwarded and Host its host
// object, empty when the snapshot carries none.
type RecordLocalModelsInput struct {
	ComputerID string
	Snapshot   json.RawMessage
	Host       json.RawMessage
	ObservedAt time.Time
}

// LocalModelUser is an active Agent on runtime pi placed on the Computer.
type LocalModelUser struct {
	AgentID      string
	Name         string
	RuntimeModel string
}

// LocalModelsRecord is what TeamHub keeps about a Computer's model library:
// the Computer row, its latest snapshot (nil when it never sent one), the
// last host a snapshot carried, and the Agents on runtime pi the viewer may
// see.
type LocalModelsRecord struct {
	ComputerID  string
	DisplayName string
	Owner       LocalComputerOwner
	Status      string
	LastSeenAt  *time.Time
	Snapshot    json.RawMessage
	Host        json.RawMessage
	Users       []LocalModelUser
}

// RecordLocalModels replaces a Computer's stored model library and tells the
// owner's Tenant to refetch it. Ordering is the Agent Service's job: it
// forwards one Computer's snapshots one at a time, newest last.
func (s *Service) RecordLocalModels(ctx context.Context, input RecordLocalModelsInput) error {
	if !validComputerID(input.ComputerID) || input.ObservedAt.IsZero() ||
		!jsonObject(input.Snapshot) || (len(input.Host) > 0 && !jsonObject(input.Host)) {
		return ErrInvalid
	}
	_, err := executeLocalComputerTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (struct{}, *LocalComputerOwner, error) {
		computer, err := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if isNoRows(err) || (err == nil && computer.Status == "removed") {
			return struct{}{}, nil, ErrNotFound
		}
		if err != nil {
			return struct{}{}, nil, err
		}
		if err := queries.UpsertLocalComputerModelSnapshot(ctx, store.UpsertLocalComputerModelSnapshotParams{
			ComputerID: input.ComputerID, Snapshot: input.Snapshot, Host: input.Host, ObservedAt: timestamptz(input.ObservedAt),
		}); err != nil {
			return struct{}{}, nil, err
		}
		return struct{}{}, nil, realtime.Invalidate(ctx, queries, realtime.Invalidation{
			TenantID: computer.OwnerTenantID, Resource: realtime.InvalidateLocalModels, ID: input.ComputerID,
		})
	})
	return err
}

// LocalModels reads a Computer's stored model library for a member of the
// Computer's Tenant. A Computer of another Tenant, or a removed one, is
// ErrNotFound.
func (s *Service) LocalModels(ctx context.Context, tenantID, viewerActorID, computerID string) (LocalModelsRecord, error) {
	if s == nil || s.pool == nil || !validComputerID(computerID) || tenantID == "" || viewerActorID == "" {
		return LocalModelsRecord{}, ErrInvalid
	}
	queries := store.New(s.pool)
	computer, err := queries.GetAgentRuntimeLocalComputer(ctx, computerID)
	if isNoRows(err) || (err == nil && (computer.Status == "removed" || computer.OwnerTenantID != tenantID)) {
		return LocalModelsRecord{}, ErrNotFound
	}
	if err != nil {
		return LocalModelsRecord{}, err
	}
	record := LocalModelsRecord{
		ComputerID: computer.ComputerID, DisplayName: computer.DisplayName, Status: computer.Status,
		Owner: LocalComputerOwner{TenantID: computer.OwnerTenantID, OwnerActorID: computer.OwnerActorID},
	}
	if computer.LastSeenAt.Valid {
		lastSeenAt := computer.LastSeenAt.Time.UTC()
		record.LastSeenAt = &lastSeenAt
	}
	snapshot, err := queries.GetLocalComputerModelSnapshot(ctx, computerID)
	if err != nil && !isNoRows(err) {
		return LocalModelsRecord{}, err
	}
	if err == nil {
		record.Snapshot, record.Host = snapshot.Snapshot, snapshot.Host
	}
	users, err := queries.ListLocalModelUsersOnComputer(ctx, store.ListLocalModelUsersOnComputerParams{
		TenantID: tenantID, ComputerID: computerID, ViewerActorID: viewerActorID,
	})
	if err != nil {
		return LocalModelsRecord{}, err
	}
	record.Users = make([]LocalModelUser, len(users))
	for index, user := range users {
		record.Users[index] = LocalModelUser{AgentID: user.AgentID, Name: user.DisplayName, RuntimeModel: user.RuntimeModel}
	}
	return record, nil
}

func jsonObject(value json.RawMessage) bool {
	return len(value) > 0 && len(value) <= maxLocalModelsSnapshotBytes && value[0] == '{' && json.Valid(value)
}
