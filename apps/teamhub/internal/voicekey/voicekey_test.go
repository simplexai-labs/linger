package voicekey

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type memoryStore struct {
	mu   sync.Mutex
	rows map[string][]byte
}

func (m *memoryStore) GetVoiceProviderKey(_ context.Context, provider string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	sealed, ok := m.rows[provider]
	if !ok {
		return nil, pgx.ErrNoRows
	}
	return sealed, nil
}

func (m *memoryStore) UpsertVoiceProviderKey(_ context.Context, arg store.UpsertVoiceProviderKeyParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string][]byte{}
	}
	m.rows[arg.Provider] = arg.ApiKeyCiphertext
	return nil
}

type checkerFunc func(context.Context, Provider, string) error

func (f checkerFunc) Check(ctx context.Context, provider Provider, key string) error {
	return f(ctx, provider, key)
}

var accept = checkerFunc(func(context.Context, Provider, string) error { return nil })

func testBox(t *testing.T, fill byte) *secretbox.Box {
	t.Helper()
	box, err := secretbox.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{fill}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	return box
}

func TestSaveSealsAndResolvesTheStoredKey(t *testing.T) {
	keys := &memoryStore{}
	service := New(keys, accept, Config{Enabled: true, Box: testBox(t, 1)}, nil)
	if status, err := service.Status(t.Context(), Soniox); err != nil || status != (Status{Source: SourceNone, CanSave: true}) {
		t.Fatalf("status before save = %+v, %v", status, err)
	}
	for range 2 {
		if err := service.Save(t.Context(), Soniox, "  soniox-secret  "); err != nil {
			t.Fatal(err)
		}
	}
	if len(keys.rows) != 1 || bytes.Contains(keys.rows["soniox"], []byte("soniox-secret")) {
		t.Fatalf("rows = %d, sealed row holds the plaintext or is missing", len(keys.rows))
	}
	if key, err := service.Effective(t.Context(), Soniox); err != nil || key != "soniox-secret" {
		t.Fatalf("Effective = %q, %v", key, err)
	}
	if status, err := service.Status(t.Context(), Soniox); err != nil || status != (Status{Source: SourceStored, CanSave: true}) {
		t.Fatalf("status after save = %+v, %v", status, err)
	}
	if key, _ := service.Effective(t.Context(), XAI); key != "" {
		t.Fatal("saving Soniox resolved an xAI key")
	}
}

func TestEnvironmentKeyWinsOverAStoredKey(t *testing.T) {
	keys := &memoryStore{}
	box := testBox(t, 1)
	if err := New(keys, accept, Config{Enabled: true, Box: box}, nil).Save(t.Context(), XAI, "stored-key"); err != nil {
		t.Fatal(err)
	}
	service := New(keys, accept, Config{Enabled: true, Box: box, Environment: map[Provider]string{XAI: "environment-key"}}, nil)
	if key, _ := service.Effective(t.Context(), XAI); key != "environment-key" {
		t.Fatalf("Effective = %q, want the environment key", key)
	}
	if status, _ := service.Status(t.Context(), XAI); status != (Status{Source: SourceEnvironment}) {
		t.Fatalf("status = %+v", status)
	}
	if err := service.Save(t.Context(), XAI, "another-key"); !errors.Is(err, ErrFromEnvironment) {
		t.Fatalf("Save = %v, want ErrFromEnvironment", err)
	}
}

