package localmodels

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	wire "github.com/simplexai-labs/linger/contracts-go/runnergateway"
)

const (
	concurrencyProbeSchema     = "linger.local-models-concurrency-probes/v1"
	concurrencyProbeFileName   = "concurrency-probes.json"
	concurrencyProbeTempPrefix = ".concurrency-probes-"

	maxProbedConcurrency = uint64(2)

	defaultProbeReadinessTimeout      = 10 * time.Second
	defaultProbeReadinessPollInterval = 200 * time.Millisecond
	defaultProbeBaselineTimeout       = 30 * time.Second
	defaultProbeMaxSlowdownRatio      = 1.3
	defaultProbeDeadlineRatio         = 1.5
	defaultProbeMinOverheadMargin     = 100 * time.Millisecond
	defaultProbeNoiseAllowance        = 10 * time.Millisecond
	defaultProbePromptWords           = 450
	maxDeployRecordBytes              = 1 << 20
	maxDeployAPIKeyBytes              = 64 << 10
	maxProbeResponseBytes             = 1 << 20
)

var sanitizeModelIDRegexp = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

type probeConfig struct {
	readinessTimeout      time.Duration
	readinessPollInterval time.Duration
	baselineTimeout       time.Duration
	maxSlowdownRatio      float64
	deadlineRatio         float64
	minOverheadMargin     time.Duration
	noiseAllowance        time.Duration
	promptWords           int
}

func defaultProbeConfig() probeConfig {
	return probeConfig{
		readinessTimeout:      defaultProbeReadinessTimeout,
		readinessPollInterval: defaultProbeReadinessPollInterval,
		baselineTimeout:       defaultProbeBaselineTimeout,
		maxSlowdownRatio:      defaultProbeMaxSlowdownRatio,
		deadlineRatio:         defaultProbeDeadlineRatio,
		minOverheadMargin:     defaultProbeMinOverheadMargin,
		noiseAllowance:        defaultProbeNoiseAllowance,
		promptWords:           defaultProbePromptWords,
	}
}

type probeFingerprint struct {
	ModelID               string `json:"model_id"`
	Engine                string `json:"engine"`
	EngineLabel           string `json:"engine_label"`
	Pool                  string `json:"pool"`
	ContextTokens         uint64 `json:"context_tokens"`
	ConfiguredConcurrency uint64 `json:"configured_concurrency"`
	ToolVersion           string `json:"tool_version"`
}

func probeFingerprintFor(toolVersion string, model wire.LocalModel) probeFingerprint {
	var configured uint64
	if model.Concurrency != nil {
		configured = *model.Concurrency
	}
	return probeFingerprint{
		ModelID:               model.ID,
		Engine:                model.Engine,
		EngineLabel:           model.EngineLabel,
		Pool:                  model.Pool,
		ContextTokens:         model.ContextTokens,
		ConfiguredConcurrency: configured,
		ToolVersion:           toolVersion,
	}
}

type probeCacheEntry struct {
	Fingerprint probeFingerprint `json:"fingerprint"`
	Detected    uint64           `json:"detected"`
	ProbedAt    string           `json:"probed_at"`
}

type probeCacheFile struct {
	Schema  string                     `json:"schema"`
	Entries map[string]probeCacheEntry `json:"entries"`
}

// probeCache persists verified post-load concurrency probe results atomically
// in concurrency-probes.json so reloads and Daemon restarts reuse them.
type probeCache struct {
	path    string
	mu      sync.Mutex
	loaded  bool
	entries map[string]probeCacheEntry
}

func newProbeCache(directory string) *probeCache {
	cache := &probeCache{entries: make(map[string]probeCacheEntry)}
	if directory == "" {
		return cache
	}
	if entries, err := os.ReadDir(directory); err == nil {
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), concurrencyProbeTempPrefix) {
				_ = os.Remove(filepath.Join(directory, entry.Name()))
			}
		}
	}
	cache.path = filepath.Join(directory, concurrencyProbeFileName)
	return cache
}

func (c *probeCache) get(fp probeFingerprint) (uint64, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ensureLoadedLocked()
	entry, ok := c.entries[fp.ModelID]
	if !ok || entry.Fingerprint != fp {
		return 0, false
	}
	limit := min(fp.ConfiguredConcurrency, maxProbedConcurrency)
	if entry.Detected < 1 || entry.Detected > limit {
		return 0, false
	}
	return entry.Detected, true
}

