package provider

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

const testAgyProtocolHelperEnv = "LINGER_TEST_AGY_PROTOCOL_HELPER"

func init() {
	metaPath := os.Getenv(testAgyProtocolHelperEnv)
	if metaPath == "" {
		return
	}
	os.Exit(runAgyProtocolHelper(metaPath, os.Args[1:]))
}

func runAgyProtocolHelper(metaPath string, args []string) int {
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
	meta, _ := json.Marshal(map[string]any{
		"geminiDir":      geminiDir,
		"logFile":        logFile,
		"appDataEntries": appDataEntries,
	})
	_ = os.WriteFile(metaPath, meta, 0o600)
	decoder := json.NewDecoder(os.Stdin)
	var request map[string]any
	if decoder.Decode(&request) != nil {
		return 4
	}
	fmt.Println(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}`)
	return 0
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
	if err := probeRuntimeProtocol(context.Background(), "antigravity", executable, env, 5*time.Second); err != nil {
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
	if err := probeRuntimeProtocol(context.Background(), "claude", claude, callerEnv, 5*time.Second); err != nil {
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
	if err := probeRuntimeProtocol(context.Background(), "claude", claude, overrideEnv, 5*time.Second); err != nil {
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
