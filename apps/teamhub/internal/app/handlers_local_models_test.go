package app

import (
	"encoding/json"
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

func TestLocalModelsViewRedactsStoragePathsForNonOwnersAndKeepsOfflineHost(t *testing.T) {
	storageJSON := `,"storage":{"dir":"/home/alice/.simplexai/runtime/localmodels/models/models","primary_path":"/home/alice/.simplexai/runtime/localmodels/models/models/idle.gguf","dedicated_dir":false,"disk_bytes":1024,"files_present":true,"files":[{"path":"/home/alice/.simplexai/runtime/localmodels/models/models/idle.gguf","role":"weights","size_bytes":1024,"present":true,"shared":false}]}`
	snapshot := strings.Replace(storedLocalModelsSnapshotJSON, `"state":"idle"`, `"state":"idle"`+storageJSON, 1)
	hostJSON := `{"platform":"linux","arch":"x86_64","os_label":"Ubuntu","engine_label":"llama.cpp","ram_total_bytes":1,"disk_free_bytes":1,"models_dir":"/home/alice/.simplexai/runtime/localmodels/models/models","models_dir_exists":true,"gpus":[]}`

	record := agentruntimestate.LocalModelsRecord{
		ComputerID: "computer_1", DisplayName: "Studio", Status: "offline",
		Owner:    agentruntimestate.LocalComputerOwner{TenantID: "tenant_1", OwnerActorID: "actor_owner"},
		Snapshot: json.RawMessage(snapshot),
		Host:     json.RawMessage(hostJSON),
	}

	ownerView, err := localModelsView(record, "actor_owner", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if ownerView.Computer.Status != httpapi.LocalModelsComputerOffline ||
		ownerView.Computer.Host == nil ||
		ownerView.Computer.Host.ModelsDir == nil ||
		*ownerView.Computer.Host.ModelsDir != "/home/alice/.simplexai/runtime/localmodels/models/models" ||
		ownerView.Computer.Host.ModelsDirExists == nil ||
		!*ownerView.Computer.Host.ModelsDirExists {
		t.Fatalf("owner offline host lost storage fields: %+v", ownerView.Computer.Host)
	}
	if ownerView.Models[2].Model.Storage == nil ||
		ownerView.Models[2].Model.Storage.PrimaryPath != "/home/alice/.simplexai/runtime/localmodels/models/models/idle.gguf" {
		t.Fatalf("owner model lost storage: %+v", ownerView.Models[2].Model.Storage)
	}

	memberView, err := localModelsView(record, "actor_member", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if memberView.Computer.Host == nil || memberView.Computer.Host.ModelsDir != nil || memberView.Computer.Host.ModelsDirExists != nil {
		t.Fatalf("non-owner saw host storage fields: %+v", memberView.Computer.Host)
	}
	for _, entry := range memberView.Models {
		if entry.Model.Storage != nil {
			t.Fatalf("non-owner saw model storage on %s: %+v", entry.Model.Id, entry.Model.Storage)
		}
	}

	// Offline Computer with no snapshot still preserves host.models_dir for owner only.
	noSnap := record
	noSnap.Snapshot = nil
	ownerNoSnap, err := localModelsView(noSnap, "actor_owner", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if ownerNoSnap.Computer.Host == nil || ownerNoSnap.Computer.Host.ModelsDir == nil {
		t.Fatalf("owner without snapshot lost host.models_dir: %+v", ownerNoSnap.Computer.Host)
	}
	memberNoSnap, err := localModelsView(noSnap, "actor_member", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if memberNoSnap.Computer.Host == nil || memberNoSnap.Computer.Host.ModelsDir != nil || memberNoSnap.Computer.Host.ModelsDirExists != nil {
		t.Fatalf("non-owner without snapshot saw host storage fields: %+v", memberNoSnap.Computer.Host)
	}
}

func TestSanitizeLocalModelsSnapshotStorage(t *testing.T) {
	var snapshot teamhubinternal.LocalModelsSnapshot
	if err := json.Unmarshal([]byte(storedLocalModelsSnapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	rawDir := "  /tmp/models  "
	exists := true
	snapshot.Host = &teamhubinternal.LocalModelHost{
		Platform:        teamhubinternal.LocalModelHostPlatformLinux,
		Arch:            teamhubinternal.LocalModelHostArchX8664,
		OsLabel:         "Ubuntu",
		EngineLabel:     "llama.cpp",
		RamTotalBytes:   1,
		DiskFreeBytes:   1,
		ModelsDir:       &rawDir,
		ModelsDirExists: &exists,
		Gpus:            []teamhubinternal.LocalModelGpu{},
	}
	// Idle model with dirty storage fields gets sanitized.
	snapshot.Models[2].Storage = &teamhubinternal.LocalModelStorage{
		Dir:          "  /tmp/models  ",
		PrimaryPath:  "  /tmp/models/m.gguf  ",
		DedicatedDir: false,
		DiskBytes:    -10,
		FilesPresent: true,
		Files: []teamhubinternal.LocalModelStorageFile{
			{Path: "  /tmp/models/m.gguf ", Role: "future_role", SizeBytes: -5, Present: true, Shared: false},
			{Path: "   ", Role: teamhubinternal.LocalModelStorageFileRoleMmproj, SizeBytes: 100, Present: true, Shared: true},
		},
	}
	// Absent model must have storage cleared.
	snapshot.Models[4].Storage = &teamhubinternal.LocalModelStorage{
		Dir: "/tmp/models", PrimaryPath: "/tmp/models/a.gguf",
		Files: []teamhubinternal.LocalModelStorageFile{{Path: "/tmp/models/a.gguf", Role: teamhubinternal.LocalModelStorageFileRoleWeights}},
	}

	sanitizeLocalModelsSnapshot(&snapshot)
	if !validLocalModelsSnapshot(snapshot) {
		t.Fatal("sanitized snapshot with storage was rejected")
	}
	if snapshot.Host.ModelsDir == nil || *snapshot.Host.ModelsDir != "/tmp/models" {
		t.Fatalf("sanitized host models_dir = %+v", snapshot.Host.ModelsDir)
	}
	if got := snapshot.Models[2].Storage; got == nil || got.Dir != "/tmp/models" || got.PrimaryPath != "/tmp/models/m.gguf" ||
		got.DiskBytes != 0 || len(got.Files) != 1 || got.Files[0].Role != teamhubinternal.LocalModelStorageFileRoleOther || got.Files[0].SizeBytes != 0 {
		t.Fatalf("sanitized model storage = %+v", got)
	}
	if snapshot.Models[4].Storage != nil {
		t.Fatalf("absent model retained storage: %+v", snapshot.Models[4].Storage)
	}
}

func TestValidLocalModelActionForce(t *testing.T) {
	yes := true
	if !validLocalModelAction("qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: httpapi.LocalModelActionRequestLoad, Force: &yes}) {
		t.Fatal("load with force=true should be valid")
	}
	for _, action := range []httpapi.LocalModelActionRequestAction{
		httpapi.LocalModelActionRequestDownload,
		httpapi.LocalModelActionRequestCancel,
		httpapi.LocalModelActionRequestUnload,
		httpapi.LocalModelActionRequestRemove,
	} {
		if validLocalModelAction("qwen3-4b:Q4_K_M", httpapi.LocalModelActionRequest{Action: action, Force: &yes}) {
			t.Errorf("%s with force=true should be rejected", action)
		}
	}
}

func TestWriteLocalModelsErrorDetailsPreservesNoRoomRefusalFields(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Set("request_id", "req-local-model-test")
	need, free, shortfall := int64(12_000_000_000), int64(8_000_000_000), int64(4_000_000_000)
	canForce := true
	refusal := &roomagent.LocalModelActionRefusal{
		Code: "LOAD_NO_ROOM", Pool: "unified", NeedBytes: &need, FreeBytes: &free,
		ShortfallBytes: &shortfall, CanForce: &canForce,
	}
	app := &App{}
	app.writeLocalModelsErrorDetails(ctx, httpapi.LocalModelsErrorCodeLOCALMODELNOROOM, localModelRefusalDetails(refusal))

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", recorder.Code)
	}
	var payload struct {
		Error struct {
			Code    string `json:"code"`
			Details []struct {
				Field  string `json:"field"`
				Reason string `json:"reason"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Error.Code != string(httpapi.LocalModelsErrorCodeLOCALMODELNOROOM) {
		t.Fatalf("error code = %q", payload.Error.Code)
	}
	got := map[string]string{}
	for _, item := range payload.Error.Details {
		got[item.Field] = item.Reason
	}
	want := map[string]string{
		"pool":            "unified",
		"need_bytes":      "12000000000",
		"free_bytes":      "8000000000",
		"shortfall_bytes": "4000000000",
		"can_force":       "true",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("details[%q] = %q, want %q (all=%v)", k, got[k], v, got)
		}
	}
}

func TestSanitizeAndValidateElasticAdmissionSnapshotFields(t *testing.T) {
	var snapshot teamhubinternal.LocalModelsSnapshot
	if err := json.Unmarshal([]byte(storedLocalModelsSnapshotJSON), &snapshot); err != nil {
		t.Fatal(err)
	}
	minBytes := int64(4_000_000_000)
	degraded, forced := true, true
	retries := 2
	kv := teamhubinternal.LocalModelKvQuantQ80
	reason := teamhubinternal.LocalModelDegradationReasonReducedContext
	snapshot.Models[0].MinimumMemoryBytes = &minBytes
	snapshot.Models[0].Degraded = &degraded
	snapshot.Models[0].RequestedPosture = &teamhubinternal.LocalModelPosture{ContextTokens: 65536, Slots: 2}
	snapshot.Models[0].EffectivePosture = &teamhubinternal.LocalModelPosture{ContextTokens: 32768, Slots: 1, KvCacheQuant: &kv}
	snapshot.Models[0].DegradationReason = &reason
	pressurePool := teamhubinternal.LocalModelPoolId("unified")
	pressureFree := int64(1_000_000_000)
	pressureBudget := int64(8_000_000_000)
	snapshot.Models[0].MemoryPressureWarning = &teamhubinternal.LocalModelPressureWarning{
		Level: teamhubinternal.LocalModelPressureWarningLevelSoft, Pool: &pressurePool, FreeBytes: &pressureFree, BudgetBytes: &pressureBudget,
	}
	snapshot.Models[0].OomRetries = &retries
	snapshot.Models[0].Forced = &forced
	if !validLocalModelsSnapshot(snapshot) {
		t.Fatal("valid elastic admission snapshot was rejected")
	}

	// Unknown future enums and invalid values are sanitized forward-compatibly.
	badMin := int64(-10)
	badReason := teamhubinternal.LocalModelDegradationReason("future_reason")
	badKV := teamhubinternal.LocalModelKvQuant("fp8")
	badLevel := teamhubinternal.LocalModelPressureWarningLevel("critical")
	badRetries := -1
	snapshot.Models[0].MinimumMemoryBytes = &badMin
	snapshot.Models[0].DegradationReason = &badReason
	snapshot.Models[0].EffectivePosture.KvCacheQuant = &badKV
	snapshot.Models[0].MemoryPressureWarning.Level = badLevel
	snapshot.Models[0].OomRetries = &badRetries
	sanitizeLocalModelsSnapshot(&snapshot)
	if !validLocalModelsSnapshot(snapshot) {
		t.Fatal("sanitized elastic admission snapshot was rejected")
	}
	if snapshot.Models[0].MinimumMemoryBytes != nil || snapshot.Models[0].DegradationReason != nil ||
		snapshot.Models[0].EffectivePosture.KvCacheQuant != nil || snapshot.Models[0].MemoryPressureWarning != nil ||
		snapshot.Models[0].OomRetries != nil {
		t.Fatalf("unexpected remaining invalid elastic fields: %+v", snapshot.Models[0])
	}
}
