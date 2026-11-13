package localmodels

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	statusSchema = "localmodels.library-status/v1"
	eventSchema  = "localmodels.library-event/v1"
)

// Unavailable reason codes of a LocalModelsSnapshot, and the refusal codes
// the Daemon adds to the tool's own.
const (
	CodeToolNotInstalled = "TOOL_NOT_INSTALLED"
	CodeToolFailed       = "TOOL_FAILED"
)

// errorCodes is the tool's closed error set (LocalModelErrorCode).
var errorCodes = []string{
	"MODEL_UNKNOWN", "INVALID_STATE", "JOB_RUNNING", "MEMORY_INSUFFICIENT", "DISK_INSUFFICIENT",
	"PLATFORM_UNSUPPORTED", "LOAD_NO_ROOM", "DOWNLOAD_FAILED", "CHECKSUM_MISMATCH", "NETWORK_UNAVAILABLE",
	"ENGINE_START_FAILED", "HEALTH_CHECK_FAILED", "OUT_OF_MEMORY", "MODEL_FILES_MISSING",
	"GATEWAY_REGISTRATION_FAILED", "CANCELLED",
}

var modelIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`)

// ValidModelID reports whether id is a LocalModelId the tool may be given as
// an argument.
func ValidModelID(id string) bool { return modelIDPattern.MatchString(id) }

// unavailable is the snapshot of a Computer whose library cannot be read.
func unavailable(code, detail string, now time.Time) wire.LocalModelsSnapshot {
	return wire.LocalModelsSnapshot{
		Available:  false,
		Reason:     &wire.LocalModelsUnavailableReason{Code: code, Detail: clip(detail, 4000)},
		ObservedAt: now.UTC().Format(time.RFC3339),
		Pools:      []wire.LocalModelPool{}, Models: []wire.LocalModel{},
	}
}

// libraryStatus is localmodels.library-status/v1. Its host and model entries
// already use the wire field names; pools gain kind and gpu_index here.
type libraryStatus struct {
	Schema      string               `json:"schema"`
	ToolVersion string               `json:"tool_version"`
	ObservedAt  string               `json:"observed_at"`
	Host        *wire.LocalModelHost `json:"host"`
	Pools       []struct {
		ID         string                      `json:"id"`
		TotalBytes uint64                      `json:"total_bytes"`
		UsedBytes  uint64                      `json:"used_bytes"`
		Holders    []wire.LocalModelPoolHolder `json:"holders"`
	} `json:"pools"`
	Models []wire.LocalModel `json:"models"`
}

// mapStatus turns one library-status/v1 document into the wire snapshot. A
// value outside the contract's closed sets makes the whole document invalid:
// the reader would otherwise show a state nobody defined.
func mapStatus(encoded []byte, now time.Time) (wire.LocalModelsSnapshot, error) {
	var status libraryStatus
	if err := json.Unmarshal(encoded, &status); err != nil {
		return wire.LocalModelsSnapshot{}, fmt.Errorf("decode library status: %w", err)
	}
	if status.Schema != statusSchema {
		return wire.LocalModelsSnapshot{}, fmt.Errorf("library status schema is %q", status.Schema)
	}
	if status.Host == nil {
		return wire.LocalModelsSnapshot{}, errors.New("library status has no host")
	}
	host := *status.Host
	// The tool reports the machine's own architecture name; the wire knows two.
	switch host.Arch {
	case "amd64":
		host.Arch = "x86_64"
	case "aarch64":
		host.Arch = "arm64"
	}
	if !slices.Contains([]string{"linux", "darwin", "windows"}, host.Platform) || (host.Arch != "x86_64" && host.Arch != "arm64") {
		return wire.LocalModelsSnapshot{}, fmt.Errorf("library status host %s/%s is outside the contract", status.Host.Platform, status.Host.Arch)
	}
	host.OsLabel, host.EngineLabel = clip(host.OsLabel, 200), clip(host.EngineLabel, 200)
	if host.Gpus == nil {
		host.Gpus = []wire.LocalModelGpu{}
	}
	observedAt := now.UTC().Format(time.RFC3339)
	if parsed, err := time.Parse(time.RFC3339, status.ObservedAt); err == nil {
		observedAt = parsed.UTC().Format(time.RFC3339)
	}
	snapshot := wire.LocalModelsSnapshot{
		Available: true, ObservedAt: observedAt, ToolVersion: clip(status.ToolVersion, 64), Host: &host,
		Pools: make([]wire.LocalModelPool, 0, len(status.Pools)), Models: make([]wire.LocalModel, 0, len(status.Models)),
	}
	for _, pool := range status.Pools {
		kind, index, err := poolKind(pool.ID)
		if err != nil {
			return wire.LocalModelsSnapshot{}, err
		}
		holders := pool.Holders
		if holders == nil {
			holders = []wire.LocalModelPoolHolder{}
		}
		for _, holder := range holders {
			if holder.Kind != "model" && holder.Kind != "component" {
				return wire.LocalModelsSnapshot{}, fmt.Errorf("pool holder kind %q is outside the contract", holder.Kind)
			}
		}
		snapshot.Pools = append(snapshot.Pools, wire.LocalModelPool{
			ID: pool.ID, Kind: kind, GpuIndex: index, TotalBytes: pool.TotalBytes, UsedBytes: pool.UsedBytes, Holders: holders,
		})
	}
	for _, model := range status.Models {
		if err := checkModel(model); err != nil {
			return wire.LocalModelsSnapshot{}, err
		}
		model.Description = clip(model.Description, 2000)
		// Only a loaded model answers at an endpoint; Agents reach it through
		// Pi by pi_model.
		if model.State != "loaded" {
			model.Endpoint = nil
		}
		if model.Error != nil {
			model.Error.Detail = clip(model.Error.Detail, 4000)
		}
		snapshot.Models = append(snapshot.Models, model)
	}
	return snapshot, nil
}

// poolKind splits a pool id so no reader parses "gpu:1".
func poolKind(id string) (string, *uint64, error) {
	switch {
	case id == "system" || id == "unified":
		return id, nil, nil
	case strings.HasPrefix(id, "gpu:"):
		index, err := strconv.ParseUint(strings.TrimPrefix(id, "gpu:"), 10, 16)
		if err == nil && index < 1000 && strconv.FormatUint(index, 10) == strings.TrimPrefix(id, "gpu:") {
			return "gpu", &index, nil
		}
	}
	return "", nil, fmt.Errorf("pool id %q is outside the contract", id)
}

func checkModel(model wire.LocalModel) error {
	invalid := func(field, value string) error {
		return fmt.Errorf("model %s %s %q is outside the contract", model.ID, field, value)
	}
	if !ValidModelID(model.ID) {
		return invalid("id", model.ID)
	}
	if !slices.Contains([]string{"gpu", "unified", "system", "none"}, model.Fit) {
		return invalid("fit", model.Fit)
	}
	if !slices.Contains([]string{"absent", "downloading", "idle", "loading", "loaded", "failed"}, model.State) {
		return invalid("state", model.State)
	}
	// A model that fits nowhere has no pool.
	if _, _, err := poolKind(model.Pool); err != nil && (model.Pool != "" || model.Fit != "none") {
		return invalid("pool", model.Pool)
	}
	if reason := model.Availability.Reason; reason != nil &&
		!slices.Contains([]string{"MEMORY_INSUFFICIENT", "DISK_INSUFFICIENT", "PLATFORM_UNSUPPORTED"}, reason.Code) {
		return invalid("availability reason", reason.Code)
	}
	if model.Download != nil && model.Download.Step != "download" && model.Download.Step != "verify" {
		return invalid("download step", model.Download.Step)
	}
	if model.Error != nil && !slices.Contains(errorCodes, model.Error.Code) {
		return invalid("error code", model.Error.Code)
	}
	if model.Note != nil && model.Note.Code != "NO_ROOM_TO_LOAD" {
		return invalid("note", model.Note.Code)
	}
	// An Agent stores pi_model as its runtime_model, so it is never cut.
	if len(model.PiModel) > 200 {
		return invalid("pi_model", model.PiModel)
	}
	if model.TokensPerSecond != nil && (math.IsNaN(*model.TokensPerSecond) || *model.TokensPerSecond < 0) {
		return errors.New("model tokens_per_second is outside the contract")
	}
	return nil
}

// libraryEvent is one localmodels.library-event/v1 line, or the one document
// a JSON command prints. Counters are read as numbers and clamped, since the
// reader only displays them.
type libraryEvent struct {
	Schema         string          `json:"schema"`
	Event          string          `json:"event"`
	Model          json.RawMessage `json:"model"`
	Phase          string          `json:"phase"`
	Done           float64         `json:"done"`
	Total          float64         `json:"total"`
	BytesPerSecond float64         `json:"bytes_per_second"`
	OK             bool            `json:"ok"`
	Code           string          `json:"code"`
	Detail         string          `json:"detail"`
	Pool           string          `json:"pool"`
	NeedBytes      *float64        `json:"need_bytes"`
	FreeBytes      *float64        `json:"free_bytes"`
	HaveBytes      *float64        `json:"have_bytes"`
}

func parseEvent(line []byte) (libraryEvent, bool) {
	var event libraryEvent
	if err := json.Unmarshal(line, &event); err != nil || event.Schema != eventSchema {
		return libraryEvent{}, false
	}
	switch event.Event {
	case "progress", "result", "error":
		return event, true
	}
	return libraryEvent{}, false
}

// modelID is the progress line's model, which is the id string.
func (e libraryEvent) modelID() string {
	var id string
	if json.Unmarshal(e.Model, &id) == nil {
		return id
	}
	return ""
}

// refusal turns the tool's error into the wire refusal. A code outside the
// closed set means the tool broke its contract.
func (e libraryEvent) refusal() *wire.LocalModelActionRefusal {
	if !slices.Contains(errorCodes, e.Code) {
		return &wire.LocalModelActionRefusal{Code: CodeToolFailed, Detail: "localmodels reported an error outside its contract"}
	}
	refusal := &wire.LocalModelActionRefusal{Code: e.Code, Detail: clip(e.Detail, 4000)}
	if _, _, err := poolKind(e.Pool); err == nil {
		refusal.Pool = e.Pool
	}
	refusal.NeedBytes = counter(e.NeedBytes)
	refusal.FreeBytes = counter(e.FreeBytes)
	if refusal.FreeBytes == nil {
		// Download refusals name what the disk or memory has as have_bytes.
		refusal.FreeBytes = counter(e.HaveBytes)
	}
	return refusal
}

func counter(value *float64) *uint64 {
	if value == nil {
		return nil
	}
	result := bytesValue(*value)
	return &result
}

func bytesValue(value float64) uint64 {
	if math.IsNaN(value) || value <= 0 {
		return 0
	}
	if value >= 1<<53 {
		return 1 << 53
	}
	return uint64(value)
}

// clip bounds display text to the schema's length in characters.
func clip(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}
