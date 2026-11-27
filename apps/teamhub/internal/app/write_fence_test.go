package app

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
)

func TestWriteFenceMiddlewareRejectsNonProbesAndAllowsExemptRoutes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fenceFile := filepath.Join(t.TempDir(), "upgrade-write-fence")

	a := &App{
		cfg: config.Config{
			WriteFenceFile: fenceFile,
		},
	}

	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		c.Set("request_id", "req_test_fence")
		c.Next()
	})
	engine.Use(a.writeFenceMiddleware())
	engine.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	engine.HEAD("/healthz", func(c *gin.Context) {
		c.Status(http.StatusOK)
	})
	engine.POST("/v0/local/identity", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})
	engine.GET("/readyz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ready"})
	})
	var writes atomic.Int32
	engine.POST("/v0/rooms/room_1/messages", func(c *gin.Context) {
		writes.Add(1)
		c.JSON(http.StatusCreated, gin.H{"ok": true})
	})

	if err := os.WriteFile(fenceFile, []byte(`{"appVersion":"0.1.11-v2test.4"}`), 0o600); err != nil {
		t.Fatalf("create fence file: %v", err)
	}

	// Non-probe write request must be rejected with 503 + Retry-After + service_upgrading
	// before executing the route handler.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v0/rooms/room_1/messages", http.NoBody)
	engine.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("fenced POST status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}
	if got := rec.Header().Get("Retry-After"); got != "5" {
		t.Fatalf("fenced Retry-After = %q, want %q", got, "5")
	}
	if writes.Load() != 0 {
		t.Fatalf("fenced handler executed %d times, want 0", writes.Load())
	}
	var payload struct {
		Error struct {
			Code      string `json:"code"`
			Message   string `json:"message"`
			RequestID string `json:"request_id"`
			Retryable *bool  `json:"retryable"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode fenced error JSON: %v", err)
	}
	if payload.Error.Code != "service_upgrading" {
		t.Fatalf("error.code = %q, want %q", payload.Error.Code, "service_upgrading")
	}
	if payload.Error.Retryable == nil || !*payload.Error.Retryable {
		t.Fatalf("error.retryable = %v, want true", payload.Error.Retryable)
	}
	if payload.Error.RequestID != "req_test_fence" {
		t.Fatalf("error.request_id = %q, want %q", payload.Error.RequestID, "req_test_fence")
	}

	// /readyz is NOT exempt and must also return 503 while fenced.
	readyRec := httptest.NewRecorder()
	engine.ServeHTTP(readyRec, httptest.NewRequest(http.MethodGet, "/readyz", http.NoBody))
	if readyRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("fenced /readyz status = %d, want %d", readyRec.Code, http.StatusServiceUnavailable)
	}

	// Exempt probes MUST succeed while fenced.
	for _, probe := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/healthz"},
		{http.MethodHead, "/healthz"},
		{http.MethodPost, "/v0/local/identity"},
	} {
		probeRec := httptest.NewRecorder()
		engine.ServeHTTP(probeRec, httptest.NewRequest(probe.method, probe.path, http.NoBody))
		if probeRec.Code != http.StatusOK {
			t.Fatalf("exempt %s %s status = %d, want %d", probe.method, probe.path, probeRec.Code, http.StatusOK)
		}
	}

	// Removing the fence file immediately unblocks writes.
	if err := os.Remove(fenceFile); err != nil {
		t.Fatalf("remove fence file: %v", err)
	}
	unblockedRec := httptest.NewRecorder()
	engine.ServeHTTP(unblockedRec, httptest.NewRequest(http.MethodPost, "/v0/rooms/room_1/messages", http.NoBody))
	if unblockedRec.Code != http.StatusCreated {
		t.Fatalf("unfenced POST status = %d, want %d", unblockedRec.Code, http.StatusCreated)
	}
	if writes.Load() != 1 {
		t.Fatalf("unfenced handler executed %d times, want 1", writes.Load())
	}
}

func TestWaitForWriteFenceDefersUntilClearedAndRespectsContextCancel(t *testing.T) {
	t.Run("starts workers once fence file is removed", func(t *testing.T) {
		fenceFile := filepath.Join(t.TempDir(), "upgrade-write-fence")
		if err := os.WriteFile(fenceFile, []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		var started atomic.Bool
		done := make(chan bool, 1)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		go func() {
			done <- waitForWriteFence(ctx, ctx, fenceFile, 10*time.Millisecond, func() error {
				started.Store(true)
				return nil
			}, nil)
		}()

		time.Sleep(40 * time.Millisecond)
		if started.Load() {
			t.Fatal("workers started while write fence file was still present")
		}

		if err := os.Remove(fenceFile); err != nil {
			t.Fatal(err)
		}
		select {
		case ok := <-done:
			if !ok || !started.Load() {
				t.Fatalf("expected deferred workers to start after fence removal (ok=%v started=%v)", ok, started.Load())
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for deferred workers after fence removal")
		}
	})

	t.Run("cancels cleanly without starting workers on ctx.Done", func(t *testing.T) {
		fenceFile := filepath.Join(t.TempDir(), "upgrade-write-fence")
		if err := os.WriteFile(fenceFile, []byte("1"), 0o600); err != nil {
			t.Fatal(err)
		}
		var started atomic.Bool
		done := make(chan bool, 1)
		ctx, cancel := context.WithCancel(context.Background())

		go func() {
			done <- waitForWriteFence(ctx, context.Background(), fenceFile, 10*time.Millisecond, func() error {
				started.Store(true)
				return nil
			}, nil)
		}()

		time.Sleep(30 * time.Millisecond)
		cancel()

		select {
		case ok := <-done:
			if ok || started.Load() {
				t.Fatalf("expected cancel without starting workers (ok=%v started=%v)", ok, started.Load())
			}
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for deferred worker waiter to cancel")
		}
	})
}
