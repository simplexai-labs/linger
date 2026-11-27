package provider

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"unicode"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/native"
	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/provider/redact"
)

const maxFailureDetailRunes = 500

// RuntimeExecutionFailure carries the structured public failure classification
// and an optional redacted, single-line diagnostic detail for Activity display.
type RuntimeExecutionFailure struct {
	Code           string `json:"code"`
	RuntimeType    string `json:"runtime_type"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
	Detail         string `json:"detail,omitempty"`
}

// A CLI reports its version as a whole line, and every CLI decorates it
// differently: Codex prints "codex-cli 0.153.4" while Claude prints
// "2.1.275 (Claude Code)". The pattern stays anchored — the captured version
// reaches a public diagnostic, so an unanchored search would let any
// version-shaped token in an arbitrary string through — and instead names both
// decorations it must tolerate. Without the trailing one, every Claude failure
// reached people as a bare "Claude: ..." while Codex kept its version.
var executionVersionPattern = regexp.MustCompile(`^(?:[A-Za-z][A-Za-z0-9-]{0,31} )?v?([0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?)(?: \([A-Za-z0-9][A-Za-z0-9 .-]{0,39}\))?\s*$`)

// ClassifyExecutionFailure derives the public failure code only from
// structured signals: a code the runtime adapter set from a runtime-specific
// signal, then a local execution deadline, else the sanitized diagnostics.
// Error text never decides the code, because its wording belongs to the CLI
// and changes between versions.
func ClassifyExecutionFailure(runtimeType, version, status, failureCode string, diagnostics native.RuntimeFailureDiagnostics) RuntimeExecutionFailure {
	failure := RuntimeExecutionFailure{Code: failureCode, RuntimeType: runtimeType}
	if failure.Code == "" && status == "timeout" {
		failure.Code = "timeout"
	}
	if failure.Code == "" {
		failure.Code = diagnosticFailureCode(diagnostics)
	}
	if match := executionVersionPattern.FindStringSubmatch(version); len(match) == 2 && len(match[1]) <= 80 {
		failure.RuntimeVersion = match[1]
	}
	return failure
}

func diagnosticFailureCode(diagnostics native.RuntimeFailureDiagnostics) string {
	if status := diagnostics.StatusCode; status != nil {
		switch *status {
		case 401, 403:
			return "authentication_required"
		case 402, 429:
			return "rate_limited"
		}
		if *status >= 500 {
			return "model_service_error"
		}
	}
	switch diagnostics.Code {
	case "unauthorized":
		return "authentication_required"
	case "usageLimitExceeded":
		return "rate_limited"
	case "contextWindowExceeded":
		return "context_too_long"
	case "internalServerError", "serverOverloaded":
		return "model_service_error"
	case "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected":
		// A connection failure that carries an HTTP status reached the
		// service; only one without a status is a network failure.
		if diagnostics.StatusCode == nil {
			return "network_error"
		}
	}
	return "execution_failed"
}

var (
	unixHomePathPattern    = regexp.MustCompile(`/(?:Users|home)/[^/\s'"<>)}\]]+/`)
	windowsHomePathPattern = regexp.MustCompile(`[A-Za-z]:\\Users\\[^\\\s'"<>)}\]]+\\`)
)

// FormatFailureDetail builds a redacted, single-line diagnostic summary from
// a Runtime failure error and its structured diagnostics, bounded to the wire
// limit. Credentials and OS home prefixes are redacted before normalization.
func FormatFailureDetail(rawError string, diagnostics native.RuntimeFailureDiagnostics) string {
	text := normalizeFailureDetailText(redactHomePaths(redact.Text(rawError)))
	sanitized := diagnostics.Sanitized()
	var parts []string
	if sanitized != nil {
		if sanitized.StatusCode != nil {
			code := strconv.Itoa(*sanitized.StatusCode)
			if !strings.Contains(text, code) {
				parts = append(parts, "HTTP "+code)
			}
		}
		if sanitized.Code != "" && !strings.Contains(text, sanitized.Code) {
			parts = append(parts, sanitized.Code)
		}
		if sanitized.Signal != "" && !strings.Contains(text, sanitized.Signal) {
			parts = append(parts, "signal "+sanitized.Signal)
		}
		if sanitized.ExitCode != nil && *sanitized.ExitCode != 0 {
			exitStatus := fmt.Sprintf("exit status %d", *sanitized.ExitCode)
			exitCode := fmt.Sprintf("exit code %d", *sanitized.ExitCode)
			if !strings.Contains(text, exitStatus) && !strings.Contains(text, exitCode) {
				parts = append(parts, exitCode)
			}
		}
	}
	var detail string
	switch {
	case text != "" && len(parts) > 0:
		detail = text + " (" + strings.Join(parts, ", ") + ")"
	case text != "":
		detail = text
	case len(parts) > 0:
		detail = strings.Join(parts, ", ")
	default:
		return ""
	}
	return truncateFailureDetail(detail, maxFailureDetailRunes)
}

func redactHomePaths(raw string) string {
	return windowsHomePathPattern.ReplaceAllString(
		unixHomePathPattern.ReplaceAllString(raw, "~/"),
		`~\`,
	)
}

func normalizeFailureDetailText(raw string) string {
	var out strings.Builder
	out.Grow(len(raw))
	spacePending := false
	for _, r := range raw {
		if r == '\r' || r == '\n' || r == '\t' || unicode.IsSpace(r) {
			if out.Len() > 0 {
				spacePending = true
			}
			continue
		}
		if r < 0x20 || r == 0x7f {
			continue
		}
		if spacePending {
			out.WriteByte(' ')
			spacePending = false
		}
		out.WriteRune(r)
	}
	return out.String()
}

func truncateFailureDetail(detail string, limit int) string {
	runes := []rune(detail)
	if len(runes) <= limit {
		return detail
	}
	if limit <= 3 {
		return string(runes[:limit])
	}
	return strings.TrimRight(string(runes[:limit-3]), " ") + "..."
}
