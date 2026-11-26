package app

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const storedLocalModelsSnapshotJSON = `{"available":true,"observed_at":"2026-11-13T10:00:00Z","tool_version":"2.0.0",
"pools":[{"id":"gpu:0","kind":"gpu","gpu_index":0,"total_bytes":100,"used_bytes":40,"holders":[]}],
"models":[
 {"id":"qwen3-4b:Q4_K_M","name":"Qwen3 4B","description":"","quant":"Q4_K_M","context_tokens":32768,"vision":false,
  "download_bytes":10,"memory_bytes":40,"fit":"gpu","recommended":false,"availability":{"downloadable":true},
  "pool":"gpu:0","state":"loaded","endpoint":{"base_url":"http://127.0.0.1:18100/v1"},"pi_model":"localmodels-library/localmodels-lib-qwen3-8-27b-iq3s-ud-iq3-s/Qwen3.8-27B-UD-IQ3_S",
  "family":"qwen","publisher":"Alibaba Cloud","architecture":"moe","parameters":"30B","active_parameters":"3B",
  "capabilities":["tool_use","reasoning","coding"],"license":"Apache-2.0",
  "source_url":"https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct","prompt_tokens_per_second":612.5,
  "engine":"polystrata","engine_label":"PolyStrata 0.2.19-poly.1 · CUDA","concurrency":1,"host_ram_bytes":19800000000},
 {"id":"quick-install:Q4","name":"Quick Install","description":"","quant":"Q4","context_tokens":8192,"vision":false,
  "download_bytes":10,"memory_bytes":30,"fit":"gpu","recommended":false,"availability":{"downloadable":true},
  "pool":"gpu:0","state":"loaded","endpoint":{"base_url":"http://127.0.0.1:18101/v1"},"pi_model":"localmodels/localmodels-agent"},
 {"id":"idle:Q4","name":"Idle","description":"","quant":"Q4","context_tokens":8192,"vision":false,
  "download_bytes":10,"memory_bytes":30,"fit":"gpu","recommended":false,"availability":{"downloadable":true},
  "pool":"gpu:0","state":"idle","pi_model":"localmodels-library/localmodels-lib-idle-q4/Idle-Q4"},
 {"id":"too-big:Q8","name":"Too Big","description":"","quant":"Q8","context_tokens":8192,"vision":false,
  "download_bytes":10,"memory_bytes":3000,"fit":"none","recommended":false,
  "availability":{"downloadable":false,"reason":{"code":"MEMORY_INSUFFICIENT","need_bytes":3000,"have_bytes":100}},"state":"absent"},
 {"id":"gemma-3:Q4","name":"Gemma 3","description":"","quant":"Q4","context_tokens":8192,"vision":true,
  "download_bytes":10,"memory_bytes":30,"fit":"gpu","recommended":true,"availability":{"downloadable":true},
  "pool":"gpu:0","state":"absent"}]}`

