package native

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/process"
)

// RuntimeFailureDiagnostics is logging-only metadata about a terminal
// failure. It never replaces Outcome.Status or Outcome.Error.
type RuntimeFailureDiagnostics struct {
	Code       string `json:"code,omitempty"`
	StatusCode *int   `json:"statusCode,omitempty"`
	ExitCode   *int   `json:"exitCode,omitempty"`
	Signal     string `json:"signal,omitempty"`
}

var (
	diagnosticCodePattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]{0,63}$`)
	diagnosticSignalPattern = regexp.MustCompile(`^SIG[A-Z0-9]{1,16}$`)
)

// Sanitized returns a copy keeping only valid fields, or nil when none is.
func (d RuntimeFailureDiagnostics) Sanitized() *RuntimeFailureDiagnostics {
	var out RuntimeFailureDiagnostics
	kept := false
	if diagnosticCodePattern.MatchString(d.Code) {
		out.Code, kept = d.Code, true
	}
	if diagnosticSignalPattern.MatchString(d.Signal) {
		out.Signal, kept = d.Signal, true
	}
	if d.StatusCode != nil && validHTTPStatus(int64(*d.StatusCode)) {
		out.StatusCode, kept = intPointer(*d.StatusCode), true
	}
	if d.ExitCode != nil && int64(*d.ExitCode) >= math.MinInt32 && int64(*d.ExitCode) <= math.MaxInt32 {
		out.ExitCode, kept = intPointer(*d.ExitCode), true
	}
	if !kept {
		return nil
	}
	return &out
}

func (d RuntimeFailureDiagnostics) empty() bool {
	return d.Code == "" && d.Signal == "" && d.StatusCode == nil && d.ExitCode == nil
}

func intPointer(value int) *int { return &value }

func validHTTPStatus(value int64) bool { return value >= 100 && value <= 599 }

// processExitDiagnostics describes a reaped process. Call it only for a
// failure that the Daemon's own cancellation or cleanup did not cause.
func processExitDiagnostics(state *os.ProcessState) RuntimeFailureDiagnostics {
	if state == nil {
		return RuntimeFailureDiagnostics{}
	}
	if signal := process.ExitSignal(state); signal != "" {
		return RuntimeFailureDiagnostics{Signal: signal}
	}
	if state.Exited() {
		return RuntimeFailureDiagnostics{ExitCode: intPointer(state.ExitCode())}
	}
	return RuntimeFailureDiagnostics{}
}

// CodexErrorDiagnostics maps a Codex error object's codexErrorInfo value:
// a string is the code; a single-key object names the code and may carry an
// httpStatusCode.
func CodexErrorDiagnostics(info json.RawMessage) RuntimeFailureDiagnostics {
	return codexErrorDiagnostics(info)
}

// codexErrorDiagnostics maps a Codex error object's codexErrorInfo value:
// a string is the code; a single-key object names the code and may carry an
// httpStatusCode.
func codexErrorDiagnostics(info json.RawMessage) RuntimeFailureDiagnostics {
	info = bytes.TrimSpace(info)
	if len(info) == 0 {
		return RuntimeFailureDiagnostics{}
	}
	var code string
	if json.Unmarshal(info, &code) == nil {
		return RuntimeFailureDiagnostics{Code: code}
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(info, &object) != nil || len(object) != 1 {
		return RuntimeFailureDiagnostics{}
	}
	var out RuntimeFailureDiagnostics
	for key, value := range object {
		out.Code = key
		var detail struct {
			HTTPStatusCode json.RawMessage `json:"httpStatusCode"`
		}
		if json.Unmarshal(value, &detail) != nil {
			continue
		}
		if status, ok := integralNumber(detail.HTTPStatusCode); ok && validHTTPStatus(status) {
			out.StatusCode = intPointer(int(status))
		}
	}
	return out
}

// integralNumber accepts a JSON number literal (not a string) with no
// fractional part.
func integralNumber(raw json.RawMessage) (int64, bool) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] == '"' {
		return 0, false
	}
	var number float64
	if json.Unmarshal(raw, &number) != nil || number != math.Trunc(number) || math.Abs(number) > 1<<53 {
		return 0, false
	}
	return int64(number), true
}

// StructuredAPIError holds the structured HTTP status and API error fields
// extracted from a provider or gateway error string without matching prose.
type StructuredAPIError struct {
	Code       string
	Type       string
	Message    string
	StatusCode *int
}

var (
	leadingHTTPStatusPattern  = regexp.MustCompile(`^([45][0-9]{2})(?::|\s|$)`)
	providerHTTPStatusPattern = regexp.MustCompile(`API error \(([45][0-9]{2})\):`)
	posixNetworkErrnoPattern  = regexp.MustCompile(`\b(?:ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ENOTFOUND)\b`)
)

// ParseStructuredAPIError extracts structured provider API error metadata from
// a JSON error body (`{"error":{"code":...,"type":...}}` or top-level
// `{"code":...,"type":...}`), accepting both string error codes and numeric
// HTTP status codes (as llama.cpp / Bifrost return), plus leading HTTP status
// prefixes formatted by provider SDKs.
func ParseStructuredAPIError(text string) (StructuredAPIError, bool) {
	trimmed := strings.TrimSpace(text)
	var statusCode *int
	if match := leadingHTTPStatusPattern.FindStringSubmatch(trimmed); len(match) == 2 {
		if code, err := strconv.Atoi(match[1]); err == nil && validHTTPStatus(int64(code)) {
			statusCode = intPointer(code)
		}
	} else if match := providerHTTPStatusPattern.FindStringSubmatch(trimmed); len(match) == 2 {
		if code, err := strconv.Atoi(match[1]); err == nil && validHTTPStatus(int64(code)) {
			statusCode = intPointer(code)
		}
	}

	rest := trimmed
	for len(rest) > 0 {
		idx := strings.IndexByte(rest, '{')
		if idx < 0 {
			break
		}
		rest = rest[idx:]
		var body struct {
			Code    json.RawMessage `json:"code"`
			Type    string          `json:"type"`
			Message string          `json:"message"`
			Error   *struct {
				Code    json.RawMessage `json:"code"`
				Type    string          `json:"type"`
				Message string          `json:"message"`
			} `json:"error"`
		}
		dec := json.NewDecoder(strings.NewReader(rest))
		if err := dec.Decode(&body); err == nil {
			if body.Error != nil {
				codeStr, codeStatus := parseAPIErrorCodeField(body.Error.Code)
				errType := strings.TrimSpace(body.Error.Type)
				if codeStr != "" || errType != "" || codeStatus != nil {
					if statusCode == nil {
						statusCode = codeStatus
					}
					return StructuredAPIError{
						Code:       codeStr,
						Type:       errType,
						Message:    strings.TrimSpace(body.Error.Message),
						StatusCode: statusCode,
					}, true
				}
			}
			codeStr, codeStatus := parseAPIErrorCodeField(body.Code)
			errType := strings.TrimSpace(body.Type)
			if codeStr != "" || errType != "" || codeStatus != nil {
				if statusCode == nil {
					statusCode = codeStatus
				}
				return StructuredAPIError{
					Code:       codeStr,
					Type:       errType,
					Message:    strings.TrimSpace(body.Message),
					StatusCode: statusCode,
				}, true
			}
		}
		rest = rest[1:]
	}
	if statusCode != nil {
		return StructuredAPIError{StatusCode: statusCode}, true
	}
	return StructuredAPIError{}, false
}

// parseAPIErrorCodeField decodes a JSON error "code" field that may be either
// a string identifier or an HTTP status integer (400-599).
func parseAPIErrorCodeField(raw json.RawMessage) (string, *int) {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || bytes.Equal(raw, []byte("null")) {
		return "", nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		text = strings.TrimSpace(text)
		if code, err := strconv.Atoi(text); err == nil && code >= 400 && code <= 599 {
			return "", intPointer(code)
		}
		return text, nil
	}
	if number, ok := integralNumber(raw); ok && number >= 400 && number <= 599 {
		return "", intPointer(int(number))
	}
	return "", nil
}

// APIErrorDiagnostics builds sanitized RuntimeFailureDiagnostics from
// structured HTTP status codes, JSON error code/type fields, or POSIX network
// error codes embedded in a runtime error string.
func APIErrorDiagnostics(text string) RuntimeFailureDiagnostics {
	var out RuntimeFailureDiagnostics
	if apiErr, ok := ParseStructuredAPIError(text); ok {
		out.StatusCode = apiErr.StatusCode
		out.Code = selectDiagnosticAPIErrorCode(apiErr)
	}
	if out.Code == "" && out.StatusCode == nil {
		if errno := posixNetworkErrnoPattern.FindString(text); errno != "" {
			out.Code = errno
		}
	}
	if sanitized := out.Sanitized(); sanitized != nil {
		return *sanitized
	}
	return RuntimeFailureDiagnostics{}
}

func selectDiagnosticAPIErrorCode(apiErr StructuredAPIError) string {
	code := apiErr.Code
	errType := apiErr.Type
	if code != "" && code != "error" && code != "invalid_request_error" && diagnosticCodePattern.MatchString(code) {
		return code
	}
	if errType != "" && errType != "error" && diagnosticCodePattern.MatchString(errType) {
		return errType
	}
	if code != "" && diagnosticCodePattern.MatchString(code) {
		return code
	}
	return ""
}
