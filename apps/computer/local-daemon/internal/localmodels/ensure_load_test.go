package localmodels

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func newEnsureLibrary(t *testing.T, fake *fakeTool, ensureLoadTimeout time.Duration) *Library {
	t.Helper()
	record := &recorder{}
	library := New(Options{
		Tool: &fake.tool, Environment: map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"), Publish: record.publish, RuntimeChanged: record.runtimeChanged,
		ProgressInterval: 20 * time.Millisecond, EnsureLoadTimeout: ensureLoadTimeout,
	})
	// Fake loaded rows carry a static non-listening 127.0.0.1:18100 endpoint;
	// keep tests that do not start a real HTTP server independent of that port.
	library.healthCheck = func(context.Context, string) bool { return true }
	t.Cleanup(library.Close)
	return library
}

func callsWithPrefix(fake *fakeTool, prefix string) []string {
	var matched []string
	for _, call := range fake.calls() {
		if strings.HasPrefix(call, prefix) {
			matched = append(matched, call)
		}
	}
	return matched
}

// holdLoad scripts a load that reports progress, waits for its gate, then
// leaves the model loaded. It returns a function that releases the gate.
func holdLoad(t *testing.T, fake *fakeTool) func() {
	t.Helper()
	gate := filepath.Join(fake.state, "load-hold")
	if err := os.WriteFile(gate, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	release := func() { _ = os.Remove(gate) }
	t.Cleanup(release)
	loaded, _ := json.Marshal(status(model(testModel, "loaded")))
	fake.script("load", fakeScript{
		Lines:       []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: resultLine(testModel), WaitFile: "load-hold"}},
		StatusAfter: loaded,
	})
	return release
}

func loadCode(err error) string {
	var loadErr *LocalModelLoadError
	if errors.As(err, &loadErr) {
		return loadErr.Code
	}
	return ""
}

func TestEnsureLoadedReturnsAtOnceForALoadedModel(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	library := newEnsureLibrary(t, fake, 0)
	// reconcile rereads a failed read in the background; keep it out of
	// the count.
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := len(fake.calls())
	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	if after := len(fake.calls()); after != before {
		t.Fatalf("a loaded model ran the tool: %v", fake.calls()[before:])
	}
}

func TestEnsureLoadedLoadsAnIdleModelWithoutUnloadingAnother(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 0)
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(context.Background(), testPiModel) }()
	waitFor(t, "the load call", func() bool { return len(callsWithPrefix(fake, "load ")) == 1 })
	select {
	case err := <-done:
		t.Fatalf("returned %v before the model loaded", err)
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	load := callsWithPrefix(fake, "load ")
	if len(load) != 1 || !strings.HasPrefix(load[0], "load "+testModel+" --base-dir ") || strings.Contains(load[0], "--unload") {
		t.Fatalf("load calls = %v", load)
	}
}

func TestEnsureLoadedWaitsForALoadAlreadyRunning(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loading")))
	library := newEnsureLibrary(t, fake, 0)
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(context.Background(), testPiModel) }()
	waitFor(t, "a poll of the running load", func() bool { return len(callsWithPrefix(fake, "status ")) >= 2 })
	fake.write("status.json", status(model(testModel, "loaded")))
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 0 {
		t.Fatalf("started a second load: %v", load)
	}
}

// The contract carries pi_model only while the model is on the Computer;
// a row outside it is still never downloaded.
func TestEnsureLoadedNeverDownloadsARowOutsideTheContract(t *testing.T) {
	for _, state := range []string{"absent", "downloading"} {
		t.Run(state, func(t *testing.T) {
			fake := newFakeTool(t)
			row := model(testModel, state)
			row["pi_model"] = testPiModel
			fake.write("status.json", status(row))
			library := newEnsureLibrary(t, fake, 0)
			if code := loadCode(library.EnsureLoaded(context.Background(), testPiModel)); code != CodeModelNotDownloaded {
				t.Fatalf("code = %q", code)
			}
			for _, call := range fake.calls() {
				if !strings.HasPrefix(call, "status ") {
					t.Fatalf("ran %q", call)
				}
			}
		})
	}
}

