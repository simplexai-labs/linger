package main

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func evalPath(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func writeFixtureFile(t *testing.T, path string, body []byte, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, body, mode); err != nil {
		t.Fatal(err)
	}
}

func piBinaryName() string {
	if runtime.GOOS == "windows" {
		return "pi.exe"
	}
	return "pi"
}

func TestResolvePiTargetLayouts(t *testing.T) {
	t.Run("layout 1: root/cli/computer-tools/bin/pi -> root/runtime/bin/node", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		pi := filepath.Join(root, "cli", "computer-tools", "bin", piBinaryName())
		entry := filepath.Join(root, "cli", "computer-tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
		node := filepath.Join(root, "runtime", "bin", nodeBinaryName())

		writeFixtureFile(t, pi, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("console.log('ok')\n"), 0o600)
		writeFixtureFile(t, node, []byte("node"), 0o700)

		target, err := resolvePiTarget(pi)
		if err != nil {
			t.Fatalf("resolvePiTarget failed: %v", err)
		}
		if target.node != node || target.entry != entry {
			t.Fatalf("got %+v, want node=%q entry=%q", target, node, entry)
		}
	})

	t.Run("layout 2: deps/computer-tools/bin/pi -> deps/runtime/bin/node", func(t *testing.T) {
		deps := evalPath(t, t.TempDir())
		pi := filepath.Join(deps, "computer-tools", "bin", piBinaryName())
		entry := filepath.Join(deps, "computer-tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
		node := filepath.Join(deps, "runtime", "bin", nodeBinaryName())

		writeFixtureFile(t, pi, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("console.log('ok')\n"), 0o600)
		writeFixtureFile(t, node, []byte("node"), 0o700)

		target, err := resolvePiTarget(pi)
		if err != nil {
			t.Fatalf("resolvePiTarget failed: %v", err)
		}
		if target.node != node || target.entry != entry {
			t.Fatalf("got %+v, want node=%q entry=%q", target, node, entry)
		}

		// A standalone bundle symlinks cli/computer-tools to deps/computer-tools;
		// EvalSymlinks resolves back into deps/computer-tools so layout 2 matches.
		if runtime.GOOS != "windows" {
			bundle := evalPath(t, t.TempDir())
			if err := os.MkdirAll(filepath.Join(bundle, "cli"), 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(filepath.Join(deps, "computer-tools"), filepath.Join(bundle, "cli", "computer-tools")); err != nil {
				t.Fatal(err)
			}
			linkedPi := filepath.Join(bundle, "cli", "computer-tools", "bin", piBinaryName())
			linkedTarget, err := resolvePiTarget(linkedPi)
			if err != nil {
				t.Fatalf("resolvePiTarget via symlink failed: %v", err)
			}
			if linkedTarget.node != node || linkedTarget.entry != entry {
				t.Fatalf("symlink got %+v, want node=%q entry=%q", linkedTarget, node, entry)
			}
		}
	})
}

func TestResolvePiTargetRejectsMissingOrNonRegularFiles(t *testing.T) {
	t.Run("missing node", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		pi := filepath.Join(root, "cli", "computer-tools", "bin", piBinaryName())
		entry := filepath.Join(root, "cli", "computer-tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
		writeFixtureFile(t, pi, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)

		_, err := resolvePiTarget(pi)
		if err == nil || !strings.Contains(err.Error(), "runtime/bin/"+nodeBinaryName()) {
			t.Fatalf("got err=%v, want missing node error", err)
		}
	})

	t.Run("node is a directory", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		pi := filepath.Join(root, "cli", "computer-tools", "bin", piBinaryName())
		entry := filepath.Join(root, "cli", "computer-tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
		nodeDir := filepath.Join(root, "runtime", "bin", nodeBinaryName())
		writeFixtureFile(t, pi, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		if err := os.MkdirAll(nodeDir, 0o700); err != nil {
			t.Fatal(err)
		}

		if _, err := resolvePiTarget(pi); err == nil {
			t.Fatal("directory node candidate was accepted")
		}
	})

	t.Run("missing cli.js", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		pi := filepath.Join(root, "cli", "computer-tools", "bin", piBinaryName())
		node := filepath.Join(root, "runtime", "bin", nodeBinaryName())
		writeFixtureFile(t, pi, []byte("launcher"), 0o700)
		writeFixtureFile(t, node, []byte("node"), 0o700)

		_, err := resolvePiTarget(pi)
		if err == nil || !strings.Contains(err.Error(), "cli entrypoint not found") {
			t.Fatalf("got err=%v, want missing cli.js error", err)
		}
	})

	t.Run("cli.js is a directory", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		pi := filepath.Join(root, "cli", "computer-tools", "bin", piBinaryName())
		entryDir := filepath.Join(root, "cli", "computer-tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
		node := filepath.Join(root, "runtime", "bin", nodeBinaryName())
		writeFixtureFile(t, pi, []byte("launcher"), 0o700)
		writeFixtureFile(t, node, []byte("node"), 0o700)
		if err := os.MkdirAll(entryDir, 0o700); err != nil {
			t.Fatal(err)
		}

		if _, err := resolvePiTarget(pi); err == nil {
			t.Fatal("directory cli.js was accepted")
		}
	})
}

func TestRunForwardsArgsStdioAndExitCode(t *testing.T) {
	root := evalPath(t, t.TempDir())
	pi := filepath.Join(root, "cli", "computer-tools", "bin", piBinaryName())
	entry := filepath.Join(root, "cli", "computer-tools", "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
	node := filepath.Join(root, "runtime", "bin", nodeBinaryName())

	writeFixtureFile(t, pi, []byte("launcher"), 0o700)

	if runtime.GOOS == "windows" {
		hostNode, err := exec.LookPath("node.exe")
		if err != nil {
			t.Skip("node.exe not found in PATH")
		}
		if err := os.MkdirAll(filepath.Dir(node), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Link(hostNode, node); err != nil {
			data, readErr := os.ReadFile(hostNode)
			if readErr != nil {
				t.Fatal(readErr)
			}
			writeFixtureFile(t, node, data, 0o700)
		}
		script := `const fs = require("node:fs");
const input = fs.readFileSync(0, "utf8");
process.stdout.write("entry=" + process.argv[1] + "\n");
process.stdout.write("args=" + process.argv.slice(2).join(",") + "\n");
process.stdout.write("stdin=" + input + "\n");
const exitArg = process.argv.slice(2).find((a) => a.startsWith("--exit="));
if (exitArg) process.exit(Number(exitArg.slice("--exit=".length)));
`
		writeFixtureFile(t, entry, []byte(script), 0o600)
	} else {
		writeFixtureFile(t, entry, []byte("// fixture entry\n"), 0o600)
		script := `#!/bin/sh
printf 'entry=%s\n' "$1"
shift
args=""
exit_code=0
for arg in "$@"; do
  if [ -n "$args" ]; then args="$args,$arg"; else args="$arg"; fi
  case "$arg" in
    --exit=*) exit_code="${arg#--exit=}" ;;
  esac
done
printf 'args=%s\n' "$args"
input=$(cat)
printf 'stdin=%s\n' "$input"
exit "$exit_code"
`
		writeFixtureFile(t, node, []byte(script), 0o700)
	}

	var stdout, stderr bytes.Buffer
	err := run(pi, []string{"--mode", "rpc", "hello world"}, strings.NewReader("ping-body"), &stdout, &stderr)
	if err != nil {
		t.Fatalf("run failed: %v (stderr=%q)", err, stderr.String())
	}
	want := "entry=" + entry + "\nargs=--mode,rpc,hello world\nstdin=ping-body\n"
	if stdout.String() != want {
		t.Fatalf("stdout = %q, want %q", stdout.String(), want)
	}

	stdout.Reset()
	stderr.Reset()
	err = run(pi, []string{"--exit=42"}, strings.NewReader(""), &stdout, &stderr)
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || exitErr.ExitCode() != 42 {
		t.Fatalf("exit err = %v, want ExitCode 42", err)
	}
}
