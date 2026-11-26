package native

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

const (
	antigravityExitWait  = 3 * time.Second
	antigravityTermWait  = time.Second
	antigravityGroupWait = 3 * time.Second
	antigravityPipeDrain = time.Second
)

var errAntigravityProcessBusy = errors.New("Antigravity process is not idle")

// antigravityTreeCheck replaces the process-tree emptiness check in tests.
var antigravityTreeCheck atomic.Pointer[func(*exec.Cmd, time.Duration) bool]

func antigravityTreeGone(cmd *exec.Cmd, budget time.Duration) bool {
	if check := antigravityTreeCheck.Load(); check != nil {
		return (*check)(cmd, budget)
	}
	return process.WaitEmpty(cmd, budget)
}

// acpProcess is one `agy acp` child and its ACP connection. Stderr is
// discarded: a signed-out Antigravity prints its OAuth URL there.
type acpProcess struct {
	res     residency
	cmd     *exec.Cmd
	pid     int
	stdin   *os.File
	stdout  *os.File
	conn    *acpConn
	exited  chan struct{}
	waitErr error
	// cancel ends the process context, which outlives every caller.
	cancel      context.CancelFunc
	caps        acpCapabilities
	shape       *antigravityShape
	front       *mcpFront
	hookEP      *AntigravityHookEndpoint
	storeRoot   string
	releaseTemp func() error
	releaseOnce sync.Once
	fixedHandle func(acpFrame)

	mu                sync.Mutex
	turn              *antigravityTurn
	sessionID         string
	transcriptPath    string
	systemPromptHash  string
	defaultModel      string
	defaultEffort     string
	appliedModel      string
	appliedEffort     string
	explicitModelSet  bool
	explicitEffortSet bool
}

// startACP launches `agy acp` with any additional flags in dir. When handle is
// non-nil it receives every notification and agent request; otherwise frames
// dispatch to the currently bound turn.
func startACP(inv Invocation, dir string, logger *slog.Logger, handle func(acpFrame), extraArgs ...string) (*acpProcess, error) {
	stdinRead, stdinWrite, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stdoutRead, stdoutWrite, err := os.Pipe()
	if err != nil {
		_ = stdinRead.Close()
		_ = stdinWrite.Close()
		return nil, err
	}
	procCtx, cancel := context.WithCancel(context.Background())
	args := append([]string{"acp"}, extraArgs...)
	cmd := ownedCommand(procCtx, inv, args...)
	cmd.Dir = dir
	cmd.WaitDelay = antigravityPipeDrain
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdinRead, stdoutWrite, nil
	startErr := process.Start(cmd)
	_ = stdinRead.Close()
	_ = stdoutWrite.Close()
	if startErr != nil {
		cancel()
		_ = stdinWrite.Close()
		_ = stdoutRead.Close()
		return nil, fmt.Errorf("Antigravity could not be started: %w", ExplainExecError(startErr))
	}
	if logger != nil {
		logRuntimeLaunch(logger, "antigravity", "acp", cmd)
	}
	p := &acpProcess{
		cmd:         cmd,
		pid:         cmd.Process.Pid,
		stdin:       stdinWrite,
		stdout:      stdoutRead,
		exited:      make(chan struct{}),
		cancel:      cancel,
		fixedHandle: handle,
	}
	p.conn = newACPConn(stdinWrite, p.handleFrame)
	go func() {
		p.waitErr = cmd.Wait()
		close(p.exited)
	}()
	go p.conn.serve(stdoutRead)
	return p, nil
}

func (p *acpProcess) handleFrame(frame acpFrame) {
	if p.fixedHandle != nil {
		p.fixedHandle(frame)
		return
	}
	p.mu.Lock()
	turn := p.turn
	p.mu.Unlock()
	if turn != nil {
		turn.handle(frame)
		return
	}
	if len(frame.ID) > 0 {
		_ = p.conn.respondError(frame.ID, -32601, "no active turn")
	}
}

func (p *acpProcess) bind(t *antigravityTurn) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.turn != nil || p.res.isStopping() {
		return errAntigravityProcessBusy
	}
	p.turn = t
	return nil
}

func (p *acpProcess) unbind(t *antigravityTurn) {
	p.mu.Lock()
	if p.turn == t {
		p.turn = nil
	}
	p.mu.Unlock()
}

func (p *acpProcess) noteTranscriptPath(req AntigravityHookRequest) {
	if p == nil || req.TranscriptPath == "" {
		return
	}
	p.mu.Lock()
	if p.sessionID == "" || p.sessionID == req.ConversationID {
		p.transcriptPath = req.TranscriptPath
	}
	p.mu.Unlock()
}

func (p *acpProcess) residency() *residency { return &p.res }

func (p *acpProcess) residentAttrs() []any {
	p.mu.Lock()
	session := p.sessionID
	p.mu.Unlock()
	return []any{"pid", p.pid, "session_id", session}
}

func (p *acpProcess) alive() bool {
	return !p.res.isStopping() && !acpDone(p.conn.closed) && !acpDone(p.exited)
}

func acpDone(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// stop is the table-serialized stop of the whole process tree.
func (p *acpProcess) stop() bool {
	return p.res.stop(p.stopTree)
}

// stopTree closes stdin and escalates until the process tree is gone. A
// confirmed exit releases everything the process owns; otherwise only the
// resident front closes so survivors cannot reach a finished Run's endpoints.
func (p *acpProcess) stopTree() bool {
	go func() { _ = p.stdin.Close() }()
	if !acpWait(p.exited, antigravityExitWait) {
		_ = process.Signal(p.cmd, syscall.SIGTERM)
		if !acpWait(p.exited, antigravityTermWait) {
			_ = process.Signal(p.cmd, syscall.SIGKILL)
			go func() { _ = p.stdout.Close() }()
			<-p.exited
		}
	}
	if !antigravityTreeGone(p.cmd, 100*time.Millisecond) {
		_ = process.Signal(p.cmd, syscall.SIGKILL)
	}
	confirmed := antigravityTreeGone(p.cmd, antigravityGroupWait)
	if !acpWait(p.conn.closed, antigravityPipeDrain) {
		go func() { _ = p.stdout.Close() }()
	}
	if !confirmed {
		p.front.Close()
		return false
	}
	p.release()
	return true
}

func (p *acpProcess) release() {
	p.releaseOnce.Do(func() {
		p.front.Close()
		if p.cancel != nil {
			p.cancel()
		}
		process.Release(p.cmd)
		if p.releaseTemp != nil {
			_ = p.releaseTemp()
		}
	})
}

func acpWait(done <-chan struct{}, budget time.Duration) bool {
	timer := time.NewTimer(budget)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}
