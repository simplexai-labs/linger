package native

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
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

// acpProcess is one `agy acp` child and its ACP connection. Stderr is
// discarded: a signed-out Antigravity prints its OAuth URL there.
type acpProcess struct {
	cmd     *exec.Cmd
	stdin   *os.File
	stdout  *os.File
	conn    *acpConn
	exited  chan struct{}
	waitErr error
	// cancel ends the process context, which outlives every caller.
	cancel context.CancelFunc
}

// startACP launches `agy acp` with any additional flags in dir. handle receives
// the agent's notifications and requests.
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
	p := &acpProcess{cmd: cmd, stdin: stdinWrite, stdout: stdoutRead, exited: make(chan struct{}), cancel: cancel}
	p.conn = newACPConn(stdinWrite, handle)
	go func() {
		p.waitErr = cmd.Wait()
		close(p.exited)
	}()
	go p.conn.serve(stdoutRead)
	return p, nil
}

// stop closes stdin and escalates until the process tree is gone. It
// reports whether the exit of the whole tree was confirmed.
func (p *acpProcess) stop() bool {
	go func() { _ = p.stdin.Close() }()
	if !acpWait(p.exited, antigravityExitWait) {
		_ = process.Signal(p.cmd, syscall.SIGTERM)
		if !acpWait(p.exited, antigravityTermWait) {
			_ = process.Signal(p.cmd, syscall.SIGKILL)
			go func() { _ = p.stdout.Close() }()
			<-p.exited
		}
	}
	if !process.WaitEmpty(p.cmd, 100*time.Millisecond) {
		_ = process.Signal(p.cmd, syscall.SIGKILL)
	}
	confirmed := process.WaitEmpty(p.cmd, antigravityGroupWait)
	if !acpWait(p.conn.closed, antigravityPipeDrain) {
		go func() { _ = p.stdout.Close() }()
	}
	if confirmed {
		p.cancel()
		process.Release(p.cmd)
	}
	return confirmed
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
