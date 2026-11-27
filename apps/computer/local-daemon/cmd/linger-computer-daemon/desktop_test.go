package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/localtools"
	localprocess "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

type fakeStatusSource struct {
	mu           sync.Mutex
	state        string
	active       int
	modelInvokes int
}

func (f *fakeStatusSource) GatewayState() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *fakeStatusSource) ActiveOperationCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.active
}

func (f *fakeStatusSource) ActiveModelInvokeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.modelInvokes
}

func (f *fakeStatusSource) set(state string, active int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.state, f.active = state, active
}

func (f *fakeStatusSource) setModelInvokes(modelInvokes int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.modelInvokes = modelInvokes
}

func TestDesktopChannelShutsDownOnStdinEOF(t *testing.T) {
	reader, writer := io.Pipe()
	channel := newDesktopChannel(io.Discard)
	done := make(chan struct{})
	go channel.read(reader, func() { close(done) })
	if _, err := writer.Write([]byte(`{"type":"hello","features":["permissions.v1"]}` + "\nnot json\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
		t.Fatal("shutdown before stdin closed")
	case <-time.After(20 * time.Millisecond):
	}
	_ = writer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not follow stdin EOF")
	}
	if _, err := channel.LingerPermissions(t.Context(), "status", ""); !errors.Is(err, localtools.ErrLingerBridgeUnavailable) {
		t.Fatalf("a closed channel accepted a request: %v", err)
	}
}

func TestReportDesktopStatusWritesChangesOnly(t *testing.T) {
	source := &fakeStatusSource{state: "connecting"}
	reader, writer := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	channel := newDesktopChannel(writer)
	go func() {
		reportDesktopStatus(ctx, channel.encode, source, 5*time.Millisecond)
		_ = writer.Close()
	}()
	lines := bufio.NewScanner(reader)
	next := func() desktopStatus {
		t.Helper()
		if !lines.Scan() {
			t.Fatal("status stream ended")
		}
		var status desktopStatus
		if err := json.Unmarshal(lines.Bytes(), &status); err != nil {
			t.Fatalf("line %q: %v", lines.Text(), err)
		}
		return status
	}
	if got := next(); got != (desktopStatus{Type: "status", GatewayState: "connecting"}) {
		t.Fatalf("first = %+v", got)
	}
	source.set("connected", 0)
	if got := next(); got.GatewayState != "connected" || got.ActiveOperations != 0 {
		t.Fatalf("second = %+v", got)
	}
	source.set("connected", 2)
	if got := next(); got.ActiveOperations != 2 || got.ActiveModelInvokes != 0 {
		t.Fatalf("third = %+v", got)
	}
	source.setModelInvokes(1)
	if got := next(); got.ActiveOperations != 2 || got.ActiveModelInvokes != 1 {
		t.Fatalf("fourth = %+v", got)
	}
	source.setModelInvokes(0)
	if got := next(); got.ActiveOperations != 2 || got.ActiveModelInvokes != 0 {
		t.Fatalf("fifth = %+v", got)
	}
	cancel()
	if lines.Scan() {
		t.Fatalf("unchanged state was repeated: %q", lines.Text())
	}
}

// fakeDesktop plays the Desktop app on the other end of the stdio pipes.
type fakeDesktop struct {
	channel *desktopChannel
	stdin   *io.PipeWriter
	lines   chan map[string]any
	done    chan struct{}
}

func startFakeDesktop(t *testing.T, timeout time.Duration) *fakeDesktop {
	t.Helper()
	stdinReader, stdinWriter := io.Pipe()
	stdoutReader, stdoutWriter := io.Pipe()
	desktop := &fakeDesktop{channel: newDesktopChannel(stdoutWriter), stdin: stdinWriter, lines: make(chan map[string]any, 64), done: make(chan struct{})}
	desktop.channel.timeout = timeout
	go desktop.channel.read(stdinReader, func() { close(desktop.done) })
	go func() {
		scanner := bufio.NewScanner(stdoutReader)
		for scanner.Scan() {
			var line map[string]any
			if err := json.Unmarshal(scanner.Bytes(), &line); err != nil {
				t.Errorf("stdout line %q is not one JSON object: %v", scanner.Text(), err)
				continue
			}
			desktop.lines <- line
		}
	}()
	t.Cleanup(func() {
		_ = stdinWriter.Close()
		_ = stdoutWriter.Close()
	})
	return desktop
}

