// Package uiruntime owns a restricted, persistent JavaScript child. Tool
// authorization, images, and uncertain action journals belong to its caller.
package uiruntime

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/finalpath"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

//go:embed runtime.mjs
var script string

var (
	// ErrBusy means an execution or its dispatched callback is still running.
	ErrBusy = errors.New("UI runtime is busy")
	// ErrClosed means the owning lifetime has ended.
	ErrClosed = errors.New("UI runtime is closed")
	// ErrCleanupUnconfirmed prevents replacing a child whose cleanup is unknown.
	ErrCleanupUnconfirmed = errors.New("UI runtime child cleanup is unconfirmed")
	errFrameTooLarge      = errors.New("UI protocol frame exceeds byte limit")
)

// Limits bound execution and protocol resources. RSSMiB is a supervised
// threshold, not an operating-system hard memory limit.
type Limits struct {
	MaxCodeBytes     int
	MaxProtocolBytes int
	MaxOutputBytes   int
	MaxCalls         int
	MaxWallTime      time.Duration
	HeapMiB          int
	RSSMiB           int
	PumpTimeout      time.Duration
}

// Call is an untrusted guest request. Dispatch must validate the method and
// arguments and perform the original operation's authorization before acting.
type Call struct {
	Generation  uint64
	ExecutionID uint64
	ID          uint64
	Namespace   string
	Method      string
	Arguments   json.RawMessage
}

// Options contains only locally resolved executable configuration and an
// in-process dispatcher. No environment or executable is accepted from a guest.
type Options struct {
	// QuickJSDirectory belongs to the verified Computer tool bundle.
	QuickJSDirectory string
	NodePath         string
	Dispatch         func(context.Context, Call) (json.RawMessage, error)
	Limits           Limits
}

// Result contains opaque JSON values. Image handles are resolved by the caller.
// Generation identifies this execution even when Exec returns an error.
type Result struct {
	Generation uint64
	Value      json.RawMessage
	Output     []json.RawMessage
}

// Runtime serializes executions within one caller-owned lifetime.
type Runtime struct {
	life       context.Context
	cancel     context.CancelFunc
	opts       Options
	slot       chan struct{}
	mu         sync.Mutex
	child      *child
	generation uint64
	execution  uint64
	closed     bool
	poisoned   error
}

// New validates configuration. The child starts lazily on the first Exec.
func New(lifetime context.Context, opts Options) (*Runtime, error) {
	if lifetime == nil || !filepath.IsAbs(opts.NodePath) || !filepath.IsAbs(opts.QuickJSDirectory) || opts.Dispatch == nil {
		return nil, errors.New("UI runtime requires a lifetime, absolute engine paths, and dispatcher")
	}
	if err := defaultLimits(&opts.Limits); err != nil {
		return nil, err
	}
	life, cancel := context.WithCancel(lifetime)
	return &Runtime{life: life, cancel: cancel, opts: opts, slot: make(chan struct{}, 1), generation: 1}, nil
}

func defaultLimits(l *Limits) error {
	if l.MaxCodeBytes == 0 {
		l.MaxCodeBytes = 64 * 1024
	}
	if l.MaxProtocolBytes == 0 {
		l.MaxProtocolBytes = 2 * 1024 * 1024
	}
	if l.MaxOutputBytes == 0 {
		l.MaxOutputBytes = 1024 * 1024
	}
	if l.MaxCalls == 0 {
		l.MaxCalls = 64
	}
	if l.MaxWallTime == 0 {
		l.MaxWallTime = 120 * time.Second
	}
	if l.HeapMiB == 0 {
		l.HeapMiB = 128
	}
	if l.RSSMiB == 0 {
		l.RSSMiB = 256
	}
	if l.PumpTimeout == 0 {
		l.PumpTimeout = 100 * time.Millisecond
	}
	if l.MaxCodeBytes < 1 || l.MaxCodeBytes > 1024*1024 || l.MaxProtocolBytes < 1024 || l.MaxProtocolBytes > 24*1024*1024 || l.MaxOutputBytes < 1 || l.MaxOutputBytes > l.MaxProtocolBytes/2 || l.MaxCalls < 1 || l.MaxCalls > 1024 || l.MaxWallTime < time.Millisecond || l.MaxWallTime > 10*time.Minute || l.HeapMiB < 16 || l.HeapMiB > 1024 || l.RSSMiB < 32 || l.RSSMiB > 2048 || l.PumpTimeout < time.Millisecond || l.PumpTimeout > time.Second {
		return errors.New("invalid UI runtime limits")
	}
	return nil
}

