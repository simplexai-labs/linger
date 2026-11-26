package daemon

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/platform/privatefs"
	localworkspace "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/workspace"
)

// fakeCardCLI installs a teamhub program that records how it was run and
// answers with stdout, stderr and an exit code.
func fakeCardCLI(t *testing.T, stdout, stderr string, exit int) (directory, record string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI is a shell script")
	}
	directory = t.TempDir()
	record = filepath.Join(t.TempDir(), "record")
	script := "#!/bin/sh\n" +
		"{ printf '%s\\n' \"$@\"; echo ---; echo \"$TEAMHUB_PROFILE\"; cat \"$TEAMHUB_CONFIG\"; echo; echo ---; env | grep -c '^TEAMHUB_SECRET=' ; echo ---; cat; } > '" + record + "'\n" +
		"printf '%s' '" + stdout + "'\nprintf '%s' '" + stderr + "' >&2\nexit " + string(rune('0'+exit)) + "\n"
	if err := os.WriteFile(filepath.Join(directory, "teamhub"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return directory, record
}

var cardInstallation = clicredential.Installation{CredentialPath: "/state/agent-1/token", Profile: clicredential.Profile{URL: "https://teamhub.example", TenantID: "tenant-1", AgentID: "agent-1"}}

func TestPlaygroundCardRunsTheCLIAsTheAgentInTheRoom(t *testing.T) {
	t.Setenv("TEAMHUB_SECRET", "from-the-daemon")
	directory, record := fakeCardCLI(t, `{"accepted":true,"message_id":"message-1","resources":[{"kind":"document","segment_index":1,"status":"published","document_id":"document-1","name":"report.md"}]}`, "", 0)
	daemon := &Daemon{teamhubCLIBin: directory}
	stdout, err := daemon.runAgentCLI(t.Context(), cardInstallation, "room-1",
		[]string{"message", "card", "--title", "Report", "--file", "-", "--attach", "/work/playground/task-1/report.md", "--operation-id", "voice-live:abc", "--json"},
		`Saved to C:\new\table.xlsx`)
	if err != nil {
		t.Fatal(err)
	}
	result, err := cardCommitResult(stdout)
	if err != nil {
		t.Fatal(err)
	}
	documents := result["documents"].([]map[string]any)
	if result["message_id"] != "message-1" || len(documents) != 1 || documents[0]["document_id"] != "document-1" || documents[0]["filename"] != "report.md" {
		t.Fatalf("result=%v", result)
	}
	recorded, err := os.ReadFile(record)
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(string(recorded), "---\n")
	if !strings.Contains(parts[0], "--attach\n/work/playground/task-1/report.md\n--operation-id\nvoice-live:abc\n--json\n") {
		t.Fatalf("argv=%q", parts[0])
	}
	profile, config, _ := strings.Cut(parts[1], "\n")
	var parsed struct {
		Profiles map[string]map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(config), &parsed); err != nil {
		t.Fatal(err)
	}
	live := parsed.Profiles["live"]
	if profile != "live" || live["token_file"] != "/state/agent-1/token" || live["agent_id"] != "agent-1" || live["url"] != "https://teamhub.example" ||
		live["scope"].(map[string]any)["id"] != "room-1" || live["scope"].(map[string]any)["kind"] != "room" {
		t.Fatalf("profile=%s config=%s", profile, config)
	}
	if strings.TrimSpace(parts[2]) != "0" {
		t.Fatal("the daemon's own TeamHub settings reached the CLI")
	}
	if parts[3] != `Saved to C:\new\table.xlsx` {
		t.Fatalf("stdin body=%q", parts[3])
	}
}

func TestPlaygroundCardTellsWhyTheCLIFailed(t *testing.T) {
	for stderr, want := range map[string]string{
		`{"error":{"code":"invalid_input","message":"A resource exceeds 50 MiB."}}`: "upload_failed",
		`{"error":{"code":"connection_failed","message":"no route"}}`:               "outcome_unknown",
		`not json`: "outcome_unknown",
	} {
		directory, _ := fakeCardCLI(t, "", stderr, 2)
		_, err := (&Daemon{teamhubCLIBin: directory}).runAgentCLI(t.Context(), cardInstallation, "room-1", []string{"message", "card"}, "Done.")
		var failure *playgroundFailure
		if !errors.As(err, &failure) || failure.code != want {
			t.Fatalf("%s: err=%v, want %s", stderr, err, want)
		}
		if want == "upload_failed" && !strings.Contains(failure.detail, "exceeds 50 MiB") {
			t.Fatalf("detail=%q", failure.detail)
		}
	}
	var failure *playgroundFailure
	if _, err := (&Daemon{}).runAgentCLI(t.Context(), cardInstallation, "room-1", nil, ""); !errors.As(err, &failure) || failure.code != "cli_unavailable" {
		t.Fatalf("no CLI = %v", err)
	}
}

func TestPlaygroundCardRefusesAnInvalidCardOrMissingCredential(t *testing.T) {
	daemon := &Daemon{}
	for _, card := range []playgroundCard{
		{OperationID: "op", InboxID: "task:task-1", Title: "Title", Content: "x"},
		{OperationID: "op", InboxID: "room:room-1", Title: " ", Content: "x"},
		{OperationID: "op", InboxID: "room:room-1", Title: "Title", Content: " "},
		{OperationID: "op", InboxID: "room:room-1", Title: "Title", Content: "x", Files: make([]playgroundCardFile, 6)},
	} {
		var failure *playgroundFailure
		if _, err := daemon.sendPlaygroundCard(t.Context(), "tenant-1", "agent-1", card); !errors.As(err, &failure) || failure.code != "invalid_card" {
			t.Fatalf("card %+v = %v", card, err)
		}
	}
	var failure *playgroundFailure
	if _, err := daemon.agentCLICredential("tenant-1", "agent-1"); !errors.As(err, &failure) || failure.code != "agent_unavailable" {
		t.Fatalf("credential = %v", err)
	}
}

// Both the Computer bundle and Desktop ship teamhub.exe on Windows and teamhub
// on other platforms; cmd.exe batch wrappers are never invoked.
func TestPlaygroundCardFindsTheCLIOnEveryLayout(t *testing.T) {
	touch := func(name string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(name), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(name, nil, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	windowsDir := t.TempDir()
	touch(filepath.Join(windowsDir, "teamhub.exe"))
	if program, ok := cardCLIProgram(windowsDir, "windows"); !ok || program != filepath.Join(windowsDir, "teamhub.exe") {
		t.Fatalf("Windows CLI: %s %v", program, ok)
	}
	cmdOnly := t.TempDir()
	touch(filepath.Join(cmdOnly, "teamhub.cmd"))
	touch(filepath.Join(cmdOnly, "teamhub.js"))
	if _, ok := cardCLIProgram(cmdOnly, "windows"); ok {
		t.Fatal("accepted teamhub.cmd without teamhub.exe")
	}
	posixDir := t.TempDir()
	touch(filepath.Join(posixDir, "teamhub"))
	if program, ok := cardCLIProgram(posixDir, "darwin"); !ok || program != filepath.Join(posixDir, "teamhub") {
		t.Fatalf("POSIX CLI: %s %v", program, ok)
	}
	if _, ok := cardCLIProgram(t.TempDir(), "darwin"); ok {
		t.Fatal("found a CLI in an empty directory")
	}
}

func TestPlaygroundImageRefusesAnIncompletePlacement(t *testing.T) {
	daemon := &Daemon{}
	for _, image := range []playgroundImage{
		{OperationID: "op", InboxID: "task:task-1", DocumentID: "document-1", AfterBlockID: "block-1"},
		{OperationID: "op", InboxID: "room:room-1", AfterBlockID: "block-1"},
		{OperationID: "op", InboxID: "room:room-1", DocumentID: "document-1"},
		{OperationID: "op", InboxID: "room:room-1", DocumentID: "document-1", AfterBlockID: "block-1", Caption: "two\nlines"},
	} {
		var failure *playgroundFailure
		if _, err := daemon.placePlaygroundImage(t.Context(), "tenant-1", "agent-1", image); !errors.As(err, &failure) || failure.code != "invalid_image" {
			t.Fatalf("image %+v = %v", image, err)
		}
	}
}

func TestPlaygroundAgentCLIConfigUsesDaemonOperationTempBase(t *testing.T) {
	stateDir := filepath.Join(t.TempDir(), "daemon-state")
	opTempBase := filepath.Join(stateDir, "operation-tmp")
	home, configPath, cleanup, err := prepareAgentCLIConfig(opTempBase, cardInstallation, "room-1")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(home, opTempBase+string(os.PathSeparator)) {
		cleanup()
		t.Fatalf("CLI config home %q is not under operation-tmp %q", home, opTempBase)
	}
	if err := privatefs.CheckPath(home, "directory", true); err != nil {
		cleanup()
		t.Fatalf("CLI config home not private: %v", err)
	}
	if err := privatefs.CheckPath(configPath, "file", true); err != nil {
		cleanup()
		t.Fatalf("CLI config.json not private: %v", err)
	}
	if removed, _, err := localworkspace.PruneOperationTemps(opTempBase, nil); err != nil || removed != 0 {
		cleanup()
		t.Fatalf("prune removed active CLI temp dir: removed=%d err=%v", removed, err)
	}
	cleanup()
	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Fatalf("CLI temp dir survived cleanup: %v", err)
	}

	if runtime.GOOS == "windows" {
		return
	}
	// Verify runAgentCLI places TEAMHUB_CONFIG inside stateDirectory/operation-tmp
	// and cleans it up when the CLI finishes.
	cliDir := t.TempDir()
	configPathRecord := filepath.Join(t.TempDir(), "config-path")
	script := "#!/bin/sh\nprintf '%s' \"$TEAMHUB_CONFIG\" > '" + configPathRecord + "'\nprintf '%s' '{\"accepted\":true,\"message_id\":\"m1\"}'\n"
	if err := os.WriteFile(filepath.Join(cliDir, "teamhub"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	d := &Daemon{stateDirectory: stateDir, teamhubCLIBin: cliDir}
	if _, err := d.runAgentCLI(t.Context(), cardInstallation, "room-1", []string{"message", "card"}, "body"); err != nil {
		t.Fatalf("runAgentCLI: %v", err)
	}
	recorded, err := os.ReadFile(configPathRecord)
	if err != nil {
		t.Fatal(err)
	}
	usedConfig := string(recorded)
	if !strings.HasPrefix(usedConfig, opTempBase+string(os.PathSeparator)) {
		t.Fatalf("runAgentCLI wrote TEAMHUB_CONFIG at %q, want under %q", usedConfig, opTempBase)
	}
	if _, err := os.Stat(filepath.Dir(usedConfig)); !os.IsNotExist(err) {
		t.Fatalf("runAgentCLI temp dir %q survived return: %v", filepath.Dir(usedConfig), err)
	}
}