func (f *fakeDesktop) send(t *testing.T, line string) {
	t.Helper()
	if _, err := f.stdin.Write([]byte(line + "\n")); err != nil {
		t.Fatal(err)
	}
}

// request returns the next permission request, skipping status lines.
func (f *fakeDesktop) request(t *testing.T) map[string]any {
	t.Helper()
	for {
		select {
		case line := <-f.lines:
			if line["type"] == "permission.request" {
				return line
			}
		case <-time.After(5 * time.Second):
			t.Fatal("no permission request")
		}
	}
}

func TestDesktopChannelWithoutHelloReportsUnavailable(t *testing.T) {
	desktop := startFakeDesktop(t, time.Second)
	if _, err := desktop.channel.LingerPermissions(t.Context(), "status", ""); !errors.Is(err, localtools.ErrLingerBridgeUnavailable) {
		t.Fatalf("err = %v", err)
	}
	desktop.send(t, `{"type":"hello","features":["other"]}`)
	time.Sleep(20 * time.Millisecond)
	if _, err := desktop.channel.LingerPermissions(t.Context(), "status", ""); !errors.Is(err, localtools.ErrLingerBridgeUnavailable) {
		t.Fatalf("a hello without permissions.v1 enabled requests: %v", err)
	}
	// The permission service then reports the app's permissions as unknown.
	service := localtools.NewComputerPermissions(localtools.ComputerPermissionOptions{Platform: "darwin", Desktop: true, Linger: desktop.channel})
	status, err := service.ComputerPermission(t.Context(), "status", "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range status.Subjects[0].Permissions {
		if item.State != "unknown" || item.Prompt != "settings_only" {
			t.Fatalf("linger = %+v", status.Subjects[0])
		}
	}
}

func TestDesktopChannelRoundTripsRequestsBesideStatusLines(t *testing.T) {
	desktop := startFakeDesktop(t, 5*time.Second)
	desktop.send(t, `{"type":"hello","features":["permissions.v1"]}`)
	time.Sleep(20 * time.Millisecond)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	source := &fakeStatusSource{state: "connecting"}
	go reportDesktopStatus(ctx, desktop.channel.encode, source, time.Millisecond)
	go func() {
		for i := 0; ctx.Err() == nil; i++ {
			source.set("connecting", i)
			time.Sleep(time.Millisecond)
		}
	}()

	type answer struct {
		permissions []localtools.LingerPermission
		err         error
	}
	answers := make(chan answer, 2)
	go func() {
		permissions, err := desktop.channel.LingerPermissions(ctx, "prompt", "screen_recording")
		answers <- answer{permissions, err}
	}()
	first := desktop.request(t)
	if first["op"] != "prompt" || first["permission"] != "screen_recording" || first["id"] == "" {
		t.Fatalf("request = %v", first)
	}
	go func() {
		permissions, err := desktop.channel.LingerPermissions(ctx, "status", "")
		answers <- answer{permissions, err}
	}()
	second := desktop.request(t)
	if _, ok := second["permission"]; ok || second["op"] != "status" {
		t.Fatalf("status request = %v", second)
	}
	// Answers arrive out of order; each reaches its own request.
	desktop.send(t, `{"type":"permission.response","id":"`+second["id"].(string)+`","ok":false,"error":"busy"}`)
	desktop.send(t, `{"type":"permission.response","id":"unknown","ok":true,"permissions":[]}`)
	desktop.send(t, `{"type":"permission.response","id":"`+first["id"].(string)+`","ok":true,"permissions":[{"id":"screen_recording","state":"denied","relaunch_required":true},{"id":"accessibility","state":"granted","relaunch_required":false}]}`)
	var refused *localtools.LingerBridgeError
	for range 2 {
		got := <-answers
		switch {
		case errors.As(got.err, &refused):
			if refused.Code != "busy" {
				t.Fatalf("refusal = %+v", refused)
			}
		case got.err != nil:
			t.Fatal(got.err)
		case len(got.permissions) != 2 || got.permissions[0] != (localtools.LingerPermission{ID: "screen_recording", State: "denied", RelaunchRequired: true}):
			t.Fatalf("permissions = %+v", got.permissions)
		}
	}
	if refused == nil {
		t.Fatal("the refusal did not reach its request")
	}
}

