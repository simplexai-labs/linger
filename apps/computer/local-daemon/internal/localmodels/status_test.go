package localmodels

import (
	"encoding/json"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
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

func TestMapStatusPreservesExternalHolders(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	pools := document["pools"].([]any)
	gpuPool := pools[0].(map[string]any)
	gpuPool["external_holders"] = []any{
		map[string]any{"name": " msedge ", "bytes": float64(188743680), "pids": []any{float64(1234)}},
		map[string]any{"name": "   ", "bytes": float64(100)},
	}

	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot.Pools) < 2 {
		t.Fatalf("expected at least 2 pools, got %d", len(snapshot.Pools))
	}
	pool0 := snapshot.Pools[0]
	if len(pool0.ExternalHolders) != 1 {
		t.Fatalf("expected 1 external holder, got %d: %+v", len(pool0.ExternalHolders), pool0.ExternalHolders)
	}
	holder := pool0.ExternalHolders[0]
	if holder.Name != "msedge" || holder.Bytes != 188743680 {
		t.Fatalf("unexpected external holder: %+v", holder)
	}

	if pool1 := snapshot.Pools[1]; pool1.ExternalHolders != nil {
		t.Fatalf("expected no external holders on pool 1, got %+v", pool1.ExternalHolders)
	}
	out, err := json.Marshal(snapshot.Pools[1])
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), "external_holders") {
		t.Fatalf("pool without external holders encoded the field: %s", out)
	}
}

func TestMapStatusKeepsReportedEmptyExternalHolders(t *testing.T) {
	for name, reported := range map[string][]any{
		"empty":       {},
		"blank names": {map[string]any{"name": "  ", "bytes": float64(100)}},
	} {
		t.Run(name, func(t *testing.T) {
			encoded, err := os.ReadFile("testdata/library-status-dev38.json")
			if err != nil {
				t.Fatal(err)
			}
			var document map[string]any
			if err := json.Unmarshal(encoded, &document); err != nil {
				t.Fatal(err)
			}
			document["pools"].([]any)[0].(map[string]any)["external_holders"] = reported
			encoded, err = json.Marshal(document)
			if err != nil {
				t.Fatal(err)
			}
			snapshot, err := mapStatus(encoded, time.Now())
			if err != nil {
				t.Fatal(err)
			}
			pool0 := snapshot.Pools[0]
			if pool0.ExternalHolders == nil || len(pool0.ExternalHolders) != 0 {
				t.Fatalf("expected a non-nil empty list, got %#v", pool0.ExternalHolders)
			}
			out, err := json.Marshal(pool0)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(out), `"external_holders":[]`) {
				t.Fatalf("reported empty list was not encoded as []: %s", out)
			}
		})
	}
}

func TestMapStatusDropsMalformedExternalHolders(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	document["pools"].([]any)[0].(map[string]any)["external_holders"] = []any{
		map[string]any{"name": "negative", "bytes": -1},
		map[string]any{"name": "fraction", "bytes": 1.5},
		map[string]any{"name": 123, "bytes": 10},
		json.RawMessage(`{"name":"sentinel","bytes":18446744073709551615}`),
		map[string]any{"name": "msedge", "bytes": 42},
	}
	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	want := []wire.LocalModelPoolExternalHolder{
		{Name: "sentinel", Bytes: 9007199254740991},
		{Name: "msedge", Bytes: 42},
	}
	if !reflect.DeepEqual(snapshot.Pools[0].ExternalHolders, want) {
		t.Fatalf("external holders = %+v, want %+v", snapshot.Pools[0].ExternalHolders, want)
	}
	if len(snapshot.Models) != len(baseline.Models) || len(snapshot.Pools) != len(baseline.Pools) ||
		!reflect.DeepEqual(snapshot.Pools[1:], baseline.Pools[1:]) {
		t.Fatalf("malformed holders changed the rest of the snapshot")
	}
}

func TestMapStatusSanitizesHostAndModelStorage(t *testing.T) {
	encoded, err := os.ReadFile("testdata/library-status-dev38.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(encoded, &document); err != nil {
		t.Fatal(err)
	}
	host := document["host"].(map[string]any)
	host["models_dir"] = "  /home/alice/.simplexai/runtime/localmodels/models/models  "
	host["models_dir_exists"] = true

	rows := document["models"].([]any)
	// Row 0 is absent: storage must always be cleared even if present in JSON.
	absentRow := rows[0].(map[string]any)
	absentRow["state"] = "absent"
	absentRow["storage"] = map[string]any{
		"dir": "/home/alice/models", "primary_path": "/home/alice/models/a.gguf",
		"dedicated_dir": false, "disk_bytes": 100, "files_present": true,
		"files": []any{map[string]any{"path": "/home/alice/models/a.gguf", "role": "weights", "size_bytes": 100, "present": true, "shared": false}},
	}

	// Row 1 is idle: trims/clips paths, clamps negatives, drops empty file paths, coerces unknown role.
	idleRow := rows[1].(map[string]any)
	idleRow["state"] = "idle"
	idleRow["storage"] = map[string]any{
		"dir":           "  /home/alice/models  ",
		"primary_path":  "  /home/alice/models/qwen.gguf  ",
		"dedicated_dir": false,
		"disk_bytes":    -42,
		"files_present": true,
		"files": []any{
			map[string]any{"path": "  /home/alice/models/qwen.gguf ", "role": "weights", "size_bytes": 1234, "present": true, "shared": false},
			map[string]any{"path": "   ", "role": "mmproj", "size_bytes": 10, "present": true, "shared": false},
			map[string]any{"path": "/home/alice/models/assets/extra.bin", "role": "future_role", "size_bytes": -9, "present": false, "shared": true},
		},
	}

	// Row 2 is idle with empty files after dropping blank paths: storage becomes nil.
	emptyRow := rows[2].(map[string]any)
	emptyRow["state"] = "idle"
	emptyRow["storage"] = map[string]any{
		"dir": "/home/alice/models", "primary_path": "/home/alice/models/empty.gguf",
		"dedicated_dir": false, "disk_bytes": 0, "files_present": false,
		"files": []any{map[string]any{"path": "   ", "role": "weights", "size_bytes": 0, "present": false, "shared": false}},
	}

	encoded, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := mapStatus(encoded, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Host == nil || snapshot.Host.ModelsDir != "/home/alice/.simplexai/runtime/localmodels/models/models" ||
		snapshot.Host.ModelsDirExists == nil || !*snapshot.Host.ModelsDirExists {
		t.Fatalf("host storage = %+v", snapshot.Host)
	}
	if snapshot.Models[0].Storage != nil {
		t.Fatalf("absent model kept storage: %+v", snapshot.Models[0].Storage)
	}
	got := snapshot.Models[1].Storage
	want := &wire.LocalModelStorage{
		Dir:          "/home/alice/models",
		PrimaryPath:  "/home/alice/models/qwen.gguf",
		DedicatedDir: false,
		DiskBytes:    0,
		FilesPresent: true,
		Files: []wire.LocalModelStorageFile{
			{Path: "/home/alice/models/qwen.gguf", Role: "weights", SizeBytes: 1234, Present: true, Shared: false},
			{Path: "/home/alice/models/assets/extra.bin", Role: "other", SizeBytes: 0, Present: false, Shared: true},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sanitized storage = %+v, want %+v", got, want)
	}
	if snapshot.Models[2].Storage != nil {
		t.Fatalf("model with no valid storage files kept storage: %+v", snapshot.Models[2].Storage)
	}
}