// pi_model is <pi provider>/<pi model id>, what an Agent on runtime pi
// stores as its runtime model; only an exact match uses the model, loaded or
// not.
func TestLocalModelsViewMatchesAgentsToModelsOnTheComputer(t *testing.T) {
	now := time.Date(2026, 11, 13, 10, 0, 30, 0, time.UTC)
	seen := now.Add(-20 * time.Second)
	record := agentruntimestate.LocalModelsRecord{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "online", LastSeenAt: &seen,
		Owner:    agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
		Snapshot: json.RawMessage(storedLocalModelsSnapshotJSON),
		Host:     json.RawMessage(`{"platform":"linux","arch":"x86_64","os_label":"Ubuntu","engine_label":"llama.cpp","ram_total_bytes":1,"disk_free_bytes":1,"gpus":[]}`),
		Users: []agentruntimestate.LocalModelUser{
			{AgentID: "agent_1", Name: "Ada", RuntimeModel: "localmodels-library/localmodels-lib-qwen3-8-27b-iq3s-ud-iq3-s/Qwen3.8-27B-UD-IQ3_S"},
			{AgentID: "agent_2", Name: "Bea", RuntimeModel: "localmodels/localmodels-agent"},
			{AgentID: "agent_3", Name: "Cy", RuntimeModel: "localmodels-lib-qwen3-8-27b-iq3s-ud-iq3-s/Qwen3.8-27B-UD-IQ3_S"},
			{AgentID: "agent_4", Name: "Di", RuntimeModel: "pi-default"},
			{AgentID: "agent_5", Name: "Eve", RuntimeModel: "localmodels-library/localmodels-lib-idle-q4/Idle-Q4"},
		},
	}
	view, err := localModelsView(record, "actor_owner", now)
	if err != nil {
		t.Fatal(err)
	}
	if !view.ViewerIsOwner || !view.Available || view.Reason != nil || view.Computer.Status != httpapi.LocalModelsComputerOnline ||
		view.Computer.Host == nil || view.Computer.Host.OsLabel != "Ubuntu" || view.ToolVersion == nil || *view.ToolVersion != "2.0.0" ||
		view.ObservedAt == nil || len(view.Pools) != 1 || len(view.Models) != 5 {
		t.Fatalf("view=%+v", view)
	}
	if users := view.Models[0].UsedBy; len(users) != 1 || users[0].AgentId != "agent_1" || users[0].Name != "Ada" {
		t.Fatalf("loaded model users=%+v", users)
	}
	first := view.Models[0].Model
	if first.Family == nil || *first.Family != httpapi.LocalModelFamilyQwen ||
		first.Publisher == nil || *first.Publisher != "Alibaba Cloud" ||
		first.Architecture == nil || *first.Architecture != httpapi.LocalModelArchitectureMoe ||
		first.Parameters == nil || *first.Parameters != "30B" ||
		first.ActiveParameters == nil || *first.ActiveParameters != "3B" ||
		first.Capabilities == nil || !slices.Equal(*first.Capabilities, []httpapi.LocalModelCapability{httpapi.LocalModelCapabilityToolUse, httpapi.LocalModelCapabilityReasoning, httpapi.LocalModelCapabilityCoding}) ||
		first.License == nil || *first.License != "Apache-2.0" ||
		first.SourceUrl == nil || *first.SourceUrl != "https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct" ||
		first.PromptTokensPerSecond == nil || *first.PromptTokensPerSecond != 612.5 ||
		first.Engine == nil || *first.Engine != httpapi.LocalModelEnginePolystrata ||
		first.EngineLabel == nil || *first.EngineLabel != "PolyStrata 0.2.19-poly.1 · CUDA" ||
		first.Concurrency == nil || *first.Concurrency != 1 ||
		first.HostRamBytes == nil || *first.HostRamBytes != 19800000000 {
		t.Fatalf("rich model fields=%+v", first)
	}
	if users := view.Models[1].UsedBy; len(users) != 1 || users[0].AgentId != "agent_2" {
		t.Fatalf("Quick Install model users=%+v", users)
	}
	if users := view.Models[2].UsedBy; len(users) != 1 || users[0].AgentId != "agent_5" {
		t.Fatalf("idle model users=%+v", users)
	}
	if view.Models[3].Model.Pool != nil || view.Models[3].Model.Fit != "none" || len(view.Models[3].UsedBy) != 0 {
		t.Fatalf("a model that fits nowhere has no pool: %+v", view.Models[3])
	}
	if users := view.Models[4].UsedBy; users == nil || len(users) != 0 {
		t.Fatalf("a model not on the Computer has no users: %+v", users)
	}

	stale := now.Add(-2 * time.Minute)
	record.LastSeenAt = &stale
	view, err = localModelsView(record, "actor_member", now)
	if err != nil || view.ViewerIsOwner || view.Computer.Status != httpapi.LocalModelsComputerOffline {
		t.Fatalf("stale Computer for a member: view=%+v err=%v", view, err)
	}
}