func TestDesktopChannelRequestTimesOut(t *testing.T) {
	desktop := startFakeDesktop(t, 30*time.Millisecond)
	desktop.send(t, `{"type":"hello","features":["permissions.v1"]}`)
	time.Sleep(20 * time.Millisecond)
	result := make(chan error, 1)
	go func() {
		_, err := desktop.channel.LingerPermissions(t.Context(), "status", "")
		result <- err
	}()
	request := desktop.request(t)
	if err := <-result; !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	// A late answer finds no waiter and changes nothing.
	desktop.send(t, `{"type":"permission.response","id":"`+request["id"].(string)+`","ok":true,"permissions":[]}`)
	desktop.channel.mu.Lock()
	pending := len(desktop.channel.pending)
	desktop.channel.mu.Unlock()
	if pending != 0 {
		t.Fatalf("pending = %d", pending)
	}

	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		_, err := desktop.channel.LingerPermissions(ctx, "status", "")
		result <- err
	}()
	desktop.request(t)
	cancel()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("a canceled request kept waiting: %v", err)
	}
}

func TestDesktopChannelFailsPendingRequestsAtEOF(t *testing.T) {
	desktop := startFakeDesktop(t, 5*time.Second)
	desktop.send(t, `{"type":"hello","features":["permissions.v1"]}`)
	time.Sleep(20 * time.Millisecond)
	result := make(chan error, 1)
	go func() {
		_, err := desktop.channel.LingerPermissions(t.Context(), "relaunch", "")
		result <- err
	}()
	desktop.request(t)
	_ = desktop.stdin.Close()
	select {
	case err := <-result:
		if err == nil || !strings.Contains(err.Error(), "closed") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("the request outlived stdin")
	}
	<-desktop.done
}

