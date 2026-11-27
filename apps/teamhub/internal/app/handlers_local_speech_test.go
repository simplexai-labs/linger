package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/agentruntimestate"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestValidLocalSpeechAction(t *testing.T) {
	modelID := "sensevoice-small"
	badModel := "../bad"
	lang := "zh"
	badLang := "english_invalid"
	keep := 900
	badKeep := -2
	useGPU := true

	cases := []struct {
		name string
		req  httpapi.LocalSpeechActionRequest
		want bool
	}{
		{name: "download requires model_id", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestDownload}, want: false},
		{name: "download valid", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestDownload, ModelId: &modelID}, want: true},
		{name: "bad model rejected", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestLoad, ModelId: &badModel}, want: false},
		{name: "unload without model valid", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestUnload}, want: true},
		{name: "configure requires field", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestConfigure}, want: false},
		{name: "configure valid", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestConfigure, UseGpu: &useGPU, KeepLoadedSeconds: &keep, Language: &lang}, want: true},
		{name: "configure bad keep", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestConfigure, KeepLoadedSeconds: &badKeep}, want: false},
		{name: "configure bad lang", req: httpapi.LocalSpeechActionRequest{Action: httpapi.LocalSpeechActionRequestConfigure, Language: &badLang}, want: false},
	}
	for _, tc := range cases {
		if got := validLocalSpeechAction(tc.req); got != tc.want {
			t.Errorf("%s: got %v, want %v", tc.name, got, tc.want)
		}
	}
}

func TestSanitizeAndValidateLocalSpeechSnapshot(t *testing.T) {
	now := time.Now().UTC()
	badFallback := teamhubinternal.LocalSpeechFallbackReason("unknown_future_reason")
	badDevice := teamhubinternal.LocalSpeechEffectiveDevice("tpu")
	snap := teamhubinternal.LocalSpeechSnapshot{
		Available:  true,
		ObservedAt: now,
		Config: &teamhubinternal.LocalSpeechConfig{
			UseGpu:            true,
			KeepLoadedSeconds: 999999,
			Language:          "not valid!",
		},
		Runtime: &teamhubinternal.LocalSpeechRuntime{
			Running:           true,
			State:             teamhubinternal.LocalSpeechRuntimeStateLoaded,
			RequestedDevice:   teamhubinternal.LocalSpeechRequestedDeviceGpu,
			EffectiveDevice:   &badDevice,
			FallbackReason:    &badFallback,
			KeepLoadedSeconds: 900,
		},
		Models: []teamhubinternal.LocalSpeechModel{
			{
				Id:            "sensevoice-small",
				Name:          "SenseVoice Small (INT8)",
				Engine:        teamhubinternal.LocalSpeechEngineSherpaOnnx,
				Languages:     []string{"zh", "en"},
				LanguageCount: 2,
				QualityRating: teamhubinternal.LocalSpeechQualityFastCjk,
				License:       "FunASR-MODEL-LICENSE-1.1",
				LicenseUrl:    "https://huggingface.co/FunAudioLLM/SenseVoiceSmall/blob/main/MODEL_LICENSE",
				State:         teamhubinternal.LocalSpeechModelStateIdle,
			},
		},
	}
	sanitizeLocalSpeechSnapshot(&snap)
	if snap.Config.KeepLoadedSeconds != 900 || snap.Config.Language != "auto" {
		t.Fatalf("expected sanitized config defaults, got %+v", snap.Config)
	}
	if snap.Runtime.EffectiveDevice != nil || snap.Runtime.FallbackReason != nil {
		t.Fatalf("expected unknown device/fallback stripped, got %+v", snap.Runtime)
	}
	if !validLocalSpeechSnapshot(snap) {
		t.Fatalf("expected sanitized snapshot to be valid")
	}
}

func TestUpdateVoiceSettingsRejectsMalformedAndNullJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	application := &App{}
	for _, tc := range []struct {
		name string
		body string
	}{
		{name: "null body", body: "null"},
		{name: "array body", body: "[1]"},
		{name: "malformed json", body: "{broken"},
		{name: "empty body", body: ""},
		{name: "trailing json", body: "{}{}"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, recorder := spaceTestContext("/v0/tenants/tenant_space/voice-settings")
			c.Params = gin.Params{{Key: "tenantId", Value: "tenant_space"}}
			c.Request = httptest.NewRequest(http.MethodPut, "/v0/tenants/tenant_space/voice-settings", strings.NewReader(tc.body))
			c.Request.Header.Set("Content-Type", "application/json")
			application.updateVoiceSettings(c)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status=%d want=400 body=%s", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), `"code":"INVALID_REQUEST"`) {
				t.Fatalf("expected INVALID_REQUEST envelope, got %s", recorder.Body.String())
			}
		})
	}
}

func TestRecordAgentRuntimeLocalSpeechWakesVoiceWorkersOnlyOnTransitionToAvailable(t *testing.T) {
	gin.SetMode(gin.TestMode)
	woke := make(chan struct{}, 4)
	var storedAvailable bool
	application := &App{
		agentRuntimeState: &agentruntimestate.Service{},
		reconcileVoiceWorkers: func(context.Context) (bool, error) {
			woke <- struct{}{}
			return true, nil
		},
		recordLocalSpeech: func(_ context.Context, input agentruntimestate.RecordLocalSpeechInput) (bool, error) {
			nextAvailable := strings.Contains(string(input.Snapshot), `"available":true`)
			becameAvailable := !storedAvailable && nextAvailable
			storedAvailable = nextAvailable
			return becameAvailable, nil
		},
	}

	engine := gin.New()
	engine.POST("/v0/agent-runtime/local-computers/local-speech", func(c *gin.Context) {
		c.Set("request_id", "request-local-speech")
		application.recordAgentRuntimeLocalSpeech(c)
	})
	postSnapshot := func(body string) {
		t.Helper()
		recorder := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/v0/agent-runtime/local-computers/local-speech", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		engine.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusNoContent {
			t.Fatalf("status=%d want=204 body=%s", recorder.Code, recorder.Body.String())
		}
	}

	availableBody := `{"computer_id":"comp_1","snapshot":{"available":true,"observed_at":"2026-11-26T13:20:00Z","models":[]}}`
	unavailableBody := `{"computer_id":"comp_1","snapshot":{"available":false,"reason":{"code":"SPEECH_UNSUPPORTED"},"observed_at":"2026-11-26T13:20:02Z","models":[]}}`

	// First available snapshot (absent -> true) wakes voice workers once.
	postSnapshot(availableBody)
	select {
	case <-woke:
	case <-time.After(2 * time.Second):
		t.Fatal("expected voice worker reconcile on absent -> true transition")
	}

	// Subsequent available progress snapshots (true -> true) must not wake workers.
	postSnapshot(availableBody)
	postSnapshot(availableBody)
	select {
	case <-woke:
		t.Fatal("unexpected voice worker reconcile on repeated available snapshot")
	case <-time.After(50 * time.Millisecond):
	}

	// Transition to unavailable must not wake workers.
	postSnapshot(unavailableBody)
	select {
	case <-woke:
		t.Fatal("unexpected voice worker reconcile on transition to unavailable")
	case <-time.After(50 * time.Millisecond):
	}

	// Recovery transition (false -> true) wakes voice workers once.
	postSnapshot(availableBody)
	select {
	case <-woke:
	case <-time.After(2 * time.Second):
		t.Fatal("expected voice worker reconcile on false -> true transition")
	}
}
