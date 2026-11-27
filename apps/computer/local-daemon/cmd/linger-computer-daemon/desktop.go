package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
	localprocess "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// desktopStatusInterval is how often a Desktop-owned Daemon checks its state.
const desktopStatusInterval = 500 * time.Millisecond

// desktopPermissionTimeout bounds one permission request to the Desktop app.
const desktopPermissionTimeout = 10 * time.Second

// desktopPermissionsFeature is the hello feature of a Desktop app that
// answers permission requests.
const desktopPermissionsFeature = "permissions.v1"

// desktopStatus is one JSON line a Desktop-owned Daemon writes to stdout.
type desktopStatus struct {
	Type               string `json:"type"`
	GatewayState       string `json:"gateway_state"`
	ActiveOperations   int    `json:"active_operations"`
	ActiveModelInvokes int    `json:"active_model_invokes"`
}

type desktopStatusSource interface {
	GatewayState() string
	ActiveOperationCount() int
	ActiveModelInvokeCount() int
}

// desktopPermissionRequest asks the Desktop app about its own permissions.
type desktopPermissionRequest struct {
	Type       string `json:"type"`
	ID         string `json:"id"`
	Op         string `json:"op"`
	Permission string `json:"permission,omitempty"`
}

// desktopLine is any line the Desktop app writes to the Daemon's stdin.
type desktopLine struct {
	Type        string                        `json:"type"`
	Features    []string                      `json:"features"`
	ID          string                        `json:"id"`
	OK          bool                          `json:"ok"`
	Permissions []localtools.LingerPermission `json:"permissions"`
	Error       string                        `json:"error"`
	Reason      string                        `json:"reason"`
	Executable  string                        `json:"executable"`
	Args        []string                      `json:"args"`
	LogFile     string                        `json:"log_file"`
	Env         map[string]string             `json:"env"`
}

// localModelsStopSpec is the detached installer command Desktop arms the
// Daemon with so an unexpected Desktop crash (stdin EOF without a planned
// shutdown line) still stops local model engines and the Bifrost gateway.
type localModelsStopSpec struct {
	Executable string
	Args       []string
	LogFile    string
	Env        map[string]string
}

// desktopChannel is the stdio channel to the Desktop app that runs this
// Daemon. Every stdout line goes through one locked encoder, so status lines
// and permission requests never interleave within a line.
type desktopChannel struct {
	writeMu        sync.Mutex
	encoder        *json.Encoder
	timeout        time.Duration
	startCrashStop func(*localModelsStopSpec) error

	mu sync.Mutex
	// permissions is set once the app's hello announced permission requests;
	// an app without it never answers them.
	permissions      bool
	closed           bool
	gracefulShutdown bool
	crashStop        *localModelsStopSpec
	pending          map[string]chan desktopLine
}

func newDesktopChannel(stdout io.Writer) *desktopChannel {
	return &desktopChannel{
		encoder:        json.NewEncoder(stdout),
		timeout:        desktopPermissionTimeout,
		startCrashStop: startDetachedLocalModelsStop,
		pending:        map[string]chan desktopLine{},
	}
}

// encode writes one JSON line to the Desktop app.
func (c *desktopChannel) encode(value any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.encoder.Encode(value)
}

