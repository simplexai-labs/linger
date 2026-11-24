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
	CodeToolNotInstalled       = "TOOL_NOT_INSTALLED"
	CodeToolFailed             = "TOOL_FAILED"
	CodeModelSourceUnsupported = "MODEL_SOURCE_UNSUPPORTED"
)

// errorCodes is the tool's closed error set (LocalModelErrorCode), plus
// UNKNOWN_ERROR for forward-compatible degradation of newer tool codes.
var errorCodes = []string{
	"MODEL_UNKNOWN", "INVALID_STATE", "JOB_RUNNING", "MEMORY_INSUFFICIENT", "DISK_INSUFFICIENT",
	"PLATFORM_UNSUPPORTED", "GPU_UNSUPPORTED", "DRIVER_UPDATE_REQUIRED", "RUNTIME_DEPENDENCY_MISSING",
	"LOAD_NO_ROOM", "DOWNLOAD_FAILED", "CHECKSUM_MISMATCH", "NETWORK_UNAVAILABLE",
	"ENGINE_START_FAILED", "HEALTH_CHECK_FAILED", "OUT_OF_MEMORY", "MODEL_FILES_MISSING",
	"GATEWAY_REGISTRATION_FAILED", "CANCELLED", "UNKNOWN_ERROR",
}

var (
	families          = []string{"qwen", "gemma", "llama", "openai", "deepseek", "mistral", "phi", "glm", "kimi", "claude", "grok", "other"}
	architectures     = []string{"dense", "moe"}
	capabilities      = []string{"vision", "tool_use", "reasoning", "coding", "multilingual"}
	engines           = []string{"llama.cpp", "polystrata", "strata"}
	availabilityCodes = []string{
		"MEMORY_INSUFFICIENT", "DISK_INSUFFICIENT", "PLATFORM_UNSUPPORTED",
		"GPU_UNSUPPORTED", "DRIVER_UPDATE_REQUIRED", "RUNTIME_DEPENDENCY_MISSING", "UNAVAILABLE",
	}
	memoryKinds  = []string{"vram", "ram", "unified"}
	gpuVendors   = []string{"amd", "intel", "none", "unknown"}
	debugModes   = []string{"tiny", "simulate"}
	debugSources = []string{"env", "state_config", "user_config"}
)

var (
	modelIDPattern   = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$`)
	sourceURLPattern = regexp.MustCompile(`^https://[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]+$`)
)

// ValidModelID reports whether id is a LocalModelId the tool may be given as
// an argument.
func ValidModelID(id string) bool { return modelIDPattern.MatchString(id) }

// unavailable is the snapshot of a Computer whose library cannot be read.
func unavailable(code, detail string, now time.Time) wire.LocalModelsSnapshot {
	return wire.LocalModelsSnapshot{
		Available:  false,
		Reason:     &wire.LocalModelsUnavailableReason{Code: code, Detail: clip(detail, 4000)},
		ObservedAt: now.UTC().Format(time.RFC3339Nano),
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
		ID              string                      `json:"id"`
		TotalBytes      uint64                      `json:"total_bytes"`
		UsedBytes       uint64                      `json:"used_bytes"`
		Holders         []wire.LocalModelPoolHolder `json:"holders"`
		ExternalHolders []json.RawMessage           `json:"external_holders"`
	} `json:"pools"`
	Models []wire.LocalModel          `json:"models"`
	Debug  *wire.LocalModelsDebugInfo `json:"debug,omitempty"`
}

