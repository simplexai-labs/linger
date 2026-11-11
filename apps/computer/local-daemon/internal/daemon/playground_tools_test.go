package daemon

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/clicredential"
)

func openTestCardFile(t *testing.T, name string, content []byte, index int) openedCardFile {
	t.Helper()
	filename := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(filename, content, 0o600); err != nil {
		t.Fatal(err)
	}
	file, err := os.Open(filename)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = file.Close() })
	opened, err := prepareCardFile(file, int64(len(content)), index, playgroundCardFile{Path: "out/" + name, RepresentationFormat: "png", MediaType: "image/png"})
	if err != nil {
		t.Fatal(err)
	}
	return opened
}

func TestPlaygroundCardCommitsTheFilesAsTheAgent(t *testing.T) {
	image := bytes.Repeat([]byte{0x89, 'P', 'N', 'G'}, 300_000)
	var metadata map[string]any
	parts := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/agent/v1/messages/commit" || request.Header.Get("Authorization") != "Bearer token-1" ||
			request.Header.Get("X-TeamHub-Expected-Agent-Id") != "agent-1" || request.Header.Get("X-TeamHub-Operation-Id") != "voice-call-1" {
			http.Error(writer, `{"error":{"code":"FORBIDDEN"}}`, http.StatusForbidden)
			return
		}
		reader, err := request.MultipartReader()
		if err != nil {
			t.Error(err)
			return
		}
		for {
			part, err := reader.NextPart()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				t.Error(err)
				return
			}
			data, _ := io.ReadAll(part)
			if part.FormName() == "metadata" {
				_ = json.Unmarshal(data, &metadata)
				continue
			}
			parts[part.FileName()] = data
		}
		_, _ = writer.Write([]byte(`{"accepted":true,"target":{"type":"room","id":"room-1"},"inbox_id":"room:room-1","message_id":"message-1","duplicate_request":false,"resources":[{"kind":"document","segment_index":1,"status":"published","document_id":"document-1","name":"cartoon.png"}]}`))
	}))
	defer server.Close()
	card := playgroundCard{OperationID: "voice-call-1", InboxID: "room:room-1", Title: "Cartoon", Content: "The drawing is done."}
	result, err := commitCard(t.Context(), clicredential.Profile{URL: server.URL, TenantID: "tenant-1", AgentID: "agent-1"}, "token-1", card,
		[]openedCardFile{openTestCardFile(t, "cartoon.png", image, 0)})
	if err != nil {
		t.Fatal(err)
	}
	documents := result["documents"].([]map[string]any)
	if result["message_id"] != "message-1" || len(documents) != 1 || documents[0]["document_id"] != "document-1" || documents[0]["filename"] != "cartoon.png" {
		t.Fatalf("result=%v", result)
	}
	if !bytes.Equal(parts["upload_0"], image) {
		t.Fatalf("uploaded %d bytes, want the whole %d byte file", len(parts["upload_0"]), len(image))
	}
	sum := sha256.Sum256(image)
	invocation := sha256.Sum256([]byte("voice-call-1"))
	uploads := metadata["uploads"].([]any)
	upload := uploads[0].(map[string]any)
	if metadata["invocation_id"] != "agent-invocation-sha256:"+hex.EncodeToString(invocation[:]) || metadata["inbox_id"] != "room:room-1" ||
		metadata["card_title"] != "Cartoon" || upload["filename"] != "cartoon.png" || upload["sha256"] != hex.EncodeToString(sum[:]) ||
		upload["size_bytes"] != float64(len(image)) || upload["media_type"] != "image/png" || upload["representation_format"] != "png" {
		t.Fatalf("metadata=%v", metadata)
	}
	segments := metadata["segments"].([]any)
	if len(segments) != 2 || segments[0].(map[string]any)["content"] != "The drawing is done." || segments[1].(map[string]any)["upload_id"] != "upload_0" {
		t.Fatalf("segments=%v", segments)
	}
}

func TestPlaygroundCardReportsARefusedCommit(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		writer.WriteHeader(http.StatusForbidden)
		_, _ = writer.Write([]byte(`{"error":{"code":"OPERATION_NOT_PERMITTED","message":"no","request_id":"r"}}`))
	}))
	defer server.Close()
	card := playgroundCard{OperationID: "voice-call-2", InboxID: "room:room-1", Title: "Cartoon", Content: "Done."}
	_, err := commitCard(t.Context(), clicredential.Profile{URL: server.URL, TenantID: "tenant-1", AgentID: "agent-1"}, "token-1", card,
		[]openedCardFile{openTestCardFile(t, "cartoon.png", []byte("png"), 0)})
	var failure *playgroundFailure
	if !errors.As(err, &failure) || failure.code != "upload_failed" || !strings.Contains(failure.detail, "403 OPERATION_NOT_PERMITTED") {
		t.Fatalf("err=%v", err)
	}
}

func TestPlaygroundCardRefusesAnInvalidCardOrMissingCredential(t *testing.T) {
	daemon := &Daemon{}
	for _, card := range []playgroundCard{
		{OperationID: "op", InboxID: "room:room-1", Title: "Two\nlines", Content: "x"},
		{OperationID: "op", InboxID: "task:task-1", Title: "Title", Content: "x"},
		{OperationID: "op", InboxID: "room:room-1", Title: "Title", Content: " "},
		{OperationID: "op", InboxID: "room:room-1", Title: "Title", Content: "x", Files: make([]playgroundCardFile, 6)},
	} {
		var failure *playgroundFailure
		if _, err := daemon.sendPlaygroundCard(t.Context(), "tenant-1", "agent-1", card); !errors.As(err, &failure) || failure.code != "invalid_card" {
			t.Fatalf("card %+v = %v", card, err)
		}
	}
	var failure *playgroundFailure
	if _, _, err := daemon.agentCLICredential("tenant-1", "agent-1"); !errors.As(err, &failure) || failure.code != "agent_unavailable" {
		t.Fatalf("credential = %v", err)
	}
}