func TestSaveRefusals(t *testing.T) {
	rejecting := checkerFunc(func(context.Context, Provider, string) error { return ErrRejected })
	unreachable := checkerFunc(func(context.Context, Provider, string) error { return ErrProviderUnavailable })
	for _, tc := range []struct {
		name     string
		cfg      Config
		checker  Checker
		provider Provider
		key      string
		want     error
		canSave  bool
	}{
		{"empty key", Config{Enabled: true, Box: testBox(t, 1)}, accept, Soniox, "   ", ErrInvalid, true},
		{"long key", Config{Enabled: true, Box: testBox(t, 1)}, accept, Soniox, strings.Repeat("k", MaxKeyBytes+1), ErrInvalid, true},
		{"newline inside", Config{Enabled: true, Box: testBox(t, 1)}, accept, Soniox, "abc\ndef", ErrInvalid, true},
		{"space inside", Config{Enabled: true, Box: testBox(t, 1)}, accept, Soniox, "abc def", ErrInvalid, true},
		{"control character inside", Config{Enabled: true, Box: testBox(t, 1)}, accept, XAI, "abc\x00def", ErrInvalid, true},
		{"unknown provider", Config{Enabled: true, Box: testBox(t, 1)}, accept, "openai", "key", ErrInvalid, true},
		{"no encryption key", Config{Enabled: true}, accept, Soniox, "key", ErrStorageMissing, false},
		{"voice off", Config{Box: testBox(t, 1)}, accept, Soniox, "key", ErrVoiceOff, false},
		{"rejected", Config{Enabled: true, Box: testBox(t, 1)}, rejecting, Soniox, "key", ErrRejected, true},
		{"unreachable", Config{Enabled: true, Box: testBox(t, 1)}, unreachable, XAI, "key", ErrProviderUnavailable, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			keys := &memoryStore{}
			service := New(keys, tc.checker, tc.cfg, nil)
			if err := service.Save(t.Context(), tc.provider, tc.key); !errors.Is(err, tc.want) {
				t.Fatalf("Save = %v, want %v", err, tc.want)
			}
			if len(keys.rows) != 0 {
				t.Fatal("a refused save stored a row")
			}
			if status, _ := service.Status(t.Context(), Soniox); status.CanSave != tc.canSave {
				t.Fatalf("CanSave = %v, want %v", status.CanSave, tc.canSave)
			}
		})
	}
}

func TestVoiceOffResolvesNoKey(t *testing.T) {
	keys := &memoryStore{}
	box := testBox(t, 1)
	if err := New(keys, accept, Config{Enabled: true, Box: box}, nil).Save(t.Context(), Soniox, "stored-key"); err != nil {
		t.Fatal(err)
	}
	service := New(keys, accept, Config{Box: box, Environment: map[Provider]string{XAI: "environment-key"}}, nil)
	for _, provider := range []Provider{Soniox, XAI} {
		if key, _ := service.Effective(t.Context(), provider); key != "" {
			t.Fatalf("%s resolved a key with voice off", provider)
		}
		if status, _ := service.Status(t.Context(), provider); status != (Status{Source: SourceNone}) {
			t.Fatalf("%s status = %+v", provider, status)
		}
	}
}

// A key sealed under another encryption key reads as absent, so saving a new
// one repairs the deployment; the log names the provider and never the key.
func TestUnreadableStoredKeyIsAbsent(t *testing.T) {
	keys := &memoryStore{}
	if err := New(keys, accept, Config{Enabled: true, Box: testBox(t, 1)}, nil).Save(t.Context(), Soniox, "old-secret"); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	service := New(keys, accept, Config{Enabled: true, Box: testBox(t, 2)}, slog.New(slog.NewJSONHandler(&logs, nil)))
	for range 3 {
		if key, err := service.Effective(t.Context(), Soniox); err != nil || key != "" {
			t.Fatalf("Effective = %q, %v", key, err)
		}
	}
	if status, _ := service.Status(t.Context(), Soniox); status != (Status{Source: SourceNone, CanSave: true}) {
		t.Fatalf("status = %+v", status)
	}
	if strings.Count(logs.String(), "voice.provider_key_unreadable") != 1 || strings.Contains(logs.String(), "old-secret") {
		t.Fatalf("repeated reads must log once: %s", logs.String())
	}
	// Another unreadable row is a new fact and is logged again.
	if err := New(keys, accept, Config{Enabled: true, Box: testBox(t, 1)}, nil).Save(t.Context(), Soniox, "newer-secret"); err != nil {
		t.Fatal(err)
	}
	_, _ = service.Effective(t.Context(), Soniox)
	if strings.Count(logs.String(), "voice.provider_key_unreadable") != 2 {
		t.Fatalf("a new unreadable row was not logged: %s", logs.String())
	}
}

// Concurrent saves keep one row per provider; the last write wins.
func TestConcurrentSavesKeepOneRow(t *testing.T) {
	keys := &memoryStore{}
	service := New(keys, accept, Config{Enabled: true, Box: testBox(t, 1)}, nil)
	var wg sync.WaitGroup
	for _, key := range []string{"first-key", "second-key", "third-key"} {
		wg.Go(func() {
			if err := service.Save(context.Background(), Soniox, key); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
	key, _ := service.Effective(t.Context(), Soniox)
	if len(keys.rows) != 1 || (key != "first-key" && key != "second-key" && key != "third-key") {
		t.Fatalf("rows=%d key=%q", len(keys.rows), key)
	}
}