func TestDesktopChannelCrashStopRunsOnUnexpectedEOF(t *testing.T) {
	reader, writer := io.Pipe()
	channel := newDesktopChannel(io.Discard)
	var got *localModelsStopSpec
	channel.startCrashStop = func(spec *localModelsStopSpec) error {
		got = spec
		return nil
	}
	done := make(chan struct{})
	go channel.read(reader, func() { close(done) })

	root := t.TempDir()
	exe := filepath.Join(root, "linger")
	logFile := filepath.Join(root, "installer", "local-models-stop.log")
	armLine, err := json.Marshal(map[string]any{
		"type":       "local_models_stop.arm",
		"executable": exe,
		"args":       []string{filepath.Join(root, "installer.js"), "--home", root, "--stop-local-models"},
		"log_file":   logFile,
		"env":        map[string]string{"ELECTRON_RUN_AS_NODE": "1"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write(append(armLine, '\n')); err != nil {
		t.Fatal(err)
	}
	// Closing stdin without a preceding shutdown line simulates Desktop crash.
	_ = writer.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not follow stdin EOF")
	}
	if got == nil {
		t.Fatal("expected crash stop to run on unexpected EOF")
	}
	if got.Executable != exe || got.LogFile != logFile || got.Env["ELECTRON_RUN_AS_NODE"] != "1" {
		t.Fatalf("unexpected crash stop spec: %+v", got)
	}
	if !slices.Contains(got.Args, "--stop-local-models") {
		t.Fatalf("missing --stop-local-models in args: %v", got.Args)
	}
}

func TestDesktopChannelPlannedShutdownSkipsCrashStop(t *testing.T) {
	for _, reason := range []string{"quit", "update", "logout", "restart"} {
		t.Run(reason, func(t *testing.T) {
			reader, writer := io.Pipe()
			channel := newDesktopChannel(io.Discard)
			called := false
			channel.startCrashStop = func(*localModelsStopSpec) error {
				called = true
				return nil
			}
			done := make(chan struct{})
			go channel.read(reader, func() { close(done) })

			root := t.TempDir()
			armLine, err := json.Marshal(map[string]any{
				"type":       "local_models_stop.arm",
				"executable": filepath.Join(root, "linger"),
				"args":       []string{filepath.Join(root, "installer.js"), "--home", root, "--stop-local-models"},
				"log_file":   filepath.Join(root, "local-models-stop.log"),
				"env":        map[string]string{"ELECTRON_RUN_AS_NODE": "1"},
			})
			if err != nil {
				t.Fatal(err)
			}
			shutdownLine, err := json.Marshal(map[string]any{
				"type":   "shutdown",
				"reason": reason,
			})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write(append(armLine, '\n')); err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write(append(shutdownLine, '\n')); err != nil {
				t.Fatal(err)
			}
			_ = writer.Close()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("shutdown did not follow stdin EOF")
			}
			if called {
				t.Fatalf("crash stop ran despite planned shutdown (%s)", reason)
			}
		})
	}
}

func TestDesktopChannelDisarmAndInvalidSpecsSkipCrashStop(t *testing.T) {
	t.Run("disarm", func(t *testing.T) {
		reader, writer := io.Pipe()
		channel := newDesktopChannel(io.Discard)
		called := false
		channel.startCrashStop = func(*localModelsStopSpec) error {
			called = true
			return nil
		}
		done := make(chan struct{})
		go channel.read(reader, func() { close(done) })

		root := t.TempDir()
		armLine, _ := json.Marshal(map[string]any{
			"type":       "local_models_stop.arm",
			"executable": filepath.Join(root, "linger"),
			"args":       []string{"--stop-local-models"},
			"env":        map[string]string{"ELECTRON_RUN_AS_NODE": "1"},
		})
		if _, err := writer.Write(append(armLine, '\n')); err != nil {
			t.Fatal(err)
		}
		if _, err := writer.Write([]byte(`{"type":"local_models_stop.disarm"}` + "\n")); err != nil {
			t.Fatal(err)
		}
		_ = writer.Close()
		<-done
		if called {
			t.Fatal("crash stop ran after disarm")
		}
	})

	root := t.TempDir()
	absExe := filepath.Join(root, "linger")
	invalidCases := []struct {
		name string
		line desktopLine
	}{
		{
			name: "relative executable",
			line: desktopLine{Executable: "linger", Args: []string{"--stop-local-models"}},
		},
		{
			name: "missing stop flag",
			line: desktopLine{Executable: absExe, Args: []string{"--home", root}},
		},
		{
			name: "relative log file",
			line: desktopLine{Executable: absExe, Args: []string{"--stop-local-models"}, LogFile: "relative.log"},
		},
		{
			name: "credential env key rejected",
			line: desktopLine{Executable: absExe, Args: []string{"--stop-local-models"}, Env: map[string]string{"linger_computer_token": "secret"}},
		},
		{
			name: "invalid env key",
			line: desktopLine{Executable: absExe, Args: []string{"--stop-local-models"}, Env: map[string]string{"A=B": "1"}},
		},
	}
	for _, tc := range invalidCases {
		t.Run(tc.name, func(t *testing.T) {
			if spec, ok := validateLocalModelsStop(tc.line); ok || spec != nil {
				t.Fatalf("expected invalid spec to be rejected, got %+v", spec)
			}
		})
	}
}

func TestCrashStopEnvironmentStripsTokenAndAppliesOverlay(t *testing.T) {
	base := []string{
		"PATH=/usr/bin",
		"LINGER_COMPUTER_TOKEN=sr1.secret.token",
		"linger_computer_token=sr1.secret.lower",
		"ELECTRON_RUN_AS_NODE=0",
		"HOME=/home/test",
	}
	got := crashStopEnvironment(base, map[string]string{
		"ELECTRON_RUN_AS_NODE": "1",
		"SIMPLEX_REGION":       "global",
	})
	for _, entry := range got {
		name, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "LINGER_COMPUTER_TOKEN") {
			t.Fatalf("credential leaked into crash stop environment: %q", entry)
		}
	}
	if !slices.Contains(got, "ELECTRON_RUN_AS_NODE=1") {
		t.Fatalf("missing ELECTRON_RUN_AS_NODE=1 in %v", got)
	}
	if slices.Contains(got, "ELECTRON_RUN_AS_NODE=0") {
		t.Fatalf("old ELECTRON_RUN_AS_NODE=0 was not replaced in %v", got)
	}
	if !slices.Contains(got, "SIMPLEX_REGION=global") {
		t.Fatalf("missing SIMPLEX_REGION=global in %v", got)
	}
}