func (c *probeCache) put(fp probeFingerprint, detected uint64, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.ensureLoadedLocked()
	c.entries[fp.ModelID] = probeCacheEntry{
		Fingerprint: fp,
		Detected:    detected,
		ProbedAt:    now.UTC().Format(time.RFC3339Nano),
	}
	if c.path != "" {
		c.writeLocked()
	}
}

func (c *probeCache) ensureLoadedLocked() {
	if c.loaded {
		return
	}
	c.loaded = true
	if c.path == "" {
		return
	}
	encoded, err := os.ReadFile(c.path)
	if errors.Is(err, fs.ErrNotExist) {
		return
	}
	var document probeCacheFile
	if err == nil {
		err = json.Unmarshal(encoded, &document)
	}
	if err == nil && document.Schema != concurrencyProbeSchema {
		err = errors.New("unknown schema")
	}
	if err != nil {
		slog.Warn("local_models.concurrency_probe_cache_invalid", "error", err)
		return
	}
	for id, entry := range document.Entries {
		if id == "" || entry.Fingerprint.ModelID != id || entry.Detected < 1 {
			continue
		}
		c.entries[id] = entry
	}
}

// writeLocked replaces concurrency-probes.json atomically, matching pi_catalog.go.
func (c *probeCache) writeLocked() {
	directory := filepath.Dir(c.path)
	err := func() error {
		encoded, err := json.Marshal(probeCacheFile{
			Schema:  concurrencyProbeSchema,
			Entries: c.entries,
		})
		if err != nil {
			return err
		}
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return err
		}
		temp, err := os.CreateTemp(directory, concurrencyProbeTempPrefix+"*")
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
		slog.Warn("local_models.concurrency_probe_cache_write_failed", "error", err)
		return
	}
	if handle, err := os.Open(directory); err == nil {
		_ = handle.Sync()
		_ = handle.Close()
	}
}

type concurrencyProber struct {
	cache        *probeCache
	toolStateDir string
	client       *http.Client
	cfg          probeConfig
}

func newConcurrencyProber(cacheDir, toolStateDir string) *concurrencyProber {
	return &concurrencyProber{
		cache:        newProbeCache(cacheDir),
		toolStateDir: toolStateDir,
		client: &http.Client{
			Transport:     &http.Transport{Proxy: nil, DisableKeepAlives: true},
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		cfg: defaultProbeConfig(),
	}
}

type deployRecord struct {
	ID   string `json:"id"`
	Plan *struct {
		Endpoint *struct {
			BaseURL string `json:"base_url"`
			Model   string `json:"model"`
		} `json:"endpoint"`
		Service *struct {
			DeployDir string `json:"deploy_dir"`
		} `json:"service"`
	} `json:"plan"`
}

func sanitizeModelFilename(id string) string {
	return sanitizeModelIDRegexp.ReplaceAllString(id, "_")
}

// lookupDeployAuth inspects <LOCALMODELS_STATE>/library/models/*.json for the
// deployed model's endpoint model ID and <deploy_dir>/api-key bearer token.
// Missing records or api-key files return empty credentials gracefully.
func lookupDeployAuth(toolStateDir, modelID, baseURL string) (requestModel, apiKey string) {
	requestModel = modelID
	if toolStateDir == "" {
		return requestModel, ""
	}
	modelsDir := filepath.Join(toolStateDir, "library", "models")
	entries, err := os.ReadDir(modelsDir)
	if err != nil {
		return requestModel, ""
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)

	sanitizedTarget := sanitizeModelFilename(modelID)
	normalizedTargetURL := normalizeEndpointURL(baseURL)

	var bestRecord *deployRecord
	bestRank := 0
	for _, name := range names {
		path := filepath.Join(modelsDir, name)
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		raw, err := readBounded(path, maxDeployRecordBytes)
		if err != nil {
			continue
		}
		var rec deployRecord
		if err := json.Unmarshal(raw, &rec); err != nil {
			continue
		}
		rank := 0
		fileBase := strings.TrimSuffix(name, ".json")
		switch {
		case rec.ID != "" && rec.ID == modelID:
			rank = 3
		case fileBase == sanitizedTarget || (rec.ID != "" && sanitizeModelFilename(rec.ID) == sanitizedTarget):
			rank = 2
		case normalizedTargetURL != "" && rec.Plan != nil && rec.Plan.Endpoint != nil &&
			normalizeEndpointURL(rec.Plan.Endpoint.BaseURL) == normalizedTargetURL:
			rank = 1
		}
		if rank > bestRank {
			bestRank = rank
			copied := rec
			bestRecord = &copied
			if bestRank == 3 {
				break
			}
		}
	}
	if bestRecord == nil || bestRecord.Plan == nil {
		return requestModel, ""
	}
	if bestRecord.Plan.Endpoint != nil {
		if m := strings.TrimSpace(bestRecord.Plan.Endpoint.Model); m != "" {
			requestModel = m
		}
	}
	if bestRecord.Plan.Service != nil {
		if deployDir := strings.TrimSpace(bestRecord.Plan.Service.DeployDir); deployDir != "" {
			keyPath := filepath.Join(deployDir, "api-key")
			if info, err := os.Lstat(keyPath); err == nil && info.Mode().IsRegular() {
				if raw, err := readBounded(keyPath, maxDeployAPIKeyBytes); err == nil {
					apiKey = strings.TrimSpace(string(raw))
				}
			}
		}
	}
	return requestModel, apiKey
}

func normalizeEndpointURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	parsed, err := url.Parse(trimmed)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return strings.TrimRight(trimmed, "/")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	parsed.Host = strings.ToLower(parsed.Host)
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = ""
	return parsed.String()
}

