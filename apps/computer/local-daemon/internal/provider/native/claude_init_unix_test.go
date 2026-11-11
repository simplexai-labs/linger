//go:build !windows

package native

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"
)

type claudeTimedEvent struct {
	Event
	at time.Time
}

// claudeTimed drains run, stamping each event and the Outcome with their
// arrival time. steer, when set, runs once on the turn-started event.
func claudeTimed(t *testing.T, run *Run, steer func(Event)) ([]claudeTimedEvent, Outcome, time.Time) {
	t.Helper()
	deadline := time.After(15 * time.Second)
	var events []claudeTimedEvent
	for {
		select {
		case event, ok := <-run.Events:
			if !ok {
				outcome := <-run.Outcome
				return events, outcome, time.Now()
			}
			events = append(events, claudeTimedEvent{event, time.Now()})
			if steer != nil && event.TurnID != "" {
				go steer(event)
				steer = nil
			}
		case <-deadline:
			t.Fatal("Run did not finish")
		}
	}
}

func claudeStartedEvents(events []claudeTimedEvent) []claudeTimedEvent {
	var started []claudeTimedEvent
	for _, event := range events {
		if event.Kind == EventStatus && event.TurnID != "" {
			started = append(started, event)
		}
	}
	return started
}

func claudeInitHome(t *testing.T, mode string, residency int) *claudeResidentHome {
	t.Helper()
	claudeEnableResidency(t, residency)
	return claudeNewResidentHome(t, map[string]string{"CLAUDE_FAKE_INIT_MODE": mode})
}

func claudeTurnAt(t *testing.T, home *claudeResidentHome, prompt string, spec RunSpec, steer func(Event)) ([]claudeTimedEvent, Outcome, time.Time, time.Time) {
	t.Helper()
	spec.ExposeTurnStarted = true
	submitted := time.Now()
	events, outcome, done := claudeTimed(t, claudeStart(t, home.profile, prompt, spec), steer)
	return events, outcome, submitted, done
}

// claudeCheckEarlyStart checks that the one turn start arrived well before
// the slow output.
func claudeCheckEarlyStart(t *testing.T, events []claudeTimedEvent, submitted, done time.Time, reused bool) {
	t.Helper()
	started := claudeStartedEvents(events)
	if len(started) != 1 {
		t.Fatalf("turn starts = %d", len(started))
	}
	s := started[0]
	if done.Sub(s.at) < 700*time.Millisecond || s.SentAt.IsZero() || s.SentAt.Before(submitted) || s.SentAt.After(s.at) {
		t.Fatalf("turn start at %v sent %v (submitted %v, done %v)", s.at, s.SentAt, submitted, done)
	}
	if s.SessionID != claudeTestSession || s.ProcessReused == nil || *s.ProcessReused != reused {
		t.Fatalf("turn start = %+v", s.Event)
	}
	text := slices.IndexFunc(events, func(e claudeTimedEvent) bool { return e.Kind == EventText })
	first := slices.IndexFunc(events, func(e claudeTimedEvent) bool { return e.TurnID != "" })
	if text < 0 || text < first {
		t.Fatalf("text event index %d, turn start %d", text, first)
	}
}

func TestClaudeTurnStartsAtInitBeforeSlowOutput(t *testing.T) {
	for name, spec := range map[string]RunSpec{
		"create": {AssignSessionID: claudeTestSession},
		"resume": {ResumeID: claudeTestSession, ResumeRequired: true},
	} {
		t.Run(name, func(t *testing.T) {
			home := claudeInitHome(t, "turn", 0)
			events, outcome, submitted, done := claudeTurnAt(t, home, "slow assist", spec, nil)
			claudeMustComplete(t, outcome)
			claudeCheckEarlyStart(t, events, submitted, done, false)
		})
	}
}

func TestClaudeReusedTurnStartsAtInit(t *testing.T) {
	home := claudeInitHome(t, "turn", DefaultResidentCap)
	_, outcome, _, _ := claudeTurnAt(t, home, "hello", RunSpec{}, nil)
	claudeMustComplete(t, outcome)
	events, outcome, submitted, done := claudeTurnAt(t, home, "slow assist", RunSpec{ResumeID: claudeTestSession}, nil)
	claudeMustComplete(t, outcome)
	claudeCheckEarlyStart(t, events, submitted, done, true)
	if len(home.pids(t)) != 1 {
		t.Fatalf("pids = %v", home.pids(t))
	}
}

