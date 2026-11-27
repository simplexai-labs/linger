package localmodels

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoverAfterWakeNoOpWhenToolNotInstalled(t *testing.T) {
	library := newLibrary(t, nil, &recorder{}, time.Second)
	unhealthyCalled := false
	library.RecoverAfterWake(t.Context(), func([]string, []string, bool) {
		unhealthyCalled = true
	})
	if unhealthyCalled {
		t.Fatal("onUnhealthy ran when tool is not installed")
	}
}

func TestRecoverAfterWakeHealthyLoadedModelDoesNotReload(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(t.Context())
	if err := library.awaitSettled(t.Context()); err != nil {
		t.Fatal(err)
	}

	before := len(fake.calls())
	unhealthyCalled := false
	library.RecoverAfterWake(t.Context(), func([]string, []string, bool) {
		unhealthyCalled = true
	})
	if unhealthyCalled {
		t.Fatal("onUnhealthy ran for a healthy local model stack")
	}
	if after := len(fake.calls()); after != before {
		t.Fatalf("healthy wake ran localmodels subprocesses: %v", fake.calls()[before:])
	}
}

func TestRecoverAfterWakeDoesNotLoadIdleOrUserStoppedModels(t *testing.T) {
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(model(testModel, "idle")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(t.Context())
	if err := library.awaitSettled(t.Context()); err != nil {
		t.Fatal(err)
	}

	library.RecoverAfterWake(t.Context(), nil)
	if loads := callsWithPrefix(fake, "load "); len(loads) != 0 {
		t.Fatalf("loaded an idle model on wake: %v", loads)
	}

	// Now load the model, explicitly unload it as the user, and simulate wake
	// with a dead engine endpoint: user-stopped models must never be revived.
	engine := startHealthServer(t)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library.Refresh(t.Context())
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "idle")),
	})
	if refusal, answered := library.Act(t.Context(), Action{Name: ActionUnload, Model: testModel}, soon()); !answered || refusal != nil {
		t.Fatalf("unload answered=%v refusal=%+v", answered, refusal)
	}
	engine.Close()
	library.RecoverAfterWake(t.Context(), nil)
	if loads := callsWithPrefix(fake, "load "); len(loads) != 0 {
		t.Fatalf("revived a user-stopped model on wake: %v", loads)
	}
}

func TestRecoverAfterWakeReloadsUnhealthyEngineAndNotifiesBeforeReload(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(t.Context())
	if err := library.awaitSettled(t.Context()); err != nil {
		t.Fatal(err)
	}

	// Simulate the engine crashing or losing its GPU context during sleep.
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

	var gotIDs, gotPiModels []string
	var gotGatewayUnhealthy bool
	var loadsAtCallback int
	library.RecoverAfterWake(t.Context(), func(modelIDs, piModels []string, gatewayUnhealthy bool) {
		gotIDs = append([]string(nil), modelIDs...)
		gotPiModels = append([]string(nil), piModels...)
		gotGatewayUnhealthy = gatewayUnhealthy
		loadsAtCallback = len(callsWithPrefix(fake, "load "))
	})

	if !slices.Equal(gotIDs, []string{testModel}) || !slices.Equal(gotPiModels, []string{testPiModel}) || gotGatewayUnhealthy {
		t.Fatalf("callback got ids=%v piModels=%v gatewayUnhealthy=%v", gotIDs, gotPiModels, gotGatewayUnhealthy)
	}
	if loadsAtCallback != 0 {
		t.Fatalf("load started before onUnhealthy callback (loads=%d)", loadsAtCallback)
	}
	if unloads, loads := callsWithPrefix(fake, "unload "), callsWithPrefix(fake, "load "); len(unloads) != 1 || len(loads) != 1 {
		t.Fatalf("unloads=%v loads=%v", unloads, loads)
	}
	if row := modelState(*library.Snapshot(), testModel); row == nil || row.State != "loaded" {
		t.Fatalf("snapshot row = %+v, want loaded after wake recovery", row)
	}
}

func TestRecoverAfterWakeReloadsWhenLocalGatewayDies(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(t.Context())
	if err := library.awaitSettled(t.Context()); err != nil {
		t.Fatal(err)
	}

	// Engine still answers /health, but local Bifrost gateway died during sleep.
	gateway.Close()
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: statusJSON(model(testModel, "idle")),
	})
	fake.script("load", fakeScript{
		Lines:       []fakeLine{{Line: progressLine(testModel, "load", 0, 2)}, {Line: resultLine(testModel)}},
		StatusAfter: statusJSON(loadedRowWithBaseURL(engine.URL + "/v1")),
	})

	var sawGatewayUnhealthy bool
	library.RecoverAfterWake(t.Context(), func(_ []string, _ []string, gatewayUnhealthy bool) {
		sawGatewayUnhealthy = gatewayUnhealthy
	})
	if !sawGatewayUnhealthy {
		t.Fatal("expected gatewayUnhealthy=true in onUnhealthy callback")
	}
	if unloads, loads := callsWithPrefix(fake, "unload "), callsWithPrefix(fake, "load "); len(unloads) != 1 || len(loads) != 1 {
		t.Fatalf("unloads=%v loads=%v", unloads, loads)
	}
}

