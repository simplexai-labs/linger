package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
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

func unsetEnvForTest(t *testing.T, key string) {
	t.Helper()
	prev, hadPrev := os.LookupEnv(key)
	if err := os.Unsetenv(key); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if hadPrev {
			_ = os.Setenv(key, prev)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func teamHubBinaryName() string {
	if runtime.GOOS == "windows" {
		return "teamhub.exe"
	}
	return "teamhub"
}

func desktopPaths(root string) (launcher, entry, bundledNode, electronApp string) {
	cliDir := filepath.Join(root, "resources", "app", "dist", "teamhub-cli")
	launcher = filepath.Join(cliDir, teamHubBinaryName())
	entry = filepath.Join(cliDir, "teamhub.js")
	bundledNode = filepath.Join(root, "resources", "runtime", "bin", nodeBinaryName())
	electronApp = filepath.Join(root, electronBinaryName())
	return launcher, entry, bundledNode, electronApp
}

// buildFakeNodeFixture compiles a self-contained Go binary into binaryPath so
// Windows tests never depend on a host node.exe installation or Node version.
func buildFakeNodeFixture(t *testing.T, binaryPath string) {
	t.Helper()
	srcDir := t.TempDir()
	const goMod = "module fakenode\n\ngo 1.22\n"
	const mainSrc = `package main

import (
	"encoding/json"
	"io"
	"os"
	"strconv"
	"strings"
)

func main() {
	stdinBytes, _ := io.ReadAll(os.Stdin)
	outPath := os.Getenv("LINGER_TEST_RESULT_PATH")
	if outPath == "" {
		_, _ = os.Stderr.WriteString("stderr-sentinel")
	}

	var runAsNode *string
	runAsNodeKeyCount := 0
	for _, entry := range os.Environ() {
		name, value, ok := strings.Cut(entry, "=")
		if ok && strings.EqualFold(name, "ELECTRON_RUN_AS_NODE") {
			v := value
			runAsNode = &v
			runAsNodeKeyCount++
		}
	}

	rawArgs := os.Args[1:]
	var execArgv []string
	var entry string
	var userArgs []string
	if len(rawArgs) >= 2 {
		execArgv = rawArgs[:1]
		entry = rawArgs[1]
		userArgs = rawArgs[2:]
	} else {
		userArgs = rawArgs
	}

	payload, _ := json.Marshal(struct {
		ExecArgv          []string ` + "`json:\"execArgv\"`" + `
		Entry             string   ` + "`json:\"entry\"`" + `
		Args              []string ` + "`json:\"args\"`" + `
		Stdin             string   ` + "`json:\"stdin\"`" + `
		RunAsNode         *string  ` + "`json:\"runAsNode\"`" + `
		RunAsNodeKeyCount int      ` + "`json:\"runAsNodeKeyCount\"`" + `
	}{
		ExecArgv:          execArgv,
		Entry:             entry,
		Args:              userArgs,
		Stdin:             string(stdinBytes),
		RunAsNode:         runAsNode,
		RunAsNodeKeyCount: runAsNodeKeyCount,
	})

	if outPath != "" {
		_ = os.WriteFile(outPath, payload, 0o600)
	} else {
		_, _ = os.Stdout.Write(payload)
	}

	for _, arg := range userArgs {
		if codeStr, ok := strings.CutPrefix(arg, "--exit="); ok {
			if code, err := strconv.Atoi(codeStr); err == nil {
				os.Exit(code)
			}
		}
	}
}
`
	writeFixtureFile(t, filepath.Join(srcDir, "go.mod"), []byte(goMod), 0o600)
	writeFixtureFile(t, filepath.Join(srcDir, "main.go"), []byte(mainSrc), 0o600)
	if err := os.MkdirAll(filepath.Dir(binaryPath), 0o700); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("go", "build", "-o", binaryPath, ".")
	cmd.Dir = srcDir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("go build fake node fixture failed: %v\n%s", err, string(out))
	}
}

func installRunnableFixture(t *testing.T, binaryPath, entryPath string) {
	t.Helper()
	writeFixtureFile(t, entryPath, []byte("// fixture teamhub.js\n"), 0o600)
	if runtime.GOOS == "windows" {
		buildFakeNodeFixture(t, binaryPath)
		return
	}

	// Use NUL-delimited records so arbitrary multiline bytes (\n, \r\n, quotes,
	// shell metacharacters, UTF-8) round-trip without escaping ambiguity.
	script := `#!/bin/sh
printf 'stderr-sentinel' >&2
if [ "${ELECTRON_RUN_AS_NODE+set}" = "set" ]; then
  printf 'env:%s\0' "$ELECTRON_RUN_AS_NODE"
else
  printf 'env-unset\0'
fi
for arg in "$@"; do
  printf 'arg:%s\0' "$arg"
done
printf 'stdin:'
cat
printf '\0'
for arg in "$@"; do
  case "$arg" in
    --exit=*) exit "${arg#--exit=}" ;;
  esac
done
`
	writeFixtureFile(t, binaryPath, []byte(script), 0o700)
}

type capturedRun struct {
	execArgv          []string
	entry             string
	args              []string
	stdin             string
	runAsNodeSet      bool
	runAsNodeValue    string
	runAsNodeKeyCount int
}

func parseCapturedRun(t *testing.T, raw []byte) capturedRun {
	t.Helper()
	if runtime.GOOS == "windows" {
		var payload struct {
			ExecArgv          []string `json:"execArgv"`
			Entry             string   `json:"entry"`
			Args              []string `json:"args"`
			Stdin             string   `json:"stdin"`
			RunAsNode         *string  `json:"runAsNode"`
			RunAsNodeKeyCount int      `json:"runAsNodeKeyCount"`
		}
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("failed to decode windows fixture json %q: %v", string(raw), err)
		}
		res := capturedRun{
			execArgv:          payload.ExecArgv,
			entry:             payload.Entry,
			args:              payload.Args,
			stdin:             payload.Stdin,
			runAsNodeKeyCount: payload.RunAsNodeKeyCount,
		}
		if payload.RunAsNode != nil {
			res.runAsNodeSet = true
			res.runAsNodeValue = *payload.RunAsNode
		}
		return res
	}

	records := bytes.Split(raw, []byte{0})
	if len(records) < 4 || len(records[len(records)-1]) != 0 {
		t.Fatalf("unexpected NUL-delimited output: %q", string(raw))
	}
	records = records[:len(records)-1]

	var res capturedRun
	var argv []string
	for _, rec := range records {
		switch {
		case bytes.Equal(rec, []byte("env-unset")):
			res.runAsNodeSet = false
		case bytes.HasPrefix(rec, []byte("env:")):
			res.runAsNodeSet = true
			res.runAsNodeValue = string(rec[len("env:"):])
			res.runAsNodeKeyCount = 1
		case bytes.HasPrefix(rec, []byte("arg:")):
			argv = append(argv, string(rec[len("arg:"):]))
		case bytes.HasPrefix(rec, []byte("stdin:")):
			res.stdin = string(rec[len("stdin:"):])
		default:
			t.Fatalf("unexpected record %q", string(rec))
		}
	}
	if len(argv) < 2 {
		t.Fatalf("expected at least --use-env-proxy and entry in argv, got %q", argv)
	}
	res.execArgv = argv[:1]
	res.entry = argv[1]
	res.args = argv[2:]
	return res
}