// mapStatus turns one library-status/v1 document into the wire snapshot.
// Structural and security invariants still reject an invalid document, while
// extensible display/diagnostic enums degrade forward-compatibly so a newer
// localmodels catalog or diagnostic release never bricks the entire library.
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
	observedAt := now.UTC().Format(time.RFC3339Nano)
	if parsed, err := time.Parse(time.RFC3339Nano, status.ObservedAt); err == nil {
		observedAt = parsed.UTC().Format(time.RFC3339Nano)
	}
	snapshot := wire.LocalModelsSnapshot{
		Available: true, ObservedAt: observedAt, ToolVersion: clip(status.ToolVersion, 64), Host: &host,
		Pools: make([]wire.LocalModelPool, 0, len(status.Pools)), Models: make([]wire.LocalModel, 0, len(status.Models)),
		Debug: sanitizeDebugInfo(status.Debug),
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
		for i := range holders {
			if holders[i].Kind != "model" && holders[i].Kind != "component" {
				holders[i].Kind = "component"
			}
		}
		// Only these closeable apps count as other apps in the Web; the rest
		// of used_bytes may be the engine's own memory beyond its holder.
		// A reported list, even [], stays non-nil so it encodes as [] ("none
		// found"); an omitted field stays nil and is not encoded.
		var externalHolders []wire.LocalModelPoolExternalHolder
		if pool.ExternalHolders != nil {
			externalHolders = make([]wire.LocalModelPoolExternalHolder, 0)
		}
		for _, raw := range pool.ExternalHolders {
			if len(externalHolders) >= 256 {
				break
			}
			if holder, ok := externalHolder(raw); ok {
				externalHolders = append(externalHolders, holder)
			}
		}
		snapshot.Pools = append(snapshot.Pools, wire.LocalModelPool{
			ID: pool.ID, Kind: kind, GpuIndex: index, TotalBytes: pool.TotalBytes, UsedBytes: pool.UsedBytes,
			Holders: holders, ExternalHolders: externalHolders,
		})
	}
	for _, model := range status.Models {
		sanitizeModel(&model)
		if err := checkModel(model); err != nil {
			return wire.LocalModelsSnapshot{}, err
		}
		model.Description = clip(model.Description, 2000)
		// Only a loaded model answers at an endpoint; Agents reach it through
		// Pi by pi_model.
		if model.State != "loaded" {
			model.Endpoint = nil
		}
		// concurrency_probing is owned by the Daemon's post-load probe and
		// never comes from localmodels directly.
		model.ConcurrencyProbing = nil
		if model.Error != nil {
			model.Error.Detail = clip(model.Error.Detail, 4000)
		}
		snapshot.Models = append(snapshot.Models, model)
	}
	return snapshot, nil
}

func sanitizeDebugInfo(raw *wire.LocalModelsDebugInfo) *wire.LocalModelsDebugInfo {
	if raw == nil || !slices.Contains(debugModes, raw.Mode) || !slices.Contains(debugSources, raw.Source) {
		return nil
	}
	info := &wire.LocalModelsDebugInfo{Mode: raw.Mode, Source: raw.Source}
	if raw.Source != "env" {
		if path := clip(strings.TrimSpace(raw.ConfigPath), 4096); path != "" {
			info.ConfigPath = path
		}
	}
	return info
}

func sanitizeReason(reason *wire.LocalModelAvailabilityReason) *wire.LocalModelAvailabilityReason {
	if reason == nil {
		return nil
	}
	if !slices.Contains(availabilityCodes, reason.Code) {
		return &wire.LocalModelAvailabilityReason{Code: "UNAVAILABLE"}
	}
	cleaned := &wire.LocalModelAvailabilityReason{
		Code:          reason.Code,
		NeedBytes:     reason.NeedBytes,
		HaveBytes:     reason.HaveBytes,
		RequiredCuda:  clip(strings.TrimSpace(reason.RequiredCuda), 32),
		DetectedCuda:  clip(strings.TrimSpace(reason.DetectedCuda), 32),
		DriverVersion: clip(strings.TrimSpace(reason.DriverVersion), 64),
		RequiredGlibc: clip(strings.TrimSpace(reason.RequiredGlibc), 32),
		DetectedGlibc: clip(strings.TrimSpace(reason.DetectedGlibc), 32),
	}
	if slices.Contains(memoryKinds, reason.MemoryKind) {
		cleaned.MemoryKind = reason.MemoryKind
	}
	if slices.Contains(gpuVendors, reason.GpuVendor) {
		cleaned.GpuVendor = reason.GpuVendor
	}
	if len(reason.MissingLibraries) > 0 {
		libs := make([]string, 0, min(len(reason.MissingLibraries), 16))
		for _, lib := range reason.MissingLibraries {
			trimmed := clip(strings.TrimSpace(lib), 64)
			if trimmed == "" || slices.Contains(libs, trimmed) {
				continue
			}
			libs = append(libs, trimmed)
			if len(libs) == 16 {
				break
			}
		}
		if len(libs) > 0 {
			cleaned.MissingLibraries = libs
		}
	}
	return cleaned
}

