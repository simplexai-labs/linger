package lingercontext

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/registration"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/protocol"
)

// cliTestResolver binds the trusted CLI path and a Registration for tenant/agent.
// The credential lookup is set only when the test supplies a store, so a nil
// store never reaches the resolver as a non-nil interface.
func cliTestResolver(root string, store *clicredential.Store) ExecutionResolver {
	resolver := ExecutionResolver{TeamHubCLIBin: "/trusted/release/cli", Providers: map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/trusted/codex", Environment: map[string]string{"PATH": "/bin"}}}, WorkspaceGrants: map[string]WorkspaceGrant{"grant": {GrantID: "grant", TenantID: "tenant", Path: root}}, Registrations: map[string]RegistrationBinding{"registration": {RegistrationID: "registration", TenantID: "tenant", ProviderType: "codex", Status: registration.StatusOnline}}, Views: testContextViews{root: root}}
	if store != nil {
		resolver.CLICredentials = store
	}
	return resolver
}

func cliTestCommand(contextKey string) protocol.Command {
	return protocol.Command{TenantID: "tenant", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1, WorkspaceGrantID: "grant", ExecutionContextKey: contextKey, RuntimeType: "codex",
		ContextViewRef: json.RawMessage(`{"receipt_ref":"receipt-1"}`)}
}

func cliTestCredentialStore(t *testing.T, install bool) *clicredential.Store {
	t.Helper()
	store, err := clicredential.Open(filepath.Join(t.TempDir(), "agent-cli-credentials"))
	if err != nil {
		t.Fatal(err)
	}
	if install {
		profile := clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant", AgentID: "agent"}
		if _, err := store.Put("tenant", "agent", profile, "th_agent_"+strings.Repeat("a", 43), 1); err != nil {
			t.Fatal(err)
		}
	}
	return store
}

func TestResolverExposesInstalledCLIProfileWithoutWireEnvironment(t *testing.T) {
	root := t.TempDir()
	store := cliTestCredentialStore(t, true)
	resolver := cliTestResolver(root, store)
	// The first run has no config.json yet; the profile comes from the credential.
	spec, err := resolver.Resolve(context.Background(), cliTestCommand(""), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"environment":{"TEAMHUB_CONFIG":"/evil/config","TEAMHUB_TOKEN":"secret"}}`))
	if err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(root, ".teamhub", "cli", "config.json")
	if _, err := os.Stat(config); !os.IsNotExist(err) {
		t.Fatalf("resolver must not create config.json: %v", err)
	}
	if spec.Environment["TEAMHUB_CONFIG"] != config || spec.Environment["TEAMHUB_PROFILE"] != "runtime" || spec.Environment["TEAMHUB_TOKEN"] != "" || spec.Environment["PATH"] != "/trusted/release/cli"+string(os.PathListSeparator)+"/bin" {
		t.Fatalf("CLI configuration or installed path was not derived locally: %+v", spec.Environment)
	}
}

func TestResolverSetsNoCLIEnvironmentWithoutCredential(t *testing.T) {
	root := t.TempDir()
	for name, store := range map[string]*clicredential.Store{
		"no store":    nil,
		"empty store": cliTestCredentialStore(t, false),
	} {
		t.Run(name, func(t *testing.T) {
			spec, err := cliTestResolver(root, store).Resolve(context.Background(), cliTestCommand(""), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
			if err != nil {
				t.Fatal(err)
			}
			if _, ok := spec.Environment["TEAMHUB_CONFIG"]; ok {
				t.Fatalf("CLI environment set without a business credential: %+v", spec.Environment)
			}
		})
	}
}

func TestResolverPrepareAndStartShareCLIEnvironment(t *testing.T) {
	root := t.TempDir()
	store := cliTestCredentialStore(t, true)
	resolver := cliTestResolver(root, store)
	prepare, err := resolver.Resolve(context.Background(), cliTestCommand("context-one"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
	if err != nil {
		t.Fatal(err)
	}
	start, err := resolver.Resolve(context.Background(), cliTestCommand("context-one"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"TEAMHUB_CONFIG", "TEAMHUB_PROFILE", "PATH"} {
		if prepare.Environment[name] == "" || prepare.Environment[name] != start.Environment[name] {
			t.Fatalf("%s differs between prepare and start: %q vs %q", name, prepare.Environment[name], start.Environment[name])
		}
	}
}

func TestResolverRejectsCLIConfigurationThroughSymbolicParent(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.MkdirAll(filepath.Join(outside, "cli"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "cli", "config.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := createTestDirectoryLink(outside, filepath.Join(root, ".teamhub")); err != nil {
		t.Fatal(err)
	}
	resolver := ExecutionResolver{TeamHubCLIBin: "/trusted/cli", Providers: map[string]ProviderInstallation{"codex": {Type: "codex", ExecutablePath: "/trusted/codex"}}, WorkspaceGrants: map[string]WorkspaceGrant{"grant": {GrantID: "grant", TenantID: "tenant", Path: root}}, Registrations: map[string]RegistrationBinding{"registration": {RegistrationID: "registration", TenantID: "tenant", ProviderType: "codex", Status: registration.StatusOnline}}}
	_, err := resolver.Resolve(context.Background(), protocol.Command{TenantID: "tenant", AgentID: "agent", RegistrationID: "registration", AssignmentRevision: 1, WorkspaceGrantID: "grant", RuntimeType: "codex"}, json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
	if err == nil {
		t.Fatal("symbolic parent configuration must not be passed to the Runtime")
	}
}

func TestResolverForwardsTrustedTeamHubCLINodePath(t *testing.T) {
	root := t.TempDir()
	trustedNode := filepath.Join(t.TempDir(), "Linger")
	store := cliTestCredentialStore(t, true)
	resolver := cliTestResolver(root, store)
	resolver.TeamHubCLINodePath = "  " + trustedNode + "  "
	resolver.Providers["codex"] = ProviderInstallation{
		Type:           "codex",
		ExecutablePath: "/trusted/codex",
		Environment: map[string]string{
			"PATH":                 "/bin",
			"LINGER_CLI_NODE_PATH": "/untrusted/installation/node",
			"linger_cli_node_path": "/untrusted/lowercase/node",
		},
	}

	prepare, err := resolver.Resolve(context.Background(), cliTestCommand("context-node"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"environment":{"LINGER_CLI_NODE_PATH":"/evil/wire/node"}}`))
	if err != nil {
		t.Fatal(err)
	}
	start, err := resolver.Resolve(context.Background(), cliTestCommand("context-node"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"cli_run_context":{"scope":{"kind":"room","id":"room-1"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if prepare.Environment["LINGER_CLI_NODE_PATH"] != trustedNode {
		t.Fatalf("LINGER_CLI_NODE_PATH = %q, want %q", prepare.Environment["LINGER_CLI_NODE_PATH"], trustedNode)
	}
	if _, leakedLower := prepare.Environment["linger_cli_node_path"]; leakedLower {
		t.Fatalf("untrusted lowercase linger_cli_node_path leaked: %+v", prepare.Environment)
	}
	if prepare.Environment["LINGER_CLI_NODE_PATH"] != start.Environment["LINGER_CLI_NODE_PATH"] {
		t.Fatalf("LINGER_CLI_NODE_PATH differs between prepare and start: %q vs %q", prepare.Environment["LINGER_CLI_NODE_PATH"], start.Environment["LINGER_CLI_NODE_PATH"])
	}
}

func TestResolverRejectsUntrustedOrMissingTeamHubCLINodePath(t *testing.T) {
	cases := []struct {
		name        string
		cliNodePath string
		withCreds   bool
	}{
		{name: "empty node path", cliNodePath: "", withCreds: true},
		{name: "relative node path", cliNodePath: "relative/bin/Linger", withCreds: true},
		{name: "no cli credential", cliNodePath: filepath.Join(t.TempDir(), "Linger"), withCreds: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			store := cliTestCredentialStore(t, tc.withCreds)
			resolver := cliTestResolver(root, store)
			resolver.TeamHubCLINodePath = tc.cliNodePath
			resolver.Providers["codex"] = ProviderInstallation{
				Type:           "codex",
				ExecutablePath: "/trusted/codex",
				Environment: map[string]string{
					"PATH":                 "/bin",
					"LINGER_CLI_NODE_PATH": "/untrusted/installation/node",
				},
			}
			spec, err := resolver.Resolve(context.Background(), cliTestCommand(""), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"},"environment":{"LINGER_CLI_NODE_PATH":"/evil/wire/node"}}`))
			if err != nil {
				t.Fatal(err)
			}
			for k, v := range spec.Environment {
				if strings.EqualFold(k, "LINGER_CLI_NODE_PATH") {
					t.Fatalf("unexpected %s=%q in resolved environment: %+v", k, v, spec.Environment)
				}
			}
		})
	}
}

func TestResolverExternalizedTeamHubCLIRunsViaCLINodePath(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("teamhub.sh is a POSIX wrapper")
	}
	scriptSource := filepath.Join("..", "..", "..", "..", "..", "desktop", "scripts", "teamhub.sh")
	wrapperBytes, err := os.ReadFile(scriptSource)
	if err != nil {
		t.Fatalf("read teamhub.sh: %v", err)
	}

	tmp := t.TempDir()
	storeCLIDir := filepath.Join(tmp, "store", "backend", "backend-abc123", "computer-daemon", "teamhub-cli")
	if err := os.MkdirAll(storeCLIDir, 0o755); err != nil {
		t.Fatal(err)
	}
	wrapperPath := filepath.Join(storeCLIDir, "teamhub")
	if err := os.WriteFile(wrapperPath, wrapperBytes, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storeCLIDir, "teamhub.js"), []byte("// stub\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	appDir := filepath.Join(tmp, "app")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatal(err)
	}
	fakeElectron := filepath.Join(appDir, "Linger")
	fakeElectronScript := "#!/bin/sh\n" +
		"if [ \"${ELECTRON_RUN_AS_NODE:-}\" != \"1\" ]; then echo 'missing ELECTRON_RUN_AS_NODE=1' >&2; exit 11; fi\n" +
		"if [ \"${1:-}\" != \"--use-env-proxy\" ]; then echo \"missing --use-env-proxy: $1\" >&2; exit 12; fi\n" +
		"shift\n" +
		"printf 'fake-electron-ok:%s' \"$*\"\n"
	if err := os.WriteFile(fakeElectron, []byte(fakeElectronScript), 0o755); err != nil {
		t.Fatal(err)
	}

	minimalBinDir := filepath.Join(tmp, "no-node-bin")
	if err := os.MkdirAll(minimalBinDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dirnameBin, err := exec.LookPath("dirname")
	if err != nil {
		t.Fatalf("locate dirname: %v", err)
	}
	if err := os.Symlink(dirnameBin, filepath.Join(minimalBinDir, "dirname")); err != nil {
		t.Fatal(err)
	}

	root := t.TempDir()
	store := cliTestCredentialStore(t, true)
	resolver := cliTestResolver(root, store)
	resolver.TeamHubCLIBin = storeCLIDir
	resolver.TeamHubCLINodePath = fakeElectron
	resolver.Providers["codex"] = ProviderInstallation{
		Type:           "codex",
		ExecutablePath: "/trusted/codex",
		Environment:    map[string]string{"PATH": minimalBinDir},
	}

	spec, err := resolver.Resolve(context.Background(), cliTestCommand("context-exec"), json.RawMessage(`{"kind":"run.start","runtime":{"type":"codex"},"session":{"threadId":""},"input":{"type":"text","text":"hi"}}`))
	if err != nil {
		t.Fatal(err)
	}

	cmd := exec.Command("/bin/sh", "-c", "teamhub --version")
	cmd.Env = make([]string, 0, len(spec.Environment))
	for k, v := range spec.Environment {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("externalized teamhub failed without global node: %v\noutput: %s", err, string(out))
	}
	resolvedCLIDir, err := filepath.EvalSymlinks(storeCLIDir)
	if err != nil {
		resolvedCLIDir = storeCLIDir
	}
	expectedScript := filepath.Join(resolvedCLIDir, "teamhub.js")
	if got := string(out); got != "fake-electron-ok:"+expectedScript+" --version" {
		t.Fatalf("unexpected teamhub output: %q, want %q", got, "fake-electron-ok:"+expectedScript+" --version")
	}
}
