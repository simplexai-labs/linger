package localmodels

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

const (
	secondModel   = "gemma3-4b:Q4_K_M"
	secondPiModel = "localmodels-library/localmodels-lib-gemma3-4b-q4-k-m/Gemma3-4B"
)

func secondRow(state string) map[string]any {
	row := model(secondModel, state)
	row["name"] = "Gemma 3 4B"
	if _, ok := row["pi_model"]; ok {
		row["pi_model"] = secondPiModel
	}
	return row
}

func piDiagnostic(status string, models ...provider.RuntimeModel) []provider.RuntimeDiagnostic {
	diagnostic := provider.RuntimeDiagnostic{Type: "pi", Status: status, Models: models}
	if status == "authentication_required" {
		diagnostic.Error = &provider.DiagnosticError{Code: "RUNTIME_AUTHENTICATION_REQUIRED", Message: "sign in"}
	}
	return []provider.RuntimeDiagnostic{{Type: "codex", Status: "ready", Models: []provider.RuntimeModel{{ID: "gpt", AllowedReasoningEffort: []string{}}}}, diagnostic}
}

// catalogFixture reads the library once and merges against that read, as
// the Daemon's discovery shaping does.
type catalogFixture struct {
	library *Library
	catalog *PiCatalog
}

func catalogLibrary(t *testing.T, fake *fakeTool) *catalogFixture {
	t.Helper()
	library := newEnsureLibrary(t, fake, 0)
	library.Refresh(context.Background())
	return &catalogFixture{library: library, catalog: NewPiCatalog(t.TempDir())}
}

func (f *catalogFixture) MergePiCatalog(diagnostics []provider.RuntimeDiagnostic, source *OverlayState) []provider.RuntimeDiagnostic {
	return f.catalog.Merge(diagnostics, source, f.library.Snapshot())
}

func (f *catalogFixture) Refresh(ctx context.Context) { f.library.Refresh(ctx) }

func (f *catalogFixture) piCatalogPath() string { return f.catalog.path }

func (f *catalogFixture) readPiCatalog() map[string]provider.RuntimeModel {
	f.catalog.mu.Lock()
	defer f.catalog.mu.Unlock()
	return f.catalog.read()
}

func modelIDs(diagnostic provider.RuntimeDiagnostic) []string {
	var ids []string
	for _, model := range diagnostic.Models {
		ids = append(ids, model.ID)
	}
	return ids
}

func TestTheMergedPiCatalogRemembersWhatPiListedWhileLoaded(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	library := catalogLibrary(t, fake)
	listed := provider.RuntimeModel{ID: testPiModel, Label: "Qwen3 4B (local)", AllowedReasoningEffort: []string{"low", "high"}, DefaultReasoningEffort: "high", ContextWindow: 32768}
	defaultModel := provider.RuntimeModel{ID: "anthropic/claude", Label: "Claude", AllowedReasoningEffort: []string{}, IsDefault: true}
	loaded := library.MergePiCatalog(piDiagnostic("ready", defaultModel, listed), nil)
	if !slices.Equal(modelIDs(loaded[1]), []string{"anthropic/claude", testPiModel}) || !loaded[1].Models[0].IsDefault {
		t.Fatalf("loaded catalog = %+v", loaded[1].Models)
	}
	info, err := os.Stat(library.piCatalogPath())
	// Windows reports no Unix permission bits; the file's ACL is not checked here.
	if err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("pi-catalog.json %v, %v", info, err)
	}

	// A quit unloaded it: Pi lists only its own model.
	fake.write("status.json", status(model(testModel, "idle")))
	library.Refresh(context.Background())
	merged := library.MergePiCatalog(piDiagnostic("ready", defaultModel), nil)
	if len(merged[1].Models) != 2 || !merged[1].Models[0].IsDefault {
		t.Fatalf("merged = %+v", merged[1].Models)
	}
	got := merged[1].Models[1]
	if got.ID != testPiModel || got.Label != listed.Label || got.DefaultReasoningEffort != "high" || !slices.Equal(got.AllowedReasoningEffort, listed.AllowedReasoningEffort) || got.ContextWindow != 32768 || got.IsDefault {
		t.Fatalf("remembered entry = %+v", got)
	}
	if len(merged[0].Models) != 1 {
		t.Fatalf("another Runtime changed: %+v", merged[0])
	}
}

