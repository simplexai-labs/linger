package localmodels

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func mustRawStatus(t *testing.T, models ...map[string]any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(status(models...))
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func newIdleTestLibrary(t *testing.T, fake *fakeTool, record *recorder, idleAfter, checkEvery time.Duration, isBusy func() bool) *Library {
	t.Helper()
	library := New(Options{
		Tool: &fake.tool,
		Environment: map[string]string{
			"LOCALMODELS_FAKE_TOOL": "1",
			"PYTHONHOME":            "/elsewhere",
			"PATH":                  os.Getenv("PATH"),
		},
		JobDirectory:      filepath.Join(t.TempDir(), "jobs"),
		Publish:           record.publish,
		RuntimeChanged:    record.runtimeChanged,
		ProgressInterval:  50 * time.Millisecond,
		IdleUnloadAfter:   idleAfter,
		IdleCheckInterval: checkEvery,
		IsBusy:            isBusy,
	})
	t.Cleanup(library.Close)
	return library
}

func TestIdleUnloadLifecycle(t *testing.T) {
	t.Run("unloads loaded model after inactivity timeout", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		fake.script("unload", fakeScript{
			Lines:       []fakeLine{{Line: resultLine(testModel)}},
			StatusAfter: mustRawStatus(t, model(testModel, "idle")),
		})
		record := &recorder{}
		library := newIdleTestLibrary(t, fake, record, 80*time.Millisecond, 15*time.Millisecond, nil)
		library.Refresh(context.Background())

		waitFor(t, "idle unload to transition model to idle", func() bool {
			row := modelState(record.last(), testModel)
			return row != nil && row.State == "idle"
		})
		if !slicesContainsPrefix(fake.calls(), "unload "+testModel+" ") {
			t.Fatalf("expected unload call in %v", fake.calls())
		}
	})

	t.Run("skips unload while busy and resets timer when work completes", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		fake.script("unload", fakeScript{
			Lines:       []fakeLine{{Line: resultLine(testModel)}},
			StatusAfter: mustRawStatus(t, model(testModel, "idle")),
		})
		var busy atomic.Bool
		busy.Store(true)
		record := &recorder{}
		library := newIdleTestLibrary(t, fake, record, 60*time.Millisecond, 15*time.Millisecond, busy.Load)
		library.Refresh(context.Background())

		time.Sleep(120 * time.Millisecond)
		if slicesContainsPrefix(fake.calls(), "unload "+testModel+" ") {
			t.Fatalf("unloaded while busy: %v", fake.calls())
		}
		if row := modelState(record.last(), testModel); row == nil || row.State != "loaded" {
			t.Fatalf("model state while busy = %+v, want loaded", row)
		}

		busy.Store(false)
		waitFor(t, "idle unload after becoming idle", func() bool {
			row := modelState(record.last(), testModel)
			return row != nil && row.State == "idle"
		})
	})

	t.Run("TouchActivity defers idle unload", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		fake.script("unload", fakeScript{
			Lines:       []fakeLine{{Line: resultLine(testModel)}},
			StatusAfter: mustRawStatus(t, model(testModel, "idle")),
		})
		record := &recorder{}
		library := newIdleTestLibrary(t, fake, record, 120*time.Millisecond, 20*time.Millisecond, nil)
		library.Refresh(context.Background())

		for range 3 {
			time.Sleep(50 * time.Millisecond)
			library.TouchActivity()
		}
		if slicesContainsPrefix(fake.calls(), "unload "+testModel+" ") {
			t.Fatalf("unloaded despite TouchActivity calls: %v", fake.calls())
		}

		waitFor(t, "idle unload after TouchActivity stops", func() bool {
			row := modelState(record.last(), testModel)
			return row != nil && row.State == "idle"
		})
	})

	t.Run("negative IdleUnloadAfter disables automatic unload", func(t *testing.T) {
		fake := newFakeTool(t)
		fake.write("status.json", status(model(testModel, "loaded")))
		fake.script("unload", fakeScript{
			Lines:       []fakeLine{{Line: resultLine(testModel)}},
			StatusAfter: mustRawStatus(t, model(testModel, "idle")),
		})
		record := &recorder{}
		library := newIdleTestLibrary(t, fake, record, -time.Second, 15*time.Millisecond, nil)
		library.Refresh(context.Background())

		time.Sleep(100 * time.Millisecond)
		if slicesContainsPrefix(fake.calls(), "unload "+testModel+" ") {
			t.Fatalf("unexpected unload when disabled: %v", fake.calls())
		}
	})
}

func slicesContainsPrefix(lines []string, prefix string) bool {
	for _, line := range lines {
		if strings.HasPrefix(line, prefix) {
			return true
		}
	}
	return false
}
