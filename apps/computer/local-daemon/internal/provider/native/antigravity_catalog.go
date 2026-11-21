package native

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
)

const antigravityProbeSeedLimit = 4 << 20

var antigravityProbeSeedFiles = []string{
	"antigravity-oauth-token",
	"settings.json",
}

// AntigravityProbe is what one ACP session/new tells about the signed-in
// account: whether a session opens and which models it offers.
type AntigravityProbe struct {
	AuthenticationRequired bool
	Models                 ModelList
}

// PrepareAntigravityProbe creates an isolated temporary Gemini data directory
// and ACP log path for `agy acp` probes so empty probe sessions and ACP logs
// never accumulate in the user's ~/.gemini/antigravity-cli store (which enforces
// a fixed conversation cap and evicts real user sessions). HOME/USERPROFILE is
// left unchanged so OS keyring auth and GEMINI_API_KEY keep working, while
// file-based OAuth tokens and settings are copied read-only into the probe dir.
func PrepareAntigravityProbe(env map[string]string) ([]string, func(), error) {
	geminiDir, logFile, _, release, err := prepareAntigravityProbeDir(env)
	if err != nil {
		return nil, nil, err
	}
	return []string{"--gemini-dir", geminiDir, "--log-file", logFile}, release, nil
}

func prepareAntigravityProbeDir(env map[string]string) (string, string, string, func(), error) {
	root, err := os.MkdirTemp("", "linger-antigravity-probe-")
	if err != nil {
		return "", "", "", nil, err
	}
	release := func() { _ = os.RemoveAll(root) }
	if err := privatefs.EnsureDir(root); err != nil {
		release()
		return "", "", "", nil, err
	}
	geminiDir := filepath.Join(root, "gemini")
	appDataDir := filepath.Join(geminiDir, "antigravity-cli")
	workDir := filepath.Join(root, "workspace")
	for _, dir := range []string{geminiDir, appDataDir, workDir} {
		if err := privatefs.EnsureDir(dir); err != nil {
			release()
			return "", "", "", nil, err
		}
	}
	if home := antigravityProbeHome(env); home != "" {
		sourceDir := filepath.Join(home, ".gemini", "antigravity-cli")
		for _, name := range antigravityProbeSeedFiles {
			if err := copyAntigravityProbeFile(filepath.Join(sourceDir, name), filepath.Join(appDataDir, name)); err != nil {
				release()
				return "", "", "", nil, err
			}
		}
	}
	return geminiDir, filepath.Join(root, "acp.log"), workDir, release, nil
}

func antigravityProbeHome(env map[string]string) string {
	if home := env["HOME"]; home != "" {
		return home
	}
	return env["USERPROFILE"]
}

func copyAntigravityProbeFile(source, destination string) error {
	file, err := os.Open(source)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read Antigravity probe file %s: %w", filepath.Base(source), err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > antigravityProbeSeedLimit {
		return fmt.Errorf("Antigravity probe file %s must be a regular file of at most 4 MiB", filepath.Base(source))
	}
	data, err := io.ReadAll(io.LimitReader(file, antigravityProbeSeedLimit+1))
	if err != nil {
		return err
	}
	if len(data) > antigravityProbeSeedLimit {
		return fmt.Errorf("Antigravity probe file %s exceeds 4 MiB", filepath.Base(source))
	}
	return privatefs.WriteFile(destination, data, true)
}

