package push

import (
	"bytes"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	token = "ExponentPushToken[abcdefghijklmnop]"
	host  = "0123456789abcdef0123456789abcdef"
)

type fakeExpo struct {
	requests []map[string]any
	auth     string
	reply    string
}

func newService(t *testing.T, now *time.Time) (*Service, *fakeExpo, *httptest.Server) {
	t.Helper()
	expo := &fakeExpo{reply: `{"data":[{"status":"ok","id":"r1"}]}`}
	expoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		expo.auth = r.Header.Get("Authorization")
		var body []map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		expo.requests = append(expo.requests, body...)
		_, _ = io.WriteString(w, expo.reply)
	}))
	t.Cleanup(expoServer.Close)
	service, err := New(Options{
		SealKey: bytes.Repeat([]byte{7}, 32), ExpoAccessToken: "expo-secret", ExpoURL: expoServer.URL,
		Logger:        slog.New(slog.NewTextHandler(io.Discard, nil)),
		ClientAddress: func(*http.Request) string { return "198.51.100.1" },
		Now:           func() time.Time { return *now },
	})
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	service.Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return service, expo, server
}

func post(t *testing.T, server *httptest.Server, path string, body any) (int, map[string]any) {
	t.Helper()
	encoded, _ := json.Marshal(body)
	response, err := http.Post(server.URL+path, "application/json", bytes.NewReader(encoded))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	out := map[string]any{}
	_ = json.NewDecoder(response.Body).Decode(&out)
	return response.StatusCode, out
}

func grantFor(t *testing.T, server *httptest.Server) string {
	t.Helper()
	status, body := post(t, server, "/v1/push/grants", map[string]string{"expo_token": token, "host_id": host})
	if status != 200 {
		t.Fatalf("grant status %d %v", status, body)
	}
	return body["grant"].(string)
}

func send(t *testing.T, server *httptest.Server, grant, kind, hostID string) (int, map[string]any) {
	t.Helper()
	return post(t, server, "/v1/push/send", map[string]any{
		"grant": grant, "kind": kind,
		"handle": map[string]string{"host_id": hostID, "room_id": "room_1", "event_id": "event_1"},
	})
}

func TestAGrantDeliversAGenericAlertForItsComputerOnly(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	_, expo, server := newService(t, &now)
	grant := grantFor(t, server)
	if strings.Contains(grant, "abcdefghijklmnop") {
		t.Fatal("the grant shows the Expo token")
	}
	if status, _ := send(t, server, grant, "message", host); status != http.StatusAccepted {
		t.Fatalf("send status %d", status)
	}
	if len(expo.requests) != 1 || expo.requests[0]["to"] != token || expo.requests[0]["body"] != "You have a new reply" || expo.auth != "Bearer expo-secret" {
		t.Fatalf("expo got %v auth %q", expo.requests, expo.auth)
	}
	// A Room's next alert replaces this one and groups with it.
	if r := expo.requests[0]; r["collapseId"] != "message:room_1" || r["tag"] != "message:room_1" ||
		r["threadId"] != "room_1" || r["interruptionLevel"] != "active" {
		t.Fatalf("alert grouping %v", r)
	}
	data := expo.requests[0]["data"].(map[string]any)
	if data["room_id"] != "room_1" || data["host_id"] != host || data["kind"] != "message" {
		t.Fatalf("alert data %v", data)
	}
	if status, _ := send(t, server, grant, "message", strings.Repeat("f", 32)); status != http.StatusUnauthorized {
		t.Fatalf("another computer's send = %d", status)
	}
	if status, _ := send(t, server, grant+"x", "message", host); status != http.StatusUnauthorized {
		t.Fatalf("tampered grant = %d", status)
	}
	if status, _ := send(t, server, grant, "content", host); status != http.StatusBadRequest {
		t.Fatalf("unknown kind = %d", status)
	}
}

func TestGrantsExpireAndQuotasHold(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	_, _, server := newService(t, &now)
	grant := grantFor(t, server)
	for i := range PerDevicePerMinute {
		if status, _ := send(t, server, grant, "decision", host); status != http.StatusAccepted {
			t.Fatalf("send %d status %d", i, status)
		}
	}
	if status, _ := send(t, server, grant, "decision", host); status != http.StatusTooManyRequests {
		t.Fatalf("over the minute quota = %d", status)
	}
	now = now.Add(GrantLifetime + time.Minute)
	if status, _ := send(t, server, grant, "decision", host); status != http.StatusGone {
		t.Fatalf("expired grant = %d", status)
	}
}

func TestGrantsForOneDeviceShareItsQuota(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	_, _, server := newService(t, &now)
	first := grantFor(t, server)
	now = now.Add(time.Second)
	second := grantFor(t, server)
	if first == second {
		t.Fatal("grants should differ")
	}
	for i := range PerDevicePerMinute {
		if status, _ := send(t, server, first, "decision", host); status != http.StatusAccepted {
			t.Fatalf("send %d status %d", i, status)
		}
	}
	if status, _ := send(t, server, second, "decision", host); status != http.StatusTooManyRequests {
		t.Fatalf("a second grant for the same device = %d", status)
	}
}

func TestAnUnregisteredDeviceIsReportedGone(t *testing.T) {
	now := time.Date(2026, 11, 22, 10, 0, 0, 0, time.UTC)
	_, expo, server := newService(t, &now)
	grant := grantFor(t, server)
	expo.reply = `{"data":[{"status":"error","details":{"error":"DeviceNotRegistered"}}]}`
	if status, _ := send(t, server, grant, "message", host); status != http.StatusGone {
		t.Fatalf("unregistered device = %d", status)
	}
}

func TestGrantRequestsAreValidated(t *testing.T) {
	now := time.Now()
	_, _, server := newService(t, &now)
	for _, body := range []map[string]string{
		{"expo_token": "not-a-token", "host_id": host},
		{"expo_token": token, "host_id": "short"},
	} {
		if status, _ := post(t, server, "/v1/push/grants", body); status != http.StatusBadRequest {
			t.Fatalf("%v = %d", body, status)
		}
	}
}
