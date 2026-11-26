package integration_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const modelSourceTestAPIKey = "sk-model-source-never-stored"

type modelSourceComputers struct {
	recordingLocalComputers
	mu      sync.Mutex
	applied []nodeservicesinternal.ModelSourceApplyCommand
	tested  []nodeservicesinternal.ByokTestRequest
	status  nodeservicesinternal.ModelSourceStatus
	// duringApply runs while the Computer switches, before TeamHub moves
	// the Agents.
	duringApply    func()
	duringApplyCtx func(context.Context)
}

func (c *modelSourceComputers) LocalComputerModelSource(_ context.Context, _ roomagent.ModelSourceTarget) (nodeservicesinternal.ModelSourceStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status, nil
}

func (c *modelSourceComputers) ApplyLocalComputerModelSource(ctx context.Context, _ roomagent.ModelSourceTarget, command nodeservicesinternal.ModelSourceApplyCommand) (nodeservicesinternal.ModelSourceStatus, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.applied = append(c.applied, command)
	if c.duringApply != nil {
		c.duringApply()
	}
	if c.duringApplyCtx != nil {
		c.duringApplyCtx(ctx)
	}
	return c.status, nil
}

func (c *modelSourceComputers) TestLocalComputerByok(_ context.Context, _ roomagent.ModelSourceTarget, request nodeservicesinternal.ByokTestRequest) (nodeservicesinternal.ByokTestResult, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.tested = append(c.tested, request)
	input := request.Byok
	if input.ApiKey == nil || *input.ApiKey != modelSourceTestAPIKey {
		return nodeservicesinternal.ByokTestResult{}, &roomagent.ModelSourceError{Code: "BYOK_AUTH_FAILED",
			Message: input.BaseUrl + input.Path + input.Endpoint + " rejected the API key (HTTP 401)."}
	}
	return nodeservicesinternal.ByokTestResult{Ok: true, Protocol: input.Protocol, Url: input.BaseUrl + input.Path + input.Endpoint, ModelId: input.ModelId, ContextWindow: 200000}, nil
}

func (c *modelSourceComputers) ListLocalComputerByokModels(_ context.Context, _ roomagent.ModelSourceTarget, endpoint nodeservicesinternal.ByokEndpointInput) (nodeservicesinternal.ByokModelList, error) {
	if endpoint.ApiKey == nil || *endpoint.ApiKey != modelSourceTestAPIKey {
		return nodeservicesinternal.ByokModelList{}, &roomagent.ModelSourceError{Code: "BYOK_AUTH_FAILED"}
	}
	window := 131072
	return nodeservicesinternal.ByokModelList{Url: endpoint.BaseUrl + endpoint.Path + "/models", Models: []nodeservicesinternal.ByokModel{{Id: "vendor/model", ContextWindow: &window}}}, nil
}

func (c *modelSourceComputers) appliedSnapshot() []nodeservicesinternal.ModelSourceApplyCommand {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]nodeservicesinternal.ModelSourceApplyCommand(nil), c.applied...)
}

type runStoppingAgentManagement struct {
	*recordingAgentManagement
	mu      sync.Mutex
	stopped []roomagent.RunCancelCommand
}

func (m *runStoppingAgentManagement) CancelRun(_ context.Context, command roomagent.RunCancelCommand) (roomagent.RunCancelResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = append(m.stopped, command)
	return roomagent.RunCancelResult{RunID: command.RunID, Status: "already_terminal"}, nil
}

func newModelSourceEnv(t *testing.T, management roomagent.AgentManagement, computers *modelSourceComputers) (*testEnv, *http.Client) {
	t.Helper()
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	seedReadyFixtureComputers(t, pool)
	artifactRoot := integrationArtifactRoot(t)
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.RoomDocument.RuntimeURL = "http://document-runtime.test"
		c.ArtifactStorageRoot = artifactRoot
	}), withAgentManagement(management), withLocalComputers(computers))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server, artifactRoot: artifactRoot}
	return env, env.login("alice", alicePassword)
}

