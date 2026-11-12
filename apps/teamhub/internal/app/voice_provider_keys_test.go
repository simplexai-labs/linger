package app

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/secretbox"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

const testVoiceKey = "sk-voice-provider-secret-1234"

type memoryVoiceKeys struct {
	mu   sync.Mutex
	rows map[string][]byte
}

func (m *memoryVoiceKeys) GetVoiceProviderKey(_ context.Context, provider string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if sealed, ok := m.rows[provider]; ok {
		return sealed, nil
	}
	return nil, pgx.ErrNoRows
}

func (m *memoryVoiceKeys) UpsertVoiceProviderKey(_ context.Context, arg store.UpsertVoiceProviderKeyParams) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.rows == nil {
		m.rows = map[string][]byte{}
	}
	m.rows[arg.Provider] = arg.ApiKeyCiphertext
	return nil
}

type voiceKeyCheck func(context.Context, voicekey.Provider, string) error

func (f voiceKeyCheck) Check(ctx context.Context, provider voicekey.Provider, key string) error {
	return f(ctx, provider, key)
}

// syncBuffer collects log lines written from the background notify.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func newVoiceKeyTestApp(t *testing.T, cfg voicekey.Config, check voiceKeyCheck) (*App, *syncBuffer) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	if check == nil {
		check = func(context.Context, voicekey.Provider, string) error { return nil }
	}
	a := &App{
		cfg:    config.ForTest(func(c *config.Config) { c.Voice.RuntimeToken = "voice-token" }),
		logger: logger, voiceMedia: voicemedia.New(nil, nil, nil),
		voiceKeys: voicekey.New(&memoryVoiceKeys{}, check, cfg, logger),
	}
	return a, logs
}

func testSecretBox(t *testing.T) *secretbox.Box {
	t.Helper()
	box, err := secretbox.New(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{3}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	return box
}

func putVoiceKey(a *App, provider, body string) *httptest.ResponseRecorder {
	engine := gin.New()
	engine.PUT("/v0/voice-provider-keys/:provider", func(c *gin.Context) {
		c.Set("request_id", "request-voice-key")
		a.saveVoiceProviderKey(c)
	})
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, httptest.NewRequest(http.MethodPut, "/v0/voice-provider-keys/"+provider, strings.NewReader(body)))
	return response
}

// A save answers with the new status, wakes Node Services once in the
// background, and a failed wake only logs; the key appears in neither the
// response nor the logs.
func TestSaveVoiceProviderKeyNotifiesNodeServicesBestEffort(t *testing.T) {
	a, logs := newVoiceKeyTestApp(t, voicekey.Config{Enabled: true, Box: testSecretBox(t)}, nil)
	notified := make(chan struct{}, 1)
	a.reconcileVoiceWorkers = func(ctx context.Context) error {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("the reconcile notify has no deadline")
		}
		notified <- struct{}{}
		return errors.New("connection refused")
	}
	response := putVoiceKey(a, "soniox", `{"api_key":"  `+testVoiceKey+`  "}`)
	if response.Code != http.StatusOK || response.Body.String() != `{"can_save":true,"source":"stored"}` {
		t.Fatalf("save = %d %s", response.Code, response.Body)
	}
	select {
	case <-notified:
	case <-time.After(30 * time.Second):
		t.Fatal("Node Services was not notified")
	}
	deadline := time.Now().Add(30 * time.Second)
	for !strings.Contains(logs.String(), "voice.reconcile_notify_failed") {
		if time.Now().After(deadline) {
			t.Fatalf("no notify failure log: %s", logs.String())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if key, _ := a.voiceKeys.Effective(t.Context(), voicekey.Soniox); key != testVoiceKey {
		t.Fatalf("effective key = %q", key)
	}
	if strings.Contains(response.Body.String(), testVoiceKey) || strings.Contains(logs.String(), testVoiceKey) {
		t.Fatal("the key leaked into the response or the logs")
	}
}

func TestSaveVoiceProviderKeyErrors(t *testing.T) {
	rejected := func(context.Context, voicekey.Provider, string) error { return voicekey.ErrRejected }
	unreachable := func(context.Context, voicekey.Provider, string) error { return voicekey.ErrProviderUnavailable }
	box := testSecretBox(t)
	for _, tc := range []struct {
		name, provider, body string
		cfg                  voicekey.Config
		check                voiceKeyCheck
		status               int
		code                 string
	}{
		{"unknown provider", "openai", `{"api_key":"` + testVoiceKey + `"}`, voicekey.Config{Enabled: true, Box: box}, nil, http.StatusBadRequest, "INVALID_REQUEST"},
		{"malformed body", "soniox", `{"key":"` + testVoiceKey + `"}`, voicekey.Config{Enabled: true, Box: box}, nil, http.StatusBadRequest, "INVALID_REQUEST"},
		{"blank key", "soniox", `{"api_key":"   "}`, voicekey.Config{Enabled: true, Box: box}, nil, http.StatusBadRequest, "INVALID_REQUEST"},
		{"rejected", "soniox", `{"api_key":"` + testVoiceKey + `"}`, voicekey.Config{Enabled: true, Box: box}, rejected, http.StatusBadRequest, "VOICE_KEY_REJECTED"},
		{"unreachable", "xai", `{"api_key":"` + testVoiceKey + `"}`, voicekey.Config{Enabled: true, Box: box}, unreachable, http.StatusServiceUnavailable, "VOICE_PROVIDER_UNAVAILABLE"},
		{"environment", "xai", `{"api_key":"` + testVoiceKey + `"}`, voicekey.Config{Enabled: true, Box: box, Environment: map[voicekey.Provider]string{voicekey.XAI: "env-key"}}, nil, http.StatusConflict, "VOICE_KEY_FROM_ENVIRONMENT"},
		{"no encryption key", "soniox", `{"api_key":"` + testVoiceKey + `"}`, voicekey.Config{Enabled: true}, nil, http.StatusServiceUnavailable, "VOICE_KEY_STORAGE_UNAVAILABLE"},
		{"voice off", "soniox", `{"api_key":"` + testVoiceKey + `"}`, voicekey.Config{Box: box}, nil, http.StatusServiceUnavailable, "VOICE_MEDIA_OFF"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, logs := newVoiceKeyTestApp(t, tc.cfg, tc.check)
			a.reconcileVoiceWorkers = func(context.Context) error {
				t.Error("a refused save notified Node Services")
				return nil
			}
			response := putVoiceKey(a, tc.provider, tc.body)
			if response.Code != tc.status || !strings.Contains(response.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("save = %d %s", response.Code, response.Body)
			}
			if strings.Contains(response.Body.String(), testVoiceKey) || strings.Contains(logs.String(), testVoiceKey) {
				t.Fatal("the key leaked into the response or the logs")
			}
		})
	}
}

