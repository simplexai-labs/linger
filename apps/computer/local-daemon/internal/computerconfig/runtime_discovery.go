package computerconfig

import (
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider"
)

var allRuntimeTypes = []string{"codex", "claude", "pi", "antigravity"}

// SelectedRuntimePath returns the executable path selected by LINGER_<TYPE>_PATH
// in the source environment.
func SelectedRuntimePath(environment map[string]string, runtimeType string) string {
	switch runtimeType {
	case "codex":
		return environment["LINGER_CODEX_PATH"]
	case "claude":
		return environment["LINGER_CLAUDE_PATH"]
	case "pi":
		return environment["LINGER_PI_PATH"]
	default:
		return ""
	}
}

// RuntimeDiscoveryRequest configures a single-shot Runtime discovery call
// shared between the local control CLI (`linger-computer`) and the daemon's
// stateless `probe-runtimes` command.
type RuntimeDiscoveryRequest struct {
	ConfiguredPaths  map[string]string
	Environment      map[string]string
	Runtimes         []string
	SkipModelCatalog bool
	Timeout          time.Duration
	// RequireAbsolutePaths rejects relative paths in ConfiguredPaths and ignores
	// relative LINGER_<TYPE>_PATH values.
	RequireAbsolutePaths bool
}

// RuntimeDiscoveryOptions resolves explicit and LINGER_<TYPE>_PATH overrides,
// validates any Runtime selection, and scrubs internal/sensitive variables via
// RuntimeEnvironment before constructing provider.DiscoveryOptions.
func RuntimeDiscoveryOptions(request RuntimeDiscoveryRequest) (provider.DiscoveryOptions, error) {
	if len(request.Runtimes) > 0 {
		if err := provider.ValidateRuntimeSelection(request.Runtimes); err != nil {
			return provider.DiscoveryOptions{}, err
		}
	}
	selected := map[string]string{}
	for _, runtimeType := range allRuntimeTypes {
		explicit := strings.TrimSpace(request.ConfiguredPaths[runtimeType])
		if explicit != "" {
			if request.RequireAbsolutePaths && !filepath.IsAbs(explicit) {
				return provider.DiscoveryOptions{}, fmt.Errorf("--%s-path must be absolute", runtimeType)
			}
			selected[runtimeType] = explicit
			continue
		}
		if fromEnv := strings.TrimSpace(SelectedRuntimePath(request.Environment, runtimeType)); fromEnv != "" {
			if !request.RequireAbsolutePaths || filepath.IsAbs(fromEnv) {
				selected[runtimeType] = fromEnv
			}
		}
	}
	return provider.DiscoveryOptions{
		ConfiguredPaths:  selected,
		Environment:      RuntimeEnvironment(request.Environment, ""),
		Runtimes:         request.Runtimes,
		SkipModelCatalog: request.SkipModelCatalog,
		Timeout:          request.Timeout,
	}, nil
}
