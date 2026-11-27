package agentregistry

import (
	"context"
	"log/slog"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestEvaluateAnotherMeLocalPlacementUsesAnyReadyRuntime(t *testing.T) {
	grants := []httpapi.LocalComputerWorkspaceGrant{{GrantId: "grant_files", Mode: httpapi.WorkspaceWrite}}
	efforts := func(values ...httpapi.AgentReasoningEffort) *[]httpapi.AgentReasoningEffort { return &values }
	high := "high"
	isDefault := true
	for _, test := range []struct {
		name      string
		runtimes  []httpapi.LocalComputerRuntime
		preferred string
		want      anotherMeLocalPlacement
	}{{
		name: "Claude model without a default effort",
		runtimes: []httpapi.LocalComputerRuntime{{Type: "claude", Status: "ready", Models: []httpapi.AgentModel{{
			Id: "claude-sonnet", AllowedReasoningEffort: efforts("medium", "high"),
		}}}},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "claude", WorkspaceGrantID: "grant_files", Model: "claude-sonnet", ReasoningEffort: "medium"},
	}, {
		name: "Codex when Claude is not ready",
		runtimes: []httpapi.LocalComputerRuntime{
			{Type: "claude", Status: "not_installed"},
			{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{Id: "codex-default"}}},
		},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "codex", WorkspaceGrantID: "grant_files", Model: "codex-default"},
	}, {
		name: "model default effort",
		runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{
			Id: "gpt", AllowedReasoningEffort: efforts("medium", "high"), DefaultReasoningEffort: &high,
		}}}},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "codex", WorkspaceGrantID: "grant_files", Model: "gpt", ReasoningEffort: "high"},
	}, {
		name: "the Runtime's default model",
		runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{
			{Id: "gpt-mini"}, {Id: "gpt", IsDefault: &isDefault},
		}}},
		want: anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "codex", WorkspaceGrantID: "grant_files", Model: "gpt"},
	}, {
		name: "the Runtime chosen at installation",
		runtimes: []httpapi.LocalComputerRuntime{
			{Type: "claude", Status: "ready", Models: []httpapi.AgentModel{{Id: "default"}}},
			{Type: "pi", Status: "ready", Models: []httpapi.AgentModel{{Id: "localmodels/localmodels-agent"}}},
		},
		preferred: "pi",
		want:      anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "pi", WorkspaceGrantID: "grant_files", Model: "localmodels/localmodels-agent"},
	}, {
		name: "another ready Runtime while the chosen one is not ready",
		runtimes: []httpapi.LocalComputerRuntime{
			{Type: "claude", Status: "ready", Models: []httpapi.AgentModel{{Id: "default"}}},
			{Type: "pi", Status: "authentication_required"},
		},
		preferred: "pi",
		want:      anotherMeLocalPlacement{ComputerID: "computer_1", RuntimeType: "claude", WorkspaceGrantID: "grant_files", Model: "default"},
	}} {
		t.Run(test.name, func(t *testing.T) {
			got, blocker := evaluateAnotherMeLocalPlacement([]httpapi.LocalComputer{{
				ComputerId: "computer_1", Status: httpapi.LocalComputerStatusOnline, Runtimes: test.runtimes, WorkspaceGrants: grants,
			}}, test.preferred)
			if blocker != nil || got != test.want {
				t.Fatalf("placement=%+v blocker=%+v, want %+v", got, blocker, test.want)
			}
		})
	}
}

func TestEvaluateAnotherMeLocalPlacementWaitsForAnOnlineComputer(t *testing.T) {
	placement, blocker := evaluateAnotherMeLocalPlacement([]httpapi.LocalComputer{{
		ComputerId: "computer_1", Status: httpapi.LocalComputerStatusOffline,
		WorkspaceGrants: []httpapi.LocalComputerWorkspaceGrant{{GrantId: "grant_files", Mode: httpapi.WorkspaceWrite}},
		Runtimes:        []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{Id: "codex-default"}}}},
	}}, "")
	if placement.ComputerID != "" || blocker == nil || blocker.Reason != httpapi.NoOnlineComputer {
		t.Fatalf("placement=%+v blocker=%+v, want no_online_computer", placement, blocker)
	}
}