func TestEnsureLoadedReportsTheToolsRefusal(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	fake.script("load", fakeScript{Lines: []fakeLine{{Line: errorLine(testModel, "LOAD_NO_ROOM", `,"pool":"gpu:0"`)}}, Exit: 2})
	library := newEnsureLibrary(t, fake, 0)
	err := library.EnsureLoaded(context.Background(), testPiModel)
	var loadErr *LocalModelLoadError
	if !errors.As(err, &loadErr) || loadErr.Code != "LOAD_NO_ROOM" || loadErr.ModelID != testModel {
		t.Fatalf("err = %v", err)
	}
}

func TestEnsureLoadedReportsTheFailedRowsCode(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	failed := model(testModel, "failed")
	failed["error"] = map[string]any{"code": "ENGINE_START_FAILED", "detail": "the engine exited"}
	encodedFailed, _ := json.Marshal(status(failed))
	fake.script("load", fakeScript{
		Lines: []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: errorLine(testModel, "ENGINE_START_FAILED", ""), DelayMS: 20}},
		Exit:  1, StatusAfter: encodedFailed,
	})
	library := newEnsureLibrary(t, fake, 0)
	if code := loadCode(library.EnsureLoaded(context.Background(), testPiModel)); code != "ENGINE_START_FAILED" {
		t.Fatalf("code = %q", code)
	}
}

func TestEnsureLoadedLetsRunsOutsideTheLibraryProceed(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	library := newEnsureLibrary(t, fake, 0)
	// reconcile rereads a failed read in the background; keep it out of
	// the count.
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := len(fake.calls())
	if err := library.EnsureLoaded(context.Background(), "openai/gpt-5"); err != nil {
		t.Fatal(err)
	}
	if len(fake.calls()) != before {
		t.Fatalf("a model outside the library ran the tool: %v", fake.calls()[before:])
	}
	if err := os.WriteFile(filepath.Join(fake.state, "status-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	library.Refresh(context.Background())
	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 0 {
		t.Fatalf("load calls = %v", load)
	}
}

func TestConcurrentEnsureLoadedShareOneLoad(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 0)
	var wg sync.WaitGroup
	errs := make([]error, 2)
	for index := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs[index] = library.EnsureLoaded(context.Background(), testPiModel)
		}()
	}
	waitFor(t, "the load call", func() bool { return len(callsWithPrefix(fake, "load ")) == 1 })
	release()
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 1 {
		t.Fatalf("load calls = %v", load)
	}
}

func TestEnsureLoadedLeavesTheLoadRunningWhenTheRunStops(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 0)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(ctx, testPiModel) }()
	waitFor(t, "the load call", func() bool { return len(callsWithPrefix(fake, "load ")) == 1 })
	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	release()
	waitFor(t, "the load to finish", func() bool {
		row := modelState(library.Refresh(context.Background()), testModel)
		return row != nil && row.State == "loaded"
	})
	if cancels := callsWithPrefix(fake, "cancel "); len(cancels) != 0 {
		t.Fatalf("cancelled the load: %v", cancels)
	}
}

func TestEnsureLoadedGivesUpAfterItsBudget(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 300*time.Millisecond)
	if code := loadCode(library.EnsureLoaded(context.Background(), testPiModel)); code != CodeLoadTimeout {
		t.Fatalf("code = %q", code)
	}
}

func TestAQueuedRunKeepsWaitingAfterAnotherRunsBudgetRanOut(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 5*time.Second)
	first := make(chan error, 1)
	go func() { first <- library.EnsureLoaded(context.Background(), testPiModel) }()
	waitFor(t, "the load call", func() bool { return len(callsWithPrefix(fake, "load ")) == 1 })
	second := make(chan error, 1)
	go func() { second <- library.EnsureLoaded(context.Background(), testPiModel) }()
	if code := loadCode(<-first); code != CodeLoadTimeout {
		t.Fatalf("first code = %q", code)
	}
	select {
	case err := <-second:
		t.Fatalf("the queued Run returned %v while the load ran", err)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 1 {
		t.Fatalf("loads = %v", load)
	}
}

