package localmodels

import (
	"encoding/json"
	"os"
	"slices"
	"testing"
	"time"
)

// testdata/library-status-dev38.json is what localmodels 0.1.0.dev38 printed
// for library status --json on a Linux computer with one GPU and nothing
// downloaded, with the GPU's UUID zeroed.
func TestMapStatusKeepsTheModelCardOfARealDev38Status(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	// A row with a load record also carries the prefill speed, as
	// round(prompt_tokens_per_second, 1); nothing here has been loaded.
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	rows := document["models"].([]any)
	moe := rows[2].(map[string]any)
	moe["state"], moe["pi_model"] = "idle", "localmodels-library/qwen3-6-35b-a3b"
	moe["tokens_per_second"], moe["prompt_tokens_per_second"] = 151.3, 2840.6
	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}

	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ToolVersion != "0.1.0.dev38" || len(snapshot.Models) != 4 {
		t.Fatalf("snapshot = %s, %d models", snapshot.ToolVersion, len(snapshot.Models))
	}
	dense := modelState(snapshot, "qwen3.8-27b:UD-Q4_K_M")
	if dense == nil || dense.Family != "qwen" || dense.Publisher != "Qwen" || dense.Architecture != "dense" ||
		dense.Parameters != "27B" || dense.ActiveParameters != "" || dense.License != "Apache-2.0" ||
		dense.SourceURL != "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF" ||
		!slices.Equal(dense.Capabilities, []string{"vision"}) || !dense.Recommended {
		t.Fatalf("dense model = %+v", dense)
	}
	mixture := modelState(snapshot, "qwen3.6-35b-a3b:UD-Q4_K_M")
	if mixture == nil || mixture.Architecture != "moe" || mixture.Parameters != "35B" || mixture.ActiveParameters != "3B" ||
		mixture.PromptTokensPerSecond == nil || *mixture.PromptTokensPerSecond != 2840.6 ||
		mixture.TokensPerSecond == nil || *mixture.TokensPerSecond != 151.3 || mixture.Recommended {
		t.Fatalf("moe model = %+v", mixture)
	}

	// The snapshot sends the contract's names.
	sent, err := json.Marshal(mixture)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(sent, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"family", "publisher", "architecture", "parameters", "active_parameters", "license", "source_url", "capabilities", "prompt_tokens_per_second"} {
		if _, ok := fields[name]; !ok {
			t.Errorf("snapshot model has no %s: %s", name, sent)
		}
	}
}

func TestMapStatusPreservesSubsecondObservedAt(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	document["observed_at"] = "2026-11-17T20:37:38.25Z"
	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(encoded, time.Date(2026, 11, 17, 20, 37, 38, 123456789, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ObservedAt != "2026-11-17T20:37:38.25Z" {
		t.Fatalf("observed_at = %q, want 2026-11-17T20:37:38.25Z", snapshot.ObservedAt)
	}
	missing := unavailable(CodeToolFailed, "err", time.Date(2026, 11, 17, 20, 37, 38, 500000000, time.UTC))
	if missing.ObservedAt != "2026-11-17T20:37:38.5Z" {
		t.Fatalf("unavailable observed_at = %q, want 2026-11-17T20:37:38.5Z", missing.ObservedAt)
	}
}

func TestMapStatusKeepsAndSanitizesEngineMetadata(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	rows := document["models"].([]any)
	first := rows[0].(map[string]any)
	first["engine"] = "polystrata"
	first["engine_label"] = "PolyStrata 0.2.19-poly.1 · CUDA"
	first["concurrency"] = 1
	first["host_ram_bytes"] = 19800000000

	second := rows[1].(map[string]any)
	second["engine"] = "future-engine"
	second["engine_label"] = "FutureEngine"
	second["concurrency"] = 99

	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	m0 := snapshot.Models[0]
	if m0.Engine != "polystrata" || m0.EngineLabel != "PolyStrata 0.2.19-poly.1 · CUDA" ||
		m0.Concurrency == nil || *m0.Concurrency != 1 ||
		m0.HostRamBytes == nil || *m0.HostRamBytes != 19800000000 {
		t.Fatalf("model 0 engine metadata = %+v", m0)
	}
	m1 := snapshot.Models[1]
	if m1.Engine != "" || m1.EngineLabel != "FutureEngine" || m1.Concurrency != nil {
		t.Fatalf("model 1 sanitized engine metadata = %+v", m1)
	}
}
