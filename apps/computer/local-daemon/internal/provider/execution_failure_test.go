package provider

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
)

// The diagnostics are what codexErrorDiagnostics decodes from codex-cli
// 0.163.0 codexErrorInfo payloads (see TestCodexErrorDiagnostics).
func TestExecutionFailureClassificationUsesStructuredSignals(t *testing.T) {
	status := func(code int) *int { return &code }
	for _, test := range []struct {
		name        string
		status      string
		failureCode string
		diagnostics native.RuntimeFailureDiagnostics
		want        string
	}{
		{"http 401", "failed", "", native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: status(401)}, "authentication_required"},
		{"http 403", "failed", "", native.RuntimeFailureDiagnostics{Code: "api_error", StatusCode: status(403)}, "authentication_required"},
		{"http 429", "failed", "", native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: status(429)}, "rate_limited"},
		{"usage limit", "failed", "", native.RuntimeFailureDiagnostics{Code: "usageLimitExceeded"}, "rate_limited"},
		{"unauthorized", "failed", "", native.RuntimeFailureDiagnostics{Code: "unauthorized"}, "authentication_required"},
		{"stream connection", "failed", "", native.RuntimeFailureDiagnostics{Code: "responseStreamConnectionFailed"}, "network_error"},
		{"stream disconnected", "failed", "", native.RuntimeFailureDiagnostics{Code: "responseStreamDisconnected"}, "network_error"},
		{"http 503", "failed", "", native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: status(503)}, "model_service_error"},
		{"internal server error", "failed", "", native.RuntimeFailureDiagnostics{Code: "internalServerError"}, "model_service_error"},
		{"context window", "failed", "", native.RuntimeFailureDiagnostics{Code: "contextWindowExceeded"}, "context_too_long"},
		{"llama exceed context size", "failed", "", native.RuntimeFailureDiagnostics{Code: "exceed_context_size_error", StatusCode: status(400)}, "context_too_long"},
		{"500 wrapped exceed context size", "failed", "", native.RuntimeFailureDiagnostics{Code: "exceed_context_size_error", StatusCode: status(500)}, "context_too_long"},
		{"http 413 payload too large", "failed", "", native.RuntimeFailureDiagnostics{StatusCode: status(413)}, "context_too_long"},
		{"request too large", "failed", "", native.RuntimeFailureDiagnostics{Code: "request_too_large", StatusCode: status(413)}, "context_too_long"},
		{"unavailable error 503", "failed", "", native.RuntimeFailureDiagnostics{Code: "unavailable_error", StatusCode: status(503)}, "model_service_error"},
		{"server error 500", "failed", "", native.RuntimeFailureDiagnostics{Code: "server_error", StatusCode: status(500)}, "model_service_error"},
		{"server busy", "failed", "", native.RuntimeFailureDiagnostics{Code: "server_busy"}, "model_service_error"},
		{"model not loaded", "failed", "", native.RuntimeFailureDiagnostics{Code: "model_not_loaded", StatusCode: status(503)}, "model_service_error"},
		{"rate limit exceeded", "failed", "", native.RuntimeFailureDiagnostics{Code: "rate_limit_exceeded", StatusCode: status(429)}, "rate_limited"},
		{"model not found", "failed", "", native.RuntimeFailureDiagnostics{Code: "model_not_found", StatusCode: status(400)}, "model_unavailable"},
		{"posix network errno", "failed", "", native.RuntimeFailureDiagnostics{Code: "ECONNREFUSED"}, "network_error"},
		{"unclassified http 400", "failed", "", native.RuntimeFailureDiagnostics{StatusCode: status(400)}, "execution_failed"},
		{"local deadline", "timeout", "", native.RuntimeFailureDiagnostics{ExitCode: status(1)}, "timeout"},
		{"adapter code wins over deadline", "timeout", "session_not_found", native.RuntimeFailureDiagnostics{}, "session_not_found"},
		{"exit only", "failed", "", native.RuntimeFailureDiagnostics{ExitCode: status(1)}, "execution_failed"},
		{"empty", "failed", "", native.RuntimeFailureDiagnostics{}, "execution_failed"},
		{"local model not loaded", "failed", "local_model_unavailable", native.RuntimeFailureDiagnostics{}, "local_model_unavailable"},
		{"model gateway unavailable", "failed", "model_gateway_unavailable", native.RuntimeFailureDiagnostics{}, "model_gateway_unavailable"},
		{"adapter code wins", "failed", "session_not_found", native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: status(401)}, "session_not_found"},
	} {
		t.Run(test.name, func(t *testing.T) {
			failure := ClassifyExecutionFailure("codex", "codex-cli 0.150.1", test.status, test.failureCode, test.diagnostics)
			if failure.Code != test.want || failure.RuntimeType != "codex" || failure.RuntimeVersion != "0.150.1" {
				t.Fatalf("unexpected public diagnostic: %+v", failure)
			}
		})
	}
}