func TestAQueuedRunSharesAFailedLoadsError(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	fake.script("load", fakeScript{Lines: []fakeLine{{Line: errorLine(testModel, "LOAD_NO_ROOM", ""), DelayMS: 300}}, Exit: 2})
	library := newEnsureLibrary(t, fake, 0)
	first := make(chan error, 1)
	go func() { first <- library.EnsureLoaded(context.Background(), testPiModel) }()
	waitFor(t, "the load call", func() bool { return len(callsWithPrefix(fake, "load ")) == 1 })
	second := make(chan error, 1)
	go func() { second <- library.EnsureLoaded(context.Background(), testPiModel) }()
	for _, done := range []chan error{first, second} {
		if code := loadCode(<-done); code != "LOAD_NO_ROOM" {
			t.Fatalf("code = %q", code)
		}
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 1 {
		t.Fatalf("loads = %v", load)
	}
}

func TestAStoppedDownloadIsNotLoaded(t *testing.T) {
	fake := newFakeTool(t)
	stopped := model(testModel, "failed")
	stopped["error"] = map[string]any{"code": "NETWORK_UNAVAILABLE", "detail": "offline"}
	fake.write("status.json", status(stopped))
	library := newEnsureLibrary(t, fake, 0)
	if code := loadCode(library.EnsureLoaded(context.Background(), testPiModel)); code != CodeModelNotDownloaded {
		t.Fatalf("code = %q", code)
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 0 {
		t.Fatalf("loads = %v", load)
	}
}

func TestARunWaitsForALoadTheModelsPageStarted(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 0)
	waiting := make(chan struct{}, 1)
	library.testWaiting = func(string) { waiting <- struct{}{} }
	library.Refresh(context.Background())
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("refused: %+v", refusal)
	}
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(context.Background(), testPiModel) }()
	<-waiting
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if load := callsWithPrefix(fake, "load "); len(load) != 1 {
		t.Fatalf("loads = %v", load)
	}
}

func statusJSON(models ...map[string]any) json.RawMessage {
	encoded, _ := json.Marshal(status(models...))
	return encoded
}

// An accepted load is running when Act answers, so no status read between
// the answer and the job's first status counts as its outcome.
func TestAnAcceptedLoadIsRunningWhenActAnswers(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 0)
	library.Refresh(context.Background())
	if refusal, _ := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon()); refusal != nil {
		t.Fatalf("refused: %+v", refusal)
	}
	library.mu.Lock()
	_, running := library.jobs[testModel]
	library.mu.Unlock()
	if !running {
		t.Fatal("the accepted load was not registered when Act answered")
	}
	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(context.Background(), testPiModel) }()
	// Reads showing the row idle while the load runs are not its outcome.
	for range 3 {
		library.Refresh(context.Background())
	}
	select {
	case err := <-done:
		t.Fatalf("returned %v while the load ran", err)
	case <-time.After(100 * time.Millisecond):
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

// A library the tool cannot read now does not cost a Run a status read.
func TestAnUnreadableLibraryCostsARunNoToolCall(t *testing.T) {
	fake := newFakeTool(t)
	if err := os.WriteFile(filepath.Join(fake.state, "status-exit"), []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	library := newEnsureLibrary(t, fake, 0)
	// reconcile rereads a failed read in the background; keep it out of
	// the count.
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := len(fake.calls())
	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	if len(fake.calls()) != before {
		t.Fatalf("ran the tool: %v", fake.calls()[before:])
	}
}

func startHealthServer(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(server.Close)
	return server
}

func loadedRowWithBaseURL(baseURL string) map[string]any {
	row := model(testModel, "loaded")
	row["endpoint"] = map[string]any{"base_url": baseURL, "model": "Qwen3.8-27B"}
	return row
}

func writeLocalSourceOverlay(t *testing.T, stateDir, gatewayURL string) {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"schema":        "localmodels.model-source/v1",
		"mode":          "local",
		"runtime":       "pi",
		"runtime_model": testPiModel,
		"gateway_url":   gatewayURL,
		"environment":   map[string]string{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "model-source.json"), body, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureLoadedProbesLoopbackHealthAndReturnsAtOnceWhenHealthy(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}
	before := len(fake.calls())
	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	if after := len(fake.calls()); after != before {
		t.Fatalf("healthy loaded model ran the tool: %v", fake.calls()[before:])
	}
}

func TestEnsureLoadedRecoversWhenACachedLoadedServerDies(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Simulate the model server dying after the last snapshot was cached.
	engine.Close()
	failed := model(testModel, "failed")
	failed["error"] = map[string]any{
		"code":   "HEALTH_CHECK_FAILED",
		"detail": "the model server does not answer; load it again",
	}
	fake.write("status.json", status(failed))
	recoveredEngine := startHealthServer(t)
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "idle")),
	})
	fake.script("load", fakeScript{
		Lines:       []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: resultLine(testModel)}},
		StatusAfter: statusJSON(loadedRowWithBaseURL(recoveredEngine.URL + "/v1")),
	})

	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	unloads := callsWithPrefix(fake, "unload ")
	loads := callsWithPrefix(fake, "load ")
	if len(unloads) != 1 || len(loads) != 1 {
		t.Fatalf("unloads = %v, loads = %v", unloads, loads)
	}
}

