package app

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/roomagent"
	httpapi "github.com/simplexai-labs/linger/contracts-go/teamhubpublic"
)

func TestValidModelSourceSwitchMatchesRuntimeAndInputsToMode(t *testing.T) {
	claude, pi := httpapi.ModelSourceRuntimeClaude, httpapi.ModelSourceRuntimePi
	unknown := httpapi.ModelSourceRuntime("gemini")
	model := "qwen3-4b:Q4_K_M"
	badModel := "../qwen"
	byok := &httpapi.ByokInput{
		BaseUrl: "https://open.bigmodel.cn", Path: "/api/paas/v4", Endpoint: "/chat/completions",
		Protocol: httpapi.ByokProtocolOpenaiChat, ModelId: "vendor/model",
	}
	fullAddress := &httpapi.ByokInput{
		BaseUrl: "https://gw.example.com/full", Protocol: httpapi.ByokProtocolAnthropic, ModelId: "vendor/model",
	}
	with := func(change func(*httpapi.ByokInput)) *httpapi.ByokInput {
		changed := *byok
		change(&changed)
		return &changed
	}
	blankURL := with(func(b *httpapi.ByokInput) { b.BaseUrl = "  " })
	for _, test := range []struct {
		name    string
		request httpapi.ModelSourceSwitchRequest
		valid   bool
	}{
		{"byok", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: byok}, true},
		{"byok on pi", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &pi, Byok: byok}, true},
		{"byok without runtime", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Byok: byok}, false},
		{"byok without endpoint", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude}, false},
		{"byok blank URL", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: blankURL}, false},
		{"byok full address", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: fullAddress}, true},
		{"byok path without slash", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: with(func(b *httpapi.ByokInput) { b.Path = "v1" })}, false},
		{"byok path with trailing slash", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: with(func(b *httpapi.ByokInput) { b.Path = "/v1/" })}, false},
		{"byok endpoint with host", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: with(func(b *httpapi.ByokInput) { b.Endpoint = "//evil.example.com/x" })}, false},
		{"byok endpoint with query", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: with(func(b *httpapi.ByokInput) { b.Endpoint = "/chat?x=1" })}, false},
		{"byok unknown protocol", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &claude, Byok: with(func(b *httpapi.ByokInput) { b.Protocol = "gemini" })}, false},
		{"subscription", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeSubscription, Runtime: &claude}, true},
		{"subscription on pi", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeSubscription, Runtime: &pi}, false},
		{"subscription with endpoint", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeSubscription, Runtime: &claude, Byok: byok}, false},
		{"local", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeLocal, LocalModelId: &model}, true},
		{"local on claude", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeLocal, Runtime: &claude}, false},
		{"local bad model", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeLocal, LocalModelId: &badModel}, false},
		{"unknown runtime", httpapi.ModelSourceSwitchRequest{Mode: httpapi.ModelSourceModeByok, Runtime: &unknown, Byok: byok}, false},
		{"unknown mode", httpapi.ModelSourceSwitchRequest{Mode: "cloud", Runtime: &claude}, false},
	} {
		if got := validModelSourceSwitch(test.request); got != test.valid {
			t.Errorf("%s: valid=%v, want %v", test.name, got, test.valid)
		}
	}
}

func TestModelSourceRefusalCodesMapRoomErrors(t *testing.T) {
	for _, computerCode := range []string{"LOAD_NO_ROOM", "MEMORY_INSUFFICIENT"} {
		got, ok := modelSourceRefusalCodes[computerCode]
		if !ok || got != httpapi.ModelSourceErrorCodeLocalModelNoRoom {
			t.Fatalf("%s mapped to %q (ok=%v), want %q", computerCode, got, ok, httpapi.ModelSourceErrorCodeLocalModelNoRoom)
		}
	}
	if got := modelSourceRefusalCodes["MODEL_SOURCE_EXPIRED"]; got != httpapi.ModelSourceErrorCodeModelSourceUnconfirmed {
		t.Fatalf("MODEL_SOURCE_EXPIRED mapped to %q, want %q", got, httpapi.ModelSourceErrorCodeModelSourceUnconfirmed)
	}
	if modelSourceErrorMessages[httpapi.ModelSourceErrorCodeLocalModelNoRoom] == "" {
		t.Fatal("LOCAL_MODEL_NO_ROOM has no message")
	}
}

