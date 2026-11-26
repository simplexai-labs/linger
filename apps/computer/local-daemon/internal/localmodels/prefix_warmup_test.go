package localmodels

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPrefixWarmupSelectionStateAndDedup(t *testing.T) {
	fake := newFakeTool(t)
	mPoly := model("poly-one", "loaded")
	mPoly["engine"] = "polystrata"
	mPoly["concurrency"] = 1

	mStrata := model("strata-nil", "loaded")
	mStrata["engine"] = "strata"

	mLlama := model("llama-ignored", "loaded")
	mLlama["engine"] = "llama.cpp"

	fake.write("status.json", status(mPoly, mStrata, mLlama))

	started := make(chan string, 4)
	release := make(chan struct{})
	var mu sync.Mutex
	calls := map[string]int{}

	record := &recorder{}
	library := New(Options{
		Tool:             &fake.tool,
		Environment:      map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PYTHONHOME": "/elsewhere", "PATH": os.Getenv("PATH")},
		JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
		Publish:          record.publish,
		RuntimeChanged:   record.runtimeChanged,
		ProgressInterval: time.Second,
		WarmupPrefix: func(ctx context.Context, target PrefixWarmupTarget) (bool, error) {
			mu.Lock()
			calls[target.ModelID]++
			mu.Unlock()
			started <- target.ModelID
			select {
			case <-release:
				return true, nil
			case <-ctx.Done():
				return false, ctx.Err()
			}
		},
	})
	t.Cleanup(library.Close)

	snap := library.Refresh(context.Background())
	// Warmup never overlays "loading" onto model.State even while in flight.
	if got := modelState(snap, "poly-one"); got == nil || got.State != "loaded" || got.ConcurrencyProbing != nil {
		t.Fatalf("poly-one snapshot during warmup = %+v, want loaded without ConcurrencyProbing", got)
	}
	if got := modelState(snap, "strata-nil"); got == nil || got.State != "loaded" || got.ConcurrencyProbing != nil {
		t.Fatalf("strata-nil snapshot during warmup = %+v, want loaded without ConcurrencyProbing", got)
	}

	gotIDs := map[string]bool{}
	for range 2 {
		select {
		case id := <-started:
			gotIDs[id] = true
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for warmup start; got %v", gotIDs)
		}
	}
	if !gotIDs["poly-one"] || !gotIDs["strata-nil"] {
		t.Fatalf("unexpected warmed models: %v", gotIDs)
	}
	close(release)

	waitFor(t, "warmup goroutines to settle", func() bool {
		library.mu.Lock()
		defer library.mu.Unlock()
		return len(library.prefixWarmups) == 0 && len(library.prefixWarmed) == 2
	})

	// Repeated refresh deduplicates identical loaded models; llama.cpp stays ignored.
	library.Refresh(context.Background())
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	if calls["poly-one"] != 1 || calls["strata-nil"] != 1 || calls["llama-ignored"] != 0 {
		mu.Unlock()
		t.Fatalf("calls after dedup refresh = %#v", calls)
	}
	mu.Unlock()

	// Unload clears warmed state; reloading triggers a fresh warm-up.
	mPolyIdle := model("poly-one", "idle")
	mPolyIdle["engine"] = "polystrata"
	fake.write("status.json", status(mPolyIdle, mStrata, mLlama))
	library.Refresh(context.Background())

	fake.write("status.json", status(mPoly, mStrata, mLlama))
	library.Refresh(context.Background())
	waitFor(t, "poly-one reload warmup", func() bool {
		mu.Lock()
		defer mu.Unlock()
		return calls["poly-one"] == 2 && calls["strata-nil"] == 1
	})
}