func TestEnsureLoadedReloadsWhenLocalGatewayDiesWhileEngineAnswers(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}

	// Engine still answers /health, but the local Bifrost gateway stopped.
	gateway.Close()
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "idle")),
	})
	fake.script("load", fakeScript{
		Lines:       []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: resultLine(testModel)}},
		StatusAfter: statusJSON(loadedRowWithBaseURL(engine.URL + "/v1")),
	})

	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	unloads := callsWithPrefix(fake, "unload ")
	loads := callsWithPrefix(fake, "load ")
	if len(unloads) != 1 || len(loads) != 1 {
		t.Fatalf("unloads = %v, loads = %v", unloads, loads)
	}
}

func TestActLoadUnloadsHealthCheckFailedModelFirst(t *testing.T) {
	fake := newFakeTool(t)
	failed := model(testModel, "failed")
	failed["error"] = map[string]any{
		"code":   "HEALTH_CHECK_FAILED",
		"detail": "the model server does not answer; load it again",
	}
	fake.write("status.json", status(failed))
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "idle")),
	})
	fake.script("load", fakeScript{
		Lines:       []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "loaded")),
	})
	library := newEnsureLibrary(t, fake, 0)
	library.Refresh(context.Background())

	refusal, answered := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon())
	if !answered || refusal != nil {
		t.Fatalf("answered = %v, refusal = %+v", answered, refusal)
	}
	waitFor(t, "the model to finish loading", func() bool {
		row := modelState(library.Refresh(context.Background()), testModel)
		return row != nil && row.State == "loaded"
	})
	unloads := callsWithPrefix(fake, "unload ")
	loads := callsWithPrefix(fake, "load ")
	if len(unloads) != 1 || len(loads) != 1 {
		t.Fatalf("unloads = %v, loads = %v", unloads, loads)
	}

	// An unload refusal stops the load before it starts.
	fakeRefuse := newFakeTool(t)
	fakeRefuse.write("status.json", status(failed))
	fakeRefuse.script("unload", fakeScript{
		Lines: []fakeLine{{Line: errorLine(testModel, "JOB_RUNNING", "")}},
		Exit:  2,
	})
	libRefuse := newEnsureLibrary(t, fakeRefuse, 0)
	libRefuse.Refresh(context.Background())
	refusal, answered = libRefuse.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon())
	if !answered || refusal == nil || refusal.Code != "JOB_RUNNING" {
		t.Fatalf("answered = %v, refusal = %+v", answered, refusal)
	}
	if loads := callsWithPrefix(fakeRefuse, "load "); len(loads) != 0 {
		t.Fatalf("started load after unload refusal: %v", loads)
	}

	// When reset-unload succeeds and the subsequent load is refused, the
	// snapshot refreshes to idle and runtimeChanged runs so the UI is not stale.
	fakeLoadRefuse := newFakeTool(t)
	fakeLoadRefuse.write("status.json", status(failed))
	fakeLoadRefuse.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "idle")),
	})
	fakeLoadRefuse.script("load", fakeScript{
		Lines: []fakeLine{{Line: errorLine(testModel, "LOAD_NO_ROOM", "")}},
		Exit:  2,
	})
	rec := &recorder{}
	libLoadRefuse := New(Options{
		Tool: &fakeLoadRefuse.tool, Environment: map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"), Publish: rec.publish, RuntimeChanged: rec.runtimeChanged,
		ProgressInterval: 20 * time.Millisecond,
	})
	libLoadRefuse.healthCheck = func(context.Context, string) bool { return true }
	t.Cleanup(libLoadRefuse.Close)
	libLoadRefuse.Refresh(context.Background())
	refusal, answered = libLoadRefuse.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon())
	if !answered || refusal == nil || refusal.Code != "LOAD_NO_ROOM" {
		t.Fatalf("answered = %v, refusal = %+v", answered, refusal)
	}
	waitFor(t, "snapshot refreshed to idle after refused load", func() bool {
		row := modelState(rec.last(), testModel)
		rec.mu.Lock()
		changed := rec.runtimeChanges > 0
		rec.mu.Unlock()
		return row != nil && row.State == "idle" && changed
	})
}

