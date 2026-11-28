package roomagent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
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

func TestHTTPGatewayLocalModelsClientOverridesShortBaseTimeout(t *testing.T) {
	if localModelsActionRequestTimeout <= 30*time.Second {
		t.Fatalf("localModelsActionRequestTimeout = %v, want headroom above 30s action lifetime", localModelsActionRequestTimeout)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		time.Sleep(40 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"request_id":"request_1","outcome":"accepted"}`))
	}))
	t.Cleanup(server.Close)
	shortClient := server.Client()
	shortClient.Timeout = 10 * time.Millisecond
	gateway, err := NewHTTPGateway(server.URL, "service-secret", shortClient)
	if err != nil {
		t.Fatal(err)
	}
	refusal, err := gateway.ActOnLocalModels(context.Background(), LocalModelActionCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "request_1",
		Action: "load", ModelID: "qwen3-4b:Q4_K_M", ExpiresAt: time.Now().Add(30 * time.Second),
	})
	if err != nil || refusal != nil {
		t.Fatalf("ActOnLocalModels with dedicated timeout failed: refusal=%+v err=%v", refusal, err)
	}
}

func TestHTTPGatewayCustomLocalModelsEndpointsAndErrors(t *testing.T) {
	var seenPaths []string
	var lastBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPaths = append(seenPaths, r.URL.Path)
		lastBody = nil
		_ = json.NewDecoder(r.Body).Decode(&lastBody)
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/local-models/custom/search":
			_, _ = w.Write([]byte(`{"hub":"huggingface","format":"all","query":"qwen","platform":"linux","arch":"x86_64","supported_formats":["gguf"],"warnings":[],"results":[{"hub":"huggingface","repo_id":"Qwen/Qwen3-4B-GGUF","owner":"Qwen","format":"gguf","downloads":100,"likes":10,"gated":false,"compatible":true,"url":"https://huggingface.co/Qwen/Qwen3-4B-GGUF"}]}`))
		case "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/local-models/custom/probe":
			_, _ = w.Write([]byte(`{"outcome":"gated","hub":"huggingface","repo_id":"meta-llama/Llama-3","hub_http_status":401,"license_url":"https://huggingface.co/meta-llama/Llama-3"}`))
		case "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/local-models/custom/download":
			if lastBody["request_id"] == "req_refuse" {
				_, _ = w.Write([]byte(`{"request_id":"req_refuse","outcome":"refused","refusal":{"code":"DISK_INSUFFICIENT","need_bytes":8000,"free_bytes":1000}}`))
				return
			}
			_, _ = w.Write([]byte(`{"request_id":"req_dl","outcome":"accepted","model_id":"hf-qwen-qwen3-4b:Q4_K_M"}`))
		case "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/local-model-actions":
			if lastBody["action"] == "smoke_test" {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"error":{"code":"LOCAL_MODELS_CUSTOM_UNSUPPORTED","message":"upgrade","request_id":"r"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"request_id":"req_load","outcome":"accepted"}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)

	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	target := ModelSourceTarget{TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1"}

	query := "qwen"
	searchResp, err := gateway.SearchLocalComputerCustomModels(context.Background(), target, nodeservicesinternal.LocalModelCustomSearchRequest{Query: &query})
	if err != nil || searchResp.Hub != nodeservicesinternal.LocalModelCustomSearchHubHuggingface || len(searchResp.Results) != 1 {
		t.Fatalf("searchResp=%+v err=%v", searchResp, err)
	}

	probeResp, err := gateway.ProbeLocalComputerCustomModel(context.Background(), target, nodeservicesinternal.LocalModelCustomProbeRequest{Target: "meta-llama/Llama-3"})
	if err != nil || probeResp.Outcome != nodeservicesinternal.LocalModelCustomProbeOutcomeGated || probeResp.HubHttpStatus == nil || *probeResp.HubHttpStatus != 401 {
		t.Fatalf("probeResp=%+v err=%v", probeResp, err)
	}

	modelID, refusal, err := gateway.DownloadLocalComputerCustomModel(context.Background(), LocalModelCustomDownloadCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "req_dl",
		CustomDownload: nodeservicesinternal.LocalModelCustomDownloadInput{
			Hub: nodeservicesinternal.LocalModelCustomHubHuggingface, RepoId: "Qwen/Qwen3-4B-GGUF", VariantId: "Q4_K_M",
		},
		ExpiresAt: time.Now().Add(30 * time.Second),
	})
	if err != nil || refusal != nil || modelID != "hf-qwen-qwen3-4b:Q4_K_M" {
		t.Fatalf("download accepted: modelID=%q refusal=%+v err=%v", modelID, refusal, err)
	}

	_, refusal, err = gateway.DownloadLocalComputerCustomModel(context.Background(), LocalModelCustomDownloadCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "req_refuse",
		CustomDownload: nodeservicesinternal.LocalModelCustomDownloadInput{
			Hub: nodeservicesinternal.LocalModelCustomHubHuggingface, RepoId: "Qwen/Qwen3-4B-GGUF", VariantId: "Q4_K_M",
		},
		ExpiresAt: time.Now().Add(30 * time.Second),
	})
	if err != nil || refusal == nil || refusal.Code != "DISK_INSUFFICIENT" ||
		refusal.NeedBytes == nil || *refusal.NeedBytes != 8000 || refusal.FreeBytes == nil || *refusal.FreeBytes != 1000 {
		t.Fatalf("download refused: refusal=%+v err=%v", refusal, err)
	}

	ctxTokens := int64(4096)
	force := true
	if refusal, err := gateway.ActOnLocalModels(context.Background(), LocalModelActionCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "req_load",
		Action: "load", ModelID: "hf-qwen-qwen3-4b:Q4_K_M", Force: &force, ContextTokens: &ctxTokens,
		ExpiresAt: time.Now().Add(30 * time.Second),
	}); err != nil || refusal != nil || lastBody["force"] != true || lastBody["context_tokens"] != float64(4096) {
		t.Fatalf("load with force+ctx: refusal=%+v err=%v body=%v", refusal, err, lastBody)
	}

	if _, err := gateway.ActOnLocalModels(context.Background(), LocalModelActionCommand{
		TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", RequestID: "req_smoke",
		Action: "smoke_test", ModelID: "hf-qwen-qwen3-4b:Q4_K_M", ContextTokens: &ctxTokens,
		ExpiresAt: time.Now().Add(30 * time.Second),
	}); !errors.Is(err, ErrLocalModelsCustomUnsupported) {
		t.Fatalf("smoke_test unsupported err=%v, want ErrLocalModelsCustomUnsupported", err)
	}
}
