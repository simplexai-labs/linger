package awaketime

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestWithTimeoutExtendsAcrossSimulatedSleep(t *testing.T) {
	// Simulate Windows behavior where Go's time.Timer fires after 25ms of real
	// (biased) time, while the unbiased awake clock only moved by 5ms because
	// the system was asleep.
	var awakeNanos atomic.Int64
	awakeNanos.Store(int64(10 * time.Second))
	clock := func() time.Duration {
		return time.Duration(awakeNanos.Load())
	}

	ctx, cancel := WithTimeoutClockCause(t.Context(), 25*time.Millisecond, nil, clock)
	defer cancel()

	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) <= 0 {
		t.Fatalf("Deadline() = (%v, %v), want future deadline", deadline, ok)
	}

	// Advance awake time by only 5ms and wait past the initial 25ms timer.
	awakeNanos.Add(int64(5 * time.Millisecond))
	time.Sleep(40 * time.Millisecond)
	if err := ctx.Err(); err != nil {
		t.Fatalf("context expired prematurely during simulated sleep: %v", err)
	}
	// Remaining awake deadline stays positive even after wall time passed 25ms.
	if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) <= 0 {
		t.Fatalf("post-sleep Deadline() = (%v, %v), want positive remaining awake time", deadline, ok)
	}

	// Now advance awake time past the 25ms budget; the re-armed timer fires.
	awakeNanos.Add(int64(25 * time.Millisecond))
	select {
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.DeadlineExceeded) {
			t.Fatalf("err = %v, want DeadlineExceeded", ctx.Err())
		}
	case <-time.After(time.Second):
		t.Fatal("context did not expire after awake budget elapsed")
	}
}

func TestWithTimeoutCausePropagatesDeadlineExceededToDerivedAndNestedContexts(t *testing.T) {
	type ctxKey string
	var awakeNanos atomic.Int64
	clock := func() time.Duration { return time.Duration(awakeNanos.Load()) }
	sentinel := errors.New("custom awake budget expired")

	base := context.WithValue(t.Context(), ctxKey("trace"), "abc")
	overall, cancelOverall := WithTimeoutClockCause(base, 15*time.Millisecond, sentinel, clock)
	defer cancelOverall()

	plainChild, cancelPlain := context.WithCancel(overall)
	defer cancelPlain()

	// Matches codex_runtime's nested budgetContext(overall, spec.Budget) where
	// the outer budget expires before the inner budget's own timer fires.
	nested, cancelNested := WithTimeoutClockCause(overall, time.Hour, sentinel, clock)
	defer cancelNested()

	awakeNanos.Add(int64(20 * time.Millisecond))
	for _, tc := range []struct {
		name string
		ctx  context.Context
	}{
		{name: "overall", ctx: overall},
		{name: "plain_child", ctx: plainChild},
		{name: "nested_awake", ctx: nested},
	} {
		select {
		case <-tc.ctx.Done():
		case <-time.After(time.Second):
			t.Fatalf("%s did not expire", tc.name)
		}
		if !errors.Is(tc.ctx.Err(), context.DeadlineExceeded) {
			t.Fatalf("%s Err() = %v, want DeadlineExceeded", tc.name, tc.ctx.Err())
		}
		if !errors.Is(context.Cause(tc.ctx), sentinel) {
			t.Fatalf("%s Cause() = %v, want %v", tc.name, context.Cause(tc.ctx), sentinel)
		}
		if got := tc.ctx.Value(ctxKey("trace")); got != "abc" {
			t.Fatalf("%s Value(trace) = %v, want abc", tc.name, got)
		}
	}
}

func TestWithTimeoutHonorsParentAndManualCancellation(t *testing.T) {
	var awakeNanos atomic.Int64
	clock := func() time.Duration { return time.Duration(awakeNanos.Load()) }

	parent, cancelParent := context.WithCancel(t.Context())
	ctx, cancel := WithTimeoutClockCause(parent, time.Hour, nil, clock)
	defer cancel()

	cancelParent()
	select {
	case <-ctx.Done():
		if !errors.Is(ctx.Err(), context.Canceled) {
			t.Fatalf("err = %v, want Canceled", ctx.Err())
		}
		if !errors.Is(context.Cause(ctx), context.Canceled) {
			t.Fatalf("cause = %v, want Canceled", context.Cause(ctx))
		}
	case <-time.After(time.Second):
		t.Fatal("context did not cancel with parent")
	}

	manual, cancelManual := WithTimeoutClockCause(t.Context(), time.Hour, errors.New("unused"), clock)
	child, cancelChild := context.WithCancel(manual)
	defer cancelChild()
	cancelManual()
	<-child.Done()
	if !errors.Is(manual.Err(), context.Canceled) || !errors.Is(child.Err(), context.Canceled) {
		t.Fatalf("manual cancel errs = (%v, %v), want Canceled", manual.Err(), child.Err())
	}
	if !errors.Is(context.Cause(manual), context.Canceled) || !errors.Is(context.Cause(child), context.Canceled) {
		t.Fatalf("manual cancel causes = (%v, %v), want Canceled", context.Cause(manual), context.Cause(child))
	}
}