func getRuntimeVoiceKeys(a *App, authorization string) *httptest.ResponseRecorder {
	engine := gin.New()
	a.registerContractRoutes(engine)
	request := httptest.NewRequest(http.MethodGet, "/internal/v1/voice/provider-keys", nil)
	if authorization != "" {
		request.Header.Set("Authorization", authorization)
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}

func TestGetVoiceProviderKeysReturnsEffectiveKeysToTheVoiceRuntime(t *testing.T) {
	a, _ := newVoiceKeyTestApp(t, voicekey.Config{
		Enabled: true, Box: testSecretBox(t), Environment: map[voicekey.Provider]string{voicekey.XAI: "xai-env-key"},
	}, nil)
	for _, authorization := range []string{"", "Bearer wrong-token"} {
		if response := getRuntimeVoiceKeys(a, authorization); response.Code != http.StatusUnauthorized || strings.Contains(response.Body.String(), "xai-env-key") {
			t.Fatalf("auth %q = %d %s", authorization, response.Code, response.Body)
		}
	}
	response := getRuntimeVoiceKeys(a, "Bearer voice-token")
	if response.Code != http.StatusOK || response.Body.String() != `{"xai_api_key":"xai-env-key"}` || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("keys = %d %s cache=%q", response.Code, response.Body, response.Header().Get("Cache-Control"))
	}
	if err := a.voiceKeys.Save(t.Context(), voicekey.Soniox, testVoiceKey); err != nil {
		t.Fatal(err)
	}
	response = getRuntimeVoiceKeys(a, "Bearer voice-token")
	if response.Code != http.StatusOK || response.Body.String() != `{"soniox_api_key":"`+testVoiceKey+`","xai_api_key":"xai-env-key"}` {
		t.Fatalf("keys after save = %d %s", response.Code, response.Body)
	}
}

// With voice media off the read still answers, without any key, so Node
// Services stops its voice workers instead of retrying a missing route.
func TestGetVoiceProviderKeysWithVoiceOff(t *testing.T) {
	a, _ := newVoiceKeyTestApp(t, voicekey.Config{
		Box: testSecretBox(t), Environment: map[voicekey.Provider]string{voicekey.Soniox: "soniox-env-key", voicekey.XAI: "xai-env-key"},
	}, nil)
	a.voiceMedia = nil
	response := getRuntimeVoiceKeys(a, "Bearer voice-token")
	if response.Code != http.StatusOK || response.Body.String() != `{}` || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("keys = %d %s", response.Code, response.Body)
	}
}
