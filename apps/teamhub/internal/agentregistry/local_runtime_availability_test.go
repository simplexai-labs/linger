package agentregistry

import (
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestLocalRuntimeAuthenticationProjectsOfflineAgentWithoutChangingComputer(t *testing.T) {
	for _, runtimeType := range []string{"codex", "claude", "pi"} {
		t.Run(runtimeType, func(t *testing.T) {
			status := roomagent.LocalAgentRuntimeStatus{
				RuntimeType: runtimeType, ComputerStatus: "online", Status: "authentication_required",
			}
			available := httpapi.TenantAgentAvailability{
				Status: httpapi.TenantAgentAvailabilityStatusOnline, Label: "Online", ActiveTaskCount: 2,
			}
			projected := availabilityWithLocalRuntimeStatus(available, status)
			if projected.Status != httpapi.TenantAgentAvailabilityStatusOffline || projected.ActiveTaskCount != 2 {
				t.Fatalf("availability = %+v", projected)
			}
			if status.ComputerStatus != "online" {
				t.Fatal("authentication changed Computer connectivity")
			}
			status.Status = "ready"
			recovered := availabilityWithLocalRuntimeStatus(available, status)
			if recovered.Status != available.Status || recovered.Label != available.Label {
				t.Fatalf("recovered availability = %+v", recovered)
			}
		})
	}
}

func TestUnavailableRuntimeStatusDoesNotAssertComputerOffline(t *testing.T) {
	status := unavailableLocalAgentRuntimeStatus(store.ListTenantAgentsForAccountRow{})
	if status.Status != "unknown" || status.ComputerStatus != "unknown" {
		t.Fatalf("status=%+v", status)
	}
	availability := availabilityWithLocalRuntimeStatus(httpapi.TenantAgentAvailability{ActiveTaskCount: 3}, status)
	if availability.Status != httpapi.TenantAgentAvailabilityStatusUnknown || availability.ActiveTaskCount != 3 {
		t.Fatalf("availability=%+v", availability)
	}
	if availability.Label != "Status unavailable" {
		t.Fatalf("label=%s", availability.Label)
	}
}

func TestUnknownRuntimePreservesKnownRegistrationError(t *testing.T) {
	before := httpapi.TenantAgentAvailability{Status: httpapi.TenantAgentAvailabilityStatusError, Label: "Registration failed"}
	after := availabilityWithLocalRuntimeStatus(before, unavailableLocalAgentRuntimeStatus(store.ListTenantAgentsForAccountRow{}))
	if after.Status != before.Status || after.Label != before.Label {
		t.Fatalf("availability=%+v", after)
	}
}

func TestUnknownRuntimePreservesLastObservedActivity(t *testing.T) {
	before := httpapi.TenantAgentAvailability{ActiveTaskCount: 3, CurrentActivity: &httpapi.TenantAgentCurrentActivity{Summary: "Running local task"}}
	after := availabilityWithLocalRuntimeStatus(before, unavailableLocalAgentRuntimeStatus(store.ListTenantAgentsForAccountRow{}))
	if after.CurrentActivity != before.CurrentActivity {
		t.Fatalf("last observation was replaced: %+v", after)
	}
}

func TestPersistedLocalRuntimeObservationSeparatesConnectionFromDiagnostics(t *testing.T) {
	now := time.Date(2026, 9, 28, 12, 0, 0, 0, time.UTC)
	agent := store.ListTenantAgentsForAccountRow{ComputerID: pgtype.Text{String: "computer", Valid: true}, LocalRuntimeType: pgtype.Text{String: "codex", Valid: true}}
	for _, tc := range []struct {
		name, stored, runtime, connection, computer string
		age                                         time.Duration
	}{
		{"fresh", "online", "ready", "connected", "online", 5 * time.Second},
		{"between liveness writes", "online", "ready", "connected", "online", 45 * time.Second},
		{"lost heartbeat", "online", "ready", "reconnecting", "unknown", 61 * time.Second},
		{"gateway restart", "offline", "ready", "reconnecting", "unknown", 5 * time.Minute},
		{"stale online", "online", "ready", "unknown", "unknown", 11 * time.Minute},
		{"offline", "offline", "error", "offline", "offline", 11 * time.Minute},
		{"upgrade required", "upgrade_required", "incompatible", "reconnecting", "unknown", 5 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			observation := store.ListLocalAgentComputerObservationsRow{DisplayName: "Computer", Status: tc.stored, LastSeenAt: pgtype.Timestamptz{Time: now.Add(-tc.age), Valid: true}, RuntimeDiagnostics: []byte(`[{"type":"hermes","status":42,"protocol":"acp","error":false},{"type":"codex","status":"ready","version":"1.0"}]`)}
			result := projectLocalRuntimeObservation(agent, observation, now)
			if result.Status != tc.runtime || result.ConnectionStatus != tc.connection || result.ComputerStatus != tc.computer || !result.ObservedAt.Equal(observation.LastSeenAt.Time) {
				t.Fatalf("observation=%+v", result)
			}
			if tc.stored == "upgrade_required" {
				if result.ErrorCode != string(httpapi.LocalRuntimeDiagnosticErrorCodeLOCALCOMPUTERUPGRADEREQUIRED) {
					t.Fatalf("error code = %q, want %q", result.ErrorCode, httpapi.LocalRuntimeDiagnosticErrorCodeLOCALCOMPUTERUPGRADEREQUIRED)
				}
				if !httpapi.LocalRuntimeDiagnosticErrorCode(result.ErrorCode).Valid() {
					t.Fatalf("error code %q is not in the contract enum", result.ErrorCode)
				}
			}
			available := availabilityWithLocalRuntimeStatus(httpapi.TenantAgentAvailability{Status: httpapi.TenantAgentAvailabilityStatusOnline, ActiveTaskCount: 2}, result)
			if tc.connection != "connected" && available.Status == httpapi.TenantAgentAvailabilityStatusOnline {
				t.Fatal("stale observation presented as live")
			}
			if available.ActiveTaskCount != 2 {
				t.Fatal("task count lost")
			}
		})
	}
	t.Run("known auth failure survives reconnect", func(t *testing.T) {
		observation := store.ListLocalAgentComputerObservationsRow{Status: "offline", LastSeenAt: pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true}, RuntimeDiagnostics: []byte(`[{"type":"codex","status":"authentication_required","error":{"code":"RUNTIME_AUTHENTICATION_REQUIRED","message":"Sign in"}}]`)}
		result := projectLocalRuntimeObservation(agent, observation, now)
		if result.Status != "authentication_required" || result.ConnectionStatus != "reconnecting" {
			t.Fatalf("observation=%+v", result)
		}
	})
	t.Run("old or corrupt data is unknown", func(t *testing.T) {
		result := projectLocalRuntimeObservation(agent, store.ListLocalAgentComputerObservationsRow{Status: "online", RuntimeDiagnostics: []byte(`broken`)}, now)
		if result.Status != "unknown" || result.ConnectionStatus != "unknown" || !result.ObservedAt.IsZero() {
			t.Fatalf("observation=%+v", result)
		}
	})
}

