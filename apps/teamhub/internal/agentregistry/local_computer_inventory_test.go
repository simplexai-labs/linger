package agentregistry

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func storedLocalComputer(status string, lastSeen time.Time) store.RuntimeLocalComputer {
	return store.RuntimeLocalComputer{
		ComputerID: "computer_1", DisplayName: "Mac", Status: status, ActiveOperations: 1,
		LastSeenAt:         pgtype.Timestamptz{Time: lastSeen, Valid: true},
		DaemonVersion:      pgtype.Text{String: "0.40.0", Valid: true},
		RecommendedVersion: pgtype.Text{String: "0.41.0", Valid: true},
		WorkspaceGrants: []byte(`[
			{"grant_id":"grant_b","tenant_id":"tenant_1","scope":"owner","label":"Files","mode":"workspace-write"},
			{"grant_id":"grant_a","tenant_id":"tenant_2","scope":"owner","mode":"workspace-write"},
			{"grant_id":"grant_c","tenant_id":"tenant_1","scope":"shared","mode":"read-only"}]`),
		RuntimeDiagnostics: []byte(`[
			{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-03T00:00:00Z","version":"1.2",
			 "models":[{"id":"gpt","label":"GPT","allowed_reasoning_effort":["medium","high"],"default_reasoning_effort":"high","is_default":true}]},
			{"type":"claude","status":"authentication_required","protocol":"stream-json","checked_at":"2026-11-03T00:00:00Z",
			 "error":{"code":"RUNTIME_AUTHENTICATION_REQUIRED","message":"Sign in"}},
			{"type":"pi","status":"ready","protocol":"rpc","checked_at":"2026-11-03T00:00:00Z","models":[],"model_catalog_error":{"code":"x"}}]`),
	}
}

func TestProjectStoredLocalComputerReadsTheRecordedInventory(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	item, listed, err := projectStoredLocalComputer(storedLocalComputer("online", now.Add(-20*time.Second)), "tenant_1", now)
	if err != nil || !listed {
		t.Fatalf("listed=%v err=%v", listed, err)
	}
	if item.Status != httpapi.LocalComputerStatusOnline || item.ActiveOperations != 1 ||
		*item.DaemonVersion != "0.40.0" || *item.RecommendedVersion != "0.41.0" {
		t.Fatalf("computer=%+v", item)
	}
	if len(item.WorkspaceGrants) != 1 || item.WorkspaceGrants[0].GrantId != "grant_b" || item.WorkspaceGrants[0].Label != "Files" {
		t.Fatalf("grants=%+v", item.WorkspaceGrants)
	}
	if len(item.Runtimes) != 3 || item.Runtimes[0].Type != "claude" || item.Runtimes[1].Type != "codex" || item.Runtimes[2].Type != "pi" {
		t.Fatalf("runtimes=%+v", item.Runtimes)
	}
	claude, codex, pi := item.Runtimes[0], item.Runtimes[1], item.Runtimes[2]
	if claude.Status != "authentication_required" || *claude.ErrorCode != "RUNTIME_AUTHENTICATION_REQUIRED" ||
		len(claude.Models) != 1 || claude.Models[0].Id != "claude-default" {
		t.Fatalf("claude=%+v", claude)
	}
	if len(codex.Models) != 1 || *codex.Models[0].DefaultReasoningEffort != "high" || len(*codex.Models[0].AllowedReasoningEffort) != 2 ||
		codex.Models[0].IsDefault == nil || !*codex.Models[0].IsDefault || claude.Models[0].IsDefault != nil {
		t.Fatalf("codex=%+v", codex)
	}
	if len(pi.Models) != 0 {
		t.Fatalf("pi=%+v", pi)
	}
}

