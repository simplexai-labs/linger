package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

const (
	testAgyProtocolHelperEnv = "LINGER_TEST_AGY_PROTOCOL_HELPER"
	testAgyProtocolModeEnv   = "LINGER_TEST_AGY_PROTOCOL_MODE"
	testAgyProtocolTraceEnv  = "LINGER_TEST_AGY_PROTOCOL_TRACE"
	testAgyPruneBaseEnv      = "LINGER_TEST_AGY_PRUNE_BASE"
)

func init() {
	metaPath := os.Getenv(testAgyProtocolHelperEnv)
	if metaPath == "" {
		return
	}
	os.Exit(runAgyProtocolHelper(metaPath, os.Args[1:]))
}

func captureProbeLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var output bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	return &output
}

func runAgyProtocolHelper(metaPath string, args []string) int {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println("agy 1.5.12")
		return 0
	}
	if len(args) == 0 || args[0] != "acp" {
		return 2
	}
	var geminiDir, logFile string
	for i := 1; i < len(args); i += 2 {
		if i+1 >= len(args) {
			return 2
		}
		switch args[i] {
		case "--gemini-dir":
			geminiDir = args[i+1]
		case "--log-file":
			logFile = args[i+1]
		default:
			return 2
		}
	}
	if !filepath.IsAbs(geminiDir) || !filepath.IsAbs(logFile) {
		return 3
	}
	_ = os.WriteFile(logFile, []byte("init\n"), 0o600)
	var appDataEntries []string
	if entries, err := os.ReadDir(filepath.Join(geminiDir, "antigravity-cli")); err == nil {
		for _, entry := range entries {
			appDataEntries = append(appDataEntries, entry.Name())
		}
	}
	cwd, _ := os.Getwd()
	privateOK := privatefs.CheckPath(geminiDir, "directory", true) == nil
	pruneRemoved := 0
	pruneErrText := ""
	if pruneBase := os.Getenv(testAgyPruneBaseEnv); pruneBase != "" {
		removed, _, err := localworkspace.PruneOperationTemps(pruneBase, nil)
		pruneRemoved = removed
		if err != nil {
			pruneErrText = err.Error()
		}
	}
	meta, _ := json.Marshal(map[string]any{
		"geminiDir":      geminiDir,
		"logFile":        logFile,
		"cwd":            cwd,
		"appDataEntries": appDataEntries,
		"privateCheckOK": privateOK,
		"pruneRemoved":   pruneRemoved,
		"pruneError":     pruneErrText,
	})
	_ = os.WriteFile(metaPath, meta, 0o600)
	if tracePath := os.Getenv(testAgyProtocolTraceEnv); tracePath != "" {
		if file, err := os.OpenFile(tracePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			_, _ = file.Write(append(meta, '\n'))
			_ = file.Close()
		}
	}
	mode := os.Getenv(testAgyProtocolModeEnv)
	if mode == "exit-error" {
		fmt.Fprintln(os.Stderr, "simulated protocol handshake exit failure")
		return 2
	}
	decoder := json.NewDecoder(os.Stdin)
	handled := 0
	for {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		err := decoder.Decode(&request)
		if errors.Is(err, io.EOF) {
			if handled == 0 {
				return 4
			}
			return 0
		}
		if err != nil {
			return 4
		}
		handled++
		switch request.Method {
		case "initialize":
			protocolVersion := 1
			if mode == "wrong-version" {
				protocolVersion = 99
			}
			response, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result":  map[string]any{"protocolVersion": protocolVersion},
			})
			fmt.Println(string(response))
		case "session/new":
			if mode == "auth-error" {
				fmt.Fprintln(os.Stderr, "simulated session/new error")
				return 5
			}
			if mode == "auth-required" {
				response, _ := json.Marshal(map[string]any{
					"jsonrpc": "2.0",
					"id":      request.ID,
					"error":   map[string]any{"code": -32000, "message": "Authentication required"},
				})
				fmt.Println(string(response))
				continue
			}
			response, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"result": map[string]any{
					"sessionId": "probe-session",
					"models": map[string]any{
						"availableModels": []any{
							map[string]any{"modelId": "gemini-pro-low", "name": "Gemini Pro (Low)"},
						},
						"currentModelId": "gemini-pro-low",
					},
					"configOptions": []any{
						map[string]any{
							"id":           "model",
							"category":     "model",
							"currentValue": "gemini-pro",
							"options": []any{
								map[string]any{"value": "gemini-pro", "name": "Gemini Pro"},
							},
						},
					},
				},
			})
			fmt.Println(string(response))
		default:
			response, _ := json.Marshal(map[string]any{
				"jsonrpc": "2.0",
				"id":      request.ID,
				"error":   map[string]any{"code": -32601, "message": "method not found"},
			})
			fmt.Println(string(response))
		}
	}
}

