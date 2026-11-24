package localmodels

import (
	"bytes"
	"encoding/json"
	"errors"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"slices"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// piCatalogSchema versions the file of remembered Pi catalog entries.
const piCatalogSchema = "linger.local-models-pi-catalog/v1"

// piCatalogFileName sits beside the job directory, which New clears.
const piCatalogFileName = "pi-catalog.json"

type piCatalogFile struct {
	Schema string                           `json:"schema"`
	Models map[string]provider.RuntimeModel `json:"models"`
}

// MergePiCatalog adds this Computer's downloaded library models to the Pi
// diagnostic. localmodels registers a model with Pi only while it is loaded,
// so after a quit unloads it Pi no longer lists it, and the Agent Service
// would refuse every Run on it before the Daemon could load it again.
//
// A model Pi listed before keeps the entry Pi gave it, remembered in
// pi-catalog.json, so an Agent's reasoning effort stays valid; one Pi never
// listed gets an entry without reasoning effort. Pi's own entries and its
// default are left as they are. A Pi diagnostic that reports
// authentication_required only because its own catalog was empty is ready
// once library models fill it. Nothing changes while the library cannot be
// read or when Pi runs on a BYOK source, whose catalog is that one model.
func (l *Library) MergePiCatalog(diagnostics []provider.RuntimeDiagnostic, source *OverlayState) []provider.RuntimeDiagnostic {
	if source != nil && source.Mode == "byok" && source.Runtime == "pi" {
		return diagnostics
	}
	snapshot := l.Snapshot()
	if snapshot == nil || !snapshot.Available {
		return diagnostics
	}
	index := slices.IndexFunc(diagnostics, func(diagnostic provider.RuntimeDiagnostic) bool { return diagnostic.Type == "pi" })
	if index < 0 {
		return diagnostics
	}
	pi := diagnostics[index]
	remembered := l.rememberPiCatalog(pi.Models, snapshot.Models)
	models := slices.Clone(pi.Models)
	for _, row := range snapshot.Models {
		if !InPiCatalog(row) || slices.ContainsFunc(models, func(model provider.RuntimeModel) bool { return model.ID == row.PiModel }) {
			continue
		}
		entry, ok := remembered[row.PiModel]
		if !ok {
			entry = provider.RuntimeModel{ID: row.PiModel, Label: row.Name, AllowedReasoningEffort: []string{}}
			if entry.Label == "" {
				entry.Label = row.PiModel
			}
			if row.ContextTokens > 0 {
				entry.ContextWindow = int(row.ContextTokens)
			}
		}
		entry.IsDefault = false
		models = append(models, entry)
	}
	if len(models) == len(pi.Models) {
		return diagnostics
	}
	shaped := slices.Clone(diagnostics)
	if pi.Status == "authentication_required" && pi.Error != nil && pi.Error.Code == "RUNTIME_AUTHENTICATION_REQUIRED" && len(pi.Models) == 0 {
		// Pi asks for a sign-in only because it listed no model; a local
		// model needs none.
		pi.Status, pi.Error = "ready", nil
	}
	pi.Models = models
	shaped[index] = pi
	return shaped
}

// rememberPiCatalog records the entry Pi gives each library model it lists,
// forgets models no longer in the library, and returns the remembered
// entries.
func (l *Library) rememberPiCatalog(listed []provider.RuntimeModel, rows []wire.LocalModel) map[string]provider.RuntimeModel {
	l.piCatalogMu.Lock()
	defer l.piCatalogMu.Unlock()
	remembered := l.readPiCatalog()
	library := make(map[string]bool)
	for _, row := range rows {
		if row.PiModel != "" {
			library[row.PiModel] = true
		}
	}
	changed := false
	for id := range remembered {
		if !library[id] {
			delete(remembered, id)
			changed = true
		}
	}
	for _, model := range listed {
		if !library[model.ID] {
			continue
		}
		model.IsDefault = false
		if previous, ok := remembered[model.ID]; ok && sameRuntimeModel(previous, model) {
			continue
		}
		remembered[model.ID] = model
		changed = true
	}
	if changed {
		l.writePiCatalog(remembered)
	}
	return remembered
}

func sameRuntimeModel(left, right provider.RuntimeModel) bool {
	encodedLeft, errLeft := json.Marshal(left)
	encodedRight, errRight := json.Marshal(right)
	return errLeft == nil && errRight == nil && bytes.Equal(encodedLeft, encodedRight)
}

func (l *Library) piCatalogPath() string {
	if l.jobDirectory == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(l.jobDirectory), piCatalogFileName)
}

// readPiCatalog returns the remembered entries; a missing or unreadable file
// is empty, and the next change replaces an unreadable one.
func (l *Library) readPiCatalog() map[string]provider.RuntimeModel {
	models := make(map[string]provider.RuntimeModel)
	path := l.piCatalogPath()
	if path == "" {
		return models
	}
	encoded, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return models
	}
	var document piCatalogFile
	if err == nil {
		err = json.Unmarshal(encoded, &document)
	}
	if err == nil && document.Schema != piCatalogSchema {
		err = errors.New("unknown schema")
	}
	if err != nil {
		slog.Warn("local_models.pi_catalog_invalid", "error", err)
		return models
	}
	for id, model := range document.Models {
		if id != "" && model.ID == id {
			models[id] = model
		}
	}
	return models
}

// writePiCatalog replaces the file whole, so a crash leaves the old entries
// or the new ones.
func (l *Library) writePiCatalog(models map[string]provider.RuntimeModel) {
	path := l.piCatalogPath()
	if path == "" {
		return
	}
	err := func() error {
		encoded, err := json.Marshal(piCatalogFile{Schema: piCatalogSchema, Models: models})
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return err
		}
		temp, err := os.CreateTemp(filepath.Dir(path), ".pi-catalog-*")
		if err != nil {
			return err
		}
		_, err = temp.Write(encoded)
		if err == nil {
			err = temp.Sync()
		}
		if closeErr := temp.Close(); err == nil {
			err = closeErr
		}
		if err == nil {
			err = os.Chmod(temp.Name(), 0o600)
		}
		if err == nil {
			err = os.Rename(temp.Name(), path)
		}
		if err != nil {
			_ = os.Remove(temp.Name())
		}
		return err
	}()
	if err != nil {
		slog.Warn("local_models.pi_catalog_write_failed", "error", err)
	}
}
