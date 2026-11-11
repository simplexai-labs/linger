package integration_test

import (
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicelive"
)

// The browser page a live call saw last is read by the next call, which is
// already claimed with no output when it asks.
func TestLatestVoiceLiveToolOutputLeavesOutTheAskingCall(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _, _, sessionID := newVoiceLiveRoom(t)
	queries := store.New(env.pool)
	claim := func(callID string) {
		claimed, err := queries.ClaimVoiceLiveToolCall(t.Context(), store.ClaimVoiceLiveToolCallParams{
			VoiceSessionID: sessionID, CallID: callID, TurnID: "lt_browser",
			Name: voicelive.ToolComputerBrowser, Arguments: `{"action":"look"}`, RequestHash: callID,
		})
		if err != nil || claimed != 1 {
			t.Fatalf("claim %s: rows=%d err=%v", callID, claimed, err)
		}
	}
	claim("call-a")
	if err := queries.CompleteVoiceLiveToolCall(t.Context(), store.CompleteVoiceLiveToolCallParams{
		VoiceSessionID: sessionID, CallID: "call-a", State: "completed",
		Output: `{"page":"### Page\n- Page URL: https://a.test/"}`,
	}); err != nil {
		t.Fatal(err)
	}
	claim("call-b")
	output, err := queries.GetLatestVoiceLiveToolOutput(t.Context(), store.GetLatestVoiceLiveToolOutputParams{
		VoiceSessionID: sessionID, Name: voicelive.ToolComputerBrowser, CallID: "call-b",
	})
	if err != nil || !strings.Contains(output, "https://a.test/") {
		t.Fatalf("output=%q err=%v", output, err)
	}
}
