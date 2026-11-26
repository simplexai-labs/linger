package localmodels

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	speechStatusSchema  = "localmodels.speech-status/v1"
	speechRuntimeSchema = "localmodels.speech-runtime/v1"
	speechEventSchema   = "localmodels.speech-event/v1"

	// firstLocalmodelsSpeechVersion is the first localmodels kit release that
	// ships the `localmodels speech` subcommand.
	firstLocalmodelsSpeechVersion = "0.1.0.dev60"

	// CodeSpeechUnsupported reports that the installed localmodels kit does
	// not yet implement the `localmodels speech` subcommand.
	CodeSpeechUnsupported = "SPEECH_UNSUPPORTED"

	maxSpeechKeyBytes        = 4096
	maxSpeechResponseBytes   = 4 << 20
	defaultSpeechHTTPTimeout = 90 * time.Second
)

type speechSupportState int

const (
	speechSupportUnknown speechSupportState = iota
	speechSupportYes
	speechSupportNo
)

// SpeechAction names, as the Runner Gateway sends them.
const (
	SpeechActionDownload  = "download"
	SpeechActionCancel    = "cancel"
	SpeechActionRemove    = "remove"
	SpeechActionLoad      = "load"
	SpeechActionUnload    = "unload"
	SpeechActionConfigure = "configure"
	SpeechActionRefresh   = "refresh"
)

var (
	speechEngines          = []string{"sherpa-onnx", "whisper.cpp"}
	speechQualityRatings   = []string{"fast-cjk", "high-multilingual"}
	speechModelStates      = []string{"absent", "downloading", "idle", "loading", "loaded", "failed"}
	speechRuntimeStates    = []string{"stopped", "standby", "loading", "loaded", "error"}
	speechRequestedDevices = []string{"gpu", "cpu"}
	speechEffectiveDevices = []string{"cuda", "metal", "vulkan", "directml", "cpu"}
	speechFallbackReasons  = []string{
		"insufficient_vram", "insufficient_unified_memory", "memory_pressure_warn",
		"memory_pressure_critical", "driver_update_required", "vulkan_unavailable",
		"gpu_engine_unavailable", "gpu_unsupported_platform", "cpu_optimal_for_int8",
		"gpu_init_failed", "runtime_oom_fallback", "yielded_to_llm", "no_supported_gpu",
	}
	speechRefusalCodes = []string{
		"MODEL_UNKNOWN", "INVALID_STATE", "JOB_RUNNING", "DISK_INSUFFICIENT",
		"MEMORY_INSUFFICIENT", "PLATFORM_UNSUPPORTED", "DOWNLOAD_FAILED",
		"CHECKSUM_MISMATCH", "NETWORK_UNAVAILABLE", "ENGINE_START_FAILED",
		"MODEL_FILES_MISSING", "CANCELLED", "SPEECH_UNSUPPORTED",
		"TOOL_NOT_INSTALLED", "TOOL_FAILED", "UNKNOWN_ERROR",
	}
	speechLanguagePattern = regexp.MustCompile(`^(auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*)$`)
)

// ValidSpeechLanguage reports whether lang is a valid speech language tag.
func ValidSpeechLanguage(lang string) bool {
	return len(lang) <= 32 && speechLanguagePattern.MatchString(lang)
}

// SpeechAction is one owner-chosen localmodels speech command.
type SpeechAction struct {
	Name              string
	Model             string
	UseGPU            *bool
	KeepLoadedSeconds *int64
	Language          string
	IncludeGPUEngine  *bool
}

// SpeechTranscribeRequest is one WAV audio transcription call routed to the
// local speech sidecar.
type SpeechTranscribeRequest struct {
	ModelID           string
	Language          string
	UseGPU            *bool
	KeepLoadedSeconds *int64
	AudioWavBase64    string
}

// SpeechTranscribeResult is the structured transcription response returned by
// the loopback speech sidecar.
type SpeechTranscribeResult struct {
	Text            string
	Language        string
	Duration        *float64
	Model           string
	RequestedDevice string
	EffectiveDevice string
	FallbackReason  string
	Segments        []wire.LocalAsrTranscribeSegment
}

// SpeechTranscribeError carries a structured failure code from local speech
// transcription back over the Runner Gateway.
type SpeechTranscribeError struct {
	Code      string
	Message   string
	Retryable bool
}

func (e *SpeechTranscribeError) Error() string {
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	return e.Code
}

// SpeechOptions configures a SpeechLibrary.
type SpeechOptions struct {
	Tool             *Tool
	Environment      map[string]string
	JobDirectory     string
	Publish          func(wire.LocalSpeechSnapshot)
	ProgressInterval time.Duration
	StatusTimeout    time.Duration
	ActionTimeout    time.Duration
	HTTPClient       *http.Client
}

// SpeechLibrary manages `localmodels speech` status, downloads/loads, config,
// and loopback HTTP transcription for one Computer.
type SpeechLibrary struct {
	tool             *Tool
	environment      map[string]string
	jobDirectory     string
	publish          func(wire.LocalSpeechSnapshot)
	progressInterval time.Duration
	statusTimeout    time.Duration
	actionTimeout    time.Duration
	httpClient       *http.Client
	now              func() time.Time
	ctx              context.Context
	stop             context.CancelFunc

	refreshMu sync.Mutex
	publishMu sync.Mutex
	startMu   sync.Mutex
	probeMu   sync.Mutex
	wg        sync.WaitGroup

	mu                sync.Mutex
	closed            bool
	current           *wire.LocalSpeechSnapshot
	speechSupport     speechSupportState
	probedToolVersion string
	sidecarBaseURL    string
	sidecarKeyFile    string
	lastEffectiveDev  string
	lastFallbackRsn   string
}

