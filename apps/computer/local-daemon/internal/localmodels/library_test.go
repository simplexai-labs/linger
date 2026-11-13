package localmodels

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const testModel = "qwen3-4b:Q4_K_M"

// recorder collects what a Library publishes and how often it asked for
// the Runtime diagnostics again.
type recorder struct {
	mu             sync.Mutex
	snapshots      []wire.LocalModelsSnapshot
	at             []time.Time
	runtimeChanges int
}

func (r *recorder) publish(snapshot wire.LocalModelsSnapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.snapshots = append(r.snapshots, snapshot)
	r.at = append(r.at, time.Now())
}

func (r *recorder) runtimeChanged() {
	r.mu.Lock()
	r.runtimeChanges++
	r.mu.Unlock()
}

func (r *recorder) last() wire.LocalModelsSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.snapshots[len(r.snapshots)-1]
}

func (r *recorder) changes() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.runtimeChanges
}

// waitFor polls condition; the budget is a harness bound for loaded machines.
func waitFor(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func newLibrary(t *testing.T, fake *fakeTool, record *recorder, interval time.Duration) *Library {
	t.Helper()
	var tool *Tool
	if fake != nil {
		tool = &fake.tool
	}
	library := New(Options{
		Tool: tool, Environment: map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PYTHONHOME": "/elsewhere", "PATH": os.Getenv("PATH")},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"), Publish: record.publish, RuntimeChanged: record.runtimeChanged,
		ProgressInterval: interval,
	})
	t.Cleanup(library.Close)
	return library
}

func modelState(snapshot wire.LocalModelsSnapshot, id string) *wire.LocalModel {
	for index := range snapshot.Models {
		if snapshot.Models[index].ID == id {
			return &snapshot.Models[index]
		}
	}
	return nil
}

func soon() time.Time { return time.Now().Add(15 * time.Second) }

