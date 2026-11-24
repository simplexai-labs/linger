package localmodels

import (
	"context"
	"encoding/json"
	"os"
	"slices"
	"testing"

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

func catalogLibrary(t *testing.T, fake *fakeTool) *Library {
	t.Helper()
	library := newEnsureLibrary(t, fake, 0)
	library.Refresh(context.Background())
	return library
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
	if err != nil || info.Mode().Perm() != 0o600 {
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
