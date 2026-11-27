package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

// localASRPlane answers the one call a local-dictation test reaches; any
// other Plane method would panic on the embedded nil interface.
type localASRPlane struct{ voicemedia.Plane }

func (localASRPlane) CreateVoiceSession(_ context.Context, request voicemedia.CreateVoiceSessionRequest) (voicemedia.VoiceSession, error) {
	now := time.Now()
	return voicemedia.VoiceSession{
		ID:               "voice_local",
		TenantID:         "tenant_space",
		RoomID:           request.RoomID,
		CreatedByActorID: request.AccountID,
		Status:           "open",
		Purpose:          request.Purpose,
		CreatedAt:        now,
		UpdatedAt:        now,
	}, nil
}

func TestVoiceSessionLocalDictationNeedsNoProviderKey(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name    string
		purpose string
		local   bool
		want    int
	}{
		{"local dictation", "chat_dictation", true, http.StatusCreated},
		{"recording still needs Soniox", "hardware_control", true, http.StatusServiceUnavailable},
		{"dictation on Soniox needs a key", "chat_dictation", false, http.StatusServiceUnavailable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			application := &App{
				voiceMedia: localASRPlane{},
				voiceKeys: voicekey.New(nil, nil, voicekey.Config{
					Enabled:     true,
					Environment: map[voicekey.Provider]string{},
				}, nil),
			}
			application.cfg.Voice.LocalASR = tc.local
			engine := gin.New()
			engine.POST("/v0/rooms/:roomId/voice-sessions", func(c *gin.Context) {
				c.Set("request_id", "request-local-asr")
				c.Set(principalKey, principal{Session: spaceTestSession()})
				application.createVoiceSession(c)
			})
			request := httptest.NewRequest(
				http.MethodPost,
				"/v0/rooms/room/voice-sessions",
				strings.NewReader(`{"purpose":"`+tc.purpose+`"}`),
			)
			request.Header.Set("Content-Type", "application/json")
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, request)
			if response.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.want, response.Body.String())
			}
		})
	}
}
