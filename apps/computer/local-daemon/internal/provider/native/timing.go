package native

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Timing event names that log consumers search for.
const (
	timingClaudeTurnResult      = "claude.turn.result"
	timingClaudeProcessExited   = "claude.process_exited"
	timingClaudeCleanupComplete = "claude.cleanup_completed"
	timingCodexTurnCompleted    = "codex turn/completed received"
	timingCodexProcessExited    = "codex.process_exited"
	timingCodexCleanupComplete  = "codex.cleanup_completed"
)

const timingQueueCapacity = 64

type timingRecord struct {
	logger *slog.Logger
	record slog.Record
	// flushed marks a flush sentinel: the worker closes it instead of logging.
	flushed chan struct{}
}

// timingQueue hands lifecycle observations to one background worker. A
// full queue drops the record: the caller never waits on a log sink, and a
// missing observation proves nothing.
type timingQueue struct {
	records chan timingRecord
	once    sync.Once
}

func newTimingQueue(capacity int) *timingQueue {
	return &timingQueue{records: make(chan timingRecord, capacity)}
}

var processTimings = newTimingQueue(timingQueueCapacity)

func (q *timingQueue) enqueue(logger *slog.Logger, at time.Time, event string, attrs ...any) bool {
	if logger == nil {
		logger = slog.Default()
	}
	q.once.Do(func() { go q.drain() })
	record := slog.NewRecord(at, slog.LevelInfo, event, 0)
	record.Add("received_at_unix_ms", at.UnixMilli())
	record.Add(attrs...)
	select {
	case q.records <- timingRecord{logger: logger, record: record}:
		return true
	default:
		return false
	}
}

func (q *timingQueue) drain() {
	ctx := context.Background()
	for item := range q.records {
		if item.flushed != nil {
			close(item.flushed)
			continue
		}
		handler := item.logger.Handler()
		if handler.Enabled(ctx, slog.LevelInfo) {
			_ = handler.Handle(ctx, item.record)
		}
	}
}

// recordTiming queues one Info record named event, observed at at.
func recordTiming(logger *slog.Logger, at time.Time, event string, attrs ...any) {
	processTimings.enqueue(logger, at, event, attrs...)
}

// flush blocks until every record queued before the call has been handled.
// The sentinel's send blocks: only real records are dropped when full, and the
// single FIFO worker handles everything queued ahead of it first.
func (q *timingQueue) flush() {
	q.once.Do(func() { go q.drain() })
	done := make(chan struct{})
	q.records <- timingRecord{flushed: done}
	<-done
}

// FlushTimings blocks until every timing record queued before the call has
// been handled. It exists so tests can wait for diagnostics written into a
// Runtime home before removing it; hot-path callers never use it.
func FlushTimings() { processTimings.flush() }
