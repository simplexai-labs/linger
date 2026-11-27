package app

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/config"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/localidentity"
)

func localIdentityApp(key string) (*App, *gin.Engine) {
	gin.SetMode(gin.TestMode)
	a := &App{
		cfg: config.ForTest(func(c *config.Config) {
			c.PublicWebURL = "http://localhost:3000"
			c.LocalIdentityKey = key
		}),
		localSessionNonces: localidentity.NewNonceCache(),
	}
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request") })
	engine.POST("/v0/local/identity", a.proveLocalIdentity)
	engine.POST("/v0/local/session", a.createLocalSession)
	return a, engine
}

func localIdentityServer(key string) *gin.Engine {
	_, engine := localIdentityApp(key)
	return engine
}

func postLocalSession(engine *gin.Engine, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v0/local/session", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
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

func TestLocalSessionIsAbsentWithoutAKey(t *testing.T) {
	engine := localIdentityServer("")
	now := time.Now().UTC().Unix()
	body := fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":"abc"}`, strings.Repeat("A", 43), now)
	if response := postLocalSession(engine, body); response.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", response.Code, response.Body)
	}
}

func TestLocalSessionRejectsMalformedRequests(t *testing.T) {
	engine := localIdentityServer(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	now := time.Now().UTC().Unix()
	nonce := strings.Repeat("A", 43)
	cases := []string{
		`{}`,
		`not json`,
		fmt.Sprintf(`{"nonce":"short","timestamp":%d,"proof":"abc"}`, now),
		fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":""}`, nonce, now),
		fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":"abc","extra":1}`, nonce, now),
	}
	for _, body := range cases {
		if response := postLocalSession(engine, body); response.Code != http.StatusBadRequest {
			t.Fatalf("body %s: status=%d body=%s", body, response.Code, response.Body)
		}
	}
}

func TestLocalSessionRejectsWrongProofSkewAndReplay(t *testing.T) {
	raw := make([]byte, 32)
	raw[0] = 9
	app, engine := localIdentityApp(base64.StdEncoding.EncodeToString(raw))
	now := time.Now().UTC()
	nonce := base64.RawURLEncoding.EncodeToString([]byte(strings.Repeat("s", 32)))

	// Wrong proof must return 401 and must NOT consume the nonce.
	wrongBody := fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":"wrong"}`, nonce, now.Unix())
	if response := postLocalSession(engine, wrongBody); response.Code != http.StatusUnauthorized {
		t.Fatalf("wrong proof: status=%d", response.Code)
	}
	// Identity proof (wrong domain label) must also be rejected without consuming the nonce.
	idProof := localidentity.Proof(raw, nonce, "http://localhost:3000")
	idBody := fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":%q}`, nonce, now.Unix(), idProof)
	if response := postLocalSession(engine, idBody); response.Code != http.StatusUnauthorized {
		t.Fatalf("identity proof: status=%d", response.Code)
	}

	// Skewed timestamps (past and future) must return 401.
	for _, ts := range []int64{now.Unix() - 120, now.Unix() + 120} {
		proof := localidentity.SessionProof(raw, nonce, ts, "http://localhost:3000")
		skewBody := fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":%q}`, nonce, ts, proof)
		if response := postLocalSession(engine, skewBody); response.Code != http.StatusUnauthorized {
			t.Fatalf("skewed ts=%d: status=%d", ts, response.Code)
		}
	}

	// Replayed nonce must return 401 before touching sessions.
	if !app.localSessionNonces.Consume(nonce, now, 2*localidentity.SessionProofWindow) {
		t.Fatal("failed to seed nonce cache; earlier invalid attempts should not have consumed it")
	}
	validProof := localidentity.SessionProof(raw, nonce, now.Unix(), "http://localhost:3000")
	replayBody := fmt.Sprintf(`{"nonce":%q,"timestamp":%d,"proof":%q}`, nonce, now.Unix(), validProof)
	if response := postLocalSession(engine, replayBody); response.Code != http.StatusUnauthorized {
		t.Fatalf("replayed nonce: status=%d body=%s", response.Code, response.Body)
	}
}