func TestStoredPreferredRuntimeReadsTheMarkedDiagnostic(t *testing.T) {
	for _, test := range []struct{ raw, want string }{
		{`[{"type":"claude","status":"ready"},{"type":"pi","status":"ready","preferred":true}]`, "pi"},
		{`[{"type":"claude","status":"ready"},{"type":"pi","status":"ready"}]`, ""},
	} {
		got, err := storedPreferredRuntime([]byte(test.raw))
		if err != nil || got != test.want {
			t.Fatalf("preferred=%q err=%v, want %q", got, err, test.want)
		}
	}
}

func TestEvaluateAnotherMeLocalPlacementUsesProjectedDefaultReasoningEffort(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	row := storedLocalComputer("online", now)
	row.RuntimeDiagnostics = []byte(`[
		{"type":"pi","status":"ready","protocol":"rpc","checked_at":"2026-11-19T00:00:00Z","models":[
			{"id":"localmodels-library/spark","label":"Spark-X2.6-4B","allowed_reasoning_effort":["none","low","high"]}
		]}
	]`)
	projected, listed, err := projectStoredLocalComputer(row, "tenant_1", now)
	if err != nil || !listed {
		t.Fatalf("project computer=%+v listed=%v err=%v", projected, listed, err)
	}
	got, blocker := evaluateAnotherMeLocalPlacement([]httpapi.LocalComputer{projected}, "pi")
	want := anotherMeLocalPlacement{
		ComputerID:       "computer_1",
		RuntimeType:      "pi",
		WorkspaceGrantID: "grant_b",
		Model:            "localmodels-library/spark",
		ReasoningEffort:  "low",
	}
	if blocker != nil || got != want {
		t.Fatalf("placement=%+v blocker=%+v, want %+v", got, blocker, want)
	}
}

