package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voice"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicedictation"
)

// What the dictation settings refuse is worded by the client from the code, so
// each refusal keeps its own status and code.
func TestVoiceDictationErrorsKeepTheirCodes(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for name, test := range map[string]struct {
		err    error
		status int
		code   string
	}{
		"invalid model":     {voice.ErrInvalidPolishModel, http.StatusBadRequest, "INVALID_REQUEST"},
		"invalid API":       {voice.ErrInvalidPolishAPI, http.StatusBadRequest, "INVALID_REQUEST"},
		"key refused":       {voicedictation.ErrAPIRejected, http.StatusBadRequest, "VOICE_KEY_REJECTED"},
		"wrapped refusal":   {fmt.Errorf("probe: %w", voicedictation.ErrAPIRejected), http.StatusBadRequest, "VOICE_KEY_REJECTED"},
		"API unreachable":   {voicedictation.ErrAPIUnreachable, http.StatusServiceUnavailable, "VOICE_PROVIDER_UNAVAILABLE"},
		"no encryption key": {voice.ErrDictationKeyStorage, http.StatusServiceUnavailable, "VOICE_KEY_STORAGE_UNAVAILABLE"},
		"anything else":     {errors.New("database is down"), http.StatusInternalServerError, "INTERNAL"},
		"joined refusal":    {errors.Join(voice.ErrInvalidPolishAPI, errors.New("other")), http.StatusBadRequest, "INVALID_REQUEST"},
	} {
		t.Run(name, func(t *testing.T) {
			a := &App{logger: slog.Default()}
			engine := gin.New()
			engine.POST("/", func(c *gin.Context) {
				c.Set("request_id", "request")
				a.writeVoiceDictationError(c, "test", test.err)
			})
			response := httptest.NewRecorder()
			engine.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/", nil))
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d: %s", response.Code, test.status, response.Body)
			}
			var body struct {
				Error struct {
					Code string `json:"code"`
				} `json:"error"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if test.status != http.StatusInternalServerError && body.Error.Code != test.code {
				t.Fatalf("code = %q, want %q", body.Error.Code, test.code)
			}
		})
	}
}