// The folder a gateway cause names is a path on the owner's machine: only
// the owner, who can rename it, reads it.
func TestLocalModelsViewShowsTheCausePathOnlyToTheOwner(t *testing.T) {
	snapshot := strings.Replace(storedLocalModelsSnapshotJSON, `"state":"idle"`,
		`"state":"failed","error":{"code":"GATEWAY_REGISTRATION_FAILED","cause":"GATEWAY_HOME_NOT_PRIVATE","path":"/home/ana/.local/share/localmodels/tools/gateway-home"}`, 1)
	record := agentruntimestate.LocalModelsRecord{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "offline",
		Owner:    agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
		Snapshot: json.RawMessage(snapshot),
	}
	for viewer, wantPath := range map[string]bool{"actor_owner": true, "actor_member": false} {
		view, err := localModelsView(record, viewer, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		failed := view.Models[2].Model.Error
		if failed == nil || failed.Cause == nil || *failed.Cause != httpapi.LocalModelErrorCauseGatewayHomeNotPrivate ||
			(failed.Path != nil) != wantPath {
			t.Fatalf("%s: error=%+v", viewer, failed)
		}
	}
}

func TestLocalModelsViewWithoutSnapshotIsNotReported(t *testing.T) {
	view, err := localModelsView(agentruntimestate.LocalModelsRecord{ComputerID: "computer_1", DisplayName: "Studio", Status: "offline"}, "actor_owner", time.Now())
	if err != nil || view.Available || view.Reason == nil || view.Reason.Code != httpapi.LocalModelsViewNotReported ||
		view.ObservedAt != nil || view.Pools == nil || view.Models == nil || view.Computer.Status != httpapi.LocalModelsComputerOffline {
		t.Fatalf("view=%+v err=%v", view, err)
	}
	encoded, err := json.Marshal(view)
	if err != nil {
		t.Fatal(err)
	}
	var shape map[string]any
	if err := json.Unmarshal(encoded, &shape); err != nil || shape["pools"] == nil || shape["models"] == nil {
		t.Fatalf("lists must encode as arrays: %s", encoded)
	}
}

func TestValidLocalModelAction(t *testing.T) {
	list := func(values ...string) *[]string { return &values }
	for _, test := range []struct {
		name    string
		modelID string
		request httpapi.LocalModelActionRequest
		want    bool
	}{
		{"download", "qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: "download"}, true},
		{"load making room", "qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: "load", UnloadFirst: list("a:1", "b:2")}, true},
		{"refresh is not public", "qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: "refresh"}, false},
		{"bad model id", "../etc", httpapi.LocalModelActionRequest{Action: "unload"}, false},
		{"unload_first only with load", "m:1", httpapi.LocalModelActionRequest{Action: "unload", UnloadFirst: list("a:1")}, false},
		{"empty unload_first", "m:1", httpapi.LocalModelActionRequest{Action: "load", UnloadFirst: list()}, false},
		{"duplicate unload_first", "m:1", httpapi.LocalModelActionRequest{Action: "load", UnloadFirst: list("a:1", "a:1")}, false},
		{"unloads itself", "m:1", httpapi.LocalModelActionRequest{Action: "load", UnloadFirst: list("m:1")}, false},
	} {
		if got := validLocalModelAction(test.modelID, test.request); got != test.want {
			t.Errorf("%s: got %v", test.name, got)
		}
	}
}

func TestValidLocalModelsSnapshot(t *testing.T) {
	var snapshot teamhubinternal.LocalModelsSnapshot
	if err := json.Unmarshal([]byte(storedLocalModelsSnapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	if !validLocalModelsSnapshot(snapshot) {
		t.Fatal("a valid snapshot was refused")
	}
	reason := &teamhubinternal.LocalModelsUnavailableReason{Code: "TOOL_NOT_INSTALLED"}
	unavailable := teamhubinternal.LocalModelsSnapshot{ObservedAt: snapshot.ObservedAt, Reason: reason}
	if !validLocalModelsSnapshot(unavailable) {
		t.Fatal("an unavailable library with its reason was refused")
	}
	for name, mutate := range map[string]func(*teamhubinternal.LocalModelsSnapshot){
		"available with a reason": func(s *teamhubinternal.LocalModelsSnapshot) { s.Reason = reason },
		"unavailable, no reason":  func(s *teamhubinternal.LocalModelsSnapshot) { s.Available = false },
		"no observation time":     func(s *teamhubinternal.LocalModelsSnapshot) { s.ObservedAt = time.Time{} },
		"unknown state":           func(s *teamhubinternal.LocalModelsSnapshot) { s.Models[0].State = "paused" },
		"duplicate model":         func(s *teamhubinternal.LocalModelsSnapshot) { s.Models[1].Id = s.Models[0].Id },
		"unknown pool kind":       func(s *teamhubinternal.LocalModelsSnapshot) { s.Pools[0].Kind = "tpu" },
		"unknown unavailable code": func(s *teamhubinternal.LocalModelsSnapshot) {
			s.Available, s.Reason = false, &teamhubinternal.LocalModelsUnavailableReason{Code: "X"}
		},
		"unknown family": func(s *teamhubinternal.LocalModelsSnapshot) {
			f := teamhubinternal.LocalModelFamily("unknown")
			s.Models[0].Family = &f
		},
		"unknown architecture": func(s *teamhubinternal.LocalModelsSnapshot) {
			a := teamhubinternal.LocalModelArchitecture("ssm")
			s.Models[0].Architecture = &a
		},
		"unknown capability": func(s *teamhubinternal.LocalModelsSnapshot) {
			c := []teamhubinternal.LocalModelCapability{"audio"}
			s.Models[0].Capabilities = &c
		},
		"duplicate capability": func(s *teamhubinternal.LocalModelsSnapshot) {
			c := []teamhubinternal.LocalModelCapability{teamhubinternal.LocalModelCapabilityVision, teamhubinternal.LocalModelCapabilityVision}
			s.Models[0].Capabilities = &c
		},
		"non-https source_url": func(s *teamhubinternal.LocalModelsSnapshot) {
			u := "http://huggingface.co/Qwen/Qwen3-4B"
			s.Models[0].SourceUrl = &u
		},
		"unknown error cause": func(s *teamhubinternal.LocalModelsSnapshot) {
			c := teamhubinternal.LocalModelErrorCause("DISK_LOCKED")
			s.Models[0].State = teamhubinternal.LocalModelStateFailed
			s.Models[0].Error = &teamhubinternal.LocalModelError{Code: "GATEWAY_REGISTRATION_FAILED", Cause: &c}
		},
		"negative prompt_tokens_per_second": func(s *teamhubinternal.LocalModelsSnapshot) {
			p := float32(-1)
			s.Models[0].PromptTokensPerSecond = &p
		},
		"unknown engine": func(s *teamhubinternal.LocalModelsSnapshot) {
			e := teamhubinternal.LocalModelEngine("vllm")
			s.Models[0].Engine = &e
		},
		"zero concurrency": func(s *teamhubinternal.LocalModelsSnapshot) {
			c := 0
			s.Models[0].Concurrency = &c
		},
		"negative host_ram_bytes": func(s *teamhubinternal.LocalModelsSnapshot) {
			r := int64(-1)
			s.Models[0].HostRamBytes = &r
		},
		"concurrency_probing outside loading": func(s *teamhubinternal.LocalModelsSnapshot) {
			p := true
			s.Models[0].ConcurrencyProbing = &p
		},
	} {
		var copied teamhubinternal.LocalModelsSnapshot
		if err := json.Unmarshal([]byte(storedLocalModelsSnapshotJSON), &copied); err != nil {
			t.Fatal(err)
		}
		mutate(&copied)
		if validLocalModelsSnapshot(copied) {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLocalModelsViewShowsDebugConfigPathOnlyToOwner(t *testing.T) {
	snapshot := strings.TrimSuffix(storedLocalModelsSnapshotJSON, "}") +
		`,"debug":{"mode":"tiny","source":"user_config","config_path":"/home/ana/.config/localmodels/debug.json"}}`
	record := agentruntimestate.LocalModelsRecord{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "online",
		Owner:    agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
		Snapshot: json.RawMessage(snapshot),
	}
	for viewer, wantPath := range map[string]bool{"actor_owner": true, "actor_member": false} {
		view, err := localModelsView(record, viewer, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		if view.Debug == nil || view.Debug.Mode != httpapi.LocalModelsDebugModeTiny ||
			view.Debug.Source != httpapi.LocalModelsDebugSourceUserConfig ||
			(view.Debug.ConfigPath != nil) != wantPath {
			t.Fatalf("%s: debug=%+v", viewer, view.Debug)
		}
	}
}

func TestSanitizeLocalModelsSnapshotForwardCompatibility(t *testing.T) {
	var snapshot teamhubinternal.LocalModelsSnapshot
	if err := json.Unmarshal([]byte(storedLocalModelsSnapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	badFamily := teamhubinternal.LocalModelFamily("new_vendor")
	badArch := teamhubinternal.LocalModelArchitecture("ssm")
	badCaps := []teamhubinternal.LocalModelCapability{"vision", "vision", "audio"}
	badCause := teamhubinternal.LocalModelErrorCause("FUTURE_CAUSE")
	path := "/tmp/x"
	badNote := teamhubinternal.LocalModelNoteCode("FUTURE_NOTE")
	badEngine := teamhubinternal.LocalModelEngine("future_engine")
	badConcurrency := 0
	badHostRam := int64(-5)
	probingOnFailed := true
	snapshot.Models[0].Family = &badFamily
	snapshot.Models[0].Architecture = &badArch
	snapshot.Models[0].Capabilities = &badCaps
	snapshot.Models[0].Engine = &badEngine
	snapshot.Models[0].Concurrency = &badConcurrency
	snapshot.Models[0].ConcurrencyProbing = &probingOnFailed
	snapshot.Models[0].HostRamBytes = &badHostRam
	snapshot.Models[0].State = teamhubinternal.LocalModelStateFailed
	snapshot.Models[0].Error = &teamhubinternal.LocalModelError{Code: "FUTURE_CODE", Cause: &badCause, Path: &path}
	snapshot.Models[2].Note = &teamhubinternal.LocalModelNote{Code: badNote}
	snapshot.Models[3].Availability.Reason = &teamhubinternal.LocalModelAvailabilityReason{Code: "FUTURE_REASON"}

	sanitizeLocalModelsSnapshot(&snapshot)
	if !validLocalModelsSnapshot(snapshot) {
		t.Fatal("sanitized snapshot was rejected")
	}
	if snapshot.Models[0].Family == nil || *snapshot.Models[0].Family != teamhubinternal.LocalModelFamilyOther ||
		snapshot.Models[0].Architecture != nil ||
		snapshot.Models[0].Engine != nil ||
		snapshot.Models[0].Concurrency != nil ||
		snapshot.Models[0].ConcurrencyProbing != nil ||
		snapshot.Models[0].HostRamBytes != nil ||
		snapshot.Models[0].Capabilities == nil || !slices.Equal(*snapshot.Models[0].Capabilities, []teamhubinternal.LocalModelCapability{teamhubinternal.LocalModelCapabilityVision}) ||
		snapshot.Models[0].Error.Code != teamhubinternal.UNKNOWNERROR || snapshot.Models[0].Error.Cause != nil || snapshot.Models[0].Error.Path != nil ||
		snapshot.Models[2].Note != nil ||
		snapshot.Models[3].Availability.Reason.Code != teamhubinternal.LocalModelAvailabilityUnavailable {
		t.Fatalf("unexpected sanitized models: %+v", snapshot.Models)
	}
}

func TestLocalModelsViewPassesThroughConcurrencyProbingWhileLoading(t *testing.T) {
	probingSnapshot := strings.Replace(storedLocalModelsSnapshotJSON,
		`"state":"idle"`,
		`"state":"loading","concurrency_probing":true`, 1)
	var internal teamhubinternal.LocalModelsSnapshot
	if err := json.Unmarshal([]byte(probingSnapshot), &internal); err != nil {
		t.Fatal(err)
	}
	if !validLocalModelsSnapshot(internal) {
		t.Fatal("loading snapshot with concurrency_probing=true was rejected")
	}
	record := agentruntimestate.LocalModelsRecord{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "online",
		Owner:    agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
		Snapshot: json.RawMessage(probingSnapshot),
	}
	view, err := localModelsView(record, "actor_owner", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	probingModel := view.Models[2].Model
	if probingModel.State != httpapi.LocalModelStateLoading || probingModel.ConcurrencyProbing == nil || !*probingModel.ConcurrencyProbing {
		t.Fatalf("probing model = %+v, want state=loading concurrency_probing=true", probingModel)
	}
}

func TestValidLocalModelActionSupportsSmokeTestAndLoadOverrides(t *testing.T) {
	boolPtr := func(v bool) *bool { return &v }
	int64Ptr := func(v int64) *int64 { return &v }
	for _, test := range []struct {
		name    string
		modelID string
		request httpapi.LocalModelActionRequest
		want    bool
	}{
		{"smoke_test default", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestSmokeTest}, true},
		{"smoke_test 4096", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestSmokeTest, ContextTokens: int64Ptr(4096)}, true},
		{"smoke_test 2048", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestSmokeTest, ContextTokens: int64Ptr(2048)}, true},
		{"smoke_test invalid ctx", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestSmokeTest, ContextTokens: int64Ptr(1024)}, false},
		{"smoke_test forbids force", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestSmokeTest, Force: boolPtr(true)}, false},
		{"load force and ctx", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestLoad, Force: boolPtr(true), ContextTokens: int64Ptr(8192)}, true},
		{"load ctx too small", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestLoad, ContextTokens: int64Ptr(256)}, false},
		{"unload forbids force", "hf-qwen-qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestUnload, Force: boolPtr(true)}, false},
	} {
		if got := validLocalModelAction(test.modelID, test.request); got != test.want {
			t.Errorf("%s: got %v, want %v", test.name, got, test.want)
		}
	}
}

func TestWriteLocalModelsRefusalPreservesStructuredByteDetailsAndNeverReturns401(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	need := int64(8_000_000_000)
	free := int64(2_000_000_000)

	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Set("request_id", "req_refusal")
	a.writeMappedLocalModelRefusal(c, "computer_1", "load", &roomagent.LocalModelActionRefusal{
		Code: "LOAD_NO_ROOM", Pool: "gpu:0", NeedBytes: &need, FreeBytes: &free,
	})
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
	var resp httpapi.LocalModelsErrorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Error.Code != httpapi.LocalModelsErrorCodeLOCALMODELNOROOM ||
		resp.Error.Pool == nil || *resp.Error.Pool != "gpu:0" ||
		resp.Error.NeedBytes == nil || *resp.Error.NeedBytes != need ||
		resp.Error.FreeBytes == nil || *resp.Error.FreeBytes != free {
		t.Fatalf("refusal response=%+v", resp.Error)
	}

	// Hub auth refusals MUST return HTTP 409 (never HTTP 401, which logs Web out).
	for _, code := range []string{"HUB_AUTH_REQUIRED", "HUB_FORBIDDEN"} {
		rec := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(rec)
		ctx.Set("request_id", "req_hub")
		a.writeMappedLocalModelRefusal(ctx, "computer_1", "custom_download", &roomagent.LocalModelActionRefusal{Code: code})
		if rec.Code != http.StatusConflict {
			t.Fatalf("%s returned status %d, want 409 (never 401)", code, rec.Code)
		}
	}
}

func TestWriteLocalModelsCustomFailureMappings(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	for _, test := range []struct {
		name       string
		err        error
		wantStatus int
		wantCode   string
	}{
		{"unsupported daemon", roomagent.ErrLocalModelsCustomUnsupported, http.StatusConflict, string(httpapi.LocalModelsErrorCodeLOCALMODELSCUSTOMUNSUPPORTED)},
		{"hub unreachable", &roomagent.LocalModelsCustomError{Code: "HUB_UNREACHABLE"}, http.StatusBadGateway, string(httpapi.LocalModelsErrorCodeLOCALMODELHUBUNREACHABLE)},
		{"hub auth never 401", &roomagent.LocalModelsCustomError{Code: "HUB_AUTH_REQUIRED"}, http.StatusConflict, string(httpapi.LocalModelsErrorCodeLOCALMODELHUBAUTHREQUIRED)},
		{"invalid repo spec", &roomagent.LocalModelsCustomError{Code: "INVALID_REPO_SPEC"}, http.StatusBadRequest, "INVALID_REQUEST"},
		{"deadline exceeded", context.DeadlineExceeded, http.StatusGatewayTimeout, string(httpapi.LocalModelsErrorCodeLOCALMODELACTIONUNCONFIRMED)},
	} {
		rec := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(rec)
		c.Set("request_id", "req_custom")
		a.writeLocalModelsCustomFailure(c, "computer_1", "probe", test.err)
		if rec.Code != test.wantStatus || !strings.Contains(rec.Body.String(), `"code":"`+test.wantCode+`"`) {
			t.Fatalf("%s: status=%d body=%s", test.name, rec.Code, rec.Body.String())
		}
	}
}

func TestCustomProbeInvalidRequestNeverEchoesHubToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	var logs bytes.Buffer
	a := &App{logger: slog.New(slog.NewJSONHandler(&logs, nil))}
	secret := "hf_abcdefghijklmnopqrstuvwxyz123456"
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(http.MethodPost, "/v0/tenants/t1/local-computers/c1/local-models/custom/probe",
		strings.NewReader(`{"target":"","token":"`+secret+`"}`))
	c.Set("request_id", "req_bad_probe")
	a.probeLocalComputerCustomModel(c)
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), secret) || strings.Contains(logs.String(), secret) {
		t.Fatalf("status=%d body=%s logs=%s", rec.Code, rec.Body.String(), logs.String())
	}
}

func TestLocalModelsViewScrubsDiagnosticLogForNonOwnersAndSanitizesCustomFields(t *testing.T) {
	hfSecret := "hf_secretToken1234567890abcd"
	msSecret := "ms-secret_token_1234567890abcd"
	customSnapshot := `{
		"available":true,"observed_at":"2026-11-26T10:00:00Z","tool_version":"2.1.0",
		"host":{"platform":"darwin","arch":"arm64","os_label":"macOS 15","engine_label":"MLX","ram_total_bytes":100,"disk_free_bytes":100,"gpus":[],"supported_formats":["mlx","gguf","gguf","unknown_fmt"]},
		"pools":[{"id":"unified","kind":"unified","total_bytes":100,"used_bytes":10,"holders":[]}],
		"models":[{
			"id":"hf-qwen-qwen3-4b:Q4_K_M","name":"Qwen3 4B","description":"","quant":"Q4_K_M","context_tokens":32768,"vision":false,
			"download_bytes":10,"memory_bytes":40,"fit":"unified","recommended":false,"availability":{"downloadable":true},
			"pool":"unified","state":"idle","engine":"mlx","origin":"custom",
			"download":{"step":"download","downloaded_bytes":5,"total_bytes":10,"shard_index":1,"shard_count":3},
			"custom":{"hub":"huggingface","repo_id":"Qwen/Qwen3-4B-GGUF","variant_id":"Q4_K_M","format":"gguf","shard_count":3,"url":"https://huggingface.co/Qwen/Qwen3-4B-GGUF"},
			"verification":{
				"status":"failed",
				"failure":{
					"kind":"unsupported_architecture",
					"code":"UNSUPPORTED_ARCHITECTURE",
					"context_tokens":4096,
					"diagnostic_log":"failed auth ` + hfSecret + ` and ` + msSecret + ` ` + strings.Repeat("x", 4500) + `"
				}
			}
		}]
	}`
	var internal teamhubinternal.LocalModelsSnapshot
	if err := json.Unmarshal([]byte(customSnapshot), &internal); err != nil {
		t.Fatal(err)
	}
	sanitizeLocalModelsSnapshot(&internal)
	if !validLocalModelsSnapshot(internal) {
		t.Fatal("sanitized custom snapshot was rejected")
	}
	if internal.Host == nil || internal.Host.SupportedFormats == nil ||
		!slices.Equal(*internal.Host.SupportedFormats, []teamhubinternal.LocalModelFormat{teamhubinternal.LocalModelFormatMlx, teamhubinternal.LocalModelFormatGguf}) {
		t.Fatalf("supported_formats=%+v", internal.Host)
	}
	diag := *internal.Models[0].Verification.Failure.DiagnosticLog
	if strings.Contains(diag, hfSecret) || strings.Contains(diag, msSecret) || len([]rune(diag)) > 4000 {
		t.Fatalf("diagnostic_log not redacted or capped: len=%d containsHF=%v containsMS=%v", len([]rune(diag)), strings.Contains(diag, hfSecret), strings.Contains(diag, msSecret))
	}

	sanitizedJSON, err := json.Marshal(internal)
	if err != nil {
		t.Fatal(err)
	}
	hostJSON, err := json.Marshal(internal.Host)
	if err != nil {
		t.Fatal(err)
	}
	record := agentruntimestate.LocalModelsRecord{
		ComputerID: "computer_1", DisplayName: "Mac", Status: "online",
		Owner:    agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
		Snapshot: sanitizedJSON,
		Host:     hostJSON,
	}
	for viewer, wantDiag := range map[string]bool{"actor_owner": true, "actor_member": false} {
		view, err := localModelsView(record, viewer, time.Now())
		if err != nil {
			t.Fatal(err)
		}
		got := view.Models[0].Model
		if got.Origin == nil || *got.Origin != httpapi.LocalModelOriginCustom ||
			got.Engine == nil || *got.Engine != httpapi.LocalModelEngineMlx ||
			got.Custom == nil || got.Custom.RepoId != "Qwen/Qwen3-4B-GGUF" ||
			got.Download == nil || got.Download.ShardIndex == nil || *got.Download.ShardIndex != 1 ||
			got.Verification == nil || got.Verification.Failure == nil ||
			(got.Verification.Failure.DiagnosticLog != nil) != wantDiag {
			t.Fatalf("%s: got=%+v", viewer, got)
		}
	}
}
