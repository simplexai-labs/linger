package integration_test

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
)

type recordingLocalComputers struct {
	mu             sync.Mutex
	removals       [][3]string
	removeConflict bool
}

func (r *recordingLocalComputers) RemoveLocalComputer(_ context.Context, tenantID, ownerActorID, computerID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removals = append(r.removals, [3]string{tenantID, ownerActorID, computerID})
	if r.removeConflict {
		return roomagent.ErrLocalComputerHasAgents
	}
	return nil
}

func (r *recordingLocalComputers) ScanLocalSkills(_ context.Context, _ roomagent.LocalSkillScanCommand) (roomagent.LocalSkillScan, error) {
	return roomagent.LocalSkillScan{}, roomagent.ErrLocalSkillCapabilityUnavailable
}

func (r *recordingLocalComputers) ConnectLocalBrowser(_ context.Context, _ roomagent.LocalBrowserConnectionCommand) (roomagent.LocalBrowserConnectionStatus, error) {
	return roomagent.LocalBrowserConnectionStatus{}, roomagent.ErrLocalBrowserUnsupported
}

func (r *recordingLocalComputers) LocalComputerPermissions(_ context.Context, _ roomagent.LocalComputerPermissionCommand) (roomagent.LocalComputerPermissionStatus, error) {
	return roomagent.LocalComputerPermissionStatus{}, roomagent.ErrLocalComputerPermissionsUnsupported
}

func (r *recordingLocalComputers) ActOnLocalModels(_ context.Context, _ roomagent.LocalModelActionCommand) (*roomagent.LocalModelActionRefusal, error) {
	return nil, roomagent.ErrLocalModelsUnsupported
}

func TestTenantAgentAvailabilityProjectsUnknownWhenRuntimeStatusIsMissing(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	localComputers := &recordingLocalComputers{}
	application, err := newIntegrationApp(context.Background(), config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
	}), withLocalComputers(localComputers))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	if _, err := pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES ('actor_local_status','tenant_acme','agent','Local Status','local_status');
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,
			computer_id,local_runtime_type,workspace_grant_id,created_by_actor_id
		) VALUES (
			'actor_local_status','tenant_acme','agent-management-local-status','active','Runs on Alice Mac','Run locally','model-local',
			'computer_owner_mac','codex','grant_linger','actor_acme_alice'
		);
	`); err != nil {
		t.Fatal(err)
	}

	status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agents?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Local Agent status=%d body=%s", status, body)
	}
	var page struct {
		Items []tenantAgentUpdateView `json:"items"`
	}
	decode(t, body, &page)
	listed, ok := findTenantAgentUpdateView(page.Items, "actor_local_status")
	if !ok || listed.Runtime.Model != "model-local" {
		t.Fatalf("unexpected Local Agent directory projection: %+v", listed)
	}
	if containsJSONText(body, `"availability"`) || containsJSONText(body, `"local_runtime_status"`) {
		t.Fatalf("Agent directory leaked volatile availability: %s", body)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/agent-availability?limit=200", nil, "")
	if status != http.StatusOK {
		t.Fatalf("list Agent availability status=%d body=%s", status, body)
	}
	var availabilityPage struct {
		Items []struct {
			ActorID      string `json:"actor_id"`
			Availability struct {
				ActiveTaskCount int    `json:"active_task_count"`
				Status          string `json:"status"`
				CurrentActivity *struct {
					Summary string `json:"summary"`
				} `json:"current_activity"`
			} `json:"availability"`
		} `json:"items"`
	}
	decode(t, body, &availabilityPage)
	var availabilityFound bool
	for _, item := range availabilityPage.Items {
		if item.ActorID != "actor_local_status" {
			continue
		}
		availabilityFound = true
		// Missing connection observations must not invent an activity.
		if item.Availability.Status != "unknown" || item.Availability.ActiveTaskCount != 0 || item.Availability.CurrentActivity != nil {
			t.Fatalf("unexpected availability snapshot: %+v", item)
		}
	}
	if !availabilityFound {
		t.Fatalf("availability snapshot omitted Local Agent: %s", body)
	}
}

func TestAgentRuntimeLocalComputerCommitHintsEventsStream(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newTestApp(context.Background(), localComputerEnrollmentConfig(config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.SSEHeartbeatInterval = 5 * time.Second
		c.SSEQueueCapacity = 8
		c.ArtifactStorageRoot = t.TempDir()
	})))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	stream := openSSE(t, alice, server.URL+"/v0/events", 10*time.Second)
	defer stream.Body.Close()
	reader := bufio.NewReader(stream.Body)
	requireSSEReady(t, "alice", reader)

	enrollLocalComputerOverHTTP(t, env, alice, "Alice's Mac", "")
	if hint := awaitInvalidation(t, reader, "computers", acmeTenant); hint.TenantID != acmeTenant {
		t.Fatalf("Computer hint=%+v", hint)
	}
	awaitInvalidation(t, reader, "agents", acmeTenant)
}

// localComputerEnrollmentConfig turns enrollment on: TeamHub signs the
// Runner credential with this key for this Gateway.
func localComputerEnrollmentConfig(cfg config.Config) config.Config {
	cfg.RunnerGatewayURL = "wss://agent.example.test/v1/runner-gateway"
	cfg.RunnerSigningKey = "runner-signing-key-that-is-at-least-32-bytes"
	return cfg
}

func TestLocalComputerInventoryEnrollmentAndCLICredentialExchange(t *testing.T) {
	allowParallelIntegrationTest(t)
	artifactRoot := integrationArtifactRoot(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	localComputers := &recordingLocalComputers{}
	application, err := newIntegrationApp(context.Background(), localComputerEnrollmentConfig(config.ForTest(func(c *config.Config) {
		c.ArtifactStorageRoot = artifactRoot
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
	})), withLocalComputers(localComputers))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)

	// Pairing writes the enrollment and the Computer in TeamHub alone.
	computerID := enrollLocalComputerOverHTTP(t, env, alice, "Alice's Mac", "")
	status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/local-computers", nil, "")
	if status != http.StatusOK || containsJSONText(body, computerID) {
		t.Fatalf("a Computer without an observed owner grant is listed: status=%d body=%s", status, body)
	}
	// The Runner Gateway records the Computer's hello; TeamHub lists it from
	// that row, online or not.
	if _, err := pool.Exec(t.Context(), `
