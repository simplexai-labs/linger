package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

type fakeSystemTelemetryGateway struct {
	roomagent.LocalComputerManagement
	snapshotFn func(ctx context.Context, target roomagent.SystemTelemetryTarget) (nodeservicesinternal.SystemTelemetryEnvelope, error)
	streamFn   func(ctx context.Context, target roomagent.SystemTelemetryTarget) (*http.Response, error)
}

func (f *fakeSystemTelemetryGateway) GetLocalComputerSystemTelemetry(ctx context.Context, target roomagent.SystemTelemetryTarget) (nodeservicesinternal.SystemTelemetryEnvelope, error) {
	return f.snapshotFn(ctx, target)
}

func (f *fakeSystemTelemetryGateway) StreamLocalComputerSystemTelemetry(ctx context.Context, target roomagent.SystemTelemetryTarget) (*http.Response, error) {
	return f.streamFn(ctx, target)
}

func testTelemetryContext(t *testing.T, method, tenantID, computerID, actorID, spaceID string) (*gin.Context, *httptest.ResponseRecorder, context.CancelFunc) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest(method, "/v0/tenants/"+tenantID+"/local-computers/"+computerID+"/system-telemetry", nil).WithContext(ctx)
	c.Request = req
	c.Params = gin.Params{
		{Key: "tenantId", Value: tenantID},
		{Key: "computerId", Value: computerID},
	}
	c.Set("request_id", "telemetry-test")
	c.Set(principalKey, principal{
		Session: store.GetActiveSessionRow{
			ID:            "session_1",
			AccountID:     "account_1",
			HumanTenantID: spaceID,
			HumanActorID:  actorID,
		},
	})
	return c, recorder, cancel
}

func TestAuthorizeSystemTelemetryEnforcesTenantOwnershipAndOnlineStatus(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Add(-10 * time.Second)
	stale := now.Add(-5 * time.Minute)
	gateway := &fakeSystemTelemetryGateway{}
	a := &App{
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		localComputers: gateway,
	}

	onlineComputer := agentruntimestate.LocalComputer{
		ComputerID:  "computer_1",
		DisplayName: "Studio",
		Status:      "online",
		LastSeenAt:  &fresh,
		Owner:       agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
	}

	cases := []struct {
		name       string
		tenantID   string
		actorID    string
		spaceID    string
		computer   agentruntimestate.LocalComputer
		lookupErr  error
		wantOK     bool
		wantStatus int
		wantCode   string
	}{
		{
			name:     "owner of online computer succeeds",
			tenantID: "tenant_1", actorID: "actor_owner", spaceID: "tenant_1",
			computer: onlineComputer, wantOK: true,
		},
		{
			name:     "non-owner tenant member is forbidden",
			tenantID: "tenant_1", actorID: "actor_other", spaceID: "tenant_1",
			computer: onlineComputer, wantOK: false, wantStatus: http.StatusForbidden, wantCode: "SYSTEM_TELEMETRY_FORBIDDEN",
		},
		{
			name:     "cross-tenant computer is not found",
			tenantID: "tenant_2", actorID: "actor_owner", spaceID: "tenant_2",
			computer: onlineComputer, wantOK: false, wantStatus: http.StatusNotFound, wantCode: "LOCAL_COMPUTER_NOT_FOUND",
		},
		{
			name:     "viewer outside tenant space gets 404",
			tenantID: "tenant_1", actorID: "actor_owner", spaceID: "tenant_other",
			computer: onlineComputer, wantOK: false, wantStatus: http.StatusNotFound, wantCode: "NOT_FOUND",
		},
		{
			name:     "offline computer returns LOCAL_COMPUTER_OFFLINE",
			tenantID: "tenant_1", actorID: "actor_owner", spaceID: "tenant_1",
			computer: agentruntimestate.LocalComputer{
				ComputerID: "computer_1", DisplayName: "Studio", Status: "online", LastSeenAt: &stale,
				Owner: agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
			},
			wantOK: false, wantStatus: http.StatusServiceUnavailable, wantCode: "LOCAL_COMPUTER_OFFLINE",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, rec, cancel := testTelemetryContext(t, http.MethodGet, tc.tenantID, "computer_1", tc.actorID, tc.spaceID)
			defer cancel()
			_, _, ok := a.authorizeSystemTelemetryWithLookup(c, func(context.Context, string) (agentruntimestate.LocalComputer, error) {
				return tc.computer, tc.lookupErr
			})
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (status=%d body=%s)", ok, tc.wantOK, rec.Code, rec.Body.String())
			}
			if !tc.wantOK {
				if rec.Code != tc.wantStatus {
					t.Fatalf("status = %d, want %d (body=%s)", rec.Code, tc.wantStatus, rec.Body.String())
				}
				if !strings.Contains(rec.Body.String(), `"`+tc.wantCode+`"`) {
					t.Fatalf("body = %s, want error code %q", rec.Body.String(), tc.wantCode)
				}
			}
		})
	}
}

