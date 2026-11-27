// Package awaketime provides monotonic awake-only clocks and timeout contexts
// whose budgets exclude time spent in system sleep or hibernation.
//
// On Linux and macOS Go's runtime monotonic clock already pauses during system
// suspend, so standard context timeouts exclude sleep. On Windows Go reads
// KUSER_SHARED_DATA.InterruptTime, which includes sleep and hibernation time;
// WithTimeoutCause re-checks QueryUnbiasedInterruptTime when the timer fires
// and extends the timer by the remaining awake budget.
package awaketime

import (
	"context"
	"errors"
	"sync"
	"time"
)

// Clock returns monotonic elapsed time excluding system sleep or hibernation.
type Clock func() time.Duration

// Now returns monotonic awake time using the platform clock.
func Now() time.Duration {
	return awakeNow()
}

// WithTimeoutCause returns a context canceled with cause (or
// context.DeadlineExceeded when cause is nil) after timeout of awake time has
// elapsed.
func WithTimeoutCause(parent context.Context, timeout time.Duration, cause error) (context.Context, context.CancelFunc) {
	return WithTimeoutClockCause(parent, timeout, cause, nil)
}

// awakeTimeoutCtx implements context.Context with its own Done channel so Go's
// context.propagateCancel observes awakeTimeoutCtx.Err() and context.Cause()
// rather than bypassing to an internal cancelCtx. On expiry or manual cancel,
// causeCtx holds an already-closed standard context carrying the exact cause
// for context.Cause lookups while preserving all parent values.
type awakeTimeoutCtx struct {
	parent  context.Context
	start   time.Duration
	timeout time.Duration
	clock   Clock

	mu       sync.Mutex
	done     chan struct{}
	err      error
	causeCtx context.Context
}

func (c *awakeTimeoutCtx) Deadline() (time.Time, bool) {
	elapsed := c.clock() - c.start
	remaining := c.timeout - elapsed
	if elapsed < 0 {
		remaining = c.timeout
	}
	if remaining < 0 {
		remaining = 0
	}
	deadline := time.Now().Add(remaining)
	if parentDeadline, ok := c.parent.Deadline(); ok && parentDeadline.Before(deadline) {
		return parentDeadline, true
	}
	return deadline, true
}

func (c *awakeTimeoutCtx) Done() <-chan struct{} {
	return c.done
}

func (c *awakeTimeoutCtx) Err() error {
	c.mu.Lock()
	err := c.err
	c.mu.Unlock()
	return err
}

func (c *awakeTimeoutCtx) Value(key any) any {
	c.mu.Lock()
	causeCtx := c.causeCtx
	c.mu.Unlock()
	if causeCtx != nil {
		if value := causeCtx.Value(key); value != nil {
			return value
		}
	}
	return c.parent.Value(key)
}

func (c *awakeTimeoutCtx) finish(err, cause error, ownCause bool) {
	c.mu.Lock()
	if c.err != nil {
		c.mu.Unlock()
		return
	}
	c.err = err
	if ownCause {
		if errors.Is(err, context.DeadlineExceeded) {
			c.causeCtx = expiredCauseCtx(cause)
		} else {
			c.causeCtx = canceledCauseCtx()
		}
	}
	close(c.done)
	c.mu.Unlock()
}

func expiredCauseCtx(cause error) context.Context {
	expired, cancel := context.WithDeadlineCause(context.Background(), time.Time{}, cause)
	cancel()
	return expired
}

func canceledCauseCtx() context.Context {
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	return canceled
}

// WithTimeoutClockCause behaves like WithTimeoutCause using clock when
// non-nil, or the platform awake clock otherwise. On platforms whose Go timers
// already exclude sleep time and when clock is nil, it delegates directly to
// context.WithTimeout / context.WithTimeoutCause.
func WithTimeoutClockCause(parent context.Context, timeout time.Duration, cause error, clock Clock) (context.Context, context.CancelFunc) {
	if parent == nil {
		panic("cannot create context from nil parent")
	}
	if clock == nil && !sleepCountsTowardTimers {
		if cause != nil {
			return context.WithTimeoutCause(parent, timeout, cause)
		}
		return context.WithTimeout(parent, timeout)
	}
	if clock == nil {
		clock = awakeNow
	}
	deadlineCause := cause
	if deadlineCause == nil {
		deadlineCause = context.DeadlineExceeded
	}
	ctx := &awakeTimeoutCtx{
		parent:  parent,
		start:   clock(),
		timeout: timeout,
		clock:   clock,
		done:    make(chan struct{}),
	}
	cancel := func() {
		ctx.finish(context.Canceled, nil, true)
	}
	if parentErr := parent.Err(); parentErr != nil {
		ctx.finish(parentErr, nil, false)
		return ctx, cancel
	}
	if timeout <= 0 {
		ctx.finish(context.DeadlineExceeded, deadlineCause, true)
		return ctx, cancel
	}
	go func() {
		timer := time.NewTimer(timeout)
		defer timer.Stop()
		parentDone := parent.Done()
		for {
			select {
			case <-ctx.done:
				return
			case <-parentDone:
				ctx.finish(parent.Err(), nil, false)
				return
			case <-timer.C:
				elapsed := clock() - ctx.start
				if elapsed >= timeout {
					ctx.finish(context.DeadlineExceeded, deadlineCause, true)
					return
				}
				remaining := timeout - elapsed
				if elapsed < 0 {
					remaining = timeout
				}
				if remaining < time.Millisecond {
					remaining = time.Millisecond
				}
				timer.Reset(remaining)
			}
		}
	}()
	return ctx, cancel
}