func TestRefreshMapsLibraryStatusToTheWireSnapshot(t *testing.T) {
	fake := newFakeTool(t)
	unfit := model("giant-405b:Q4_K_M", "absent")
	unfit["fit"], unfit["pool"] = "none", ""
	unfit["availability"] = map[string]any{"downloadable": false, "reason": map[string]any{"code": "MEMORY_INSUFFICIENT", "need_bytes": 200 << 30, "have_bytes": 24 << 30}}
	fake.write("status.json", status(model(testModel, "downloading"), unfit))
	record := &recorder{}
	snapshot := newLibrary(t, fake, record, time.Second).Refresh(context.Background())
	if !snapshot.Available || snapshot.ToolVersion != "0.9.0" || snapshot.ObservedAt != "2026-11-13T08:00:00Z" {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	if len(snapshot.Pools) != 2 || snapshot.Pools[0].Kind != "gpu" || snapshot.Pools[0].GpuIndex == nil || *snapshot.Pools[0].GpuIndex != 0 ||
		snapshot.Pools[1].Kind != "system" || snapshot.Pools[1].GpuIndex != nil || snapshot.Pools[1].Holders[0].Kind != "component" {
		t.Fatalf("pools = %+v", snapshot.Pools)
	}
	downloading := modelState(snapshot, testModel)
	if downloading == nil || downloading.State != "downloading" || downloading.Download.DoneBytes != 1<<30 || *downloading.Download.BytesPerSecond != 1<<20 {
		t.Fatalf("model = %+v", downloading)
	}
	if giant := modelState(snapshot, "giant-405b:Q4_K_M"); giant == nil || giant.Pool != "" || giant.Availability.Reason.Code != "MEMORY_INSUFFICIENT" {
		t.Fatalf("model that fits nowhere = %+v", giant)
	}
	encoded, _ := json.Marshal(snapshot)
	if strings.Contains(string(encoded), `"pool":""`) {
		t.Fatalf("a model without a pool sent an empty pool: %s", encoded)
	}
	if len(record.snapshots) != 1 {
		t.Fatalf("published %d snapshots", len(record.snapshots))
	}
	call := fake.calls()[0]
	if !strings.HasPrefix(call, "status --base-dir "+fake.tool.BaseDirectory+" --json|PYTHONPATH="+fake.tool.ModuleDirectory+"|cwd="+fake.tool.ModuleDirectory) {
		t.Fatalf("status call = %q", call)
	}
}

func TestRefreshRejectsStatusOutsideTheContract(t *testing.T) {
	fake := newFakeTool(t)
	broken := model(testModel, "warming")
	// An Agent stores pi_model whole, so one longer than the contract is not cut.
	long := model("other:Q4_K_M", "idle")
	long["pi_model"] = "localmodels-library/" + strings.Repeat("x", 200)
	for _, entry := range []map[string]any{broken, long} {
		fake.write("status.json", status(entry))
		snapshot := newLibrary(t, fake, &recorder{}, time.Second).Refresh(context.Background())
		if snapshot.Available || snapshot.Reason.Code != CodeToolFailed || strings.Contains(snapshot.Reason.Detail, "warming") {
			t.Fatalf("snapshot = %+v", snapshot)
		}
	}
}

func TestFailedStatusReportsToolFailedWithoutLocalDetail(t *testing.T) {
	fake := newFakeTool(t)
	if err := os.WriteFile(filepath.Join(fake.state, "status-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	library := newLibrary(t, fake, &recorder{}, time.Second)
	snapshot := library.Refresh(context.Background())
	if snapshot.Available || snapshot.Reason.Code != CodeToolFailed || strings.Contains(snapshot.Reason.Detail, "/private/path") {
		t.Fatalf("snapshot = %+v", snapshot)
	}
	refusal, _ := library.Act(context.Background(), Action{Name: ActionRefresh}, soon())
	if refusal == nil || refusal.Code != CodeToolFailed {
		t.Fatalf("refresh refusal = %+v", refusal)
	}
}

func TestComputerWithoutTheToolReportsToolNotInstalled(t *testing.T) {
	missing := newFakeTool(t)
	missing.tool.Python = filepath.Join(t.TempDir(), "python3")
	for name, fake := range map[string]*fakeTool{"no config": nil, "missing interpreter": missing} {
		t.Run(name, func(t *testing.T) {
			record := &recorder{}
			library := newLibrary(t, fake, record, time.Second)
			snapshot := library.Refresh(context.Background())
			if snapshot.Available || snapshot.Reason == nil || snapshot.Reason.Code != CodeToolNotInstalled ||
				snapshot.Pools == nil || snapshot.Models == nil {
				t.Fatalf("snapshot = %+v", snapshot)
			}
			for _, action := range []Action{{Name: ActionDownload, Model: testModel}, {Name: ActionRefresh}} {
				if refusal, _ := library.Act(context.Background(), action, soon()); refusal == nil || refusal.Code != CodeToolNotInstalled {
					t.Fatalf("%s refusal = %+v", action.Name, refusal)
				}
			}
		})
	}
}

func TestDownloadIsAcceptedAtItsFirstProgressAndThrottlesProgress(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "absent")))
	lines := []fakeLine{{Line: progressLine(testModel, "download", 0, 3000)}}
	for done := 100; done <= 3000; done += 100 {
		lines = append(lines, fakeLine{Line: progressLine(testModel, "download", done, 3000), DelayMS: 20})
	}
	lines = append(lines, fakeLine{Line: progressLine(testModel, "verify", 3000, 3000)}, fakeLine{Line: resultLine(testModel), DelayMS: 50})
	loaded := status(model(testModel, "loaded"))
	encodedLoaded, _ := json.Marshal(loaded)
	fake.script("download", fakeScript{Lines: lines, StatusAfter: encodedLoaded})
	record := &recorder{}
	interval := 200 * time.Millisecond
	library := newLibrary(t, fake, record, interval)
	library.Refresh(context.Background())

	started := time.Now()
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionDownload, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("download refused: %+v", refusal)
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("the answer waited %s for the job instead of its first event", elapsed)
	}
	waitFor(t, "the loaded snapshot", func() bool {
		record.mu.Lock()
		defer record.mu.Unlock()
		last := record.snapshots[len(record.snapshots)-1]
		model := modelState(last, testModel)
		return model != nil && model.State == "loaded"
	})
	record.mu.Lock()
	defer record.mu.Unlock()
	var progressTimes []time.Time
	for index, snapshot := range record.snapshots {
		if model := modelState(snapshot, testModel); model != nil && model.State == "downloading" {
			progressTimes = append(progressTimes, record.at[index])
		}
	}
	// About 30 lines over 600 ms publish at most every 200 ms.
	if len(progressTimes) < 2 || len(progressTimes) > 6 {
		t.Fatalf("published %d progress snapshots", len(progressTimes))
	}
	for index := 1; index < len(progressTimes); index++ {
		if gap := progressTimes[index].Sub(progressTimes[index-1]); gap < interval-20*time.Millisecond {
			t.Fatalf("progress snapshots %s apart, interval %s", gap, interval)
		}
	}
	final := modelState(record.snapshots[len(record.snapshots)-1], testModel)
	if final.Endpoint == nil || final.Endpoint.BaseURL != "http://127.0.0.1:18100/v1" || final.PiModel != testPiModel {
		t.Fatalf("loaded model = %+v, endpoint %+v", final, final.Endpoint)
	}
}