// TestLocalComputerModelSourceSwitchMovesAgentsAndEndsChosenWork covers what
// needs PostgreSQL: the owner-only view, the refusal while an Agent works, and
// the forced switch that ends the work and moves every Agent on the Computer
// in one transaction, without TeamHub keeping the API key.
func TestLocalComputerModelSourceSwitchMovesAgentsAndEndsChosenWork(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &runStoppingAgentManagement{recordingAgentManagement: &recordingAgentManagement{}}
	effort := "high"
	computers := &modelSourceComputers{status: nodeservicesinternal.ModelSourceStatus{
		Mode: "byok", Runtime: "claude", RuntimeModel: "localmodels-byok", ReasoningEffort: &effort,
		Byok: nodeservicesinternal.ByokSummary{Configured: true, KeySaved: true},
	}}
	env, alice := newModelSourceEnv(t, management, computers)
	bob := seedPeerHuman(t, env)
	base := "/v0/tenants/" + acmeTenant + "/local-computers/" + fixtureComputerID + "/model-source"

	agents := map[string]tenantAgentUpdateView{}
	for _, name := range []string{"Worker", "Idler"} {
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": name, "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "model-source-create-"+name)
		if status != http.StatusCreated {
			t.Fatalf("create %s: %d %s", name, status, body)
		}
		var created tenantAgentUpdateView
		decode(t, body, &created)
		agents[name] = created
	}

	status, _, body := env.request(alice, http.MethodGet, base, nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"viewer_is_owner":true`) || !containsJSONText(body, `"mode":"byok"`) {
		t.Fatalf("owner view: %d %s", status, body)
	}
	status, _, body = env.request(bob, http.MethodGet, base, nil, "")
	if status != http.StatusOK || !containsJSONText(body, `"viewer_is_owner":false`) || containsJSONText(body, `"status"`) {
		t.Fatalf("member view: %d %s", status, body)
	}
	byokSwitch := map[string]any{"mode": "byok", "runtime": "claude", "byok": map[string]any{
		"base_url": "https://api.example.com", "path": "/api/v3", "endpoint": "/messages", "protocol": "anthropic",
		"api_key": modelSourceTestAPIKey, "model_id": "vendor/model",
	}}
	status, _, body = env.request(bob, http.MethodPost, base, byokSwitch, "")
	if status != http.StatusForbidden || !containsJSONText(body, "MODEL_SOURCE_FORBIDDEN") {
		t.Fatalf("member switch: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, base, map[string]any{"mode": "subscription", "runtime": "pi"}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("subscription on pi: %d %s", status, body)
	}

	status, _, body = env.request(alice, http.MethodPost, base+"/test", map[string]any{"byok": byokSwitch["byok"]}, "")
	if status != http.StatusOK || !containsJSONText(body, `"context_window":200000`) ||
		!containsJSONText(body, `"url":"https://api.example.com/api/v3/messages"`) || containsJSONText(body, modelSourceTestAPIKey) {
		t.Fatalf("BYOK test: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, base+"/test", byokSwitch["byok"], "")
	if status != http.StatusBadRequest {
		t.Fatalf("BYOK test without its envelope: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, base+"/test", map[string]any{"byok": map[string]any{"base_url": "https://api.example.com", "path": "v1", "endpoint": "/messages", "protocol": "anthropic", "model_id": "vendor/model"}}, "")
	if status != http.StatusBadRequest {
		t.Fatalf("BYOK test with a path that is not a path: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, base+"/test", map[string]any{"byok": map[string]any{"base_url": "https://api.example.com", "path": "/v1", "endpoint": "/messages", "protocol": "anthropic", "api_key": "wrong", "model_id": "vendor/model"}}, "")
	if status != http.StatusConflict || !containsJSONText(body, "BYOK_AUTH_FAILED") ||
		!containsJSONText(body, "https://api.example.com/v1/messages rejected the API key (HTTP 401).") {
		t.Fatalf("BYOK test with a wrong key: %d %s", status, body)
	}
	status, _, body = env.request(alice, http.MethodPost, base+"/models", map[string]any{"base_url": "https://api.example.com", "path": "/v1", "endpoint": "/chat/completions", "protocol": "openai-chat", "api_key": modelSourceTestAPIKey}, "")
	if status != http.StatusOK || !containsJSONText(body, `"context_window":131072`) || containsJSONText(body, modelSourceTestAPIKey) {
		t.Fatalf("BYOK models: %d %s", status, body)
	}
	status, _, body = env.request(bob, http.MethodPost, base+"/models", map[string]any{"base_url": "https://api.example.com", "path": "/v1", "endpoint": "/chat/completions", "protocol": "openai-chat", "api_key": modelSourceTestAPIKey}, "")
	if status != http.StatusForbidden {
		t.Fatalf("member BYOK models: %d %s", status, body)
	}

	const roomID = "room_model_source_worker"
	worker := agents["Worker"]
	insertRuntimeRoomMembershipForAgent(t, env.pool, roomID, worker.Actor.ID)
	ensured, err := agentruntimestate.New(env.pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: worker.AgentManagementID, RoomID: roomID}, TargetResidency: "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at) VALUES('model-source-run',$1,'running',clock_timestamp())`, ensured.Context.ContextKey); err != nil {
		t.Fatal(err)
	}

	// Running work refuses the switch before the Computer changes.
	status, _, body = env.request(alice, http.MethodPost, base, byokSwitch, "")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_HAS_ACTIVE_RUNS") || !containsJSONText(body, `"reason":"Worker"`) ||
		containsJSONText(body, "Idler") || len(computers.appliedSnapshot()) != 0 {
		t.Fatalf("busy switch: %d %s applied=%d", status, body, len(computers.appliedSnapshot()))
	}

	forced := map[string]any{"mode": "byok", "runtime": "claude", "byok": byokSwitch["byok"], "force_terminate": true}
	status, _, body = env.request(alice, http.MethodPost, base, forced, "")
	if status != http.StatusOK || !containsJSONText(body, `"terminated_run_count":1`) || containsJSONText(body, modelSourceTestAPIKey) {
		t.Fatalf("forced switch: %d %s", status, body)
	}
	applied := computers.appliedSnapshot()
	if len(applied) != 1 || applied[0].Byok == nil || applied[0].Byok.ApiKey == nil || *applied[0].Byok.ApiKey != modelSourceTestAPIKey {
		t.Fatalf("command sent to the Computer: %+v", applied)
	}
	var runStatus, runReason string
	if err := env.pool.QueryRow(t.Context(), `SELECT status,terminal->>'reason' FROM agent_local_runs WHERE run_id='model-source-run'`).Scan(&runStatus, &runReason); err != nil {
		t.Fatal(err)
	}
	if runStatus != "canceled" || runReason != "model_source_switched" {
		t.Fatalf("ended run: %s/%s", runStatus, runReason)
	}
	for name, agent := range agents {
		if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND computer_id=$2 AND local_runtime_type='claude'
			AND runtime_model='localmodels-byok' AND runtime_reasoning_effort='high' AND configuration_revision=2`, agent.Actor.ID, fixtureComputerID) != 1 {
			t.Fatalf("%s was not moved to the Computer's new Runtime", name)
		}
	}
	notified := strings.Join(management.notifiedSnapshot(), ",")
	if !strings.Contains(notified, worker.AgentManagementID) || !strings.Contains(notified, agents["Idler"].AgentManagementID) {
		t.Fatalf("Agent Service notifications: %s", notified)
	}
	management.mu.Lock()
	stopped := append([]roomagent.RunCancelCommand(nil), management.stopped...)
	management.mu.Unlock()
	if len(stopped) != 1 || stopped[0].RunID != "model-source-run" || stopped[0].AgentID != worker.AgentManagementID || stopped[0].RoomID != roomID {
		t.Fatalf("live process stops: %+v", stopped)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE description LIKE '%'||$1||'%' OR instructions LIKE '%'||$1||'%'`, modelSourceTestAPIKey) != 0 {
		t.Fatal("TeamHub stored the API key")
	}

	// A repeated switch to the same target leaves the Agents alone.
	status, _, body = env.request(alice, http.MethodPost, base, byokSwitch, "")
	if status != http.StatusOK || !containsJSONText(body, `"updated_agent_count":0`) {
		t.Fatalf("repeated switch: %d %s", status, body)
	}
}

