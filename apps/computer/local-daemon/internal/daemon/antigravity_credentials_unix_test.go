//go:build unix

package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

func antigravityDiagJSON(status, version string) json.RawMessage {
	return mustJSON([]map[string]any{{
		"type":       "antigravity",
		"status":     status,
		"protocol":   "acp",
		"version":    version,
		"checked_at": "2026-09-01T00:00:00Z",
	}})
}

type runtimeEchoResolver struct{ dir string }

func (r runtimeEchoResolver) Resolve(_ context.Context, command protocol.Command, _ json.RawMessage) (provider.OperationSpec, error) {
	return provider.OperationSpec{
		OperationKind:    "run.start",
		Provider:         command.RuntimeType,
		ExecutablePath:   "/bin/" + command.RuntimeType,
		WorkingDirectory: r.dir,
		CodexVersion:     "0.155.1",
	}, nil
}

func TestUpdateRuntimeInventoryAntigravityCredentialTransitions(t *testing.T) {
	t.Cleanup(func() { _, _ = native.StopAllParkedResidents() })
	antigravity := writeParkedScript(t, "agy", parkedAntigravityScript)

	newCredDaemon := func(t *testing.T, initialDiag json.RawMessage) (*Daemon, *fakeStream, map[string]*providerPrepareBackend) {
		t.Helper()
		stream := &fakeStream{}
		backends := map[string]*providerPrepareBackend{
			"antigravity": {started: make(chan struct{}), release: make(chan struct{})},
			"codex":       {started: make(chan struct{}), release: make(chan struct{})},
		}
		var mu sync.Mutex
		d, err := newTestDaemon(t, Options{
			ComputerID:         "computer-1",
			ControlPlane:       fakeControlPlane{stream: stream},
			IdentityStore:      fakeStore{},
			RuntimeDiagnostics: initialDiag,
			OperationResolver:  runtimeEchoResolver{dir: t.TempDir()},
			Executor: provider.Executor{
				NewBackend: func(kind string, _ native.Profile) (native.Runtime, error) {
					mu.Lock()
					defer mu.Unlock()
					return backends[kind], nil
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		return d, stream, backends
	}

	startPrepare := func(t *testing.T, d *Daemon, stream *fakeStream, backend *providerPrepareBackend, prepareID, runtimeType, contextKey string) {
		t.Helper()
		cmd := providerPrepareCommand(prepareID)
		cmd.RuntimeType = runtimeType
		cmd.ExecutionContextKey = contextKey
		cmd.Payload = mustJSON(map[string]any{
			"prepare_id": prepareID,
			"runtime":    map[string]any{"type": runtimeType},
			"session":    map[string]any{"threadId": ""},
		})
		if err := d.handleProviderPrepare(context.Background(), stream, cmd); err != nil {
			t.Fatal(err)
		}
		<-backend.started
	}

	t.Run("ready_to_authentication_required_stops_parked_and_cancels_prepare", func(t *testing.T) {
		d, stream, backends := newCredDaemon(t, antigravityDiagJSON("ready", "1.5.16"))
		defer close(backends["codex"].release)
		defer close(backends["antigravity"].release)

		parkedPID := parkAntigravityFor(t, antigravity, "ctx-agy-logout", "agent-1")
		startPrepare(t, d, stream, backends["antigravity"], "prep-agy-logout", "antigravity", "ctx-agy-prep")
		startPrepare(t, d, stream, backends["codex"], "prep-codex-keep", "codex", "ctx-codex-prep")

		// Steady-state refresh (ready -> ready, same version) must not disturb residents or prepares.
		if err := d.UpdateRuntimeInventory(t.Context(), []string{"antigravity"}, antigravityDiagJSON("ready", "1.5.16"), nil); err != nil {
			t.Fatal(err)
		}
		if syscall.Kill(parkedPID, 0) != nil {
			t.Fatal("steady-state ready update stopped parked Antigravity resident")
		}

		// Transition ready -> authentication_required invalidates parked residents and Antigravity prepares.
		if err := d.UpdateRuntimeInventory(t.Context(), []string{"antigravity"}, antigravityDiagJSON("authentication_required", "1.5.16"), nil); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for syscall.Kill(parkedPID, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("parked Antigravity resident %d survived ready -> authentication_required", parkedPID)
			}
			time.Sleep(20 * time.Millisecond)
		}
		if native.ContextHasParkedResident("ctx-agy-logout") {
			t.Fatal("parked Antigravity resident entry remained after logout transition")
		}
		if payload := waitForProviderPrepared(t, stream, "prep-agy-logout"); payload["outcome"] != "canceled" {
			t.Fatalf("antigravity prepare outcome=%v, want canceled", payload)
		}
		d.providerPrepareMu.Lock()
		codexStillInFlight := d.providerPrepares["ctx-codex-prep"] != nil
		d.providerPrepareMu.Unlock()
		if !codexStillInFlight {
			t.Fatal("unrelated Codex prepare was canceled by Antigravity credential transition")
		}
	})

	t.Run("authentication_required_to_ready_relogin_stops_parked_and_cancels_prepare", func(t *testing.T) {
		d, stream, backends := newCredDaemon(t, antigravityDiagJSON("authentication_required", "1.5.16"))
		defer close(backends["antigravity"].release)

		parkedPID := parkAntigravityFor(t, antigravity, "ctx-agy-relogin", "agent-1")
		startPrepare(t, d, stream, backends["antigravity"], "prep-agy-relogin", "antigravity", "ctx-agy-relogin-prep")

		if err := d.UpdateRuntimeInventory(t.Context(), []string{"antigravity"}, antigravityDiagJSON("ready", "1.5.16"), nil); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for syscall.Kill(parkedPID, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("parked Antigravity resident %d survived authentication_required -> ready", parkedPID)
			}
			time.Sleep(20 * time.Millisecond)
		}
		if payload := waitForProviderPrepared(t, stream, "prep-agy-relogin"); payload["outcome"] != "canceled" {
			t.Fatalf("antigravity prepare outcome=%v, want canceled", payload)
		}
	})

	t.Run("version_change_while_ready_invalidates_parked_resident", func(t *testing.T) {
		d, _, _ := newCredDaemon(t, antigravityDiagJSON("ready", "1.5.16"))
		parkedPID := parkAntigravityFor(t, antigravity, "ctx-agy-upgrade", "agent-1")
		if err := d.UpdateRuntimeInventory(t.Context(), []string{"antigravity"}, antigravityDiagJSON("ready", "1.5.17"), nil); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(10 * time.Second)
		for syscall.Kill(parkedPID, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("parked Antigravity resident %d survived version change", parkedPID)
			}
			time.Sleep(20 * time.Millisecond)
		}
	})

	t.Run("invalidate_antigravity_residents_directly", func(t *testing.T) {
		d, stream, backends := newCredDaemon(t, antigravityDiagJSON("ready", "1.5.16"))
		defer close(backends["codex"].release)
		defer close(backends["antigravity"].release)

		parkedPID := parkAntigravityFor(t, antigravity, "ctx-agy-exec", "agent-1")
		startPrepare(t, d, stream, backends["antigravity"], "prep-agy-exec", "antigravity", "ctx-agy-exec-prep")
		startPrepare(t, d, stream, backends["codex"], "prep-codex-exec", "codex", "ctx-codex-exec-prep")

		d.InvalidateAntigravityResidents("executable_changed")

		deadline := time.Now().Add(10 * time.Second)
		for syscall.Kill(parkedPID, 0) == nil {
			if time.Now().After(deadline) {
				t.Fatalf("parked Antigravity resident %d survived InvalidateAntigravityResidents", parkedPID)
			}
			time.Sleep(20 * time.Millisecond)
		}
		if payload := waitForProviderPrepared(t, stream, "prep-agy-exec"); payload["outcome"] != "canceled" {
			t.Fatalf("antigravity prepare outcome=%v, want canceled", payload)
		}
		d.providerPrepareMu.Lock()
		codexStillInFlight := d.providerPrepares["ctx-codex-exec-prep"] != nil
		d.providerPrepareMu.Unlock()
		if !codexStillInFlight {
			t.Fatal("unrelated Codex prepare was canceled by InvalidateAntigravityResidents")
		}
	})
}