func TestLoadRefusalBeforeWorkStartsIsTheAnswer(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	fake.script("load", fakeScript{
		Lines: []fakeLine{{Line: errorLine(testModel, "LOAD_NO_ROOM", `,"pool":"gpu:0","need_bytes":4294967296,"free_bytes":1073741824`)}},
		Exit:  2,
	})
	record := &recorder{}
	library := newLibrary(t, fake, record, time.Second)
	library.Refresh(context.Background())
	refusal, _ := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel, UnloadFirst: []string{"gemma3-4b:Q4_K_M"}}, soon())
	if refusal == nil || refusal.Code != "LOAD_NO_ROOM" || refusal.Pool != "gpu:0" ||
		refusal.NeedBytes == nil || *refusal.NeedBytes != 4<<30 || refusal.FreeBytes == nil || *refusal.FreeBytes != 1<<30 {
		t.Fatalf("refusal = %+v", refusal)
	}
	waitFor(t, "the load call", func() bool { return len(fake.calls()) == 2 })
	if call := fake.calls()[1]; !strings.HasPrefix(call, "load "+testModel+" --unload gemma3-4b:Q4_K_M --base-dir ") {
		t.Fatalf("load call = %q", call)
	}
	time.Sleep(100 * time.Millisecond)
	if len(record.snapshots) != 1 || record.changes() != 0 {
		t.Fatalf("a refused load published %d snapshots and %d runtime changes", len(record.snapshots), record.changes())
	}
}

func TestDownloadRefusalCarriesWhatTheDiskHas(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "absent")))
	fake.script("download", fakeScript{
		Lines: []fakeLine{{Line: errorLine(testModel, "DISK_INSUFFICIENT", `,"need_bytes":10,"have_bytes":4`)}}, Exit: 2,
	})
	refusal, _ := newLibrary(t, fake, &recorder{}, time.Second).Act(context.Background(), Action{Name: ActionDownload, Model: testModel}, soon())
	if refusal == nil || refusal.Code != "DISK_INSUFFICIENT" || *refusal.NeedBytes != 10 || *refusal.FreeBytes != 4 {
		t.Fatalf("refusal = %+v", refusal)
	}
}

func TestUnloadAndRemoveAnswerWhenTheToolFinishes(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	idle, _ := json.Marshal(status(model(testModel, "idle")))
	fake.script("unload", fakeScript{Lines: []fakeLine{{Line: resultLine(testModel)}}, StatusAfter: idle})
	fake.script("remove", fakeScript{Lines: []fakeLine{{Line: errorLine(testModel, "INVALID_STATE", "")}}, Exit: 2})
	record := &recorder{}
	library := newLibrary(t, fake, record, time.Second)
	library.Refresh(context.Background())

	if refusal, _ := library.Act(context.Background(), Action{Name: ActionUnload, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("unload refused: %+v", refusal)
	}
	waitFor(t, "the idle snapshot and a diagnostics re-run", func() bool {
		model := modelState(record.last(), testModel)
		return model.State == "idle" && model.Endpoint == nil && record.changes() > 0
	})
	refusal, _ := library.Act(context.Background(), Action{Name: ActionRemove, Model: testModel}, soon())
	if refusal == nil || refusal.Code != "INVALID_STATE" || refusal.Detail != "refused by the fake" {
		t.Fatalf("remove refusal = %+v", refusal)
	}
}

func TestCancelStopsARunningDownload(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "absent")))
	lines := []fakeLine{{Line: progressLine(testModel, "download", 0, 100)}}
	for range 200 {
		lines = append(lines, fakeLine{Line: progressLine(testModel, "download", 1, 100), DelayMS: 50, CancelAware: true})
	}
	fake.script("download", fakeScript{Lines: lines})
	fake.script("cancel", fakeScript{Lines: []fakeLine{{Line: resultLine(testModel)}}, MarkCancelled: true})
	record := &recorder{}
	library := newLibrary(t, fake, record, 50*time.Millisecond)
	library.Refresh(context.Background())
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionDownload, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("download refused: %+v", refusal)
	}
	waitFor(t, "a downloading snapshot", func() bool { return modelState(record.last(), testModel).State == "downloading" })
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionCancel, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("cancel refused: %+v", refusal)
	}
	waitFor(t, "the cancelled download to end", func() bool {
		library.mu.Lock()
		defer library.mu.Unlock()
		return len(library.jobs) == 0 && modelState(*library.current, testModel).State == "absent"
	})
	if !slices.ContainsFunc(fake.calls(), func(call string) bool { return strings.HasPrefix(call, "cancel "+testModel+" --base-dir ") }) {
		t.Fatalf("calls = %q", fake.calls())
	}
}

