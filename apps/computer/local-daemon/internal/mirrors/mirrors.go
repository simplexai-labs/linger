// Package mirrors reads Linger's shared simplex.region/v1 mirror profile and
// applies cached per-ecosystem download acceleration to localmodels and Agent
// Runtime environments with zero network round trips on the Run critical path.
package mirrors

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"time"
)

const (
	// Schema is the versioned identifier shared by Linger and localmodels.
	Schema = "simplex.region/v1"
	// MaxAge is how long a cached region.json profile remains fresh.
	MaxAge = 6 * time.Hour

	maxProfileBytes = 64 << 10
	maxConfigBytes  = 64 << 10

	defaultChinaPyPI    = "https://pypi.tuna.tsinghua.edu.cn/simple/"
	defaultChinaNPM     = "https://registry.npmmirror.com"
	defaultChinaGoProxy = "https://goproxy.cn"
	defaultChinaRust    = "https://mirrors.tuna.tsinghua.edu.cn/rustup"
	defaultChinaHF      = "https://hf-mirror.com"
	defaultChinaBrewAPI = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api"
	tsinghuaBrewBottles = "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"
	ustcBrewBottles     = "https://mirrors.ustc.edu.cn/homebrew-bottles"
)

var allowedURLsByEcosystem = map[string]map[string]struct{}{
	"pypi": {
		"https://pypi.org/simple":                       {},
		"https://pypi.tuna.tsinghua.edu.cn/simple":      {},
		"https://mirrors.aliyun.com/pypi/simple":        {},
		"https://pypi.mirrors.ustc.edu.cn/simple":       {},
		"https://mirrors.cloud.tencent.com/pypi/simple": {},
	},
	"npm": {
		"https://registry.npmjs.org":     {},
		"https://registry.npmmirror.com": {},
	},
	"node": {
		"https://nodejs.org/dist":                             {},
		"https://cdn.npmmirror.com/binaries/node":             {},
		"https://mirrors.tuna.tsinghua.edu.cn/nodejs-release": {},
	},
	"model_hub": {
		"https://huggingface.co": {},
		"https://hf-mirror.com":  {},
		"https://modelscope.cn":  {},
	},
	"go": {
		"https://proxy.golang.org": {},
		"https://goproxy.cn":       {},
		"https://goproxy.io":       {},
	},
	"rust": {
		"https://static.rust-lang.org":                {},
		"https://mirrors.tuna.tsinghua.edu.cn/rustup": {},
		"https://mirrors.ustc.edu.cn/rust-static":     {},
	},
	"homebrew": {
		"https://formulae.brew.sh/api":                              {},
		"https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api": {},
		"https://mirrors.ustc.edu.cn/homebrew-bottles/api":          {},
	},
}

func isValidMethod(method string) bool {
	return method == "env" || method == "probe" || method == "fallback"
}

func isProxyEnvName(lower string) bool {
	switch lower {
	case "http_proxy", "https_proxy", "all_proxy", "no_proxy":
		return true
	default:
		return false
	}
}

func isAllowedMirrorURL(raw, ecosystem string) bool {
	if raw == "" || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, " \t\r\n,|") {
		return false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return false
	}
	allowed, ok := allowedURLsByEcosystem[ecosystem]
	if !ok {
		return false
	}
	_, valid := allowed[strings.TrimRight(raw, "/")]
	return valid
}

func validEcosystemRecord(ecosystem string, rec EcosystemRecord) bool {
	if (rec.Region != "cn" && rec.Region != "global") ||
		rec.Name == "" ||
		rec.BytesPerSecond < 0 ||
		rec.MeasuredAt == "" ||
		!isValidMethod(rec.Method) ||
		!isAllowedMirrorURL(rec.URL, ecosystem) {
		return false
	}
	for _, cand := range rec.Candidates {
		if !isAllowedMirrorURL(cand, ecosystem) {
			return false
		}
	}
	return true
}

// EcosystemRecord captures the speed-tested winner for a single package or
// artifact ecosystem inside region.json.
type EcosystemRecord struct {
	Region         string   `json:"region"`
	Name           string   `json:"name"`
	URL            string   `json:"url"`
	BytesPerSecond int64    `json:"bytes_per_second"`
	Candidates     []string `json:"candidates"`
	MeasuredAt     string   `json:"measured_at"`
	Method         string   `json:"method"`
}

// Profile is the decoded simplex.region/v1 document shared by Linger, the
// Computer Daemon, and localmodels.
type Profile struct {
	Schema             string                     `json:"schema"`
	Region             string                     `json:"region"`
	ResolvedAt         string                     `json:"resolved_at"`
	Method             string                     `json:"method"`
	NetworkFingerprint string                     `json:"network_fingerprint,omitempty"`
	Ecosystems         map[string]EcosystemRecord `json:"ecosystems,omitempty"`
}