func TestWriteModelSourceFailureMapsByokGatewayFailedWithComputerDetail(t *testing.T) {
	gin.SetMode(gin.TestMode)
	application := &App{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	run := func(err error) (int, httpapi.ErrorResponse) {
		t.Helper()
		recorder := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(recorder)
		c.Set("request_id", "req_model_source_test")
		application.writeModelSourceFailure(c, "computer_1", "apply", err)
		var body httpapi.ErrorResponse
		if decErr := json.Unmarshal(recorder.Body.Bytes(), &body); decErr != nil {
			t.Fatalf("decode response %s: %v", recorder.Body.String(), decErr)
		}
		return recorder.Code, body
	}

	gatewayDetail := "cannot record Bifrost process identity ([Errno 1] Operation not permitted: '/bin/ps'); stopped it"
	status, body := run(&roomagent.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: gatewayDetail})
	if status != http.StatusBadGateway || body.Error.Code != "BYOK_GATEWAY_FAILED" || body.Error.Message != gatewayDetail {
		t.Fatalf("BYOK_GATEWAY_FAILED with detail: status=%d body=%+v", status, body)
	}
	if body.Error.Details == nil || len(*body.Error.Details) != 1 ||
		(*body.Error.Details)[0].Field != "gateway" || (*body.Error.Details)[0].Reason != gatewayDetail {
		t.Fatalf("BYOK_GATEWAY_FAILED details=%+v", body.Error.Details)
	}

	// Empty or overlong Computer messages fall back to TeamHub's summary without
	// emitting a gateway detail entry.
	for name, msg := range map[string]string{
		"empty":    "   ",
		"overlong": strings.Repeat("x", maxComputerMessageLength+1),
	} {
		status, body = run(&roomagent.ModelSourceError{Code: "BYOK_GATEWAY_FAILED", Message: msg})
		if status != http.StatusBadGateway || body.Error.Code != "BYOK_GATEWAY_FAILED" ||
			body.Error.Message != "The Computer could not configure its local BYOK gateway" ||
			body.Error.Details != nil {
			t.Fatalf("BYOK_GATEWAY_FAILED (%s): status=%d body=%+v", name, status, body)
		}
	}

	endpointDetail := "https://api.kimi.com/coding/v1/chat/completions rejected the API key (HTTP 401)."
	status, body = run(&roomagent.ModelSourceError{Code: "BYOK_AUTH_FAILED", Message: endpointDetail})
	if status != http.StatusConflict || body.Error.Code != "BYOK_AUTH_FAILED" ||
		body.Error.Message != endpointDetail || body.Error.Details != nil {
		t.Fatalf("BYOK_AUTH_FAILED: status=%d body=%+v", status, body)
	}

	status, body = run(&roomagent.ModelSourceError{
		Code:    "MODEL_SOURCE_FAILED",
		Message: "The Computer could not switch to the requested local model.",
	})
	if status != http.StatusBadGateway || body.Error.Code != "MODEL_SOURCE_FAILED" ||
		body.Error.Message != modelSourceErrorMessages[httpapi.ModelSourceErrorCodeModelSourceFailed] ||
		body.Error.Details != nil {
		t.Fatalf("MODEL_SOURCE_FAILED refusal: status=%d body=%+v", status, body)
	}

	status, body = run(&roomagent.ModelSourceError{Code: "UNEXPECTED_INTERNAL", Message: "private stack trace"})
	if status != http.StatusBadGateway || body.Error.Code != "MODEL_SOURCE_FAILED" ||
		body.Error.Message != modelSourceErrorMessages[httpapi.ModelSourceErrorCodeModelSourceFailed] ||
		body.Error.Details != nil {
		t.Fatalf("unknown refusal: status=%d body=%+v", status, body)
	}
}

