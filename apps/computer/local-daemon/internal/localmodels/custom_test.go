package localmodels

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

func TestInPiCatalogGatesCustomModelsUntilVerifiedOrLoaded(t *testing.T) {
	base := wire.LocalModel{
		ID:      "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M",
		Origin:  "custom",
		PiModel: "localmodels-library/custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M",
		State:   "idle",
	}
	if InPiCatalog(base) {
		t.Fatal("untested idle custom model must not enter Pi catalog")
	}
	untested := base
	untested.Verification = &wire.LocalModelVerification{Status: "untested"}
	if InPiCatalog(untested) {
		t.Fatal("explicitly untested custom model must not enter Pi catalog")
	}
	failed := base
	failed.Verification = &wire.LocalModelVerification{Status: "failed"}
	if InPiCatalog(failed) {
		t.Fatal("failed verification custom model must not enter Pi catalog")
	}
	running := base
	running.Verification = &wire.LocalModelVerification{Status: "running"}
	if InPiCatalog(running) {
		t.Fatal("smoke-testing custom model must not enter Pi catalog")
	}
	verified := base
	verified.Verification = &wire.LocalModelVerification{Status: "verified"}
	if !InPiCatalog(verified) {
		t.Fatal("verified idle custom model should enter Pi catalog")
	}
	loaded := base
	loaded.State = "loaded"
	if !InPiCatalog(loaded) {
		t.Fatal("loaded custom model should enter Pi catalog")
	}
	stopped := base
	stopped.State = "failed"
	stopped.Verification = &wire.LocalModelVerification{Status: "verified"}
	stopped.Error = &wire.LocalModelError{Code: "HUB_AUTH_REQUIRED"}
	if InPiCatalog(stopped) {
		t.Fatal("stopped custom download must not enter Pi catalog")
	}
}

func TestIsReadOnlyOrStopSubcommandCustomVerbs(t *testing.T) {
	if !isReadOnlyOrStopSubcommand([]string{"-P", "-s", "-m", "localmodels", "library", "custom", "search", "--config-stdin", "--json"}) {
		t.Fatal("custom search must be read-only")
	}
	if !isReadOnlyOrStopSubcommand([]string{"-P", "-s", "-m", "localmodels", "library", "custom", "probe", "--config-stdin", "--json"}) {
		t.Fatal("custom probe must be read-only")
	}
	if isReadOnlyOrStopSubcommand([]string{"-P", "-s", "-m", "localmodels", "library", "custom", "download", "--config-stdin", "--jsonl"}) {
		t.Fatal("custom download must not be read-only")
	}
}

func TestToolArgumentsCustomAndSmokeTest(t *testing.T) {
	tool := Tool{BaseDirectory: "/models"}
	dlArgs := tool.arguments(Action{
		Name: ActionCustomDownload,
		CustomDownload: &wire.LocalModelCustomDownloadInput{
			Hub: "huggingface", RepoID: "bartowski/Qwen", VariantID: "Q4_K_M",
			Token: "hf_SecretTokenValue1234567890",
		},
	})
	joined := strings.Join(dlArgs, " ")
	if strings.Contains(joined, "hf_SecretTokenValue") {
		t.Fatalf("token leaked into argv: %s", joined)
	}
	if !strings.Contains(joined, "library custom download --config-stdin --base-dir /models --jsonl") {
		t.Fatalf("unexpected custom download args: %v", dlArgs)
	}

	smokeArgs := tool.arguments(Action{Name: ActionSmokeTest, Model: "custom.hf.a--b:Q4_K_M", ContextTokens: 2048})
	if !strings.Contains(strings.Join(smokeArgs, " "), "library smoke-test custom.hf.a--b:Q4_K_M --ctx 2048 --base-dir /models --jsonl") {
		t.Fatalf("unexpected smoke-test args: %v", smokeArgs)
	}

	loadArgs := tool.arguments(Action{Name: ActionLoad, Model: "custom.hf.a--b:Q4_K_M", Force: true, ContextTokens: 2048})
	if !strings.Contains(strings.Join(loadArgs, " "), "library load custom.hf.a--b:Q4_K_M --force --ctx 2048 --base-dir /models --jsonl") {
		t.Fatalf("unexpected load args: %v", loadArgs)
	}
}

