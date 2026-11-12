package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
)

// maxCardFiles is how many files one card carries.
const maxCardFiles = 5

// playgroundFailure is a result TeamHub tells the live model as an error code.
type playgroundFailure struct{ code, detail string }

func (f *playgroundFailure) Error() string { return f.code + ": " + f.detail }

type playgroundRequest struct {
	Folder lingercontext.PlaygroundFolder `json:"folder"`
	Path   string                         `json:"path"`
	Offset int64                          `json:"offset"`
	Limit  int64                          `json:"limit"`
}

type playgroundCardFile struct {
	Folder lingercontext.PlaygroundFolder `json:"folder"`
	Path   string                         `json:"path"`
}

type playgroundCard struct {
	OperationID string               `json:"operation_id"`
	InboxID     string               `json:"inbox_id"`
	Title       string               `json:"title"`
	Content     string               `json:"content"`
	Files       []playgroundCardFile `json:"files"`
}

// callPlayground runs one live voice file action for the command's Agent.
func (d *Daemon) callPlayground(ctx context.Context, tenantID, agentID, name string, arguments json.RawMessage) (map[string]any, error) {
	if d.contextViews == nil {
		return map[string]any{"status": "unavailable"}, nil
	}
	var (
		result map[string]any
		err    error
	)
	switch name {
	case "list", "read":
		var request playgroundRequest
		if !decodes(arguments, &request) {
			return map[string]any{"status": "invalid_file_path"}, nil
		}
		if name == "list" {
			result, err = d.contextViews.ListPlayground(ctx, tenantID, agentID, request.Folder, request.Path)
		} else {
			result, err = d.contextViews.ReadPlayground(ctx, tenantID, agentID, request.Folder, request.Path, request.Offset, request.Limit)
		}
	case "send_card":
		var card playgroundCard
		if !decodes(arguments, &card) {
			return map[string]any{"status": "invalid_card"}, nil
		}
		result, err = d.sendPlaygroundCard(ctx, tenantID, agentID, card)
	default:
		return map[string]any{"status": "unavailable"}, nil
	}
	var failure *playgroundFailure
	switch {
	case err == nil:
		return result, nil
	case errors.As(err, &failure):
		return map[string]any{"status": failure.code, "detail": failure.detail}, nil
	case errors.Is(err, lingercontext.ErrPlaygroundFolder), errors.Is(err, lingercontext.ErrSharedTaskPathConflict):
		return map[string]any{"status": "not_allowed"}, nil
	case errors.Is(err, lingercontext.ErrPlaygroundPath):
		return map[string]any{"status": "invalid_file_path"}, nil
	case errors.Is(err, fs.ErrNotExist):
		return map[string]any{"status": "file_not_found"}, nil
	case errors.Is(err, lingercontext.ErrPlaygroundNotFolder):
		return map[string]any{"status": "not_a_folder"}, nil
	case errors.Is(err, lingercontext.ErrPlaygroundNotFile):
		return map[string]any{"status": "not_a_file"}, nil
	}
	return nil, err
}

// decodes reports whether arguments decode into target; a malformed call is
// told to the live model as a status, not failed.
func decodes(arguments json.RawMessage, target any) bool {
	return json.Unmarshal(arguments, target) == nil
}

// sendPlaygroundCard posts a card with files where the Agent wrote them by
// running `teamhub message card --attach` as the Agent, so a card from the
// live voice is the one a Meta posts, Markdown images included. The
// operation ID makes a repeated call the same message.
func (d *Daemon) sendPlaygroundCard(ctx context.Context, tenantID, agentID string, card playgroundCard) (map[string]any, error) {
	roomID, isRoom := strings.CutPrefix(card.InboxID, "room:")
	if card.OperationID == "" || !isRoom || roomID == "" || strings.TrimSpace(card.Title) == "" ||
		strings.TrimSpace(card.Content) == "" || len(card.Files) > maxCardFiles {
		return nil, &playgroundFailure{"invalid_card", "A card needs a title, content and at most 5 files."}
	}
	// The body goes on stdin: the CLI decodes escapes such as \n in --content,
	// which the live model does not write for it.
	arguments := []string{"message", "card", "--title", card.Title, "--file", "-"}
	for _, requested := range card.Files {
		filename, err := d.contextViews.PlaygroundFilePath(ctx, tenantID, agentID, requested.Folder, requested.Path)
		if err != nil {
			return nil, err
		}
		arguments = append(arguments, "--attach", filename)
	}
	arguments = append(arguments, "--operation-id", card.OperationID, "--json")
	installation, err := d.agentCLICredential(tenantID, agentID)
	if err != nil {
		return nil, err
	}
	return d.runCardCLI(ctx, installation, roomID, arguments, card.Content)
}