// Generation changes when guest state is discarded. It never resets journals
// or other resources owned by the caller.
func (r *Runtime) Generation() uint64 { r.mu.Lock(); defer r.mu.Unlock(); return r.generation }

func (r *Runtime) enter() error {
	select {
	case r.slot <- struct{}{}:
	default:
		return ErrBusy
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.life.Err() != nil {
		<-r.slot
		return ErrClosed
	}
	if r.poisoned != nil {
		<-r.slot
		return r.poisoned
	}
	return nil
}

// Exec executes an async function body. Only state persists; lexical declarations
// belong to this call. UI closures saved in state retain their execution scope
// and cannot dispatch during a later execution. Scheduling cancellation stops the guest immediately, but
// an already-dispatched callback finishes under hardCtx before Exec returns.
// hardCtx must be honored by Dispatch; Go cannot forcibly terminate a callback.
func (r *Runtime) Exec(hardCtx, schedulingCtx context.Context, code string) (result Result, err error) {
	if hardCtx == nil || schedulingCtx == nil {
		return result, errors.New("UI execution requires both contexts")
	}
	if err = r.enter(); err != nil {
		return result, err
	}
	defer func() { <-r.slot }()
	result.Generation = r.Generation()
	if len(code) > r.opts.Limits.MaxCodeBytes {
		return result, errors.New("UI code exceeds byte limit")
	}
	hard, cancel := context.WithTimeout(hardCtx, r.opts.Limits.MaxWallTime)
	defer cancel()
	stopLife := context.AfterFunc(r.life, cancel)
	defer stopLife()
	if err = executionCause(hard, schedulingCtx); err != nil {
		return result, err
	}
	c, startErr := r.ensureChild(hard, schedulingCtx)
	if startErr != nil {
		return result, startErr
	}
	result.Generation = r.Generation()
	r.mu.Lock()
	r.execution++
	execution := r.execution
	r.mu.Unlock()
	// Kill the guest even while Dispatch is blocked. The callback deliberately
	// receives hard rather than schedulingCtx, retaining its completion receipt.
	stopHard := context.AfterFunc(hard, func() { r.invalidate(c) })
	stopScheduling := context.AfterFunc(schedulingCtx, func() { r.invalidate(c) })
	defer stopHard()
	defer stopScheduling()
	defer func() {
		if err != nil {
			r.invalidate(c)
			if closeErr := r.reap(c); closeErr != nil {
				err = errors.Join(err, closeErr)
			}
		}
	}()
	if err = executionCause(hard, schedulingCtx); err != nil {
		return result, err
	}
	if err = c.send(hard, map[string]any{"type": "exec", "execution": execution, "code": code}, r.opts.Limits.MaxProtocolBytes); err != nil {
		return result, err
	}
	var lastID uint64
	for {
		if err = executionCause(hard, schedulingCtx); err != nil {
			return result, err
		}
		var msg message
		select {
		case <-hard.Done():
			return result, context.Cause(hard)
		case <-schedulingCtx.Done():
			return result, context.Cause(schedulingCtx)
		case msg = <-c.messages:
		case readErr := <-c.readError:
			return result, readErr
		case <-c.exited:
			return result, errors.New("UI child exited before completion")
		}
		if err = executionCause(hard, schedulingCtx); err != nil {
			return result, err
		}
		if msg.Type == "fatal" {
			return result, fmt.Errorf("UI child failed: %s", msg.Error)
		}
		if msg.Execution != execution {
			return result, errors.New("UI protocol execution mismatch")
		}
		switch msg.Type {
		case "call":
			if msg.ID != lastID+1 || msg.ID > uint64(r.opts.Limits.MaxCalls) || (msg.Namespace != "computer" && msg.Namespace != "browser" && msg.Namespace != "help") || (msg.Method == "" && msg.Namespace != "help") || len(msg.Method) > 256 || len(msg.Arguments) == 0 || !json.Valid(msg.Arguments) {
				return result, errors.New("invalid UI callback request")
			}
			lastID = msg.ID
			value, callErr := r.opts.Dispatch(hard, Call{Generation: result.Generation, ExecutionID: execution, ID: msg.ID, Namespace: msg.Namespace, Method: msg.Method, Arguments: msg.Arguments})
			if err = executionCause(hard, schedulingCtx); err != nil {
				return result, err
			}
			if callErr != nil {
				err = c.send(hard, map[string]any{"type": "reply", "execution": execution, "id": msg.ID, "error": callErr.Error()}, r.opts.Limits.MaxProtocolBytes)
			} else {
				if len(value) == 0 {
					value = json.RawMessage("null")
				}
				if !json.Valid(value) {
					return result, errors.New("UI dispatcher returned invalid JSON")
				}
				err = c.send(hard, map[string]any{"type": "reply", "execution": execution, "id": msg.ID, "value": value}, r.opts.Limits.MaxProtocolBytes)
				if errors.Is(err, errFrameTooLarge) {
					// The action has completed; reject only this call so the
					// script keeps its state and can read a smaller result.
					err = c.send(hard, map[string]any{"type": "reply", "execution": execution, "id": msg.ID, "error": "UI call completed, but its result exceeds the byte limit; do not replay it"}, r.opts.Limits.MaxProtocolBytes)
				}
			}
			if err != nil {
				return result, err
			}
		case "done":
			if msg.Error != "" {
				// Console lines and emitted output explain the failure, so they
				// survive it when they are well formed.
				if outputWithin(msg.Output, r.opts.Limits.MaxOutputBytes) {
					result.Output = msg.Output
				}
				return result, fmt.Errorf("UI script failed: %s", msg.Error)
			}
			if len(msg.Value) == 0 || !json.Valid(msg.Value) {
				return result, errors.New("invalid UI return value")
			}
			size := len(msg.Value)
			for _, v := range msg.Output {
				if !json.Valid(v) {
					return result, errors.New("invalid UI output")
				}
				size += len(v)
			}
			if size > r.opts.Limits.MaxOutputBytes {
				return result, errors.New("UI output exceeds byte limit")
			}
			result.Value, result.Output = msg.Value, msg.Output
			return result, nil
		default:
			return result, errors.New("unexpected UI protocol message")
		}
	}
}

func outputWithin(output []json.RawMessage, limit int) bool {
	size := 0
	for _, v := range output {
		if !json.Valid(v) {
			return false
		}
		size += len(v)
	}
	return size <= limit
}

func executionCause(hard, scheduling context.Context) error {
	if hard.Err() != nil {
		return context.Cause(hard)
	}
	if scheduling.Err() != nil {
		return context.Cause(scheduling)
	}
	return nil
}

// Reset discards only guest state. An active or draining Exec returns ErrBusy.
func (r *Runtime) Reset(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return context.Cause(ctx)
	}
	if err := r.enter(); err != nil {
		return err
	}
	defer func() { <-r.slot }()
	r.mu.Lock()
	c := r.child
	r.mu.Unlock()
	if c == nil {
		r.mu.Lock()
		r.generation++
		r.mu.Unlock()
		return nil
	}
	r.invalidate(c)
	return r.reapContext(ctx, c)
}

