package app

import (
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentregistry"
)

// Saving or removing a Composio key, or connecting an app, changes the
// effective resources digest, so the Agent Service rebuilds the next Run's
// instructions; with a key and no app account the digest is the Skill digest.
func TestEffectiveResourcesDigestFollowsConnectedApps(t *testing.T) {
	skills := "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if got := agentregistry.EffectiveResourcesDigest(skills, true, nil); got != skills {
		t.Fatalf("digest with connected apps = %s, want the Skill digest", got)
	}
	without := agentregistry.EffectiveResourcesDigest(skills, false, nil)
	if without == skills || len(without) != 64 {
		t.Fatalf("digest without connected apps = %s", without)
	}
	if again := agentregistry.EffectiveResourcesDigest(skills, false, nil); again != without {
		t.Fatal("digest is not deterministic")
	}
	gmail := agentregistry.EffectiveResourcesDigest(skills, true, []string{"gmail"})
	if gmail == skills || gmail == without || len(gmail) != 64 {
		t.Fatalf("digest with a Gmail account = %s", gmail)
	}
	if calendar := agentregistry.EffectiveResourcesDigest(skills, true, []string{"gmail", "google_calendar"}); calendar == gmail {
		t.Fatal("connecting another app keeps the digest")
	}
	if (&App{}).connectionProvidersConfigured() {
		t.Fatal("an App without external sources has no connected apps")
	}
}