func TestEvaluateAnotherMeLocalPlacementBlockers(t *testing.T) {
	grants := []httpapi.LocalComputerWorkspaceGrant{{GrantId: "grant_files", Mode: httpapi.WorkspaceWrite}}
	readOnlyGrants := []httpapi.LocalComputerWorkspaceGrant{{GrantId: "grant_ro", Mode: httpapi.ReadOnly}}
	errMsg := "node.exe not found"
	win32 := httpapi.Win32

	if placement, blocker := evaluateAnotherMeLocalPlacement(nil, ""); placement.ComputerID != "" || blocker != nil {
		t.Fatalf("empty computers placement=%+v blocker=%+v, want empty/nil", placement, blocker)
	}

	for _, test := range []struct {
		name           string
		computers      []httpapi.LocalComputer
		wantReason     httpapi.AnotherMePlacementBlockerReason
		wantComputerID string
		wantRuntimes   int
	}{
		{
			name: "offline computer",
			computers: []httpapi.LocalComputer{{
				ComputerId: "cmp_off", Status: httpapi.LocalComputerStatusOffline, WorkspaceGrants: grants,
			}},
			wantReason:     httpapi.NoOnlineComputer,
			wantComputerID: "cmp_off",
		},
		{
			name: "upgrade required computer",
			computers: []httpapi.LocalComputer{{
				ComputerId: "cmp_old", Status: httpapi.LocalComputerStatusOffline, UpgradeRequired: true, WorkspaceGrants: grants,
			}},
			wantReason:     httpapi.ComputerUpgradeRequired,
			wantComputerID: "cmp_old",
		},
		{
			name: "online computer with no workspace grants",
			computers: []httpapi.LocalComputer{{
				ComputerId: "cmp_nogrant", Status: httpapi.LocalComputerStatusOnline,
				Runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{Id: "gpt"}}}},
			}},
			wantReason:     httpapi.NoWritableWorkspaceGrant,
			wantComputerID: "cmp_nogrant",
		},
		{
			name: "online computer with only read-only workspace grant",
			computers: []httpapi.LocalComputer{{
				ComputerId: "cmp_ro", Status: httpapi.LocalComputerStatusOnline, WorkspaceGrants: readOnlyGrants,
				Runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: "ready", Models: []httpapi.AgentModel{{Id: "gpt"}}}},
			}},
			wantReason:     httpapi.NoWritableWorkspaceGrant,
			wantComputerID: "cmp_ro",
		},
		{
			name: "online Windows computer with unready runtimes",
			computers: []httpapi.LocalComputer{{
				ComputerId: "cmp_win", Platform: &win32, Status: httpapi.LocalComputerStatusOnline, WorkspaceGrants: grants,
				Runtimes: []httpapi.LocalComputerRuntime{
					{Type: "claude", Status: httpapi.LocalRuntimeDiagnosticStatusNotInstalled, Models: []httpapi.AgentModel{{Id: "claude-default"}}},
					{Type: "codex", Status: httpapi.LocalRuntimeDiagnosticStatusError, Message: &errMsg},
					{Type: "pi", Status: httpapi.LocalRuntimeDiagnosticStatusReady, Models: nil},
				},
			}},
			wantReason:     httpapi.NoReadyRuntimeWithModels,
			wantComputerID: "cmp_win",
			wantRuntimes:   3,
		},
		{
			name: "multi-computer selects furthest-along blocker",
			computers: []httpapi.LocalComputer{
				{ComputerId: "cmp_off", Status: httpapi.LocalComputerStatusOffline, WorkspaceGrants: grants},
				{ComputerId: "cmp_old", Status: httpapi.LocalComputerStatusOffline, UpgradeRequired: true, WorkspaceGrants: grants},
				{ComputerId: "cmp_nogrant", Status: httpapi.LocalComputerStatusOnline},
				{
					ComputerId: "cmp_win", Platform: &win32, Status: httpapi.LocalComputerStatusOnline, WorkspaceGrants: grants,
					Runtimes: []httpapi.LocalComputerRuntime{{Type: "codex", Status: httpapi.LocalRuntimeDiagnosticStatusAuthenticationRequired}},
				},
			},
			wantReason:     httpapi.NoReadyRuntimeWithModels,
			wantComputerID: "cmp_win",
			wantRuntimes:   1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			placement, blocker := evaluateAnotherMeLocalPlacement(test.computers, "")
			if placement.ComputerID != "" {
				t.Fatalf("unexpected placement=%+v", placement)
			}
			if blocker == nil {
				t.Fatal("blocker=nil, want non-nil")
			}
			if blocker.Reason != test.wantReason {
				t.Fatalf("reason=%q, want %q", blocker.Reason, test.wantReason)
			}
			if blocker.ComputerId == nil || *blocker.ComputerId != test.wantComputerID {
				t.Fatalf("computer_id=%v, want %q", blocker.ComputerId, test.wantComputerID)
			}
			gotRuntimes := 0
			if blocker.Runtimes != nil {
				gotRuntimes = len(*blocker.Runtimes)
			}
			if gotRuntimes != test.wantRuntimes {
				t.Fatalf("runtimes count=%d, want %d", gotRuntimes, test.wantRuntimes)
			}
			if blocker.Runtimes != nil {
				for _, runtime := range *blocker.Runtimes {
					if runtime.Status != httpapi.LocalRuntimeDiagnosticStatusReady && runtime.ModelCount != 0 {
						t.Fatalf("non-ready runtime %+v reported model_count=%d, want 0", runtime, runtime.ModelCount)
					}
				}
			}
		})
	}
}