// ProbeAntigravity opens an empty ACP session inside a temporary isolated
// Gemini directory and removes that directory after `agy acp` exits, so
// probing never persists 0-step conversations or ACP logs under the user's
// ~/.gemini/antigravity-cli store.
func ProbeAntigravity(ctx context.Context, inv Invocation) (AntigravityProbe, error) {
	env := invocationEnvironment(inv)
	if antigravityProbeHome(env) == "" {
		return AntigravityProbe{}, errors.New("Antigravity probe requires HOME")
	}
	geminiDir, logFile, workDir, release, err := prepareAntigravityProbeDir(env)
	if err != nil {
		return AntigravityProbe{}, err
	}
	defer release()
	probeArgs := []string{"--gemini-dir", geminiDir, "--log-file", logFile}
	var result AntigravityProbe
	err = withACPProcess(ctx, inv, workDir, probeArgs, nil, func(conn *acpConn) error {
		if err := acpInitialize(ctx, conn); err != nil {
			return err
		}
		raw, err := acpOpenSession(ctx, conn, env, func() (json.RawMessage, error) {
			return conn.call(ctx, "session/new", map[string]any{"cwd": workDir, "mcpServers": []any{}})
		})
		if acpNeedsAuth(err) {
			result.AuthenticationRequired = true
			return nil
		}
		if err != nil {
			return err
		}
		var session acpSession
		if json.Unmarshal(raw, &session) != nil || session.SessionID == "" {
			return errors.New("Antigravity session/new returned no session")
		}
		result.Models = antigravityCatalog(session)
		return nil
	})
	return result, err
}

// DiscoverAntigravityModels lists the models of the signed-in account.
func DiscoverAntigravityModels(ctx context.Context, inv Invocation) (ModelList, error) {
	probe, err := ProbeAntigravity(ctx, inv)
	if err != nil {
		return ModelList{}, err
	}
	if probe.AuthenticationRequired {
		return ModelList{}, errors.New("Antigravity sign-in is required to list models")
	}
	return probe.Models, nil
}

// antigravityCatalog turns a session's model selector into the catalog.
// Antigravity selects a model family and a thinking level separately, and
// names each family-and-level pair "<family>-<level>" in availableModels;
// the levels a family offers are the suffixes of its pairs.
func antigravityCatalog(session acpSession) ModelList {
	var families *acpConfigOption
	for i := range session.ConfigOptions {
		if session.ConfigOptions[i].Category == "model" {
			families = &session.ConfigOptions[i]
			break
		}
	}
	var catalog catalogModels
	if families == nil {
		return catalog.list()
	}
	var pairs []string
	current := ""
	if session.Models != nil {
		for _, model := range session.Models.AvailableModels {
			pairs = append(pairs, model.ModelID)
		}
		current = session.Models.CurrentModelID
	}
	for _, family := range families.Options {
		var efforts effortCatalog
		for _, level := range antigravityLevels {
			if slices.Contains(pairs, family.Value+"-"+level) {
				efforts.add(level, "")
			}
		}
		defaultEffort := ""
		if family.Value == families.CurrentValue {
			defaultEffort, _ = strings.CutPrefix(current, family.Value+"-")
		}
		catalog.add(ModelOption{
			ID: family.Value, Label: family.Name, Provider: "antigravity",
			Default: family.Value == families.CurrentValue, Effort: efforts.support(defaultEffort),
		})
	}
	return catalog.list()
}

// antigravityLevels are the product reasoning efforts Antigravity also
// names, in ascending order.
var antigravityLevels = []string{"low", "medium", "high", "xhigh", "max"}

// withACPProcess runs exchange against a fresh `agy acp` in dir, then
// reaps the process tree. ctx bounds the exchange only.
func withACPProcess(ctx context.Context, inv Invocation, dir string, extraArgs []string, handle func(acpFrame), exchange func(*acpConn) error) error {
	proc, err := startACP(inv, dir, nil, handle, extraArgs...)
	if err != nil {
		return err
	}
	exchangeErr := exchange(proc.conn)
	if !proc.stop() && exchangeErr == nil {
		exchangeErr = errors.New("Antigravity probe process did not exit")
	}
	return exchangeErr
}

// invocationEnvironment reads back the environment an Invocation carries.
func invocationEnvironment(inv Invocation) map[string]string {
	env := map[string]string{}
	entries := inv.Env
	if entries == nil {
		entries = os.Environ()
	}
	for _, entry := range entries {
		if key, value, ok := strings.Cut(entry, "="); ok {
			env[key] = value
		}
	}
	return env
}