func TestTheMergedPiCatalogListsEveryDownloadedModelOnly(t *testing.T) {
	fake := newFakeTool(t)
	stopped := secondRow("failed")
	stopped["error"] = map[string]any{"code": "DOWNLOAD_FAILED", "detail": "stopped"}
	stopped["pi_model"] = secondPiModel
	downloading := model("downloading-1b:Q4_K_M", "downloading")
	downloading["pi_model"] = "localmodels-library/downloading"
	fake.write("status.json", status(model(testModel, "idle"), stopped, downloading, model("absent-1b:Q4_K_M", "absent")))
	library := catalogLibrary(t, fake)
	merged := library.MergePiCatalog(piDiagnostic("ready"), nil)
	if !slices.Equal(modelIDs(merged[1]), []string{testPiModel}) {
		t.Fatalf("models = %v", modelIDs(merged[1]))
	}
	entry := merged[1].Models[0]
	if entry.Label != "Qwen3 4B" || entry.ContextWindow != 32768 || len(entry.AllowedReasoningEffort) != 0 || entry.AllowedReasoningEffort == nil || entry.DefaultReasoningEffort != "" || entry.IsDefault {
		t.Fatalf("row-derived entry = %+v", entry)
	}
}

func TestLibraryModelsMakeAnEmptyPiCatalogReady(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	library := catalogLibrary(t, fake)
	merged := library.MergePiCatalog(piDiagnostic("authentication_required"), nil)
	if merged[1].Status != "ready" || merged[1].Error != nil || len(merged[1].Models) != 1 {
		t.Fatalf("pi = %+v", merged[1])
	}
	// Another reason stays.
	errored := piDiagnostic("error")
	errored[1].Error = &provider.DiagnosticError{Code: "RUNTIME_DIAGNOSTIC_FAILED"}
	if got := library.MergePiCatalog(errored, nil)[1]; got.Status != "error" {
		t.Fatalf("pi = %+v", got)
	}

	empty := newFakeTool(t)
	empty.write("status.json", status())
	if got := catalogLibrary(t, empty).MergePiCatalog(piDiagnostic("authentication_required"), nil)[1]; got.Status != "authentication_required" || len(got.Models) != 0 {
		t.Fatalf("pi without library models = %+v", got)
	}
}

func TestABYOKPiSourceGetsNoLibraryModels(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	library := catalogLibrary(t, fake)
	byok := []provider.RuntimeModel{{ID: "localmodels-byok", Label: "My model", AllowedReasoningEffort: []string{}, IsDefault: true}}
	merged := library.MergePiCatalog(piDiagnostic("ready", byok...), &OverlayState{Mode: "byok", Runtime: "pi"})
	if !slices.Equal(modelIDs(merged[1]), []string{"localmodels-byok"}) {
		t.Fatalf("models = %v", modelIDs(merged[1]))
	}
}

