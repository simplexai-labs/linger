package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
	lingercontext "github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/context"
)

const (
	// The Agent message commit route's limits: per file and per message.
	maxCardFileBytes  = 50 << 20
	maxCardTotalBytes = 512 << 20
	maxCardFiles      = 5
)

// playgroundCardClient posts cards to TeamHub; the Computer tool's deadline
// bounds each request, and a redirect is never followed with the credential.
var playgroundCardClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}}

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
	Folder               lingercontext.PlaygroundFolder `json:"folder"`
	Path                 string                         `json:"path"`
	RepresentationFormat string                         `json:"representation_format"`
	MediaType            string                         `json:"media_type"`
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

type openedCardFile struct {
	file     *os.File
	upload   map[string]any
	size     int64
	uploadID string
}

// sendPlaygroundCard reads the card's files where the Agent wrote them and
// commits the card through the Agent API, the request `teamhub message card
// --attach` sends. The operation ID makes a repeated call the same message.
func (d *Daemon) sendPlaygroundCard(ctx context.Context, tenantID, agentID string, card playgroundCard) (map[string]any, error) {
	title := strings.TrimSpace(card.Title)
	if card.OperationID == "" || !strings.HasPrefix(card.InboxID, "room:") || title == "" || title != card.Title ||
		len([]rune(title)) > 120 || strings.ContainsAny(title, "\r\n") || strings.TrimSpace(card.Content) == "" || len(card.Files) > maxCardFiles {
		return nil, &playgroundFailure{"invalid_card", "A card needs a one-line title, content and at most 5 files."}
	}
	files := make([]openedCardFile, 0, len(card.Files))
	defer func() {
		for _, opened := range files {
			_ = opened.file.Close()
		}
	}()
	var total int64
	for index, requested := range card.Files {
		file, info, err := d.contextViews.OpenPlaygroundFile(ctx, tenantID, agentID, requested.Folder, requested.Path)
		if err != nil {
			return nil, err
		}
		opened, err := prepareCardFile(file, info.Size(), index, requested)
		files = append(files, opened)
		if err != nil {
			return nil, err
		}
		if total += info.Size(); total > maxCardTotalBytes {
			return nil, &playgroundFailure{"files_too_large", "The files are over 512 MiB together."}
		}
	}
	profile, token, err := d.agentCLICredential(tenantID, agentID)
	if err != nil {
		return nil, err
	}
	return commitCard(ctx, profile, token, card, files)
}

// prepareCardFile hashes one opened file for its upload entry.
func prepareCardFile(file *os.File, size int64, index int, requested playgroundCardFile) (openedCardFile, error) {
	opened := openedCardFile{file: file, size: size, uploadID: "upload_" + strconv.Itoa(index)}
	if size > maxCardFileBytes {
		return opened, &playgroundFailure{"file_too_large", path.Base(requested.Path) + " is over 50 MiB."}
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return opened, err
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return opened, err
	}
	opened.upload = map[string]any{
		"upload_id": opened.uploadID, "filename": path.Base(requested.Path),
		"representation_format": requested.RepresentationFormat, "media_type": requested.MediaType,
		"size_bytes": size, "sha256": hex.EncodeToString(hash.Sum(nil)),
	}
	return opened, nil
}