UPDATE local_computers
SET status='online',last_seen_at=$3,platform='darwin',daemon_version='0.40.0',recommended_version='0.41.0',
    active_operations=1,runtime_inventory='["claude"]',
    workspace_grants=jsonb_build_array(jsonb_build_object('grant_id','grant_linger','tenant_id',$2::text,'scope','owner','label','Linger','mode','workspace-write')),
    runtime_diagnostics=jsonb_build_array(jsonb_build_object('type','claude','status','ready','protocol','stream-json','checked_at',to_jsonb(now()),'version','1.2.3',
        'models',jsonb_build_array(jsonb_build_object('id','claude-sonnet','label','Claude Sonnet','allowed_reasoning_effort','[]'::jsonb))))
WHERE computer_id=$1`, computerID, acmeTenant, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/local-computers", nil, "")
	if status != http.StatusOK || !containsJSONText(body, computerID) || !containsJSONText(body, "claude-sonnet") ||
		!strings.Contains(string(body), `"platform":"darwin"`) || !strings.Contains(string(body), `"status":"online"`) ||
		!strings.Contains(string(body), `"daemon_version":"0.40.0"`) || !strings.Contains(string(body), `"active_operations":1`) {
		t.Fatalf("list Local Computers status=%d body=%s", status, body)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE local_computers SET status='offline',active_operations=0 WHERE computer_id=$1`, computerID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/local-computers", nil, "")
	if status != http.StatusOK || !strings.Contains(string(body), `"status":"offline"`) || !containsJSONText(body, "claude-sonnet") {
		t.Fatalf("an offline Computer keeps its Runtimes: status=%d body=%s", status, body)
	}

	status, _, _ = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/local-computers/"+computerID, nil, "")
	if status != http.StatusNoContent || len(localComputers.removals) != 1 || localComputers.removals[0] != [3]string{acmeTenant, "actor_acme_alice", computerID} {
		t.Fatalf("remove Local Computer status=%d removals=%v", status, localComputers.removals)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES ('actor_local_guard','tenant_acme','agent','Local Guard','local_guard');
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			computer_id,local_runtime_type,workspace_grant_id,created_by_actor_id
		) VALUES (
			'actor_local_guard','tenant_acme','agent-management-local-guard','active','Guard locally','model-local',
			'`+computerID+`','codex','grant_linger','actor_acme_alice'
		);
	`); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/local-computers/"+computerID, nil, "")
	if status != http.StatusConflict || !containsJSONText(body, "LOCAL_COMPUTER_HAS_AGENTS") || len(localComputers.removals) != 1 {
		t.Fatalf("remove locally assigned Computer status=%d body=%s removals=%v", status, body, localComputers.removals)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE agent_registrations SET status='revoked' WHERE actor_id='actor_local_guard'`); err != nil {
		t.Fatal(err)
	}
	localComputers.removeConflict = true
	status, _, body = env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/local-computers/"+computerID, nil, "")
	if status != http.StatusConflict || !containsJSONText(body, "LOCAL_COMPUTER_HAS_AGENTS") {
		t.Fatalf("remove assigned Local Computer status=%d body=%s", status, body)
	}

	// Renewal rotates the credential generation; a removed Computer is gone.
	if renewed := enrollLocalComputerOverHTTP(t, env, alice, "Alice's Mac", computerID); renewed != computerID {
		t.Fatalf("renewal moved the Computer: %s", renewed)
	}
	var generation int64
	if err := pool.QueryRow(t.Context(), `SELECT credential_generation FROM local_computers WHERE computer_id=$1`, computerID).Scan(&generation); err != nil || generation != 1 {
		t.Fatalf("renewed credential generation=%d err=%v", generation, err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE local_computers SET status='removed',removed_at=now() WHERE computer_id=$1`, computerID); err != nil {
		t.Fatal(err)
	}
	status, _, body = env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computer-enrollments", map[string]any{
		"computer_id": computerID, "display_name": "Alice's Mac", "redirect_uri": "http://127.0.0.1:45123/callback",
		"code_challenge": strings.Repeat("a", 43),
	}, "")
	if status != http.StatusGone || !containsJSONText(body, "LOCAL_COMPUTER_REMOVED") {
		t.Fatalf("renew removed Local Computer status=%d body=%s", status, body)
	}
}

// enrollLocalComputerOverHTTP pairs a Computer as the CLI does: the owner
// authorizes a PKCE enrollment and the CLI exchanges it, twice, as a retry
// of an uncertain exchange would. renew names an enrolled Computer.
func enrollLocalComputerOverHTTP(t *testing.T, env *testEnv, owner *http.Client, displayName, renew string) string {
	t.Helper()
	verifier := strings.Repeat("b", 43)
	challenge := sha256.Sum256([]byte(verifier))
	request := map[string]any{
		"display_name": displayName, "redirect_uri": "http://127.0.0.1:45123/callback",
		"code_challenge": base64.RawURLEncoding.EncodeToString(challenge[:]),
	}
	if renew != "" {
		request["computer_id"] = renew
	}
	status, _, body := env.request(owner, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computer-enrollments", request, "")
	if status != http.StatusCreated {
		t.Fatalf("create Local Computer enrollment status=%d body=%s", status, body)
	}
	var authorization struct {
		EnrollmentID      string `json:"enrollment_id"`
		ComputerID        string `json:"computer_id"`
		AuthorizationCode string `json:"authorization_code"`
	}
	decode(t, body, &authorization)
	var token string
	for attempt := range 2 {
		status, _, body = env.request(newClient(t), http.MethodPost, "/v0/local-computer-enrollments/"+authorization.EnrollmentID+"/exchange", map[string]any{
			"authorization_code": authorization.AuthorizationCode, "code_verifier": verifier,
			"redirect_uri": "http://127.0.0.1:45123/callback",
		}, "")
		var bundle struct {
			ComputerID   string `json:"computer_id"`
			GatewayURL   string `json:"gateway_url"`
			GatewayToken string `json:"gateway_token"`
		}
		decode(t, body, &bundle)
		if status != http.StatusOK || bundle.ComputerID != authorization.ComputerID ||
			bundle.GatewayURL != "wss://agent.example.test/v1/runner-gateway" || !strings.HasPrefix(bundle.GatewayToken, "sr1.") {
			t.Fatalf("exchange Local Computer credential attempt=%d status=%d body=%s", attempt, status, body)
		}
		token = bundle.GatewayToken
	}
	if token == "" {
		t.Fatal("exchange returned no credential")
	}
	return authorization.ComputerID
}

func TestLocalComputerEnrollmentDaemonIdentityHTTP(t *testing.T) {
	allowParallelIntegrationTest(t)
	databaseURL := newIntegrationDatabase(t)
	pool, err := pgxpool.New(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	application, err := newTestApp(context.Background(), localComputerEnrollmentConfig(config.ForTest(func(c *config.Config) {
		c.DatabaseURL = databaseURL
		c.SessionTTL = time.Hour
		c.CookieName = "teamhub_session"
		c.TeamHubInternalToken = teamHubInternalToken
		c.NodeServicesInternalToken = nodeServicesInternalToken
		c.AgentRunTokenSecret = agentRunTokenSecret
		c.ArtifactStorageRoot = t.TempDir()
	})), withLocalComputers(&recordingLocalComputers{}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(application.Close)
	server := httptest.NewServer(application.Handler())
	registerIntegrationServerCleanup(t, server)
	env := &testEnv{t: t, databaseURL: databaseURL, pool: pool, server: server}
	alice := env.login("alice", alicePassword)
	bob := seedPeerHuman(t, env)

	// A desktop newer than its server names its Daemon only when /v0/me lists
	// the capability, because an older TeamHub rejects the unknown field.
	if status, _, meBody := env.request(alice, http.MethodGet, "/v0/me", nil, ""); status != http.StatusOK ||
		!strings.Contains(string(meBody), `"server_capabilities":["local_computer_enrollment_daemon_id"]`) {
		t.Fatalf("read the enrollment capability status=%d body=%s", status, meBody)
	}

	computerA := enrollLocalComputerOverHTTP(t, env, alice, "Alice's Mac", "")
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO actors(id,tenant_id,kind,display_name,handle)
		VALUES ('actor_local_reset','tenant_acme','agent','Local Reset','local_reset')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `
		INSERT INTO agent_registrations(
			actor_id,tenant_id,agent_management_id,status,instructions,runtime_model,
			computer_id,local_runtime_type,workspace_grant_id,created_by_actor_id
		) VALUES (
			'actor_local_reset','tenant_acme','agent-management-local-reset','active','Run locally','model-local',
			$1,'codex','grant_linger','actor_acme_alice'
		)
	`, computerA); err != nil {
		t.Fatal(err)
	}

	key := sha256.Sum256([]byte("http-daemon-key"))
	daemonHash := sha256.Sum256(key[:])
	daemonID := base64.RawURLEncoding.EncodeToString(daemonHash[:])
	daemonPubKey := base64.StdEncoding.EncodeToString(key[:])
	connectBody := func(computerID, ownerActorID string, generation string) map[string]any {
		return map[string]any{
			"computer_id":           computerID,
			"owner":                 map[string]any{"tenant_id": acmeTenant, "owner_actor_id": ownerActorID},
			"credential_generation": generation,
			"daemon_id":             daemonID,
			"daemon_public_key":     daemonPubKey,
			"identity_version":      "1",
			"status":                "offline",
			"seen_at":               time.Now().UTC().Format(time.RFC3339Nano),
			"display_name":          "Alice's Mac",
			"runtimes":              []string{"codex"},
			"runtime_diagnostics":   []any{},
			"workspace_grants":      []any{},
			"daemon_version":        "0.51.0",
		}
	}
	// During a rolling upgrade, an old TeamHub can still read and write its limit.
	if _, err := pool.Exec(t.Context(), "UPDATE local_computers SET capacity=5 WHERE computer_id=$1", computerA); err != nil {
		t.Fatal(err)
	}
	legacyConnect := connectBody(computerA, "actor_acme_alice", "0")
	legacyConnect["capacity"] = 2
	status, body := agentRuntimeStateRequest(t, application.Handler(), http.MethodPost, "/v0/agent-runtime/local-computers/connect", teamHubInternalToken, legacyConnect)
	if status != http.StatusOK {
		t.Fatalf("connect Computer A status=%d body=%s", status, body)
	}
	var storedLimit int
	if err := pool.QueryRow(t.Context(), "SELECT capacity FROM local_computers WHERE computer_id=$1", computerA).Scan(&storedLimit); err != nil || storedLimit != 5 {
		t.Fatalf("legacy limit after reconnect=%d err=%v", storedLimit, err)
	}

	status, _, removeBody := env.request(alice, http.MethodDelete, "/v0/tenants/"+acmeTenant+"/local-computers/"+computerA, nil, "")
	if status != http.StatusConflict || !containsJSONText(removeBody, "LOCAL_COMPUTER_HAS_AGENTS") {
		t.Fatalf("delete assigned Computer A status=%d body=%s", status, removeBody)
	}

	verifier := strings.Repeat("v", 43)
	challenge := sha256.Sum256([]byte(verifier))
	challengeB64 := base64.RawURLEncoding.EncodeToString(challenge[:])
	status, _, enrollBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computer-enrollments", map[string]any{
		"display_name":   "Alice's Mac",
		"redirect_uri":   "http://127.0.0.1:45123/callback",
		"code_challenge": challengeB64,
		"daemon_id":      daemonID,
	}, "")
	if status != http.StatusCreated {
		t.Fatalf("re-enroll by daemon_id status=%d body=%s", status, enrollBody)
	}
	var authorization struct {
		EnrollmentID      string `json:"enrollment_id"`
		ComputerID        string `json:"computer_id"`
		AuthorizationCode string `json:"authorization_code"`
	}
	decode(t, enrollBody, &authorization)
	if authorization.ComputerID != computerA {
		t.Fatalf("re-enroll computer_id=%q, want %q", authorization.ComputerID, computerA)
	}
	status, _, exchangeBody := env.request(newClient(t), http.MethodPost, "/v0/local-computer-enrollments/"+authorization.EnrollmentID+"/exchange", map[string]any{
		"authorization_code": authorization.AuthorizationCode,
		"code_verifier":      verifier,
		"redirect_uri":       "http://127.0.0.1:45123/callback",
	}, "")
	if status != http.StatusOK {
		t.Fatalf("exchange renewed enrollment status=%d body=%s", status, exchangeBody)
	}
	status, body = agentRuntimeStateRequest(t, application.Handler(), http.MethodPost, "/v0/agent-runtime/local-computers/connect", teamHubInternalToken, connectBody(computerA, "actor_acme_alice", "1"))
	if status != http.StatusOK || !containsJSONText(body, "agent-management-local-reset") {
		t.Fatalf("reconnect renewed Computer A status=%d body=%s", status, body)
	}

	// A desktop whose earlier release paired a new Computer without naming its
	// Daemon renews at start naming both; the owner's Computer holding the
	// Daemon Identity is renewed instead of the never-connected one.
	orphan := enrollLocalComputerOverHTTP(t, env, alice, "Alice's Mac", "")
	status, _, healBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computer-enrollments", map[string]any{
		"computer_id":    orphan,
		"daemon_id":      daemonID,
		"display_name":   "Alice's Mac",
		"redirect_uri":   "http://127.0.0.1:45123/callback",
		"code_challenge": challengeB64,
	}, "")
	var healed struct {
		ComputerID string `json:"computer_id"`
	}
	if status != http.StatusCreated {
		t.Fatalf("renew the orphan naming the Daemon status=%d body=%s", status, healBody)
	}
	decode(t, healBody, &healed)
	if healed.ComputerID != computerA {
		t.Fatalf("renew the orphan naming the Daemon computer_id=%q, want %q", healed.ComputerID, computerA)
	}

	status, _, mismatchBody := env.request(alice, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computer-enrollments", map[string]any{
		"computer_id":    computerA,
		"daemon_id":      strings.Repeat("Z", 43),
		"display_name":   "Alice's Mac",
		"redirect_uri":   "http://127.0.0.1:45123/callback",
		"code_challenge": challengeB64,
	}, "")
	assertAgentRuntimeHTTPError(t, status, mismatchBody, http.StatusConflict, "LOCAL_COMPUTER_IDENTITY_MISMATCH")

	status, _, bobEnrollBody := env.request(bob, http.MethodPost, "/v0/tenants/"+acmeTenant+"/local-computer-enrollments", map[string]any{
		"display_name":   "Bob's Mac",
		"redirect_uri":   "http://127.0.0.1:45123/callback",
		"code_challenge": challengeB64,
		"daemon_id":      daemonID,
	}, "")
	assertAgentRuntimeHTTPError(t, status, bobEnrollBody, http.StatusConflict, "DAEMON_IDENTITY_IN_USE")

	computerB := enrollLocalComputerOverHTTP(t, env, bob, "Bob's Mac", "")
	status, bobConnectBody := agentRuntimeStateRequest(t, application.Handler(), http.MethodPost, "/v0/agent-runtime/local-computers/connect", teamHubInternalToken, connectBody(computerB, "actor_acme_bob", "0"))
	assertAgentRuntimeHTTPError(t, status, bobConnectBody, http.StatusConflict, "DAEMON_IDENTITY_IN_USE")
}
