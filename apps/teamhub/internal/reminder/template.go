package reminder

import (
	"context"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

// PauseTemplateRoutinesInTx stops copies as soon as Agent deletion is reserved,
// including copies authored by a Human and copies with no mention.
// Update paused copies too: their revision fences concurrent enable requests
// that read the registration's old active state before deletion commits.
func PauseTemplateRoutinesInTx(ctx context.Context, queries *store.Queries, agentID, humanID string) error {
	records, err := queries.PauseAgentTemplateOriginRoutines(ctx, optionalText(&agentID))
	if err != nil {
		return err
	}
	for _, record := range records {
		authority := Authority{TenantID: record.TenantID, RoomID: record.RoomID, ActorID: humanID}
		if _, err := appendChanged(ctx, queries, authority, record.ID, "updated", record.Revision); err != nil {
			return err
		}
	}
	return nil
}
