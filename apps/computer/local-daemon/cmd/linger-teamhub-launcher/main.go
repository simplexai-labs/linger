// Command linger-teamhub-launcher runs the Desktop bundled TeamHub CLI on
// the bundled Node or Electron runtime without going through a command shell.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
)

const launcherName = "linger desktop teamhub"

type teamHubTarget struct {
	program   string
	entry     string
	runAsNode bool
}

func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

func nodeBinaryName() string {
	if runtime.GOOS == "windows" {
		return "node.exe"
	}
	return "node"
}

func electronBinaryName() string {
	if runtime.GOOS == "windows" {
		return "Linger.exe"
	}
	return "Linger"
}

func resolveTeamHubTarget(executable string) (teamHubTarget, error) {
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	} else {
		executable = filepath.Clean(executable)
	}
	cliDir := filepath.Dir(executable)
	entry := filepath.Join(cliDir, "teamhub.js")
	if !isRegularFile(entry) {
		return teamHubTarget{}, fmt.Errorf("%s: cli entrypoint not found at %s", launcherName, entry)
	}

	// Priority 1: Desktop bundled standalone Node (resources/runtime/bin/node(.exe)).
	bundledNode := filepath.Clean(filepath.Join(cliDir, "..", "..", "..", "runtime", "bin", nodeBinaryName()))
	if isRegularFile(bundledNode) {
		return teamHubTarget{program: bundledNode, entry: entry, runAsNode: false}, nil
	}

	// Priority 2: Desktop Electron executable run in Node mode.
	electronApp := filepath.Clean(filepath.Join(cliDir, "..", "..", "..", "..", electronBinaryName()))
	if isRegularFile(electronApp) {
		return teamHubTarget{program: electronApp, entry: entry, runAsNode: true}, nil
	}

	// Priority 3: Unpackaged development fallback via explicit LINGER_NODE or PATH.
	if rawOverride, ok := os.LookupEnv("LINGER_NODE"); ok {
		if override := strings.TrimSpace(rawOverride); override != "" {
			if strings.ContainsAny(override, `/\`) || filepath.VolumeName(override) != "" {
				absPath, err := filepath.Abs(override)
				if err != nil {
					return teamHubTarget{}, fmt.Errorf("%s: invalid LINGER_NODE %q: %w", launcherName, override, err)
				}
				if isRegularFile(absPath) {
					return teamHubTarget{program: absPath, entry: entry}, nil
				}
				return teamHubTarget{}, fmt.Errorf("%s: LINGER_NODE %q is not an existing file", launcherName, override)
			}
			if resolved, err := exec.LookPath(override); err == nil && isRegularFile(resolved) {
				return teamHubTarget{program: resolved, entry: entry}, nil
			}
			return teamHubTarget{}, fmt.Errorf("%s: LINGER_NODE %q not found", launcherName, override)
		}
	}

	nodeName := nodeBinaryName()
	resolved, err := exec.LookPath(nodeName)
	if err != nil || !isRegularFile(resolved) {
		return teamHubTarget{}, fmt.Errorf("%s: bundled runtime not found and %s is not on PATH", launcherName, nodeName)
	}
	return teamHubTarget{program: resolved, entry: entry}, nil
}

func run(executable string, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	target, err := resolveTeamHubTarget(executable)
	if err != nil {
		return err
	}
	argv := make([]string, 0, 2+len(args))
	argv = append(argv, "--use-env-proxy", target.entry)
	argv = append(argv, args...)
	cmd := exec.Command(target.program, argv...)
	if target.runAsNode {
		// exec.Cmd deduplicates Env keeping the last entry (case-insensitively on Windows).
		cmd.Env = append(os.Environ(), "ELECTRON_RUN_AS_NODE=1")
	}
	cmd.Stdin = stdin
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	return winprocess.RunInKillOnCloseJob(cmd)
}

func main() {
	executable, err := os.Executable()
	if err == nil {
		err = run(executable, os.Args[1:], os.Stdin, os.Stdout, os.Stderr)
	}
	if err == nil {
		return
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && exitErr.ExitCode() >= 0 {
		os.Exit(exitErr.ExitCode())
	}
	_, _ = fmt.Fprintln(os.Stderr, err.Error())
	os.Exit(127)
}