func TestAnotherMePlacementBlockerFromRows(t *testing.T) {
	now := time.Date(2026, 11, 26, 12, 0, 0, 0, time.UTC)

	t.Run("no registered computers returns nil blocker", func(t *testing.T) {
		blocker, err := anotherMePlacementBlockerFromRows(nil, "tenant_1", now, nil)
		if err != nil || blocker != nil {
			t.Fatalf("blocker=%+v err=%v, want nil/nil", blocker, err)
		}
	})

	t.Run("online Windows computer with unready runtime", func(t *testing.T) {
		row := storedLocalComputer("online", now.Add(-5*time.Second))
		row.ComputerID = "cmp_win_1"
		row.Platform = pgtype.Text{String: "win32", Valid: true}
		row.RuntimeDiagnostics = []byte(`[
			{"type":"claude","status":"not_installed","protocol":"stream-json","checked_at":"2026-11-26T11:59:55Z"},
			{"type":"codex","status":"authentication_required","protocol":"app-server","checked_at":"2026-11-26T11:59:55Z","error":{"code":"RUNTIME_AUTHENTICATION_REQUIRED","message":"Sign in to Codex"}},
			{"type":"pi","status":"ready","protocol":"rpc","checked_at":"2026-11-26T11:59:55Z","models":[]}
		]`)
		blocker, err := anotherMePlacementBlockerFromRows([]store.RuntimeLocalComputer{row}, "tenant_1", now, nil)
		if err != nil || blocker == nil {
			t.Fatalf("blocker=%+v err=%v", blocker, err)
		}
		if blocker.Reason != httpapi.NoReadyRuntimeWithModels || blocker.ComputerId == nil || *blocker.ComputerId != "cmp_win_1" {
			t.Fatalf("blocker=%+v", blocker)
		}
		if blocker.Runtimes == nil || len(*blocker.Runtimes) != 3 {
			t.Fatalf("runtimes=%+v", blocker.Runtimes)
		}
		// Non-ready runtimes with omitted models must report model_count=0 even
		// though projectStoredRuntimes synthesizes a fallback default model.
		if (*blocker.Runtimes)[0].Type != httpapi.LocalRuntimeTypeClaude ||
			(*blocker.Runtimes)[0].Status != httpapi.LocalRuntimeDiagnosticStatusNotInstalled ||
			(*blocker.Runtimes)[0].ModelCount != 0 {
			t.Fatalf("claude runtime=%+v", (*blocker.Runtimes)[0])
		}
		if (*blocker.Runtimes)[1].Type != httpapi.LocalRuntimeTypeCodex ||
			(*blocker.Runtimes)[1].Status != httpapi.LocalRuntimeDiagnosticStatusAuthenticationRequired ||
			(*blocker.Runtimes)[1].ModelCount != 0 ||
			(*blocker.Runtimes)[1].Message == nil || *(*blocker.Runtimes)[1].Message != "Sign in to Codex" {
			t.Fatalf("codex runtime=%+v", (*blocker.Runtimes)[1])
		}
		if (*blocker.Runtimes)[2].Type != httpapi.LocalRuntimeTypePi ||
			(*blocker.Runtimes)[2].Status != httpapi.LocalRuntimeDiagnosticStatusReady ||
			(*blocker.Runtimes)[2].ModelCount != 0 {
			t.Fatalf("pi runtime=%+v", (*blocker.Runtimes)[2])
		}
	})

	t.Run("online computer without any owner workspace grants", func(t *testing.T) {
		row := storedLocalComputer("online", now.Add(-5*time.Second))
		row.WorkspaceGrants = []byte(`[]`)
		blocker, err := anotherMePlacementBlockerFromRows([]store.RuntimeLocalComputer{row}, "tenant_1", now, nil)
		if err != nil || blocker == nil || blocker.Reason != httpapi.NoWritableWorkspaceGrant {
			t.Fatalf("blocker=%+v err=%v, want no_writable_workspace_grant", blocker, err)
		}
	})

	t.Run("upgrade required computer", func(t *testing.T) {
		row := storedLocalComputer("upgrade_required", now)
		blocker, err := anotherMePlacementBlockerFromRows([]store.RuntimeLocalComputer{row}, "tenant_1", now, nil)
		if err != nil || blocker == nil || blocker.Reason != httpapi.ComputerUpgradeRequired {
			t.Fatalf("blocker=%+v err=%v, want computer_upgrade_required", blocker, err)
		}
	})

	t.Run("stale heartbeat computer reports no_online_computer", func(t *testing.T) {
		row := storedLocalComputer("online", now.Add(-2*time.Minute))
		blocker, err := anotherMePlacementBlockerFromRows([]store.RuntimeLocalComputer{row}, "tenant_1", now, nil)
		if err != nil || blocker == nil || blocker.Reason != httpapi.NoOnlineComputer {
			t.Fatalf("blocker=%+v err=%v, want no_online_computer", blocker, err)
		}
	})

	t.Run("eligible computer with recorded create failure reports create_failed", func(t *testing.T) {
		row := storedLocalComputer("online", now.Add(-5*time.Second))
		blocker, err := anotherMePlacementBlockerFromRows([]store.RuntimeLocalComputer{row}, "tenant_1", now, &anotherMeCreateFailure{
			ComputerID: row.ComputerID,
		})
		if err != nil || blocker == nil || blocker.Reason != httpapi.CreateFailed {
			t.Fatalf("blocker=%+v err=%v, want create_failed", blocker, err)
		}
		if blocker.ComputerId == nil || *blocker.ComputerId != row.ComputerID {
			t.Fatalf("computer_id=%v, want %q", blocker.ComputerId, row.ComputerID)
		}
	})
}

