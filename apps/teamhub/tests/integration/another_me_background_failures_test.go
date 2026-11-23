package integration_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/realtime"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

// The Agent Service reports how each background model call of an Another Me
// ended. The Human's Another Me shows the failures in a row from the third on,
// with the latest reason, and nothing again after a completed call. Browsers
// are told to refetch only when the banner appears, changes its reason or
// goes; a higher count alone waits for the next fetch.
func TestAnotherMeShowsThreeBackgroundCallFailuresInARow(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newAgentRegistrationEnv(t, &recordingAgentManagement{})
	const anotherMe, general = "actor_background_alice_anotherme", "actor_background_general"
	for _, agent := range []struct{ actorID, human, agentType string }{
		{anotherMe, "actor_acme_alice", "anotherme"},
		{general, "", "general"},
	} {
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO actors(id,tenant_id,kind,display_name,handle) VALUES($1,$2,'agent',$1,'@'||replace($1,'_','-'))`, agent.actorID, acmeTenant); err != nil {
			t.Fatal(err)
		}
		if _, err := env.pool.Exec(t.Context(), `INSERT INTO agent_registrations(actor_id,tenant_id,agent_management_id,status,description,instructions,runtime_model,created_by_actor_id,visibility_scope,agent_type,represented_human_actor_id,computer_id,local_runtime_type,workspace_grant_id)
VALUES($1,$2,'management-'||$1,'active','Background','Work safely','gpt-5','actor_acme_alice','sponsor',$4,nullif($3,''),'computer_fixture','codex','grant_files')`,
			agent.actorID, acmeTenant, agent.human, agent.agentType); err != nil {
			t.Fatal(err)
		}
	}
	handler := env.server.Config.Handler
	hints := listenTenantHints(t, env.pool)
	const anotherMeHint = realtime.InvalidationKindPrefix + realtime.InvalidateAnotherMe
	report := func(actorID, outcome, reason string) {
		t.Helper()
		request := teamhubinternal.RecordAnotherMeBackgroundCallRequest{
			TenantId: acmeTenant, AgentActorId: actorID,
			Outcome: teamhubinternal.RecordAnotherMeBackgroundCallRequestOutcome(outcome),
		}
		if reason != "" {
			request.Reason = &reason
		}
		status, body := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/another-me/background-calls", teamHubInternalToken, request)
		if status != http.StatusNoContent {
			t.Fatalf("report %s %s status=%d body=%s", actorID, outcome, status, body)
		}
	}
	shown := func() *httpapi.AnotherMeBackgroundFailure {
		t.Helper()
		status, _, body := env.request(alice, http.MethodGet, "/v0/tenants/"+acmeTenant+"/another-me", nil, "")
		if status != http.StatusOK {
			t.Fatalf("Another Me status=%d body=%s", status, body)
		}
		var model httpapi.AnotherMe
		decode(t, body, &model)
		return model.BackgroundFailure
	}

	if status, body := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/another-me/background-calls", "", teamhubinternal.RecordAnotherMeBackgroundCallRequest{
		TenantId: acmeTenant, AgentActorId: anotherMe, Outcome: "failed",
	}); status != http.StatusUnauthorized {
		t.Fatalf("unauthenticated report status=%d body=%s", status, body)
	}
	if status, body := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/another-me/background-calls", teamHubInternalToken, map[string]any{
		"tenant_id": acmeTenant, "agent_actor_id": anotherMe, "outcome": "skipped",
	}); status != http.StatusBadRequest {
		t.Fatalf("unknown outcome status=%d body=%s", status, body)
	}
	if status, body := agentRuntimeStateRequest(t, handler, http.MethodPost, "/v0/agent-runtime/another-me/background-calls", teamHubInternalToken, map[string]any{
		"tenant_id": acmeTenant, "agent_actor_id": anotherMe, "outcome": "failed", "reason": strings.Repeat("x", 65),
	}); status != http.StatusBadRequest {
		t.Fatalf("over-long reason status=%d body=%s", status, body)
	}

	report(anotherMe, "failed", "runtime_unavailable")
	report(anotherMe, "failed", "runtime_unavailable")
	if got := shown(); got != nil {
		t.Fatalf("two failures shown=%+v", got)
	}
	if got := hints()[anotherMeHint]; got != 0 {
		t.Fatalf("two failures sent %d Another Me hints", got)
	}
	report(anotherMe, "failed", "runtime_incompatible")
	if got := shown(); got == nil || got.ConsecutiveFailures != 3 || got.Reason != httpapi.AnotherMeBackgroundFailureReasonRuntimeIncompatible {
		t.Fatalf("third failure shown=%+v", got)
	}
	if got := hints()[anotherMeHint]; got != 1 {
		t.Fatalf("the banner appearing sent %d Another Me hints, want 1", got)
	}
	report(anotherMe, "failed", "runtime_incompatible")
	if got := shown(); got == nil || got.ConsecutiveFailures != 4 || got.Reason != httpapi.AnotherMeBackgroundFailureReasonRuntimeIncompatible {
		t.Fatalf("fourth failure shown=%+v", got)
	}
	if got := hints()[anotherMeHint]; got != 0 {
		t.Fatalf("a higher count with the same reason sent %d Another Me hints", got)
	}
	// A code this TeamHub does not know, as a newer Agent Service may send.
	report(anotherMe, "failed", "provider_quota")
	if got := shown(); got == nil || got.ConsecutiveFailures != 5 || got.Reason != httpapi.AnotherMeBackgroundFailureReasonUnknown {
		t.Fatalf("fifth failure shown=%+v", got)
	}
	if got := hints()[anotherMeHint]; got != 1 {
		t.Fatalf("a changed reason sent %d Another Me hints, want 1", got)
	}

	// Another Agent's calls neither count nor clear.
	report(general, "failed", "unknown")
	report(general, "completed", "")
	if got := shown(); got == nil || got.ConsecutiveFailures != 5 {
		t.Fatalf("after another Agent's calls shown=%+v", got)
	}

	report(anotherMe, "completed", "")
	if got := shown(); got != nil {
		t.Fatalf("after a completed call shown=%+v", got)
	}
	report(anotherMe, "completed", "")
	if got := hints()[anotherMeHint]; got != 1 {
		t.Fatalf("clearing sent %d Another Me hints, want 1", got)
	}
	if got := countRows(t, env, `SELECT count(*) FROM another_me_background_failures`); got != 0 {
		t.Fatalf("background failure rows=%d after the run ended", got)
	}
}
