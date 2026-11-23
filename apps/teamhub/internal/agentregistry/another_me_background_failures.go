package agentregistry

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// AnotherMeBackgroundFailureThreshold is how many background model calls in
// a row must fail before the Human's Another Me shows it.
const AnotherMeBackgroundFailureThreshold = 3

// RecordAnotherMeBackgroundCall counts a failed background model call of an
// Another Me, or clears the count after a completed one. Browsers are told to
// refetch the Another Me only when the banner it shows appears, changes its
// reason, or goes; a higher count alone waits for the next fetch, so a run of
// failures does not refetch the whole Tenant each time. A call for an Agent
// that is not an active Another Me changes nothing.
func (s *Service) RecordAnotherMeBackgroundCall(ctx context.Context, tenantID, agentActorID string, failed bool, reason string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	queries := s.queries.WithTx(tx)
	var changed bool
	if failed {
		reason = anotherMeBackgroundFailureReason(reason)
		var row store.RecordAnotherMeBackgroundFailureRow
		row, err = queries.RecordAnotherMeBackgroundFailure(ctx, store.RecordAnotherMeBackgroundFailureParams{
			AgentActorID: agentActorID, TenantID: tenantID, Reason: reason,
		})
		changed = row.ConsecutiveFailures == AnotherMeBackgroundFailureThreshold ||
			(row.ConsecutiveFailures > AnotherMeBackgroundFailureThreshold && row.PreviousReason != reason)
	} else {
		var count int32
		count, err = queries.ClearAnotherMeBackgroundFailures(ctx, store.ClearAnotherMeBackgroundFailuresParams{
			AgentActorID: agentActorID, TenantID: tenantID,
		})
		changed = count >= AnotherMeBackgroundFailureThreshold
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if changed {
		if err := createTenantAnotherMeDeliveries(ctx, queries, tenantID); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// anotherMeBackgroundFailureReason keeps a reason code clients know and
// records any other, including one from a newer Agent Service, as unknown.
func anotherMeBackgroundFailureReason(reason string) string {
	code := httpapi.AnotherMeBackgroundFailureReason(reason)
	if !code.Valid() {
		return string(httpapi.AnotherMeBackgroundFailureReasonUnknown)
	}
	return reason
}

// anotherMeBackgroundFailure is what the Human's Another Me shows about its
// failed background model calls: nothing below the threshold.
func anotherMeBackgroundFailure(ctx context.Context, queries *store.Queries, tenantID, agentActorID string) (*httpapi.AnotherMeBackgroundFailure, error) {
	row, err := queries.GetAnotherMeBackgroundFailure(ctx, store.GetAnotherMeBackgroundFailureParams{
		AgentActorID: agentActorID, TenantID: tenantID,
	})
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && row.ConsecutiveFailures < AnotherMeBackgroundFailureThreshold) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &httpapi.AnotherMeBackgroundFailure{
		ConsecutiveFailures: int(row.ConsecutiveFailures),
		Reason:              httpapi.AnotherMeBackgroundFailureReason(anotherMeBackgroundFailureReason(row.Reason)),
	}, nil
}
