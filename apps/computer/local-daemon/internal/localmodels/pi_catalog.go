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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

// piCatalogSchema versions the file of remembered Pi catalog entries.
const piCatalogSchema = "linger.local-models-pi-catalog/v1"

// piCatalogFileName sits beside the Library's job directory.
const piCatalogFileName = "pi-catalog.json"

// piCatalogTempPrefix names the files a write renames into place.
const piCatalogTempPrefix = ".pi-catalog-"

type piCatalogFile struct {
	Schema string                           `json:"schema"`
	Models map[string]provider.RuntimeModel `json:"models"`
}

// PiCatalog adds this Computer's downloaded library models to the Pi
// diagnostic the Daemon reports. localmodels registers a model with Pi only
// while it is loaded, so after a quit unloads it Pi no longer lists it, and
// the Agent Service would refuse every Run on it before the Daemon could
// load it again.
//
// A model Pi listed before keeps the entry Pi gave it, remembered in
// pi-catalog.json, so an Agent's reasoning effort stays valid; a model Pi
// never listed gets an entry without reasoning effort. Pi's own entries and
// its default are left as they are and come first within the catalog
// bound.
type PiCatalog struct {
	path string
	mu   sync.Mutex
	// libraryOnly is whether the last merge reported Pi ready only because
	// library models filled its empty catalog.
	libraryOnly atomic.Bool
	// reported holds, by log event, the condition last logged, so a
	// condition that lasts is logged once, not on every discovery.
	reportedMu sync.Mutex
	reported   map[string]string
}

// report logs event when its condition differs from the one last logged; an
// empty condition clears it.
func (c *PiCatalog) report(event, condition string, attrs ...any) {
	c.reportedMu.Lock()
	defer c.reportedMu.Unlock()
	if condition == "" {
		delete(c.reported, event)
		return
	}
	if c.reported[event] == condition {
		return
	}
	if c.reported == nil {
		c.reported = make(map[string]string)
	}
	c.reported[event] = condition
	slog.Warn(event, attrs...)
}

// NewPiCatalog returns the catalog kept in directory, the parent of the
// Library's job directory, and removes writes a crash left behind.
func NewPiCatalog(directory string) *PiCatalog {
	if entries, err := os.ReadDir(directory); err == nil {
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), piCatalogTempPrefix) {
				_ = os.Remove(filepath.Join(directory, entry.Name()))
			}
		}
	}
	return &PiCatalog{path: filepath.Join(directory, piCatalogFileName)}
}

// LibraryOnly reports whether Pi is ready only because of library models:
// none is loaded, so Pi has no model to answer a call that names none.
func (c *PiCatalog) LibraryOnly() bool {
	return c != nil && c.libraryOnly.Load()
}