func TestResolveTeamHubTargetPriorityAndValidation(t *testing.T) {
	t.Run("bundled node wins over electron and LINGER_NODE without runAsNode", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, bundledNode, electronApp := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, bundledNode, []byte("node"), 0o700)
		writeFixtureFile(t, electronApp, []byte("electron"), 0o700)

		t.Setenv("LINGER_NODE", "/does/not/exist")
		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget failed: %v", err)
		}
		if target.program != bundledNode || target.entry != entry || target.runAsNode {
			t.Fatalf("got %+v, want program=%q entry=%q runAsNode=false", target, bundledNode, entry)
		}
	})

	t.Run("electron fallback used when bundled node is absent", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, electronApp := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, electronApp, []byte("electron"), 0o700)

		t.Setenv("LINGER_NODE", "/does/not/exist")
		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget failed: %v", err)
		}
		if target.program != electronApp || target.entry != entry || !target.runAsNode {
			t.Fatalf("got %+v, want program=%q entry=%q runAsNode=true", target, electronApp, entry)
		}
	})

	t.Run("directory bundled node is ignored and falls back to electron", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, bundledNode, electronApp := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		if err := os.MkdirAll(bundledNode, 0o700); err != nil {
			t.Fatal(err)
		}
		writeFixtureFile(t, electronApp, []byte("electron"), 0o700)

		unsetEnvForTest(t, "LINGER_NODE")
		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget failed: %v", err)
		}
		if target.program != electronApp || !target.runAsNode {
			t.Fatalf("got %+v, want electron fallback", target)
		}
	})

	t.Run("dev fallback uses explicit LINGER_NODE file path", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, _ := desktopPaths(root)
		customNode := filepath.Join(root, "custom", nodeBinaryName())
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, customNode, []byte("node"), 0o700)

		t.Setenv("LINGER_NODE", "  "+customNode+"  ")
		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget failed: %v", err)
		}
		if target.program != customNode || target.entry != entry || target.runAsNode {
			t.Fatalf("got %+v, want customNode=%q runAsNode=false", target, customNode)
		}
	})

	t.Run("dev fallback resolves relative current-directory LINGER_NODE to absolute path and executes it", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, _ := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)

		cwd := evalPath(t, t.TempDir())
		binName := "custom-node"
		relOverride := "./custom-node"
		if runtime.GOOS == "windows" {
			binName = "custom-node.exe"
			relOverride = `.\custom-node.exe`
		}
		localNode := filepath.Join(cwd, binName)
		installRunnableFixture(t, localNode, entry)

		// Put a decoy binary with the same basename on PATH to prove relative
		// LINGER_NODE executes the local file rather than hitting LookPath.
		decoyDir := evalPath(t, t.TempDir())
		writeFixtureFile(t, filepath.Join(decoyDir, binName), []byte("#!/bin/sh\nexit 99\n"), 0o700)
		t.Setenv("PATH", decoyDir)
		t.Setenv("LINGER_NODE", relOverride)
		t.Chdir(cwd)

		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget failed: %v", err)
		}
		if !filepath.IsAbs(target.program) {
			t.Fatalf("target.program = %q, want absolute path", target.program)
		}
		if !strings.EqualFold(filepath.Clean(target.program), filepath.Clean(localNode)) {
			t.Fatalf("target.program = %q, want %q", target.program, localNode)
		}

		var stdout, stderr bytes.Buffer
		if err := run(launcher, []string{"relative-ok"}, strings.NewReader(""), &stdout, &stderr); err != nil {
			t.Fatalf("run with relative LINGER_NODE failed: %v (stderr=%q)", err, stderr.String())
		}
		got := parseCapturedRun(t, stdout.Bytes())
		if !slices.Equal(got.args, []string{"relative-ok"}) {
			t.Fatalf("args = %q, want [relative-ok]", got.args)
		}
	})

	t.Run("dev fallback uses explicit LINGER_NODE command on PATH", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, _ := desktopPaths(root)
		binDir := filepath.Join(root, "bin")
		cmdName := "custom-node"
		if runtime.GOOS == "windows" {
			cmdName = "custom-node.exe"
		}
		customNode := filepath.Join(binDir, cmdName)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, customNode, []byte("node"), 0o700)

		t.Setenv("PATH", binDir)
		t.Setenv("LINGER_NODE", cmdName)
		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget failed: %v", err)
		}
		if !strings.EqualFold(target.program, customNode) || target.runAsNode {
			t.Fatalf("got %+v, want %q runAsNode=false", target, customNode)
		}
	})

	t.Run("dev fallback uses PATH node when LINGER_NODE is unset or blank", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, _ := desktopPaths(root)
		binDir := filepath.Join(root, "bin")
		pathNode := filepath.Join(binDir, nodeBinaryName())
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, pathNode, []byte("node"), 0o700)

		t.Setenv("PATH", binDir)
		unsetEnvForTest(t, "LINGER_NODE")
		target, err := resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget (unset) failed: %v", err)
		}
		if !strings.EqualFold(target.program, pathNode) || target.runAsNode {
			t.Fatalf("got %+v, want %q runAsNode=false", target, pathNode)
		}

		t.Setenv("LINGER_NODE", "   ")
		target, err = resolveTeamHubTarget(launcher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget (blank) failed: %v", err)
		}
		if !strings.EqualFold(target.program, pathNode) || target.runAsNode {
			t.Fatalf("got %+v, want %q runAsNode=false", target, pathNode)
		}
	})

	t.Run("invalid explicit LINGER_NODE fails instead of falling back to PATH", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, _ := desktopPaths(root)
		binDir := filepath.Join(root, "bin")
		pathNode := filepath.Join(binDir, nodeBinaryName())
		dirOverride := filepath.Join(root, "some-dir")
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, pathNode, []byte("node"), 0o700)
		if err := os.MkdirAll(dirOverride, 0o700); err != nil {
			t.Fatal(err)
		}

		t.Setenv("PATH", binDir)
		for _, invalid := range []string{
			filepath.Join(root, "missing", nodeBinaryName()),
			dirOverride,
			"definitely-missing-node-command",
		} {
			t.Setenv("LINGER_NODE", invalid)
			if target, err := resolveTeamHubTarget(launcher); err == nil {
				t.Fatalf("expected error for invalid LINGER_NODE=%q, got target=%+v", invalid, target)
			}
		}
	})

	t.Run("missing or directory teamhub.js fails", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, bundledNode, _ := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, bundledNode, []byte("node"), 0o700)

		if _, err := resolveTeamHubTarget(launcher); err == nil || !strings.Contains(err.Error(), "cli entrypoint not found") {
			t.Fatalf("got err=%v, want missing teamhub.js error", err)
		}

		if err := os.MkdirAll(entry, 0o700); err != nil {
			t.Fatal(err)
		}
		if _, err := resolveTeamHubTarget(launcher); err == nil {
			t.Fatal("directory teamhub.js was accepted")
		}
	})

	t.Run("symlinked launcher resolves through EvalSymlinks", func(t *testing.T) {
		if runtime.GOOS == "windows" {
			t.Skip("symlinks require developer mode or elevated privileges on Windows")
		}
		root := evalPath(t, t.TempDir())
		launcher, entry, bundledNode, _ := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, entry, []byte("ok"), 0o600)
		writeFixtureFile(t, bundledNode, []byte("node"), 0o700)

		linkDir := evalPath(t, t.TempDir())
		linkedLauncher := filepath.Join(linkDir, teamHubBinaryName())
		if err := os.Symlink(launcher, linkedLauncher); err != nil {
			t.Fatal(err)
		}
		target, err := resolveTeamHubTarget(linkedLauncher)
		if err != nil {
			t.Fatalf("resolveTeamHubTarget via symlink failed: %v", err)
		}
		if target.program != bundledNode || target.entry != entry || target.runAsNode {
			t.Fatalf("got %+v, want bundledNode=%q entry=%q", target, bundledNode, entry)
		}
	})
}

