// Command linger-pi-launcher runs the bundled Pi CLI on the sibling Node
// runtime without going through a shell.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/winprocess"
)

const launcherName = "linger bundled pi"

type piTarget struct {
	node  string
	entry string
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

func resolvePiTarget(executable string) (piTarget, error) {
	if resolved, err := filepath.EvalSymlinks(executable); err == nil {
		executable = resolved
	} else {
		executable = filepath.Clean(executable)
	}
	tools := filepath.Dir(filepath.Dir(executable))
	entry := filepath.Join(tools, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
	if !isRegularFile(entry) {
		return piTarget{}, fmt.Errorf("%s: cli entrypoint not found at %s", launcherName, entry)
	}
	nodeName := nodeBinaryName()
	candidates := []string{
		filepath.Join(filepath.Dir(filepath.Dir(tools)), "runtime", "bin", nodeName),
		filepath.Join(filepath.Dir(tools), "runtime", "bin", nodeName),
	}
	for _, candidate := range candidates {
		if isRegularFile(candidate) {
			return piTarget{node: candidate, entry: entry}, nil
		}
	}
	return piTarget{}, fmt.Errorf("%s: runtime/bin/%s not found", launcherName, nodeName)
}

func run(executable string, args []string, stdin io.Reader, stdout, stderr io.Writer) error {
	target, err := resolvePiTarget(executable)
	if err != nil {
		return err
	}
	argv := make([]string, 0, 1+len(args))
	argv = append(argv, target.entry)
	argv = append(argv, args...)
	cmd := exec.Command(target.node, argv...)
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
