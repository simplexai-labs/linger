package app

import (
	"encoding/json"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
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