func TestServeSystemTelemetrySnapshotAndUnsupportedError(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Add(-5 * time.Second)
	computer := agentruntimestate.LocalComputer{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "online", LastSeenAt: &fresh,
		Owner: agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
	}

	inFlight := 2
	gw := &fakeSystemTelemetryGateway{
		snapshotFn: func(_ context.Context, target roomagent.SystemTelemetryTarget) (nodeservicesinternal.SystemTelemetryEnvelope, error) {
			if target.ComputerID != "computer_1" || target.OwnerActorID != "actor_owner" {
				t.Fatalf("unexpected target: %+v", target)
			}
			return nodeservicesinternal.SystemTelemetryEnvelope{
				ComputerId: "computer_1",
				Revision:   4,
				ObservedAt: now,
				Snapshot: nodeservicesinternal.SystemTelemetrySnapshot{
					Schema:      "localmodels.stack-view/v1",
					GeneratedAt: now.Format(time.RFC3339),
					Source:      nodeservicesinternal.SystemTelemetrySourceLive,
					InFlight:    &inFlight,
				},
			}, nil
		},
	}
	a := &App{logger: slog.New(slog.NewTextHandler(io.Discard, nil)), localComputers: gw}
	c, rec, cancel := testTelemetryContext(t, http.MethodGet, "tenant_1", "computer_1", "actor_owner", "tenant_1")
	defer cancel()

	a.serveSystemTelemetrySnapshot(c, computer, gw)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var view httpapi.SystemTelemetryView
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode view: %v", err)
	}
	if !view.ViewerIsOwner || view.Computer.Status != httpapi.SystemTelemetryComputerOnline || view.Revision != 4 || view.Snapshot.InFlight == nil || *view.Snapshot.InFlight != 2 {
		t.Fatalf("unexpected view: %+v", view)
	}

	// Unsupported daemon returns 409 SYSTEM_TELEMETRY_UNSUPPORTED.
	gwUnsupported := &fakeSystemTelemetryGateway{
		snapshotFn: func(context.Context, roomagent.SystemTelemetryTarget) (nodeservicesinternal.SystemTelemetryEnvelope, error) {
			return nodeservicesinternal.SystemTelemetryEnvelope{}, roomagent.ErrSystemTelemetryUnsupported
		},
	}
	c2, rec2, cancel2 := testTelemetryContext(t, http.MethodGet, "tenant_1", "computer_1", "actor_owner", "tenant_1")
	defer cancel2()
	a.serveSystemTelemetrySnapshot(c2, computer, gwUnsupported)
	if rec2.Code != http.StatusConflict || !strings.Contains(rec2.Body.String(), `"SYSTEM_TELEMETRY_UNSUPPORTED"`) {
		t.Fatalf("expected 409 SYSTEM_TELEMETRY_UNSUPPORTED, got %d %s", rec2.Code, rec2.Body.String())
	}
}

func TestServeSystemTelemetryStreamHeadersProjectionAndClientDisconnect(t *testing.T) {
	now := time.Now().UTC()
	fresh := now.Add(-5 * time.Second)
	computer := agentruntimestate.LocalComputer{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "online", LastSeenAt: &fresh,
		Owner: agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
	}

	pr, pw := io.Pipe()
	upstreamCanceled := make(chan struct{})
	gw := &fakeSystemTelemetryGateway{
		streamFn: func(ctx context.Context, _ roomagent.SystemTelemetryTarget) (*http.Response, error) {
			go func() {
				<-ctx.Done()
				close(upstreamCanceled)
				_ = pr.Close()
			}()
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
				Body:       pr,
			}, nil
		},
	}

	a := &App{
		cfg:            config.Config{SSEHeartbeatInterval: 15 * time.Second},
		logger:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		localComputers: gw,
	}
	c, rec, cancel := testTelemetryContext(t, http.MethodGet, "tenant_1", "computer_1", "actor_owner", "tenant_1")

	done := make(chan struct{})
	go func() {
		defer close(done)
		a.serveSystemTelemetryStream(c, computer, gw)
	}()

	_, _ = io.WriteString(pw, "event: telemetry.snapshot\ndata: {\"computer_id\":\"computer_1\",\"revision\":9,\"observed_at\":\"2026-11-26T10:00:00Z\",\"snapshot\":{\"schema\":\"localmodels.stack-view/v1\",\"generated_at\":\"2026-11-26T10:00:00Z\",\"source\":\"live\",\"in_flight\":3}}\n\n")

	// Wait briefly for frame to be written, then cancel client context.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(rec.Body.String(), "event: telemetry.snapshot") {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("stream handler did not exit promptly after client disconnect")
	}
	select {
	case <-upstreamCanceled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream stream context was not canceled on client disconnect")
	}

	if got := rec.Header().Get("Content-Type"); got != "text/event-stream" {
		t.Fatalf("Content-Type = %q, want text/event-stream", got)
	}
	if got := rec.Header().Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("X-Accel-Buffering = %q, want no", got)
	}
	if got := rec.Header().Get("Cache-Control"); !strings.Contains(got, "no-cache") {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
	body := rec.Body.String()
	if !strings.Contains(body, `"viewer_is_owner":true`) || !strings.Contains(body, `"revision":9`) || !strings.Contains(body, `"in_flight":3`) {
		t.Fatalf("unexpected SSE body: %s", body)
	}
}
