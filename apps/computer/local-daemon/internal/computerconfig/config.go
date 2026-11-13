// Package computerconfig reads the Local Computer config file and the process
// environment shared by the Daemon and the linger-computer CLI.
package computerconfig

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

// Config is a validated Local Computer config with its Gateway credential.
type Config struct {
	ComputerID              string
	DisplayName             string
	GatewayURL              string
	GatewayToken            string
	CodexAuthFile           string
	StateDirectory          string
	MaxConcurrentOperations *int
	RuntimePaths            map[string]string
	EnabledRuntimes         []string
	// PreferredRuntime is the Runtime the person chose at installation, or
	// empty when the installer chose none.
	PreferredRuntime string
	WorkspaceGrants  []WorkspaceGrant
	Owners           []Owner
	// Desktop is set when the Linger Desktop app runs this Daemon as its child.
	Desktop *Desktop
	// LocalModels locates the localmodels tool the installer prepared; nil
	// when this Computer has none.
	LocalModels *LocalModels
}

// LocalModels is where the installer put the localmodels tool and its state.
// The Daemon runs `python -P -s -m localmodels library ...` with PYTHONPATH
// and the working directory set to ModuleDirectory, LOCALMODELS_STATE set to
// StateDirectory and --base-dir set to BaseDirectory.
type LocalModels struct {
	Python          string
	ModuleDirectory string
	StateDirectory  string
	BaseDirectory   string
}

// Desktop configures a Daemon owned by the Linger Desktop app. The app ships
// and updates the Daemon, so it does not update itself; it exits when the app
// closes its stdin and reports its state as JSON lines on stdout.
type Desktop struct {
	TeamHubCLIDirectory string
}

// Owner is one tenant owner scope named by the Gateway credential.
type Owner struct {
	TenantID     string `json:"tenant_id"`
	OwnerActorID string `json:"owner_actor_id"`
}

// WorkspaceGrant is one local directory the Computer may expose to a tenant.
type WorkspaceGrant struct {
	GrantID  string          `json:"grant_id"`
	Label    string          `json:"label,omitempty"`
	TenantID string          `json:"tenant_id"`
	RootPath string          `json:"root_path"`
	Mode     string          `json:"mode"`
	Scope    string          `json:"scope,omitempty"`
	Bindings json.RawMessage `json:"bindings,omitempty"`
}

type encodedConfig struct {
	RunnerID                string              `json:"runner_id"`
	DisplayName             string              `json:"display_name"`
	Gateway                 encodedGateway      `json:"gateway"`
	StateDirectory          string              `json:"state_directory"`
	MaxConcurrentOperations *int                `json:"max_concurrent_operations,omitempty"`
	RuntimePaths            map[string]string   `json:"runtime_paths,omitempty"`
	EnabledRuntimes         json.RawMessage     `json:"enabled_runtimes,omitempty"`
	PreferredRuntime        string              `json:"preferred_runtime,omitempty"`
	WorkspaceGrants         []WorkspaceGrant    `json:"workspace_grants"`
	CredentialExpiresAt     string              `json:"credential_expires_at,omitempty"`
	Codex                   *encodedCodex       `json:"codex,omitempty"`
	Desktop                 *encodedDesktop     `json:"desktop,omitempty"`
	LocalModels             *encodedLocalModels `json:"local_models,omitempty"`
}

type encodedLocalModels struct {
	Python          string `json:"python"`
	ModuleDirectory string `json:"module_directory"`
	StateDirectory  string `json:"state_directory"`
	BaseDirectory   string `json:"base_directory"`
}

type encodedDesktop struct {
	TeamHubCLIDirectory string `json:"teamhub_cli_directory,omitempty"`
}

type encodedCodex struct {
	AuthFile string `json:"auth_file"`
}

type encodedGateway struct {
	URL       string `json:"url"`
	TokenFile string `json:"token_file,omitempty"`
	TokenEnv  string `json:"token_env,omitempty"`
}

