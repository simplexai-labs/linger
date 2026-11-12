package voicetranscription

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// The keyed transcriber reads the key at each call: no key means no provider
// request at all, and a key saved later is used by the next block.
func TestKeyedSonioxTranscriberReadsTheKeyAtEachCall(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer saved-later" {
			t.Errorf("Authorization = %q", r.Header.Get("Authorization"))
		}
		switch r.URL.Path {
		case "/v1/files":
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "file-1"})
		case "/v1/transcriptions/tx-1/transcript":
			_ = json.NewEncoder(w).Encode(map[string]any{"text": "", "tokens": []any{}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "tx-1", "status": "completed"})
		}
	}))
	defer server.Close()
	var key atomic.Value
	key.Store("")
	transcriber := NewKeyedSonioxTranscriber(func(context.Context) (string, error) {
		return key.Load().(string), nil
	}, SonioxConfig{BaseURL: server.URL, HTTPClient: server.Client()})

	if ready, err := transcriber.Ready(t.Context()); ready || err != nil {
		t.Fatalf("Ready without a key = %v, %v", ready, err)
	}
	if _, err := transcriber.TranscribeArchivePCM(t.Context(), make([]byte, 3200)); !errors.Is(err, ErrProviderNotConfigured) {
		t.Fatalf("TranscribeArchivePCM without a key = %v", err)
	}
	if requests.Load() != 0 {
		t.Fatalf("%d Soniox requests without a key", requests.Load())
	}
	key.Store("saved-later")
	if ready, err := transcriber.Ready(t.Context()); !ready || err != nil {
		t.Fatalf("Ready after a key was saved = %v, %v", ready, err)
	}
	if _, err := transcriber.TranscribeArchivePCM(t.Context(), make([]byte, 3200)); err != nil {
		t.Fatal(err)
	}
	if requests.Load() == 0 {
		t.Fatal("no Soniox request with a key")
	}
}

func TestKeyedSonioxTranscriberKeyReadFailure(t *testing.T) {
	transcriber := NewKeyedSonioxTranscriber(func(context.Context) (string, error) {
		return "", errors.New("database unavailable")
	}, SonioxConfig{})
	// A failed read is an error, not "no key", so materialization retries.
	if ready, err := transcriber.Ready(t.Context()); ready || err == nil {
		t.Fatalf("Ready while the key cannot be read = %v, %v", ready, err)
	}
	if _, err := transcriber.TranscribeArchivePCM(t.Context(), make([]byte, 3200)); !errors.Is(err, ErrProviderFailure) {
		t.Fatalf("TranscribeArchivePCM = %v, want a retryable provider failure", err)
	}
}