// NewSpeech returns a SpeechLibrary. Close stops supervision goroutines.
func NewSpeech(options SpeechOptions) *SpeechLibrary {
	ctx, stop := context.WithCancel(context.Background())
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: defaultSpeechHTTPTimeout}
	}
	s := &SpeechLibrary{
		tool:             options.Tool,
		environment:      options.Environment,
		jobDirectory:     options.JobDirectory,
		publish:          options.Publish,
		progressInterval: options.ProgressInterval,
		statusTimeout:    options.StatusTimeout,
		actionTimeout:    options.ActionTimeout,
		httpClient:       client,
		now:              time.Now,
		ctx:              ctx,
		stop:             stop,
	}
	if s.progressInterval <= 0 {
		s.progressInterval = defaultProgressInterval
	}
	if s.statusTimeout <= 0 {
		s.statusTimeout = defaultStatusTimeout
	}
	if s.actionTimeout <= 0 {
		s.actionTimeout = defaultActionTimeout
	}
	if s.publish == nil {
		s.publish = func(wire.LocalSpeechSnapshot) {}
	}
	if s.jobDirectory != "" {
		_ = os.RemoveAll(s.jobDirectory)
	}
	return s
}

// Close stops background supervision goroutines; detached jobs continue.
func (s *SpeechLibrary) Close() {
	s.stop()
	s.mu.Lock()
	s.closed = true
	s.mu.Unlock()
	s.wg.Wait()
}

func (s *SpeechLibrary) track(n int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return false
	}
	s.wg.Add(n)
	return true
}

func speechUnavailable(code, detail string, now time.Time) wire.LocalSpeechSnapshot {
	return wire.LocalSpeechSnapshot{
		Available:  false,
		Reason:     &wire.LocalSpeechUnavailableReason{Code: code, Detail: clip(detail, 4000)},
		ObservedAt: now.UTC().Format(time.RFC3339Nano),
		Models:     []wire.LocalSpeechModel{},
	}
}

func (s *SpeechLibrary) commitAndPublish(snapshot wire.LocalSpeechSnapshot) {
	s.publishMu.Lock()
	defer s.publishMu.Unlock()
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	copied := snapshot
	s.current = &copied
	s.mu.Unlock()
	s.publish(snapshot)
}

// Refresh probes `localmodels speech status --base-dir <dir> --json` and
// publishes the resulting snapshot. When the installed tool version precedes
// firstLocalmodelsSpeechVersion, it publishes SPEECH_UNSUPPORTED gracefully.
func (s *SpeechLibrary) Refresh(ctx context.Context) wire.LocalSpeechSnapshot {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if s.tool == nil {
		snap := speechUnavailable(CodeToolNotInstalled, "localmodels tool is not installed", s.now())
		s.commitAndPublish(snap)
		return snap
	}
	if detail, unsupported := s.cachedSpeechUnsupported(); unsupported {
		snap := speechUnavailable(CodeSpeechUnsupported, detail, s.now())
		s.commitAndPublish(snap)
		return snap
	}
	runCtx, cancel := context.WithTimeout(ctx, s.statusTimeout)
	defer cancel()
	args := []string{"-P", "-s", "-m", "localmodels", "speech", "status", "--base-dir", s.tool.BaseDirectory, "--json"}
	stdout, stderr, err := s.runTool(runCtx, args)
	if err != nil {
		if detail, unsupported := s.checkSpeechUnsupported(runCtx); unsupported {
			snap := speechUnavailable(CodeSpeechUnsupported, detail, s.now())
			s.commitAndPublish(snap)
			return snap
		}
		detail := strings.TrimSpace(stderr)
		if detail == "" {
			detail = err.Error()
		}
		snap := speechUnavailable(CodeToolFailed, detail, s.now())
		s.commitAndPublish(snap)
		return snap
	}
	snap, baseURL, keyFile, mapErr := mapSpeechStatus(stdout, s.now())
	if mapErr != nil {
		if detail, unsupported := s.checkSpeechUnsupported(runCtx); unsupported {
			snap = speechUnavailable(CodeSpeechUnsupported, detail, s.now())
			s.commitAndPublish(snap)
			return snap
		}
		snap = speechUnavailable(CodeToolFailed, mapErr.Error(), s.now())
		s.commitAndPublish(snap)
		return snap
	}
	s.setSpeechSupport(speechSupportYes, snap.ToolVersion)
	s.mu.Lock()
	if baseURL != "" && keyFile != "" {
		s.sidecarBaseURL = baseURL
		s.sidecarKeyFile = keyFile
	}
	if snap.Runtime != nil {
		s.lastEffectiveDev = snap.Runtime.EffectiveDevice
		s.lastFallbackRsn = snap.Runtime.FallbackReason
	}
	s.mu.Unlock()
	s.commitAndPublish(snap)
	return snap
}

// Act executes one owner-chosen speech action (download, cancel, remove, load,
// unload, configure, refresh) and returns nil when accepted or a refusal.
func (s *SpeechLibrary) Act(ctx context.Context, action SpeechAction, deadline time.Time) (refusal *wire.LocalSpeechActionRefusal, answered bool) {
	if s.tool == nil {
		return &wire.LocalSpeechActionRefusal{Code: CodeToolNotInstalled}, true
	}
	if action.Name == SpeechActionRefresh {
		s.Refresh(ctx)
		return nil, true
	}
	if detail, unsupported := s.cachedSpeechUnsupported(); unsupported {
		return &wire.LocalSpeechActionRefusal{Code: CodeSpeechUnsupported, Detail: clip(detail, 4000)}, true
	}
	if action.Name == SpeechActionDownload || action.Name == SpeechActionLoad {
		return s.startStreamingAction(ctx, action, deadline)
	}
	runCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	args := s.speechActionArgs(action)
	stdout, stderr, err := s.runTool(runCtx, args)
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) && !deadline.After(s.now()) {
		return nil, false
	}
	if err != nil {
		if ref := parseSpeechRefusal(stdout, stderr); ref != nil {
			return ref, true
		}
		if detail, unsupported := s.checkSpeechUnsupported(runCtx); unsupported {
			return &wire.LocalSpeechActionRefusal{Code: CodeSpeechUnsupported, Detail: clip(detail, 4000)}, true
		}
		detail := strings.TrimSpace(stderr)
		if detail == "" {
			detail = err.Error()
		}
		return &wire.LocalSpeechActionRefusal{Code: CodeToolFailed, Detail: clip(detail, 4000)}, true
	}
	s.setSpeechSupport(speechSupportYes, "")
	// Refresh snapshot asynchronously so caller gets an immediate ack.
	if s.track(1) {
		go func() {
			defer s.wg.Done()
			s.Refresh(s.ctx)
		}()
	}
	return nil, true
}