// parseLoopbackBaseURL accepts only direct HTTP loopback URLs so probes never
// leave the Computer or resolve through proxies.
func parseLoopbackBaseURL(raw string) (string, bool) {
	parsed, ok := parseLoopbackHTTPURL(raw, false)
	if !ok {
		return "", false
	}
	return parsed.String(), true
}

type probeChatRequest struct {
	Model       string             `json:"model"`
	Messages    []probeChatMessage `json:"messages"`
	MaxTokens   int                `json:"max_tokens"`
	Temperature float64            `json:"temperature"`
	Stream      bool               `json:"stream"`
}

type probeChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type probeChatResponse struct {
	Choices []json.RawMessage `json:"choices"`
}

// buildProbePrompt generates a deterministic ~1000-token prompt whose tokens are
// distinct from token 0 per variant so prefix caching cannot distort Phase 2.
func buildProbePrompt(variant string, wordCount int) string {
	if wordCount <= 0 {
		wordCount = defaultProbePromptWords
	}
	var b strings.Builder
	b.Grow(wordCount * 16)
	fmt.Fprintf(&b, "Concurrency probe run %s. Ignore all preceding tokens and reply with OK.\n", variant)
	for i := range wordCount {
		if i > 0 {
			b.WriteByte(' ')
		}
		fmt.Fprintf(&b, "%s_%04d", variant, i)
	}
	b.WriteString("\nReply with the single word OK.")
	return b.String()
}

type probeCallResult struct {
	duration time.Duration
	err      error
}

// probe measures whether a loaded model sustains 2 concurrent requests without
// significant slowdown. measured is true only when baseline succeeded and the
// parallel pair produced a definitive concurrency measurement; errors and
// timeouts return measured=false so transient conditions are never cached as 1.
func (p *concurrencyProber) probe(ctx context.Context, modelID, rawBaseURL string, configured uint64) (uint64, bool) {
	if configured <= 1 {
		return 1, false
	}
	baseURL, ok := parseLoopbackBaseURL(rawBaseURL)
	if !ok {
		slog.Warn("local_models.concurrency_probe_rejected_url", "model", modelID)
		return 0, false
	}
	requestModel, apiKey := lookupDeployAuth(p.toolStateDir, modelID, baseURL)

	ready, authFailed := p.waitReady(ctx, baseURL, apiKey)
	if authFailed || !ready || ctx.Err() != nil {
		return 0, false
	}

	baselineCtx, cancelBaseline := context.WithTimeout(ctx, p.cfg.baselineTimeout)
	t1, err := p.runChatCompletion(baselineCtx, baseURL, requestModel, apiKey, buildProbePrompt("baseline", p.cfg.promptWords))
	cancelBaseline()
	if err != nil || ctx.Err() != nil {
		slog.Warn("local_models.concurrency_probe_baseline_failed", "model", modelID, "error", err)
		return 0, false
	}

	threshold := time.Duration(p.cfg.maxSlowdownRatio*float64(t1)) + p.cfg.noiseAllowance
	attemptDeadline := max(time.Duration(p.cfg.deadlineRatio*float64(t1)), t1+p.cfg.minOverheadMargin)
	if p.cfg.baselineTimeout > 0 && attemptDeadline > p.cfg.baselineTimeout {
		attemptDeadline = p.cfg.baselineTimeout
	}

	attemptCtx, cancelAttempt := context.WithTimeout(ctx, attemptDeadline)
	defer cancelAttempt()

	results := make(chan probeCallResult, 2)
	for _, variant := range []string{"concurrent-alpha", "concurrent-beta"} {
		prompt := buildProbePrompt(variant, p.cfg.promptWords)
		go func() {
			duration, callErr := p.runChatCompletion(attemptCtx, baseURL, requestModel, apiKey, prompt)
			results <- probeCallResult{duration: duration, err: callErr}
		}()
	}

	first := <-results
	if first.err != nil {
		cancelAttempt()
		<-results
		return 0, false
	}
	if first.duration > threshold {
		cancelAttempt()
		<-results
		return 1, true
	}
	second := <-results
	if second.err != nil {
		if ctx.Err() == nil && errors.Is(attemptCtx.Err(), context.DeadlineExceeded) && attemptDeadline > threshold {
			return 1, true
		}
		return 0, false
	}
	if second.duration > threshold {
		return 1, true
	}
	return min(configured, maxProbedConcurrency), true
}