func TestMapStatusSanitizesCustomVerificationAndRedactsLog(t *testing.T) {
	longLog := "auth failed with hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345 " + strings.Repeat("x", 4500)
	doc := map[string]any{
		"schema":       statusSchema,
		"tool_version": "0.1.0.dev60",
		"observed_at":  "2026-11-26T00:00:00Z",
		"host": map[string]any{
			"platform":          "darwin",
			"arch":              "arm64",
			"os_label":          "macOS 15",
			"engine_label":      "llama.cpp",
			"ram_total_bytes":   16000000000,
			"disk_free_bytes":   100000000000,
			"gpus":              []any{},
			"supported_formats": []string{"gguf", "mlx", "gguf", "unknown"},
		},
		"pools": []any{},
		"models": []any{
			map[string]any{
				"id": "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M", "name": "Qwen 2.5 7B",
				"description": "Custom", "quant": "Q4_K_M", "context_tokens": 32768, "vision": false,
				"download_bytes": 4683073248, "memory_bytes": 6400000000, "fit": "unified", "pool": "unified",
				"recommended": false, "availability": map[string]any{"downloadable": true}, "state": "idle",
				"engine": "mlx",
				"origin": "custom",
				"custom": map[string]any{
					"hub": "huggingface", "repo_id": "bartowski/Qwen2.5-7B-Instruct-GGUF",
					"format": "gguf", "variant_id": "Q4_K_M", "shard_count": 2, "standby_on_restart": true,
				},
				"verification": map[string]any{
					"status":         "failed",
					"context_tokens": 4096,
					"tested_at":      "2026-11-26T01:02:03Z",
					"failure": map[string]any{
						"kind": "oom", "code": "OUT_OF_MEMORY", "context_tokens": 4096,
						"can_retry_lower_ctx": true, "can_redownload": false,
						"diagnostic_log": longLog,
					},
				},
			},
		},
	}
	encoded, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	snap, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatalf("mapStatus: %v", err)
	}
	if len(snap.Host.SupportedFormats) != 2 || snap.Host.SupportedFormats[0] != "gguf" || snap.Host.SupportedFormats[1] != "mlx" {
		t.Fatalf("unexpected supported_formats: %v", snap.Host.SupportedFormats)
	}
	m := snap.Models[0]
	if m.Engine != "mlx" || m.Origin != "custom" || m.Custom == nil || m.Verification == nil || m.Verification.Failure == nil {
		t.Fatalf("custom metadata dropped: %+v", m)
	}
	diag := m.Verification.Failure.DiagnosticLog
	if strings.Contains(diag, "hf_AbCdEfGhIjKlMnOpQrStUvWxYz012345") {
		t.Fatalf("hf token survived in diagnostic_log: %q", diag)
	}
	if len([]rune(diag)) > 4000 {
		t.Fatalf("diagnostic_log exceeded 4000 runes: %d", len([]rune(diag)))
	}
}

func TestApplyProgressShardAndSmokeTest(t *testing.T) {
	id := "custom.hf.bartowski--qwen2.5-7b-instruct-gguf:Q4_K_M"
	snap := wire.LocalModelsSnapshot{
		Available: true,
		Models:    []wire.LocalModel{{ID: id, State: "idle", Origin: "custom"}},
	}
	idx, cnt := 2.0, 3.0
	if !applyProgress(&snap, libraryEvent{
		Event: "progress", Model: json.RawMessage(`"` + id + `"`),
		Phase: "download", Done: 500, Total: 1000, BytesPerSecond: 100,
		ShardIndex: &idx, ShardCount: &cnt,
	}) {
		t.Fatal("expected shard download progress to apply")
	}
	if snap.Models[0].Download == nil || snap.Models[0].Download.ShardIndex == nil || *snap.Models[0].Download.ShardIndex != 2 ||
		snap.Models[0].Download.ShardCount == nil || *snap.Models[0].Download.ShardCount != 3 {
		t.Fatalf("unexpected shard download progress: %+v", snap.Models[0].Download)
	}
	snap.Models[0].State = "idle"
	ctxTokens := 4096.0
	if !applyProgress(&snap, libraryEvent{
		Event: "progress", Model: json.RawMessage(`"` + id + `"`),
		Phase: "smoke_test", ContextTokens: &ctxTokens,
	}) {
		t.Fatal("expected smoke_test progress to apply")
	}
	if snap.Models[0].State != "idle" || snap.Models[0].Verification == nil || snap.Models[0].Verification.Status != "running" ||
		snap.Models[0].Verification.ContextTokens == nil || *snap.Models[0].Verification.ContextTokens != 4096 {
		t.Fatalf("unexpected smoke_test state: %+v", snap.Models[0])
	}
}