func TestRecoverAfterWakeRefreshesActiveDownload(t *testing.T) {
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(model(testModel, "downloading")))
	library := newEnsureLibrary(t, fake, 0)
	library.healthCheck = gatewayAnswers
	library.progressInterval = time.Hour
	library.Refresh(t.Context())
	if err := library.awaitSettled(t.Context()); err != nil {
		t.Fatal(err)
	}

	// Simulate the download failing during sleep; wake must refresh immediately
	// so the UI transitions out of the frozen downloading percentage.
	failed := model(testModel, "failed")
	failed["error"] = map[string]any{"code": "NETWORK_UNAVAILABLE", "detail": "connection reset"}
	fake.write("status.json", status(failed))

	library.RecoverAfterWake(t.Context(), nil)
	row := modelState(*library.Snapshot(), testModel)
	if row == nil || row.State != "failed" {
		t.Fatalf("snapshot row = %+v, want failed after wake refresh", row)
	}
	if loads := callsWithPrefix(fake, "load "); len(loads) != 0 {
		t.Fatalf("wake loaded a failed download: %v", loads)
	}
}

func TestRecoverAfterWakeHonorsCloseAndCanceledContext(t *testing.T) {
	engine := startHealthServer(t)
	gateway := startHealthServer(t)
	fake := newFakeTool(t)
	writeLocalSourceOverlay(t, fake.state, gateway.URL)
	fake.write("status.json", status(loadedRowWithBaseURL(engine.URL+"/v1")))
	library := newEnsureLibrary(t, fake, 0)
	library.progressInterval = time.Hour
	library.Refresh(t.Context())
	if err := library.awaitSettled(t.Context()); err != nil {
		t.Fatal(err)
	}

	var probes atomic.Int32
	library.healthCheck = func(ctx context.Context, healthURL string) bool {
		probes.Add(1)
		return gatewayAnswers(ctx, healthURL)
	}

	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	library.RecoverAfterWake(canceled, nil)
	if got := probes.Load(); got != 0 {
		t.Fatalf("canceled context ran %d health probes", got)
	}

	library.Close()
	library.RecoverAfterWake(t.Context(), nil)
	if got := probes.Load(); got != 0 {
		t.Fatalf("closed library ran %d health probes", got)
	}
}

func TestRecoverGatewayAfterWakeRemountsUnhealthyByokGateway(t *testing.T) {
	healthy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/health" {
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer healthy.Close()
	stopped := httptest.NewServer(http.NotFoundHandler())
	stoppedURL := stopped.URL
	stopped.Close()

	ft := newFakeTool(t)
	piProfile := filepath.Join(ft.state, "byok-home", ".pi", "agent")
	ms := NewModelSource(ModelSourceOptions{
		Tool:         &ft.tool,
		Environment:  map[string]string{"LOCALMODELS_FAKE_TOOL": "1"},
		JobDirectory: filepath.Join(t.TempDir(), "jobs"),
		NodePath:     "/usr/local/bin/node",
	})
	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema": modelSourceSchema, "mode": "byok", "runtime": "pi",
		"runtime_model": "localmodels/localmodels-byok", "gateway_url": healthy.URL,
		"environment": map[string]string{"PI_CODING_AGENT_DIR": piProfile},
	})
	calledUnhealthy := false
	if err := ms.RecoverGatewayAfterWake(t.Context(), func(string) { calledUnhealthy = true }); err != nil {
		t.Fatal(err)
	}
	if calledUnhealthy {
		t.Fatal("healthy BYOK gateway invoked onUnhealthy")
	}

	writeModelSourceJSON(t, ft.state, map[string]any{
		"schema": modelSourceSchema, "mode": "byok", "runtime": "pi",
		"runtime_model": "localmodels/localmodels-byok", "gateway_url": stoppedURL,
		"environment": map[string]string{"PI_CODING_AGENT_DIR": piProfile},
	})
	ft.write("source-apply.json", map[string]any{
		"schema": modelSourceStatusSchema, "mode": "byok", "runtime": "pi",
		"runtime_model": "localmodels/localmodels-byok", "gateway_url": healthy.URL,
		"environment": map[string]string{"PI_CODING_AGENT_DIR": piProfile},
		"byok":        map[string]any{"configured": true, "key_saved": false},
	})
	var unhealthyRuntime string
	if err := ms.RecoverGatewayAfterWake(t.Context(), func(rt string) { unhealthyRuntime = rt }); err != nil {
		t.Fatal(err)
	}
	if unhealthyRuntime != "pi" {
		t.Fatalf("unhealthyRuntime = %q, want pi", unhealthyRuntime)
	}
	if _, err := os.Stat(filepath.Join(ft.state, "source-args.txt")); err != nil {
		t.Fatalf("expected source apply remount to run: %v", err)
	}
}

func TestEnsureLoadedDoesNotExpirePrematurelyAcrossSimulatedSleep(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	release := holdLoad(t, fake)
	library := newEnsureLibrary(t, fake, 40*time.Millisecond)
	// Freeze awake clock at 10ms while real wall/timer time exceeds 40ms
	// (simulating Windows InterruptTime advancing across system sleep).
	var awakeNanos atomic.Int64
	library.awakeClock = func() time.Duration { return time.Duration(awakeNanos.Load()) }

	done := make(chan error, 1)
	go func() { done <- library.EnsureLoaded(t.Context(), testPiModel) }()
	waitFor(t, "the load call", func() bool { return len(callsWithPrefix(fake, "load ")) == 1 })

	awakeNanos.Store(int64(10 * time.Millisecond))
	time.Sleep(80 * time.Millisecond)
	select {
	case err := <-done:
		t.Fatalf("EnsureLoaded expired prematurely during simulated sleep: %v", err)
	default:
	}

	release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("EnsureLoaded failed after release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("EnsureLoaded did not finish after load completed")
	}
}
