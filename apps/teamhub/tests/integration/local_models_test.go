package integration_test

import (
	"bufio"
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

const localModelsLibraryPiModel = "localmodels-library/localmodels-lib-qwen3-8-27b-iq3s-ud-iq3-s/Qwen3.8-27B-UD-IQ3_S"

type localModelsComputers struct {
	recordingLocalComputers
	mu       sync.Mutex
	commands []roomagent.LocalModelActionCommand
	refusal  *roomagent.LocalModelActionRefusal
	err      error
}

func (c *localModelsComputers) ActOnLocalModels(_ context.Context, command roomagent.LocalModelActionCommand) (*roomagent.LocalModelActionRefusal, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.commands = append(c.commands, command)
	return c.refusal, c.err
}

// TestLocalComputerModelsStoreServeAndAct covers what needs PostgreSQL: the
// stored snapshot and its kept host, the invalidation committed with it, the
// used_by visibility rule, owner-only actions, and deletion with the Computer.
func TestLocalComputerModelsStoreServeAndAct(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	computers := &localModelsComputers{}
	application, err := newTestApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.SSEHeartbeatInterval = 5 * time.Second
		c.SSEQueueCapacity = 8
		c.ArtifactStorageRoot = t.TempDir()
	}), withLocalComputers(computers))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)
	const computerID = "computer_models"
	base := "/v0/tenants/" + acmeTenant + "/local-computers/" + computerID + "/local-models"

	if _, err := pool.Exec(t.Context(), `
INSERT INTO local_computers(computer_id,display_name,status,owner_tenant_id,owner_actor_id,last_seen_at)
VALUES ($1,'Studio','online','tenant_acme','actor_acme_alice',now()-interval '5 seconds')`, computerID); err != nil {
		t.Fatal(err)
	}
	// Bob sees Alice's workspace Agent but not her sponsor-only one; a codex
	// Agent with the same model id never uses a local model.
	if _, err := pool.Exec(t.Context(), `
INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES
  ('actor_models_shared','tenant_acme','agent','Shared Pi','models_shared'),
  ('actor_models_private','tenant_acme','agent','Private Pi','models_private'),
  ('actor_models_codex','tenant_acme','agent','Codex','models_codex');
INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
  computer_id,local_runtime_type,workspace_grant_id,created_by_actor_id,visibility_scope) VALUES
  ('actor_models_shared','tenant_acme','agent_models_shared','active','Run','`+localModelsLibraryPiModel+`','computer_models','pi','grant_linger','actor_acme_alice','workspace'),
  ('actor_models_private','tenant_acme','agent_models_private','active','Run','`+localModelsLibraryPiModel+`','computer_models','pi','grant_linger','actor_acme_alice','sponsor'),
  ('actor_models_codex','tenant_acme','agent_models_codex','active','Run','`+localModelsLibraryPiModel+`','computer_models','codex','grant_linger','actor_acme_alice','workspace');
`); err != nil {
		t.Fatal(err)
	}

	var view struct {
		Computer struct {
			Status string `json:"status"`
			Host   *struct {
				OsLabel string `json:"os_label"`
			} `json:"host"`
		} `json:"computer"`
		ViewerIsOwner bool `json:"viewer_is_owner"`
		Available     bool `json:"available"`
		Reason        *struct {
			Code string `json:"code"`
		} `json:"reason"`
		Models []struct {
			Model struct {
				ID string `json:"id"`
			} `json:"model"`
			UsedBy []struct {
				AgentID string `json:"agent_id"`
			} `json:"used_by"`
		} `json:"models"`
	}
	read := func(client *http.Client) {
		t.Helper()
		status, _, body := env.request(client, http.MethodGet, base, nil, "")
		if status != http.StatusOK {
			t.Fatalf("read Local models status=%d body=%s", status, body)
		}
		view.Computer.Host, view.Reason, view.Models = nil, nil, nil
		decode(t, body, &view)
	}
	read(alice)
	if !view.ViewerIsOwner || view.Available || view.Reason == nil || view.Reason.Code != "NOT_REPORTED" || view.Computer.Status != "online" {
		t.Fatalf("a Computer that never reported: %+v", view)
	}

	stream := openSSE(t, alice, server.URL+"/v0/events", 10*time.Second)
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	requireSSEReady(t, "alice", reader)
	record := func(snapshot map[string]any) {
		t.Helper()
		status, body := agentRuntimeStateRequest(t, server.Config.Handler, http.MethodPost,
			"/v0/agent-runtime/local-computers/local-models", teamHubInternalToken,
			map[string]any{"computer_id": computerID, "snapshot": snapshot})
		if status != http.StatusNoContent {
			t.Fatalf("record Local models status=%d body=%s", status, body)
		}
		awaitInvalidation(t, reader, "local-models", computerID)
	}
	record(map[string]any{
		"available": true, "observed_at": time.Now().UTC(), "tool_version": "2.0.0",
		"host": map[string]any{"platform": "linux", "arch": "x86_64", "os_label": "Ubuntu 24.04", "engine_label": "llama.cpp",
			"ram_total_bytes": 64 << 30, "disk_free_bytes": 100 << 30, "gpus": []any{}},
		"pools": []any{map[string]any{"id": "gpu:0", "kind": "gpu", "gpu_index": 0, "total_bytes": 24 << 30, "used_bytes": 8 << 30, "holders": []any{}}},
		"models": []any{map[string]any{
			"id": "qwen3.8-27b:IQ3_S", "name": "Qwen3.8 27B", "description": "", "quant": "IQ3_S", "context_tokens": 32768,
			"vision": false, "download_bytes": 12 << 30, "memory_bytes": 14 << 30, "fit": "gpu", "recommended": false,
			// An idle model keeps its pi_model, so its Agents stay listed.
			"availability": map[string]any{"downloadable": true}, "pool": "gpu:0", "state": "idle",
			"pi_model": localModelsLibraryPiModel,
		}},
	})
	read(alice)
	if !view.Available || len(view.Models) != 1 || len(view.Models[0].UsedBy) != 2 || view.Computer.Host == nil {
		t.Fatalf("owner view: %+v", view)
	}
	read(bob)
	if view.ViewerIsOwner || len(view.Models) != 1 || len(view.Models[0].UsedBy) != 1 || view.Models[0].UsedBy[0].AgentID != "agent_models_shared" {
		t.Fatalf("member view: %+v", view)
	}

	// An unavailable library carries no host; the Computer keeps the last one.
	record(map[string]any{"available": false, "reason": map[string]any{"code": "TOOL_FAILED"}, "observed_at": time.Now().UTC(), "pools": []any{}, "models": []any{}})
	read(alice)
	if view.Available || view.Reason == nil || view.Reason.Code != "TOOL_FAILED" || len(view.Models) != 0 ||
		view.Computer.Host == nil || view.Computer.Host.OsLabel != "Ubuntu 24.04" {
		t.Fatalf("unavailable view: %+v", view)
	}

	act := func(client *http.Client, body map[string]any) (int, []byte) {
		t.Helper()
		status, _, response := env.request(client, http.MethodPost, base+"/qwen3.8-27b:IQ3_S/actions", body, "")
		return status, response
	}
	if status, body := act(bob, map[string]any{"action": "unload"}); status != http.StatusForbidden || !containsJSONText(body, "LOCAL_MODEL_ACTION_FORBIDDEN") {
		t.Fatalf("member action status=%d body=%s", status, body)
	}
	if status, body := act(alice, map[string]any{"action": "load", "unload_first": []string{"gemma-3:Q4"}}); status != http.StatusAccepted ||
		!containsJSONText(body, `"action":"load"`) {
		t.Fatalf("owner action status=%d body=%s", status, body)
	}
	if len(computers.commands) != 1 || computers.commands[0].OwnerActorID != "actor_acme_alice" || computers.commands[0].ModelID != "qwen3.8-27b:IQ3_S" ||
		len(computers.commands[0].UnloadFirst) != 1 || computers.commands[0].RequestID == "" {
		t.Fatalf("forwarded commands=%+v", computers.commands)
	}
	computers.refusal = &roomagent.LocalModelActionRefusal{Code: "LOAD_NO_ROOM", Pool: "gpu:0"}
	if status, body := act(alice, map[string]any{"action": "load"}); status != http.StatusConflict || !containsJSONText(body, "LOCAL_MODEL_NO_ROOM") {
		t.Fatalf("refused action status=%d body=%s", status, body)
	}
	computers.refusal = &roomagent.LocalModelActionRefusal{Code: "CHECKSUM_MISMATCH"}
	if status, body := act(alice, map[string]any{"action": "download"}); status != http.StatusBadGateway || !containsJSONText(body, "LOCAL_MODEL_ACTION_FAILED") {
		t.Fatalf("failed action status=%d body=%s", status, body)
	}
	// A connected Computer that had not decided in time is not offline.
	computers.refusal, computers.err = nil, roomagent.ErrLocalModelsTimeout
	if status, body := act(alice, map[string]any{"action": "load"}); status != http.StatusGatewayTimeout || !containsJSONText(body, "LOCAL_MODEL_ACTION_UNCONFIRMED") {
		t.Fatalf("unconfirmed action status=%d body=%s", status, body)
	}
	computers.err = nil
	if _, err := pool.Exec(t.Context(), `UPDATE local_computers SET last_seen_at=now()-interval '2 minutes' WHERE computer_id=$1`, computerID); err != nil {
		t.Fatal(err)
	}
	if status, body := act(alice, map[string]any{"action": "unload"}); status != http.StatusServiceUnavailable || !containsJSONText(body, "LOCAL_COMPUTER_OFFLINE") {
		t.Fatalf("offline action status=%d body=%s", status, body)
	}
	if len(computers.commands) != 4 {
		t.Fatalf("an offline Computer was sent an action: %d commands", len(computers.commands))
	}

	if _, err := pool.Exec(t.Context(), `UPDATE agent_registrations SET status='revoked' WHERE computer_id=$1`, computerID); err != nil {
		t.Fatal(err)
	}
	status, body := agentRuntimeStateRequest(t, server.Config.Handler, http.MethodPost, "/v0/agent-runtime/local-computers/remove", teamHubInternalToken,
		map[string]any{"computer_id": computerID, "owner": map[string]any{"tenant_id": acmeTenant, "owner_actor_id": "actor_acme_alice"}})
	if status != http.StatusOK || !containsJSONText(body, `"removed"`) {
		t.Fatalf("remove Computer status=%d body=%s", status, body)
	}
	var snapshots int
	if err := pool.QueryRow(t.Context(), `SELECT count(*) FROM local_computer_model_snapshots WHERE computer_id=$1`, computerID).Scan(&snapshots); err != nil || snapshots != 0 {
		t.Fatalf("snapshot outlived its Computer: rows=%d err=%v", snapshots, err)
	}
	if status, _, body := env.request(alice, http.MethodGet, base, nil, ""); status != http.StatusNotFound {
		t.Fatalf("removed Computer models status=%d body=%s", status, body)
	}
}
