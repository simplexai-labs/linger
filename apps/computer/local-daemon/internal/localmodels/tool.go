// Package localmodels runs the installer's localmodels tool for the Daemon.
// It reads `library status`, starts the library actions a Computer owner
// chose, supervises the long ones (download, load), and maps the tool's
// localmodels.library-status/v1 into the Runner Gateway LocalModelsSnapshot.
// It never chooses a model: every action names the model the owner picked.
package localmodels

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// HarnessRoot returns the shared runtime/harness directory sibling to a
// localmodels StateDirectory, or an empty string when stateDir is unset.
func HarnessRoot(stateDir string) string {
	if stateDir == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(stateDir, "..", "..", "harness"))
}

// Tool is where the installer put the localmodels tool and its state, as
// the Computer config records it.
type Tool struct {
	Python          string
	ModuleDirectory string
	StateDirectory  string
	BaseDirectory   string
}

// Action is one owner-chosen library action. Model is empty only for
// refresh; UnloadFirst is only for load; NoAutoload is only for download.
type Action struct {
	Name        string
	Model       string
	UnloadFirst []string
	NoAutoload  bool
}

// Action names, as the Runner Gateway sends them.
const (
	ActionDownload = "download"
	ActionCancel   = "cancel"
	ActionLoad     = "load"
	ActionUnload   = "unload"
	ActionRemove   = "remove"
	ActionRefresh  = "refresh"
)

// arguments are the `library` arguments of one call. Model ids are validated
// by the caller, so none starts with "-".
func (t Tool) arguments(action Action) []string {
	args := []string{"-P", "-s", "-m", "localmodels", "library"}
	switch action.Name {
	case ActionRefresh:
		return append(args, "status", "--base-dir", t.BaseDirectory, "--json")
	case ActionDownload:
		args = append(args, "download", action.Model)
		if action.NoAutoload {
			args = append(args, "--no-autoload")
		}
		return append(args, "--base-dir", t.BaseDirectory, "--jsonl")
	case ActionLoad:
		args = append(args, "load", action.Model)
		for _, other := range action.UnloadFirst {
			args = append(args, "--unload", other)
		}
		return append(args, "--base-dir", t.BaseDirectory, "--jsonl")
	default:
		return append(args, action.Name, action.Model, "--base-dir", t.BaseDirectory, "--json")
	}
}

// command builds one library invocation for the tool.
func (t Tool) command(environment map[string]string, action Action) *exec.Cmd {
	return t.commandArgs(environment, t.arguments(action))
}

// commandArgs builds one tool invocation the way the installer runs it: the
// sealed kit on PYTHONPATH and as the working directory, no user site
// packages, no bytecode writes into the sealed kit, and PI_CODING_AGENT_DIR
// resolved through OverlayEnvironment and workspace.PiSourceEnvironment so
// localmodels reads and writes the same Pi profile the Daemon probes and runs.
func (t Tool) commandArgs(environment map[string]string, args []string) *exec.Cmd {
	cmd := exec.Command(t.Python, args...)
	cmd.Dir = t.ModuleDirectory
	cleaned := make(map[string]string, len(environment))
	for key, value := range environment {
		switch strings.ToUpper(key) {
		case "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONPATH", "LOCALMODELS_STATE":
			continue
		case "PI_CODING_AGENT_DIR":
			if trimmed := strings.TrimSpace(value); trimmed != "" {
				cleaned["PI_CODING_AGENT_DIR"] = trimmed
			}
			continue
		}
		cleaned[key] = value
	}
	effective := OverlayEnvironment(cleaned, t.StateDirectory)
	if piEnv, err := workspace.PiSourceEnvironment(effective); err == nil && piEnv["PI_CODING_AGENT_DIR"] != "" {
		effective["PI_CODING_AGENT_DIR"] = piEnv["PI_CODING_AGENT_DIR"]
	}
	effective["PYTHONPATH"] = t.ModuleDirectory
	effective["LOCALMODELS_STATE"] = t.StateDirectory
	effective["PYTHONNOUSERSITE"] = "1"
	effective["PYTHONDONTWRITEBYTECODE"] = "1"
	cmd.Env = make([]string, 0, len(effective))
	for key, value := range effective {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

// runBuffered executes localmodels with stdout and stderr redirected to
// temporary files (never pipes) so any background gateway child spawned by
// localmodels survives after the CLI process exits.
func (t Tool) runBuffered(
	ctx context.Context,
	environment map[string]string,
	tempDir, prefix string,
	maxBytes int64,
	args []string,
	stdin []byte,
) (stdoutBytes, stderrBytes []byte, exitCode int, err error) {
	if tempDir != "" {
		if mkErr := os.MkdirAll(tempDir, 0o700); mkErr != nil {
			return nil, nil, -1, mkErr
		}
	}
	stdout, err := os.CreateTemp(tempDir, prefix+"-*.out")
	if err != nil {
		return nil, nil, -1, err
	}
	defer func() { _ = os.Remove(stdout.Name()) }()
	stderr, err := os.CreateTemp(tempDir, prefix+"-*.err")
	if err != nil {
		_ = stdout.Close()
		return nil, nil, -1, err
	}
	defer func() { _ = os.Remove(stderr.Name()) }()

	cmd := t.commandArgs(environment, args)
	if len(stdin) > 0 {
		cmd.Stdin = bytes.NewReader(stdin)
	}
	cmd.Stdout, cmd.Stderr = stdout, stderr
	process.Prepare(cmd)
	startErr := cmd.Start()
	_ = stdout.Close()
	_ = stderr.Close()
	if startErr != nil {
		return nil, nil, -1, startErr
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case <-exited:
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		<-exited
		return nil, nil, -1, context.Cause(ctx)
	}
	code := cmd.ProcessState.ExitCode()
	out, readErr := readBounded(stdout.Name(), maxBytes)
	var errOut []byte
	if code != 0 {
		if diagnostic, diagErr := readBounded(stderr.Name(), 4096); diagErr == nil {
			errOut = diagnostic
		}
	}
	return out, errOut, code, readErr
}

// installed reports whether the configured interpreter still exists.
func (t Tool) installed() bool {
	info, err := os.Stat(t.Python)
	return err == nil && info.Mode().IsRegular()
}
