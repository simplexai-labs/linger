package integration_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/app"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

const voiceKeyRuntimeToken = "voice-key-runtime-token"

type voiceKeyChecker struct {
	mu   sync.Mutex
	seen []string
}

func (c *voiceKeyChecker) Check(_ context.Context, provider voicekey.Provider, key string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seen = append(c.seen, string(provider))
	if strings.HasPrefix(key, "rejected") {
		return voicekey.ErrRejected
	}
	return nil
}

func withVoiceKeyChecker(checker voicekey.Checker) appOption {
	return withDeps(func(deps *app.Deps) { deps.VoiceKeyChecker = checker })
}

// newVoiceKeyEnv runs voice over a fake LiveKit API with no environment key
// and a secret encryption key, so provider keys are saved in the product.
func newVoiceKeyEnv(t *testing.T, checker voicekey.Checker) (*testEnv, *http.Client) {
	t.Helper()
	providerAPI := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/protobuf")
		w.WriteHeader(http.StatusOK)
	}))
	registerIntegrationServerCleanup(t, providerAPI)
	media := &dictationTestMedia{}
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.Voice.SonioxAPIKey, cfg.Voice.XaiAPIKey = "", ""
		cfg.Voice.RuntimeToken = voiceKeyRuntimeToken
		cfg.ExternalApps.SecretEncryptionKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	}, withVoiceMedia(media), withVoiceKeyChecker(checker))
	provider, err := voicemedia.NewLiveKitProvider(voicemedia.LiveKitConfig{APIURL: providerAPI.URL, PublicURL: providerAPI.URL, APIKey: "test", APISecret: "test"}, env.pool)
	if err != nil {
		t.Fatal(err)
	}
	media.Plane = voicemedia.New(env.pool, provider, nil)
	return env, alice
}

func voiceMediaPolicy(t *testing.T, env *testEnv, client *http.Client) httpapi.VoiceMediaPolicy {
	t.Helper()
	status, _, body := env.request(client, http.MethodGet, "/v0/tenants/"+acmeTenant+"/voice-media-policy", nil, "")
	if status != http.StatusOK {
		t.Fatalf("voice media policy=%d %s", status, body)
	}
	var policy httpapi.VoiceMediaPolicy
	decode(t, body, &policy)
	return policy
}

func runtimeVoiceKeys(t *testing.T, env *testEnv) string {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, env.server.URL+"/internal/v1/voice/provider-keys", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+voiceKeyRuntimeToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var body bytes.Buffer
	if _, err := body.ReadFrom(response.Body); err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("runtime keys=%d cache=%q %s", response.StatusCode, response.Header.Get("Cache-Control"), body.String())
	}
	return strings.TrimSpace(body.String())
}

// Saving a key turns its voice feature on at once, without a restart: the
// policy, session creation and the Voice Runtime key read all follow the
// row. The row is sealed, a repeated save keeps one row, and the key is never
// echoed to the browser.
func TestVoiceProviderKeySaveTurnsVoiceOnWithoutRestart(t *testing.T) {
	allowParallelIntegrationTest(t)
	checker := &voiceKeyChecker{}
	env, alice := newVoiceKeyEnv(t, checker)
	roomID := env.createRoom(alice, acmeTenant, "Voice keys", "voice-keys-room")

	policy := voiceMediaPolicy(t, env, alice)
	if policy.VoiceAvailable == nil || !*policy.VoiceAvailable || policy.VoiceMediaSupported || *policy.LiveSupported ||
		policy.SonioxKey == nil || *policy.SonioxKey != (httpapi.VoiceProviderKeyStatus{Source: httpapi.None, CanSave: true}) {
		t.Fatalf("policy before save=%+v", policy)
	}
	if status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/voice-sessions", map[string]any{"purpose": "hardware_control"}, "recording-before-key"); status != http.StatusServiceUnavailable {
		t.Fatalf("recording without a key=%d %s", status, body)
	}
	if keys := runtimeVoiceKeys(t, env); keys != `{}` {
		t.Fatalf("runtime keys before save=%s", keys)
	}

	if status, _, body := env.request(alice, http.MethodPut, "/v0/voice-provider-keys/soniox", map[string]any{"api_key": "rejected-soniox-key"}, ""); status != http.StatusBadRequest || !strings.Contains(string(body), "VOICE_KEY_REJECTED") {
		t.Fatalf("rejected save=%d %s", status, body)
	}
	for range 2 {
		status, _, body := env.request(alice, http.MethodPut, "/v0/voice-provider-keys/soniox", map[string]any{"api_key": " soniox-product-key "}, "")
		if status != http.StatusOK || strings.Contains(string(body), "soniox-product-key") || strings.TrimSpace(string(body)) != `{"can_save":true,"source":"stored"}` {
			t.Fatalf("save=%d %s", status, body)
		}
	}
	var rows int
	var sealed []byte
	if err := env.pool.QueryRow(t.Context(), `SELECT count(*) OVER (), api_key_ciphertext FROM voice_provider_keys`).Scan(&rows, &sealed); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || bytes.Contains(sealed, []byte("soniox-product-key")) {
		t.Fatalf("rows=%d, sealed row holds the plaintext", rows)
	}

	policy = voiceMediaPolicy(t, env, alice)
	if !policy.VoiceMediaSupported || *policy.LiveSupported || *policy.SonioxKey != (httpapi.VoiceProviderKeyStatus{Source: httpapi.Stored, CanSave: true}) {
		t.Fatalf("policy after Soniox save=%+v", policy)
	}
	if status, _, body := env.request(alice, http.MethodPost, "/v0/rooms/"+roomID+"/voice-sessions", map[string]any{"purpose": "hardware_control"}, "recording-after-key"); status != http.StatusCreated {
		t.Fatalf("recording after save=%d %s", status, body)
	}
	if keys := runtimeVoiceKeys(t, env); keys != `{"soniox_api_key":"soniox-product-key"}` {
		t.Fatalf("runtime keys after save=%s", keys)
	}

	if status, _, body := env.request(alice, http.MethodPut, "/v0/voice-provider-keys/xai", map[string]any{"api_key": "xai-product-key"}, ""); status != http.StatusOK {
		t.Fatalf("xAI save=%d %s", status, body)
	}
	if policy = voiceMediaPolicy(t, env, alice); !*policy.LiveSupported || !*policy.LiveEnabled {
		t.Fatalf("policy after xAI save=%+v", policy)
	}
}

