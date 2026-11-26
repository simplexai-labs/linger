package mirrors

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func writeRegionJSON(t *testing.T, dir string, profile Profile) string {
	t.Helper()
	path := filepath.Join(dir, "region.json")
	raw, err := json.Marshal(profile)
	if err != nil {
		t.Fatalf("marshal profile: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write profile: %v", err)
	}
	return path
}

func TestRegionFileFromStateDir(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "runtime", "localmodels", "state")
	got := RegionFileFromStateDir(stateDir)
	want := filepath.Join(filepath.Dir(filepath.Dir(stateDir)), "region.json")
	if got != want {
		t.Fatalf("RegionFileFromStateDir(%q) = %q, want %q", stateDir, got, want)
	}
	if RegionFileFromStateDir("") != "" {
		t.Fatalf("expected empty path for empty stateDir")
	}
}

func TestNetworkFingerprintStabilityAndRedaction(t *testing.T) {
	if got := NetworkFingerprint(map[string]string{}); got != "direct" {
		t.Fatalf("empty env fingerprint = %q, want direct", got)
	}
	fpUpper := NetworkFingerprint(map[string]string{"HTTPS_PROXY": "http://127.0.0.1:7890"})
	fpLower := NetworkFingerprint(map[string]string{"https_proxy": "http://127.0.0.1:7890"})
	if fpUpper != fpLower {
		t.Fatalf("expected case-insensitive match: %q vs %q", fpUpper, fpLower)
	}
	if !strings.HasPrefix(fpUpper, "proxy:") || len(fpUpper) != len("proxy:")+16 {
		t.Fatalf("unexpected fingerprint format: %q", fpUpper)
	}
	if strings.Contains(fpUpper, "7890") {
		t.Fatalf("fingerprint leaked proxy port: %q", fpUpper)
	}
}

func TestReadProfileFreshnessAndProxyInvalidation(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	path := writeRegionJSON(t, dir, Profile{
		Schema:             Schema,
		Region:             "cn",
		ResolvedAt:         now.Add(-2 * time.Hour).Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
	})
	if prof := ReadProfile(path, map[string]string{}, now); prof == nil || prof.Region != "cn" {
		t.Fatalf("expected fresh profile, got %#v", prof)
	}
	// Proxy change invalidates the cached profile immediately.
	if prof := ReadProfile(path, map[string]string{"HTTPS_PROXY": "http://127.0.0.1:7890"}, now); prof != nil {
		t.Fatalf("expected nil profile after proxy change, got %#v", prof)
	}
	// Older than MaxAge (6h) is rejected by ReadProfile so LocalmodelsEnv does
	// not lock localmodels to a stale SIMPLEX_REGION and lets it re-probe.
	if prof := ReadProfile(path, map[string]string{}, now.Add(7*time.Hour)); prof != nil {
		t.Fatalf("expected stale profile to be ignored by ReadProfile, got %#v", prof)
	}
}

func TestApplyAgentEnvironmentKeepsStaleProfileUntilProxyChanges(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	home := t.TempDir()
	runtimeDir := filepath.Join(home, "runtime")
	stateDir := filepath.Join(runtimeDir, "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	regionPath := writeRegionJSON(t, runtimeDir, Profile{
		Schema:             Schema,
		Region:             "cn",
		ResolvedAt:         now.Add(-8 * time.Hour).Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
		Ecosystems: map[string]EcosystemRecord{
			"pypi": {
				Region:         "cn",
				Name:           "pypi-tsinghua",
				URL:            "https://pypi.tuna.tsinghua.edu.cn/simple/",
				BytesPerSecond: 880_000,
				MeasuredAt:     now.Add(-8 * time.Hour).Format(time.RFC3339),
				Method:         "probe",
			},
		},
	})

	// LocalmodelsEnv still shares SIMPLEX_REGION_FILE, but does not pin SIMPLEX_REGION
	// from a stale profile so localmodels can re-probe and refresh region.json.
	lmEnv := LocalmodelsEnv(map[string]string{}, stateDir, now)
	if lmEnv["SIMPLEX_REGION_FILE"] != regionPath {
		t.Fatalf("SIMPLEX_REGION_FILE = %q, want %q", lmEnv["SIMPLEX_REGION_FILE"], regionPath)
	}
	if _, pinned := lmEnv["SIMPLEX_REGION"]; pinned {
		t.Fatalf("expected stale profile not to pin SIMPLEX_REGION for localmodels, got %q", lmEnv["SIMPLEX_REGION"])
	}

	// Read-only Agent Runs keep using the stale profile while the proxy fingerprint matches.
	agentEnv := map[string]string{"HOME": home}
	applyAgentEnvironmentForOS(agentEnv, regionPath, now, "linux")
	if agentEnv["PIP_INDEX_URL"] != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("expected stale profile to keep PIP_INDEX_URL, got %q", agentEnv["PIP_INDEX_URL"])
	}
	if agentEnv["npm_config_registry"] != defaultChinaNPM {
		t.Fatalf("expected stale profile to keep npm_config_registry, got %q", agentEnv["npm_config_registry"])
	}

	// Changing proxy immediately invalidates even a stale profile.
	proxyChanged := map[string]string{"HOME": home, "HTTPS_PROXY": "http://127.0.0.1:7890"}
	applyAgentEnvironmentForOS(proxyChanged, regionPath, now, "linux")
	if _, set := proxyChanged["PIP_INDEX_URL"]; set {
		t.Fatalf("expected proxy change to drop stale profile injection, got %v", proxyChanged)
	}
}

