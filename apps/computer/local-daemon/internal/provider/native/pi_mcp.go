package native

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	piMCPConfigEnvKey     = "LINGER_PI_MANAGED_MCP_CONFIG"
	piContextWindowEnvKey = "LINGER_PI_CONTEXT_WINDOW"
	piNodePathKey         = "NODE_PATH"
	// The NODE_PATH Pi would have had without the Computer tools.
	piInheritedNodePathKey = "LINGER_PI_INHERITED_NODE_PATH"
)

// piManagedExtensionPath returns extension when it names an installed regular
// file so managed Pi prompt hygiene and compaction bounds load even without
// MCP servers.
func piManagedExtensionPath(extension string) string {
	if extension == "" || !filepath.IsAbs(extension) {
		return ""
	}
	info, err := os.Stat(extension)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return extension
}

// piMCPWiring is the managed MCP set prepared for one Pi process. A zero
// value wires nothing.
type piMCPWiring struct {
	extension  string
	configPath string
}

func (w piMCPWiring) wired() bool { return w.configPath != "" }

// piPrepareMCP writes the caller's MCP bytes unchanged next to the session
// and names the managed extension that loads them. Pi never falls back to
// an ambient MCP configuration.
func piPrepareMCP(raw json.RawMessage, extension, sessionDir string) (piMCPWiring, error) {
	raw = mcpNamespace(raw)
	var config struct {
		MCPServers *map[string]json.RawMessage `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &config); err != nil {
		return piMCPWiring{}, fmt.Errorf("invalid managed Pi MCP configuration: %w", err)
	}
	if config.MCPServers == nil || len(*config.MCPServers) == 0 {
		return piMCPWiring{}, nil
	}
	if extension == "" || !filepath.IsAbs(extension) {
		return piMCPWiring{}, errors.New("the managed Pi MCP extension is not installed; repair the Computer installation")
	}
	info, err := os.Stat(extension)
	if err != nil || !info.Mode().IsRegular() {
		return piMCPWiring{}, errors.New("the managed Pi MCP extension is unavailable; repair the Computer installation")
	}
	path := filepath.Join(sessionDir, piMCPConfigName)
	if err := piWritePrivate(path, raw); err != nil {
		return piMCPWiring{}, fmt.Errorf("managed Pi MCP configuration could not be written: %w", err)
	}
	return piMCPWiring{extension: extension, configPath: path}, nil
}

// piExtensionNodePath puts the Computer tools' node_modules on Pi's module
// search path. Pi loads every extension through jiti, which its bare npm
// bundle does not carry: a Pi unpacked without its dependencies, as the
// managed runtime harness installs it, cannot load the extension otherwise.
// The tools ship jiti beside the extension. CommonJS reads NODE_PATH only
// after a package's own node_modules, so a Pi with its own jiti keeps it.
// Node reads NODE_PATH once, at startup, so the extension puts back the
// inherited value for the commands Pi starts (piInheritedNodePathKey).
func piExtensionNodePath(env map[string]string, extension string) {
	modules := filepath.Join(filepath.Dir(filepath.Dir(extension)), "node_modules")
	key := piNodePathKey
	if _, ok := env[key]; !ok {
		for existing := range env {
			if strings.EqualFold(existing, piNodePathKey) {
				key = existing
			}
		}
	}
	current := env[key]
	if current != "" {
		modules += string(filepath.ListSeparator) + current
	}
	env[key] = modules
	env[piInheritedNodePathKey] = current
}

func (w piMCPWiring) remove() {
	if w.configPath != "" {
		_ = os.Remove(w.configPath)
	}
}