// commitCard posts the card and its prepared files as the Agent.
func commitCard(ctx context.Context, profile clicredential.Profile, token string, card playgroundCard, files []openedCardFile) (map[string]any, error) {
	segments := []map[string]any{{"type": "text", "content": card.Content}}
	uploads := make([]map[string]any, 0, len(files))
	for _, opened := range files {
		segments = append(segments, map[string]any{"type": "document", "upload_id": opened.uploadID})
		uploads = append(uploads, opened.upload)
	}
	invocation := sha256.Sum256([]byte(card.OperationID))
	metadata, err := json.Marshal(map[string]any{
		"invocation_id": "agent-invocation-sha256:" + hex.EncodeToString(invocation[:]),
		"inbox_id":      card.InboxID, "card_title": card.Title, "segments": segments, "uploads": uploads,
	})
	if err != nil {
		return nil, err
	}
	body, writer := io.Pipe()
	form := multipart.NewWriter(writer)
	go func() {
		_ = writer.CloseWithError(writeCardForm(form, metadata, files))
	}()
	defer body.Close()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(profile.URL, "/")+"/api/agent/v1/messages/commit", body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", form.FormDataContentType())
	request.Header.Set("X-TeamHub-Expected-Tenant-Id", profile.TenantID)
	request.Header.Set("X-TeamHub-Expected-Agent-Id", profile.AgentID)
	request.Header.Set("X-TeamHub-Operation-Id", card.OperationID)
	response, err := playgroundCardClient.Do(request)
	if err != nil {
		// The request may have reached TeamHub; only the same operation may retry.
		return nil, &playgroundFailure{"outcome_unknown", "The card may have been posted; check the chat before trying again."}
	}
	defer response.Body.Close()
	return cardCommitResult(response)
}

func writeCardForm(form *multipart.Writer, metadata []byte, files []openedCardFile) error {
	if err := form.WriteField("metadata", string(metadata)); err != nil {
		return err
	}
	for _, opened := range files {
		part, err := form.CreateFormFile("file", opened.uploadID)
		if err != nil {
			return err
		}
		// A file that grew since it was hashed fails TeamHub's size check.
		if _, err := io.Copy(part, io.LimitReader(opened.file, opened.size+1)); err != nil {
			return err
		}
	}
	return form.Close()
}

// cardCommitResult is the posted card's message and the Documents its files
// became, in file order.
func cardCommitResult(response *http.Response) (map[string]any, error) {
	data, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return nil, &playgroundFailure{"outcome_unknown", "The card may have been posted; check the chat before trying again."}
	}
	if response.StatusCode != http.StatusOK {
		var envelope struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &envelope)
		return nil, &playgroundFailure{"upload_failed", strings.TrimSpace(fmt.Sprintf("TeamHub answered HTTP %d %s", response.StatusCode, envelope.Error.Code))}
	}
	var committed struct {
		MessageID string `json:"message_id"`
		Resources []struct {
			Kind         string `json:"kind"`
			SegmentIndex int    `json:"segment_index"`
			DocumentID   string `json:"document_id"`
			Name         string `json:"name"`
		} `json:"resources"`
	}
	if err := json.Unmarshal(data, &committed); err != nil || committed.MessageID == "" {
		return nil, &playgroundFailure{"outcome_unknown", "TeamHub's answer could not be read; check the chat before trying again."}
	}
	documents := make([]map[string]any, 0, len(committed.Resources))
	for _, resource := range committed.Resources {
		if resource.Kind == "document" {
			documents = append(documents, map[string]any{"document_id": resource.DocumentID, "filename": resource.Name})
		}
	}
	return map[string]any{"message_id": committed.MessageID, "documents": documents}, nil
}

// agentCLICredential is the TeamHub CLI profile and token the Agent Service
// pushed to this Computer for the Agent.
func (d *Daemon) agentCLICredential(tenantID, agentID string) (clicredential.Profile, string, error) {
	if d.cliCredentials == nil {
		return clicredential.Profile{}, "", &playgroundFailure{"agent_unavailable", "This Computer holds no TeamHub credential for the Agent."}
	}
	installation, err := d.cliCredentials.Lookup(tenantID, agentID)
	if errors.Is(err, clicredential.ErrNotInstalled) {
		return clicredential.Profile{}, "", &playgroundFailure{"agent_unavailable", "This Computer holds no TeamHub credential for the Agent."}
	}
	if err != nil {
		return clicredential.Profile{}, "", err
	}
	token, err := os.ReadFile(installation.CredentialPath)
	if err != nil {
		return clicredential.Profile{}, "", err
	}
	return installation.Profile, strings.TrimSpace(string(token)), nil
}