func TestCrashStopHelperProcess(t *testing.T) {
	if os.Getenv("LINGER_TEST_CRASH_STOP_HELPER") != "1" {
		return
	}
	marker := os.Getenv("LINGER_TEST_CRASH_STOP_MARKER")
	payload, _ := json.Marshal(map[string]any{
		"args":        os.Args,
		"run_as_node": os.Getenv("ELECTRON_RUN_AS_NODE"),
		"has_token":   os.Getenv("LINGER_COMPUTER_TOKEN") != "",
	})
	_, _ = os.Stdout.Write(append(payload, '\n'))
	if marker != "" {
		_ = os.WriteFile(marker, payload, 0o600)
	}
	os.Exit(0)
}

func TestStartDetachedLocalModelsStopRealProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	logFile := filepath.Join(dir, "installer", "local-models-stop.log")
	marker := filepath.Join(dir, "done.json")
	t.Setenv("LINGER_COMPUTER_TOKEN", "sr1.must-not-leak")

	spec := &localModelsStopSpec{
		Executable: exe,
		Args:       []string{"-test.run=^TestCrashStopHelperProcess$", "--", "--stop-local-models"},
		LogFile:    logFile,
		Env: map[string]string{
			"ELECTRON_RUN_AS_NODE":          "1",
			"LINGER_TEST_CRASH_STOP_HELPER": "1",
			"LINGER_TEST_CRASH_STOP_MARKER": marker,
		},
	}
	if err := startDetachedLocalModelsStop(spec); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, readErr := os.ReadFile(marker)
		if readErr == nil && len(raw) > 0 {
			var doc struct {
				Args      []string `json:"args"`
				RunAsNode string   `json:"run_as_node"`
				HasToken  bool     `json:"has_token"`
			}
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatalf("parse marker %q: %v", string(raw), err)
			}
			if doc.RunAsNode != "1" {
				t.Fatalf("ELECTRON_RUN_AS_NODE = %q, want 1", doc.RunAsNode)
			}
			if doc.HasToken {
				t.Fatal("LINGER_COMPUTER_TOKEN leaked into detached stop helper")
			}
			if !slices.Contains(doc.Args, "--stop-local-models") {
				t.Fatalf("args = %v", doc.Args)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for detached stop helper (GOOS=%s)", runtime.GOOS)
		}
		time.Sleep(25 * time.Millisecond)
	}
	logBytes, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("read stop log: %v", err)
	}
	if !strings.Contains(string(logBytes), `"run_as_node":"1"`) {
		t.Fatalf("unexpected stop log content: %q", string(logBytes))
	}
}

// TestDesktopCrashParentHelper simulates Desktop spawning the daemon detached
// (outside any parent Job Object on Windows / in its own group on Unix),
// arming local_models_stop.arm over stdin, and blocking until hard-killed.
func TestDesktopCrashParentHelper(t *testing.T) {
	if os.Getenv("LINGER_TEST_CRASH_PARENT") != "1" {
		return
	}
	exe, err := os.Executable()
	if err != nil {
		os.Exit(2)
	}
	daemon := exec.Command(exe, "-test.run=^TestDesktopCrashDaemonHelper$")
	daemon.Env = append(os.Environ(),
		"LINGER_TEST_CRASH_PARENT=",
		"LINGER_TEST_CRASH_DAEMON=1",
		"LINGER_COMPUTER_TOKEN=sr1.must-not-leak-parent",
	)
	localprocess.Prepare(daemon)
	stdin, err := daemon.StdinPipe()
	if err != nil {
		os.Exit(3)
	}
	stdout, err := daemon.StdoutPipe()
	if err != nil {
		os.Exit(4)
	}
	if err := daemon.Start(); err != nil {
		os.Exit(5)
	}
	armLine := os.Getenv("LINGER_TEST_CRASH_ARM_LINE")
	if _, err := stdin.Write([]byte(armLine + "\n")); err != nil {
		os.Exit(6)
	}
	scanner := bufio.NewScanner(stdout)
	if !scanner.Scan() || scanner.Text() != "armed" {
		os.Exit(7)
	}
	_, _ = os.Stdout.WriteString("ready\n")
	select {}
}

