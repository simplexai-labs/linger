package localmodels

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
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
//   - jobs/<pid> exists while a download or load runs.
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
	Line     json.RawMessage `json:"line"`
	DelayMS  int             `json:"delay_ms,omitempty"`
	WaitFile string          `json:"wait_file,omitempty"`
	// CancelAware lines stop the call with CANCELLED once a cancel ran.
	CancelAware bool `json:"cancel_aware,omitempty"`
}

func runFakeTool(args []string) int {
	state := os.Getenv("LOCALMODELS_STATE")
	if len(args) >= 6 && strings.Join(args[:5], " ") == "-P -s -m localmodels source" {
		return runFakeSourceTool(state, args[5:])
	}
	if len(args) >= 6 && strings.Join(args[:5], " ") == "-P -s -m localmodels harness" {
		return runFakeHarness(state, args[5:])
	}
	if len(args) >= 6 && strings.Join(args[:5], " ") == "-P -s -m localmodels speech" {
		return runFakeSpeechTool(state, args[5:])
	}
	if len(args) < 6 || strings.Join(args[:5], " ") != "-P -s -m localmodels library" {
		fmt.Fprintln(os.Stderr, "unexpected invocation", args)
		return 3
	}
	verb := args[5]
	if verb == "download" || verb == "load" {
		marker := filepath.Join(state, "jobs", strconv.Itoa(os.Getpid()))
		_ = os.MkdirAll(filepath.Dir(marker), 0o700)
		_ = os.WriteFile(marker, nil, 0o600)
		defer func() { _ = os.Remove(marker) }()
	}
	log, _ := os.OpenFile(filepath.Join(state, "calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	_, _ = fmt.Fprintf(log, "%s|PYTHONPATH=%s|cwd=%s|PI_CODING_AGENT_DIR=%s\n", strings.Join(args[5:], " "), os.Getenv("PYTHONPATH"), workingDirectory(), os.Getenv("PI_CODING_AGENT_DIR"))
	_ = log.Close()
	if verb == "status" {
		waitGate := filepath.Join(state, "status-wait")
		if _, err := os.Stat(waitGate); err == nil {
			_ = os.WriteFile(filepath.Join(state, "status-entered"), []byte("1"), 0o600)
			waitForGateRemoval(waitGate, 30*time.Second)
		}
		if code, err := os.ReadFile(filepath.Join(state, "status-exit")); err == nil {
			var exit int
			_, _ = fmt.Sscan(string(code), &exit)
			fmt.Fprintln(os.Stderr, "error: library status failed: /private/path")
			return exit
		}
		status, err := readFileRetrying(filepath.Join(state, "status.json"))
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
		if line.WaitFile != "" {
			waitForGateRemoval(filepath.Join(state, line.WaitFile), 30*time.Second)
		}
		time.Sleep(time.Duration(line.DelayMS) * time.Millisecond)
		if _, err := os.Stat(filepath.Join(state, "cancelled")); line.CancelAware && err == nil {
			fmt.Printf(`{"schema":"localmodels.library-event/v1","event":"error","ok":false,"code":"CANCELLED","detail":"the download was cancelled","model":%q}`+"\n", args[6])
			return 130
		}
		fmt.Println(string(line.Line))
	}
	if script.StatusAfter != nil {
		if err := writeFileAtomic(state, "status.json", script.StatusAfter); err != nil {
			fmt.Fprintf(os.Stderr, "write status.json: %v\n", err)
			return 1
		}
	}
	return script.Exit
}

func readFileRetrying(path string) ([]byte, error) {
	// On Windows, a concurrent atomic rename can transiently reject opens
	// with a sharing violation; retry briefly unless the file is absent.
	deadline := time.Now().Add(2 * time.Second)
	for {
		data, err := os.ReadFile(path)
		if err == nil || os.IsNotExist(err) || !time.Now().Before(deadline) {
			return data, err
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func writeFileAtomic(dir, name string, data []byte) error {
	temp, err := os.CreateTemp(dir, "."+name+".*.tmp")
	if err != nil {
		return err
	}
	tmpPath := temp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o600); err != nil {
		return err
	}
	target := filepath.Join(dir, name)
	// On Windows, replacing a file opened by a concurrent status subprocess
	// can fail transiently with a sharing or access error.
	deadline := time.Now().Add(2 * time.Second)
	for {
		err = os.Rename(tmpPath, target)
		if err == nil {
			cleanup = false
			return nil
		}
		if !time.Now().Before(deadline) {
			return err
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func waitForGateRemoval(gatePath string, timeout time.Duration) {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(gatePath); err != nil {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func workingDirectory() string {
	directory, _ := os.Getwd()
	return directory
}

func runFakeHarness(state string, args []string) int {
	if len(args) < 1 {
		return 3
	}
	verb := args[0]
	log, _ := os.OpenFile(filepath.Join(state, "calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	_, _ = fmt.Fprintf(log, "harness %s|PI_CODING_AGENT_DIR=%s\n", strings.Join(args, " "), os.Getenv("PI_CODING_AGENT_DIR"))
	_ = log.Close()
	argValue := func(flag string) string {
		for index := 0; index+1 < len(args); index++ {
			if args[index] == flag {
				return args[index+1]
			}
		}
		return ""
	}
	root := argValue("--root")
	installedPath := filepath.Join(root, "tools", "pi", "1.3.0", "pi")
	statusJSON := func(installed bool) string {
		if installed {
			return fmt.Sprintf(`{"schema":"localmodels.harness-status/v1","runtimes":[{"runtime":"pi","installed":true,"executable":%q,"argvPrefix":[]}]}`, installedPath)
		}
		return `{"schema":"localmodels.harness-status/v1","runtimes":[{"runtime":"pi","installed":false,"executable":null,"argvPrefix":[]}]}`
	}
	switch verb {
	case "status":
		if _, err := os.Stat(filepath.Join(state, "harness-status-fail")); err == nil {
			return 1
		}
		_, err := os.Stat(filepath.Join(state, "harness-pi-installed"))
		fmt.Println(statusJSON(err == nil))
		return 0
	case "plan":
		waitGate := filepath.Join(state, "harness-plan-wait")
		if _, err := os.Stat(waitGate); err == nil {
			_ = os.WriteFile(filepath.Join(state, "harness-plan-entered"), []byte("1"), 0o600)
			waitForGateRemoval(waitGate, 30*time.Second)
		}
		if _, err := os.Stat(filepath.Join(state, "harness-plan-fail")); err == nil {
			return 1
		}
		outPath := argValue("--out")
		plan := fmt.Sprintf(`{"schema":"localmodels.harness-plan/v1","id":%q,"runtime":"pi","root":%q}`, strings.Repeat("a", 64), root)
		if outPath != "" {
			_ = os.WriteFile(outPath, []byte(plan), 0o600)
		}
		fmt.Println(plan)
		return 0
	case "apply":
		if _, err := os.Stat(filepath.Join(state, "harness-apply-fail")); err == nil {
			return 1
		}
		if argValue("--approve") != strings.Repeat("a", 64) {
			return 2
		}
		_ = os.WriteFile(filepath.Join(state, "harness-pi-installed"), []byte(installedPath), 0o600)
		fmt.Println(`{"kind":"stage","stage":"install","state":"running"}`)
		fmt.Println(statusJSON(true))
		return 0
	default:
		return 3
	}
}

func runFakeSpeechTool(state string, args []string) int {
	if len(args) < 1 {
		return 3
	}
	verb := args[0]
	log, _ := os.OpenFile(filepath.Join(state, "calls.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	_, _ = fmt.Fprintf(log, "speech %s\n", strings.Join(args, " "))
	_ = log.Close()

	if rawCode, err := os.ReadFile(filepath.Join(state, "speech-exit")); err == nil {
		var exit int
		_, _ = fmt.Sscan(string(rawCode), &exit)
		if rawErr, err := os.ReadFile(filepath.Join(state, "speech-stderr")); err == nil {
			_, _ = os.Stderr.Write(rawErr)
		}
		return exit
	}
	if verb == "download" && len(args) >= 2 && args[1] == "bad-model" {
		fmt.Println(`{"schema":"localmodels.speech-event/v1","event":"error","error":{"code":"MODEL_UNKNOWN","message":"unknown"}}`)
		return 2
	}
	if data, err := os.ReadFile(filepath.Join(state, "speech-"+verb+".json")); err == nil {
		_, _ = os.Stdout.Write(data)
		return 0
	}
	switch verb {
	case "download", "load":
		fmt.Println(`{"schema":"localmodels.speech-event/v1","event":"progress","done_bytes":10,"total_bytes":100}`)
		return 0
	case "configure":
		fmt.Println(`{"schema":"localmodels.speech-config/v1","config":{"language":"zh"}}`)
		return 0
	default:
		fmt.Println(`{"schema":"localmodels.speech-event/v1","event":"done"}`)
		return 0
	}
}

// fakeTool lays out a Tool that runs the fake.
type fakeTool struct {
	t     *testing.T
	tool  Tool
	state string
}

func newFakeTool(t *testing.T) *fakeTool {
	t.Helper()
	// The tool reports its working directory as the OS resolves it, and on
	// macOS the temporary directory sits behind the /var symlink.
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Jobs outlive Library.Close and write into this directory until they
	// exit; wait for them before the TempDir cleanup removes it. Cleanups
	// run last-registered first, so this runs after every Close.
	t.Cleanup(func() {
		waitFor(t, "the fake tool's jobs to exit", func() bool {
			entries, err := os.ReadDir(filepath.Join(root, "state", "jobs"))
			return err != nil || len(entries) == 0
		})
	})
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
	if err := writeFileAtomic(f.state, name, encoded); err != nil {
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