func TestAvailabilityCarriesReasonBesideEnglishLabel(t *testing.T) {
	online := listedTenantAgentAvailability(store.ListTenantAgentsForAccountRow{ActiveTaskCount: 1})
	for _, tc := range []struct {
		name   string
		status roomagent.LocalAgentRuntimeStatus
		want   httpapi.TenantAgentAvailabilityReason
		label  string
	}{
		{"ready", roomagent.LocalAgentRuntimeStatus{ComputerStatus: "online", Status: "ready", ConnectionStatus: "connected"}, httpapi.TenantAgentAvailabilityReasonOnline, "Online"},
		{"unknown", roomagent.LocalAgentRuntimeStatus{Status: "unknown", ConnectionStatus: "unknown"}, httpapi.TenantAgentAvailabilityReasonStatusUnavailable, "Status unavailable"},
		{"reconnecting", roomagent.LocalAgentRuntimeStatus{Status: "ready", ConnectionStatus: "reconnecting"}, httpapi.TenantAgentAvailabilityReasonReconnecting, "Reconnecting"},
		{"sign-in", roomagent.LocalAgentRuntimeStatus{ComputerStatus: "online", Status: "authentication_required", ConnectionStatus: "connected"}, httpapi.TenantAgentAvailabilityReasonAuthenticationRequired, "Offline"},
		{"computer offline", roomagent.LocalAgentRuntimeStatus{ComputerStatus: "offline", Status: "error", ConnectionStatus: "connected", ErrorCode: "LOCAL_COMPUTER_OFFLINE"}, httpapi.TenantAgentAvailabilityReasonWaitingForComputer, "Offline"},
		{"not installed", roomagent.LocalAgentRuntimeStatus{ComputerStatus: "online", Status: "not_installed", ConnectionStatus: "connected"}, httpapi.TenantAgentAvailabilityReasonRuntimeNotInstalled, "Needs attention"},
		{"incompatible", roomagent.LocalAgentRuntimeStatus{ComputerStatus: "online", Status: "incompatible", ConnectionStatus: "connected"}, httpapi.TenantAgentAvailabilityReasonRuntimeIncompatible, "Needs attention"},
		{"error", roomagent.LocalAgentRuntimeStatus{ComputerStatus: "online", Status: "error", ConnectionStatus: "connected", Message: "Probe failed"}, httpapi.TenantAgentAvailabilityReasonRuntimeError, "Needs attention"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			projected := availabilityWithLocalRuntimeStatus(online, tc.status)
			if projected.Reason == nil || *projected.Reason != tc.want || projected.Label != tc.label {
				t.Fatalf("availability = %+v, reason = %v", projected, projected.Reason)
			}
			if !projected.Reason.Valid() {
				t.Fatalf("reason %q is not in the contract enum", *projected.Reason)
			}
		})
	}
}