func TestWriteModelSourceFailureClassifiesTimeoutsCancelsAndRedactsAllowedMessages(t *testing.T) {
	gin.SetMode(gin.TestMode)
	a := &App{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}

	run := func(cancelReq bool, err error) (int, httpapi.ErrorResponse) {
		t.Helper()
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Set("request_id", "req_model_source_test")
		reqCtx, cancel := context.WithCancel(context.Background())
		if cancelReq {
			cancel()
		} else {
			defer cancel()
		}
		c.Request = httptest.NewRequest(http.MethodPost, "/model-source", nil).WithContext(reqCtx)
		a.writeModelSourceFailure(c, "computer_1", "models", err)
		var body httpapi.ErrorResponse
		if decErr := json.Unmarshal(w.Body.Bytes(), &body); decErr != nil {
			t.Fatalf("decode response %q: %v", w.Body.String(), decErr)
		}
		return w.Code, body
	}

	if status, body := run(false, context.DeadlineExceeded); status != http.StatusGatewayTimeout || body.Error.Code != string(httpapi.ModelSourceErrorCodeModelSourceUnconfirmed) {
		t.Fatalf("deadline exceeded -> %d %+v", status, body)
	}
	if status, body := run(true, context.Canceled); status != http.StatusGatewayTimeout || body.Error.Code != string(httpapi.ModelSourceErrorCodeModelSourceUnconfirmed) {
		t.Fatalf("client cancel -> %d %+v", status, body)
	}
	if status, body := run(false, context.Canceled); status != http.StatusServiceUnavailable || body.Error.Code != string(httpapi.ModelSourceErrorCodeModelSourceServiceUnavailable) {
		t.Fatalf("unexpected backend cancel -> %d %+v", status, body)
	}
	if status, body := run(false, &roomagent.ModelSourceError{Code: "MODEL_SOURCE_EXPIRED"}); status != http.StatusGatewayTimeout || body.Error.Code != string(httpapi.ModelSourceErrorCodeModelSourceUnconfirmed) {
		t.Fatalf("MODEL_SOURCE_EXPIRED -> %d %+v", status, body)
	}
	status, body := run(false, &roomagent.ModelSourceError{
		Code:    "BYOK_GATEWAY_FAILED",
		Message: `Operation not permitted: '/bin/ps' reading '/home/alice/.local/share/localmodels/state.json', ~/secret.key, and C:\Users\alice\secret.key calling https://user:pass@api.example.com/v1/models?api_key=sk-1234567890abcdef123456 with Bearer tok_secret`,
	})
	if status != http.StatusBadGateway || body.Error.Code != string(httpapi.ModelSourceErrorCodeByokGatewayFailed) {
		t.Fatalf("redacted BYOK_GATEWAY_FAILED -> %d %+v", status, body)
	}
	if body.Error.Details == nil || len(*body.Error.Details) != 1 || (*body.Error.Details)[0].Field != "gateway" || (*body.Error.Details)[0].Reason != body.Error.Message {
		t.Fatalf("expected scrubbed gateway detail, got %+v", body.Error.Details)
	}
	for _, leaked := range []string{"/home/alice", "~/secret.key", `C:\Users\alice`, "user:pass", "sk-1234567890abcdef123456", "api_key=", "tok_secret"} {
		if strings.Contains(body.Error.Message, leaked) {
			t.Fatalf("BYOK_GATEWAY_FAILED leaked %q in %q", leaked, body.Error.Message)
		}
	}
	if !strings.Contains(body.Error.Message, "'/bin/ps'") {
		t.Fatalf("BYOK_GATEWAY_FAILED redacted benign binary path '/bin/ps' in %q", body.Error.Message)
	}
}
