// Package localmodels runs the installer's localmodels tool for the Daemon.
// It reads `library status`, starts the library actions a Computer owner
// chose, supervises the long ones (download, load), and maps the tool's
// localmodels.library-status/v1 into the Runner Gateway LocalModelsSnapshot.
// It never chooses a model: every action names the model the owner picked.
package localmodels

import (
	"os"
	"os/exec"
	"strings"
)

// Tool is where the installer put the localmodels tool and its state, as
// the Computer config records it.
type Tool struct {
	Python          string
	ModuleDirectory string
	StateDirectory  string
	BaseDirectory   string
}

// Action is one owner-chosen library action. Model is empty only for
// refresh; UnloadFirst is only for load.
type Action struct {
	Name        string
	Model       string
	UnloadFirst []string
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
		return append(args, "download", action.Model, "--base-dir", t.BaseDirectory, "--jsonl")
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

// command builds one tool invocation the way the installer runs it: the
// sealed kit on PYTHONPATH and as the working directory, no user site
// packages, no bytecode writes into the sealed kit.
func (t Tool) command(environment map[string]string, action Action) *exec.Cmd {
	cmd := exec.Command(t.Python, t.arguments(action)...)
	cmd.Dir = t.ModuleDirectory
	values := make(map[string]string, len(environment)+4)
	for key, value := range environment {
		switch strings.ToUpper(key) {
		case "PYTHONHOME", "PYTHONSTARTUP", "PYTHONINSPECT", "PYTHONPATH", "LOCALMODELS_STATE":
			continue
		}
		values[key] = value
	}
	values["PYTHONPATH"] = t.ModuleDirectory
	values["LOCALMODELS_STATE"] = t.StateDirectory
	values["PYTHONNOUSERSITE"] = "1"
	values["PYTHONDONTWRITEBYTECODE"] = "1"
	cmd.Env = make([]string, 0, len(values))
	for key, value := range values {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

// installed reports whether the configured interpreter still exists.
func (t Tool) installed() bool {
	info, err := os.Stat(t.Python)
	return err == nil && info.Mode().IsRegular()
}