// RegionFileFromStateDir maps <home>/runtime/localmodels/state to the shared
// <home>/runtime/region.json path, returning empty for relative or too-shallow
// paths that would escape to the filesystem root.
func RegionFileFromStateDir(stateDir string) string {
	trimmed := strings.TrimSpace(stateDir)
	if trimmed == "" || !filepath.IsAbs(trimmed) {
		return ""
	}
	clean := filepath.Clean(trimmed)
	parent := filepath.Dir(clean)
	grandparent := filepath.Dir(parent)
	if grandparent == parent || grandparent == filepath.Dir(grandparent) {
		return ""
	}
	return filepath.Join(grandparent, "region.json")
}

// ResolveRegionFile returns an explicit absolute SIMPLEX_REGION_FILE from env,
// falling back to RegionFileFromStateDir(stateDir).
func ResolveRegionFile(env map[string]string, stateDir string) string {
	if explicit := strings.TrimSpace(envLookupFold(env, "SIMPLEX_REGION_FILE")); explicit != "" && filepath.IsAbs(explicit) {
		return filepath.Clean(explicit)
	}
	return RegionFileFromStateDir(stateDir)
}

// NetworkFingerprint returns an opaque SHA-256 fingerprint of active proxy
// environment variables, or "direct" when none are configured. Matches the
// Python and TypeScript implementations bit-for-bit and never leaks raw URLs.
func NetworkFingerprint(env map[string]string) string {
	seen := make(map[string]struct{})
	for key, raw := range env {
		lower := strings.ToLower(key)
		if !isProxyEnvName(lower) {
			continue
		}
		value := strings.TrimSpace(raw)
		if value == "" {
			continue
		}
		seen[lower+"="+value] = struct{}{}
	}
	if len(seen) == 0 {
		return "direct"
	}
	entries := make([]string, 0, len(seen))
	for item := range seen {
		entries = append(entries, item)
	}
	slices.Sort(entries)
	sum := sha256.Sum256([]byte(strings.Join(entries, "\n")))
	return "proxy:" + hex.EncodeToString(sum[:])[:16]
}

// ReadProfile loads a regular, fresh region.json matching the current proxy
// fingerprint. Missing, stale, malformed, or symlinked files return nil.
func ReadProfile(path string, env map[string]string, now time.Time) *Profile {
	return readProfile(path, env, now, false)
}

func readProfile(path string, env map[string]string, now time.Time, allowStale bool) *Profile {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxProfileBytes {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, maxProfileBytes+1))
	if err != nil || int64(len(raw)) > maxProfileBytes {
		return nil
	}
	var doc Profile
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil
	}
	if doc.Schema != Schema || (doc.Region != "cn" && doc.Region != "global") || !isValidMethod(doc.Method) {
		return nil
	}
	resolvedAt, err := time.Parse(time.RFC3339Nano, doc.ResolvedAt)
	if err != nil {
		resolvedAt, err = time.Parse(time.RFC3339, doc.ResolvedAt)
		if err != nil {
			return nil
		}
	}
	age := now.Sub(resolvedAt)
	if age < 0 || (!allowStale && age > MaxAge) {
		return nil
	}
	if doc.NetworkFingerprint != "" && doc.NetworkFingerprint != NetworkFingerprint(env) {
		return nil
	}
	if len(doc.Ecosystems) > 0 {
		clean := make(map[string]EcosystemRecord, len(doc.Ecosystems))
		for eco, rec := range doc.Ecosystems {
			if validEcosystemRecord(eco, rec) {
				clean[eco] = rec
			}
		}
		if len(clean) > 0 {
			doc.Ecosystems = clean
		} else {
			doc.Ecosystems = nil
		}
	}
	return &doc
}

// LocalmodelsEnv computes SIMPLEX_REGION_FILE and SIMPLEX_REGION overrides so
// localmodels invoked by the Daemon shares Linger's single region.json instead
// of splitting state under localmodels/state.
func LocalmodelsEnv(baseEnv map[string]string, stateDir string, now time.Time) map[string]string {
	out := make(map[string]string, 2)
	regionFile := ResolveRegionFile(baseEnv, stateDir)
	if regionFile != "" {
		out["SIMPLEX_REGION_FILE"] = regionFile
	}
	explicit := strings.TrimSpace(envLookupFold(baseEnv, "SIMPLEX_REGION"))
	if explicit == "cn" || explicit == "global" {
		out["SIMPLEX_REGION"] = explicit
		return out
	}
	if profile := ReadProfile(regionFile, baseEnv, now); profile != nil {
		out["SIMPLEX_REGION"] = profile.Region
	}
	return out
}

