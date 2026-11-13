package roomagent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHTTPGatewayForwardsLocalModelActionAndReadsTheAnswer(t *testing.T) {
	answer := `{"request_id":"request_1","outcome":"accepted"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/local-model-actions" {
			t.Fatalf("%s %s", r.Method, r.URL.Path)
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		unloadFirst, _ := body["unload_first"].([]any)
		if len(body) != 5 || body["request_id"] != "request_1" || body["action"] != "load" || body["model_id"] != "qwen3-4b:Q4_K_M" ||
			len(unloadFirst) != 1 || unloadFirst[0] != "gemma-3:Q4" || body["expires_at"] != "2026-11-13T10:00:00Z" {
			t.Fatalf("body=%v", body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(answer))
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	command := LocalModelActionCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "request_1",
		Action: "load", ModelID: "qwen3-4b:Q4_K_M", UnloadFirst: []string{"gemma-3:Q4"},
		ExpiresAt: time.Date(2026, 11, 13, 18, 0, 0, 0, time.FixedZone("CST", 8*3600)),
	}
	refusal, err := gateway.ActOnLocalModels(context.Background(), command)
	if err != nil || refusal != nil {
		t.Fatalf("accepted answer read as refusal=%+v err=%v", refusal, err)
	}
	answer = `{"request_id":"request_1","outcome":"refused","refusal":{"code":"LOAD_NO_ROOM","pool":"gpu:1","need_bytes":10,"free_bytes":4}}`
	refusal, err = gateway.ActOnLocalModels(context.Background(), command)
	if err != nil || refusal == nil || refusal.Code != "LOAD_NO_ROOM" || refusal.Pool != "gpu:1" ||
		refusal.NeedBytes == nil || *refusal.NeedBytes != 10 || refusal.FreeBytes == nil || *refusal.FreeBytes != 4 {
		t.Fatalf("refusal=%+v err=%v", refusal, err)
	}
	answer = `{"request_id":"request_other","outcome":"accepted"}`
	if refusal, err = gateway.ActOnLocalModels(context.Background(), command); err == nil {
		t.Fatalf("an answer to another request was accepted: %+v", refusal)
	}
}

func TestHTTPGatewayMapsLocalModelActionFailures(t *testing.T) {
	for _, test := range []struct {
		status int
		body   string
		want   error
	}{
		{http.StatusNotFound, `{"error":{"code":"LOCAL_COMPUTER_NOT_FOUND","message":"x","request_id":"r"}}`, ErrLocalComputerNotFound},
		{http.StatusConflict, `{"error":{"code":"LOCAL_MODELS_UNSUPPORTED","message":"x","request_id":"r"}}`, ErrLocalModelsUnsupported},
		{http.StatusServiceUnavailable, `{"error":{"code":"LOCAL_COMPUTER_OFFLINE","message":"x","request_id":"r"}}`, ErrLocalComputerOffline},
		{http.StatusServiceUnavailable, `{"error":{"code":"LOCAL_MODELS_ACTION_TIMEOUT","message":"x","request_id":"r"}}`, ErrLocalModelsTimeout},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(test.status)
			_, _ = w.Write([]byte(test.body))
		}))
		gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
		if err != nil {
			t.Fatal(err)
		}
		_, err = gateway.ActOnLocalModels(context.Background(), LocalModelActionCommand{
			TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "request_1",
			Action: "unload", ModelID: "qwen3-4b:Q4_K_M", ExpiresAt: time.Now(),
		})
		server.Close()
		if !errors.Is(err, test.want) {
			t.Fatalf("status %d: err=%v want %v", test.status, err, test.want)
		}
	}
}