// Load reads and validates the owner-only config at path and its credential.
func Load(path string, environment map[string]string) (Config, error) {
	encoded, err := readOwnerFile(path, 1024*1024)
	if err != nil {
		return Config{}, fmt.Errorf("read Computer config: %w", err)
	}
	var value encodedConfig
	decoder := json.NewDecoder(strings.NewReader(string(encoded)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return Config{}, fmt.Errorf("decode Computer config: %w", err)
	}
	if value.RunnerID == "" || value.DisplayName == "" || !filepath.IsAbs(value.StateDirectory) {
		return Config{}, errors.New("Computer config identity or state directory is invalid")
	}
	parsedURL, err := url.Parse(value.Gateway.URL)
	if err != nil || (parsedURL.Scheme != "wss" && parsedURL.Scheme != "ws") || parsedURL.Host == "" {
		return Config{}, errors.New("Computer Gateway URL is invalid")
	}
	if (value.Gateway.TokenFile == "") == (value.Gateway.TokenEnv == "") {
		return Config{}, errors.New("Computer Gateway credential source is invalid")
	}
	if value.Codex != nil && !filepath.IsAbs(value.Codex.AuthFile) {
		return Config{}, errors.New("Computer Codex auth path is invalid")
	}
	var desktop *Desktop
	if value.Desktop != nil {
		if value.Desktop.TeamHubCLIDirectory != "" && !filepath.IsAbs(value.Desktop.TeamHubCLIDirectory) {
			return Config{}, errors.New("Computer Desktop TeamHub CLI path is invalid")
		}
		desktop = &Desktop{TeamHubCLIDirectory: value.Desktop.TeamHubCLIDirectory}
	}
	var localModels *LocalModels
	if value.LocalModels != nil {
		encoded := value.LocalModels
		for _, path := range []string{encoded.Python, encoded.ModuleDirectory, encoded.StateDirectory, encoded.BaseDirectory} {
			if !filepath.IsAbs(path) {
				return Config{}, errors.New("local_models paths must be absolute")
			}
		}
		localModels = &LocalModels{
			Python: encoded.Python, ModuleDirectory: encoded.ModuleDirectory,
			StateDirectory: encoded.StateDirectory, BaseDirectory: encoded.BaseDirectory,
		}
	}
	var token string
	if value.Gateway.TokenFile != "" {
		if !filepath.IsAbs(value.Gateway.TokenFile) {
			return Config{}, errors.New("Computer Gateway credential path is invalid")
		}
		credential, err := readOwnerFile(value.Gateway.TokenFile, 4096)
		if err != nil {
			return Config{}, fmt.Errorf("read Computer Gateway credential: %w", err)
		}
		token = strings.TrimSpace(string(credential))
	} else {
		token = environment[value.Gateway.TokenEnv]
	}
	if token == "" || strings.ContainsAny(token, " \t\r\n") {
		return Config{}, errors.New("Computer Gateway credential is invalid")
	}
	owners, err := tokenOwners(token, value.RunnerID)
	if err != nil {
		return Config{}, err
	}
	if value.MaxConcurrentOperations != nil && (*value.MaxConcurrentOperations < 1 || *value.MaxConcurrentOperations > 100) {
		return Config{}, errors.New("max_concurrent_operations is invalid")
	}
	for runtimeType, runtimePath := range value.RuntimePaths {
		if (runtimeType != "codex" && runtimeType != "claude" && runtimeType != "pi") || !filepath.IsAbs(runtimePath) {
			return Config{}, errors.New("runtime_paths is invalid")
		}
	}
	var enabledRuntimes []string
	if value.EnabledRuntimes != nil {
		if err := json.Unmarshal(value.EnabledRuntimes, &enabledRuntimes); err != nil || len(enabledRuntimes) == 0 {
			return Config{}, errors.New("enabled_runtimes must be a nonempty supported Runtime subset")
		}
	}
	if err := provider.ValidateRuntimeSelection(enabledRuntimes); err != nil {
		return Config{}, fmt.Errorf("enabled_runtimes: %w", err)
	}
	if value.PreferredRuntime != "" {
		if provider.ValidateRuntimeSelection([]string{value.PreferredRuntime}) != nil ||
			(enabledRuntimes != nil && !slices.Contains(enabledRuntimes, value.PreferredRuntime)) {
			return Config{}, errors.New("preferred_runtime must be an enabled supported Runtime")
		}
	}
	seenGrants := make(map[string]struct{})
	for index := range value.WorkspaceGrants {
		grant := &value.WorkspaceGrants[index]
		if grant.GrantID == "" || grant.TenantID == "" || !filepath.IsAbs(grant.RootPath) ||
			(grant.Mode != "read-only" && grant.Mode != "workspace-write") ||
			(grant.Scope != "" && grant.Scope != "owner" && grant.Scope != "bindings") {
			return Config{}, errors.New("workspace_grants is invalid")
		}
		if _, duplicate := seenGrants[grant.GrantID]; duplicate {
			return Config{}, errors.New("workspace_grants contains duplicate identity")
		}
		seenGrants[grant.GrantID] = struct{}{}
		if grant.Scope == "" {
			grant.Scope = "bindings"
		}
	}
	return Config{
		ComputerID: value.RunnerID, DisplayName: value.DisplayName,
		GatewayURL: value.Gateway.URL, GatewayToken: token, CodexAuthFile: codexAuthFile(value.Codex), StateDirectory: value.StateDirectory,
		MaxConcurrentOperations: value.MaxConcurrentOperations, RuntimePaths: value.RuntimePaths,
		EnabledRuntimes: enabledRuntimes, PreferredRuntime: value.PreferredRuntime,
		WorkspaceGrants: value.WorkspaceGrants, Owners: owners, Desktop: desktop, LocalModels: localModels,
	}, nil
}

func codexAuthFile(value *encodedCodex) string {
	if value == nil {
		return ""
	}
	return value.AuthFile
}

func readOwnerFile(path string, maximum int64) ([]byte, error) {
	data, err := privatefs.ReadFile(path, maximum)
	if err == nil && len(data) == 0 {
		return nil, errors.New("owner file is empty")
	}
	return data, err
}

func tokenOwners(token, expectedComputerID string) ([]Owner, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] != "sr1" {
		return nil, errors.New("Computer Gateway credential format is invalid")
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, errors.New("Computer Gateway credential payload is invalid")
	}
	var claims struct {
		RunnerID     string `json:"runner_id"`
		TenantOwners []struct {
			TenantID     string `json:"tenant_id"`
			OwnerActorID string `json:"owner_actor_id"`
		} `json:"tenant_owners"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.RunnerID != expectedComputerID || len(claims.TenantOwners) == 0 {
		return nil, errors.New("Computer Gateway credential identity is invalid")
	}
	owners := make([]Owner, 0, len(claims.TenantOwners))
	seen := make(map[string]struct{})
	for _, owner := range claims.TenantOwners {
		key := owner.TenantID + "\x00" + owner.OwnerActorID
		if owner.TenantID == "" || owner.OwnerActorID == "" {
			return nil, errors.New("Computer Gateway credential owner scope is invalid")
		}
		if _, duplicate := seen[key]; duplicate {
			return nil, errors.New("Computer Gateway credential owner scope is duplicated")
		}
		seen[key] = struct{}{}
		owners = append(owners, Owner{TenantID: owner.TenantID, OwnerActorID: owner.OwnerActorID})
	}
	return owners, nil
}
