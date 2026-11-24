package localmodels

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func uint64Ptr(v uint64) *uint64 { return &v }

func TestConcurrencyProbePromotesParallelAndFallsBackWhenSerialized(t *testing.T) {
	t.Run("parallel requests promote to 2", func(t *testing.T) {
		var mu sync.Mutex
		var sawModels atomic.Int32
		var prompts []string
		var maxInFlight atomic.Int32
		var inFlight atomic.Int32

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "" {
				t.Errorf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
			}
			switch r.URL.Path {
			case "/v1/models":
				sawModels.Add(1)
				w.WriteHeader(http.StatusOK)
				_, _ = io.WriteString(w, `{"data":[]}`)
			case "/v1/chat/completions":
				cur := inFlight.Add(1)
				for {
					prev := maxInFlight.Load()
					if cur <= prev || maxInFlight.CompareAndSwap(prev, cur) {
						break
					}
				}
				body, _ := io.ReadAll(r.Body)
				var decoded probeChatRequest
				if err := json.Unmarshal(body, &decoded); err != nil {
					t.Errorf("invalid request JSON: %v", err)
				}
				if decoded.Stream || decoded.Temperature != 0 || decoded.MaxTokens != 32 || len(decoded.Messages) != 1 {
					t.Errorf("unexpected chat completions request: %+v", decoded)
				}
				mu.Lock()
				prompts = append(prompts, decoded.Messages[0].Content)
				mu.Unlock()
				time.Sleep(40 * time.Millisecond)
				inFlight.Add(-1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`)
			default:
				http.NotFound(w, r)
			}
		}))
		defer server.Close()

		prober := newConcurrencyProber("", "")
		prober.cfg.promptWords = 64
		prober.cfg.minOverheadMargin = 100 * time.Millisecond
		prober.cfg.noiseAllowance = 20 * time.Millisecond

		detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 4)
		if detected != 2 || !measured {
			t.Fatalf("probe = (%d, %t), want (2, true)", detected, measured)
		}
		if sawModels.Load() == 0 {
			t.Fatal("expected /models readiness check")
		}
		if maxInFlight.Load() < 2 {
			t.Fatalf("maxInFlight = %d, want >= 2", maxInFlight.Load())
		}
		mu.Lock()
		defer mu.Unlock()
		if len(prompts) != 3 {
			t.Fatalf("len(prompts) = %d, want 3", len(prompts))
		}
		if prompts[0] == prompts[1] || prompts[0] == prompts[2] || prompts[1] == prompts[2] {
			t.Fatal("expected distinct prompts across baseline and Phase 2 calls")
		}
	})

	t.Run("serialized requests fall back to 1", func(t *testing.T) {
		var serialize sync.Mutex
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/v1/models":
				w.WriteHeader(http.StatusOK)
			case "/v1/chat/completions":
				_, _ = io.Copy(io.Discard, r.Body)
				serialize.Lock()
				defer serialize.Unlock()
				time.Sleep(60 * time.Millisecond)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
			default:
				http.NotFound(w, r)
			}
		}))
		defer server.Close()

		prober := newConcurrencyProber("", "")
		prober.cfg.promptWords = 32
		prober.cfg.noiseAllowance = 5 * time.Millisecond
		prober.cfg.minOverheadMargin = 120 * time.Millisecond

		detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 2)
		if detected != 1 || !measured {
			t.Fatalf("probe = (%d, %t), want (1, true)", detected, measured)
		}
	})

	t.Run("slow second request hits deadline and cancels early", func(t *testing.T) {
		var completions atomic.Int32
		secondCanceled := make(chan struct{})
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/v1/models":
				w.WriteHeader(http.StatusOK)
			case "/v1/chat/completions":
				// Drain the JSON body so net/http enables background close detection on r.Context().
				_, _ = io.Copy(io.Discard, r.Body)
				n := completions.Add(1)
				if n <= 2 {
					time.Sleep(20 * time.Millisecond)
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
					return
				}
				select {
				case <-r.Context().Done():
					close(secondCanceled)
				case <-time.After(3 * time.Second):
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
				}
			default:
				http.NotFound(w, r)
			}
		}))
		defer server.Close()
		defer server.CloseClientConnections()

		prober := newConcurrencyProber("", "")
		prober.cfg.promptWords = 16
		prober.cfg.baselineTimeout = 2 * time.Second
		prober.cfg.minOverheadMargin = 40 * time.Millisecond
		prober.cfg.noiseAllowance = 5 * time.Millisecond

		started := time.Now()
		detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 2)
		elapsed := time.Since(started)
		if detected != 1 || !measured {
			t.Fatalf("probe = (%d, %t), want (1, true)", detected, measured)
		}
		if elapsed > time.Second {
			t.Fatalf("probe took %s, expected early cancellation", elapsed)
		}
		select {
		case <-secondCanceled:
		case <-time.After(time.Second):
			t.Fatal("expected slower Phase 2 HTTP request context to be canceled")
		}
	})
}

func TestConcurrencyProbeDeployAuthAndFallbacks(t *testing.T) {
	writeRecord := func(t *testing.T, stateDir, fileName, recordID, deployDir, endpointModel, baseURL, token string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(stateDir, "library", "models"), 0o700); err != nil {
			t.Fatal(err)
		}
		if deployDir != "" {
			if err := os.MkdirAll(deployDir, 0o700); err != nil {
				t.Fatal(err)
			}
			if token != "" {
				if err := os.WriteFile(filepath.Join(deployDir, "api-key"), []byte(token+"\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
		}
		doc := map[string]any{
			"id": recordID,
			"plan": map[string]any{
				"endpoint": map[string]any{
					"base_url": baseURL,
					"model":    endpointModel,
				},
				"service": map[string]any{
					"deploy_dir": deployDir,
				},
			},
		}
		encoded, _ := json.Marshal(doc)
		if err := os.WriteFile(filepath.Join(stateDir, "library", "models", fileName), encoded, 0o600); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("attaches deploy api-key and endpoint model across record match modes", func(t *testing.T) {
		const secret = "probe-bearer-secret"
		const endpointModel = "served-qwen3-4b"
		var sawModelsAuth atomic.Bool
		var sawChatModel string
		var mu sync.Mutex

		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer "+secret {
				http.Error(w, "unauthorized", http.StatusUnauthorized)
				return
			}
			switch r.URL.Path {
			case "/v1/models":
				sawModelsAuth.Store(true)
				w.WriteHeader(http.StatusOK)
			case "/v1/chat/completions":
				body, _ := io.ReadAll(r.Body)
				var decoded probeChatRequest
				_ = json.Unmarshal(body, &decoded)
				mu.Lock()
				sawChatModel = decoded.Model
				mu.Unlock()
				time.Sleep(15 * time.Millisecond)
				_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
			default:
				http.NotFound(w, r)
			}
		}))
		defer server.Close()

		for _, tc := range []struct {
			name     string
			fileName string
			recordID string
			baseURL  string
		}{
			{name: "exact id", fileName: "other.json", recordID: testModel, baseURL: "http://127.0.0.1:1/v1"},
			{name: "sanitized id", fileName: sanitizeModelFilename(testModel) + ".json", recordID: "", baseURL: "http://127.0.0.1:1/v1"},
			{name: "base_url fallback", fileName: "by-url.json", recordID: "unrelated-id", baseURL: strings.ToUpper(server.URL) + "/v1/"},
		} {
			t.Run(tc.name, func(t *testing.T) {
				stateDir := t.TempDir()
				deployDir := filepath.Join(t.TempDir(), "deploy")
				writeRecord(t, stateDir, tc.fileName, tc.recordID, deployDir, endpointModel, tc.baseURL, secret)

				prober := newConcurrencyProber("", stateDir)
				prober.cfg.promptWords = 16
				prober.cfg.noiseAllowance = 25 * time.Millisecond
				detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 2)
				if detected != 2 || !measured {
					t.Fatalf("probe = (%d, %t), want (2, true)", detected, measured)
				}
				if !sawModelsAuth.Load() {
					t.Fatal("expected /models GET to receive Bearer token")
				}
				mu.Lock()
				gotModel := sawChatModel
				mu.Unlock()
				if gotModel != endpointModel {
					t.Fatalf("request model = %q, want %q", gotModel, endpointModel)
				}
			})
		}
	})

	t.Run("unauthorized readiness returns unmeasured immediately", func(t *testing.T) {
		var attempts atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			attempts.Add(1)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
		}))
		defer server.Close()

		prober := newConcurrencyProber("", "")
		prober.cfg.readinessTimeout = 5 * time.Second
		detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 2)
		if detected != 0 || measured {
			t.Fatalf("probe = (%d, %t), want (0, false)", detected, measured)
		}
		if attempts.Load() != 1 {
			t.Fatalf("401 readiness attempts = %d, want 1", attempts.Load())
		}
	})

	t.Run("non-2xx invalid JSON empty choices and non-loopback return unmeasured", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			body string
			code int
		}{
			{name: "server 500", code: http.StatusInternalServerError, body: `error`},
			{name: "invalid json", code: http.StatusOK, body: `not-json`},
			{name: "empty choices", code: http.StatusOK, body: `{"choices":[]}`},
		} {
			t.Run(tc.name, func(t *testing.T) {
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path == "/v1/models" {
						w.WriteHeader(http.StatusOK)
						return
					}
					w.WriteHeader(tc.code)
					_, _ = io.WriteString(w, tc.body)
				}))
				defer server.Close()

				prober := newConcurrencyProber("", "")
				prober.cfg.promptWords = 8
				if detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 2); detected != 0 || measured {
					t.Fatalf("probe = (%d, %t), want (0, false)", detected, measured)
				}
			})
		}

		prober := newConcurrencyProber("", "")
		if detected, measured := prober.probe(context.Background(), testModel, "https://example.com/v1", 2); detected != 0 || measured {
			t.Fatalf("non-loopback probe = (%d, %t), want (0, false)", detected, measured)
		}
		if detected, measured := prober.probe(context.Background(), testModel, "http://127.0.0.1:1/v1", 1); detected != 1 || measured {
			t.Fatalf("configured=1 probe = (%d, %t), want (1, false)", detected, measured)
		}
	})
}

func TestProbeCachePersistenceAndInvalidation(t *testing.T) {
	dir := t.TempDir()
	base := probeFingerprint{
		ModelID:               testModel,
		Engine:                "llamacpp",
		EngineLabel:           "llama.cpp b11370",
		Pool:                  "gpu:0",
		ContextTokens:         32768,
		ConfiguredConcurrency: 4,
		ToolVersion:           "0.9.0",
	}

	cache := newProbeCache(dir)
	cache.put(base, 2, time.Unix(1700000000, 0).UTC())

	reloaded := newProbeCache(dir)
	if detected, ok := reloaded.get(base); !ok || detected != 2 {
		t.Fatalf("reloaded.get(base) = (%d, %t), want (2, true)", detected, ok)
	}

	mutations := []probeFingerprint{
		func() probeFingerprint { f := base; f.Engine = "polystrata"; return f }(),
		func() probeFingerprint { f := base; f.EngineLabel = "llama.cpp b11400"; return f }(),
		func() probeFingerprint { f := base; f.Pool = "system"; return f }(),
		func() probeFingerprint { f := base; f.ContextTokens = 65536; return f }(),
		func() probeFingerprint { f := base; f.ConfiguredConcurrency = 2; return f }(),
		func() probeFingerprint { f := base; f.ToolVersion = "0.9.1"; return f }(),
	}
	for i, mutated := range mutations {
		if detected, ok := reloaded.get(mutated); ok {
			t.Fatalf("mutation %d unexpectedly hit cache with detected=%d", i, detected)
		}
	}
}

func newProbeTestLibrary(t *testing.T, fake *fakeTool, cacheDir string, record *recorder) *Library {
	t.Helper()
	library := New(Options{
		Tool:                &fake.tool,
		Environment:         map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory:        filepath.Join(t.TempDir(), "jobs"),
		ProbeCacheDirectory: cacheDir,
		Publish:             record.publish,
		RuntimeChanged:      record.runtimeChanged,
		ProgressInterval:    20 * time.Millisecond,
		EnsureLoadTimeout:   5 * time.Second,
	})
	library.prober.cfg.promptWords = 16
	library.prober.cfg.noiseAllowance = 30 * time.Millisecond
	t.Cleanup(library.Close)
	return library
}

func loadedModelWithConcurrency(baseURL, engine string, concurrency any) map[string]any {
	row := model(testModel, "loaded")
	row["engine"] = engine
	row["engine_label"] = "llama.cpp b11370"
	if concurrency != nil {
		row["concurrency"] = concurrency
	}
	row["endpoint"] = map[string]any{
		"base_url":      baseURL + "/v1",
		"gateway_model": "localmodels-library/" + testModel,
	}
	return row
}

func TestLibraryProbeLifecycleOverlayEnsureLoadedAndCacheReuse(t *testing.T) {
	gate := make(chan struct{})
	probeEntered := make(chan struct{}, 1)
	var httpCalls atomic.Int32
	const secret = "live-slot-secret"

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+secret {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/v1/models":
			w.WriteHeader(http.StatusOK)
		case "/v1/chat/completions":
			select {
			case probeEntered <- struct{}{}:
			default:
			}
			<-gate
			time.Sleep(15 * time.Millisecond)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	fake := newFakeTool(t)
	deployDir := filepath.Join(t.TempDir(), "deploy")
	if err := os.MkdirAll(deployDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(deployDir, "api-key"), []byte(secret), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(fake.state, "library", "models"), 0o700); err != nil {
		t.Fatal(err)
	}
	deployJSON, _ := json.Marshal(map[string]any{
		"id": testModel,
		"plan": map[string]any{
			"endpoint": map[string]any{"base_url": server.URL + "/v1", "model": "deployed-qwen"},
			"service":  map[string]any{"deploy_dir": deployDir},
		},
	})
	if err := os.WriteFile(filepath.Join(fake.state, "library", "models", sanitizeModelFilename(testModel)+".json"), deployJSON, 0o600); err != nil {
		t.Fatal(err)
	}

	fake.write("status.json", status(loadedModelWithConcurrency(server.URL, "llamacpp", 4)))
	cacheDir := t.TempDir()
	record := &recorder{}
	library := newProbeTestLibrary(t, fake, cacheDir, record)
	library.progressInterval = time.Hour // keep reconcile out of the way

	// First read sees loaded(concurrency=4) and overlays concurrency_probing=true
	// while the one-time probe waits on gate.
	first := library.Refresh(context.Background())
	probingRow := modelState(first, testModel)
	if probingRow == nil || probingRow.State != "loading" ||
		probingRow.ConcurrencyProbing == nil || !*probingRow.ConcurrencyProbing ||
		probingRow.Endpoint != nil || probingRow.Concurrency != nil {
		t.Fatalf("first probing snapshot row = %+v", probingRow)
	}
	if record.changes() != 0 {
		t.Fatalf("runtimeChanged before probe completed = %d, want 0", record.changes())
	}
	library.mu.Lock()
	adopted := library.hasAdoptedJobLocked(first)
	library.mu.Unlock()
	if adopted {
		t.Fatal("expected probing model not to be treated as an adopted job")
	}

	// EnsureLoaded waits while concurrency probe is in flight.
	ensureDone := make(chan error, 1)
	go func() {
		ensureDone <- library.EnsureLoaded(context.Background(), testPiModel)
	}()

	<-probeEntered
	select {
	case err := <-ensureDone:
		t.Fatalf("EnsureLoaded returned %v while probing was still running", err)
	case <-time.After(60 * time.Millisecond):
	}

	close(gate)
	if err := <-ensureDone; err != nil {
		t.Fatalf("EnsureLoaded returned %v", err)
	}

	waitFor(t, "loaded snapshot with detected concurrency", func() bool {
		m := modelState(record.last(), testModel)
		return m != nil && m.State == "loaded" && m.ConcurrencyProbing == nil && m.Concurrency != nil && *m.Concurrency == 2
	})
	if record.changes() == 0 {
		t.Fatal("expected runtimeChanged after probe published loaded model")
	}

	// A new Library sharing concurrency-probes.json uses cached result with 0 HTTP probes.
	callsBeforeRestart := httpCalls.Load()
	restartedRecord := &recorder{}
	restarted := newProbeTestLibrary(t, fake, cacheDir, restartedRecord)
	restarted.progressInterval = time.Hour
	cachedSnapshot := restarted.Refresh(context.Background())
	cachedRow := modelState(cachedSnapshot, testModel)
	if cachedRow == nil || cachedRow.State != "loaded" || cachedRow.ConcurrencyProbing != nil ||
		cachedRow.Concurrency == nil || *cachedRow.Concurrency != 2 {
		t.Fatalf("restarted cached row = %+v", cachedRow)
	}
	if httpCalls.Load() != callsBeforeRestart {
		t.Fatalf("expected 0 HTTP calls on cache hit, got %d new calls", httpCalls.Load()-callsBeforeRestart)
	}
}

func TestLibraryProbeSkipsLowOrUnsetConcurrencyAndCancelsOnUnload(t *testing.T) {
	t.Run("configured <= 1 and nil skip HTTP probing", func(t *testing.T) {
		var httpCalls atomic.Int32
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			httpCalls.Add(1)
			http.NotFound(w, r)
		}))
		defer server.Close()

		for _, tc := range []struct {
			name        string
			concurrency any
			want        *uint64
		}{
			{name: "configured 1", concurrency: 1, want: uint64Ptr(1)},
			{name: "unset concurrency", concurrency: nil, want: nil},
		} {
			t.Run(tc.name, func(t *testing.T) {
				fake := newFakeTool(t)
				fake.write("status.json", status(loadedModelWithConcurrency(server.URL, "llamacpp", tc.concurrency)))
				record := &recorder{}
				library := newProbeTestLibrary(t, fake, t.TempDir(), record)
				library.progressInterval = time.Hour
				snap := library.Refresh(context.Background())
				row := modelState(snap, testModel)
				if row == nil || row.State != "loaded" || row.ConcurrencyProbing != nil {
					t.Fatalf("row = %+v", row)
				}
				if (row.Concurrency == nil) != (tc.want == nil) || (tc.want != nil && *row.Concurrency != *tc.want) {
					t.Fatalf("Concurrency = %v, want %v", row.Concurrency, tc.want)
				}
				if httpCalls.Load() != 0 {
					t.Fatalf("httpCalls = %d, want 0", httpCalls.Load())
				}
			})
		}
	})

	t.Run("unload cancels active concurrency probe", func(t *testing.T) {
		probeCanceled := make(chan struct{})
		var cancelOnce sync.Once
		probeStarted := make(chan struct{}, 1)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v1/models" {
				w.WriteHeader(http.StatusOK)
				return
			}
			// Drain the JSON body so net/http enables background close detection on r.Context().
			_, _ = io.Copy(io.Discard, r.Body)
			select {
			case probeStarted <- struct{}{}:
			default:
			}
			select {
			case <-r.Context().Done():
				cancelOnce.Do(func() { close(probeCanceled) })
			case <-time.After(5 * time.Second):
			}
		}))
		defer server.Close()
		defer server.CloseClientConnections()

		fake := newFakeTool(t)
		fake.write("status.json", status(loadedModelWithConcurrency(server.URL, "llamacpp", 2)))
		idleStatus, _ := json.Marshal(status(model(testModel, "idle")))
		fake.script("unload", fakeScript{
			Lines:       []fakeLine{{Line: resultLine(testModel)}},
			StatusAfter: idleStatus,
		})
		record := &recorder{}
		library := newProbeTestLibrary(t, fake, t.TempDir(), record)
		library.progressInterval = time.Hour

		snap := library.Refresh(context.Background())
		if row := modelState(snap, testModel); row == nil || row.ConcurrencyProbing == nil || !*row.ConcurrencyProbing {
			t.Fatalf("expected concurrency_probing=true, got %+v", row)
		}
		<-probeStarted

		refusal, answered := library.Act(context.Background(), Action{Name: ActionUnload, Model: testModel}, soon())
		if !answered || refusal != nil {
			t.Fatalf("unload answered=%t refusal=%+v", answered, refusal)
		}
		select {
		case <-probeCanceled:
		case <-time.After(2 * time.Second):
			t.Fatal("expected unload to cancel active concurrency probe")
		}
		waitFor(t, "idle snapshot after unload", func() bool {
			row := modelState(record.last(), testModel)
			return row != nil && row.State == "idle" && row.ConcurrencyProbing == nil
		})
	})

	t.Run("ensureLoaded waits through post-load concurrency probe", func(t *testing.T) {
		gate := make(chan struct{})
		probeEntered := make(chan struct{}, 1)
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/v1/models" {
				w.WriteHeader(http.StatusOK)
				return
			}
			select {
			case probeEntered <- struct{}{}:
			default:
			}
			<-gate
			time.Sleep(15 * time.Millisecond)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
		}))
		defer server.Close()

		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "idle")))
		loadedStatus, _ := json.Marshal(status(loadedModelWithConcurrency(server.URL, "llamacpp", 2)))
		fake.script("load", fakeScript{
			Lines: []fakeLine{
				{Line: progressLine(testModel, "load", 0, 2)},
				{Line: resultLine(testModel)},
			},
			StatusAfter: loadedStatus,
		})
		record := &recorder{}
		library := newProbeTestLibrary(t, fake, t.TempDir(), record)

		done := make(chan error, 1)
		go func() {
			done <- library.EnsureLoaded(context.Background(), testPiModel)
		}()

		<-probeEntered
		waitFor(t, "probing snapshot after load finished", func() bool {
			row := modelState(record.last(), testModel)
			return row != nil && row.State == "loading" && row.ConcurrencyProbing != nil && *row.ConcurrencyProbing
		})
		select {
		case err := <-done:
			t.Fatalf("EnsureLoaded returned %v while probing was active", err)
		case <-time.After(50 * time.Millisecond):
		}

		close(gate)
		if err := <-done; err != nil {
			t.Fatalf("EnsureLoaded returned %v", err)
		}
		row := modelState(record.last(), testModel)
		if row == nil || row.State != "loaded" || row.ConcurrencyProbing != nil || row.Concurrency == nil || *row.Concurrency != 2 {
			t.Fatalf("final row = %+v, want loaded with concurrency 2", row)
		}
	})
}

func TestConcurrencyProbeCappedDeadlineBelowThresholdIsUnmeasured(t *testing.T) {
	var completions atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.WriteHeader(http.StatusOK)
		case "/v1/chat/completions":
			_, _ = io.Copy(io.Discard, r.Body)
			n := completions.Add(1)
			switch n {
			case 1, 2:
				time.Sleep(80 * time.Millisecond)
				_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
			default:
				select {
				case <-r.Context().Done():
				case <-time.After(time.Second):
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
				}
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer server.CloseClientConnections()

	prober := newConcurrencyProber("", "")
	prober.cfg.promptWords = 8
	prober.cfg.baselineTimeout = 110 * time.Millisecond
	prober.cfg.maxSlowdownRatio = 1.6
	prober.cfg.noiseAllowance = 5 * time.Millisecond
	prober.cfg.minOverheadMargin = 10 * time.Millisecond

	detected, measured := prober.probe(context.Background(), testModel, server.URL+"/v1", 4)
	if detected != 0 || measured {
		t.Fatalf("probe = (%d, %t), want (0, false)", detected, measured)
	}
}

func TestLibraryProbeTimeoutNotCachedAndRetriesOnReload(t *testing.T) {
	var shouldTimeout atomic.Bool
	shouldTimeout.Store(true)
	var chatCalls atomic.Int32

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/models":
			w.WriteHeader(http.StatusOK)
		case "/v1/chat/completions":
			_, _ = io.Copy(io.Discard, r.Body)
			chatCalls.Add(1)
			if shouldTimeout.Load() {
				select {
				case <-r.Context().Done():
				case <-time.After(2 * time.Second):
				}
				return
			}
			time.Sleep(15 * time.Millisecond)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()
	defer server.CloseClientConnections()

	fake := newFakeTool(t)
	fake.write("status.json", status(loadedModelWithConcurrency(server.URL, "llamacpp", 4)))
	cacheDir := t.TempDir()
	record := &recorder{}
	library := newProbeTestLibrary(t, fake, cacheDir, record)
	library.progressInterval = time.Hour
	library.prober.cfg.baselineTimeout = 50 * time.Millisecond

	first := library.Refresh(context.Background())
	probingRow := modelState(first, testModel)
	if probingRow == nil || probingRow.State != "loading" || probingRow.ConcurrencyProbing == nil || !*probingRow.ConcurrencyProbing {
		t.Fatalf("first snapshot row = %+v, want concurrency_probing", probingRow)
	}

	if err := library.EnsureLoaded(context.Background(), testPiModel); err != nil {
		t.Fatalf("EnsureLoaded after timeout returned %v", err)
	}
	waitFor(t, "loaded snapshot with nil concurrency after timeout", func() bool {
		m := modelState(record.last(), testModel)
		return m != nil && m.State == "loaded" && m.ConcurrencyProbing == nil && m.Concurrency == nil
	})
	cachePath := filepath.Join(cacheDir, concurrencyProbeFileName)
	if _, err := os.Stat(cachePath); !os.IsNotExist(err) {
		t.Fatalf("expected no probe cache file after transient timeout, stat err = %v", err)
	}

	callsAfterTimeout := chatCalls.Load()
	stillUnmeasured := library.Refresh(context.Background())
	if row := modelState(stillUnmeasured, testModel); row == nil || row.State != "loaded" || row.Concurrency != nil {
		t.Fatalf("repeat refresh row = %+v, want loaded with nil concurrency", row)
	}
	if chatCalls.Load() != callsAfterTimeout {
		t.Fatalf("repeat refresh triggered %d unexpected HTTP probe calls", chatCalls.Load()-callsAfterTimeout)
	}

	// Unload then reload once the server is healthy: probe runs again and caches 2.
	shouldTimeout.Store(false)
	idleStatus, _ := json.Marshal(status(model(testModel, "idle")))
	fake.script("unload", fakeScript{
		Lines:       []fakeLine{{Line: resultLine(testModel)}},
		StatusAfter: idleStatus,
	})
	if refusal, answered := library.Act(context.Background(), Action{Name: ActionUnload, Model: testModel}, soon()); !answered || refusal != nil {
		t.Fatalf("unload answered=%t refusal=%+v", answered, refusal)
	}

	loadedStatus, _ := json.Marshal(status(loadedModelWithConcurrency(server.URL, "llamacpp", 4)))
	fake.script("load", fakeScript{
		Lines: []fakeLine{
			{Line: progressLine(testModel, "load", 0, 2)},
			{Line: resultLine(testModel)},
		},
		StatusAfter: loadedStatus,
	})
	if refusal, answered := library.Act(context.Background(), Action{Name: ActionLoad, Model: testModel}, soon()); !answered || refusal != nil {
		t.Fatalf("load answered=%t refusal=%+v", answered, refusal)
	}

	waitFor(t, "loaded snapshot with measured concurrency 2 after reload", func() bool {
		m := modelState(record.last(), testModel)
		return m != nil && m.State == "loaded" && m.ConcurrencyProbing == nil && m.Concurrency != nil && *m.Concurrency == 2
	})
	if _, err := os.Stat(cachePath); err != nil {
		t.Fatalf("expected probe cache file after measured reload: %v", err)
	}
}