// ApplyAgentEnvironment injects cached language and package mirror variables
// into an Agent Run environment without adding any network round trips. Explicit
// user variables, user config files (pip.conf, uv.toml, .npmrc), and forced
// SIMPLEX_REGION=global are always preserved.
func ApplyAgentEnvironment(env map[string]string, regionFile string, now time.Time) {
	applyAgentEnvironmentForOSInDir(env, regionFile, "", now, runtime.GOOS)
}

// ApplyAgentEnvironmentInDir is like ApplyAgentEnvironment and also inspects
// workspace-level .npmrc, uv.toml, and pip.conf inside workDir before injecting
// package-manager mirror environment variables.
func ApplyAgentEnvironmentInDir(env map[string]string, regionFile, workDir string, now time.Time) {
	applyAgentEnvironmentForOSInDir(env, regionFile, workDir, now, runtime.GOOS)
}

func applyAgentEnvironmentForOS(env map[string]string, regionFile string, now time.Time, goos string) {
	applyAgentEnvironmentForOSInDir(env, regionFile, "", now, goos)
}

func applyAgentEnvironmentForOSInDir(env map[string]string, regionFile, workDir string, now time.Time, goos string) {
	if env == nil {
		return
	}
	explicit := strings.TrimSpace(envLookupFold(env, "SIMPLEX_REGION"))
	if explicit == "global" {
		return
	}
	if strings.TrimSpace(regionFile) == "" {
		regionFile = ResolveRegionFile(env, "")
	}
	// Read-only Agent Run consumers keep using a stale-but-fingerprint-matching
	// profile past MaxAge so long-running Desktop sessions do not silently fall
	// back to slow endpoints before the next Node/localmodels probe refreshes it.
	profile := readProfile(regionFile, env, now, true)
	effectiveRegion := ""
	if explicit == "cn" {
		effectiveRegion = "cn"
	} else if profile != nil {
		effectiveRegion = profile.Region
	}
	if effectiveRegion == "" && profile == nil {
		return
	}

	pickCN := func(ecosystem, fallback string) string {
		if profile != nil {
			if rec, ok := profile.Ecosystems[ecosystem]; ok && isAllowedMirrorURL(rec.URL, ecosystem) {
				if rec.Region == "cn" {
					return rec.URL
				}
				if rec.Region == "global" && explicit != "cn" {
					return ""
				}
			}
		}
		if effectiveRegion == "cn" {
			return fallback
		}
		return ""
	}

	if !hasAnyEnvFold(env, "PIP_INDEX_URL", "UV_DEFAULT_INDEX", "UV_INDEX_URL", "UV_INDEX") &&
		!userPythonIndexConfigured(env, workDir, goos) {
		if pypiURL := pickCN("pypi", defaultChinaPyPI); pypiURL != "" {
			env["PIP_INDEX_URL"] = pypiURL
			env["UV_DEFAULT_INDEX"] = pypiURL
		}
	}

	if !hasAnyEnvFold(env, "npm_config_registry", "pnpm_config_registry") &&
		!userNpmRegistryConfigured(env, workDir) {
		if npmURL := pickCN("npm", defaultChinaNPM); npmURL != "" {
			env["npm_config_registry"] = npmURL
			env["pnpm_config_registry"] = npmURL
		}
	}

	if !hasAnyEnvFold(env, "GOPROXY") {
		if goURL := pickCN("go", defaultChinaGoProxy); goURL != "" {
			env["GOPROXY"] = formatGoProxy(goURL)
		}
	}

	if !hasAnyEnvFold(env, "RUSTUP_DIST_SERVER", "RUSTUP_UPDATE_ROOT") {
		if rustURL := pickCN("rust", defaultChinaRust); rustURL != "" {
			env["RUSTUP_DIST_SERVER"] = rustURL
			env["RUSTUP_UPDATE_ROOT"] = strings.TrimRight(rustURL, "/") + "/rustup"
		}
	}

	if !hasAnyEnvFold(env, "HF_ENDPOINT") {
		if pickCN("model_hub", defaultChinaHF) != "" {
			env["HF_ENDPOINT"] = defaultChinaHF
		}
	}

	if goos == "darwin" && !hasAnyEnvFold(env, "HOMEBREW_API_DOMAIN", "HOMEBREW_BOTTLE_DOMAIN") {
		if brewURL := pickCN("homebrew", defaultChinaBrewAPI); brewURL != "" {
			env["HOMEBREW_API_DOMAIN"] = brewURL
			if parsed, err := url.Parse(brewURL); err == nil {
				switch strings.ToLower(parsed.Hostname()) {
				case "mirrors.tuna.tsinghua.edu.cn":
					env["HOMEBREW_BOTTLE_DOMAIN"] = tsinghuaBrewBottles
				case "mirrors.ustc.edu.cn":
					env["HOMEBREW_BOTTLE_DOMAIN"] = ustcBrewBottles
				}
			}
		}
	}
}