func TestAntigravityProtocolProbeIsolatesGeminiDirAndLogFile(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	userAppData := filepath.Join(home, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(filepath.Join(userAppData, "antigravity-oauth-token"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userAppData, "settings.json"), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	metaFile := filepath.Join(t.TempDir(), "protocol-meta.json")
	env := map[string]string{
		"HOME":                   home,
		testAgyProtocolHelperEnv: metaFile,
	}
	if err := probeRuntimeProtocol(context.Background(), "antigravity", executable, env, 5*time.Second, ""); err != nil {
		t.Fatalf("antigravity protocol probe failed: %v", err)
	}
	rawMeta, err := os.ReadFile(metaFile)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		GeminiDir      string   `json:"geminiDir"`
		LogFile        string   `json:"logFile"`
		AppDataEntries []string `json:"appDataEntries"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	if !filepath.IsAbs(meta.GeminiDir) || !filepath.IsAbs(meta.LogFile) {
		t.Fatalf("expected absolute isolated paths, got %+v", meta)
	}
	if len(meta.AppDataEntries) != 0 {
		t.Fatalf("protocol probe must not copy user credentials or settings: %v", meta.AppDataEntries)
	}
	if _, err := os.Stat(filepath.Dir(meta.GeminiDir)); !os.IsNotExist(err) {
		t.Fatalf("temporary probe root was not cleaned up: %q (err=%v)", filepath.Dir(meta.GeminiDir), err)
	}
	if _, err := os.Stat(filepath.Join(userAppData, "log")); !os.IsNotExist(err) {
		t.Fatalf("protocol probe created log dir under HOME: err=%v", err)
	}
}

func isPathWithin(base, target string) bool {
	rel, err := filepath.Rel(base, target)
	return err == nil && rel != "." && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

func TestAntigravityProtocolProbeUsesTempBaseAndProtectsActiveDir(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	tempBase := filepath.Join(root, "state", "operation-tmp")
	metaFile := filepath.Join(root, "protocol-meta.json")
	badTemp := filepath.Join(root, "not-a-dir")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badTemp, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", badTemp)
	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)

	env := map[string]string{
		"HOME":                   home,
		testAgyProtocolHelperEnv: metaFile,
		testAgyPruneBaseEnv:      tempBase,
	}
	if err := probeRuntimeProtocol(context.Background(), "antigravity", executable, env, 5*time.Second, tempBase); err != nil {
		t.Fatalf("antigravity protocol probe in tempBase failed: %v", err)
	}
	rawMeta, err := os.ReadFile(metaFile)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		GeminiDir      string `json:"geminiDir"`
		LogFile        string `json:"logFile"`
		PrivateCheckOK bool   `json:"privateCheckOK"`
		PruneRemoved   int    `json:"pruneRemoved"`
		PruneError     string `json:"pruneError"`
	}
	if err := json.Unmarshal(rawMeta, &meta); err != nil {
		t.Fatal(err)
	}
	if !isPathWithin(tempBase, meta.GeminiDir) || !isPathWithin(tempBase, meta.LogFile) {
		t.Fatalf("expected probe paths inside tempBase %q, got %+v", tempBase, meta)
	}
	if !meta.PrivateCheckOK {
		t.Fatalf("active probe gemini dir failed privatefs.CheckPath: %+v", meta)
	}
	if meta.PruneRemoved != 0 || meta.PruneError != "" {
		t.Fatalf("concurrent PruneOperationTemps touched active probe dir: %+v", meta)
	}
	entries, err := os.ReadDir(tempBase)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("tempBase was not cleaned up after probe: %v", entries)
	}
}

func TestAntigravityProtocolProbePreparationFailureReportsDiagnosticFailed(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	fileBase := filepath.Join(root, "blocked-temp-base")
	if err := os.WriteFile(fileBase, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	logged := captureProbeLog(t)
	outcome := probeRuntime(
		context.Background(),
		"antigravity",
		executable,
		map[string]string{"HOME": root, testAgyProtocolHelperEnv: filepath.Join(root, "meta.json")},
		5*time.Second,
		probeOptions{tempBase: fileBase},
	)
	if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" {
		t.Fatalf("outcome = %+v, want error RUNTIME_DIAGNOSTIC_FAILED (not RUNTIME_INCOMPATIBLE)", outcome)
	}
	if strings.Contains(outcome.Message, fileBase) {
		t.Fatalf("outcome.Message leaked local path %q: %q", fileBase, outcome.Message)
	}
	logOutput := logged.String()
	for _, want := range []string{"runner.runtime_probe.prepare_failed", "runtime_type=antigravity"} {
		if !strings.Contains(logOutput, want) {
			t.Fatalf("log lacks %q: %s", want, logOutput)
		}
	}
}

func TestAntigravityProtocolHandshakeMismatchStillReportsIncompatible(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"exit-error", "wrong-version"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			tempBase := filepath.Join(root, "state", "operation-tmp")
			outcome := probeRuntime(
				context.Background(),
				"antigravity",
				executable,
				map[string]string{
					"HOME":                   root,
					testAgyProtocolHelperEnv: filepath.Join(root, "meta.json"),
					testAgyProtocolModeEnv:   mode,
				},
				5*time.Second,
				probeOptions{tempBase: tempBase},
			)
			if outcome.Status != "incompatible" || outcome.Code != "RUNTIME_INCOMPATIBLE" || outcome.Message != "Runtime protocol handshake failed" {
				t.Fatalf("mode %q outcome = %+v, want incompatible RUNTIME_INCOMPATIBLE", mode, outcome)
			}
			entries, err := os.ReadDir(tempBase)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 0 {
				t.Fatalf("tempBase leaked entries after failed handshake: %v", entries)
			}
		})
	}
}

func TestProtocolProbeWaitsForInitializeBeforeClosingInput(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	stdout, _, err := runBoundedProbe(context.Background(), executable,
		[]string{"-test.run=^TestProtocolProbeProcess$"},
		map[string]string{"LINGER_TEST_PROTOCOL_HELPER": "delayed"},
		`{"id":1,"method":"initialize"}`+"\n", 5*time.Second)
	if err != nil {
		t.Fatalf("probe failed: %v; output=%s", err, stdout)
	}
	if !strings.Contains(stdout, `{"id":1,"result":{"userAgent":"probe"}}`) {
		t.Fatalf("missing initialize result: %s", stdout)
	}
}

func TestProtocolProbeCancellationClosesUnresponsiveRuntime(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	started := time.Now()
	_, _, err = runBoundedProbe(ctx, executable,
		[]string{"-test.run=^TestProtocolProbeProcess$"},
		map[string]string{"LINGER_TEST_PROTOCOL_HELPER": "unresponsive"},
		`{"id":1,"method":"initialize"}`+"\n", 5*time.Second)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected cancellation, got %v", err)
	}
	if time.Since(started) > 3*time.Second {
		t.Fatal("probe did not terminate within cleanup budget")
	}
}

func TestClaudeProtocolProbeRequiresMatchingInitialization(t *testing.T) {
	for _, test := range []struct {
		name, frame string
		matched     bool
	}{
		{"success", `{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}`, true},
		{"wrong request", `{"type":"control_response","response":{"subtype":"success","request_id":"another-request"}}`, false},
		{"rejected", `{"type":"control_response","response":{"subtype":"error","request_id":"linger-computer-doctor"}}`, false},
		{"session announcement", `{"type":"system","subtype":"init","session_id":"session"}`, false},
		{"missing response", `{"type":"control_response"}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			var frame map[string]any
			if err := json.Unmarshal([]byte(test.frame), &frame); err != nil {
				t.Fatal(err)
			}
			if got := protocolProbeResponseMatches("claude", frame); got != test.matched {
				t.Fatalf("matched = %v, want %v", got, test.matched)
			}
		})
	}
}

