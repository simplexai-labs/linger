package native

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestInvokeAntigravityModelIsolatedAndClampsEffort(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	userHome := filepath.Join(base, "user-home")
	userAppData := filepath.Join(userHome, ".gemini", "antigravity-cli")
	if err := os.MkdirAll(userAppData, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userAppData, "antigravity-oauth-token"), []byte("seeded-oauth"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(userAppData, "settings.json"), []byte(`{"theme":"dark"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	workDir := filepath.Join(base, "work")
	scratchDir := filepath.Join(base, "scratch")
	for _, d := range []string{workDir, scratchDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	recordPath := filepath.Join(base, "requests.jsonl")
	metaPath := filepath.Join(base, "meta.json")
	env := map[string]string{
		"HOME":           userHome,
		agyFakeEnv:       "model-invoke",
		agyFakeRecordEnv: recordPath,
		agyFakeMetaEnv:   metaPath,
	}

	// gemini-flash in agyFakeSession offers only "medium"; requesting "high" must clamp to "medium".
	outcome, reportedModel, err := InvokeAntigravityModel(
		t.Context(),
		Profile{Program: program, Env: env},
		workDir,
		scratchDir,
		"Return concise text.",
		"gemini-flash",
		"hello world",
		"high",
	)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Status != statusCompleted || !outcome.ExitConfirmed || reportedModel != "gemini-flash" || outcome.Output != "Antigravity answer: hello world" {
		t.Fatalf("outcome=%+v model=%q", outcome, reportedModel)
	}
	if usage := outcome.Usage["gemini-flash"]; usage != (TokenCount{Input: 12, Output: 8, CacheRead: 5, CacheWrite: 3}) {
		t.Fatalf("usage=%+v", outcome.Usage)
	}

	// Verify isolated --gemini-dir, --include-default-customizations=false, and credential seeding.
	metaBytes, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatal(err)
	}
	var meta struct {
		Args      []string `json:"args"`
		GeminiDir string   `json:"geminiDir"`
		AddDir    string   `json:"addDir"`
		Token     string   `json:"token"`
		Settings  string   `json:"settings"`
	}
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(meta.Args, "--include-default-customizations=false") {
		t.Fatalf("expected --include-default-customizations=false in args: %v", meta.Args)
	}
	if !strings.HasPrefix(meta.GeminiDir, scratchDir) || meta.Token != "seeded-oauth" || meta.Settings != `{"theme":"dark"}` {
		t.Fatalf("unexpected isolated meta: %+v", meta)
	}
	// Verify zero pollution of user ~/.gemini/antigravity-cli (only the two original files exist).
	entries, err := os.ReadDir(userAppData)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("user ~/.gemini/antigravity-cli was polluted: %v", entries)
	}

	// Verify systemPrompt.append and clamped thought_level="medium" in ACP requests.
	reqs := readAgyRequests(t, recordPath)
	if len(reqs["session/new"]) != 1 {
		t.Fatalf("session/new=%v", reqs["session/new"])
	}
	newParams := reqs["session/new"][0]["params"].(map[string]any)
	metaParam := newParams["_meta"].(map[string]any)["antigravity"].(map[string]any)["systemPrompt"].(map[string]any)
	if metaParam["append"] != "Return concise text." {
		t.Fatalf("systemPrompt.append=%v", metaParam["append"])
	}
	var thoughtValue string
	for _, req := range reqs["session/set_config_option"] {
		params := req["params"].(map[string]any)
		if params["configId"] == "thought_level" {
			thoughtValue, _ = params["value"].(string)
		}
	}
	if thoughtValue != "medium" {
		t.Fatalf("thought_level=%q, want clamped medium", thoughtValue)
	}
}

func TestInvokeAntigravityModelDeniesToolsAndPermissions(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := t.TempDir()
	workDir := filepath.Join(base, "work")
	scratchDir := filepath.Join(base, "scratch")
	for _, d := range []string{workDir, scratchDir} {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	outcome, _, err := InvokeAntigravityModel(
		t.Context(),
		Profile{Program: program, Env: map[string]string{"HOME": base, agyFakeEnv: "model-invoke-tool"}},
		workDir,
		scratchDir,
		"",
		"",
		"run tool",
		"low",
	)
	if err != nil {
		t.Fatal(err)
	}
	// Pre-tool scratch must be reset on tool_call, PreToolUse must deny, and permission must deny.
	if outcome.Status != statusCompleted || !outcome.ExitConfirmed || outcome.Output != "hook=deny perm=deny" {
		t.Fatalf("outcome=%+v, want hook=deny perm=deny", outcome)
	}
}

func TestInvokeAntigravityModelFailuresAndCancel(t *testing.T) {
	program, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("signed_out", func(t *testing.T) {
		base := t.TempDir()
		outcome, _, err := InvokeAntigravityModel(
			t.Context(),
			Profile{Program: program, Env: map[string]string{"HOME": base, agyFakeEnv: "signed-out"}},
			base,
			t.TempDir(),
			"",
			"",
			"hi",
			"low",
		)
		if err != nil || outcome.Status != statusFailed || outcome.FailureCode != "authentication_required" || !outcome.ExitConfirmed {
			t.Fatalf("signed_out outcome=%+v err=%v", outcome, err)
		}
	})

	t.Run("unknown_model", func(t *testing.T) {
		base := t.TempDir()
		outcome, _, err := InvokeAntigravityModel(
			t.Context(),
			Profile{Program: program, Env: map[string]string{"HOME": base, agyFakeEnv: "model-invoke"}},
			base,
			t.TempDir(),
			"",
			"unknown-model",
			"hi",
			"low",
		)
		if err != nil || outcome.Status != statusFailed || outcome.FailureCode != "model_not_offered" || !outcome.ExitConfirmed {
			t.Fatalf("unknown_model outcome=%+v err=%v", outcome, err)
		}
	})

	t.Run("cancel", func(t *testing.T) {
		base := t.TempDir()
		recordPath := filepath.Join(base, "requests.jsonl")
		ctx, cancel := context.WithCancel(t.Context())
		done := make(chan Outcome, 1)
		go func() {
			out, _, _ := InvokeAntigravityModel(
				ctx,
				Profile{Program: program, Env: map[string]string{"HOME": base, agyFakeEnv: "model-invoke-hang", agyFakeRecordEnv: recordPath}},
				base,
				t.TempDir(),
				"",
				"",
				"hang",
				"low",
			)
			done <- out
		}()
		deadline := time.Now().Add(10 * time.Second)
		for {
			if raw, readErr := os.ReadFile(recordPath); readErr == nil && strings.Contains(string(raw), `"session/prompt"`) {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("model-invoke-hang did not send session/prompt")
			}
			time.Sleep(10 * time.Millisecond)
		}
		cancel()
		select {
		case out := <-done:
			if out.Status != statusAborted || !out.ExitConfirmed {
				t.Fatalf("canceled outcome=%+v", out)
			}
		case <-time.After(15 * time.Second):
			t.Fatal("canceled model invoke did not return")
		}
	})
}

func readAgyRequests(t *testing.T, path string) map[string][]map[string]any {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	out := map[string][]map[string]any{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<20)
	for scanner.Scan() {
		var frame map[string]any
		if json.Unmarshal(scanner.Bytes(), &frame) != nil {
			t.Fatalf("invalid JSON line: %s", scanner.Text())
		}
		method, _ := frame["method"].(string)
		out[method] = append(out[method], frame)
	}
	return out
}

func TestAntigravityProbeHomeCaseInsensitiveLookup(t *testing.T) {
	if got := antigravityProbeHome(map[string]string{"UserProfile": `  C:\Users\Alice  `}); got != `C:\Users\Alice` {
		t.Fatalf("UserProfile = %q, want C:\\Users\\Alice", got)
	}
	if got := antigravityProbeHome(map[string]string{"Home": "/home/alice", "UserProfile": `C:\Users\Bob`}); got != "/home/alice" {
		t.Fatalf("Home precedence = %q, want /home/alice", got)
	}
	if got := antigravityProbeHome(map[string]string{"HOME": "/exact", "Home": "/folded"}); got != "/exact" {
		t.Fatalf("exact HOME = %q, want /exact", got)
	}
}