func (s *SpeechLibrary) speechActionArgs(action SpeechAction) []string {
	args := []string{"-P", "-s", "-m", "localmodels", "speech"}
	switch action.Name {
	case SpeechActionDownload:
		args = append(args, "download", action.Model, "--base-dir", s.tool.BaseDirectory)
		if action.IncludeGPUEngine != nil && *action.IncludeGPUEngine {
			args = append(args, "--include-gpu-engine")
		}
		return append(args, "--jsonl")
	case SpeechActionLoad:
		args = append(args, "load", action.Model, "--base-dir", s.tool.BaseDirectory)
		if action.UseGPU != nil {
			args = append(args, "--use-gpu", strconv.FormatBool(*action.UseGPU))
		}
		return append(args, "--jsonl")
	case SpeechActionCancel:
		return append(args, "cancel", action.Model, "--base-dir", s.tool.BaseDirectory, "--json")
	case SpeechActionRemove:
		return append(args, "remove", action.Model, "--base-dir", s.tool.BaseDirectory, "--json")
	case SpeechActionUnload:
		return append(args, "unload", "--base-dir", s.tool.BaseDirectory, "--json")
	case SpeechActionConfigure:
		args = append(args, "configure", "--base-dir", s.tool.BaseDirectory)
		if action.Model != "" {
			args = append(args, "--model", action.Model)
		}
		if action.UseGPU != nil {
			args = append(args, "--use-gpu", strconv.FormatBool(*action.UseGPU))
		}
		if action.KeepLoadedSeconds != nil {
			args = append(args, "--keep-loaded-seconds", strconv.FormatInt(*action.KeepLoadedSeconds, 10))
		}
		if action.Language != "" {
			args = append(args, "--language", action.Language)
		}
		return append(args, "--json")
	default:
		return append(args, "status", "--base-dir", s.tool.BaseDirectory, "--json")
	}
}

func (s *SpeechLibrary) startStreamingAction(ctx context.Context, action SpeechAction, deadline time.Time) (*wire.LocalSpeechActionRefusal, bool) {
	jobDir := s.jobDirectory
	if jobDir == "" {
		jobDir = os.TempDir()
	}
	if err := os.MkdirAll(jobDir, 0o700); err != nil {
		return &wire.LocalSpeechActionRefusal{Code: CodeToolFailed, Detail: err.Error()}, true
	}
	var nonce [8]byte
	_, _ = rand.Read(nonce[:])
	outPath := filepath.Join(jobDir, fmt.Sprintf("speech-%s-%s.jsonl", action.Name, hex.EncodeToString(nonce[:])))
	outFile, err := os.OpenFile(outPath, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o600)
	if err != nil {
		return &wire.LocalSpeechActionRefusal{Code: CodeToolFailed, Detail: err.Error()}, true
	}
	cmd := s.tool.commandArgs(s.environment, s.speechActionArgs(action))
	process.Prepare(cmd)
	var stderrBuf bytes.Buffer
	cmd.Stdout = outFile
	cmd.Stderr = &stderrBuf
	if err := cmd.Start(); err != nil {
		_ = outFile.Close()
		_ = os.Remove(outPath)
		return &wire.LocalSpeechActionRefusal{Code: CodeToolFailed, Detail: err.Error()}, true
	}
	_ = outFile.Close()

	doneCh := make(chan error, 1)
	go func() {
		doneCh <- cmd.Wait()
	}()

	// Wait for the first JSONL line or process exit before the deadline to decide accepted vs refused.
	pollTicker := time.NewTicker(50 * time.Millisecond)
	defer pollTicker.Stop()
	var firstLine string
	var exitErr error
	exited := false
waitFirst:
	for {
		if line := readFirstNonEmptyLine(outPath); line != "" {
			firstLine = line
			break waitFirst
		}
		select {
		case exitErr = <-doneCh:
			exited = true
			firstLine = readFirstNonEmptyLine(outPath)
			break waitFirst
		case <-ctx.Done():
			return nil, false
		case <-pollTicker.C:
			if !deadline.After(s.now()) {
				return nil, false
			}
		}
	}

	if firstLine != "" {
		var ev speechEventLine
		if err := json.Unmarshal([]byte(firstLine), &ev); err == nil && ev.Schema == speechEventSchema {
			s.setSpeechSupport(speechSupportYes, "")
			if ev.Event == "error" || ev.Error != nil {
				code := CodeToolFailed
				detail := ""
				if ev.Error != nil {
					code = sanitizeSpeechRefusalCode(ev.Error.Code)
					detail = clip(ev.Error.Message, 4000)
				}
				return &wire.LocalSpeechActionRefusal{Code: code, Detail: detail}, true
			}
		}
	} else if exited && exitErr != nil {
		stderrText := stderrBuf.String()
		if ref := parseSpeechRefusal("", stderrText); ref != nil {
			return ref, true
		}
		probeCtx, cancel := context.WithDeadline(ctx, deadline)
		detail, unsupported := s.checkSpeechUnsupported(probeCtx)
		cancel()
		if unsupported {
			return &wire.LocalSpeechActionRefusal{Code: CodeSpeechUnsupported, Detail: clip(detail, 4000)}, true
		}
		return &wire.LocalSpeechActionRefusal{Code: CodeToolFailed, Detail: clip(strings.TrimSpace(stderrText), 4000)}, true
	}

	// Accepted: supervise until exit, refreshing snapshots periodically so progress reaches Web.
	if s.track(1) {
		go func() {
			defer s.wg.Done()
			defer func() { _ = os.Remove(outPath) }()
			if exited {
				s.Refresh(s.ctx)
				return
			}
			s.Refresh(s.ctx)
			ticker := time.NewTicker(s.progressInterval)
			defer ticker.Stop()
			for {
				select {
				case <-doneCh:
					s.Refresh(s.ctx)
					return
				case <-s.ctx.Done():
					return
				case <-ticker.C:
					s.Refresh(s.ctx)
				}
			}
		}()
	}
	return nil, true
}