func TestClaudeTurnStartWaitsForEchoWithoutTurnInit(t *testing.T) {
	for _, mode := range []string{"early", ""} {
		t.Run("mode="+mode, func(t *testing.T) {
			home := claudeInitHome(t, mode, 0)
			events, outcome, submitted, _ := claudeTurnAt(t, home, "slow", RunSpec{}, nil)
			claudeMustComplete(t, outcome)
			started := claudeStartedEvents(events)
			if len(started) != 1 || started[0].at.Sub(submitted) < 900*time.Millisecond {
				t.Fatalf("turn starts = %+v submitted %v", started, submitted)
			}
		})
	}
}

func TestClaudeSteerRidesTheToolResult(t *testing.T) {
	home := claudeInitHome(t, "turn", 0)
	type result struct {
		ack    SteerAck
		err    error
		turnID string
	}
	results := make(chan result, 1)
	run := claudeStart(t, home.profile, "tool", RunSpec{ExposeTurnStarted: true})
	events, outcome, _ := claudeTimed(t, run, func(started Event) {
		ack, err := run.Steer(t.Context(), SteerRequest{ExpectedTurnID: started.TurnID, Input: "go"})
		results <- result{ack, err, started.TurnID}
	})
	r := <-results
	if r.err != nil || r.ack.TurnID != r.turnID {
		t.Fatalf("steer = %+v", r)
	}
	if outcome.Status != statusCompleted || outcome.Output != "done 1" || len(claudeStartedEvents(events)) != 1 {
		t.Fatalf("outcome = %+v starts = %d", outcome, len(claudeStartedEvents(events)))
	}
	hooks := home.lines("hooks", "")
	if len(hooks) != 1 || !strings.Contains(hooks[0], `"additionalContext"`) || !strings.Contains(hooks[0], `go"`) {
		t.Fatalf("hooks = %q", hooks)
	}
	if inputs := home.lines("events", "user "); len(inputs) != 1 {
		t.Fatalf("inputs = %q", inputs)
	}
}

func claudeNotAppliedError(t *testing.T, err error) {
	t.Helper()
	var steerErr *SteerError
	if !errors.As(err, &steerErr) || steerErr.Effect != "definitely_not_applied" || steerErr.Reason != "no_active_turn" {
		t.Fatalf("steer error = %v", err)
	}
}

func TestClaudeSteerRejectedWhenTurnEndsBeforeEcho(t *testing.T) {
	home := claudeInitHome(t, "turn", 0)
	errs := make(chan error, 1)
	run := claudeStart(t, home.profile, "slow noecho", RunSpec{ExposeTurnStarted: true})
	claudeTimed(t, run, func(started Event) {
		ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
		defer cancel()
		_, err := run.Steer(ctx, SteerRequest{ExpectedTurnID: started.TurnID, Input: "go"})
		if ctx.Err() != nil {
			err = errors.New("steer waited for its own deadline")
		}
		errs <- err
	})
	claudeNotAppliedError(t, <-errs)
}

func TestClaudeSteerCancelledWhileWaiting(t *testing.T) {
	home := claudeInitHome(t, "turn", 0)
	type result struct {
		err     error
		elapsed time.Duration
	}
	results := make(chan result, 1)
	run := claudeStart(t, home.profile, "slow", RunSpec{ExposeTurnStarted: true})
	_, outcome, _ := claudeTimed(t, run, func(started Event) {
		ctx, cancel := context.WithTimeout(t.Context(), 200*time.Millisecond)
		defer cancel()
		begin := time.Now()
		_, err := run.Steer(ctx, SteerRequest{ExpectedTurnID: started.TurnID, Input: "go"})
		results <- result{err, time.Since(begin)}
	})
	r := <-results
	claudeNotAppliedError(t, r.err)
	if r.elapsed > 600*time.Millisecond {
		t.Fatalf("steer took %v", r.elapsed)
	}
	claudeMustComplete(t, outcome)
}