func TestLocalmodelsEnvSharesLingerRegionFileAndCachedRegion(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	home := t.TempDir()
	runtimeDir := filepath.Join(home, "runtime")
	stateDir := filepath.Join(runtimeDir, "localmodels", "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	regionPath := writeRegionJSON(t, runtimeDir, Profile{
		Schema:             Schema,
		Region:             "cn",
		ResolvedAt:         now.Add(-30 * time.Minute).Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
	})

	env := LocalmodelsEnv(map[string]string{}, stateDir, now)
	if env["SIMPLEX_REGION_FILE"] != regionPath {
		t.Fatalf("SIMPLEX_REGION_FILE = %q, want %q", env["SIMPLEX_REGION_FILE"], regionPath)
	}
	if env["SIMPLEX_REGION"] != "cn" {
		t.Fatalf("SIMPLEX_REGION = %q, want cn", env["SIMPLEX_REGION"])
	}

	// Explicit SIMPLEX_REGION overrides cached region.json.
	forced := LocalmodelsEnv(map[string]string{"SIMPLEX_REGION": "global"}, stateDir, now)
	if forced["SIMPLEX_REGION"] != "global" {
		t.Fatalf("expected forced SIMPLEX_REGION=global, got %q", forced["SIMPLEX_REGION"])
	}
}

func TestApplyAgentEnvironmentUsesMeasuredEcosystemWinnersAndHonorsUserOverrides(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	home := t.TempDir()
	regionPath := writeRegionJSON(t, home, Profile{
		Schema:             Schema,
		Region:             "cn",
		ResolvedAt:         now.Add(-15 * time.Minute).Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
		Ecosystems: map[string]EcosystemRecord{
			"pypi": {
				Region:         "cn",
				Name:           "pypi-tsinghua",
				URL:            "https://pypi.tuna.tsinghua.edu.cn/simple/",
				BytesPerSecond: 880_000,
				MeasuredAt:     now.Add(-15 * time.Minute).Format(time.RFC3339),
				Method:         "probe",
			},
			"go": {
				Region:         "cn",
				Name:           "goproxy-io",
				URL:            "https://goproxy.io",
				BytesPerSecond: 1_200_000,
				MeasuredAt:     now.Add(-15 * time.Minute).Format(time.RFC3339),
				Method:         "probe",
			},
			"rust": {
				Region:         "cn",
				Name:           "rust-ustc",
				URL:            "https://mirrors.ustc.edu.cn/rust-static",
				BytesPerSecond: 900_000,
				MeasuredAt:     now.Add(-15 * time.Minute).Format(time.RFC3339),
				Method:         "probe",
			},
			"homebrew": {
				Region:         "cn",
				Name:           "homebrew-ustc",
				URL:            "https://mirrors.ustc.edu.cn/homebrew-bottles/api",
				BytesPerSecond: 950_000,
				MeasuredAt:     now.Add(-15 * time.Minute).Format(time.RFC3339),
				Method:         "probe",
			},
		},
	})

	env := map[string]string{
		"HOME":                home,
		"npm_config_registry": "https://corp-npm.internal",
	}
	applyAgentEnvironmentForOS(env, regionPath, now, "darwin")

	if env["PIP_INDEX_URL"] != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("PIP_INDEX_URL = %q", env["PIP_INDEX_URL"])
	}
	if env["UV_DEFAULT_INDEX"] != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("UV_DEFAULT_INDEX = %q", env["UV_DEFAULT_INDEX"])
	}
	if env["npm_config_registry"] != "https://corp-npm.internal" {
		t.Fatalf("user npm_config_registry was overwritten: %q", env["npm_config_registry"])
	}
	if env["GOPROXY"] != "https://goproxy.io|https://goproxy.cn|direct" {
		t.Fatalf("GOPROXY = %q", env["GOPROXY"])
	}
	if env["RUSTUP_DIST_SERVER"] != "https://mirrors.ustc.edu.cn/rust-static" {
		t.Fatalf("RUSTUP_DIST_SERVER = %q", env["RUSTUP_DIST_SERVER"])
	}
	if env["HF_ENDPOINT"] != defaultChinaHF {
		t.Fatalf("HF_ENDPOINT = %q", env["HF_ENDPOINT"])
	}
	if env["HOMEBREW_BOTTLE_DOMAIN"] != ustcBrewBottles {
		t.Fatalf("HOMEBREW_BOTTLE_DOMAIN = %q", env["HOMEBREW_BOTTLE_DOMAIN"])
	}

	// User pip.conf stops PyPI injection while other ecosystems still accelerate.
	pipDir := filepath.Join(home, ".config", "pip")
	if err := os.MkdirAll(pipDir, 0o700); err != nil {
		t.Fatalf("mkdir pip: %v", err)
	}
	if err := os.WriteFile(filepath.Join(pipDir, "pip.conf"), []byte("[global]\nindex-url = https://pypi.lan/simple\n"), 0o600); err != nil {
		t.Fatalf("write pip.conf: %v", err)
	}
	withPipConf := map[string]string{"HOME": home}
	applyAgentEnvironmentForOS(withPipConf, regionPath, now, "linux")
	if _, set := withPipConf["PIP_INDEX_URL"]; set {
		t.Fatalf("expected user pip.conf to prevent PIP_INDEX_URL injection")
	}
	if _, set := withPipConf["HOMEBREW_API_DOMAIN"]; set {
		t.Fatalf("expected no Homebrew env on linux")
	}

	// Forced SIMPLEX_REGION=global injects nothing.
	forcedGlobal := map[string]string{"HOME": home, "SIMPLEX_REGION": "global"}
	applyAgentEnvironmentForOS(forcedGlobal, regionPath, now, "darwin")
	if len(forcedGlobal) != 2 {
		t.Fatalf("expected no mirror overrides when SIMPLEX_REGION=global, got %v", forcedGlobal)
	}
}

