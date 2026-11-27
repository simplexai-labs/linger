package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicekey"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicemedia"
)

type recordingVoicePlane struct {
	voicemedia.Plane
	created []voicemedia.CreateVoiceSessionRequest
}

func (p *recordingVoicePlane) CreateVoiceSession(_ context.Context, request voicemedia.CreateVoiceSessionRequest) (voicemedia.VoiceSession, error) {
	p.created = append(p.created, request)
	return voicemedia.VoiceSession{ID: "voice_session_1", Purpose: request.Purpose, Status: "connected"}, nil
}

// The Mobile App names itself so its Live session gets no page tools; a
// request without a client is the browser's.
func TestVoiceSessionCreateCarriesItsClient(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		body, want string
		status     int
	}{
		{`{"purpose":"chat_live","client":"mobile"}`, voicemedia.ClientMobile, http.StatusCreated},
		{`{"purpose":"chat_live","client":"web"}`, voicemedia.ClientWeb, http.StatusCreated},
		{`{"purpose":"chat_live"}`, voicemedia.ClientWeb, http.StatusCreated},
		{`{"purpose":"chat_live","client":"watch"}`, "", http.StatusBadRequest},
	} {
		t.Run(tc.body, func(t *testing.T) {
			plane := &recordingVoicePlane{}
			a := &App{voiceMedia: plane, voiceKeys: voicekey.New(nil, nil, voicekey.Config{
				Enabled: true, Environment: map[voicekey.Provider]string{voicekey.XAI: "xai-key"},
			}, nil)}
			engine := gin.New()
			engine.POST("/v0/rooms/:roomId/voice-sessions", func(c *gin.Context) {
				c.Set("request_id", "request")
				c.Set(principalKey, principal{})
				a.createVoiceSession(c)
			})
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/v0/rooms/room/voice-sessions", strings.NewReader(tc.body)))
			if response.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, tc.status, response.Body)
			}
			if tc.want == "" {
				if len(plane.created) != 0 {
					t.Fatalf("created %v for an invalid client", plane.created)
				}
				return
			}
			if len(plane.created) != 1 || plane.created[0].Client != tc.want {
				t.Fatalf("created %v, want client %q", plane.created, tc.want)
			}
		})
	}
}
