package agentruntimestate

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestTerminalRuntimeFailure(t *testing.T) {
	tooLongDetail := strings.Repeat("a", 501)
	for _, tc := range []struct {
		name, raw string
		valid     bool
	}{
		{"legacy", `{"type":"failed","error":"private error"}`, true},
		{"unknown execution outcome", `{"type":"failed","failure":{"code":"execution_outcome_unknown","runtime_type":"claude"}}`, true},
		{"reply never reached the Room", `{"type":"failed","error":"Agent reply was not delivered to the Room","failure":{"code":"reply_undelivered","runtime_type":"pi"}}`, true},
		{"no reply sent to a waiting Human", `{"type":"failed","error":"Agent ended its turn without sending a reply to the Room","failure":{"code":"reply_not_sent","runtime_type":"pi"}}`, true},
		{"model refused for the account", `{"type":"failed","failure":{"code":"model_unavailable","runtime_type":"codex","runtime_version":"0.153.4"}}`, true},
		{"Computer does not offer the model", `{"type":"failed","error":"Local Computer model is unavailable","failure":{"code":"model_not_offered","runtime_type":"codex"}}`, true},
		{"Computer could not load the local model", `{"type":"failed","failure":{"code":"local_model_unavailable","runtime_type":"pi"}}`, true},
		{"Computer could not start the local model gateway", `{"type":"failed","failure":{"code":"model_gateway_unavailable","runtime_type":"codex"}}`, true},
		{"redacted diagnostic detail", `{"type":"failed","failure":{"code":"execution_failed","runtime_type":"antigravity","runtime_version":"1.5.16","detail":"FAILED_PRECONDITION (code 400): User location is not supported for the API use."}}`, true},
		{"blank detail rejected", `{"type":"failed","failure":{"code":"execution_failed","runtime_type":"antigravity","detail":"   "}}`, false},
		{"control char detail rejected", `{"type":"failed","failure":{"code":"execution_failed","runtime_type":"antigravity","detail":"line1\nline2"}}`, false},
		{"oversized detail rejected", `{"type":"failed","failure":{"code":"execution_failed","runtime_type":"antigravity","detail":"` + tooLongDetail + `"}}`, false},
		{"canceled cannot claim unknown failure", `{"type":"canceled","failure":{"code":"execution_outcome_unknown","runtime_type":"codex"}}`, false},
		{"unknown outcome cannot carry native text", `{"type":"failed","failure":{"code":"execution_outcome_unknown","runtime_type":"codex","cause":"private"}}`, false},
		{"known", `{"type":"failed","failure":{"code":"session_not_found","runtime_type":"codex","runtime_version":"0.153.4"}}`, true},
		{"native text", `{"type":"failed","failure":{"code":"session_not_found","runtime_type":"codex","message":"secret"}}`, false},
		{"invalid version", `{"type":"failed","failure":{"code":"session_not_found","runtime_type":"codex","runtime_version":"/private/token"}}`, false},
		{"Service-observed failure names no Runtime", `{"type":"failed","error":"process_interrupted","failure":{"code":"interrupted"}}`, true},
		{"Computer deadline", `{"type":"failed","failure":{"code":"timeout","runtime_type":"codex"}}`, true},
		{"unknown Runtime", `{"type":"failed","failure":{"code":"timeout","runtime_type":"secret"}}`, false},
		{"unknown code", `{"type":"failed","failure":{"code":"secret","runtime_type":"codex"}}`, false},
		{"success", `{"type":"succeeded","failure":{"code":"execution_failed","runtime_type":"codex"}}`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := terminalRuntimeFailure(json.RawMessage(tc.raw))
			if (err == nil) != tc.valid {
				t.Fatalf("error=%v, valid=%v", err, tc.valid)
			}
		})
	}
}