func sanitizeModel(model *wire.LocalModel) {
	model.Publisher = clip(strings.TrimSpace(model.Publisher), 120)
	model.Parameters = clip(strings.TrimSpace(model.Parameters), 32)
	model.ActiveParameters = clip(strings.TrimSpace(model.ActiveParameters), 32)
	model.License = clip(strings.TrimSpace(model.License), 120)
	model.SourceURL = strings.TrimSpace(model.SourceURL)
	model.Engine = strings.TrimSpace(model.Engine)
	if model.Engine != "" && !slices.Contains(engines, model.Engine) {
		model.Engine = ""
	}
	model.EngineLabel = clip(strings.TrimSpace(model.EngineLabel), 120)
	if model.Concurrency != nil && (*model.Concurrency < 1 || *model.Concurrency > 64) {
		model.Concurrency = nil
	}
	if model.Family != "" && !slices.Contains(families, model.Family) {
		model.Family = "other"
	}
	if model.Architecture != "" && !slices.Contains(architectures, model.Architecture) {
		model.Architecture = ""
	}
	if len(model.Capabilities) > 0 {
		filtered := make([]string, 0, len(model.Capabilities))
		for _, capability := range model.Capabilities {
			if slices.Contains(capabilities, capability) && !slices.Contains(filtered, capability) {
				filtered = append(filtered, capability)
			}
		}
		if len(filtered) > 0 {
			model.Capabilities = filtered
		} else {
			model.Capabilities = nil
		}
	} else {
		model.Capabilities = nil
	}
	if model.Availability.Downloadable {
		model.Availability.Reason = nil
	} else {
		model.Availability.Reason = sanitizeReason(model.Availability.Reason)
	}
	if model.Download != nil && model.Download.Step != "download" && model.Download.Step != "verify" {
		model.Download.Step = "download"
	}
	if model.Error != nil {
		if !slices.Contains(errorCodes, model.Error.Code) {
			model.Error.Code = "UNKNOWN_ERROR"
			model.Error.Cause, model.Error.Path = "", ""
		} else if model.Error.Cause != "" && !slices.Contains(errorCauses, model.Error.Cause) {
			model.Error.Cause, model.Error.Path = "", ""
		}
	}
	if model.Note != nil && model.Note.Code != "NO_ROOM_TO_LOAD" {
		model.Note = nil
	}
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
	// An Agent stores pi_model as its runtime_model, so it is never cut.
	if len(model.PiModel) > 200 {
		return invalid("pi_model", model.PiModel)
	}
	if model.TokensPerSecond != nil && (math.IsNaN(*model.TokensPerSecond) || math.IsInf(*model.TokensPerSecond, 0) || *model.TokensPerSecond < 0) {
		return errors.New("model tokens_per_second is outside the contract")
	}
	if model.SourceURL != "" && (len(model.SourceURL) > 2048 || !sourceURLPattern.MatchString(model.SourceURL)) {
		return invalid("source_url", model.SourceURL)
	}
	if model.PromptTokensPerSecond != nil && (math.IsNaN(*model.PromptTokensPerSecond) || math.IsInf(*model.PromptTokensPerSecond, 0) || *model.PromptTokensPerSecond < 0) {
		return errors.New("model prompt_tokens_per_second is outside the contract")
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
	Cause          string          `json:"cause"`
	Path           string          `json:"path"`
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

// refusal turns the tool's error into the wire refusal. Unknown future codes
// degrade to UNKNOWN_ERROR instead of breaking the whole action path.
func (e libraryEvent) refusal() *wire.LocalModelActionRefusal {
	code := e.Code
	if !slices.Contains(errorCodes, code) {
		code = "UNKNOWN_ERROR"
	}
	refusal := &wire.LocalModelActionRefusal{Code: code, Detail: clip(e.Detail, 4000)}
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

// maxWireInteger is the contract's NonNegativeInteger maximum.
const maxWireInteger = 1<<53 - 1

// externalHolder decodes one external_holders entry leniently: the list comes
// from per-process OS GPU counters and is display-only, so a malformed entry is
// dropped instead of failing the library or reaching the strict wire contract.
func externalHolder(raw json.RawMessage) (wire.LocalModelPoolExternalHolder, bool) {
	var holder struct {
		Name  string      `json:"name"`
		Bytes json.Number `json:"bytes"`
	}
	if err := json.Unmarshal(raw, &holder); err != nil {
		return wire.LocalModelPoolExternalHolder{}, false
	}
	name := clip(strings.TrimSpace(holder.Name), 200)
	bytes, err := strconv.ParseUint(holder.Bytes.String(), 10, 64)
	if name == "" || err != nil {
		return wire.LocalModelPoolExternalHolder{}, false
	}
	return wire.LocalModelPoolExternalHolder{Name: name, Bytes: min(bytes, maxWireInteger)}, true
}

func bytesValue(value float64) uint64 {
	if math.IsNaN(value) || value <= 0 {
		return 0
	}
	if value >= maxWireInteger {
		return maxWireInteger
	}
	return uint64(value)
}

// errorCauses is the tool's closed set of error causes; a GATEWAY_REGISTRATION_FAILED
// line carries one with the path it names.
var errorCauses = []string{"GATEWAY_HOME_NOT_PRIVATE"}

// cause is the error line's cause as the wire carries it on a model's error,
// or nil when the line names none the contract knows.
func (e libraryEvent) cause() *wire.LocalModelError {
	if !slices.Contains(errorCodes, e.Code) || !slices.Contains(errorCauses, e.Cause) || e.Path == "" {
		return nil
	}
	return &wire.LocalModelError{Code: e.Code, Cause: e.Cause, Path: clip(e.Path, 4096)}
}

// clip bounds display text to the schema's length in characters.
func clip(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit])
}