func TestClaudeProtocolProbeClosesInputAfterSplitInitialization(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = runBoundedProbe(context.Background(), executable,
		[]string{"-test.run=^TestProtocolProbeProcess$"},
		map[string]string{"LINGER_TEST_PROTOCOL_HELPER": "claude"},
		`{"type":"control_request","request_id":"linger-computer-doctor","request":{"subtype":"initialize"}}`+"\n", 5*time.Second)
	if err != nil {
		t.Fatalf("Claude initialize did not close stdin cleanly: %v", err)
	}
}

func TestClaudeProbesDisableNonessentialTrafficWithoutMutatingCallerEnv(t *testing.T) {
	original := map[string]string{"ANTHROPIC_BASE_URL": "http://127.0.0.1:8080/anthropic"}
	derived := native.ClaudeEnvironment(original)
	if derived["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] != "1" {
		t.Fatalf("native.ClaudeEnvironment() = %+v, want CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", derived)
	}
	if _, mutated := original["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]; mutated {
		t.Fatal("native.ClaudeEnvironment mutated caller environment map")
	}
	if runtime.GOOS == "windows" {
		return
	}
	root := t.TempDir()
	claude := filepath.Join(root, "claude")
	script := `#!/bin/sh
want="${EXPECTED_NONESSENTIAL:-1}"
if [ "$CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC" != "$want" ]; then exit 11; fi
if [ "$1 $2 $3" = "auth status --json" ]; then
  echo '{"loggedIn":true}'
  exit 0
fi
IFS= read -r _request
echo '{"type":"control_response","response":{"subtype":"success","request_id":"linger-computer-doctor"}}'
exit 0
`
	if err := os.WriteFile(claude, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	callerEnv := map[string]string{"HOME": root, "PATH": root}
	outcome := probeClaudeAuthStatus(context.Background(), claude, callerEnv, 5*time.Second)
	if outcome.Status != "ready" {
		t.Fatalf("probeClaudeAuthStatus() = %+v, want ready", outcome)
	}
	if _, mutated := callerEnv["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]; mutated {
		t.Fatal("probeClaudeAuthStatus mutated caller environment map")
	}
	if err := probeRuntimeProtocol(context.Background(), "claude", claude, callerEnv, 5*time.Second, ""); err != nil {
		t.Fatalf("probeRuntimeProtocol(claude) = %v, want nil", err)
	}
	if _, mutated := callerEnv["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"]; mutated {
		t.Fatal("probeRuntimeProtocol mutated caller environment map")
	}
	overrideEnv := map[string]string{
		"HOME": root,
		"PATH": root,
		"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "0",
		"EXPECTED_NONESSENTIAL":                    "0",
	}
	if outcome := probeClaudeAuthStatus(context.Background(), claude, overrideEnv, 5*time.Second); outcome.Status != "ready" {
		t.Fatalf("probeClaudeAuthStatus(override) = %+v, want ready", outcome)
	}
	if err := probeRuntimeProtocol(context.Background(), "claude", claude, overrideEnv, 5*time.Second, ""); err != nil {
		t.Fatalf("probeRuntimeProtocol(claude, override) = %v, want nil", err)
	}
}

func TestProtocolProbeProcess(t *testing.T) {
	mode := os.Getenv("LINGER_TEST_PROTOCOL_HELPER")
	if mode == "" {
		return
	}
	decoder := json.NewDecoder(os.Stdin)
	var request map[string]any
	if decoder.Decode(&request) != nil {
		os.Exit(2)
	}
	closed := make(chan error, 1)
	go func() { closed <- decoder.Decode(&request) }()
	fmt.Println(`{"method":"starting"}`)
	if mode == "unresponsive" {
		<-closed
		os.Exit(3)
	}
	select {
	case <-closed:
		os.Exit(4)
	case <-time.After(400 * time.Millisecond):
	}
	if mode == "claude" {
		fmt.Print(`{"type":"control_response","response":`)
		time.Sleep(20 * time.Millisecond)
		fmt.Println(`{"subtype":"success","request_id":"linger-computer-doctor"}}`)
	} else {
		fmt.Print(`{"id":1,"res`)
		time.Sleep(20 * time.Millisecond)
		fmt.Println(`ult":{"userAgent":"probe"}}`)
	}
	if err := <-closed; !errors.Is(err, io.EOF) {
		os.Exit(5)
	}
	os.Exit(0)
}
