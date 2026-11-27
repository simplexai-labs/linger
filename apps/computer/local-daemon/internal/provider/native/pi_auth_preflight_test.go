package native

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPiModelAuthPreflightBlocksMissingCredentials(t *testing.T) {
	t.Run("not_ready", func(t *testing.T) {
		commands := t.TempDir() + "/auth-check"
		h := piNewHarness(t, "finish", map[string]string{
			piFakeAuthEnv:   commands,
			piFakeStatusEnv: "not_ready",
		})

		run, authErr := h.runtime.Start(t.Context(), "go", RunSpec{Model: "anthropic/fixture", Dir: h.dir})
		if !errors.Is(authErr, ErrPiModelAuthenticationRequired) {
			t.Fatalf("start error = %v, want ErrPiModelAuthenticationRequired", authErr)
		}
		if run != nil {
			t.Fatal("blocked start returned a run")
		}
		argv, err := os.ReadFile(commands)
		if err != nil {
			t.Fatal(err)
		}
		if got, want := string(argv), "auth\ncheck\n--model\nanthropic/fixture\n--json"; got != want {
			t.Fatalf("auth argv = %q, want %q", got, want)
		}
		if !strings.Contains(fmt.Sprint(authErr), "run pi /login") {
			t.Fatalf("error %v omits the recovery hint", authErr)
		}
	})
}

func TestPiModelAuthPreflightReadyStarts(t *testing.T) {
	commands := t.TempDir() + "/auth-check"
	h := piNewHarness(t, "finish", map[string]string{
		piFakeAuthEnv:              commands,
		piFakeStatusEnv:            "ready",
		"PI_AUTH_PREFLIGHT_MARKER": "child",
	})

	run := h.start(t.Context(), "go", RunSpec{Model: "deepseek/fixture"})
	events, outcome := piCollect(t, run)
	if outcome.Status != statusCompleted || outcome.Output != "done" {
		t.Fatalf("outcome = %+v", outcome)
	}
	argv, err := os.ReadFile(commands)
	if err != nil {
		t.Fatal(err)
	}
	if got := string(argv); !strings.Contains(got, "deepseek/fixture") {
		t.Fatalf("auth argv = %q, want the selected model", got)
	}
	marker, err := os.ReadFile(commands + ".child_env")
	if err != nil {
		t.Fatal(err)
	}
	if string(marker) != "child" {
		t.Fatalf("auth child marker = %q, want the profile environment", marker)
	}
	var text Event
	for _, candidate := range events {
		if candidate.Kind == EventText {
			text = candidate
			break
		}
	}
	if text.Body != "done" {
		t.Fatalf("text events = %+v", events)
	}
}

func TestPiModelAuthPreflightSkipsDefaultAndEmptyModels(t *testing.T) {
	commands := t.TempDir() + "/auth-check"
	h := piNewHarness(t, "finish", map[string]string{
		piFakeAuthEnv:   commands,
		piFakeStatusEnv: "not-json",
	})

	for _, model := range []string{piDefaultModel, ""} {
		if _, outcome := piCollect(t, h.start(t.Context(), "go", RunSpec{Model: model})); outcome.Status != statusCompleted {
			t.Fatalf("model %q outcome = %+v", model, outcome)
		}
	}
	if _, err := os.Stat(commands); !os.IsNotExist(err) {
		t.Fatalf("default or empty model ran an auth check: %v", err)
	}
}

// An inconclusive check never blocks: `invalid` is Pi's own bad-state verdict
// (exit 2), a non-JSON answer is a probe failure, and `provider_not_found`
// means Pi cannot resolve the provider so the Run must surface the real error.
func TestPiModelAuthPreflightInconclusiveStillStarts(t *testing.T) {
	for _, status := range []string{"invalid", "not-json", "provider_not_found"} {
		t.Run(status, func(t *testing.T) {
			h := piNewHarness(t, "finish", map[string]string{
				piFakeStatusEnv: status,
			})

			run := h.start(t.Context(), "go", RunSpec{Model: "anthropic/fixture"})
			if _, outcome := piCollect(t, run); outcome.Status != statusCompleted {
				t.Fatalf("outcome = %+v", outcome)
			}
		})
	}
}

// A caller that cancels the Operation must get the cancellation back, never
// an advisory pass that would launch Pi on a dead Operation.
func TestPiModelAuthPreflightCallerCancelStops(t *testing.T) {
	h := piNewHarness(t, "sleep", nil)
	ctx, cancel := context.WithCancel(t.Context())
	// Cancel while the probe is still hanging, before its own budget expires.
	time.AfterFunc(20*time.Millisecond, cancel)

	run, err := h.runtime.Start(ctx, "go", RunSpec{Model: "anthropic/fixture", Dir: h.dir})
	if !errors.Is(err, context.Canceled) || run != nil {
		t.Fatalf("start = %+v, %v, want context.Canceled and no run", run, err)
	}
}

// The probe's own budget expiring is advisory: the caller is still live, so
// the Run must start and complete normally.
func TestPiModelAuthPreflightTimeoutStillStarts(t *testing.T) {
	previous := piAuthCheckTimeout
	piAuthCheckTimeout = 50 * time.Millisecond
	t.Cleanup(func() { piAuthCheckTimeout = previous })

	h := piNewHarness(t, "finish", map[string]string{"PI_FAKE_AUTH_HANG": "1"})
	run, err := h.runtime.Start(t.Context(), "go", RunSpec{Model: "anthropic/fixture", Dir: h.dir})
	if err != nil || run == nil {
		t.Fatalf("start = %+v, %v, want a run after an inconclusive auth check", run, err)
	}
	if errors.Is(err, ErrPiModelAuthenticationRequired) {
		t.Fatal("inconclusive auth check blocked the run")
	}
	if _, outcome := piCollect(t, run); outcome.Status != statusCompleted {
		t.Fatalf("outcome = %+v", outcome)
	}
}