func TestProjectStoredLocalComputerKeepsRuntimesOfAnOfflineComputer(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	for name, row := range map[string]store.RuntimeLocalComputer{
		"disconnected":     storedLocalComputer("offline", now.Add(-time.Hour)),
		"stale heartbeat":  storedLocalComputer("online", now.Add(-2*time.Minute)),
		"upgrade required": storedLocalComputer("upgrade_required", now),
	} {
		t.Run(name, func(t *testing.T) {
			item, listed, err := projectStoredLocalComputer(row, "tenant_1", now)
			if err != nil || !listed || item.Status != httpapi.LocalComputerStatusOffline ||
				item.ActiveOperations != 0 {
				t.Fatalf("computer=%+v listed=%v err=%v", item, listed, err)
			}
			if item.UpgradeRequired != (row.Status == "upgrade_required") {
				t.Fatalf("upgrade_required=%v", item.UpgradeRequired)
			}
			if item.Runtimes[1].Status != "ready" || item.Runtimes[1].Models[0].Id != "gpt" {
				t.Fatalf("codex=%+v", item.Runtimes[1])
			}
		})
	}
}

func TestProjectStoredLocalComputerSkipsAComputerWithoutAnOwnerGrant(t *testing.T) {
	now := time.Now()
	_, listed, err := projectStoredLocalComputer(storedLocalComputer("online", now), "tenant_3", now)
	if err != nil || listed {
		t.Fatalf("listed=%v err=%v", listed, err)
	}
}