func TestPrefixWarmupRetriesUnreadyAndAfterEnsurePi(t *testing.T) {
	fake := newFakeTool(t)
	mPoly := model("poly-one", "loaded")
	mPoly["engine"] = "polystrata"
	fake.write("status.json", status(mPoly))

	waitGate := filepath.Join(fake.state, "harness-plan-wait")
	if err := os.WriteFile(waitGate, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(waitGate) })

	var piReady atomic.Bool
	var attempts atomic.Int32
	harnessDir := filepath.Join(filepath.Dir(fake.state), "harness")

	record := &recorder{}
	library := New(Options{
		Tool:             &fake.tool,
		Environment:      map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PYTHONHOME": "/elsewhere", "PATH": os.Getenv("PATH")},
		JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
		HarnessDirectory: harnessDir,
		Publish:          record.publish,
		RuntimeChanged:   record.runtimeChanged,
		ProgressInterval: time.Second,
		WarmupPrefix: func(context.Context, PrefixWarmupTarget) (bool, error) {
			attempts.Add(1)
			if !piReady.Load() {
				return false, nil
			}
			return true, nil
		},
	})
	t.Cleanup(library.Close)

	library.Refresh(context.Background())
	waitFor(t, "initial unready warmup attempt", func() bool { return attempts.Load() >= 1 })
	waitFor(t, "harness plan entered", func() bool {
		_, err := os.Stat(filepath.Join(fake.state, "harness-plan-entered"))
		return err == nil
	})
	// Still unready: another explicit Refresh retries.
	library.Refresh(context.Background())
	waitFor(t, "second unready retry on Refresh", func() bool { return attempts.Load() >= 2 })

	// Once EnsurePi finishes, scheduleEnsurePi triggers Refresh and finishes warmup.
	piReady.Store(true)
	_ = os.Remove(waitGate)
	waitFor(t, "automatic warmup retry after EnsurePi completes", func() bool {
		library.mu.Lock()
		defer library.mu.Unlock()
		return library.piExecutable != "" && library.prefixWarmed["poly-one"].ModelID == "poly-one"
	})
	if attempts.Load() < 3 {
		t.Fatalf("attempts = %d, want >= 3", attempts.Load())
	}
}

func TestPrefixWarmupCancelsOnLifecycleEvents(t *testing.T) {
	newLoadedLibrary := func(t *testing.T) (*fakeTool, *Library, <-chan struct{}, <-chan struct{}) {
		t.Helper()
		fake := newFakeTool(t)
		mPoly := model("poly-one", "loaded")
		mPoly["engine"] = "polystrata"
		fake.write("status.json", status(mPoly))

		started := make(chan struct{}, 1)
		cancelled := make(chan struct{}, 1)
		record := &recorder{}
		library := New(Options{
			Tool:             &fake.tool,
			Environment:      map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PYTHONHOME": "/elsewhere", "PATH": os.Getenv("PATH")},
			JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
			Publish:          record.publish,
			RuntimeChanged:   record.runtimeChanged,
			ProgressInterval: time.Second,
			WarmupPrefix: func(ctx context.Context, _ PrefixWarmupTarget) (bool, error) {
				select {
				case started <- struct{}{}:
				default:
				}
				<-ctx.Done()
				select {
				case cancelled <- struct{}{}:
				default:
				}
				return false, ctx.Err()
			},
		})
		t.Cleanup(library.Close)
		library.Refresh(context.Background())
		select {
		case <-started:
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for warmup start")
		}
		return fake, library, started, cancelled
	}

	awaitCancel := func(t *testing.T, ch <-chan struct{}, what string) {
		t.Helper()
		select {
		case <-ch:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for cancel on %s", what)
		}
	}

	t.Run("unload", func(t *testing.T) {
		fake, library, _, cancelled := newLoadedLibrary(t)
		idle, _ := json.Marshal(status(model("poly-one", "idle")))
		fake.script("unload", fakeScript{Lines: []fakeLine{{Line: resultLine("poly-one")}}, StatusAfter: idle})
		if refusal, answered := library.Act(context.Background(), Action{Name: ActionUnload, Model: "poly-one"}, soon()); refusal != nil || !answered {
			t.Fatalf("unload refused=%+v answered=%t", refusal, answered)
		}
		awaitCancel(t, cancelled, "unload")
	})

	t.Run("remove", func(t *testing.T) {
		fake, library, _, cancelled := newLoadedLibrary(t)
		absent, _ := json.Marshal(status(model("poly-one", "absent")))
		fake.script("remove", fakeScript{Lines: []fakeLine{{Line: resultLine("poly-one")}}, StatusAfter: absent})
		if refusal, answered := library.Act(context.Background(), Action{Name: ActionRemove, Model: "poly-one"}, soon()); refusal != nil || !answered {
			t.Fatalf("remove refused=%+v answered=%t", refusal, answered)
		}
		awaitCancel(t, cancelled, "remove")
	})

	t.Run("load cancels UnloadFirst", func(t *testing.T) {
		fake, library, _, cancelled := newLoadedLibrary(t)
		second := model("other", "loaded")
		second["engine"] = "polystrata"
		loaded, _ := json.Marshal(status(model("poly-one", "idle"), second))
		fake.script("load", fakeScript{
			Lines:       []fakeLine{{Line: progressLine("other", "load", 0, 2)}, {Line: resultLine("other")}},
			StatusAfter: loaded,
		})
		if refusal, answered := library.Act(context.Background(), Action{Name: ActionLoad, Model: "other", UnloadFirst: []string{"poly-one"}}, soon()); refusal != nil || !answered {
			t.Fatalf("load refused=%+v answered=%t", refusal, answered)
		}
		awaitCancel(t, cancelled, "load UnloadFirst")
	})

	t.Run("unavailable snapshot", func(t *testing.T) {
		fake, library, _, cancelled := newLoadedLibrary(t)
		failStatus(t, fake, true)
		library.Refresh(context.Background())
		awaitCancel(t, cancelled, "unavailable")
	})

	t.Run("Close", func(t *testing.T) {
		_, library, _, cancelled := newLoadedLibrary(t)
		library.Close()
		awaitCancel(t, cancelled, "Close")
	})
}

