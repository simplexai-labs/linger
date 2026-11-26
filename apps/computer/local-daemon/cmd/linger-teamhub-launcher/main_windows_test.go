//go:build windows

package main

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func TestWindowsPowerShellMultilineArgumentViaTeamHubExe(t *testing.T) {
	powershell, err := exec.LookPath("powershell.exe")
	if err != nil {
		powershell, err = exec.LookPath("pwsh.exe")
		if err != nil {
			t.Skip("powershell.exe/pwsh.exe not found in PATH")
		}
	}

	root := evalPath(t, t.TempDir())
	cliDir := filepath.Join(root, "resources", "app", "dist", "teamhub-cli")
	exePath := filepath.Join(cliDir, "teamhub.exe")
	entryPath := filepath.Join(cliDir, "teamhub.js")
	bundledNode := filepath.Join(root, "resources", "runtime", "bin", "node.exe")
	resultPath := filepath.Join(root, "result.json")

	if err := os.MkdirAll(cliDir, 0o700); err != nil {
		t.Fatal(err)
	}

	buildCmd := exec.Command("go", "build", "-o", exePath, ".")
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("go build teamhub.exe failed: %v\n%s", err, string(out))
	}

	// Keep the POSIX shim beside teamhub.exe (as Desktop ships) with no teamhub.cmd.
	writeFixtureFile(t, filepath.Join(cliDir, "teamhub"), []byte("#!/bin/sh\nexit 99\n"), 0o700)
	writeFixtureFile(t, entryPath, []byte("// fixture teamhub.js\n"), 0o600)
	buildFakeNodeFixture(t, bundledNode)

	t.Setenv("PATH", cliDir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("LINGER_TEST_RESULT_PATH", resultPath)

	wantBody := strings.Join([]string{
		"Summary heading",
		"",
		"- item one with 'quotes' & pipes | %TEMP% ^ <tag> > out",
		"- unicode: \u4f60\u597d",
		"```sh",
		"echo 'hello & world'",
		"```",
	}, "\n")

	psScript := strings.Join([]string{
		"$ErrorActionPreference = 'Stop'",
		"$resolved = (Get-Command teamhub -ErrorAction Stop).Source",
		"$body = \"Summary heading`n`n- item one with 'quotes' & pipes | %TEMP% ^ <tag> > out`n- unicode: \" + ([string][char]0x4F60) + ([string][char]0x597D) + \"`n``````sh`necho 'hello & world'`n``````\"",
		"teamhub message send --content $body",
		"if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
		"Write-Output $resolved",
	}, "\n")

	cmd := exec.Command(powershell, "-NoProfile", "-NonInteractive", "-Command", psScript)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("powershell invocation failed: %v\n%s", err, string(out))
	}

	resolvedSource := strings.TrimSpace(string(out))
	if resolved, evalErr := filepath.EvalSymlinks(resolvedSource); evalErr == nil {
		resolvedSource = resolved
	}
	if !strings.EqualFold(filepath.Clean(resolvedSource), filepath.Clean(exePath)) {
		t.Fatalf("Get-Command teamhub resolved to %q, want %q", resolvedSource, exePath)
	}

	raw, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatalf("failed to read captured argv: %v", err)
	}
	var captured struct {
		ExecArgv []string `json:"execArgv"`
		Entry    string   `json:"entry"`
		Args     []string `json:"args"`
	}
	if err := json.Unmarshal(raw, &captured); err != nil {
		t.Fatalf("failed to decode captured argv %q: %v", string(raw), err)
	}
	if !slices.Contains(captured.ExecArgv, "--use-env-proxy") {
		t.Fatalf("execArgv = %q, want --use-env-proxy", captured.ExecArgv)
	}
	if !strings.EqualFold(filepath.Clean(captured.Entry), filepath.Clean(entryPath)) {
		t.Fatalf("entry = %q, want %q", captured.Entry, entryPath)
	}
	wantArgv := []string{"message", "send", "--content", wantBody}
	if !slices.Equal(captured.Args, wantArgv) {
		t.Fatalf("argv mismatch:\n got: %q\nwant: %q", captured.Args, wantArgv)
	}
}