// TestLocalComputerModelSourceWorkStartedDuringSwitchKeepsOnlyItsAgent covers
// work that starts after the busy check while the Computer switches: the
// Computer has changed, so the idle Agent moves and only the working one waits
// for the owner, whose forced retry moves it too.
func TestLocalComputerModelSourceWorkStartedDuringSwitchKeepsOnlyItsAgent(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &runStoppingAgentManagement{recordingAgentManagement: &recordingAgentManagement{}}
	computers := &modelSourceComputers{status: nodeservicesinternal.ModelSourceStatus{
		Mode: "subscription", Runtime: "claude", RuntimeModel: "claude-default",
	}}
	env, alice := newModelSourceEnv(t, management, computers)
	base := "/v0/tenants/" + acmeTenant + "/local-computers/" + fixtureComputerID + "/model-source"

	agents := map[string]tenantAgentUpdateView{}
	for _, name := range []string{"Worker", "Idler"} {
		status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": name, "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "late-work-create-"+name)
		if status != http.StatusCreated {
			t.Fatalf("create %s: %d %s", name, status, body)
		}
		var created tenantAgentUpdateView
		decode(t, body, &created)
		agents[name] = created
	}
	const roomID = "room_model_source_late_worker"
	worker := agents["Worker"]
	insertRuntimeRoomMembershipForAgent(t, env.pool, roomID, worker.Actor.ID)
	ensured, err := agentruntimestate.New(env.pool).EnsureContext(t.Context(), agentruntimestate.EnsureContextInput{
		Ref: agentruntimestate.ContextRef{Kind: "meta", AgentID: worker.AgentManagementID, RoomID: roomID}, TargetResidency: "active",
	})
	if err != nil {
		t.Fatal(err)
	}
	computers.duringApply = func() {
		computers.duringApply = nil
		if _, err := env.pool.Exec(context.Background(), `INSERT INTO agent_local_runs(run_id,context_key,status,started_at) VALUES('model-source-late-run',$1,'running',clock_timestamp())`, ensured.Context.ContextKey); err != nil {
			t.Error(err)
		}
	}
	moved := func(agent tenantAgentUpdateView) bool {
		return countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND local_runtime_type='claude' AND runtime_model='claude-default'`, agent.Actor.ID) == 1
	}

	subscription := map[string]any{"mode": "subscription", "runtime": "claude"}
	status, _, body := env.request(alice, http.MethodPost, base, subscription, "")
	if status != http.StatusConflict || !containsJSONText(body, "AGENT_HAS_ACTIVE_RUNS") || !containsJSONText(body, `"reason":"Worker"`) || containsJSONText(body, "Idler") {
		t.Fatalf("switch with late work: %d %s", status, body)
	}
	if !moved(agents["Idler"]) || moved(worker) {
		t.Fatalf("after late work: Idler moved=%v, Worker moved=%v", moved(agents["Idler"]), moved(worker))
	}

	status, _, body = env.request(alice, http.MethodPost, base, map[string]any{"mode": "subscription", "runtime": "claude", "force_terminate": true}, "")
	if status != http.StatusOK || !containsJSONText(body, `"terminated_run_count":1`) || !containsJSONText(body, `"updated_agent_count":1`) {
		t.Fatalf("forced retry: %d %s", status, body)
	}
	if !moved(worker) {
		t.Fatal("the forced retry did not move Worker")
	}
}

// TestLocalComputerModelSourceDetachesFromClientCancelAndRejectsInvalidStatus
// verifies that a client disconnecting mid-apply does not cancel the in-flight
// switch or its Agent reconciliation, and that an invalid returned mode or
// empty runtime_model is rejected before Agents move.
func TestLocalComputerModelSourceDetachesFromClientCancelAndRejectsInvalidStatus(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &runStoppingAgentManagement{recordingAgentManagement: &recordingAgentManagement{}}
	localModel := "localmodels-library/localmodels-lib-qwen3-8-27b/Qwen3.8-27B-UD-Q4_K_M"
	computers := &modelSourceComputers{status: nodeservicesinternal.ModelSourceStatus{
		Mode: "byok", Runtime: "pi", RuntimeModel: "localmodels/localmodels-byok",
	}}
	env, alice := newModelSourceEnv(t, management, computers)
	base := "/v0/tenants/" + acmeTenant + "/local-computers/" + fixtureComputerID + "/model-source"

	status, _, body := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/agents", map[string]any{"name": "SwitchAgent", "instructions": "Keep work", "runtime": fixtureRuntime("codex-default")}, "detach-create-agent")
	if status != http.StatusCreated {
		t.Fatalf("create agent: %d %s", status, body)
	}
	var agent tenantAgentUpdateView
	decode(t, body, &agent)

	// 1. Mismatched mode or empty runtime_model returns MODEL_SOURCE_FAILED (502)
	// and leaves the Agent untouched.
	for _, invalidStatus := range []nodeservicesinternal.ModelSourceStatus{
		{Mode: "byok", Runtime: "pi", RuntimeModel: "localmodels/localmodels-byok"},
		{Mode: "local", Runtime: "pi", RuntimeModel: ""},
	} {
		computers.status = invalidStatus
		status, _, body = env.request(alice, http.MethodPost, base, map[string]any{"mode": "local", "runtime": "pi"}, "")
		if status != http.StatusBadGateway || !containsJSONText(body, "MODEL_SOURCE_FAILED") {
			t.Fatalf("invalid status %+v -> %d %s", invalidStatus, status, body)
		}
		if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND local_runtime_type='codex' AND runtime_model='codex-default'`, agent.Actor.ID) != 1 {
			t.Fatalf("agent moved despite invalid status %+v", invalidStatus)
		}
	}

	// 2. Client canceling mid-apply still finishes Apply and moves the Agent.
	computers.status = nodeservicesinternal.ModelSourceStatus{
		Mode: "local", Runtime: "pi", RuntimeModel: localModel,
	}
	reqCtx, cancelReq := context.WithCancel(t.Context())
	defer cancelReq()
	applyCtxErrCh := make(chan error, 1)
	computers.duringApplyCtx = func(ctx context.Context) {
		cancelReq()
		time.Sleep(50 * time.Millisecond)
		applyCtxErrCh <- ctx.Err()
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, env.server.URL+base, strings.NewReader(`{"mode":"local","runtime":"pi"}`))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if resp, err := alice.Do(req); err == nil {
		_ = resp.Body.Close()
	}
	if applyCtxErr := <-applyCtxErrCh; applyCtxErr != nil {
		t.Fatalf("apply context was canceled with client disconnect: %v", applyCtxErr)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND local_runtime_type='pi' AND runtime_model=$2`, agent.Actor.ID, localModel) == 1 {
			break
		}
		time.Sleep(25 * time.Millisecond)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND local_runtime_type='pi' AND runtime_model=$2`, agent.Actor.ID, localModel) != 1 {
		t.Fatal("agent was not reconciled after client disconnected mid-switch")
	}
}