func TestRunCustomSearchProbeAndCustomDownloadStdinTokenSafety(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "fake_python.sh")
	stdinCapture := filepath.Join(dir, "stdin.json")
	argvCapture := filepath.Join(dir, "argv.txt")
	script := `#!/bin/sh
echo "$@" > "` + argvCapture + `"
cat > "` + stdinCapture + `"
case "$*" in
  *"custom search"*)
    echo '{"schema":"localmodels.library-custom-search/v1","ok":true,"query":"qwen","hub":"huggingface","format":"compatible","platform":"linux","arch":"x86_64","supported_formats":["gguf"],"results":[{"hub":"huggingface","repo_id":"bartowski/Qwen2.5-7B-Instruct-GGUF","url":"https://huggingface.co/bartowski/Qwen2.5-7B-Instruct-GGUF","title":"Qwen2.5-7B-Instruct-GGUF","owner":"bartowski","format":"gguf","downloads":100,"likes":10,"gated":false,"compatible":true}],"warnings":[]}'
    exit 0
    ;;
  *"custom probe"*)
    echo '{"schema":"localmodels.library-custom-probe/v1","ok":true,"outcome":"gated","hub_http_status":401,"token_provided":true,"repo":{"hub":"huggingface","repo_id":"meta-llama/Llama-3.1-8B-GGUF","url":"https://huggingface.co/meta-llama/Llama-3.1-8B-GGUF"}}'
    exit 0
    ;;
  *"custom download"*)
    echo '{"schema":"localmodels.library-event/v1","event":"progress","model":"custom.hf.bartowski--qwen:Q4_K_M","phase":"download","done":10,"total":100,"shard_index":1,"shard_count":2}'
    echo '{"schema":"localmodels.library-event/v1","event":"result","model":"custom.hf.bartowski--qwen:Q4_K_M","ok":true}'
    exit 0
    ;;
  *"status"*)
    echo '{"schema":"localmodels.library-status/v1","tool_version":"0.1.0.dev60","observed_at":"2026-11-26T00:00:00Z","host":{"platform":"linux","arch":"x86_64","os_label":"Linux","engine_label":"llama.cpp","ram_total_bytes":16000000000,"disk_free_bytes":100000000000,"gpus":[],"supported_formats":["gguf"]},"pools":[],"models":[]}'
    exit 0
    ;;
esac
exit 1
`
	if err := os.WriteFile(scriptPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	tool := Tool{Python: scriptPath, ModuleDirectory: dir, StateDirectory: filepath.Join(dir, "state"), BaseDirectory: filepath.Join(dir, "models")}
	if err := os.MkdirAll(tool.StateDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	secret := "hf_SuperSecretReadOnlyToken987654321"
	searchRes, err := tool.runCustomSearch(context.Background(), nil, dir, wire.LocalModelCustomSearchInput{
		Hub: "huggingface", Query: "qwen", Token: secret,
	})
	if err != nil {
		t.Fatalf("runCustomSearch: %v", err)
	}
	if len(searchRes.Results) != 1 || searchRes.Results[0].RepoID != "bartowski/Qwen2.5-7B-Instruct-GGUF" {
		t.Fatalf("unexpected search result: %+v", searchRes)
	}
	argvBytes, _ := os.ReadFile(argvCapture)
	if strings.Contains(string(argvBytes), secret) {
		t.Fatalf("secret leaked on argv: %s", argvBytes)
	}
	stdinBytes, _ := os.ReadFile(stdinCapture)
	if !strings.Contains(string(stdinBytes), secret) {
		t.Fatalf("expected token on stdin, got: %s", stdinBytes)
	}

	probeRes, err := tool.runCustomProbe(context.Background(), nil, dir, wire.LocalModelCustomProbeInput{
		Target: "meta-llama/Llama-3.1-8B-GGUF", Hub: "huggingface", Token: secret,
	})
	if err != nil {
		t.Fatalf("runCustomProbe: %v", err)
	}
	if probeRes.Outcome != "gated" || probeRes.HubHTTPStatus == nil || *probeRes.HubHTTPStatus != 401 {
		t.Fatalf("unexpected probe result: %+v", probeRes)
	}

	lib := New(Options{
		Tool:             &tool,
		JobDirectory:     filepath.Join(dir, "jobs"),
		ProgressInterval: 10 * time.Millisecond,
		ActionTimeout:    5 * time.Second,
		StatusTimeout:    5 * time.Second,
	})
	defer lib.Close()
	modelID, refusal, answered := lib.ActWithResult(context.Background(), Action{
		Name: ActionCustomDownload,
		CustomDownload: &wire.LocalModelCustomDownloadInput{
			Hub: "huggingface", RepoID: "bartowski/Qwen", VariantID: "Q4_K_M", Token: secret,
		},
	}, time.Now().Add(5*time.Second))
	if !answered || refusal != nil || modelID != "custom.hf.bartowski--qwen:Q4_K_M" {
		t.Fatalf("custom_download got modelID=%q refusal=%+v answered=%v", modelID, refusal, answered)
	}
	argvBytes, _ = os.ReadFile(argvCapture)
	if strings.Contains(string(argvBytes), secret) {
		t.Fatalf("secret leaked on custom download argv: %s", argvBytes)
	}
}