// Transcribe sends a 16 kHz mono WAV buffer to the local loopback speech sidecar
// (`/v1/audio/transcriptions`), auto-starting the sidecar in standby if needed.
func (s *SpeechLibrary) Transcribe(ctx context.Context, req SpeechTranscribeRequest) (SpeechTranscribeResult, error) {
	if s.tool == nil {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:    CodeToolNotInstalled,
			Message: "localmodels tool is not installed",
		}
	}
	audioBytes, err := base64.StdEncoding.DecodeString(req.AudioWavBase64)
	if err != nil || len(audioBytes) == 0 {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:    "INVALID_AUDIO",
			Message: "audio_wav_base64 is invalid",
		}
	}
	baseURL, keyFile, err := s.ensureSidecar(ctx, false)
	if err != nil {
		return SpeechTranscribeResult{}, err
	}
	result, err := s.postTranscription(ctx, baseURL, keyFile, audioBytes, req)
	if err != nil && isRetryableSidecarDialError(err) {
		// Sidecar may have exited after idle stop; restart once and retry.
		baseURL, keyFile, startErr := s.ensureSidecar(ctx, true)
		if startErr != nil {
			return SpeechTranscribeResult{}, startErr
		}
		result, err = s.postTranscription(ctx, baseURL, keyFile, audioBytes, req)
	}
	if err != nil {
		return SpeechTranscribeResult{}, err
	}

	s.mu.Lock()
	changed := (result.EffectiveDevice != "" && result.EffectiveDevice != s.lastEffectiveDev) ||
		result.FallbackReason != s.lastFallbackRsn
	if result.EffectiveDevice != "" {
		s.lastEffectiveDev = result.EffectiveDevice
	}
	s.lastFallbackRsn = result.FallbackReason
	s.mu.Unlock()
	if changed && s.track(1) {
		go func() {
			defer s.wg.Done()
			s.Refresh(s.ctx)
		}()
	}
	return result, nil
}

func (s *SpeechLibrary) ensureSidecar(ctx context.Context, forceRestart bool) (baseURL, keyFile string, err error) {
	s.startMu.Lock()
	defer s.startMu.Unlock()

	if !forceRestart {
		s.mu.Lock()
		cachedURL, cachedKey := s.sidecarBaseURL, s.sidecarKeyFile
		s.mu.Unlock()
		if cachedURL != "" && cachedKey != "" && s.sidecarHealthy(ctx, cachedURL) {
			return cachedURL, cachedKey, nil
		}
	}

	if detail, unsupported := s.cachedSpeechUnsupported(); unsupported {
		return "", "", &SpeechTranscribeError{
			Code:    CodeSpeechUnsupported,
			Message: clip(detail, 1000),
		}
	}

	startCtx, cancel := context.WithTimeout(ctx, s.actionTimeout)
	defer cancel()
	args := []string{"-P", "-s", "-m", "localmodels", "speech", "start", "--base-dir", s.tool.BaseDirectory, "--standby", "--json"}
	stdout, stderr, runErr := s.runTool(startCtx, args)
	if runErr != nil {
		if detail, unsupported := s.checkSpeechUnsupported(startCtx); unsupported {
			return "", "", &SpeechTranscribeError{
				Code:    CodeSpeechUnsupported,
				Message: clip(detail, 1000),
			}
		}
		detail := strings.TrimSpace(stderr)
		if detail == "" {
			detail = runErr.Error()
		}
		return "", "", &SpeechTranscribeError{
			Code:      "SIDECAR_START_FAILED",
			Message:   clip(detail, 1000),
			Retryable: true,
		}
	}
	parsedURL, parsedKey, parseErr := parseSpeechRuntimeStart(stdout)
	if parseErr != nil {
		return "", "", &SpeechTranscribeError{
			Code:      "SIDECAR_START_FAILED",
			Message:   clip(parseErr.Error(), 1000),
			Retryable: true,
		}
	}
	s.setSpeechSupport(speechSupportYes, "")
	s.mu.Lock()
	s.sidecarBaseURL = parsedURL
	s.sidecarKeyFile = parsedKey
	s.mu.Unlock()
	return parsedURL, parsedKey, nil
}

