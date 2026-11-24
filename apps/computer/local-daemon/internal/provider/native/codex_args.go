package native

import (
	"fmt"
	"log/slog"
	"strings"

	"github.com/pelletier/go-toml/v2"
)

// codexUnmanagedFeatures are the feature names the adapter always keeps
// disabled; user overrides of them are dropped.
var codexUnmanagedFeatures = map[string]bool{
	"goals": true, "memories": true, "memory_tool": true, "apps": true, "image_generation": true,
	"multi_agent": true, "multi_agent_v2": true,
}

// CodexSubAgentConfig turns Codex sub-agents off. Their model requests run
// beside the Run's own, outside the model queue that admits the Run.
// features.multi_agent removes the V1 tools a model without a catalog entry
// gets. A catalog entry can select a sub-agent version itself, and only
// agents.enabled=false removes those tools, unless multi_agent_v2 is on.
func CodexSubAgentConfig() []string {
	return []string{"--config", "features.multi_agent=false", "--config", "features.multi_agent_v2=false", "--config", "agents.enabled=false"}
}

// CodexAppServerArgs is the app-server argv shared by execution, the
// protocol probe and model catalog. The trailing feature overrides
// come after launchArgs so no caller can re-enable them.
func CodexAppServerArgs(launchArgs ...string) []string {
	args := []string{
		"app-server", "--disable", "plugins", "--disable", "goals", "--listen", "stdio://",
		"--config", fmt.Sprintf("tool_output_token_limit=%d", toolOutputTokens),
	}
	args = append(args, launchArgs...)
	// Bundled Skills describe Codex itself (image generation, OpenAI docs,
	// Codex Skill authoring and installation), not the Agent, and their
	// skill-installer shadows the TeamHub Skill of the same name. Codex
	// before 0.114 ignores the unknown key. Images are generated through the
	// user's connected account with teamhub image-gen, so Codex's own image
	// tool stays off.
	args = append(args,
		"--config", "features.memories=false",
		"--config", "features.memory_tool=false",
		"--config", "features.apps=false",
		"--config", "features.image_generation=false",
		"--config", "project_root_markers=[]",
		"--config", "skills.bundled.enabled=false",
	)
	return append(args, CodexSubAgentConfig()...)
}

// NormalizeCodexLaunchArgs filters Computer args (extra) and Agent args
// (custom) separately: --listen is adapter-owned, and the Daemon's MCP set
// owns every mcp_servers override and the MCP OAuth credential store.
func NormalizeCodexLaunchArgs(extra, custom []string, logger *slog.Logger) []string {
	if logger == nil {
		logger = slog.Default()
	}
	reserved := map[string]flagArity{"--listen": flagTakesValue}
	var out []string
	for _, list := range [][]string{extra, custom} {
		filtered := filterAdapterArgs(logger, reserved, list)
		filtered = codexDropOverrides(logger, filtered, func(path []string) bool {
			return len(path) > 0 && (path[0] == "mcp_servers" || path[0] == codexOAuthStoreKey)
		})
		out = append(out, filtered...)
	}
	return out
}

// codexUnloadsImmediately gates thread_unload_delay_secs=0 and the
// loaded-thread confirmation loop on a Daemon-owned Codex home.
func codexUnloadsImmediately(home string) bool {
	return strings.TrimSpace(home) != ""
}

// codexExecutionArgs builds the full argv of an execution launch.
func codexExecutionArgs(profile Profile, spec RunSpec, home string, logger *slog.Logger) []string {
	lists := [][]string{spec.ComputerArgs, spec.AgentArgs}
	for i, list := range lists {
		if home != "" {
			list = codexDropOverrides(logger, list, func(path []string) bool {
				return len(path) > 0 && path[0] == "shell_environment_policy"
			})
		}
		lists[i] = codexStripFeatureArgs(logger, list)
	}
	user := NormalizeCodexLaunchArgs(lists[0], lists[1], logger)
	launch := append(append([]string{}, profile.CodexConfigArgs...), user...)
	args := CodexAppServerArgs(launch...)
	if spec.WithoutNativeWebTools {
		// After every user override, which cannot turn it back on.
		args = append(args, "--config", `web_search="disabled"`)
	}
	if codexUnloadsImmediately(home) {
		args = append(args, "-c", "thread_unload_delay_secs=0")
	}
	return args
}