// runCardCLI runs the bundled CLI with a profile of its own that targets the
// card's Room. The credential stays in its file; the CLI reads it.
func (d *Daemon) runCardCLI(ctx context.Context, installation clicredential.Installation, roomID string, arguments []string, body string) (map[string]any, error) {
	program, prefix, environment, ok := cardCLIProgram(d.teamhubCLIBin, runtime.GOOS)
	if !ok {
		return nil, &playgroundFailure{"cli_unavailable", "This Computer has no TeamHub CLI; update the Computer."}
	}
	home, err := os.MkdirTemp("", "linger-live-card-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(home)
	config, err := json.Marshal(map[string]any{"version": 1, "default_profile": "live", "profiles": map[string]any{"live": map[string]any{
		"url": installation.Profile.URL, "token_file": installation.CredentialPath,
		"tenant_id": installation.Profile.TenantID, "agent_id": installation.Profile.AgentID,
		"scope": map[string]string{"kind": "room", "id": roomID},
	}}})
	if err != nil {
		return nil, err
	}
	configPath := filepath.Join(home, "config.json")
	if err := os.WriteFile(configPath, config, 0o600); err != nil {
		return nil, err
	}
	command := exec.CommandContext(ctx, program, append(prefix, arguments...)...)
	command.Dir = home
	command.Env = append(append(cardCLIEnvironment(os.Environ()), environment...), "TEAMHUB_CONFIG="+configPath, "TEAMHUB_PROFILE=live")
	command.Stdin = strings.NewReader(body)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	runErr := command.Run()
	if ctx.Err() != nil {
		return nil, &playgroundFailure{"outcome_unknown", "The card may have been posted; check the chat before trying again."}
	}
	if runErr != nil {
		var exit *exec.ExitError
		if !errors.As(runErr, &exit) {
			// The CLI never started, so nothing was posted.
			return nil, &playgroundFailure{"cli_unavailable", "The TeamHub CLI could not start: " + runErr.Error()}
		}
		return nil, cardCLIFailure(stderr.Bytes())
	}
	return cardCommitResult(stdout.Bytes())
}

// cardCLIProgram is how to start the bundled CLI in directory. The Computer
// bundle has a teamhub program on every platform. Desktop has only scripts on
// Windows; its teamhub.cmd is not run, since cmd.exe would parse the card's
// text, so the app it names runs teamhub.js as Node instead.
func cardCLIProgram(directory, goos string) (program string, prefix, environment []string, ok bool) {
	if directory == "" {
		return "", nil, nil, false
	}
	if goos != "windows" {
		program = filepath.Join(directory, "teamhub")
		return program, nil, nil, regularFile(program)
	}
	if program = filepath.Join(directory, "teamhub.exe"); regularFile(program) {
		return program, nil, nil, true
	}
	script := filepath.Join(directory, "teamhub.js")
	// The same relative app path teamhub.cmd names; apps/desktop/build.mjs
	// writes both.
	app := filepath.Join(directory, "..", "..", "..", "..", "Linger.exe")
	if !regularFile(script) || !regularFile(app) {
		return "", nil, nil, false
	}
	return filepath.Clean(app), []string{"--use-env-proxy", script}, []string{"ELECTRON_RUN_AS_NODE=1"}, true
}

func regularFile(name string) bool {
	info, err := os.Stat(name)
	return err == nil && info.Mode().IsRegular()
}

// cardCLIEnvironment is the daemon's environment without TeamHub settings,
// so only the card's own profile applies; proxies still reach the CLI.
func cardCLIEnvironment(environment []string) []string {
	kept := make([]string, 0, len(environment))
	for _, entry := range environment {
		if !strings.HasPrefix(strings.ToUpper(entry), "TEAMHUB_") {
			kept = append(kept, entry)
		}
	}
	return kept
}

// cardCLIFailure tells the live model why the CLI did not post the card. A
// failure whose outcome the CLI could not know is never reported as refused.
func cardCLIFailure(stderr []byte) error {
	var envelope struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(bytes.TrimSpace(stderr), &envelope)
	switch envelope.Error.Code {
	case "", "connection_failed", "timeout", "outcome_unknown", "external_outcome_unknown":
		return &playgroundFailure{"outcome_unknown", "The card may have been posted; check the chat before trying again."}
	}
	return &playgroundFailure{"upload_failed", strings.TrimSpace(envelope.Error.Code + ": " + envelope.Error.Message)}
}

// cardCommitResult is the posted card's message and the Documents its files
// became, in file order.
func cardCommitResult(stdout []byte) (map[string]any, error) {
	var committed struct {
		MessageID string `json:"message_id"`
		Resources []struct {
			Kind       string `json:"kind"`
			DocumentID string `json:"document_id"`
			Name       string `json:"name"`
		} `json:"resources"`
	}
	if json.Unmarshal(bytes.TrimSpace(stdout), &committed) != nil || committed.MessageID == "" {
		return nil, &playgroundFailure{"outcome_unknown", "The CLI's answer could not be read; check the chat before trying again."}
	}
	documents := make([]map[string]any, 0, len(committed.Resources))
	for _, resource := range committed.Resources {
		if resource.Kind == "document" {
			documents = append(documents, map[string]any{"document_id": resource.DocumentID, "filename": resource.Name})
		}
	}
	return map[string]any{"message_id": committed.MessageID, "documents": documents}, nil
}

// agentCLICredential is the TeamHub CLI profile and credential file the
// Agent Service pushed to this Computer for the Agent.
func (d *Daemon) agentCLICredential(tenantID, agentID string) (clicredential.Installation, error) {
	if d.cliCredentials == nil {
		return clicredential.Installation{}, &playgroundFailure{"agent_unavailable", "This Computer holds no TeamHub credential for the Agent."}
	}
	installation, err := d.cliCredentials.Lookup(tenantID, agentID)
	if errors.Is(err, clicredential.ErrNotInstalled) {
		return clicredential.Installation{}, &playgroundFailure{"agent_unavailable", "This Computer holds no TeamHub credential for the Agent."}
	}
	return installation, err
}