// read handles the Desktop app's stdin lines until EOF, then calls shutdown:
// the app closes the Daemon's stdin when it stops it, and the pipe closes
// when the app exits without stopping it. When EOF arrives cleanly without a
// prior planned shutdown message and Desktop armed a local-models stop
// command, the Daemon launches that detached helper before shutting down.
func (c *desktopChannel) read(stdin io.Reader, shutdown func()) {
	lines := bufio.NewScanner(stdin)
	lines.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for lines.Scan() {
		var line desktopLine
		if err := json.Unmarshal(lines.Bytes(), &line); err != nil {
			slog.Warn("desktop.stdin_invalid_line", "error", err)
			continue
		}
		c.receive(line)
	}
	readErr := lines.Err()
	if readErr != nil {
		slog.Warn("desktop.stdin_read_failed", "error", readErr)
		// An overlong line stops the scanner, but only EOF means the app is
		// gone.
		_, _ = io.Copy(io.Discard, stdin)
	}
	c.mu.Lock()
	c.closed = true
	var crashStop *localModelsStopSpec
	if readErr == nil && !c.gracefulShutdown && c.crashStop != nil {
		crashStop = c.crashStop
	}
	c.crashStop = nil
	for id, reply := range c.pending {
		close(reply)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	if crashStop != nil && c.startCrashStop != nil {
		if err := c.startCrashStop(crashStop); err != nil {
			slog.Warn("desktop.crash_local_models_stop_failed", "error", err)
		}
	}
	shutdown()
}

func (c *desktopChannel) receive(line desktopLine) {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch line.Type {
	case "hello":
		c.permissions = slices.Contains(line.Features, desktopPermissionsFeature)
	case "local_models_stop.arm":
		spec, ok := validateLocalModelsStop(line)
		if !ok {
			slog.Warn("desktop.local_models_stop_invalid")
			return
		}
		c.crashStop = spec
	case "local_models_stop.disarm":
		c.crashStop = nil
	case "shutdown":
		c.gracefulShutdown = true
	case "permission.response":
		// A response after its request timed out has no waiter.
		if reply, ok := c.pending[line.ID]; ok {
			delete(c.pending, line.ID)
			reply <- line
		}
	}
}

func validateLocalModelsStop(line desktopLine) (*localModelsStopSpec, bool) {
	if line.Executable == "" || !filepath.IsAbs(line.Executable) || strings.ContainsRune(line.Executable, 0) {
		return nil, false
	}
	if !slices.Contains(line.Args, "--stop-local-models") {
		return nil, false
	}
	for _, arg := range line.Args {
		if strings.ContainsRune(arg, 0) {
			return nil, false
		}
	}
	if line.LogFile != "" && (!filepath.IsAbs(line.LogFile) || strings.ContainsRune(line.LogFile, 0)) {
		return nil, false
	}
	env := make(map[string]string, len(line.Env))
	for key, value := range line.Env {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(value, 0) {
			return nil, false
		}
		if strings.EqualFold(key, "LINGER_COMPUTER_TOKEN") {
			return nil, false
		}
		env[key] = value
	}
	return &localModelsStopSpec{
		Executable: line.Executable,
		Args:       slices.Clone(line.Args),
		LogFile:    line.LogFile,
		Env:        env,
	}, true
}

// crashStopEnvironment strips the Daemon's Gateway credential from the
// inherited environment and overlays the non-secret keys requested for the
// detached stop helper.
func crashStopEnvironment(base []string, overlay map[string]string) []string {
	overrideKeys := make(map[string]struct{}, len(overlay))
	for key := range overlay {
		overrideKeys[strings.ToUpper(key)] = struct{}{}
	}
	result := make([]string, 0, len(base)+len(overlay))
	for _, entry := range base {
		name, _, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		if strings.EqualFold(name, "LINGER_COMPUTER_TOKEN") {
			continue
		}
		if _, replaced := overrideKeys[strings.ToUpper(name)]; replaced {
			continue
		}
		result = append(result, entry)
	}
	keys := slices.Collect(maps.Keys(overlay))
	sort.Strings(keys)
	for _, key := range keys {
		result = append(result, key+"="+overlay[key])
	}
	return result
}

// startDetachedLocalModelsStop launches the installer's `--stop-local-models`
// helper in its own process group / console outside any Job Object and returns
// immediately so the Daemon exits without waiting for model teardown.
func startDetachedLocalModelsStop(spec *localModelsStopSpec) error {
	var logFile *os.File
	if spec.LogFile != "" {
		if err := os.MkdirAll(filepath.Dir(spec.LogFile), 0o700); err != nil {
			return fmt.Errorf("create local-models stop log directory: %w", err)
		}
		file, err := os.OpenFile(spec.LogFile, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
		if err != nil {
			return fmt.Errorf("open local-models stop log: %w", err)
		}
		logFile = file
		defer func() { _ = logFile.Close() }()
	}
	cmd := exec.Command(spec.Executable, spec.Args...)
	cmd.Env = crashStopEnvironment(os.Environ(), spec.Env)
	cmd.Stdin = nil
	if logFile != nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	localprocess.Prepare(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start local-models stop helper: %w", err)
	}
	pid := 0
	if cmd.Process != nil {
		pid = cmd.Process.Pid
		_ = cmd.Process.Release()
	}
	slog.Info("desktop.crash_local_models_stop_started", "pid", pid)
	return nil
}

// LingerPermissions sends one permission request to the Desktop app and
// waits for its answer.
func (c *desktopChannel) LingerPermissions(ctx context.Context, op, permission string) ([]localtools.LingerPermission, error) {
	id := rand.Text()
	reply := make(chan desktopLine, 1)
	c.mu.Lock()
	if !c.permissions || c.closed {
		c.mu.Unlock()
		return nil, localtools.ErrLingerBridgeUnavailable
	}
	c.pending[id] = reply
	c.mu.Unlock()
	forget := func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	if err := c.encode(desktopPermissionRequest{Type: "permission.request", ID: id, Op: op, Permission: permission}); err != nil {
		forget()
		return nil, fmt.Errorf("write Desktop permission request: %w", err)
	}
	select {
	case line, ok := <-reply:
		switch {
		case !ok:
			return nil, errors.New("the Desktop app closed the Daemon's stdin")
		case !line.OK:
			return nil, &localtools.LingerBridgeError{Code: line.Error}
		}
		return line.Permissions, nil
	case <-ctx.Done():
		forget()
		return nil, ctx.Err()
	}
}

// reportDesktopStatus writes the Daemon state when it changes until ctx ends.
// Logs go to stderr, so stdout carries only Desktop channel lines.
func reportDesktopStatus(ctx context.Context, encode func(any) error, source desktopStatusSource, interval time.Duration) {
	var last *desktopStatus
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		current := desktopStatus{
			Type:               "status",
			GatewayState:       source.GatewayState(),
			ActiveOperations:   source.ActiveOperationCount(),
			ActiveModelInvokes: source.ActiveModelInvokeCount(),
		}
		if last == nil || current != *last {
			if encode(current) != nil {
				return
			}
			last = &current
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