func (s *SpeechLibrary) sidecarHealthy(ctx context.Context, baseURL string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/health", nil)
	if err != nil {
		return false
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return false
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}

func (s *SpeechLibrary) postTranscription(
	ctx context.Context,
	baseURL, keyFile string,
	audioBytes []byte,
	req SpeechTranscribeRequest,
) (SpeechTranscribeResult, error) {
	tokenBytes, err := readBounded(keyFile, maxSpeechKeyBytes)
	if err != nil {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:      "SIDECAR_KEY_UNREADABLE",
			Message:   "failed to read local speech sidecar token",
			Retryable: true,
		}
	}
	token := strings.TrimSpace(string(tokenBytes))
	if token == "" {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:      "SIDECAR_KEY_EMPTY",
			Message:   "local speech sidecar token is empty",
			Retryable: true,
		}
	}

	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", "audio.wav")
	if err != nil {
		return SpeechTranscribeResult{}, err
	}
	if _, err := part.Write(audioBytes); err != nil {
		return SpeechTranscribeResult{}, err
	}
	model := strings.TrimSpace(req.ModelID)
	if model == "" {
		model = "default"
	}
	_ = writer.WriteField("model", model)
	_ = writer.WriteField("response_format", "verbose_json")
	if lang := strings.TrimSpace(req.Language); lang != "" {
		_ = writer.WriteField("language", lang)
	}
	if req.UseGPU != nil {
		_ = writer.WriteField("use_gpu", strconv.FormatBool(*req.UseGPU))
	}
	if req.KeepLoadedSeconds != nil {
		_ = writer.WriteField("keep_loaded_seconds", strconv.FormatInt(*req.KeepLoadedSeconds, 10))
	}
	if err := writer.Close(); err != nil {
		return SpeechTranscribeResult{}, err
	}

	endpoint := strings.TrimRight(baseURL, "/") + "/v1/audio/transcriptions"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, &body)
	if err != nil {
		return SpeechTranscribeResult{}, err
	}
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())
	httpReq.Header.Set("Authorization", "Bearer "+token)

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return SpeechTranscribeResult{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	respBytes, err := io.ReadAll(io.LimitReader(resp.Body, maxSpeechResponseBytes))
	if err != nil {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:      "TRANSCRIBE_READ_FAILED",
			Message:   err.Error(),
			Retryable: true,
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:      fmt.Sprintf("SIDECAR_HTTP_%d", resp.StatusCode),
			Message:   clip(strings.TrimSpace(string(respBytes)), 1000),
			Retryable: resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests,
		}
	}
	var parsed struct {
		Text            string   `json:"text"`
		Language        *string  `json:"language"`
		Duration        *float64 `json:"duration"`
		Model           string   `json:"model"`
		RequestedDevice string   `json:"requested_device"`
		EffectiveDevice *string  `json:"effective_device"`
		FallbackReason  *string  `json:"fallback_reason"`
		Segments        []struct {
			Start float64 `json:"start"`
			End   float64 `json:"end"`
			Text  string  `json:"text"`
		} `json:"segments"`
	}
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		return SpeechTranscribeResult{}, &SpeechTranscribeError{
			Code:    "TRANSCRIBE_INVALID_JSON",
			Message: err.Error(),
		}
	}
	requestedDevice := parsed.RequestedDevice
	if !slices.Contains(speechRequestedDevices, requestedDevice) {
		requestedDevice = "cpu"
	}
	effectiveDevice := ""
	if parsed.EffectiveDevice != nil && slices.Contains(speechEffectiveDevices, *parsed.EffectiveDevice) {
		effectiveDevice = *parsed.EffectiveDevice
	}
	fallbackReason := ""
	if parsed.FallbackReason != nil && slices.Contains(speechFallbackReasons, *parsed.FallbackReason) {
		fallbackReason = *parsed.FallbackReason
	}
	lang := ""
	if parsed.Language != nil {
		lang = clip(strings.TrimSpace(*parsed.Language), 32)
	}
	modelOut := strings.TrimSpace(parsed.Model)
	if modelOut == "" {
		modelOut = model
	}
	segments := make([]wire.LocalAsrTranscribeSegment, 0, len(parsed.Segments))
	for _, seg := range parsed.Segments {
		start := seg.Start
		if start < 0 {
			start = 0
		}
		end := seg.End
		if end < start {
			end = start
		}
		segments = append(segments, wire.LocalAsrTranscribeSegment{
			Start: start,
			End:   end,
			Text:  seg.Text,
		})
	}
	return SpeechTranscribeResult{
		Text:            parsed.Text,
		Language:        lang,
		Duration:        parsed.Duration,
		Model:           clip(modelOut, 160),
		RequestedDevice: requestedDevice,
		EffectiveDevice: effectiveDevice,
		FallbackReason:  fallbackReason,
		Segments:        segments,
	}, nil
}

func (s *SpeechLibrary) runTool(ctx context.Context, args []string) (stdout, stderr string, err error) {
	cmd := s.tool.commandArgs(s.environment, args)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf
	if err := cmd.Start(); err != nil {
		return "", "", err
	}
	waitErr := cmd.Wait()
	if ctx.Err() != nil {
		_ = cmd.Process.Kill()
		return outBuf.String(), errBuf.String(), ctx.Err()
	}
	return outBuf.String(), errBuf.String(), waitErr
}