func TestRunPreservesMultilineArgsStdioEnvAndExitCode(t *testing.T) {
	multilineBody := strings.Join([]string{
		"First line with \u4f60\u597d Unicode",
		"",
		"- bullet with \"double quotes\" and 'single quotes'",
		"- cmd metachars: & | %TEMP% ^ <tag> > out",
		"```json",
		`{"key": "value & %TEMP%", "crlf": "next"}`,
		"```",
	}, "\n") + "\r\nTrailing CRLF line\r\n"

	t.Run("bundled node preserves argv, stdio, stderr, exit code without injecting ELECTRON_RUN_AS_NODE", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, bundledNode, electronApp := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		writeFixtureFile(t, electronApp, []byte("electron"), 0o700)
		installRunnableFixture(t, bundledNode, entry)

		unsetEnvForTest(t, "ELECTRON_RUN_AS_NODE")
		args := []string{"message", "send", "--content", multilineBody, "--extra", `a "b" & | %TEMP% ^ < >`}
		stdinBody := "line 1\r\n\nline 3 \u4f60\u597d"

		var stdout, stderr bytes.Buffer
		if err := run(launcher, args, strings.NewReader(stdinBody), &stdout, &stderr); err != nil {
			t.Fatalf("run failed: %v (stderr=%q)", err, stderr.String())
		}
		if stderr.String() != "stderr-sentinel" {
			t.Fatalf("stderr = %q, want %q", stderr.String(), "stderr-sentinel")
		}
		got := parseCapturedRun(t, stdout.Bytes())
		if !slices.Contains(got.execArgv, "--use-env-proxy") {
			t.Fatalf("execArgv = %q, want --use-env-proxy", got.execArgv)
		}
		if !strings.EqualFold(got.entry, entry) {
			t.Fatalf("entry = %q, want %q", got.entry, entry)
		}
		if !slices.Equal(got.args, args) {
			t.Fatalf("args mismatch:\n got: %q\nwant: %q", got.args, args)
		}
		if got.stdin != stdinBody {
			t.Fatalf("stdin = %q, want %q", got.stdin, stdinBody)
		}
		if got.runAsNodeSet {
			t.Fatalf("bundled node unexpectedly received ELECTRON_RUN_AS_NODE=%q", got.runAsNodeValue)
		}

		stdout.Reset()
		stderr.Reset()
		err := run(launcher, []string{"--exit=42"}, strings.NewReader(""), &stdout, &stderr)
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) || exitErr.ExitCode() != 42 {
			t.Fatalf("exit err = %v, want ExitCode 42", err)
		}
	})

	t.Run("electron fallback injects ELECTRON_RUN_AS_NODE=1 and deduplicates existing key without mutating launcher env", func(t *testing.T) {
		root := evalPath(t, t.TempDir())
		launcher, entry, _, electronApp := desktopPaths(root)
		writeFixtureFile(t, launcher, []byte("launcher"), 0o700)
		installRunnableFixture(t, electronApp, entry)

		if runtime.GOOS == "windows" {
			unsetEnvForTest(t, "ELECTRON_RUN_AS_NODE")
			t.Setenv("electron_run_as_node", "0")
		} else {
			t.Setenv("ELECTRON_RUN_AS_NODE", "0")
		}

		var stdout, stderr bytes.Buffer
		if err := run(launcher, []string{"message", "send", "--content", multilineBody}, strings.NewReader(""), &stdout, &stderr); err != nil {
			t.Fatalf("run failed: %v (stderr=%q)", err, stderr.String())
		}
		got := parseCapturedRun(t, stdout.Bytes())
		if !got.runAsNodeSet || got.runAsNodeValue != "1" {
			t.Fatalf("ELECTRON_RUN_AS_NODE set=%v value=%q, want set=true value=\"1\"", got.runAsNodeSet, got.runAsNodeValue)
		}
		if runtime.GOOS == "windows" && got.runAsNodeKeyCount != 1 {
			t.Fatalf("ELECTRON_RUN_AS_NODE key count = %d, want 1", got.runAsNodeKeyCount)
		}
		if !slices.Equal(got.args, []string{"message", "send", "--content", multilineBody}) {
			t.Fatalf("args mismatch:\n got: %q\nwant: %q", got.args, []string{"message", "send", "--content", multilineBody})
		}
		if os.Getenv("ELECTRON_RUN_AS_NODE") != "0" {
			t.Fatalf("launcher process env mutated: ELECTRON_RUN_AS_NODE=%q", os.Getenv("ELECTRON_RUN_AS_NODE"))
		}
	})
}