func (p *concurrencyProber) waitReady(ctx context.Context, baseURL, apiKey string) (ready, authFailed bool) {
	deadline := time.Now().Add(p.cfg.readinessTimeout)
	modelsURL := baseURL + "/models"
	for {
		if ctx.Err() != nil {
			return false, false
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return false, false
		}
		attemptTimeout := min(2*time.Second, remaining)
		reqCtx, cancel := context.WithTimeout(ctx, attemptTimeout)
		req, err := http.NewRequestWithContext(reqCtx, http.MethodGet, modelsURL, nil)
		if err != nil {
			cancel()
			return false, false
		}
		if apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+apiKey)
		}
		resp, err := p.client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
			_ = resp.Body.Close()
		}
		cancel()
		if err == nil {
			switch {
			case resp.StatusCode >= 200 && resp.StatusCode < 300,
				resp.StatusCode == http.StatusNotFound,
				resp.StatusCode == http.StatusMethodNotAllowed:
				return true, false
			case resp.StatusCode == http.StatusUnauthorized, resp.StatusCode == http.StatusForbidden:
				slog.Warn("local_models.concurrency_probe_unauthorized", "status", resp.StatusCode)
				return false, true
			}
		}
		if time.Now().After(deadline) {
			return false, false
		}
		sleep := min(p.cfg.readinessPollInterval, time.Until(deadline))
		if sleep <= 0 {
			return false, false
		}
		timer := time.NewTimer(sleep)
		select {
		case <-ctx.Done():
			timer.Stop()
			return false, false
		case <-timer.C:
		}
	}
}

func (p *concurrencyProber) runChatCompletion(ctx context.Context, baseURL, modelName, apiKey, prompt string) (time.Duration, error) {
	payload, err := json.Marshal(probeChatRequest{
		Model:       modelName,
		Messages:    []probeChatMessage{{Role: "user", Content: prompt}},
		MaxTokens:   32,
		Temperature: 0,
		Stream:      false,
	})
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	started := time.Now()
	resp, err := p.client.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxProbeResponseBytes))
	elapsed := time.Since(started)
	if err != nil {
		return elapsed, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return elapsed, fmt.Errorf("chat completions returned status %d", resp.StatusCode)
	}
	var decoded probeChatResponse
	if err := json.Unmarshal(body, &decoded); err != nil {
		return elapsed, fmt.Errorf("decode chat completions response: %w", err)
	}
	if len(decoded.Choices) == 0 {
		return elapsed, errors.New("chat completions response contained no choices")
	}
	return elapsed, nil
}

type activeProbe struct {
	fp     probeFingerprint
	cancel context.CancelFunc
}

