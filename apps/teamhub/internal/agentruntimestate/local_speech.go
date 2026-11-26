package agentruntimestate

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// RecordLocalSpeechInput is the latest local speech snapshot a Computer reported.
type RecordLocalSpeechInput struct {
	ComputerID string
	Snapshot   json.RawMessage
	ObservedAt time.Time
}

// LocalSpeechRecord is what TeamHub keeps about a Computer's local speech status:
// the Computer row, its latest speech snapshot (nil when it never sent one), and
// the last host recorded by local-models if present.
type LocalSpeechRecord struct {
	ComputerID  string
	DisplayName string
	Owner       LocalComputerOwner
	Status      string
	LastSeenAt  *time.Time
	Snapshot    json.RawMessage
	Host        json.RawMessage
}

// RecordLocalSpeech replaces a Computer's stored local speech snapshot and tells
// the owner's Tenant to refetch it. It returns true when the snapshot moved the
// Computer's stored local speech availability from absent or false to true.
func (s *Service) RecordLocalSpeech(ctx context.Context, input RecordLocalSpeechInput) (bool, error) {
	if !validComputerID(input.ComputerID) || input.ObservedAt.IsZero() || !jsonObject(input.Snapshot) {
		return false, ErrInvalid
	}
	return executeLocalComputerTx(ctx, s, func(ctx context.Context, _ pgx.Tx, queries *store.Queries) (bool, *LocalComputerOwner, error) {
		computer, err := queries.LockAgentRuntimeLocalComputer(ctx, input.ComputerID)
		if isNoRows(err) || (err == nil && computer.Status == "removed") {
			return false, nil, ErrNotFound
		}
		if err != nil {
			return false, nil, err
		}
		previousSnapshot, err := queries.GetLocalComputerSpeechSnapshot(ctx, input.ComputerID)
		if err != nil && !isNoRows(err) {
			return false, nil, err
		}
		if err := queries.UpsertLocalComputerSpeechSnapshot(ctx, store.UpsertLocalComputerSpeechSnapshotParams{
			ComputerID: input.ComputerID, Snapshot: input.Snapshot, ObservedAt: timestamptz(input.ObservedAt),
		}); err != nil {
			return false, nil, err
		}
		if err := realtime.Invalidate(ctx, queries, realtime.Invalidation{
			TenantID: computer.OwnerTenantID, Resource: realtime.InvalidateLocalSpeech, ID: input.ComputerID,
		}); err != nil {
			return false, nil, err
		}
		return speechBecameAvailable(previousSnapshot, input.Snapshot), nil, nil
	})
}

func speechSnapshotAvailable(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var doc struct {
		Available bool `json:"available"`
	}
	return json.Unmarshal(raw, &doc) == nil && doc.Available
}

func speechBecameAvailable(previous, next json.RawMessage) bool {
	return !speechSnapshotAvailable(previous) && speechSnapshotAvailable(next)
}

// LocalSpeech reads a Computer's stored local speech status for a member of the
// Computer's Tenant. A Computer of another Tenant, or a removed one, is
// ErrNotFound.
func (s *Service) LocalSpeech(ctx context.Context, tenantID, viewerActorID, computerID string) (LocalSpeechRecord, error) {
	if s == nil || s.pool == nil || !validComputerID(computerID) || tenantID == "" || viewerActorID == "" {
		return LocalSpeechRecord{}, ErrInvalid
	}
	queries := store.New(s.pool)
	computer, err := queries.GetAgentRuntimeLocalComputer(ctx, computerID)
	if isNoRows(err) || (err == nil && (computer.Status == "removed" || computer.OwnerTenantID != tenantID)) {
		return LocalSpeechRecord{}, ErrNotFound
	}
	if err != nil {
		return LocalSpeechRecord{}, err
	}
	record := LocalSpeechRecord{
		ComputerID: computer.ComputerID, DisplayName: computer.DisplayName, Status: computer.Status,
		Owner: LocalComputerOwner{TenantID: computer.OwnerTenantID, OwnerActorID: computer.OwnerActorID},
	}
	if computer.LastSeenAt.Valid {
		lastSeenAt := computer.LastSeenAt.Time.UTC()
		record.LastSeenAt = &lastSeenAt
	}
	speechSnapshot, err := queries.GetLocalComputerSpeechSnapshot(ctx, computerID)
	if err != nil && !isNoRows(err) {
		return LocalSpeechRecord{}, err
	}
	if err == nil {
		record.Snapshot = speechSnapshot
	}
	if modelSnapshot, err := queries.GetLocalComputerModelSnapshot(ctx, computerID); err == nil {
		record.Host = modelSnapshot.Host
	} else if !isNoRows(err) {
		return LocalSpeechRecord{}, err
	}
	return record, nil
}
