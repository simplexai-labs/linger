package provider

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type agyProbeTraceEntry struct {
	GeminiDir      string `json:"geminiDir"`
	LogFile        string `json:"logFile"`
	Cwd            string `json:"cwd"`
	PrivateCheckOK bool   `json:"privateCheckOK"`
}

func readAgyProbeTrace(t *testing.T, path string) []agyProbeTraceEntry {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var entries []agyProbeTraceEntry
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		var entry agyProbeTraceEntry
		if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
			t.Fatalf("decode trace line %q: %v", scanner.Text(), err)
		}
		entries = append(entries, entry)
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return entries
}

func TestDiscoverAntigravityUsesTempBaseForProtocolAuthAndCatalog(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	tempBase := filepath.Join(root, "state", "operation-tmp")
	metaFile := filepath.Join(root, "meta.json")
	traceFile := filepath.Join(root, "trace.jsonl")
	badTemp := filepath.Join(root, "not-a-dir")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badTemp, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Poison every OS temporary directory variable so any accidental fallback
	// to os.TempDir() fails immediately.
	t.Setenv("TMPDIR", badTemp)
	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)

	env := map[string]string{
		"HOME":                   home,
		"PATH":                   filepath.Dir(executable),
		testAgyProtocolHelperEnv: metaFile,
		testAgyProtocolTraceEnv:  traceFile,
	}
	result, err := Discover(context.Background(), DiscoveryOptions{
		ConfiguredPaths: map[string]string{"antigravity": executable},
		Runtimes:        []string{"antigravity"},
		TempBase:        tempBase,
		Environment:     env,
		Timeout:         5 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 1 {
		t.Fatalf("diagnostics = %+v, want 1 entry", result.Diagnostics)
	}
	diagnostic := result.Diagnostics[0]
	if diagnostic.Type != "antigravity" || diagnostic.Status != "ready" || diagnostic.Error != nil {
		t.Fatalf("antigravity diagnostic = %+v, want ready", diagnostic)
	}
	if len(diagnostic.Models) != 1 || diagnostic.Models[0].ID != "gemini-pro" {
		t.Fatalf("antigravity models = %+v, want gemini-pro", diagnostic.Models)
	}

	trace := readAgyProbeTrace(t, traceFile)
	if len(trace) != 2 {
		t.Fatalf("expected 2 antigravity probe invocations (protocol + auth/catalog), got %d: %+v", len(trace), trace)
	}
	for i, entry := range trace {
		if !isPathWithin(tempBase, entry.GeminiDir) || !isPathWithin(tempBase, entry.LogFile) || !entry.PrivateCheckOK {
			t.Fatalf("trace[%d] did not run privately inside tempBase %q: %+v", i, tempBase, entry)
		}
	}
	if entries, err := os.ReadDir(tempBase); err != nil || len(entries) != 0 {
		t.Fatalf("tempBase was not cleaned up after Discover: entries=%v err=%v", entries, err)
	}

	// Verify the uncached model-discovery fallback path also uses TempBase.
	models, modelErr := discoverRuntimeModels(context.Background(), "antigravity", executable, env, tempBase)
	if modelErr != "" || len(models) != 1 || models[0].ID != "gemini-pro" {
		t.Fatalf("discoverRuntimeModels() = %+v, err=%q; want gemini-pro", models, modelErr)
	}
	if entries, err := os.ReadDir(tempBase); err != nil || len(entries) != 0 {
		t.Fatalf("tempBase was not cleaned up after discoverRuntimeModels: entries=%v err=%v", entries, err)
	}
}

func TestRefreshRuntimeAuthenticationAntigravityUsesTempBase(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicalExecutable(executable)
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	home := filepath.Join(root, "home")
	tempBase := filepath.Join(root, "state", "operation-tmp")
	metaFile := filepath.Join(root, "meta.json")
	traceFile := filepath.Join(root, "trace.jsonl")
	badTemp := filepath.Join(root, "not-a-dir")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(badTemp, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", badTemp)
	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)

	current := DiscoveryResult{
		Diagnostics: []RuntimeDiagnostic{
			{
				Type:           "antigravity",
				Status:         "ready",
				Version:        "1.5.12",
				ExecutablePath: canonical,
				EntryPath:      executable,
			},
		},
	}
	options := DiscoveryOptions{
		TempBase: tempBase,
		Timeout:  5 * time.Second,
		Environment: map[string]string{
			"HOME":                   home,
			testAgyProtocolHelperEnv: metaFile,
			testAgyProtocolTraceEnv:  traceFile,
		},
	}
	refreshed, err := RefreshRuntimeAuthentication(context.Background(), current, options)
	if err != nil {
		t.Fatal(err)
	}
	if len(refreshed.Diagnostics) != 1 || refreshed.Diagnostics[0].Status != "ready" || len(refreshed.Diagnostics[0].Models) != 1 {
		t.Fatalf("refreshed = %+v, want ready with 1 model", refreshed.Diagnostics)
	}
	trace := readAgyProbeTrace(t, traceFile)
	if len(trace) != 1 || !isPathWithin(tempBase, trace[0].GeminiDir) || !isPathWithin(tempBase, trace[0].LogFile) || !trace[0].PrivateCheckOK {
		t.Fatalf("auth refresh trace = %+v, want single private probe under %q", trace, tempBase)
	}
	if entries, err := os.ReadDir(tempBase); err != nil || len(entries) != 0 {
		t.Fatalf("tempBase was not cleaned up after RefreshRuntimeAuthentication: entries=%v err=%v", entries, err)
	}
}

func TestProbeAntigravityAuthenticationLogsAndCategorizesFailures(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}

	t.Run("prepare_failed", func(t *testing.T) {
		root := t.TempDir()
		fileBase := filepath.Join(root, "blocked-temp-base")
		if err := os.WriteFile(fileBase, []byte("file"), 0o600); err != nil {
			t.Fatal(err)
		}
		logged := captureProbeLog(t)
		outcome := probeAntigravityAuthentication(
			context.Background(),
			executable,
			map[string]string{"HOME": root, testAgyProtocolHelperEnv: filepath.Join(root, "meta.json")},
			5*time.Second,
			fileBase,
		)
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != "Antigravity diagnostic environment could not be prepared" {
			t.Fatalf("outcome = %+v, want prepare failure RUNTIME_DIAGNOSTIC_FAILED", outcome)
		}
		if strings.Contains(outcome.Message, fileBase) {
			t.Fatalf("outcome.Message leaked local path: %q", outcome.Message)
		}
		logOutput := logged.String()
		for _, want := range []string{"runner.runtime_auth.prepare_failed", "runtime_type=antigravity"} {
			if !strings.Contains(logOutput, want) {
				t.Fatalf("log lacks %q: %s", want, logOutput)
			}
		}
	})

	t.Run("probe_failed", func(t *testing.T) {
		root := t.TempDir()
		tempBase := filepath.Join(root, "state", "operation-tmp")
		logged := captureProbeLog(t)
		outcome := probeAntigravityAuthentication(
			context.Background(),
			executable,
			map[string]string{
				"HOME":                   root,
				testAgyProtocolHelperEnv: filepath.Join(root, "meta.json"),
				testAgyProtocolModeEnv:   "auth-error",
			},
			5*time.Second,
			tempBase,
		)
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != "Antigravity authentication could not be verified" {
			t.Fatalf("outcome = %+v, want probe failure RUNTIME_DIAGNOSTIC_FAILED", outcome)
		}
		logOutput := logged.String()
		for _, want := range []string{"runner.runtime_auth.probe_failed", "runtime_type=antigravity"} {
			if !strings.Contains(logOutput, want) {
				t.Fatalf("log lacks %q: %s", want, logOutput)
			}
		}
		if entries, err := os.ReadDir(tempBase); err != nil || len(entries) != 0 {
			t.Fatalf("tempBase leaked entries after failed auth probe: entries=%v err=%v", entries, err)
		}
	})

	t.Run("os_temp_fallback_prepare_failed", func(t *testing.T) {
		root := t.TempDir()
		badTemp := filepath.Join(root, "not-a-dir")
		if err := os.WriteFile(badTemp, []byte("file"), 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv("TMPDIR", badTemp)
		t.Setenv("TEMP", badTemp)
		t.Setenv("TMP", badTemp)
		logged := captureProbeLog(t)
		outcome := probeAntigravityAuthentication(
			context.Background(),
			executable,
			map[string]string{"HOME": root, testAgyProtocolHelperEnv: filepath.Join(root, "meta.json")},
			5*time.Second,
			"",
		)
		if outcome.Status != "error" || outcome.Code != "RUNTIME_DIAGNOSTIC_FAILED" || outcome.Message != "Antigravity diagnostic environment could not be prepared" {
			t.Fatalf("outcome = %+v, want prepare failure RUNTIME_DIAGNOSTIC_FAILED", outcome)
		}
		if strings.Contains(outcome.Message, badTemp) {
			t.Fatalf("outcome.Message leaked local path %q: %q", badTemp, outcome.Message)
		}
		logOutput := logged.String()
		for _, want := range []string{"runner.runtime_auth.prepare_failed", "runtime_type=antigravity"} {
			if !strings.Contains(logOutput, want) {
				t.Fatalf("log lacks %q: %s", want, logOutput)
			}
		}
	})
}

func TestDiscoverRuntimeModelsAntigravityPrepareFailureIsCategorical(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	badTemp := filepath.Join(root, "not-a-dir")
	if err := os.WriteFile(badTemp, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", badTemp)
	t.Setenv("TEMP", badTemp)
	t.Setenv("TMP", badTemp)

	logged := captureProbeLog(t)
	models, modelErr := discoverRuntimeModels(
		context.Background(),
		"antigravity",
		executable,
		map[string]string{"HOME": root, testAgyProtocolHelperEnv: filepath.Join(root, "meta.json")},
		"",
	)
	if len(models) != 0 || modelErr != "Antigravity diagnostic environment could not be prepared" {
		t.Fatalf("discoverRuntimeModels() = %+v, err=%q; want empty models and categorical prepare error", models, modelErr)
	}
	if strings.Contains(modelErr, badTemp) {
		t.Fatalf("modelErr leaked local path %q: %q", badTemp, modelErr)
	}
	logOutput := logged.String()
	for _, want := range []string{"runner.runtime_models.prepare_failed", "runtime_type=antigravity"} {
		if !strings.Contains(logOutput, want) {
			t.Fatalf("log lacks %q: %s", want, logOutput)
		}
	}
}