// Concurrent saves of one provider keep one row and the last write wins.
func TestVoiceProviderKeyConcurrentSavesKeepOneRow(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice := newVoiceKeyEnv(t, &voiceKeyChecker{})
	keys := []string{"xai-key-one", "xai-key-two", "xai-key-three", "xai-key-four"}
	var wg sync.WaitGroup
	for _, key := range keys {
		wg.Go(func() {
			if status, _, body := env.request(alice, http.MethodPut, "/v0/voice-provider-keys/xai", map[string]any{"api_key": key}, ""); status != http.StatusOK {
				t.Errorf("save %s=%d %s", key, status, body)
			}
		})
	}
	wg.Wait()
	if rows := countRows(t, env, `SELECT count(*) FROM voice_provider_keys WHERE provider='xai'`); rows != 1 {
		t.Fatalf("rows=%d", rows)
	}
	got := runtimeVoiceKeys(t, env)
	found := false
	for _, key := range keys {
		found = found || got == `{"xai_api_key":"`+key+`"}`
	}
	if !found {
		t.Fatalf("runtime keys=%s", got)
	}
}

// The table accepts only the two providers.
func TestVoiceProviderKeyTableRejectsUnknownProviders(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, _ := newVoiceKeyEnv(t, &voiceKeyChecker{})
	if _, err := env.pool.Exec(t.Context(), `INSERT INTO voice_provider_keys(provider,api_key_ciphertext) VALUES('openai','\x00')`); err == nil {
		t.Fatal("an unknown provider was stored")
	}
}

// With voice media off voice stays off whatever keys exist: the policy
// reports nothing, saving answers VOICE_MEDIA_OFF and the Voice Runtime reads
// no key.
func TestVoiceProviderKeysWithVoiceMediaOff(t *testing.T) {
	allowParallelIntegrationTest(t)
	env, alice, _ := newHardwareVoiceCaptureEnvWithStorageAndLimitsAndConfig(t, 1<<20, 1<<30, func(cfg *config.Config) {
		cfg.Voice.RuntimeToken = voiceKeyRuntimeToken
		cfg.Voice.XaiAPIKey = "xai-environment-key"
		cfg.ExternalApps.SecretEncryptionKey = base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	}, withVoiceKeyChecker(&voiceKeyChecker{}))
	policy := voiceMediaPolicy(t, env, alice)
	if policy.VoiceAvailable == nil || *policy.VoiceAvailable || policy.VoiceMediaSupported || *policy.LiveSupported ||
		*policy.SonioxKey != (httpapi.VoiceProviderKeyStatus{Source: httpapi.None}) || *policy.XaiKey != (httpapi.VoiceProviderKeyStatus{Source: httpapi.None}) {
		t.Fatalf("policy with voice off=%+v", policy)
	}
	if status, _, body := env.request(alice, http.MethodPut, "/v0/voice-provider-keys/soniox", map[string]any{"api_key": "soniox-key"}, ""); status != http.StatusServiceUnavailable || !strings.Contains(string(body), "VOICE_MEDIA_OFF") {
		t.Fatalf("save with voice off=%d %s", status, body)
	}
	if keys := runtimeVoiceKeys(t, env); keys != `{}` {
		t.Fatalf("runtime keys with voice off=%s", keys)
	}
	request, err := http.NewRequestWithContext(t.Context(), http.MethodPost, env.server.URL+"/internal/v1/voice/observations", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+voiceKeyRuntimeToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusNotFound {
		t.Fatalf("voice callback with voice off=%d", response.StatusCode)
	}
}
