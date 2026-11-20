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

func TestMapStatusPreservesMemoryBreakdownAndLiveFitFields(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"schema": "localmodels.library-status/v1", "tool_version": "0.1.5", "observed_at": "2026-11-19T00:00:00Z",
		"host": map[string]any{
			"platform": "darwin", "arch": "arm64", "os_label": "macOS 27.2", "engine_label": "llama.cpp b11370 · Metal",
			"ram_total_bytes": 24 << 30, "ram_available_bytes": 9 << 30,
			"metal_working_set_bytes": 18 << 30, "memory_pressure": "warn",
			"disk_free_bytes": 50 << 30, "gpus": []any{},
		},
		"pools": []any{map[string]any{
			"id": "unified", "total_bytes": 21 << 30, "used_bytes": 15 << 30, "reserve_bytes": 3 << 30, "holders": []any{},
		}},
		"models": []any{map[string]any{
			"id": "qwen3.8-27b-iq3s:UD-IQ3_S", "name": "Qwen3.8 27B (UD-IQ3_S)", "description": "", "quant": "UD-IQ3_S",
			"context_tokens": 200_000, "vision": true, "download_bytes": 17 << 30, "memory_bytes": 20 << 30,
			"fit": "unified", "recommended": false, "availability": map[string]any{"downloadable": true},
			"pool": "unified", "state": "absent",
			"fits_now": false, "load_need_bytes": 18 << 30, "load_free_bytes": 6 << 30,
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(raw, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Host == nil || snapshot.Host.RamAvailableBytes == nil || *snapshot.Host.RamAvailableBytes != 9<<30 ||
		snapshot.Host.MetalWorkingSetBytes == nil || *snapshot.Host.MetalWorkingSetBytes != 18<<30 ||
		snapshot.Host.MemoryPressure != "warn" {
		t.Fatalf("host = %+v", snapshot.Host)
	}
	if len(snapshot.Pools) != 1 || snapshot.Pools[0].ReserveBytes == nil || *snapshot.Pools[0].ReserveBytes != 3<<30 {
		t.Fatalf("pools = %+v", snapshot.Pools)
	}
	model := snapshot.Models[0]
	if model.FitsNow == nil || *model.FitsNow || model.LoadNeedBytes == nil || *model.LoadNeedBytes != 18<<30 ||
		model.LoadFreeBytes == nil || *model.LoadFreeBytes != 6<<30 {
		t.Fatalf("model = %+v", model)
	}

	var invalid map[string]any
	_ = json.Unmarshal(raw, &invalid)
	invalid["host"].(map[string]any)["memory_pressure"] = "extreme"
	bad, _ := json.Marshal(invalid)
	if _, err := mapStatus(bad, time.Now()); err == nil {
		t.Fatal("expected error for invalid memory_pressure")
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