// TestLocalComputerModelSourceByokReapplyClearsAnotherMeBackgroundFailures
// proves that re-applying the same BYOK (runtime, model, effort) still clears
// another_me_background_failures and emits the another-me invalidation hint
// without bumping ConfigurationRevision.
func TestLocalComputerModelSourceByokReapplyClearsAnotherMeBackgroundFailures(t *testing.T) {
	allowParallelIntegrationTest(t)
	management := &runStoppingAgentManagement{recordingAgentManagement: &recordingAgentManagement{}}
	effort := "high"
	computers := &modelSourceComputers{status: nodeservicesinternal.ModelSourceStatus{
		Mode: "byok", Runtime: "claude", RuntimeModel: "localmodels-byok", ReasoningEffort: &effort,
		Byok: nodeservicesinternal.ByokSummary{Configured: true, KeySaved: true},
	}}
	env, alice := newModelSourceEnv(t, management, computers)
	base := "/v0/tenants/" + acmeTenant + "/local-computers/" + fixtureComputerID + "/model-source"

	const anotherMeID = "actor_byok_reapply_anotherme"
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES($1,$2,'agent','Alice Another Me','@byok-reapply-anotherme')`, anotherMeID, acmeTenant); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_registrations(
		actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,runtime_reasoning_effort,
		created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,computer_id,local_runtime_type,workspace_grant_id,configuration_revision
	) VALUES($1,$2,'management-byok-reapply-anotherme','active','Background','Work safely','localmodels-byok','high','actor_acme_alice','sponsor','anotherme','actor_acme_alice',$3,'claude','grant_files',1)`,
		anotherMeID, acmeTenant, fixtureComputerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO another_me_background_failures(agent_actor_id,tenant_id,consecutive_failures,reason,last_failed_at) VALUES($1,$2,3,'runtime_unavailable',now())`, anotherMeID, acmeTenant); err != nil {
		t.Fatal(err)
	}

	hints := listenTenantHints(t, env.pool)
	const anotherMeHint = realtime.InvalidationKindPrefix + realtime.InvalidateAnotherMe

	byokReapply := map[string]any{
		"mode":    "byok",
		"runtime": "claude",
		"byok": map[string]any{
			"base_url": "https://api.example.com",
			"path":     "/api/v3",
			"endpoint": "/messages",
			"protocol": "anthropic",
			"api_key":  modelSourceTestAPIKey,
			"model_id": "vendor/model",
		},
	}
	status, _, body := env.request(alice, http.MethodPost, base, byokReapply, "")
	if status != http.StatusOK || !containsJSONText(body, `"updated_agent_count":0`) {
		t.Fatalf("BYOK reapply: %d %s", status, body)
	}
	if countRows(t, env, `SELECT count(*) FROM agent_registrations WHERE actor_id=$1 AND configuration_revision=1`, anotherMeID) != 1 {
		t.Fatal("BYOK reapply unexpectedly bumped configuration_revision")
	}
	if got := countRows(t, env, `SELECT count(*) FROM another_me_background_failures WHERE agent_actor_id=$1`, anotherMeID); got != 0 {
		t.Fatalf("another_me_background_failures count = %d, want 0", got)
	}
	if got := hints()[anotherMeHint]; got != 1 {
		t.Fatalf("another-me invalidation hints = %d, want 1", got)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/another-me", nil, "")
	if status != http.StatusOK {
		t.Fatalf("GET another-me: %d %s", status, body)
	}
	var anotherMe httpapi.AnotherMe
	decode(t, body, &anotherMe)
	if anotherMe.BackgroundFailure != nil {
		t.Fatalf("Another Me still shows background failure after BYOK reapply: %+v", anotherMe.BackgroundFailure)
	}
}
