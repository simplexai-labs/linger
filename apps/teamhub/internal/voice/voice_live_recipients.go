package voice

import (
	"context"
	"strings"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
)

// checkVoiceLiveRecipients holds a canvas write whose to or cc has an address
// the user never used that resembles one they did, and returns what the live
// model asks the user instead. The write goes ahead once the model writes the
// suggested address, or keeps its own with confirmed once the user stood by
// it. confirmed needs no recorded question: the model may have suggested the
// known address on its own, and the send asks the user again regardless. An
// empty output lets the write go ahead.
func (s *Service) checkVoiceLiveRecipients(ctx context.Context, session voicelive.Session, to, cc string, confirmed bool) (string, error) {
	if confirmed || strings.TrimSpace(to+cc) == "" {
		return "", nil
	}
	rows, err := s.queries.ListVoiceLiveKnownAddresses(ctx, store.ListVoiceLiveKnownAddressesParams{ActorID: session.HumanActorID, TenantID: session.TenantID})
	if err != nil {
		return "", err
	}
	own, recent := voiceLiveKnownAddresses(rows)
	suggestions := voicelive.SuggestRecipients(to, cc, append(own, recent...))
	if len(suggestions) == 0 {
		return "", nil
	}
	return voicelive.Output(map[string]any{
		"status": "needs_confirmation", "reason": "check_recipient", "suggestions": suggestions,
		"next": "Nothing was written yet: each heard address resembles a suggested one the user has used before, so it may be misheard. " +
			"Ask the user once, in your own words, whether they meant the suggested address, saying it, and end your turn. " +
			"If they say yes, call again with the suggested address in place of the heard one. If they say the heard address is right, call again unchanged with confirmed=true. If they give another address, call again with that one.",
	}), nil
}