func TestPrefixWarmupWaitsForConcurrencyProbeOverlay(t *testing.T) {
	fake := newFakeTool(t)
	probeGate := make(chan struct{})
	probeEntered := make(chan struct{}, 1)
	var closeProbeOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, `{"data":[]}`)
		case "/v1/chat/completions":
			_, _ = io.Copy(io.Discard, r.Body)
			select {
			case probeEntered <- struct{}{}:
			default:
			}
			<-probeGate
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer closeProbeOnce.Do(func() { close(probeGate) })

	mPoly := model("poly-probed", "loaded")
	mPoly["engine"] = "polystrata"
	mPoly["concurrency"] = 2
	mPoly["endpoint"] = map[string]any{"base_url": server.URL + "/v1", "gateway_model": "localmodels-library/poly-probed"}
	fake.write("status.json", status(mPoly))

	var warmedCount atomic.Int32
	record := &recorder{}
	library := New(Options{
		Tool:                &fake.tool,
		Environment:         map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PYTHONHOME": "/elsewhere", "PATH": os.Getenv("PATH")},
		JobDirectory:        filepath.Join(t.TempDir(), "jobs"),
		ProbeCacheDirectory: t.TempDir(),
		Publish:             record.publish,
		RuntimeChanged:      record.runtimeChanged,
		ProgressInterval:    time.Second,
		WarmupPrefix: func(context.Context, PrefixWarmupTarget) (bool, error) {
			warmedCount.Add(1)
			return true, nil
		},
	})
	t.Cleanup(library.Close)
	library.prober.cfg.promptWords = 16

	snap := library.Refresh(context.Background())
	if got := modelState(snap, "poly-probed"); got == nil || got.State != "loading" || got.ConcurrencyProbing == nil || !*got.ConcurrencyProbing {
		t.Fatalf("expected concurrency_probing to overlay state=loading, got %+v", got)
	}
	select {
	case <-probeEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for concurrency probe request")
	}
	if warmedCount.Load() != 0 {
		t.Fatalf("warmedCount = %d while concurrency probe still running, want 0", warmedCount.Load())
	}

	closeProbeOnce.Do(func() { close(probeGate) })
	waitFor(t, "warmup after concurrency probe finishes", func() bool {
		return warmedCount.Load() == 1
	})
}

func TestPrefixWarmupDoesNotSpinAfterErrorUntilReload(t *testing.T) {
	fake := newFakeTool(t)
	mPoly := model("poly-err", "loaded")
	mPoly["engine"] = "polystrata"
	fake.write("status.json", status(mPoly))

	var calls atomic.Int32
	record := &recorder{}
	library := New(Options{
		Tool:             &fake.tool,
		Environment:      map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PYTHONHOME": "/elsewhere", "PATH": os.Getenv("PATH")},
		JobDirectory:     filepath.Join(t.TempDir(), "jobs"),
		Publish:          record.publish,
		ProgressInterval: time.Second,
		WarmupPrefix: func(context.Context, PrefixWarmupTarget) (bool, error) {
			calls.Add(1)
			return false, errors.New("boom")
		},
	})
	t.Cleanup(library.Close)

	library.Refresh(context.Background())
	waitFor(t, "initial failing warmup", func() bool { return calls.Load() == 1 })
	library.Refresh(context.Background())
	time.Sleep(30 * time.Millisecond)
	if calls.Load() != 1 {
		t.Fatalf("calls = %d, want 1 after error dedup", calls.Load())
	}
}