// TestDesktopCrashDaemonHelper runs the real desktopChannel.read loop over
// os.Stdin and exits once shutdown fires after stdin EOF.
func TestDesktopCrashDaemonHelper(t *testing.T) {
	if os.Getenv("LINGER_TEST_CRASH_DAEMON") != "1" {
		return
	}
	channel := newDesktopChannel(io.Discard)
	readySignaled := false
	origRead := func(r io.Reader) {
		lines := bufio.NewScanner(r)
		lines.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		pr, pw := io.Pipe()
		done := make(chan struct{})
		go channel.read(pr, func() { close(done) })
		for lines.Scan() {
			_, _ = pw.Write(append(slices.Clone(lines.Bytes()), '\n'))
			if !readySignaled {
				readySignaled = true
				// Wait briefly for channel.receive to process the arm line.
				for range 200 {
					channel.mu.Lock()
					armed := channel.crashStop != nil
					channel.mu.Unlock()
					if armed {
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
				_, _ = os.Stdout.WriteString("armed\n")
			}
		}
		_ = pw.Close()
		<-done
	}
	origRead(os.Stdin)
	if marker := os.Getenv("LINGER_TEST_CRASH_DAEMON_EXITED"); marker != "" {
		_ = os.WriteFile(marker, []byte("exited"), 0o600)
	}
	os.Exit(0)
}

func TestDesktopCrashParentKillTriggersDetachedStopHelper(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	logFile := filepath.Join(dir, "installer", "local-models-stop.log")
	stopMarker := filepath.Join(dir, "stop-ran.json")
	daemonExited := filepath.Join(dir, "daemon-exited")

	armLine, err := json.Marshal(map[string]any{
		"type":       "local_models_stop.arm",
		"executable": exe,
		"args":       []string{"-test.run=^TestCrashStopHelperProcess$", "--", "--stop-local-models"},
		"log_file":   logFile,
		"env": map[string]string{
			"ELECTRON_RUN_AS_NODE":          "1",
			"LINGER_TEST_CRASH_STOP_HELPER": "1",
			"LINGER_TEST_CRASH_STOP_MARKER": stopMarker,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	parent := exec.Command(exe, "-test.run=^TestDesktopCrashParentHelper$")
	parent.Env = append(os.Environ(),
		"LINGER_TEST_CRASH_PARENT=1",
		"LINGER_TEST_CRASH_ARM_LINE="+string(armLine),
		"LINGER_TEST_CRASH_DAEMON_EXITED="+daemonExited,
	)
	stdout, err := parent.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := parent.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if parent.Process != nil {
			_ = parent.Process.Kill()
			_ = parent.Wait()
		}
	})
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
			return
		}
		ready <- ""
	}()
	select {
	case line := <-ready:
		if line != "ready" {
			t.Fatalf("parent helper did not signal ready (got %q)", line)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("timed out waiting for parent helper to arm daemon")
	}

	// Hard-kill the parent (SIGKILL on Unix, TerminateProcess on Windows).
	if err := parent.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = parent.Wait()

	deadline := time.Now().Add(15 * time.Second)
	for {
		raw, readErr := os.ReadFile(stopMarker)
		_, exitedErr := os.Stat(daemonExited)
		if readErr == nil && len(raw) > 0 && exitedErr == nil {
			var doc struct {
				Args      []string `json:"args"`
				RunAsNode string   `json:"run_as_node"`
				HasToken  bool     `json:"has_token"`
			}
			if err := json.Unmarshal(raw, &doc); err != nil {
				t.Fatalf("parse stop marker %q: %v", string(raw), err)
			}
			if doc.RunAsNode != "1" {
				t.Fatalf("ELECTRON_RUN_AS_NODE = %q, want 1", doc.RunAsNode)
			}
			if doc.HasToken {
				t.Fatal("LINGER_COMPUTER_TOKEN leaked into detached stop helper")
			}
			if !slices.Contains(doc.Args, "--stop-local-models") {
				t.Fatalf("args = %v", doc.Args)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for crash stop after parent kill (GOOS=%s, stopErr=%v, daemonExitErr=%v)", runtime.GOOS, readErr, exitedErr)
		}
		time.Sleep(25 * time.Millisecond)
	}
}
