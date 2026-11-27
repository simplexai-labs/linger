package localtools

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/mcpproxy"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// startFakeLinuxDriver launches a tiny Python JSON-RPC MCP server simulating
// local_linux.py receipts so linux.go launch and error-surfacing paths can be
// verified deterministically on any host OS.
func startFakeLinuxDriver(t *testing.T, script string) *mcpClient {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	client, err := startClient(ctx, python, []string{"-u", "-c", script}, t.TempDir(), os.Environ())
	if err != nil {
		t.Fatalf("start fake driver: %v", err)
	}
	t.Cleanup(func() {
		if err := client.close(); err != nil {
			t.Errorf("close fake driver: %v", err)
		}
	})
	return client
}

func newTestLinuxOperation(t *testing.T, client *mcpClient) (*operation, *Manager) {
	t.Helper()
	prev := linuxHost
	linuxHost = func() bool { return true }
	t.Cleanup(func() { linuxHost = prev })

	root := t.TempDir()
	manager, err := New(Options{StateDirectory: filepath.Join(root, "state")})
	if err != nil {
		t.Fatal(err)
	}
	if manager.journal == nil {
		journal, err := openJournal(filepath.Join(root, "state", "computer-tools", "action.json"))
		if err != nil {
			t.Fatal(err)
		}
		manager.journal = journal
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	op := &operation{
		manager:  manager,
		ctx:      ctx,
		label:    "linux-launch-test",
		spec:     provider.OperationSpec{AgentID: "agent-1", WorkingDirectory: root},
		identity: mcpproxy.OperationIdentity{OperationID: "op-1"},
		linux:    client,
	}
	return op, manager
}

func TestLinuxOpenURLSurfacesImmediateLaunchErrorWithoutWaiting(t *testing.T) {
	script := `
import base64, json, sys
for line in sys.stdin:
    req = json.loads(line)
    if "id" not in req:
        continue
    m = req.get("method")
    if m == "initialize":
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}}}
    elif m == "tools/call":
        cmd = req["params"]["arguments"]["command"]
        if cmd == "active-window":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"123").decode()}
        elif cmd == "window-title":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"Terminal").decode()}
        elif cmd == "open":
            payload = {"status": "failed", "error": "xdg-open failed (exited with status 4): /user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-1.service is not a snap cgroup for tag snap.firefox.firefox"}
        elif cmd == "semantic-ui":
            payload = {"window": "Terminal", "app": "gnome-terminal", "elements": [{"ref": {"path": "1"}, "role": "terminal", "name": "bash"}]}
        else:
            payload = {"status": "confirmed", "output_base64": ""}
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
`
	client := startFakeLinuxDriver(t, script)
	op, manager := newTestLinuxOperation(t, client)

	started := time.Now()
	raw, err := op.linuxComputerCall(op.ctx, "open_url", json.RawMessage(`{"url":"https://example.com"}`))
	elapsed := time.Since(started)

	if err != nil {
		t.Fatalf("unexpected transport error: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("open_url waited %v instead of failing fast on launch error", elapsed)
	}
	var res struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatalf("unmarshal result: %v (%s)", err, raw)
	}
	if !res.IsError {
		t.Fatalf("expected tool error result, got: %s", raw)
	}
	if len(res.Content) == 0 || !strings.Contains(res.Content[0].Text, "is not a snap cgroup for tag snap.firefox.firefox") || !strings.Contains(res.Content[0].Text, "status 4") {
		t.Fatalf("expected snap cgroup launch error, got: %s", raw)
	}
	if strings.Contains(res.Content[0].Text, errURLNotOpened.Error()) {
		t.Fatalf("should not mask launch failure as generic errURLNotOpened: %s", raw)
	}
	if manager.journal.blocked() {
		t.Fatal("confirmed launch failure must not leave the action journal blocked")
	}
}

func TestLinuxOpenApplicationSurfacesImmediateLaunchErrorWithoutWaiting(t *testing.T) {
	script := `
import base64, json, sys
for line in sys.stdin:
    req = json.loads(line)
    if "id" not in req:
        continue
    m = req.get("method")
    if m == "initialize":
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}}}
    elif m == "tools/call":
        cmd = req["params"]["arguments"]["command"]
        if cmd == "active-window":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"123").decode()}
        elif cmd == "run":
            payload = {"status": "failed", "error": "firefox failed (exited with status 4): /user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-2.service is not a snap cgroup for tag snap.firefox.firefox"}
        elif cmd == "semantic-ui":
            payload = {"window": "Terminal", "app": "gnome-terminal", "elements": [{"ref": {"path": "1"}, "role": "terminal", "name": "bash"}]}
        else:
            payload = {"status": "confirmed", "output_base64": ""}
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
`
	client := startFakeLinuxDriver(t, script)
	op, manager := newTestLinuxOperation(t, client)

	started := time.Now()
	raw, err := op.linuxComputerCall(op.ctx, "open_application", json.RawMessage(`{"application":"firefox"}`))
	elapsed := time.Since(started)

	if err != nil {
		t.Fatalf("unexpected transport error: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("open_application waited %v instead of failing fast", elapsed)
	}
	var res struct {
		IsError bool `json:"isError"`
		Content []struct {
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if !res.IsError || len(res.Content) == 0 || !strings.Contains(res.Content[0].Text, "firefox failed (exited with status 4)") {
		t.Fatalf("expected immediate firefox launch error, got: %s", raw)
	}
	if manager.journal.blocked() {
		t.Fatal("confirmed launch failure must not leave the action journal blocked")
	}
}

func TestLinuxPostLaunchDiagnosticsEnrichOpenURLAndLateAppCrash(t *testing.T) {
	prevLaunchWait, prevWindowPoll, prevTreeWait := launchWait, windowPoll, launchTreeWait
	launchWait, windowPoll, launchTreeWait = 40*time.Millisecond, 10*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() {
		launchWait, windowPoll, launchTreeWait = prevLaunchWait, prevWindowPoll, prevTreeWait
	})

	script := `
import base64, json, sys
for line in sys.stdin:
    req = json.loads(line)
    if "id" not in req:
        continue
    m = req.get("method")
    if m == "initialize":
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}}}
    elif m == "tools/call":
        cmd = req["params"]["arguments"]["command"]
        args = req["params"]["arguments"].get("args", [])
        if cmd == "active-window":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"123").decode()}
        elif cmd == "window-title":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"Terminal").decode()}
        elif cmd == "launch-error":
            mode = args[0] if args else "open"
            if mode == "open":
                msg = b"async grandchild: is not a snap cgroup for tag snap.firefox.firefox"
            else:
                msg = b"firefox failed (exited with status 1): profile locked"
            payload = {"status": "confirmed", "output_base64": base64.b64encode(msg).decode()}
        elif cmd == "semantic-ui":
            payload = {"window": "Terminal", "app": "gnome-terminal", "elements": [{"ref": {"path": "1"}, "role": "terminal", "name": "bash"}]}
        else:
            payload = {"status": "confirmed", "output_base64": ""}
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
`
	client := startFakeLinuxDriver(t, script)
	op, _ := newTestLinuxOperation(t, client)

	rawURL, err := op.linuxComputerCall(op.ctx, "open_url", json.RawMessage(`{"url":"https://example.com"}`))
	if err != nil {
		t.Fatalf("open_url transport err: %v", err)
	}
	if !strings.Contains(string(rawURL), errURLNotOpened.Error()) || !strings.Contains(string(rawURL), "async grandchild: is not a snap cgroup for tag snap.firefox.firefox") {
		t.Fatalf("expected enriched errURLNotOpened, got: %s", rawURL)
	}

	rawApp, err := op.linuxComputerCall(op.ctx, "open_application", json.RawMessage(`{"application":"firefox"}`))
	if err != nil {
		t.Fatalf("open_application transport err: %v", err)
	}
	if !strings.Contains(string(rawApp), `"isError":true`) || !strings.Contains(string(rawApp), "profile locked") {
		t.Fatalf("expected late crash error for open_application, got: %s", rawApp)
	}
}

func TestLinuxOpenApplicationSlowRunningAppPreservesWindowOpenedFalse(t *testing.T) {
	prevLaunchWait, prevWindowPoll, prevTreeWait := launchWait, windowPoll, launchTreeWait
	launchWait, windowPoll, launchTreeWait = 30*time.Millisecond, 10*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() {
		launchWait, windowPoll, launchTreeWait = prevLaunchWait, prevWindowPoll, prevTreeWait
	})

	script := `
import base64, json, sys
for line in sys.stdin:
    req = json.loads(line)
    if "id" not in req:
        continue
    m = req.get("method")
    if m == "initialize":
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}}}
    elif m == "tools/call":
        cmd = req["params"]["arguments"]["command"]
        if cmd == "active-window":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"123").decode()}
        elif cmd == "semantic-ui":
            payload = {"window": "Terminal", "app": "gnome-terminal", "elements": [{"ref": {"path": "1"}, "role": "terminal", "name": "bash"}]}
        else:
            payload = {"status": "confirmed", "output_base64": ""}
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
`
	client := startFakeLinuxDriver(t, script)
	op, _ := newTestLinuxOperation(t, client)

	rawApp, err := op.linuxComputerCall(op.ctx, "open_application", json.RawMessage(`{"application":"gedit"}`))
	if err != nil {
		t.Fatalf("open_application transport err: %v", err)
	}
	if strings.Contains(string(rawApp), `"isError":true`) || !strings.Contains(string(rawApp), `"window_opened\":false`) {
		t.Fatalf("expected non-error result with window_opened:false, got: %s", rawApp)
	}
}

func TestLinuxRunActionsStopsImmediatelyOnLaunchFailure(t *testing.T) {
	script := `
import base64, json, sys
calls = []
for line in sys.stdin:
    req = json.loads(line)
    if "id" not in req:
        continue
    m = req.get("method")
    if m == "initialize":
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"protocolVersion": "2024-11-05", "capabilities": {"tools": {}}}}
    elif m == "tools/call":
        cmd = req["params"]["arguments"]["command"]
        calls.append(cmd)
        if cmd == "active-window":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"123").decode()}
        elif cmd == "window-title":
            payload = {"status": "confirmed", "output_base64": base64.b64encode(b"Terminal").decode()}
        elif cmd == "open":
            payload = {"status": "failed", "error": "xdg-open failed (exited with status 4): snap cgroup denied"}
        elif cmd == "type":
            payload = {"status": "failed", "error": "BUG: second step should never execute"}
        elif cmd == "semantic-ui":
            payload = {"window": "Terminal", "app": "gnome-terminal", "elements": [{"ref": {"path": "1"}, "role": "terminal", "name": "bash"}]}
        else:
            payload = {"status": "confirmed", "output_base64": ""}
        out = {"jsonrpc": "2.0", "id": req["id"], "result": {"content": [{"type": "text", "text": json.dumps(payload)}]}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
`
	client := startFakeLinuxDriver(t, script)
	op, manager := newTestLinuxOperation(t, client)

	started := time.Now()
	raw, err := op.runActions(op.ctx, json.RawMessage(`{"actions":[{"tool":"open_url","url":"https://example.com"},{"tool":"type_text","text":"should-not-run"}]}`))
	elapsed := time.Since(started)

	if err != nil {
		t.Fatalf("unexpected transport error: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("run_actions waited %v instead of failing fast", elapsed)
	}
	if !strings.Contains(string(raw), `"isError":true`) || !strings.Contains(string(raw), "snap cgroup denied") {
		t.Fatalf("expected snap cgroup error from run_actions, got: %s", raw)
	}
	if strings.Contains(string(raw), "BUG:") {
		t.Fatalf("subsequent batch step ran after launch failure: %s", raw)
	}
	if manager.journal.blocked() {
		t.Fatal("confirmed launch failure must not block action journal")
	}
}

func TestLinuxActionEmbeddedDriverLaunchErrorIsConfirmedFailure(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	binDir := t.TempDir()
	xdgOpen := filepath.Join(binDir, "xdg-open")
	script := "#!/bin/sh\necho '/user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-x.service is not a snap cgroup for tag snap.firefox.firefox' >&2\nexit 4\n"
	if err := os.WriteFile(xdgOpen, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	env := append(os.Environ(), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	client, err := startClient(ctx, python, []string{"-u", "-c", nativeLinuxProgram}, t.TempDir(), env)
	if err != nil {
		t.Fatalf("start embedded local_linux.py: %v", err)
	}
	defer func() {
		if err := client.close(); err != nil {
			t.Errorf("close embedded driver: %v", err)
		}
	}()

	_, err = linuxAction(ctx, client, "open", "https://example.com")
	if err == nil {
		t.Fatal("expected launch error from embedded local_linux.py")
	}
	if errors.Is(err, errOutcomeUnknown) {
		t.Fatalf("confirmed launch error must not be classified as errOutcomeUnknown: %v", err)
	}
	if !strings.Contains(err.Error(), "exited with status 4") || !strings.Contains(err.Error(), "is not a snap cgroup for tag snap.firefox.firefox") {
		t.Fatalf("unexpected launch error: %v", err)
	}
}

func TestLinuxEmbeddedDriverFiltersLdPreloadNoiseAndIgnoresStillRunningStderr(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	ldNoise := "ERROR: ld.so: object '/usr/local/lib/syslog.so' from /etc/ld.so.preload cannot be preloaded (cannot open shared object file): ignored."

	t.Run("nonzero_exit_strips_ld_preload_keeps_snap_error", func(t *testing.T) {
		binDir := t.TempDir()
		xdgOpen := filepath.Join(binDir, "xdg-open")
		script := "#!/bin/sh\necho \"" + ldNoise + "\" >&2\necho '/user.slice/user-1010.slice/user@1010.service/app.slice/linger-app-x.service is not a snap cgroup for tag snap.firefox.firefox' >&2\necho \"" + ldNoise + "\" >&2\nexit 4\n"
		if err := os.WriteFile(xdgOpen, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		env := append(os.Environ(), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		client, err := startClient(ctx, python, []string{"-u", "-c", nativeLinuxProgram}, t.TempDir(), env)
		if err != nil {
			t.Fatalf("start embedded driver: %v", err)
		}
		defer func() { _ = client.close() }()

		_, err = linuxAction(ctx, client, "open", "https://example.com")
		if err == nil {
			t.Fatal("expected launch error")
		}
		if strings.Contains(err.Error(), "cannot be preloaded") {
			t.Fatalf("ld.so.preload noise leaked into error: %v", err)
		}
		if !strings.Contains(err.Error(), "is not a snap cgroup for tag snap.firefox.firefox") {
			t.Fatalf("expected snap cgroup error, got: %v", err)
		}
	})

	t.Run("exited_zero_with_only_ld_preload_noise_has_empty_launch_error", func(t *testing.T) {
		binDir := t.TempDir()
		xdgOpen := filepath.Join(binDir, "xdg-open")
		script := "#!/bin/sh\necho \"" + ldNoise + "\" >&2\nexit 0\n"
		if err := os.WriteFile(xdgOpen, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		env := append(os.Environ(), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		client, err := startClient(ctx, python, []string{"-u", "-c", nativeLinuxProgram}, t.TempDir(), env)
		if err != nil {
			t.Fatalf("start embedded driver: %v", err)
		}
		defer func() { _ = client.close() }()

		if _, err := linuxAction(ctx, client, "open", "https://example.com"); err != nil {
			t.Fatalf("unexpected open error: %v", err)
		}
		detail, err := linuxAction(ctx, client, "launch-error", "open")
		if err != nil {
			t.Fatalf("launch-error failed: %v", err)
		}
		if strings.TrimSpace(string(detail)) != "" {
			t.Fatalf("expected empty launch-error for ld.so.preload-only exit 0, got: %q", string(detail))
		}
	})

	t.Run("still_running_process_stderr_does_not_pollute_timeout", func(t *testing.T) {
		binDir := t.TempDir()
		xdgOpen := filepath.Join(binDir, "xdg-open")
		script := "#!/bin/sh\necho \"" + ldNoise + "\" >&2\necho 'Gtk-WARNING: harmless startup log' >&2\nsleep 5\n"
		if err := os.WriteFile(xdgOpen, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
		env := append(os.Environ(), "PATH="+binDir+string(os.PathListSeparator)+os.Getenv("PATH"))
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		client, err := startClient(ctx, python, []string{"-u", "-c", nativeLinuxProgram}, t.TempDir(), env)
		if err != nil {
			t.Fatalf("start embedded driver: %v", err)
		}
		defer func() { _ = client.close() }()

		if _, err := linuxAction(ctx, client, "open", "https://example.com"); err != nil {
			t.Fatalf("unexpected open error: %v", err)
		}
		detail, err := linuxAction(ctx, client, "launch-error", "open")
		if err != nil {
			t.Fatalf("launch-error failed: %v", err)
		}
		if strings.TrimSpace(string(detail)) != "" {
			t.Fatalf("expected empty launch-error while process is still running, got: %q", string(detail))
		}
	})
}