type capturedLogRecord struct {
	level slog.Level
	msg   string
	attrs map[string]any
}

type capturingLogHandler struct {
	records *[]capturedLogRecord
}

func (h capturingLogHandler) Enabled(context.Context, slog.Level) bool { return true }
func (h capturingLogHandler) Handle(_ context.Context, record slog.Record) error {
	attrs := make(map[string]any)
	record.Attrs(func(attr slog.Attr) bool {
		attrs[attr.Key] = attr.Value.Any()
		return true
	})
	*h.records = append(*h.records, capturedLogRecord{level: record.Level, msg: record.Message, attrs: attrs})
	return nil
}
func (h capturingLogHandler) WithAttrs([]slog.Attr) slog.Handler { return h }
func (h capturingLogHandler) WithGroup(string) slog.Handler      { return h }

func TestLogAnotherMePlacementSkippedDeduplicatesAndLogsTransitions(t *testing.T) {
	var records []capturedLogRecord
	svc := &Service{logger: slog.New(capturingLogHandler{records: &records})}
	win32 := httpapi.Win32
	computer := httpapi.LocalComputer{
		ComputerId: "cmp_win_1",
		Platform:   &win32,
		Status:     httpapi.LocalComputerStatusOnline,
	}
	runtimes := []httpapi.AnotherMePlacementRuntimeStatus{{
		Type:       httpapi.LocalRuntimeTypeCodex,
		Status:     httpapi.LocalRuntimeDiagnosticStatusAuthenticationRequired,
		ModelCount: 0,
	}}
	blocker := &httpapi.AnotherMePlacementBlocker{
		Reason:     httpapi.NoReadyRuntimeWithModels,
		ComputerId: &computer.ComputerId,
		Runtimes:   &runtimes,
	}

	svc.logAnotherMePlacementSkipped("tenant_1", "actor_1", computer, blocker)
	svc.logAnotherMePlacementSkipped("tenant_1", "actor_1", computer, blocker)
	if len(records) != 1 {
		t.Fatalf("logged %d records, want 1 (deduplicated)", len(records))
	}
	if records[0].level != slog.LevelWarn || records[0].msg != "another_me.placement_skipped" {
		t.Fatalf("record=%+v", records[0])
	}
	if records[0].attrs["reason"] != "no_ready_runtime_with_models" ||
		records[0].attrs["computer_id"] != "cmp_win_1" ||
		records[0].attrs["platform"] != "win32" {
		t.Fatalf("attrs=%+v", records[0].attrs)
	}

	// Changing blocker reason logs a new transition record.
	grantBlocker := &httpapi.AnotherMePlacementBlocker{
		Reason:     httpapi.NoWritableWorkspaceGrant,
		ComputerId: &computer.ComputerId,
	}
	svc.logAnotherMePlacementSkipped("tenant_1", "actor_1", computer, grantBlocker)
	if len(records) != 2 || records[1].attrs["reason"] != "no_writable_workspace_grant" {
		t.Fatalf("transition records=%+v", records)
	}

	// Clearing owner state resets deduplication.
	svc.anotherMeState.clearOwner("tenant_1", "actor_1")
	svc.logAnotherMePlacementSkipped("tenant_1", "actor_1", computer, grantBlocker)
	if len(records) != 3 {
		t.Fatalf("records after clear=%d, want 3", len(records))
	}
}