func TestEnsureLoadedTrustsRefreshedLoadedRowWhenCachedEngineProbeMisses(t *testing.T) {
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	// Point the engine at a closed port so the fast-path engine probe misses,
	// while library status still reports the model loaded (e.g. engine slow
	// under heavy generation). EnsureLoaded must refresh and NOT unload it.
	closedEngine := startHealthServer(t)
	closedEngine.Close()
	fake.write("status.json", status(loadedRowWithBaseURL(closedEngine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(context.Background())
	if err := library.awaitSettled(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatal(err)
	}
	if unloads := callsWithPrefix(fake, "unload "); len(unloads) != 0 {
		t.Fatalf("unloaded a model that library status reported loaded: %v", unloads)
	}
	if loads := callsWithPrefix(fake, "load "); len(loads) != 0 {
		t.Fatalf("reloaded a model that library status reported loaded: %v", loads)
	}
}

func TestWaitLoadedReturnsImmediatelyForAdoptedLoadAlreadyLoaded(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	library := newEnsureLibrary(t, fake, 0)
	library.Refresh(context.Background())
	library.mu.Lock()
	since := library.commits
	library.mu.Unlock()
	budget, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if err := library.waitLoaded(context.Background(), budget, testModel, since, false); err != nil {
		t.Fatalf("waitLoaded on already-loaded adopted row returned %v", err)
	}
}

func TestLoopbackHealthURL(t *testing.T) {
	cases := []struct {
		raw     string
		stripV1 bool
		want    string
	}{
		{"http://127.0.0.1:18101/v1", true, "http://127.0.0.1:18101/health"},
		{"http://127.0.0.1:18101/v1/", true, "http://127.0.0.1:18101/health"},
		{"http://127.0.0.2:18101/v1", true, "http://127.0.0.2:18101/health"},
		{"http://127.0.0.1:47711", false, "http://127.0.0.1:47711/health"},
		{"http://[::1]:18101/v1", true, "http://[::1]:18101/health"},
		{"http://LOCALHOST:18101/v1", true, "http://LOCALHOST:18101/health"},
		{"https://127.0.0.1:18101/v1", true, ""},
		{"http://10.0.0.5:18101/v1", true, ""},
		{"http://user@127.0.0.1:18101/v1", true, ""},
		{"http://127.0.0.1/v1", true, ""},
	}
	for _, tc := range cases {
		if got := loopbackHealthURL(tc.raw, tc.stripV1); got != tc.want {
			t.Errorf("loopbackHealthURL(%q, %v) = %q, want %q", tc.raw, tc.stripV1, got, tc.want)
		}
	}
}