// codexStripFeatureArgs drops overrides of unmanaged features and of
// agents.enabled, and removes unmanaged names from --enable/--disable lists,
// which Codex applies after every --config override.
func codexStripFeatureArgs(logger *slog.Logger, list []string) []string {
	list = codexDropOverrides(logger, list, func(path []string) bool {
		if len(path) == 1 {
			return path[0] == "features"
		}
		if len(path) == 2 && path[0] == "agents" && path[1] == "enabled" {
			return true
		}
		return len(path) == 2 && path[0] == "features" && codexUnmanagedFeatures[path[1]]
	})
	out := make([]string, 0, len(list))
	for i := 0; i < len(list); i++ {
		word := list[i]
		for _, flag := range []string{"--enable", "--disable"} {
			switch {
			case word == flag && i+1 < len(list):
				kept, changed := codexKeepFeatures(stripQuotes(list[i+1]))
				if changed {
					logger.Warn("Codex configuration option is adapter-owned", "flag", flag)
				}
				i++
				if kept != "" {
					out = append(out, flag, kept)
				}
				word = ""
			case strings.HasPrefix(word, flag+"="):
				kept, changed := codexKeepFeatures(stripQuotes(word[len(flag)+1:]))
				if changed {
					logger.Warn("Codex configuration option is adapter-owned", "flag", flag)
				}
				if kept != "" {
					out = append(out, flag+"="+kept)
				}
				word = ""
			}
			if word == "" {
				break
			}
		}
		if word != "" {
			out = append(out, word)
		}
	}
	return out
}

func codexKeepFeatures(value string) (string, bool) {
	var kept []string
	changed := false
	for _, name := range strings.Split(value, ",") {
		if codexUnmanagedFeatures[strings.TrimSpace(name)] {
			changed = true
			continue
		}
		kept = append(kept, name)
	}
	if !changed {
		return value, false
	}
	return strings.Join(kept, ","), true
}

// codexDropOverrides removes config overrides whose key path (after an
// optional profiles.<name>. prefix) matches. Unparseable keys are kept.
func codexDropOverrides(logger *slog.Logger, list []string, match func(path []string) bool) []string {
	if logger == nil {
		logger = slog.Default()
	}
	out := make([]string, 0, len(list))
	for i := 0; i < len(list); i++ {
		value, consumed, ok := codexConfigOverride(list, i)
		if ok {
			if path, parsed := codexOverridePath(value); parsed && match(path) {
				logger.Warn("Codex configuration option is adapter-owned", "flag", "--config")
				i += consumed - 1
				continue
			}
		}
		out = append(out, list[i])
	}
	return out
}

// codexConfigOverride recognizes -c X, --config X, -c=X, --config=X and -cX.
func codexConfigOverride(list []string, i int) (value string, consumed int, ok bool) {
	word := list[i]
	switch {
	case word == "-c" || word == "--config":
		if i+1 >= len(list) {
			return "", 0, false
		}
		return stripQuotes(list[i+1]), 2, true
	case strings.HasPrefix(word, "--config="):
		return stripQuotes(word[len("--config="):]), 1, true
	case strings.HasPrefix(word, "-c="):
		return stripQuotes(word[len("-c="):]), 1, true
	case strings.HasPrefix(word, "-c") && len(word) > 2:
		return stripQuotes(word[2:]), 1, true
	}
	return "", 0, false
}

// codexOverridePath parses the TOML dotted key of key=value and strips a
// leading profiles.<name>.
func codexOverridePath(value string) ([]string, bool) {
	key, ok := codexOverrideKey(value)
	if !ok {
		return nil, false
	}
	var document map[string]any
	if toml.Unmarshal([]byte(key+" = 0\n"), &document) != nil {
		return nil, false
	}
	var path []string
	var node any = document
	for {
		table, isTable := node.(map[string]any)
		if !isTable {
			break
		}
		if len(table) != 1 {
			return nil, false
		}
		for name, child := range table {
			path = append(path, name)
			node = child
		}
	}
	if len(path) == 0 {
		return nil, false
	}
	if len(path) > 2 && path[0] == "profiles" {
		path = path[2:]
	}
	return path, true
}

// codexOverrideKey returns the text before the first '=' outside quotes.
func codexOverrideKey(value string) (string, bool) {
	var quote byte
	for i := 0; i < len(value); i++ {
		c := value[i]
		switch {
		case quote == '"' && c == '\\':
			i++
		case quote != 0 && c == quote:
			quote = 0
		case quote == 0 && (c == '"' || c == '\''):
			quote = c
		case quote == 0 && c == '=':
			key := strings.TrimSpace(value[:i])
			return key, key != "" && !strings.ContainsAny(key, "\r\n")
		}
	}
	return "", false
}