// reconcileProbes applies cached probe concurrency results and overlays
// state="loading" with concurrency_probing=true while a one-time loopback
// probe runs for a loaded model whose configured concurrency exceeds 1.
func (l *Library) reconcileProbes(snapshot *wire.LocalModelsSnapshot) {
	if l.prober == nil || !snapshot.Available {
		return
	}
	type pendingTarget struct {
		index   int
		baseURL string
		fp      probeFingerprint
	}
	desired := make(map[string]pendingTarget)
	loadedFPs := make(map[string]probeFingerprint)
	for i := range snapshot.Models {
		model := &snapshot.Models[i]
		model.ConcurrencyProbing = nil
		if model.State != "loaded" || model.Concurrency == nil || *model.Concurrency <= 1 {
			continue
		}
		fp := probeFingerprintFor(snapshot.ToolVersion, *model)
		if detected, ok := l.prober.cache.get(fp); ok {
			d := min(detected, *model.Concurrency)
			model.Concurrency = &d
			continue
		}
		loadedFPs[model.ID] = fp
		if model.Endpoint == nil {
			slog.Warn("local_models.concurrency_probe_skipped", "model", model.ID, "reason", "missing_endpoint")
			model.Concurrency = nil
			continue
		}
		baseURL, ok := parseLoopbackBaseURL(model.Endpoint.BaseURL)
		if !ok {
			slog.Warn("local_models.concurrency_probe_skipped", "model", model.ID, "reason", "non_loopback_endpoint")
			model.Concurrency = nil
			continue
		}
		desired[model.ID] = pendingTarget{index: i, baseURL: baseURL, fp: fp}
	}

	l.mu.Lock()
	for id, fp := range l.probeUnknown {
		if currentFP, ok := loadedFPs[id]; !ok || currentFP != fp {
			delete(l.probeUnknown, id)
		}
	}
	for id, active := range l.probes {
		target, ok := desired[id]
		if !ok || active.fp != target.fp {
			active.cancel()
			delete(l.probes, id)
		}
	}
	for id, target := range desired {
		model := &snapshot.Models[target.index]
		if unknownFP, marked := l.probeUnknown[id]; marked && unknownFP == target.fp {
			model.Concurrency = nil
			continue
		}
		if l.closed || l.ctx.Err() != nil {
			continue
		}
		configured := *model.Concurrency
		if _, running := l.probes[id]; !running {
			l.wg.Add(1)
			probeCtx, probeCancel := context.WithCancel(l.ctx)
			probe := &activeProbe{fp: target.fp, cancel: probeCancel}
			l.probes[id] = probe
			go l.runConcurrencyProbe(probeCtx, probe, id, target.baseURL, configured, target.fp)
		}
		probing := true
		model.State = "loading"
		model.ConcurrencyProbing = &probing
		model.Endpoint = nil
		model.Concurrency = nil
	}
	l.mu.Unlock()
}

func (l *Library) runConcurrencyProbe(
	ctx context.Context,
	probe *activeProbe,
	modelID, baseURL string,
	configured uint64,
	fp probeFingerprint,
) {
	defer l.wg.Done()
	defer probe.cancel()
	detected, measured := l.prober.probe(ctx, modelID, baseURL, configured)
	if ctx.Err() != nil {
		return
	}
	if measured {
		l.prober.cache.put(fp, detected, l.now())
	}

	l.mu.Lock()
	current := l.probes[modelID]
	if current == probe {
		delete(l.probes, modelID)
		if measured {
			delete(l.probeUnknown, modelID)
		} else {
			l.probeUnknown[modelID] = fp
		}
	}
	closed := l.closed
	l.mu.Unlock()

	if current == probe && !closed && l.ctx.Err() == nil {
		if measured {
			slog.Info("local_models.concurrency_probed", "model", modelID, "configured", configured, "detected", detected)
		} else {
			slog.Info("local_models.concurrency_probe_unmeasured", "model", modelID, "configured", configured)
		}
		l.Refresh(l.ctx)
	}
}

func (l *Library) cancelProbe(modelID string) bool {
	if modelID == "" {
		return false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.cancelProbeLocked(modelID)
}

func (l *Library) cancelProbeLocked(modelID string) bool {
	if modelID == "" {
		return false
	}
	delete(l.probeUnknown, modelID)
	active, ok := l.probes[modelID]
	if !ok {
		return false
	}
	active.cancel()
	delete(l.probes, modelID)
	return true
}

func (l *Library) cancelAllProbes() {
	l.mu.Lock()
	defer l.mu.Unlock()
	for id, active := range l.probes {
		active.cancel()
		delete(l.probes, id)
	}
	clear(l.probeUnknown)
}