func TestJobThatExitsWithoutEventsIsRefusedAndOneThatCrashesIsReread(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "absent")))
	fake.script("download", fakeScript{Exit: 1})
	record := &recorder{}
	library := newLibrary(t, fake, record, time.Second)
	library.Refresh(context.Background())
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionDownload, Model: testModel}, soon()); refusal == nil || refusal.Code != CodeToolFailed {
		t.Fatalf("silent exit answer = %+v", refusal)
	}

	failed := model(testModel, "failed")
	failed["error"] = map[string]any{"code": "DOWNLOAD_FAILED", "detail": "stale job"}
	encodedFailed, _ := json.Marshal(status(failed))
	fake.script("download", fakeScript{Lines: []fakeLine{{Line: progressLine(testModel, "download", 0, 100)}}, Exit: 1, StatusAfter: encodedFailed})
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionDownload, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("download refused: %+v", refusal)
	}
	waitFor(t, "the failed state from status", func() bool {
		model := modelState(record.last(), testModel)
		return model.State == "failed" && model.Error != nil && model.Error.Code == "DOWNLOAD_FAILED"
	})
}

func TestAnswerAfterTheDeadlineIsNotAGuessAndShowsInASnapshot(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		action Action
		script fakeScript
	}{
		{"load refused late", Action{Name: ActionLoad, Model: testModel},
			fakeScript{Lines: []fakeLine{{Line: errorLine(testModel, "LOAD_NO_ROOM", ""), DelayMS: 250}}, Exit: 2}},
		{"unload refused late", Action{Name: ActionUnload, Model: testModel},
			fakeScript{Lines: []fakeLine{{Line: errorLine(testModel, "INVALID_STATE", ""), DelayMS: 250}}, Exit: 2}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fake := newFakeTool(t)
			fake.write("status.json", status(model(testModel, "idle")))
			fake.script(scenario.action.Name, scenario.script)
			record := &recorder{}
			library := newLibrary(t, fake, record, 20*time.Millisecond)
			library.Refresh(context.Background())
			started := time.Now()
			refusal, answered := library.Act(context.Background(), scenario.action, started.Add(50*time.Millisecond))
			if answered || refusal != nil {
				t.Fatalf("the deadline passed before the tool decided, yet the answer is %+v (answered %v)", refusal, answered)
			}
			if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
				t.Fatalf("the answer waited %s past the deadline", elapsed)
			}
			// The late refusal changes nothing, and a fresh snapshot shows it.
			waitFor(t, "the snapshot after the late refusal", func() bool {
				record.mu.Lock()
				defer record.mu.Unlock()
				return len(record.snapshots) == 2
			})
			if got := modelState(record.last(), testModel); got.State != "idle" {
				t.Fatalf("model = %+v", got)
			}
		})
	}
}

func TestFollowingAJobSurvivesAFailedStatusRead(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "downloading")))
	record := &recorder{}
	library := newLibrary(t, fake, record, 20*time.Millisecond)
	library.Refresh(context.Background())
	failStatus(t, fake, true)
	waitFor(t, "the failed read", func() bool { return !record.last().Available })
	// The tool recovers and the job it was following has finished meanwhile.
	failStatus(t, fake, false)
	fake.write("status.json", status(model(testModel, "loaded")))
	waitFor(t, "the read after recovery", func() bool {
		model := modelState(record.last(), testModel)
		return model != nil && model.State == "loaded"
	})
	waitFor(t, "the Pi diagnostics for the new model", func() bool { return record.changes() == 1 })
}