// Merge returns diagnostics with the library models added to Pi's.
// diagnostics must hold Pi's own catalog, not an earlier merge. snapshot is
// the Library's last read; until one succeeds, the remembered entries stand
// in for it, since each was a library model. Nothing is added unless Pi
// runs on the managed local models source (none saved, or local), or when
// Pi is neither ready nor only waiting for a sign-in. A Pi that reports
// authentication_required only because its own catalog was empty is ready
// once library models fill it.
func (c *PiCatalog) Merge(diagnostics []provider.RuntimeDiagnostic, source *OverlayState, snapshot *wire.LocalModelsSnapshot) []provider.RuntimeDiagnostic {
	if c == nil {
		return diagnostics
	}
	index := slices.IndexFunc(diagnostics, func(diagnostic provider.RuntimeDiagnostic) bool { return diagnostic.Type == "pi" })
	if index < 0 || (source != nil && source.Mode != "local") {
		c.libraryOnly.Store(false)
		return diagnostics
	}
	pi := diagnostics[index]
	if pi.Status != "ready" && pi.Status != "authentication_required" {
		c.libraryOnly.Store(false)
		return diagnostics
	}
	var library []provider.RuntimeModel
	if snapshot != nil && snapshot.Available {
		remembered := c.remember(pi.Models, snapshot.Models)
		for _, row := range snapshot.Models {
			if !InPiCatalog(row) {
				continue
			}
			entry, ok := remembered[row.PiModel]
			if !ok {
				entry = provider.RuntimeModel{ID: row.PiModel, Label: row.Name, AllowedReasoningEffort: []string{}}
				if row.ContextTokens > 0 {
					entry.ContextWindow = int(min(row.ContextTokens, uint64(provider.MaxRuntimeModelContextWindow)))
				}
			}
			library = append(library, entry)
		}
	} else {
		c.mu.Lock()
		remembered := c.read()
		c.mu.Unlock()
		ids := make([]string, 0, len(remembered))
		for id := range remembered {
			ids = append(ids, id)
		}
		slices.Sort(ids)
		for _, id := range ids {
			library = append(library, remembered[id])
		}
	}
	models := slices.Clone(pi.Models)
	dropped := 0
	for _, entry := range library {
		if entry.ID == "" || len([]rune(entry.ID)) > provider.MaxRuntimeModelTextRunes ||
			slices.ContainsFunc(models, func(model provider.RuntimeModel) bool { return model.ID == entry.ID }) {
			continue
		}
		if len(models) >= provider.MaxRuntimeModels {
			dropped++
			continue
		}
		if entry.Label == "" {
			entry.Label = entry.ID
		}
		entry.Label = provider.ClipRuntimeModelLabel(entry.Label)
		entry.IsDefault = false
		if entry.AllowedReasoningEffort == nil {
			entry.AllowedReasoningEffort = []string{}
		}
		if !provider.ValidRuntimeModel(entry) {
			continue
		}
		models = append(models, entry)
	}
	truncated := ""
	if dropped > 0 {
		truncated = strconv.Itoa(dropped)
	}
	c.report("local_models.pi_catalog_truncated", truncated, "dropped", dropped)
	libraryOnly := len(models) > len(pi.Models) && len(pi.Models) == 0 && pi.Status == "authentication_required" &&
		pi.Error != nil && pi.Error.Code == "RUNTIME_AUTHENTICATION_REQUIRED"
	c.libraryOnly.Store(libraryOnly)
	if len(models) == len(pi.Models) {
		return diagnostics
	}
	if libraryOnly {
		// Pi asks for a sign-in only because it listed no model; a local
		// model needs none.
		pi.Status, pi.Error = "ready", nil
	}
	pi.Models = models
	shaped := slices.Clone(diagnostics)
	shaped[index] = pi
	return shaped
}

// remember records the entry Pi gives each library model it lists, forgets
// models no longer in the library, and returns the remembered entries.
func (c *PiCatalog) remember(listed []provider.RuntimeModel, rows []wire.LocalModel) map[string]provider.RuntimeModel {
	c.mu.Lock()
	defer c.mu.Unlock()
	remembered := c.read()
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
		c.write(remembered)
	}
	return remembered
}

func sameRuntimeModel(left, right provider.RuntimeModel) bool {
	encodedLeft, errLeft := json.Marshal(left)
	encodedRight, errRight := json.Marshal(right)
	return errLeft == nil && errRight == nil && bytes.Equal(encodedLeft, encodedRight)
}

// read returns the remembered entries; a missing or unreadable file is
// empty, and the next change replaces an unreadable one. The caller holds
// mu.
func (c *PiCatalog) read() map[string]provider.RuntimeModel {
	models := make(map[string]provider.RuntimeModel)
	encoded, err := os.ReadFile(c.path)
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
		c.report("local_models.pi_catalog_invalid", err.Error(), "error", err)
		return models
	}
	invalid := 0
	for id, model := range document.Models {
		// An entry the catalog could not carry is dropped, never sent.
		if id == "" || model.ID != id || !provider.ValidRuntimeModel(model) {
			invalid++
			continue
		}
		models[id] = model
	}
	condition := ""
	if invalid > 0 {
		condition = "entries:" + strconv.Itoa(invalid)
	}
	c.report("local_models.pi_catalog_invalid", condition, "invalid_entries", invalid)
	return models
}

// write replaces the file whole, so a crash leaves the old entries or the
// new ones. The caller holds mu.
func (c *PiCatalog) write(models map[string]provider.RuntimeModel) {
	directory := filepath.Dir(c.path)
	err := func() error {
		encoded, err := json.Marshal(piCatalogFile{Schema: piCatalogSchema, Models: models})
		if err != nil {
			return err
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		temp, err := os.CreateTemp(directory, piCatalogTempPrefix+"*")
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
			err = os.Rename(temp.Name(), c.path)
		}
		if err != nil {
			_ = os.Remove(temp.Name())
		}
		return err
	}()
	if err != nil {
		slog.Warn("local_models.pi_catalog_write_failed", "error", err)
		return
	}
	// The rename is durable only once the directory is; Windows cannot
	// sync a directory, and the file itself is already synced.
	if handle, err := os.Open(directory); err == nil {
		_ = handle.Sync()
		_ = handle.Close()
	}
}
