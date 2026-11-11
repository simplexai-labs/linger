package app

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/localidentity"
)

func localIdentityServer(key string) *gin.Engine {
	gin.SetMode(gin.TestMode)
	a := &App{cfg: config.ForTest(func(c *config.Config) {
		c.PublicWebURL = "http://localhost:3000"
		c.LocalIdentityKey = key
	})}
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request") })
	engine.POST("/v0/local/identity", a.proveLocalIdentity)
	return engine
}

func proveLocalIdentity(engine *gin.Engine, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v0/local/identity", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}

func TestLocalIdentityAnswersTheNonceForThisOrigin(t *testing.T) {
	raw := make([]byte, 32)
	raw[0] = 7
	engine := localIdentityServer(base64.StdEncoding.EncodeToString(raw))
	nonce := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("n", 32)))
	response := proveLocalIdentity(engine, `{"nonce":"`+nonce+`"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
	var body struct{ Proof string }
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Proof != localidentity.Proof(raw, nonce, "http://localhost:3000") {
		t.Fatalf("proof=%s", body.Proof)
	}
}

func TestLocalIdentityRejectsMalformedNonces(t *testing.T) {
	engine := localIdentityServer(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	for _, body := range []string{`{}`, `{"nonce":"short"}`, `{"nonce":"` + strings.Repeat("A", 43) + `","extra":1}`, `not json`} {
		if response := proveLocalIdentity(engine, body); response.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status=%d", body, response.Code)
		}
	}
}

func TestLocalIdentityIsAbsentWithoutAKey(t *testing.T) {
	engine := localIdentityServer("")
	response := proveLocalIdentity(engine, `{"nonce":"`+strings.Repeat("A", 43)+`"}`)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status=%d", response.Code)
	}
}
