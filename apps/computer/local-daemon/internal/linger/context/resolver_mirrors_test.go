package lingercontext

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/mirrors"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

func TestResolveAppliesCachedLanguageMirrorsFromRegionFile(t *testing.T) {
	root := t.TempDir()
	regionPath := filepath.Join(root, "region.json")
	raw, err := json.Marshal(mirrors.Profile{
		Schema:             mirrors.Schema,
		Region:             "cn",
		ResolvedAt:         time.Now().UTC().Format(time.RFC3339),
		Method:             "probe",
		NetworkFingerprint: "direct",
		Ecosystems: map[string]mirrors.EcosystemRecord{
			"pypi": {
				Region:         "cn",
				Name:           "pypi-tsinghua",
				URL:            "https://pypi.tuna.tsinghua.edu.cn/simple/",
				BytesPerSecond: 880_000,
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal profile: %v", err)
	}
	if err := os.WriteFile(regionPath, raw, 0o600); err != nil {
		t.Fatalf("write region.json: %v", err)
	}

	resolver := ExecutionResolver{
		RegionFile: regionPath,
		Providers: map[string]ProviderInstallation{
			"pi": {
				Type:           "pi",
				ExecutablePath: "/trusted/pi",
				Environment: map[string]string{
					"HOME":    root,
					"GOPROXY": "https://corp-goproxy.internal,direct",
				},
			},
		},
		WorkspaceGrants: map[string]WorkspaceGrant{
			"grant": {GrantID: "grant", TenantID: "tenant", Path: root},
		},
		Registrations: map[string]RegistrationBinding{
			"reg": {
				RegistrationID: "reg",
				TenantID:       "tenant",
				OwnerActorID:   "owner",
				ProviderType:   "pi",
				Status:         registration.StatusOnline,
			},
		},
		Views: testContextViews{root: root},
	}

	cmd := protocol.Command{
		RegistrationID:      "reg",
		AssignmentRevision:  1,
		TenantID:            "tenant",
		RuntimeType:         "pi",
		WorkspaceGrantID:    "grant",
		ExecutionContextKey: "ctx",
		ContextViewRef:      json.RawMessage(`{"view_digest":"abc"}`),
	}
	payload := json.RawMessage(`{"kind":"run.start","runtime":{"type":"pi","model":"demo"},"input":{"text":"hi"}}`)
	spec, err := resolver.Resolve(context.Background(), cmd, payload)
	if err != nil {
		t.Fatalf("Resolve failed: %v", err)
	}
	if spec.Environment["PIP_INDEX_URL"] != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("PIP_INDEX_URL = %q, want Tsinghua mirror", spec.Environment["PIP_INDEX_URL"])
	}
	if spec.Environment["UV_DEFAULT_INDEX"] != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("UV_DEFAULT_INDEX = %q, want Tsinghua mirror", spec.Environment["UV_DEFAULT_INDEX"])
	}
	if spec.Environment["npm_config_registry"] != "https://registry.npmmirror.com" {
		t.Fatalf("npm_config_registry = %q, want npmmirror", spec.Environment["npm_config_registry"])
	}
	if spec.Environment["HF_ENDPOINT"] != "https://hf-mirror.com" {
		t.Fatalf("HF_ENDPOINT = %q, want hf-mirror", spec.Environment["HF_ENDPOINT"])
	}
	// User/provider GOPROXY is never overwritten.
	if spec.Environment["GOPROXY"] != "https://corp-goproxy.internal,direct" {
		t.Fatalf("GOPROXY was overwritten: %q", spec.Environment["GOPROXY"])
	}
}

func TestResolveKeepsCachedMirrorsPastSixHoursUntilProxyChanges(t *testing.T) {
	root := t.TempDir()
	regionPath := filepath.Join(root, "region.json")
	staleTime := time.Now().UTC().Add(-24 * time.Hour).Format(time.RFC3339)
	raw, err := json.Marshal(mirrors.Profile{
		Schema:             mirrors.Schema,
		Region:             "cn",
		ResolvedAt:         staleTime,
		Method:             "probe",
		NetworkFingerprint: "direct",
		Ecosystems: map[string]mirrors.EcosystemRecord{
			"pypi": {
				Region:         "cn",
				Name:           "pypi-tsinghua",
				URL:            "https://pypi.tuna.tsinghua.edu.cn/simple/",
				BytesPerSecond: 880_000,
				MeasuredAt:     staleTime,
				Method:         "probe",
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal profile: %v", err)
	}
	if err := os.WriteFile(regionPath, raw, 0o600); err != nil {
		t.Fatalf("write region.json: %v", err)
	}

	makeResolver := func(env map[string]string) ExecutionResolver {
		return ExecutionResolver{
			RegionFile: regionPath,
			Providers: map[string]ProviderInstallation{
				"pi": {
					Type:           "pi",
					ExecutablePath: "/trusted/pi",
					Environment:    env,
				},
			},
			WorkspaceGrants: map[string]WorkspaceGrant{
				"grant": {GrantID: "grant", TenantID: "tenant", Path: root},
			},
			Registrations: map[string]RegistrationBinding{
				"reg": {
					RegistrationID: "reg",
					TenantID:       "tenant",
					OwnerActorID:   "owner",
					ProviderType:   "pi",
					Status:         registration.StatusOnline,
				},
			},
			Views: testContextViews{root: root},
		}
	}

	cmd := protocol.Command{
		RegistrationID:      "reg",
		AssignmentRevision:  1,
		TenantID:            "tenant",
		RuntimeType:         "pi",
		WorkspaceGrantID:    "grant",
		ExecutionContextKey: "ctx",
		ContextViewRef:      json.RawMessage(`{"view_digest":"abc"}`),
	}
	payload := json.RawMessage(`{"kind":"run.start","runtime":{"type":"pi","model":"demo"},"input":{"text":"hi"}}`)

	// Same proxy state (direct): stale profile still accelerates Agent Runs.
	spec, err := makeResolver(map[string]string{"HOME": root}).Resolve(context.Background(), cmd, payload)
	if err != nil {
		t.Fatalf("Resolve with stale profile failed: %v", err)
	}
	if spec.Environment["PIP_INDEX_URL"] != "https://pypi.tuna.tsinghua.edu.cn/simple/" {
		t.Fatalf("PIP_INDEX_URL = %q, want Tsinghua mirror from stale profile", spec.Environment["PIP_INDEX_URL"])
	}

	// Changed proxy state: stale profile is ignored.
	proxied, err := makeResolver(map[string]string{"HOME": root, "HTTPS_PROXY": "http://127.0.0.1:7890"}).Resolve(context.Background(), cmd, payload)
	if err != nil {
		t.Fatalf("Resolve with proxy failed: %v", err)
	}
	if _, set := proxied.Environment["PIP_INDEX_URL"]; set {
		t.Fatalf("expected proxy change to drop stale mirror injection, got %q", proxied.Environment["PIP_INDEX_URL"])
	}
}
