package native

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"sync"
	"time"
)

// claudeConversation is the input state of one process. A reused turn resets
// it; the end of the stream finishes it for good.
type claudeConversation struct {
	proc *claudeProcess

	mu             sync.Mutex
	owner          *claudeTurn
	nativeID       string
	closed         bool
	started        bool
	failure        string
	finished       bool
	finishedCh     chan struct{}
	requests       map[string]chan claudeControlResult
	submitted      bool
	inputWrittenAt time.Time
	// steers hold input for the running turn until the main agent's next
	// tool result carries it to the model.
	steers []*claudeSteer
}

// claudeSteer is input waiting for the next tool boundary of its turn. done
// receives nil once the input reached the CLI, or the reason it did not.
type claudeSteer struct {
	text string
	done chan error
}

// claudeControlResult is the answer to one control request: the response
// payload on success, or an error.
type claudeControlResult struct {
	payload json.RawMessage
	err     error
}

func claudeNewConversation(p *claudeProcess) *claudeConversation {
	return &claudeConversation{
		proc: p, finishedCh: make(chan struct{}),
		requests: map[string]chan claudeControlResult{},
	}
}

// reset starts a new turn on the conversation with nativeID as its turn ID.
func (c *claudeConversation) reset(owner *claudeTurn, nativeID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.owner, c.nativeID = owner, nativeID
	c.closed, c.started = false, false
	c.failure = ""
	c.submitted, c.inputWrittenAt = false, time.Time{}
	for id, ch := range c.requests {
		ch <- claudeControlResult{err: errors.New("Claude turn was reset")}
		delete(c.requests, id)
	}
	c.rejectSteersLocked()
}

func (c *claudeConversation) current() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nativeID
}

// markSubmitted records, just before the turn's first user frame is
// written, that the initial input is on its way.
func (c *claudeConversation) markSubmitted(at time.Time) {
	c.mu.Lock()
	c.submitted = true
	if c.inputWrittenAt.IsZero() {
		c.inputWrittenAt = at
	}
	c.mu.Unlock()
}

// claudeTurnStart is the moment a turn's run input reached the CLI.
type claudeTurnStart struct {
	turnID    string
	writtenAt time.Time
}

// beginAtInit starts the turn on a system/init frame. It only counts once
// the initial input is submitted and the turn has not started yet, so an
// init sent at process start is ignored.
func (c *claudeConversation) beginAtInit() (claudeTurnStart, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.submitted || c.started {
		return claudeTurnStart{}, false
	}
	c.started = true
	return claudeTurnStart{turnID: c.nativeID, writtenAt: c.inputWrittenAt}, true
}

// confirmReplay applies a root replay of id. It starts the turn when no
// system/init did.
func (c *claudeConversation) confirmReplay(id string) (claudeTurnStart, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if id == "" || id != c.nativeID || c.started {
		return claudeTurnStart{}, false
	}
	c.started = true
	return claudeTurnStart{turnID: c.nativeID, writtenAt: c.inputWrittenAt}, true
}

// acceptResult applies the result acceptance rules. The accepted result
// ends the turn, so steers still waiting for a tool boundary never reach it.
func (c *claudeConversation) acceptResult(parent, userMessage string) bool {
	if parent != "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if userMessage != "" && userMessage != c.nativeID {
		return false
	}
	c.closed = true
	c.rejectSteersLocked()
	return true
}

// enqueueSteer holds text for the next tool boundary of owner's running
// turn, the one named expected.
func (c *claudeConversation) enqueueSteer(owner *claudeTurn, expected, text string) (*claudeSteer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.owner != owner || !c.started || c.closed || c.finished || owner.proc.isStopping() || expected != c.nativeID {
		return nil, claudeNotApplied(expected, c.nativeID)
	}
	steer := &claudeSteer{text: text, done: make(chan error, 1)}
	c.steers = append(c.steers, steer)
	return steer, nil
}

// withdrawSteer removes a steer that has not been handed to the CLI. It
// reports false once the steer was taken.
func (c *claudeConversation) withdrawSteer(steer *claudeSteer) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	index := slices.Index(c.steers, steer)
	if index < 0 {
		return false
	}
	c.steers = slices.Delete(c.steers, index, index+1)
	return true
}

// takeSteers hands every waiting steer of owner's open turn to the caller,
// which must resolve each one.
func (c *claudeConversation) takeSteers(owner *claudeTurn) []*claudeSteer {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.owner != owner || c.closed {
		return nil
	}
	steers := c.steers
	c.steers = nil
	return steers
}

// rejectSteersLocked releases every waiting steer as not applied.
func (c *claudeConversation) rejectSteersLocked() {
	for _, steer := range c.steers {
		steer.done <- claudeNotApplied(c.nativeID, c.nativeID)
	}
	c.steers = nil
}

// idle reports a conversation that may park.
func (c *claudeConversation) idle() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.failure == ""
}

func (c *claudeConversation) failureSummary() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.failure
}

// abort records a failure, closes the conversation and cancels the process.
func (c *claudeConversation) abort(text string) {
	c.mu.Lock()
	if c.failure == "" {
		c.failure = text
	}
	c.closed = true
	c.rejectSteersLocked()
	c.mu.Unlock()
	c.proc.cancel()
}

// finish ends the stream and releases every waiter. Repeated calls return
// the same failure.
func (c *claudeConversation) finish() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.finished {
		c.closed, c.finished = true, true
		close(c.finishedCh)
		for id, ch := range c.requests {
			ch <- claudeControlResult{err: io.EOF}
			delete(c.requests, id)
		}
		c.rejectSteersLocked()
	}
	return c.failure
}

// request writes a control request and waits for its control response. It
// returns the response payload.
func (c *claudeConversation) request(ctx context.Context, id string, frame []byte) (json.RawMessage, error) {
	reply := make(chan claudeControlResult, 1)
	c.mu.Lock()
	if c.finished {
		c.mu.Unlock()
		return nil, io.EOF
	}
	c.requests[id] = reply
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.requests[id] == reply {
			delete(c.requests, id)
		}
		c.mu.Unlock()
	}()
	if err := c.proc.write(ctx, frame); err != nil {
		return nil, err
	}
	select {
	case result := <-reply:
		return result.payload, result.err
	case <-ctx.Done():
		return nil, context.Cause(ctx)
	case <-c.proc.ctx.Done():
		return nil, errors.New("Claude process is stopping")
	}
}

// handleResponse completes the pending request a control response names.
func (c *claudeConversation) handleResponse(raw json.RawMessage) {
	var response struct {
		RequestID string          `json:"request_id"`
		Subtype   string          `json:"subtype"`
		Error     string          `json:"error"`
		Response  json.RawMessage `json:"response"`
	}
	if json.Unmarshal(raw, &response) != nil {
		return
	}
	c.mu.Lock()
	reply := c.requests[response.RequestID]
	delete(c.requests, response.RequestID)
	c.mu.Unlock()
	if reply != nil {
		if response.Subtype == "success" {
			reply <- claudeControlResult{payload: response.Response}
		} else {
			reply <- claudeControlResult{err: errors.New("Claude rejected control request: " + response.Error)}
		}
	}
}