func TestAFailedFirstReadIsRetried(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	failStatus(t, fake, true)
	record := &recorder{}
	library := newLibrary(t, fake, record, 20*time.Millisecond)
	if library.Refresh(context.Background()).Available {
		t.Fatal("the failing read reported a library")
	}
	failStatus(t, fake, false)
	waitFor(t, "a retried read", func() bool { return record.last().Available })
	calls := len(fake.calls())
	time.Sleep(200 * time.Millisecond)
	if len(fake.calls()) != calls {
		t.Fatal("reads continued after a library with nothing to follow")
	}
}

// failStatus makes `library status` exit 1 until it is called with false.
func failStatus(t *testing.T, fake *fakeTool, fail bool) {
	t.Helper()
	path := filepath.Join(fake.state, "status-exit")
	if !fail {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
		return
	}
	if err := os.WriteFile(path, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestALoadingSnapshotShowsWhatTheLoadReservedAndFreed(t *testing.T) {
	fake := newFakeTool(t)
	other := model("gemma3-4b:Q4_K_M", "loaded")
	fake.write("status.json", status(model(testModel, "idle"), other))
	lines := []fakeLine{{Line: progressLine(testModel, "load", 0, 3), DelayMS: 100}}
	for range 200 {
		lines = append(lines, fakeLine{Line: progressLine(testModel, "load", 1, 3), DelayMS: 50, CancelAware: true})
	}
	fake.script("load", fakeScript{Lines: lines})
	record := &recorder{}
	library := newLibrary(t, fake, record, 20*time.Millisecond)
	library.Refresh(context.Background())
	t.Cleanup(func() {
		_ = os.WriteFile(filepath.Join(fake.state, "cancelled"), nil, 0o600)
		waitFor(t, "the job to end", func() bool { library.mu.Lock(); defer library.mu.Unlock(); return len(library.jobs) == 0 })
	})
	// What localmodels records before its first load line: the model it
	// unloads first is idle and the load's memory is reserved.
	reserved := status(model(testModel, "loading"), model("gemma3-4b:Q4_K_M", "idle"))
	pool := reserved["pools"].([]any)[0].(map[string]any)
	pool["used_bytes"] = 4 << 30
	pool["holders"] = []any{map[string]any{"kind": "model", "id": testModel, "name": "Qwen3 4B", "bytes": 4 << 30}}
	fake.write("status.json", reserved)
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel, UnloadFirst: []string{"gemma3-4b:Q4_K_M"}}, soon()); refusal != nil {
		t.Fatal(refusal)
	}
	waitFor(t, "the loading snapshot", func() bool { return modelState(record.last(), testModel).State == "loading" })
	record.mu.Lock()
	defer record.mu.Unlock()
	for _, snapshot := range record.snapshots {
		if modelState(snapshot, testModel).State != "loading" {
			continue
		}
		if snapshot.Pools[0].UsedBytes != 4<<30 || len(snapshot.Pools[0].Holders) != 1 {
			t.Fatalf("a loading snapshot shows the pool before its reservation: %+v", snapshot.Pools[0])
		}
		if freed := modelState(snapshot, "gemma3-4b:Q4_K_M"); freed.State != "idle" || freed.Endpoint != nil {
			t.Fatalf("the model unloaded first still shows %+v", freed)
		}
	}
}

