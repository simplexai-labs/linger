package localmodels

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake localmodels tool: a Library under test
// runs os.Args[0] as its "python" with LOCALMODELS_FAKE_TOOL=1. The fake
// reads its behavior from files in LOCALMODELS_STATE:
//
//   - status.json is what `library status` prints; status-exit makes it
//     fail with that exit code.
//   - <verb>.json is a fakeScript for every other verb.
//   - calls.log records each call's arguments and tool environment.
func TestMain(m *testing.M) {
	if os.Getenv("LOCALMODELS_FAKE_TOOL") == "1" {
		os.Exit(runFakeTool(os.Args[1:]))
	}
	os.Exit(m.Run())
}

type fakeScript struct {
	Lines []fakeLine `json:"lines"`
	Exit  int        `json:"exit"`
	// StatusAfter replaces status.json before the tool exits.
	StatusAfter json.RawMessage `json:"status_after,omitempty"`
	// MarkCancelled makes this call (a cancel) mark the download cancelled.
	MarkCancelled bool `json:"mark_cancelled,omitempty"`
}

type fakeLine struct {
	Line    json.RawMessage `json:"line"`
	DelayMS int             `json:"delay_ms,omitempty"`
	// CancelAware lines stop the call with CANCELLED once a cancel ran.
	CancelAware bool `json:"cancel_aware,omitempty"`
}

func runFakeTool(args []string) int {
	state := os.Getenv("LOCALMODELS_STATE")
	if len(args) < 6 || strings.Join(args[:5], " ") != "-P -s -m localmodels library" {
		fmt.Fprintln(os.Stderr, "unexpected invocation", args)
		return 3
	}
	verb := args[5]
	log, _ := os.OpenFile(filepath.Join(state, "calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	_, _ = fmt.Fprintf(log, "%s|PYTHONPATH=%s|cwd=%s\n", strings.Join(args[5:], " "), os.Getenv("PYTHONPATH"), workingDirectory())
	_ = log.Close()
	if verb == "status" {
		if code, err := os.ReadFile(filepath.Join(state, "status-exit")); err == nil {
			var exit int
			_, _ = fmt.Sscan(string(code), &exit)
			fmt.Fprintln(os.Stderr, "error: library status failed: /private/path")
			return exit
		}
		status, err := os.ReadFile(filepath.Join(state, "status.json"))
		if err != nil {
			return 1
		}
		_, _ = os.Stdout.Write(status)
		return 0
	}
	encoded, err := os.ReadFile(filepath.Join(state, verb+".json"))
	if err != nil {
		return 1
	}
	var script fakeScript
	if err := json.Unmarshal(encoded, &script); err != nil {
		return 1
	}
	if script.MarkCancelled {
		_ = os.WriteFile(filepath.Join(state, "cancelled"), nil, 0o600)
	}
	for _, line := range script.Lines {
		time.Sleep(time.Duration(line.DelayMS) * time.Millisecond)
		if _, err := os.Stat(filepath.Join(state, "cancelled")); line.CancelAware && err == nil {
			fmt.Printf(`{"schema":"localmodels.library-event/v1","event":"error","ok":false,"code":"CANCELLED","detail":"the download was cancelled","model":%q}`+"\n", args[6])
			return 130
		}
		fmt.Println(string(line.Line))
	}
	if script.StatusAfter != nil {
		_ = os.WriteFile(filepath.Join(state, "status.json"), script.StatusAfter, 0o600)
	}
	return script.Exit
}

func workingDirectory() string {
	directory, _ := os.Getwd()
	return directory
}

// fakeTool lays out a Tool that runs the fake.
type fakeTool struct {
	t     *testing.T
	tool  Tool
	state string
}

func newFakeTool(t *testing.T) *fakeTool {
	t.Helper()
	root := t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	tool := Tool{
		Python: executable, ModuleDirectory: filepath.Join(root, "kit"),
		StateDirectory: filepath.Join(root, "state"), BaseDirectory: filepath.Join(root, "models"),
	}
	for _, directory := range []string{tool.ModuleDirectory, tool.StateDirectory, tool.BaseDirectory} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	return &fakeTool{t: t, tool: tool, state: tool.StateDirectory}
}

func (f *fakeTool) write(name string, value any) {
	f.t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.state, name), encoded, 0o600); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fakeTool) script(verb string, script fakeScript) { f.write(verb+".json", script) }

func (f *fakeTool) calls() []string {
	encoded, _ := os.ReadFile(filepath.Join(f.state, "calls.log"))
	return strings.Split(strings.TrimSpace(string(encoded)), "\n")
}

// status is a library-status/v1 document with the given model states.
func status(models ...map[string]any) map[string]any {
	if models == nil {
		models = []map[string]any{}
	}
	return map[string]any{
		"schema": "localmodels.library-status/v1", "tool_version": "0.9.0", "observed_at": "2026-11-13T08:00:00+00:00",
		"host": map[string]any{
			"platform": "linux", "arch": "x86_64", "os_label": "Ubuntu 24.04", "engine_label": "llama.cpp b11370 · CUDA",
			"ram_total_bytes": 64 << 30, "disk_free_bytes": 500 << 30,
			"gpus":  []any{map[string]any{"index": 0, "uuid": "GPU-1", "name": "RTX 4090", "total_bytes": 24 << 30, "free_bytes": 20 << 30}},
			"extra": "ignored",
		},
		"pools": []any{
			map[string]any{"id": "gpu:0", "total_bytes": 24 << 30, "used_bytes": 0, "holders": []any{}},
			map[string]any{"id": "system", "total_bytes": 51 << 30, "used_bytes": 1 << 30, "holders": []any{
				map[string]any{"kind": "component", "id": "embedding", "name": "Embedding", "bytes": 1 << 30},
			}},
		},
		"models": models,
	}
}

// testPiModel is the Pi key localmodels reports for testModel while it is on
// the Computer.
const testPiModel = "localmodels-library/localmodels-lib-qwen3-4b-q4-k-m/Qwen3-4B-Q4_K_M"

func model(id, state string) map[string]any {
	entry := map[string]any{
		"id": id, "name": "Qwen3 4B", "description": "A small model.", "quant": "Q4_K_M",
		"context_tokens": 32768, "vision": false, "download_bytes": 3 << 30, "memory_bytes": 4 << 30,
		"fit": "gpu", "recommended": false, "availability": map[string]any{"downloadable": true},
		"pool": "gpu:0", "state": state,
	}
	if state != "absent" && state != "downloading" {
		entry["pi_model"] = testPiModel
	}
	switch state {
	case "loaded":
		entry["endpoint"] = map[string]any{"base_url": "http://127.0.0.1:18100/v1", "gateway_model": "localmodels-library/" + id}
		entry["tokens_per_second"] = 41.5
	case "downloading":
		entry["download"] = map[string]any{"step": "download", "done_bytes": 1 << 30, "total_bytes": 3 << 30, "bytes_per_second": 1 << 20}
	}
	return entry
}

func progressLine(id, phase string, done, total int) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"schema":"localmodels.library-event/v1","event":"progress","model":%q,"phase":%q,"done":%d,"total":%d,"bytes_per_second":1048576}`, id, phase, done, total))
}

func resultLine(id string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"schema":"localmodels.library-event/v1","event":"result","ok":true,"model":{"id":%q}}`, id))
}

func errorLine(id, code, extra string) json.RawMessage {
	return json.RawMessage(fmt.Sprintf(`{"schema":"localmodels.library-event/v1","event":"error","ok":false,"code":%q,"detail":"refused by the fake","model":%q%s}`, code, id, extra))
}