func TestStoredRuntimeModelsResolvesFallbackDefaultReasoningEffort(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	row := storedLocalComputer("online", now)
	row.RuntimeDiagnostics = []byte(`[
		{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-19T00:00:00Z","models":[
			{"id":"gpt-6-astra","label":"GPT-6-Astra","allowed_reasoning_effort":["low","xhigh"]},
			{"id":"gpt-5.4-mini","label":"GPT-5.4 Mini","allowed_reasoning_effort":["minimal","low","high","bad effort"],"default_reasoning_effort":"minimal"}
		]},
		{"type":"pi","status":"ready","protocol":"rpc","checked_at":"2026-11-19T00:00:00Z","models":[
			{"id":"spark","label":"Spark-X2.6-4B","allowed_reasoning_effort":["none","low","high"]},
			{"id":"qwen","label":"Qwen3.6-35B-A3B","allowed_reasoning_effort":["none","low","medium","high"]},
			{"id":"high-only","label":"HighOnly","allowed_reasoning_effort":["none","high"]},
			{"id":"xhigh-only","label":"XHighOnly","allowed_reasoning_effort":["none","xhigh"]},
			{"id":"none-only","label":"NoneOnly","allowed_reasoning_effort":["none"]},
			{"id":"explicit-none","label":"ExplicitNone","allowed_reasoning_effort":["none","low","high"],"default_reasoning_effort":"none"},
			{"id":"invalid-default","label":"InvalidDefault","allowed_reasoning_effort":["none","low","high"],"default_reasoning_effort":"medium"},
			{"id":"no-effort","label":"NoEffort","allowed_reasoning_effort":[]}
		]}
	]`)
	item, listed, err := projectStoredLocalComputer(row, "tenant_1", now)
	if err != nil || !listed || len(item.Runtimes) != 2 {
		t.Fatalf("computer=%+v listed=%v err=%v", item, listed, err)
	}
	mini := item.Runtimes[0].Models[1]
	if mini.Id != "gpt-5.4-mini" || mini.AllowedReasoningEffort == nil || len(*mini.AllowedReasoningEffort) != 3 ||
		(*mini.AllowedReasoningEffort)[0] != "minimal" || mini.DefaultReasoningEffort == nil || *mini.DefaultReasoningEffort != "minimal" {
		t.Fatalf("gpt-5.4-mini projected = %+v", mini)
	}
	want := map[string]string{
		"spark":           "low",
		"qwen":            "medium",
		"high-only":       "high",
		"xhigh-only":      "xhigh",
		"none-only":       "none",
		"explicit-none":   "none",
		"invalid-default": "low",
		"no-effort":       "",
	}
	for _, model := range item.Runtimes[1].Models {
		got := ""
		if model.DefaultReasoningEffort != nil {
			got = *model.DefaultReasoningEffort
		}
		if got != want[model.Id] {
			t.Fatalf("%s default_reasoning_effort=%q, want %q", model.Id, got, want[model.Id])
		}
	}

	medium := "medium"
	high := "high"
	ultra := "ultra"
	minimal := "minimal"
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "spark", nil); resolved == nil || *resolved != "low" {
		t.Fatalf("omitted effort on spark=%v, want low", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "spark", &medium); resolved == nil || *resolved != "low" {
		t.Fatalf("unsupported medium on spark=%v, want low", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "spark", &high); resolved == nil || *resolved != "high" {
		t.Fatalf("supported high on spark=%v, want high", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "spark", &ultra); resolved == nil || *resolved != "low" {
		t.Fatalf("unsupported ultra on pi spark=%v, want low", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "qwen", nil); resolved == nil || *resolved != "medium" {
		t.Fatalf("omitted effort on qwen=%v, want medium", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "no-effort", &high); resolved != nil {
		t.Fatalf("stale effort on no-effort model=%v, want nil", *resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "codex", "gpt-6-astra", nil); resolved == nil || *resolved != "low" {
		t.Fatalf("omitted effort on codex=%v, want low", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "codex", "gpt-6-astra", &medium); resolved == nil || *resolved != "low" {
		t.Fatalf("unsupported medium on codex=%v, want low", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "codex", "gpt-6-astra", &ultra); resolved == nil || *resolved != "low" {
		t.Fatalf("unsupported ultra on codex=%v, want clamped to low", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "codex", "gpt-5.4-mini", &minimal); resolved == nil || *resolved != "minimal" {
		t.Fatalf("supported minimal on codex=%v, want minimal", resolved)
	}
	if resolved := resolveRegistrationReasoningEffort(row.RuntimeDiagnostics, "pi", "unlisted", nil); resolved != nil {
		t.Fatalf("unlisted model effort=%v, want nil", resolved)
	}
}

func TestStoredRuntimeModelsCapsEffortsAndResolvesDefaultAlias(t *testing.T) {
	efforts := make([]string, 0, 40)
	for i := range 40 {
		efforts = append(efforts, fmt.Sprintf(`"tier_%02d"`, i))
	}
	raw := []byte(fmt.Sprintf(`[
		{"type":"codex","status":"ready","protocol":"app-server","checked_at":"2026-11-25T00:00:00Z","models":[
			{"id":"gpt-first","label":"GPT First","allowed_reasoning_effort":["tier_00","-invalid",%s],"default_reasoning_effort":"tier_35"},
			{"id":"gpt-default","label":"GPT Default","allowed_reasoning_effort":["minimal","low"],"default_reasoning_effort":"minimal","is_default":true}
		]},
		{"type":"claude","status":"ready","protocol":"stream-json","checked_at":"2026-11-25T00:00:00Z","models":[
			{"id":"claude-first","label":"Claude First","allowed_reasoning_effort":["low","high"]},
			{"id":"claude-second","label":"Claude Second","allowed_reasoning_effort":["high"]}
		]}
	]`, strings.Join(efforts, ",")))

	firstModel, found := storedRuntimeModel(raw, "codex", "gpt-first")
	if !found || firstModel.AllowedReasoningEffort == nil {
		t.Fatalf("gpt-first lookup failed: found=%v model=%+v", found, firstModel)
	}
	if len(*firstModel.AllowedReasoningEffort) != maxRuntimeModelReasoningEfforts {
		t.Fatalf("allowed reasoning efforts len = %d, want %d", len(*firstModel.AllowedReasoningEffort), maxRuntimeModelReasoningEfforts)
	}
	if firstModel.DefaultReasoningEffort == nil || *firstModel.DefaultReasoningEffort != "tier_00" {
		t.Fatalf("default reasoning effort = %v, want tier_00 fallback", firstModel.DefaultReasoningEffort)
	}

	codexDefault, found := storedRuntimeModel(raw, "codex", "codex-default")
	if !found || codexDefault.Id != "gpt-default" {
		t.Fatalf("codex-default resolved to found=%v id=%q, want gpt-default", found, codexDefault.Id)
	}
	minimal := "minimal"
	if resolved := resolveRegistrationReasoningEffort(raw, "codex", "codex-default", &minimal); resolved == nil || *resolved != "minimal" {
		t.Fatalf("codex-default minimal effort = %v, want minimal", resolved)
	}

	claudeDefault, found := storedRuntimeModel(raw, "claude", "claude-default")
	if !found || claudeDefault.Id != "claude-first" {
		t.Fatalf("claude-default without is_default resolved to found=%v id=%q, want claude-first", found, claudeDefault.Id)
	}
}