func TestAFailedPhaseReadIsRetriedWithinThePhase(t *testing.T) {
	fake := newFakeTool(t)
	other := "gemma3-4b:Q4_K_M"
	fake.write("status.json", status(model(testModel, "idle"), model(other, "loaded")))
	lines := []fakeLine{{Line: progressLine(testModel, "load", 0, 3)}}
	for range 2000 {
		lines = append(lines, fakeLine{Line: progressLine(testModel, "load", 1, 3), DelayMS: 50, CancelAware: true})
	}
	fake.script("load", fakeScript{Lines: lines})
	record := &recorder{}
	library := newLibrary(t, fake, record, 20*time.Millisecond)
	library.Refresh(context.Background())
	t.Cleanup(func() {
		_ = os.WriteFile(filepath.Join(fake.state, "cancelled"), nil, 0o600)
		waitFor(t, "the job to end", func() bool { library.mu.Lock(); defer library.mu.Unlock(); return len(library.jobs) == 0 })
	})
	// The read at the start of the load phase fails.
	failStatus(t, fake, true)
	if refusal, answered := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel, UnloadFirst: []string{other}}, soon()); refusal != nil || !answered {
		t.Fatalf("refusal = %+v, answered = %v", refusal, answered)
	}
	waitFor(t, "the loading snapshot", func() bool {
		model := modelState(record.last(), testModel)
		return model != nil && model.State == "loading"
	})
	// The tool recovers while the job stays in the same phase: what the load
	// reserved and freed must still reach the page.
	reserved := status(model(testModel, "loading"), model(other, "idle"))
	pool := reserved["pools"].([]any)[0].(map[string]any)
	pool["used_bytes"] = 4 << 30
	pool["holders"] = []any{map[string]any{"kind": "model", "id": testModel, "name": "Qwen3 4B", "bytes": 4 << 30}}
	fake.write("status.json", reserved)
	failStatus(t, fake, false)
	waitFor(t, "the reread after the failed phase read", func() bool {
		last := record.last()
		if !last.Available || len(last.Pools) == 0 {
			return false
		}
		freed := modelState(last, other)
		return last.Pools[0].UsedBytes == 4<<30 && freed != nil && freed.State == "idle" && freed.Endpoint == nil
	})
}

func TestRestartedLibraryFollowsAJobFromStatus(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "downloading")))
	record := &recorder{}
	library := newLibrary(t, fake, record, 50*time.Millisecond)
	library.Refresh(context.Background())
	waitFor(t, "a status poll", func() bool { return len(fake.calls()) >= 3 })
	fake.write("status.json", status(model(testModel, "idle")))
	waitFor(t, "the finished job", func() bool { return modelState(record.last(), testModel).State == "idle" })
	time.Sleep(200 * time.Millisecond)
	calls := len(fake.calls())
	time.Sleep(200 * time.Millisecond)
	if len(fake.calls()) != calls {
		t.Fatal("polling continued after the job ended")
	}
}

func TestPiModelPassesThroughAndTheEndpointKeepsOnlyItsURL(t *testing.T) {
	fake := newFakeTool(t)
	idle := model(testModel, "idle")
	// An endpoint outside the loaded state is not the contract's.
	idle["endpoint"] = map[string]any{"base_url": "http://127.0.0.1:18100/v1"}
	fake.write("status.json", status(idle))
	record := &recorder{}
	library := newLibrary(t, fake, record, time.Second)
	if got := modelState(library.Refresh(context.Background()), testModel); got.PiModel != testPiModel || got.Endpoint != nil {
		t.Fatalf("idle model = %+v", got)
	}
	fake.write("status.json", status(model(testModel, "loaded")))
	loaded := library.Refresh(context.Background())
	got := modelState(loaded, testModel)
	if got.PiModel != testPiModel || got.Endpoint == nil || got.Endpoint.BaseURL != "http://127.0.0.1:18100/v1" {
		t.Fatalf("loaded model = %+v", got)
	}
	// The gateway's own model id is not an Agent's runtime_model.
	if encoded, _ := json.Marshal(loaded); strings.Contains(string(encoded), "gateway_model") {
		t.Fatalf("snapshot carries the gateway's model id: %s", encoded)
	}
}

func TestChangeOfTheLoadedModelsAsksForRuntimeDiagnostics(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	record := &recorder{}
	library := newLibrary(t, fake, record, time.Second)
	library.Refresh(context.Background())
	if record.changes() != 0 {
		t.Fatalf("the first read asked for %d diagnostics", record.changes())
	}
	fake.write("status.json", status(model(testModel, "loaded")))
	library.Refresh(context.Background())
	library.Refresh(context.Background())
	if record.changes() != 1 {
		t.Fatalf("a load asked for %d diagnostics, want 1", record.changes())
	}
	fake.write("status.json", status(model(testModel, "idle")))
	library.Refresh(context.Background())
	if record.changes() != 2 {
		t.Fatalf("an unload asked for %d diagnostics in all, want 2", record.changes())
	}
}