func TestRememberedPiEntriesFollowTheLibrary(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "loaded")))
	library := catalogLibrary(t, fake)
	if err := os.WriteFile(library.piCatalogPath(), []byte(`{"schema":"elsewhere/v9"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	listed := provider.RuntimeModel{ID: testPiModel, Label: "First", AllowedReasoningEffort: []string{}}
	library.MergePiCatalog(piDiagnostic("ready", listed), nil)
	listed.Label = "Second"
	library.MergePiCatalog(piDiagnostic("ready", listed), nil)
	if remembered := library.readPiCatalog(); remembered[testPiModel].Label != "Second" {
		t.Fatalf("remembered = %+v", remembered)
	}
	// Removed from the Computer: its entry goes.
	fake.write("status.json", status(model(testModel, "absent")))
	library.Refresh(context.Background())
	library.MergePiCatalog(piDiagnostic("ready"), nil)
	encoded, _ := os.ReadFile(library.piCatalogPath())
	var document piCatalogFile
	if err := json.Unmarshal(encoded, &document); err != nil || document.Schema != piCatalogSchema || len(document.Models) != 0 {
		t.Fatalf("pi-catalog.json = %s (%v)", encoded, err)
	}
}

func TestTheCatalogChangesWhenTheDownloadedModelsDo(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	changes := 0
	library := New(Options{
		Tool: &fake.tool, Environment: map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory: t.TempDir() + "/jobs", CatalogChanged: func() { changes++ },
	})
	t.Cleanup(library.Close)
	library.Refresh(context.Background())
	if changes != 1 {
		t.Fatalf("first read with a library model: %d changes", changes)
	}
	library.Refresh(context.Background())
	fake.write("status.json", status(model(testModel, "loaded")))
	library.Refresh(context.Background())
	if changes != 1 {
		t.Fatalf("unchanged models: %d changes", changes)
	}
	fake.write("status.json", status(model(testModel, "loaded"), secondRow("idle")))
	library.Refresh(context.Background())
	if changes != 2 {
		t.Fatalf("a new download: %d changes", changes)
	}
}

func rememberedCatalog(t *testing.T, models ...provider.RuntimeModel) *PiCatalog {
	t.Helper()
	directory := t.TempDir()
	document := piCatalogFile{Schema: piCatalogSchema, Models: map[string]provider.RuntimeModel{}}
	for _, model := range models {
		document.Models[model.ID] = model
	}
	encoded, _ := json.Marshal(document)
	if err := os.WriteFile(directory+"/"+piCatalogFileName, encoded, 0o600); err != nil {
		t.Fatal(err)
	}
	// A crash left a temporary write behind.
	if err := os.WriteFile(directory+"/"+piCatalogTempPrefix+"stale", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	return NewPiCatalog(directory)
}

// Before the Library has read anything, the first discovery and the hello
// already list what Pi listed while the models were loaded.
func TestRememberedEntriesStandInBeforeTheFirstRead(t *testing.T) {
	entry := provider.RuntimeModel{ID: testPiModel, Label: "Qwen3 4B", AllowedReasoningEffort: []string{"high"}, DefaultReasoningEffort: "high"}
	catalog := rememberedCatalog(t, entry)
	if _, err := os.Stat(filepath.Dir(catalog.path) + "/" + piCatalogTempPrefix + "stale"); err == nil {
		t.Fatal("a stale temporary write was left")
	}
	merged := catalog.Merge(piDiagnostic("authentication_required"), nil, nil)
	if merged[1].Status != "ready" || !slices.Equal(modelIDs(merged[1]), []string{testPiModel}) || merged[1].Models[0].DefaultReasoningEffort != "high" {
		t.Fatalf("pi = %+v", merged[1])
	}
	if !catalog.LibraryOnly() {
		t.Fatal("Pi is ready only through library models")
	}
	// A failed read keeps them.
	unreadable := unavailable(CodeToolFailed, "", time.Now())
	if got := catalog.Merge(piDiagnostic("authentication_required"), nil, &unreadable)[1]; got.Status != "ready" {
		t.Fatalf("pi after a failed read = %+v", got)
	}
}

func TestOnlyTheManagedLocalSourceGetsLibraryModels(t *testing.T) {
	entry := provider.RuntimeModel{ID: testPiModel, Label: "Qwen3 4B", AllowedReasoningEffort: []string{}}
	for _, tc := range []struct {
		source *OverlayState
		merges bool
	}{
		{nil, true},
		{&OverlayState{Mode: "local"}, true},
		{&OverlayState{Mode: "subscription"}, false},
		{&OverlayState{Mode: "byok", Runtime: "pi"}, false},
		{&OverlayState{Mode: "byok", Runtime: "claude"}, false},
	} {
		catalog := rememberedCatalog(t, entry)
		got := catalog.Merge(piDiagnostic("authentication_required"), tc.source, nil)[1]
		if (len(got.Models) == 1) != tc.merges || (got.Status == "ready") != tc.merges {
			t.Fatalf("source %+v: pi = %+v", tc.source, got)
		}
	}
}

func TestOnlyAReadyOrSignedOutPiGetsLibraryModels(t *testing.T) {
	entry := provider.RuntimeModel{ID: testPiModel, Label: "Qwen3 4B", AllowedReasoningEffort: []string{}}
	for _, status := range []string{"not_installed", "error"} {
		got := rememberedCatalog(t, entry).Merge(piDiagnostic(status), nil, nil)[1]
		if got.Status != status || len(got.Models) != 0 {
			t.Fatalf("%s: pi = %+v", status, got)
		}
	}
}

func TestLibraryModelsStayWithinTheCatalogBound(t *testing.T) {
	var own []provider.RuntimeModel
	for i := range provider.MaxRuntimeModels - 1 {
		own = append(own, provider.RuntimeModel{ID: fmt.Sprintf("own/%03d", i), AllowedReasoningEffort: []string{}})
	}
	long := strings.Repeat("x", provider.MaxRuntimeModelTextRunes+1)
	catalog := rememberedCatalog(t,
		provider.RuntimeModel{ID: "lib/a", Label: "A", AllowedReasoningEffort: []string{}},
		provider.RuntimeModel{ID: "lib/b", AllowedReasoningEffort: []string{}},
		provider.RuntimeModel{ID: long, AllowedReasoningEffort: []string{}},
	)
	got := catalog.Merge(piDiagnostic("ready", own...), nil, nil)[1]
	if len(got.Models) != provider.MaxRuntimeModels || got.Models[len(got.Models)-1].ID != "lib/a" {
		t.Fatalf("%d models, last %+v", len(got.Models), got.Models[len(got.Models)-1])
	}
}

func TestTheCatalogChangesWhenTheLibraryCanBeReadAgain(t *testing.T) {
	fake := newFakeTool(t)
	fake.write("status.json", status(model(testModel, "idle")))
	changes := 0
	library := New(Options{
		Tool: &fake.tool, Environment: map[string]string{"LOCALMODELS_FAKE_TOOL": "1", "PATH": os.Getenv("PATH")},
		JobDirectory: t.TempDir() + "/jobs", CatalogChanged: func() { changes++ }, ProgressInterval: time.Hour,
	})
	t.Cleanup(library.Close)
	library.Refresh(context.Background())
	failing := filepath.Join(fake.state, "status-exit")
	if err := os.WriteFile(failing, []byte("1"), 0o600); err != nil {
		t.Fatal(err)
	}
	library.Refresh(context.Background())
	_ = os.Remove(failing)
	library.Refresh(context.Background())
	if changes != 2 {
		t.Fatalf("%d changes, want the first read and the recovery", changes)
	}
}

// A remembered entry the catalog cannot carry is dropped, never sent, and
// the condition is logged once, not on every discovery.
func TestInvalidRememberedEntriesAreDroppedAndLoggedOnce(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	t.Cleanup(func() { slog.SetDefault(previous) })
	valid := provider.RuntimeModel{ID: "lib/valid", Label: "Valid", AllowedReasoningEffort: []string{"high"}, DefaultReasoningEffort: "high"}
	catalog := rememberedCatalog(t,
		valid,
		provider.RuntimeModel{ID: "lib/effort", Label: "Effort", AllowedReasoningEffort: []string{"turbo"}},
		provider.RuntimeModel{ID: "lib/window", Label: "Window", AllowedReasoningEffort: []string{}, ContextWindow: provider.MaxRuntimeModelContextWindow + 1},
	)
	for range 3 {
		got := catalog.Merge(piDiagnostic("ready"), nil, nil)[1]
		if !slices.Equal(modelIDs(got), []string{"lib/valid"}) {
			t.Fatalf("models = %v", modelIDs(got))
		}
		for _, model := range got.Models {
			if !provider.ValidRuntimeModel(model) {
				t.Fatalf("sent an invalid entry %+v", model)
			}
		}
	}
	if count := strings.Count(logs.String(), "local_models.pi_catalog_invalid"); count != 1 {
		t.Fatalf("logged %d times:\n%s", count, logs.String())
	}
}

func TestARowDerivedEntryStaysWithinTheBounds(t *testing.T) {
	fake := newFakeTool(t)
	row := model(testModel, "idle")
	row["context_tokens"] = provider.MaxRuntimeModelContextWindow * 10
	row["name"] = strings.Repeat("y", provider.MaxRuntimeModelTextRunes+5)
	fake.write("status.json", status(row))
	got := catalogLibrary(t, fake).MergePiCatalog(piDiagnostic("ready"), nil)[1]
	if len(got.Models) != 1 || got.Models[0].ContextWindow != provider.MaxRuntimeModelContextWindow ||
		len([]rune(got.Models[0].Label)) != provider.MaxRuntimeModelTextRunes {
		t.Fatalf("models = %+v", got.Models)
	}
}
