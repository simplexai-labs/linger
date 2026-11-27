package mobilegateway

import (
	"context"
	"errors"
	"io"
	"sync"
)

var (
	errStreamReset  = errors.New("stream reset by phone")
	errFlowControl  = errors.New("phone exceeded its stream window")
	windowThreshold = 32 * 1024
)

type inbound struct {
	kind frameType
	data []byte
}

// stream is one request or socket inside a session. Frames from the phone
// queue here; the consumer takes them and returns window credit as it goes.
type stream struct {
	session *session
	id      uint32
	ctx     context.Context
	cancel  context.CancelCauseFunc

	mu        sync.Mutex
	cond      *sync.Cond
	queue     []inbound
	queued    int
	credit    int
	inputDone bool
	err       error
}

func newStream(s *session, id uint32) *stream {
	ctx, cancel := context.WithCancelCause(s.ctx)
	st := &stream{session: s, id: id, ctx: ctx, cancel: cancel}
	st.cond = sync.NewCond(&st.mu)
	return st
}

func (st *stream) deliver(kind frameType, payload []byte) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	if st.err != nil || st.inputDone {
		return nil
	}
	if st.queued+len(payload) > streamWindow {
		return errFlowControl
	}
	st.queue = append(st.queue, inbound{kind: kind, data: append([]byte(nil), payload...)})
	st.queued += len(payload)
	st.cond.Broadcast()
	return nil
}

func (st *stream) finishInput() {
	st.mu.Lock()
	st.inputDone = true
	st.cond.Broadcast()
	st.mu.Unlock()
}

func (st *stream) abort(cause error) {
	st.mu.Lock()
	if st.err == nil {
		st.err = cause
	}
	st.cond.Broadcast()
	st.mu.Unlock()
	st.cancel(cause)
}

// next blocks until the phone sends a message, ends its input (io.EOF), or
// the stream is abandoned.
func (st *stream) next() (inbound, error) {
	st.mu.Lock()
	for len(st.queue) == 0 && !st.inputDone && st.err == nil {
		st.cond.Wait()
	}
	if st.err != nil {
		err := st.err
		st.mu.Unlock()
		return inbound{}, err
	}
	if len(st.queue) == 0 {
		st.mu.Unlock()
		return inbound{}, io.EOF
	}
	item := st.queue[0]
	st.queue[0] = inbound{}
	st.queue = st.queue[1:]
	st.queued -= len(item.data)
	st.credit += len(item.data)
	var increment int
	if st.credit >= windowThreshold || (len(st.queue) == 0 && st.credit > 0) {
		increment, st.credit = st.credit, 0
	}
	st.mu.Unlock()
	if increment > 0 {
		_ = st.session.emit(st.ctx, frameWindow, st.id, windowPayload(uint32(increment)))
	}
	return item, nil
}

// finish releases the stream from its session.
func (st *stream) finish() {
	st.cancel(io.EOF)
	st.session.release(st.id)
}

// bodyReader adapts a request stream's data frames to an io.ReadCloser.
type bodyReader struct {
	stream   *stream
	leftover []byte
}

func (b *bodyReader) Read(p []byte) (int, error) {
	for len(b.leftover) == 0 {
		item, err := b.stream.next()
		if err != nil {
			if errors.Is(err, io.EOF) {
				return 0, io.EOF
			}
			return 0, err
		}
		if item.kind != frameData {
			return 0, errMalformedFrame
		}
		b.leftover = item.data
	}
	n := copy(p, b.leftover)
	b.leftover = b.leftover[n:]
	return n, nil
}

func (b *bodyReader) Close() error { return nil }