func formatGoProxy(primary string) string {
	chain := []string{primary}
	for _, fallback := range []string{"https://goproxy.cn", "https://goproxy.io"} {
		if !slices.Contains(chain, fallback) {
			chain = append(chain, fallback)
		}
	}
	chain = append(chain, "direct")
	return strings.Join(chain, "|")
}

func envLookupFold(env map[string]string, name string) string {
	if value, ok := env[name]; ok && strings.TrimSpace(value) != "" {
		return value
	}
	var keys []string
	for key := range env {
		if strings.EqualFold(key, name) {
			keys = append(keys, key)
		}
	}
	slices.Sort(keys)
	for _, key := range keys {
		if strings.TrimSpace(env[key]) != "" {
			return env[key]
		}
	}
	return ""
}

func hasAnyEnvFold(env map[string]string, names ...string) bool {
	for _, name := range names {
		if strings.TrimSpace(envLookupFold(env, name)) != "" {
			return true
		}
	}
	return false
}

func userHomeDir(env map[string]string) string {
	if home := strings.TrimSpace(envLookupFold(env, "HOME")); home != "" {
		return home
	}
	return strings.TrimSpace(envLookupFold(env, "USERPROFILE"))
}

func readSmallText(path string) string {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxConfigBytes {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer func() { _ = file.Close() }()
	raw, err := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	if err != nil || int64(len(raw)) > maxConfigBytes {
		return ""
	}
	return string(raw)
}

func hasKeyAssignment(lowerLine string, keys ...string) bool {
	for _, key := range keys {
		rest, ok := strings.CutPrefix(lowerLine, key)
		if !ok {
			continue
		}
		if strings.HasPrefix(strings.TrimLeft(rest, " \t"), "=") {
			return true
		}
	}
	return false
}

func userPythonIndexConfigured(env map[string]string, workDir, goos string) bool {
	home := userHomeDir(env)
	var paths []string
	for _, name := range []string{"PIP_CONFIG_FILE", "UV_CONFIG_FILE"} {
		if custom := strings.TrimSpace(envLookupFold(env, name)); custom != "" && custom != os.DevNull {
			paths = append(paths, custom)
		}
	}
	if strings.TrimSpace(workDir) != "" {
		paths = append(paths,
			filepath.Join(workDir, "uv.toml"),
			filepath.Join(workDir, "pip.conf"),
		)
	}
	if home != "" {
		xdg := strings.TrimSpace(envLookupFold(env, "XDG_CONFIG_HOME"))
		if xdg == "" {
			xdg = filepath.Join(home, ".config")
		}
		paths = append(paths,
			filepath.Join(home, ".pip", "pip.conf"),
			filepath.Join(xdg, "pip", "pip.conf"),
			filepath.Join(home, "Library", "Application Support", "pip", "pip.conf"),
			filepath.Join(xdg, "uv", "uv.toml"),
		)
	}
	if goos != "windows" {
		paths = append(paths, "/etc/pip.conf", "/etc/xdg/pip/pip.conf", "/etc/uv/uv.toml")
	}
	if appData := strings.TrimSpace(envLookupFold(env, "APPDATA")); appData != "" {
		paths = append(paths,
			filepath.Join(appData, "pip", "pip.ini"),
			filepath.Join(appData, "uv", "uv.toml"),
		)
	}
	for _, path := range paths {
		text := readSmallText(path)
		if text == "" {
			continue
		}
		for _, line := range strings.Split(text, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
				continue
			}
			lower := strings.ToLower(trimmed)
			if strings.HasPrefix(lower, "[[index]]") ||
				hasKeyAssignment(lower, "index-url", "default-index", "index") {
				return true
			}
		}
	}
	return false
}

func userNpmRegistryConfigured(env map[string]string, workDir string) bool {
	var paths []string
	if custom := strings.TrimSpace(envLookupFold(env, "NPM_CONFIG_USERCONFIG")); custom != "" && custom != os.DevNull {
		paths = append(paths, custom)
	}
	if strings.TrimSpace(workDir) != "" {
		paths = append(paths, filepath.Join(workDir, ".npmrc"))
	}
	if home := userHomeDir(env); home != "" {
		paths = append(paths, filepath.Join(home, ".npmrc"))
	}
	for _, path := range paths {
		text := readSmallText(path)
		if text == "" {
			continue
		}
		for _, line := range strings.Split(text, "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, ";") {
				continue
			}
			if hasKeyAssignment(strings.ToLower(trimmed), "registry") {
				return true
			}
		}
	}
	return false
}
