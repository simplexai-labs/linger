package roomagent

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHTTPGatewaySystemTelemetrySnapshotAndErrors(t *testing.T) {
	cases := []struct {
		name       string
		status     int
		body       string
		wantErr    error
		wantRev    int64
		wantSource string
	}{
		{
			name:   "ok",
			status: http.StatusOK,
			body: `{
				"computer_id": "computer_1",
				"revision": 7,
				"observed_at": "2026-11-26T10:00:00Z",
				"snapshot": {
					"schema": "localmodels.stack-view/v1",
					"schema_version": "1.1",
					"generated_at": "2026-11-26T10:00:00Z",
					"source": "live",
					"bottleneck": "idle"
				}
			}`,
			wantRev:    7,
			wantSource: "live",
		},
		{
			name:    "not found",
			status:  http.StatusNotFound,
			body:    `{"error":{"code":"LOCAL_COMPUTER_NOT_FOUND","message":"not found"}}`,
			wantErr: ErrLocalComputerNotFound,
		},
		{
			name:    "unsupported",
			status:  http.StatusConflict,
			body:    `{"error":{"code":"SYSTEM_TELEMETRY_UNSUPPORTED","message":"upgrade"}}`,
			wantErr: ErrSystemTelemetryUnsupported,
		},
		{
			name:    "offline",
			status:  http.StatusServiceUnavailable,
			body:    `{"error":{"code":"LOCAL_COMPUTER_OFFLINE","message":"offline"}}`,
			wantErr: ErrLocalComputerOffline,
		},
		{
			name:    "unavailable",
			status:  http.StatusServiceUnavailable,
			body:    `{"error":{"code":"SYSTEM_TELEMETRY_UNAVAILABLE","message":"busy"}}`,
			wantErr: ErrSystemTelemetryUnavailable,
		},
		{
			name:    "timeout",
			status:  http.StatusGatewayTimeout,
			body:    `{"error":{"code":"SYSTEM_TELEMETRY_TIMEOUT","message":"timeout"}}`,
			wantErr: ErrSystemTelemetryTimeout,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer svc-token" {
					t.Errorf("missing bearer auth: %q", r.Header.Get("Authorization"))
				}
				if r.URL.Path != "/v1/tenants/tenant_1/owners/owner_1/local-computers/computer_1/system-telemetry" {
					t.Errorf("unexpected path %q", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tc.status)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			gateway, err := NewHTTPGateway(server.URL, "svc-token", server.Client())
			if err != nil {
				t.Fatal(err)
			}
			got, err := gateway.GetLocalComputerSystemTelemetry(context.Background(), SystemTelemetryTarget{
				TenantID: "tenant_1", OwnerActorID: "owner_1", ComputerID: "computer_1",
			})
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected err: %v", err)
			}
			if got.Revision != tc.wantRev || string(got.Snapshot.Source) != tc.wantSource {
				t.Fatalf("unexpected envelope: %+v", got)
			}
		})
	}
}

func TestHTTPGatewaySystemTelemetryStream(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tenants/tenant_1/owners/owner_1/local-computers/computer_1/system-telemetry/stream" {
			t.Errorf("unexpected path %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer svc-token" {
			t.Errorf("missing bearer auth")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "event: telemetry.snapshot\ndata: {\"computer_id\":\"computer_1\",\"revision\":1,\"observed_at\":\"2026-11-26T10:00:00Z\",\"snapshot\":{\"schema\":\"localmodels.stack-view/v1\",\"generated_at\":\"2026-11-26T10:00:00Z\",\"source\":\"live\"}}\n\n")
	}))
	defer server.Close()

	gateway, err := NewHTTPGateway(server.URL, "svc-token", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	resp, err := gateway.StreamLocalComputerSystemTelemetry(context.Background(), SystemTelemetryTarget{
		TenantID: "tenant_1", OwnerActorID: "owner_1", ComputerID: "computer_1",
	})
	if err != nil {
		t.Fatalf("StreamLocalComputerSystemTelemetry failed: %v", err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "event: telemetry.snapshot") {
		t.Fatalf("expected SSE payload, got %q", string(raw))
	}
}
