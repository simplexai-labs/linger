package agentruntimestate

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxRuntimeFailureDetailRunes = 500

// PublicRuntimeFailure carries the structured public failure classification and
// an optional redacted, single-line diagnostic detail for Activity display.
type PublicRuntimeFailure struct {
	Code           string `json:"code"`
	RuntimeType    string `json:"runtime_type,omitempty"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
	Detail         string `json:"detail,omitempty"`
}

var runtimeVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$`)

func terminalRuntimeFailure(raw json.RawMessage) (*PublicRuntimeFailure, error) {
	var terminal struct {
		Type    string          `json:"type"`
		Failure json.RawMessage `json:"failure"`
	}
	if json.Unmarshal(raw, &terminal) != nil {
		return nil, ErrInvalid
	}
	if len(terminal.Failure) == 0 || string(terminal.Failure) == "null" {
		return nil, nil
	}
	var failure PublicRuntimeFailure
	if terminal.Type != "failed" || strictJSON(terminal.Failure, &failure) != nil {
		return nil, ErrInvalid
	}
	switch failure.Code {
	case "session_not_found", "protocol_incompatible", "authentication_required", "network_error", "rate_limited",
		"model_unavailable", "model_not_offered", "local_model_unavailable", "model_gateway_unavailable", "context_too_long", "model_service_error", "timeout", "execution_failed",
		"execution_outcome_unknown", "reply_undelivered", "reply_not_sent", "interrupted", "computer_unavailable",
		"cleanup_unconfirmed", "response_too_large", "unclassified":
	default:
		return nil, ErrInvalid
	}
	// A failure observed without a selected Runtime names none.
	switch failure.RuntimeType {
	case "", "codex", "claude", "pi", "antigravity":
	default:
		return nil, ErrInvalid
	}
	if failure.RuntimeVersion != "" && (len(failure.RuntimeVersion) > 80 || !runtimeVersionPattern.MatchString(failure.RuntimeVersion)) {
		return nil, ErrInvalid
	}
	if failure.Detail != "" {
		if strings.TrimSpace(failure.Detail) == "" || utf8.RuneCountInString(failure.Detail) > maxRuntimeFailureDetailRunes || hasControlChar(failure.Detail) {
			return nil, ErrInvalid
		}
	}
	return &failure, nil
}

func hasControlChar(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}