type speechStatusDoc struct {
	Schema      string `json:"schema"`
	ToolVersion string `json:"tool_version"`
	ObservedAt  string `json:"observed_at"`
	Config      *struct {
		ModelID           *string `json:"model_id"`
		UseGPU            bool    `json:"use_gpu"`
		KeepLoadedSeconds int64   `json:"keep_loaded_seconds"`
		Language          string  `json:"language"`
	} `json:"config"`
	Runtime *struct {
		Running              bool    `json:"running"`
		State                string  `json:"state"`
		BaseURL              *string `json:"base_url"`
		KeyFile              *string `json:"key_file"`
		ActiveModel          *string `json:"active_model"`
		Engine               *string `json:"engine"`
		RequestedDevice      string  `json:"requested_device"`
		EffectiveDevice      *string `json:"effective_device"`
		FallbackReason       *string `json:"fallback_reason"`
		FallbackDetail       *string `json:"fallback_detail"`
		VRAMUsedBytes        uint64  `json:"vram_used_bytes"`
		RAMUsedBytes         uint64  `json:"ram_used_bytes"`
		KeepLoadedSeconds    int64   `json:"keep_loaded_seconds"`
		IdleRemainingSeconds *int64  `json:"idle_remaining_seconds"`
		ActiveSessions       uint64  `json:"active_sessions"`
	} `json:"runtime"`
	Models []struct {
		ID                string   `json:"id"`
		Name              string   `json:"name"`
		Engine            string   `json:"engine"`
		Languages         []string `json:"languages"`
		LanguageCount     uint64   `json:"language_count"`
		QualityRating     string   `json:"quality_rating"`
		License           string   `json:"license"`
		LicenseURL        string   `json:"license_url"`
		CommercialNotice  *string  `json:"commercial_notice"`
		DiskSizeBytes     uint64   `json:"disk_size_bytes"`
		VRAMEstimateBytes uint64   `json:"vram_estimate_bytes"`
		RAMEstimateBytes  uint64   `json:"ram_estimate_bytes"`
		GPUSupported      bool     `json:"gpu_supported"`
		State             string   `json:"state"`
		Active            bool     `json:"active"`
		Download          *struct {
			Step           string  `json:"step"`
			DoneBytes      uint64  `json:"done_bytes"`
			TotalBytes     uint64  `json:"total_bytes"`
			BytesPerSecond uint64  `json:"bytes_per_second"`
			Source         string  `json:"source"`
			Connections    *uint64 `json:"connections"`
		} `json:"download"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	} `json:"models"`
}

func mapSpeechStatus(raw string, now time.Time) (snap wire.LocalSpeechSnapshot, baseURL, keyFile string, err error) {
	var doc speechStatusDoc
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return wire.LocalSpeechSnapshot{}, "", "", fmt.Errorf("decode speech status: %w", err)
	}
	if doc.Schema != speechStatusSchema {
		return wire.LocalSpeechSnapshot{}, "", "", fmt.Errorf("speech status schema is %q", doc.Schema)
	}
	observedAt := now.UTC().Format(time.RFC3339Nano)
	if parsed, err := time.Parse(time.RFC3339Nano, doc.ObservedAt); err == nil {
		observedAt = parsed.UTC().Format(time.RFC3339Nano)
	}
	snap = wire.LocalSpeechSnapshot{
		Available:   true,
		ObservedAt:  observedAt,
		ToolVersion: clip(strings.TrimSpace(doc.ToolVersion), 64),
		Models:      make([]wire.LocalSpeechModel, 0, len(doc.Models)),
	}
	if doc.Config != nil {
		lang := strings.TrimSpace(doc.Config.Language)
		if !ValidSpeechLanguage(lang) {
			lang = "auto"
		}
		keep := doc.Config.KeepLoadedSeconds
		if keep < -1 || keep > 86400 {
			keep = 900
		}
		cfg := &wire.LocalSpeechConfig{
			UseGpu:            doc.Config.UseGPU,
			KeepLoadedSeconds: keep,
			Language:          lang,
		}
		if doc.Config.ModelID != nil && ValidModelID(*doc.Config.ModelID) {
			cfg.ModelID = *doc.Config.ModelID
		}
		snap.Config = cfg
	}
	if doc.Runtime != nil {
		rt := doc.Runtime
		state := rt.State
		if !slices.Contains(speechRuntimeStates, state) {
			state = "error"
		}
		reqDev := rt.RequestedDevice
		if !slices.Contains(speechRequestedDevices, reqDev) {
			reqDev = "cpu"
		}
		keep := rt.KeepLoadedSeconds
		if keep < -1 || keep > 86400 {
			keep = 900
		}
		wireRT := &wire.LocalSpeechRuntime{
			Running:           rt.Running,
			State:             state,
			RequestedDevice:   reqDev,
			VramUsedBytes:     rt.VRAMUsedBytes,
			RamUsedBytes:      rt.RAMUsedBytes,
			KeepLoadedSeconds: keep,
			ActiveSessions:    rt.ActiveSessions,
		}
		if rt.ActiveModel != nil && ValidModelID(*rt.ActiveModel) {
			wireRT.ActiveModel = *rt.ActiveModel
		}
		if rt.Engine != nil && slices.Contains(speechEngines, *rt.Engine) {
			wireRT.Engine = *rt.Engine
		}
		if rt.EffectiveDevice != nil && slices.Contains(speechEffectiveDevices, *rt.EffectiveDevice) {
			wireRT.EffectiveDevice = *rt.EffectiveDevice
		}
		if rt.FallbackReason != nil && slices.Contains(speechFallbackReasons, *rt.FallbackReason) {
			wireRT.FallbackReason = *rt.FallbackReason
		}
		if rt.FallbackDetail != nil {
			wireRT.FallbackDetail = clip(strings.TrimSpace(*rt.FallbackDetail), 1000)
		}
		if rt.IdleRemainingSeconds != nil && *rt.IdleRemainingSeconds >= 0 && *rt.IdleRemainingSeconds <= 86400 {
			v := uint64(*rt.IdleRemainingSeconds)
			wireRT.IdleRemainingSeconds = &v
		}
		snap.Runtime = wireRT
		if rt.BaseURL != nil && rt.KeyFile != nil {
			if validURL, ok := validateLoopbackSpeechURL(*rt.BaseURL); ok {
				baseURL = validURL
				keyFile = strings.TrimSpace(*rt.KeyFile)
			}
		}
	}
	for _, m := range doc.Models {
		if !ValidModelID(m.ID) || !slices.Contains(speechEngines, m.Engine) ||
			!slices.Contains(speechQualityRatings, m.QualityRating) || !slices.Contains(speechModelStates, m.State) {
			slog.Warn("local_speech.model_skipped", "id", m.ID, "engine", m.Engine, "state", m.State)
			continue
		}
		langs := m.Languages
		if langs == nil {
			langs = []string{}
		}
		wm := wire.LocalSpeechModel{
			ID:                m.ID,
			Name:              clip(strings.TrimSpace(m.Name), 200),
			Engine:            m.Engine,
			Languages:         langs,
			LanguageCount:     m.LanguageCount,
			QualityRating:     m.QualityRating,
			License:           clip(strings.TrimSpace(m.License), 128),
			LicenseURL:        clip(strings.TrimSpace(m.LicenseURL), 2048),
			DiskSizeBytes:     m.DiskSizeBytes,
			VramEstimateBytes: m.VRAMEstimateBytes,
			RamEstimateBytes:  m.RAMEstimateBytes,
			GpuSupported:      m.GPUSupported,
			State:             m.State,
			Active:            m.Active,
		}
		if m.CommercialNotice != nil {
			wm.CommercialNotice = clip(strings.TrimSpace(*m.CommercialNotice), 1000)
		}
		if m.Download != nil {
			step := m.Download.Step
			if step != "download" && step != "verify" {
				step = "download"
			}
			wm.Download = &wire.LocalSpeechDownloadProgress{
				Step:           step,
				DoneBytes:      m.Download.DoneBytes,
				TotalBytes:     m.Download.TotalBytes,
				BytesPerSecond: m.Download.BytesPerSecond,
				Source:         clip(strings.TrimSpace(m.Download.Source), 200),
				Connections:    m.Download.Connections,
			}
		}
		if m.Error != nil {
			wm.Error = &wire.LocalSpeechError{
				Code:    clip(strings.TrimSpace(m.Error.Code), 128),
				Message: clip(strings.TrimSpace(m.Error.Message), 4000),
			}
		}
		snap.Models = append(snap.Models, wm)
	}
	return snap, baseURL, keyFile, nil
}

type speechEventLine struct {
	Schema string `json:"schema"`
	Event  string `json:"event"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func parseSpeechRuntimeStart(raw string) (baseURL, keyFile string, err error) {
	var doc struct {
		Schema  string `json:"schema"`
		Runtime *struct {
			BaseURL *string `json:"base_url"`
			KeyFile *string `json:"key_file"`
		} `json:"runtime"`
		BaseURL *string `json:"base_url"`
		KeyFile *string `json:"key_file"`
	}
	if err := json.Unmarshal([]byte(raw), &doc); err != nil {
		return "", "", fmt.Errorf("decode speech start response: %w", err)
	}
	if doc.Schema != "" && doc.Schema != speechRuntimeSchema {
		return "", "", fmt.Errorf("unexpected speech runtime schema %q", doc.Schema)
	}
	var rawURL, rawKey string
	if doc.Runtime != nil {
		if doc.Runtime.BaseURL != nil {
			rawURL = *doc.Runtime.BaseURL
		}
		if doc.Runtime.KeyFile != nil {
			rawKey = *doc.Runtime.KeyFile
		}
	}
	if rawURL == "" && doc.BaseURL != nil {
		rawURL = *doc.BaseURL
	}
	if rawKey == "" && doc.KeyFile != nil {
		rawKey = *doc.KeyFile
	}
	validURL, ok := validateLoopbackSpeechURL(rawURL)
	if !ok {
		return "", "", fmt.Errorf("speech sidecar base_url %q is not a valid loopback URL", rawURL)
	}
	rawKey = strings.TrimSpace(rawKey)
	if rawKey == "" {
		return "", "", errors.New("speech sidecar key_file is missing")
	}
	return validURL, rawKey, nil
}

func validateLoopbackSpeechURL(raw string) (string, bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "http" || parsed.Host == "" || parsed.User != nil {
		return "", false
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" && host != "::1" && host != "localhost" {
		return "", false
	}
	return strings.TrimRight(parsed.String(), "/"), true
}

func (s *SpeechLibrary) setSpeechSupport(state speechSupportState, toolVersion string) {
	s.mu.Lock()
	s.speechSupport = state
	if toolVersion != "" {
		s.probedToolVersion = toolVersion
	}
	s.mu.Unlock()
}

func (s *SpeechLibrary) speechUnsupportedDetail(version string) string {
	if version != "" {
		return fmt.Sprintf("localmodels %s does not include the speech subcommand (requires %s or later)", version, firstLocalmodelsSpeechVersion)
	}
	return fmt.Sprintf("installed localmodels version does not include the speech subcommand (requires %s or later)", firstLocalmodelsSpeechVersion)
}

func (s *SpeechLibrary) cachedSpeechUnsupported() (string, bool) {
	s.mu.Lock()
	state, version := s.speechSupport, s.probedToolVersion
	s.mu.Unlock()
	if state == speechSupportNo {
		return s.speechUnsupportedDetail(version), true
	}
	return "", false
}

// checkSpeechUnsupported determines structurally whether the installed
// localmodels kit predates firstLocalmodelsSpeechVersion by reading the
// structured tool_version from `localmodels library status --json`.
func (s *SpeechLibrary) checkSpeechUnsupported(ctx context.Context) (string, bool) {
	s.mu.Lock()
	state, version := s.speechSupport, s.probedToolVersion
	s.mu.Unlock()
	switch state {
	case speechSupportNo:
		return s.speechUnsupportedDetail(version), true
	case speechSupportYes:
		return "", false
	}

	s.probeMu.Lock()
	defer s.probeMu.Unlock()

	s.mu.Lock()
	state, version = s.speechSupport, s.probedToolVersion
	s.mu.Unlock()
	switch state {
	case speechSupportNo:
		return s.speechUnsupportedDetail(version), true
	case speechSupportYes:
		return "", false
	}

	probeCtx, cancel := context.WithTimeout(ctx, s.statusTimeout)
	defer cancel()
	args := []string{"-P", "-s", "-m", "localmodels", "library", "status", "--base-dir", s.tool.BaseDirectory, "--json"}
	stdout, _, err := s.runTool(probeCtx, args)
	if err != nil {
		return "", false
	}
	var doc struct {
		Schema      string `json:"schema"`
		ToolVersion string `json:"tool_version"`
	}
	if err := json.Unmarshal([]byte(stdout), &doc); err != nil || doc.Schema != statusSchema {
		return "", false
	}
	toolVersion := strings.TrimSpace(doc.ToolVersion)
	atLeast, ok := localmodelsVersionAtLeast(toolVersion, firstLocalmodelsSpeechVersion)
	if !ok {
		return "", false
	}
	if !atLeast {
		s.setSpeechSupport(speechSupportNo, toolVersion)
		return s.speechUnsupportedDetail(toolVersion), true
	}
	s.setSpeechSupport(speechSupportYes, toolVersion)
	return "", false
}

var pep440VersionPattern = regexp.MustCompile(`^[vV]?(?:(\d+)!)?(\d+(?:\.\d+)*)(?:(a|b|rc)(\d+))?(?:\.post(\d+))?(?:\.dev(\d+))?(?:\+[A-Za-z0-9._-]+)?$`)

type pep440Version struct {
	epoch   int
	release []int
	hasPre  bool
	preRank int
	preNum  int
	hasPost bool
	postNum int
	hasDev  bool
	devNum  int
}

func parsePEP440Version(raw string) (pep440Version, bool) {
	match := pep440VersionPattern.FindStringSubmatch(strings.TrimSpace(raw))
	if match == nil {
		return pep440Version{}, false
	}
	var v pep440Version
	if match[1] != "" {
		epoch, err := strconv.Atoi(match[1])
		if err != nil {
			return pep440Version{}, false
		}
		v.epoch = epoch
	}
	parts := strings.Split(match[2], ".")
	v.release = make([]int, len(parts))
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil {
			return pep440Version{}, false
		}
		v.release[i] = n
	}
	if match[3] != "" {
		n, err := strconv.Atoi(match[4])
		if err != nil {
			return pep440Version{}, false
		}
		v.hasPre = true
		v.preNum = n
		switch match[3] {
		case "a":
			v.preRank = 1
		case "b":
			v.preRank = 2
		case "rc":
			v.preRank = 3
		}
	}
	if match[5] != "" {
		n, err := strconv.Atoi(match[5])
		if err != nil {
			return pep440Version{}, false
		}
		v.hasPost = true
		v.postNum = n
	}
	if match[6] != "" {
		n, err := strconv.Atoi(match[6])
		if err != nil {
			return pep440Version{}, false
		}
		v.hasDev = true
		v.devNum = n
	}
	return v, true
}

// pep440SortKey maps one PEP 440 version to a fixed-width tuple after release
// segments: (stage, preNum, subStage, postNum, devStage, devNum).
// Within one release segment R:
//
//	R.devN < R{a|b|rc}M.devN < R{a|b|rc}M < R{a|b|rc}M.postP.devN < R{a|b|rc}M.postP < R < R.postP.devN < R.postP.
func (v pep440Version) suffixKey() [6]int {
	if !v.hasPre && !v.hasPost && v.hasDev {
		return [6]int{0, 0, 0, 0, 0, v.devNum}
	}
	if v.hasPre {
		if v.hasPost {
			devStage := 1
			if v.hasDev {
				devStage = 0
			}
			return [6]int{v.preRank, v.preNum, 2, v.postNum, devStage, v.devNum}
		}
		if v.hasDev {
			return [6]int{v.preRank, v.preNum, 0, 0, 0, v.devNum}
		}
		return [6]int{v.preRank, v.preNum, 1, 0, 1, 0}
	}
	if v.hasPost {
		devStage := 1
		if v.hasDev {
			devStage = 0
		}
		return [6]int{5, 0, 0, v.postNum, devStage, v.devNum}
	}
	return [6]int{4, 0, 0, 0, 1, 0}
}

func localmodelsVersionAtLeast(actual, minimum string) (atLeast bool, ok bool) {
	a, okA := parsePEP440Version(actual)
	b, okB := parsePEP440Version(minimum)
	if !okA || !okB {
		return false, false
	}
	if a.epoch != b.epoch {
		return a.epoch > b.epoch, true
	}
	n := max(len(a.release), len(b.release))
	for i := range n {
		segA, segB := 0, 0
		if i < len(a.release) {
			segA = a.release[i]
		}
		if i < len(b.release) {
			segB = b.release[i]
		}
		if segA != segB {
			return segA > segB, true
		}
	}
	ka, kb := a.suffixKey(), b.suffixKey()
	for i := range ka {
		if ka[i] != kb[i] {
			return ka[i] > kb[i], true
		}
	}
	return true, true
}

func parseSpeechRefusal(stdout, stderr string) *wire.LocalSpeechActionRefusal {
	for _, text := range []string{stdout, stderr} {
		for _, line := range strings.Split(text, "\n") {
			trimmed := strings.TrimSpace(line)
			if trimmed == "" || !strings.HasPrefix(trimmed, "{") {
				continue
			}
			var ev speechEventLine
			if err := json.Unmarshal([]byte(trimmed), &ev); err == nil && ev.Error != nil && ev.Error.Code != "" {
				return &wire.LocalSpeechActionRefusal{
					Code:   sanitizeSpeechRefusalCode(ev.Error.Code),
					Detail: clip(ev.Error.Message, 4000),
				}
			}
		}
	}
	return nil
}

func sanitizeSpeechRefusalCode(code string) string {
	trimmed := strings.TrimSpace(code)
	if slices.Contains(speechRefusalCodes, trimmed) {
		return trimmed
	}
	return "UNKNOWN_ERROR"
}

func readFirstNonEmptyLine(path string) string {
	f, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = f.Close() }()
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 4096), maxEventLine)
	for scanner.Scan() {
		if line := strings.TrimSpace(scanner.Text()); line != "" {
			return line
		}
	}
	return ""
}

func isRetryableSidecarDialError(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) {
		return true
	}
	var opErr *net.OpError
	return errors.As(err, &opErr)
}