func TestHardeningHostileURLsConfigFilesAndDeterministicFold(t *testing.T) {
	now := time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()

	// 1. Shallow and relative state directories return empty instead of /region.json.
	if got := RegionFileFromStateDir("/tmp/state"); got != "" {
		t.Fatalf("expected empty path for shallow stateDir, got %q", got)
	}
	if got := RegionFileFromStateDir("state"); got != "" {
		t.Fatalf("expected empty path for relative stateDir, got %q", got)
	}

	// 2. Mixed-case proxy keys produce identical fingerprints.
	if NetworkFingerprint(map[string]string{"Http_Proxy": "http://127.0.0.1:7890"}) !=
		NetworkFingerprint(map[string]string{"HTTP_PROXY": "http://127.0.0.1:7890"}) {
		t.Fatalf("expected mixed-case Http_Proxy fingerprint parity")
	}

	// 3. Hostile / malformed URLs in region.json are dropped by ReadProfile.
	hostilePath := writeRegionJSON(t, dir, Profile{
		Schema:             Schema,
		Region:             "cn",
		ResolvedAt:         now.Add(-5 * time.Minute).Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
		Ecosystems: map[string]EcosystemRecord{
			"pypi": {
				Region:     "cn",
				Name:       "evil",
				URL:        "https://evil.attacker.example/simple/",
				MeasuredAt: now.Format(time.RFC3339),
				Method:     "probe",
			},
			"homebrew": {
				Region:     "cn",
				Name:       "spoof",
				URL:        "https://evil.attacker.example/?tsinghua",
				MeasuredAt: now.Format(time.RFC3339),
				Method:     "probe",
			},
		},
	})
	env := map[string]string{"HOME": dir}
	applyAgentEnvironmentForOS(env, hostilePath, now, "darwin")
	if env["PIP_INDEX_URL"] != defaultChinaPyPI {
		t.Fatalf("expected safe default PyPI mirror, got %q", env["PIP_INDEX_URL"])
	}
	if env["HOMEBREW_API_DOMAIN"] != defaultChinaBrewAPI {
		t.Fatalf("expected safe default Homebrew mirror, got %q", env["HOMEBREW_API_DOMAIN"])
	}

	// 4. Duplicate empty lowercase + populated uppercase keys stay deterministic.
	for range 100 {
		dup := map[string]string{
			"HOME":          dir,
			"pip_index_url": "",
			"PIP_INDEX_URL": "https://corp-pypi.internal/simple/",
		}
		applyAgentEnvironmentForOS(dup, hostilePath, now, "linux")
		if dup["PIP_INDEX_URL"] != "https://corp-pypi.internal/simple/" {
			t.Fatalf("user PIP_INDEX_URL overwritten on duplicate empty key: %q", dup["PIP_INDEX_URL"])
		}
	}

	// 5. Workspace .npmrc (with spaces), NPM_CONFIG_USERCONFIG, and uv.toml index=[...] are honored.
	workDir := filepath.Join(dir, "workspace")
	if err := os.MkdirAll(workDir, 0o700); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workDir, ".npmrc"), []byte("registry = https://workspace-npm.internal/\n"), 0o600); err != nil {
		t.Fatalf("write .npmrc: %v", err)
	}
	if err := os.WriteFile(filepath.Join(workDir, "uv.toml"), []byte("index=[{url=\"https://workspace-pypi.internal/\",default=true}]\n"), 0o600); err != nil {
		t.Fatalf("write uv.toml: %v", err)
	}
	wsEnv := map[string]string{"HOME": dir}
	ApplyAgentEnvironmentInDir(wsEnv, hostilePath, workDir, now)
	if _, set := wsEnv["npm_config_registry"]; set {
		t.Fatalf("expected workspace .npmrc to prevent npm_config_registry injection")
	}
	if _, set := wsEnv["UV_DEFAULT_INDEX"]; set {
		t.Fatalf("expected workspace uv.toml to prevent UV_DEFAULT_INDEX injection")
	}
}
