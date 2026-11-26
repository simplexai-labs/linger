package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

const (
	defaultPrefixWarmupTimeout  = 2 * time.Minute
	defaultPrefixFetchTimeout   = 15 * time.Second
	defaultCompactContextTokens = 128 * 1024
	maxStaticPrefixBundleBytes  = 4 << 20
	maxCachedPrefixBundles      = 8
)

var defaultPrefixFetchClient = &http.Client{
	Timeout: defaultPrefixFetchTimeout,
	CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

type staticPrefixVariants struct {
	Full    string `json:"full"`
	Compact string `json:"compact"`
}

type staticPrefixBundle struct {
	Version                 int    `json:"version"`
	Marker                  string `json:"marker"`
	CompactMaxContextTokens int    `json:"compact_max_context_tokens"`
	Prefixes                struct {
		Meta     staticPrefixVariants `json:"meta"`
		AlterEgo staticPrefixVariants `json:"alter_ego"`
	} `json:"prefixes"`
}

type cachedPrefixBundle struct {
	unsupported bool
	bundle      staticPrefixBundle
}

// PrefixWarmupRunner fetches deployment-level static system-prompt prefixes
// from Agent Service and pre-fills them into loaded PolyStrata models via Pi.
type PrefixWarmupRunner struct {
	ContentURL           func() string
	PiInstallation       func() (lingercontext.ProviderInstallation, bool)
	ManagedMCPExtension  string
	ServiceCommand       []string
	ToolGuide            string
	HostEnvironmentGuide string
	TeamHubCLI           bool
	TempBase             string
	HTTPClient           *http.Client
	Timeout              time.Duration
	RunWarmup            func(ctx context.Context, profile native.Profile, dir, instructionsFile, model string, pin native.StrataPinSpec) error

	mu      sync.Mutex
	bundles map[string]cachedPrefixBundle
}

// Warmup fetches the deployment's static prefix bundle and runs one-shot
// prefill-only Pi warm-ups for both Meta and AlterEgo contexts. It returns
// (false, nil) when prerequisites like ContentURL or Pi are not ready yet.
func (r *PrefixWarmupRunner) Warmup(ctx context.Context, target localmodels.PrefixWarmupTarget) (bool, error) {
	if strings.TrimSpace(r.ManagedMCPExtension) == "" || strings.TrimSpace(target.PiModel) == "" {
		return true, nil
	}
	if r.ContentURL == nil || r.PiInstallation == nil {
		return false, nil
	}
	contentURL := strings.TrimRight(strings.TrimSpace(r.ContentURL()), "/")
	if contentURL == "" {
		return false, nil
	}
	install, ok := r.PiInstallation()
	if !ok || strings.TrimSpace(install.ExecutablePath) == "" {
		return false, nil
	}

	bundle, supported, err := r.staticPrefixes(ctx, contentURL)
	if err != nil {
		return false, err
	}
	if !supported {
		return true, nil
	}

	compactLimit := bundle.CompactMaxContextTokens
	if compactLimit <= 0 {
		compactLimit = defaultCompactContextTokens
	}
	useCompact := target.ContextTokens > 0 && target.ContextTokens <= uint64(compactLimit)
	metaPrefix := bundle.Prefixes.Meta.Full
	alterEgoPrefix := bundle.Prefixes.AlterEgo.Full
	if useCompact {
		metaPrefix = bundle.Prefixes.Meta.Compact
		alterEgoPrefix = bundle.Prefixes.AlterEgo.Compact
	}
	marker := bundle.Marker
	if marker == "" {
		marker = lingercontext.StaticPrefixEndMarker
	}

	guides := lingercontext.PiDaemonStaticGuides(r.ServiceCommand, r.ToolGuide, r.HostEnvironmentGuide, true, true, r.TeamHubCLI)
	if r.TempBase != "" {
		if err := os.MkdirAll(r.TempBase, 0o700); err != nil {
			return false, fmt.Errorf("create prefix warm-up temp root: %w", err)
		}
	}
	workDir, err := os.MkdirTemp(r.TempBase, "prefix-warmup-*")
	if err != nil {
		return false, fmt.Errorf("create prefix warm-up directory: %w", err)
	}
	defer os.RemoveAll(workDir)

	timeout := r.Timeout
	if timeout <= 0 {
		timeout = defaultPrefixWarmupTimeout
	}
	warmupCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	profile := native.Profile{
		Program:             install.ExecutablePath,
		Env:                 install.Environment,
		Logger:              slog.Default(),
		ManagedMCPExtension: r.ManagedMCPExtension,
	}
	run := r.RunWarmup
	if run == nil {
		run = native.WarmupPiPrefix
	}

	for _, entry := range []struct {
		pinName string
		prefix  string
	}{
		{pinName: "linger-meta", prefix: metaPrefix},
		{pinName: "linger-alter-ego", prefix: alterEgoPrefix},
	} {
		assembled := lingercontext.AssembleWarmupSystemPrompt(entry.prefix, guides)
		if assembled == "" {
			continue
		}
		instructionsPath := filepath.Join(workDir, entry.pinName+".md")
		if err := os.WriteFile(instructionsPath, []byte(assembled), 0o600); err != nil {
			return false, fmt.Errorf("write prefix warm-up instructions: %w", err)
		}
		pin := native.StrataPinSpec{
			Name:        entry.pinName,
			PrefillOnly: true,
			Resident:    "ram",
			Anchor:      marker,
		}
		if err := run(warmupCtx, profile, workDir, instructionsPath, target.PiModel, pin); err != nil {
			return false, err
		}
	}
	return true, nil
}

func (r *PrefixWarmupRunner) httpClient() *http.Client {
	if r.HTTPClient != nil {
		return r.HTTPClient
	}
	return defaultPrefixFetchClient
}

func (r *PrefixWarmupRunner) staticPrefixes(ctx context.Context, contentURL string) (staticPrefixBundle, bool, error) {
	r.mu.Lock()
	cached, ok := r.bundles[contentURL]
	r.mu.Unlock()
	if ok {
		if cached.unsupported {
			return staticPrefixBundle{}, false, nil
		}
		return cached.bundle, true, nil
	}

	reqCtx, cancel := context.WithTimeout(ctx, defaultPrefixFetchTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(reqCtx, http.MethodGet, contentURL+"/static-prefixes/v1", nil)
	if err != nil {
		return staticPrefixBundle{}, false, err
	}
	request.Header.Set("Cache-Control", "no-store")
	response, err := r.httpClient().Do(request)
	if err != nil {
		return staticPrefixBundle{}, false, fmt.Errorf("fetch static prefixes: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode == http.StatusNotFound {
		r.storeBundle(contentURL, cachedPrefixBundle{unsupported: true})
		return staticPrefixBundle{}, false, nil
	}
	if response.StatusCode != http.StatusOK {
		return staticPrefixBundle{}, false, fmt.Errorf("fetch static prefixes: unexpected HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxStaticPrefixBundleBytes+1))
	if err != nil {
		return staticPrefixBundle{}, false, fmt.Errorf("read static prefixes: %w", err)
	}
	if len(body) > maxStaticPrefixBundleBytes {
		return staticPrefixBundle{}, false, fmt.Errorf("static prefixes exceeded %d bytes", maxStaticPrefixBundleBytes)
	}
	var bundle staticPrefixBundle
	if err := json.Unmarshal(body, &bundle); err != nil {
		return staticPrefixBundle{}, false, fmt.Errorf("decode static prefixes: %w", err)
	}
	if bundle.Version != 1 {
		return staticPrefixBundle{}, false, fmt.Errorf("unsupported static prefixes version %d", bundle.Version)
	}
	r.storeBundle(contentURL, cachedPrefixBundle{bundle: bundle})
	return bundle, true, nil
}

func (r *PrefixWarmupRunner) storeBundle(contentURL string, entry cachedPrefixBundle) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.bundles == nil {
		r.bundles = make(map[string]cachedPrefixBundle)
	} else if len(r.bundles) >= maxCachedPrefixBundles {
		clear(r.bundles)
	}
	r.bundles[contentURL] = entry
}
