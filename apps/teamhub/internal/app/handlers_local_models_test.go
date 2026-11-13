package app

import (
	"encoding/json"
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
  "pool":"gpu:0","state":"loaded","endpoint":{"base_url":"http://127.0.0.1:18100/v1"},"pi_model":"localmodels-library/localmodels-lib-qwen3-8-27b-iq3s-ud-iq3-s/Qwen3.8-27B-UD-IQ3_S"},
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
