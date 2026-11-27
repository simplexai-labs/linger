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
	"time"

	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/localmodels"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

const (
	defaultPrefixWarmupTimeout = 2 * time.Minute
	defaultPrefixFetchTimeout  = 15 * time.Second
	maxStaticPrefixBundleBytes = 4 << 20
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
	WarmupMCPServers     func(ctx context.Context) (json.RawMessage, func(), error)
	RunWarmup            func(ctx context.Context, profile native.Profile, dir, instructionsFile, model string, pin native.StrataPinSpec, mcpConfig json.RawMessage) error
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

	useCompact := target.ContextTokens > 0 && target.ContextTokens <= uint64(bundle.CompactMaxContextTokens)
	metaPrefix := bundle.Prefixes.Meta.Full
	alterEgoPrefix := bundle.Prefixes.AlterEgo.Full
	if useCompact {
		metaPrefix = bundle.Prefixes.Meta.Compact
		alterEgoPrefix = bundle.Prefixes.AlterEgo.Compact
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

	var mcpConfig json.RawMessage
	if r.WarmupMCPServers != nil {
		var closeMCP func()
		mcpConfig, closeMCP, err = r.WarmupMCPServers(warmupCtx)
		if err != nil {
			return false, err
		}
		if closeMCP != nil {
			defer closeMCP()
		}
	}

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
			Anchor:      bundle.Marker,
		}
		if err := run(warmupCtx, profile, workDir, instructionsPath, target.PiModel, pin, mcpConfig); err != nil {
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
	if bundle.CompactMaxContextTokens <= 0 {
		return staticPrefixBundle{}, false, fmt.Errorf("static prefixes compact_max_context_tokens must be positive, got %d", bundle.CompactMaxContextTokens)
	}
	if strings.TrimSpace(bundle.Marker) == "" {
		return staticPrefixBundle{}, false, fmt.Errorf("static prefixes marker is empty")
	}
	return bundle, true, nil
}
