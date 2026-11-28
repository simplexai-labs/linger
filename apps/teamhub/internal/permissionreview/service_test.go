package permissionreview

import (
	"context"
	"strings"
	"testing"
)

// Without a judge model the review is off, so deploying it changes nothing
// until a model is configured.
func TestReviewWithoutAJudgeAllowsEveryCall(t *testing.T) {
	t.Parallel()
	outcome, err := (&Service{}).Review(context.Background(), ReviewInput{Action: Action{Tool: "Bash", Command: "git push"}})
	if err != nil || outcome.Decision != DecisionAllow {
		t.Fatalf("outcome=%+v err=%v", outcome, err)
	}
}

func TestActionDigestIgnoresJSONLayoutButNotContent(t *testing.T) {
	t.Parallel()
	base := Action{Surface: "browser", Tool: "mcp__browser__browser_click", Input: `{"ref":"e42","element":"Send"}`}
	reordered := base
	reordered.Input = `{ "element": "Send", "ref": "e42" }`
	if ActionDigest(base, Evidence{}) != ActionDigest(reordered, Evidence{}) {
		t.Fatal("key order and spacing must not change the digest")
	}
	otherTarget := base
	otherTarget.Input = `{"ref":"e43","element":"Send"}`
	if ActionDigest(base, Evidence{}) == ActionDigest(otherTarget, Evidence{}) {
		t.Fatal("a different target must be a different action")
	}

	shell := Action{Surface: "shell", Tool: "Bash", Command: "python scripts/notify.py"}
	before := ActionDigest(shell, Evidence{Script: &ScriptEvidence{Path: "scripts/notify.py", Body: "print('preview')"}})
	after := ActionDigest(shell, Evidence{Script: &ScriptEvidence{Path: "scripts/notify.py", Body: "send_all()"}})
	if before == after {
		t.Fatal("an approval must not carry over to a changed script")
	}
	if ActionDigest(shell, Evidence{Patch: "a"}) == ActionDigest(shell, Evidence{Patch: "b"}) {
		t.Fatal("an approval must not carry over to a changed patch")
	}
	if !strings.HasPrefix(before, "sha256:") || len(before) != len("sha256:")+64 {
		t.Fatalf("digest %q does not match the stored format", before)
	}
}

func TestComputerActionDigestBindsComputerAndBundleID(t *testing.T) {
	t.Parallel()
	action := Action{Surface: "computer", Tool: "mcp__computer__click", Input: `{"pid":42}`}
	safari := Evidence{Desktop: &DesktopEvidence{BundleID: "com.apple.Safari"}}
	safariLower := Evidence{Desktop: &DesktopEvidence{BundleID: "com.apple.safari"}}
	terminal := Evidence{Desktop: &DesktopEvidence{BundleID: "com.apple.Terminal"}}

	d1 := ComputerActionDigest(action, safari, "comp-1")
	if d1 != ComputerActionDigest(action, safariLower, "comp-1") {
		t.Fatal("ComputerActionDigest must normalize bundle_id casing")
	}
	if d1 == ComputerActionDigest(action, terminal, "comp-1") {
		t.Fatal("different bundle_id for the same pid must produce a different digest")
	}
	if d1 == ComputerActionDigest(action, safari, "comp-2") {
		t.Fatal("different computer_id must produce a different digest")
	}
}

func TestReviewDeniesUnresolvedDarwinComputerActionWithoutJudge(t *testing.T) {
	t.Parallel()
	outcome, err := (&Service{}).Review(context.Background(), ReviewInput{
		Environment: Environment{Platform: "darwin"},
		Action:      Action{Surface: "computer", Tool: "mcp__computer__get_window_state", Input: `{"pid":999}`},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if outcome.Decision != DecisionDeny || !strings.Contains(outcome.Message, "COMPUTER_TARGET_REQUIRED") {
		t.Fatalf("outcome = %+v, want DecisionDeny with COMPUTER_TARGET_REQUIRED", outcome)
	}
}