func TestExecutionFailureClassificationDoesNotPublishNativeDetails(t *testing.T) {
	failure := ClassifyExecutionFailure("codex", "/private/codex secret", "failed", "", native.RuntimeFailureDiagnostics{Code: "secret"})
	encoded, err := json.Marshal(failure)
	if err != nil || failure.RuntimeVersion != "" || strings.Contains(string(encoded), "secret") {
		t.Fatalf("native details leaked into public diagnostics: %s", encoded)
	}
}

// Every CLI decorates its version line differently and the daemon stores the
// whole line. Codex's prefix was tolerated from the start; Claude's suffix was
// not, so its failures reached people without a version at all.
func TestExecutionFailureVersionAcceptsEachRuntimesOwnDecoration(t *testing.T) {
	for raw, want := range map[string]string{
		"codex-cli 0.153.4":                 "0.153.4",
		"2.1.275 (Claude Code)":             "2.1.275",
		"claude 2.1.275":                    "2.1.275",
		"0.150.1":                           "0.150.1",
		"v1.2.3":                            "1.2.3",
		"1.2.3-alpha.1":                     "1.2.3-alpha.1",
		"2.1.275 (Claude Code) secret":      "",
		"/private/1.2.3/codex":              "",
		"codex 1.2.3 and a private comment": "",
		"not a version":                     "",
	} {
		if got := ClassifyExecutionFailure("claude", raw, "failed", "", native.RuntimeFailureDiagnostics{}).RuntimeVersion; got != want {
			t.Fatalf("version %q parsed as %q, want %q", raw, got, want)
		}
	}
}

func TestFormatFailureDetailRedactsAndBounds(t *testing.T) {
	status := func(code int) *int { return &code }
	if got := FormatFailureDetail("\n\u26a0 FAILED_PRECONDITION (code 400): User location is not supported for the API use.\n", native.RuntimeFailureDiagnostics{}); got != "\u26a0 FAILED_PRECONDITION (code 400): User location is not supported for the API use." {
		t.Fatalf("antigravity detail=%q", got)
	}
	redacted := FormatFailureDetail("request failed at /Users/alice/work/app.go: Authorization: Bearer sk-1234567890abcdefghijklmnop\nnext line", native.RuntimeFailureDiagnostics{StatusCode: status(401), Code: "unauthorized", ExitCode: status(0)})
	if strings.Contains(redacted, "sk-1234567890") || strings.Contains(redacted, "/Users/alice/") || strings.Contains(redacted, "exit code 0") || strings.Contains(redacted, "\n") || !strings.Contains(redacted, "~/work/app.go") || !strings.Contains(redacted, "HTTP 401") || !strings.Contains(redacted, "unauthorized") {
		t.Fatalf("redacted detail=%q", redacted)
	}
	diagOnly := FormatFailureDetail("", native.RuntimeFailureDiagnostics{Code: "httpConnectionFailed", StatusCode: status(429), ExitCode: status(3), Signal: "SIGSEGV"})
	if diagOnly != "HTTP 429, httpConnectionFailed, signal SIGSEGV, exit code 3" {
		t.Fatalf("diagOnly=%q", diagOnly)
	}
	bounded := FormatFailureDetail(strings.Repeat("x", 700), native.RuntimeFailureDiagnostics{})
	if len([]rune(bounded)) > maxFailureDetailRunes || !strings.HasSuffix(bounded, "...") {
		t.Fatalf("bounded len=%d val=%q", len([]rune(bounded)), bounded)
	}
}