// Close revokes the lifetime, stops the guest, and waits for the execution and
// owned process cleanup. Repeated Close calls may retry an incomplete wait.
func (r *Runtime) Close(ctx context.Context) error {
	r.mu.Lock()
	r.closed = true
	c := r.child
	r.mu.Unlock()
	r.cancel()
	if c != nil {
		r.invalidate(c)
	}
	select {
	case r.slot <- struct{}{}:
		defer func() { <-r.slot }()
	case <-ctx.Done():
		return errors.Join(ErrCleanupUnconfirmed, context.Cause(ctx))
	}
	if c != nil {
		return r.reapContext(ctx, c)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.poisoned
}

func (r *Runtime) invalidate(c *child) {
	r.mu.Lock()
	if r.child == c && !c.invalid {
		c.invalid = true
		r.generation++
	}
	r.mu.Unlock()
	c.stop()
}
func (r *Runtime) reap(c *child) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	return r.reapContext(ctx, c)
}
func (r *Runtime) reapContext(ctx context.Context, c *child) error {
	var err error
	select {
	case <-c.exited:
		// process.Run joins cleanup failures. Only a direct exit error from an
		// intentionally stopped child is benign; a joined error remains unknown.
		if c.err != nil && c.err != context.Cause(c.ctx) { //nolint:errorlint // A wrapped cause may also contain a cleanup failure.
			if _, ok := c.err.(*exec.ExitError); !ok { //nolint:errorlint // Only a bare exit error confirms cleanup.
				err = errors.Join(ErrCleanupUnconfirmed, c.err)
			}
		}
	case <-ctx.Done():
		err = errors.Join(ErrCleanupUnconfirmed, context.Cause(ctx))
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if err != nil {
		r.poisoned = err
		return err
	}
	if r.child == c {
		r.child = nil
	}
	return nil
}

type message struct {
	Type      string            `json:"type"`
	Execution uint64            `json:"execution"`
	ID        uint64            `json:"id"`
	Namespace string            `json:"namespace"`
	Method    string            `json:"method"`
	Arguments json.RawMessage   `json:"arguments"`
	Value     json.RawMessage   `json:"value"`
	Output    []json.RawMessage `json:"output"`
	Error     string            `json:"error"`
}
type child struct {
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	stdout    io.ReadCloser
	messages  chan message
	readError chan error
	exited    chan struct{}
	cancel    context.CancelFunc
	ctx       context.Context
	stopOnce  sync.Once
	invalid   bool  // guarded by Runtime.mu
	err       error // published by exited
}

func (c *child) stop() {
	c.stopOnce.Do(func() { _ = process.Signal(c.cmd, syscall.SIGKILL); c.cancel(); _ = c.stdin.Close() })
}

func (r *Runtime) ensureChild(hard, scheduling context.Context) (*child, error) {
	r.mu.Lock()
	c := r.child
	// A cancellation can invalidate the child after its last Exec returned.
	usable := c != nil && !c.invalid
	r.mu.Unlock()
	if c != nil {
		select {
		case <-c.exited:
			usable = false
		default:
		}
		if usable {
			return c, nil
		}
		r.invalidate(c)
		if err := r.reap(c); err != nil {
			return nil, err
		}
	}
	engineDir, err := finalpath.Resolve(r.opts.QuickJSDirectory)
	if err != nil {
		return nil, fmt.Errorf("open bundled UI engine: %w", err)
	}
	cfg, _ := json.Marshal(map[string]any{"engineDirectory": engineDir, "heapBytes": r.opts.Limits.HeapMiB * 1024 * 1024, "maxProtocolBytes": r.opts.Limits.MaxProtocolBytes, "maxOutputBytes": r.opts.Limits.MaxOutputBytes, "maxCalls": r.opts.Limits.MaxCalls, "rssBytes": r.opts.Limits.RSSMiB * 1024 * 1024, "pumpMs": r.opts.Limits.PumpTimeout.Milliseconds()})
	cmd := exec.Command(r.opts.NodePath, "--permission", "--allow-fs-read="+engineDir, "--no-addons", "--max-old-space-size="+strconv.Itoa(r.opts.Limits.HeapMiB), "--input-type=module", "-e", script, string(cfg))
	cmd.Env = []string{}
	cmd.Stderr = io.Discard
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, err
	}
	childCtx, cancel := context.WithCancel(r.life)
	c = &child{cmd: cmd, stdin: stdin, stdout: stdout, messages: make(chan message, 2), readError: make(chan error, 1), exited: make(chan struct{}), cancel: cancel, ctx: childCtx}
	r.mu.Lock()
	r.child = c
	r.mu.Unlock()
	go c.read(r.opts.Limits.MaxProtocolBytes)
	go func() {
		c.err = process.Run(childCtx, cmd, time.Second)
		_ = stdin.Close()
		_ = stdout.Close()
		close(c.exited)
	}()
	select {
	case msg := <-c.messages:
		if msg.Type == "ready" {
			return c, nil
		}
		err = errors.New("invalid UI child handshake")
	case err = <-c.readError:
	case <-c.exited:
		err = errors.New("UI child exited during startup")
	case <-hard.Done():
		err = context.Cause(hard)
	case <-scheduling.Done():
		err = context.Cause(scheduling)
	}
	r.invalidate(c)
	return nil, errors.Join(err, r.reap(c))
}
func (c *child) read(limit int) {
	scanner := bufio.NewScanner(c.stdout)
	scanner.Buffer(make([]byte, 4096), limit)
	for scanner.Scan() {
		var msg message
		if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
			c.readError <- errors.New("invalid UI child JSON")
			return
		}
		select {
		case c.messages <- msg:
		case <-c.exited:
			return
		}
	}
	err := scanner.Err()
	if err == nil {
		err = io.ErrUnexpectedEOF
	}
	c.readError <- err
}
func (c *child) send(ctx context.Context, value any, limit int) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if len(data) >= limit {
		return errFrameTooLarge
	}
	done := make(chan error, 1)
	go func() { _, err := c.stdin.Write(append(data, '\n')); done <- err }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		c.stop()
		return context.Cause(ctx)
	case <-c.exited:
		return io.ErrClosedPipe
	}
}
