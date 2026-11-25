package permission

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// ShellPowerShell decides a PowerShell command against the TeamHub CLI
// allowlist. It fails closed outside two shapes: a single bare teamhub
// command, or a PowerShell single-quoted here-string (@'...'@) piped into a
// single bare teamhub command. POSIX Shell never parses PowerShell
// here-strings because bash treats @'...'@ as an ordinary single-quoted word
// that breaks out on the first apostrophe. The returned name is the confirmed
// TeamHub command for ShellRunAlone.
func ShellPowerShell(command string, commands []TeamHubCommand) (ShellDecision, string) {
	i := skipPowerShellWhitespace(command, 0)
	if i >= len(command) {
		return ShellReview, ""
	}
	if strings.HasPrefix(command[i:], "@'") {
		var ok bool
		i, ok = skipPowerShellHereStringPipe(command, i)
		if !ok {
			return ShellReview, ""
		}
	}
	words, after, ok := parsePowerShellTeamHubCommand(command, i)
	if !ok {
		return ShellReview, ""
	}
	allowed := teamhubCommand(words, commands)
	if allowed == nil {
		return ShellReview, ""
	}
	rest := command[after:]
	if strings.Trim(rest, " \t\r\n") == "" {
		return ShellAllow, ""
	}
	if sepLen := powerShellSeparatorLen(rest); sepLen > 0 && allowed.Confirm && strings.Trim(rest[sepLen:], " \t\r\n") != "" {
		return ShellRunAlone, "teamhub " + strings.Join(allowed.Path, " ")
	}
	return ShellReview, ""
}

// isPowerShellTeamHubCommand reports whether a PowerShell command runs bare
// teamhub (or teamhub.cmd / teamhub.exe), directly or fed by a PowerShell
// single-quoted here-string, so Surface classifies it as connected_app.
func isPowerShellTeamHubCommand(command string) bool {
	i := skipPowerShellWhitespace(command, 0)
	if i >= len(command) {
		return false
	}
	if strings.HasPrefix(command[i:], "@'") {
		var ok bool
		i, ok = skipPowerShellHereStringPipe(command, i)
		if !ok {
			return false
		}
	}
	word, after := readPowerShellCommandWord(command, i)
	if !isBarePowerShellTeamHub(word) {
		return false
	}
	return after < len(command) && (command[after] == ' ' || command[after] == '\t')
}

func skipPowerShellWhitespace(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t' || s[i] == '\r' || s[i] == '\n') {
		i++
	}
	return i
}

func skipPowerShellHorizontal(s string, i int) int {
	for i < len(s) && (s[i] == ' ' || s[i] == '\t') {
		i++
	}
	return i
}

func isBarePowerShellTeamHub(word string) bool {
	return strings.EqualFold(word, "teamhub") ||
		strings.EqualFold(word, "teamhub.cmd") ||
		strings.EqualFold(word, "teamhub.exe")
}

func readPowerShellCommandWord(s string, i int) (string, int) {
	start := i
	for i < len(s) {
		switch s[i] {
		case ' ', '\t', '\r', '\n', ';', '|', '&':
			return s[start:i], i
		}
		i++
	}
	return s[start:i], i
}

// skipPowerShellHereStringPipe consumes a PowerShell single-quoted here-string
// (@' ... '@) followed by a single pipe (|) and optional whitespace, returning
// the index of the piped command.
func skipPowerShellHereStringPipe(s string, i int) (int, bool) {
	if !strings.HasPrefix(s[i:], "@'") {
		return 0, false
	}
	i = skipPowerShellHorizontal(s, i+2)
	switch {
	case strings.HasPrefix(s[i:], "\r\n"):
		i += 2
	case i < len(s) && s[i] == '\n':
		i++
	default:
		return 0, false
	}
	for i < len(s) {
		if strings.HasPrefix(s[i:], "'@") {
			i = skipPowerShellHorizontal(s, i+2)
			if i >= len(s) || s[i] != '|' {
				return 0, false
			}
			if i+1 < len(s) && (s[i+1] == '|' || s[i+1] == '&') {
				return 0, false
			}
			return skipPowerShellWhitespace(s, i+1), true
		}
		// PowerShell's lexer also treats smart single quotes as here-string
		// delimiters, so a column-0 smart-quote + '@' would break out early.
		if first, size := utf8.DecodeRuneInString(s[i:]); first == utf8.RuneError && size == 1 {
			return 0, false
		} else if isPowerShellSmartSingleQuote(first) && strings.HasPrefix(s[i+size:], "@") {
			return 0, false
		}
		lineEnd := i
		for lineEnd < len(s) {
			r, size := utf8.DecodeRuneInString(s[lineEnd:])
			if r == utf8.RuneError && size == 1 {
				return 0, false
			}
			switch r {
			case '\r':
				if lineEnd+1 >= len(s) || s[lineEnd+1] != '\n' {
					return 0, false
				}
				lineEnd += 2
				goto nextLine
			case '\n':
				lineEnd++
				goto nextLine
			case '\u0085', '\u2028', '\u2029':
				return 0, false
			default:
				lineEnd += size
			}
		}
		// Unclosed here-string reached EOF without a closing '@ line.
		return 0, false
	nextLine:
		i = lineEnd
	}
	return 0, false
}

// parsePowerShellTeamHubCommand reads a single bare teamhub invocation and its
// safe arguments and 2>&1 redirections, stopping at EOF or a command boundary.
func parsePowerShellTeamHubCommand(s string, i int) ([]string, int, bool) {
	program, next := readPowerShellCommandWord(s, i)
	if !isBarePowerShellTeamHub(program) {
		return nil, 0, false
	}
	words := []string{"teamhub"}
	i = next
	for {
		i = skipPowerShellHorizontal(s, i)
		if i >= len(s) {
			return words, i, true
		}
		if s[i] == '\r' || s[i] == '\n' || powerShellSeparatorLen(s[i:]) > 0 {
			return words, i, true
		}
		if strings.HasPrefix(s[i:], "2>&1") && isPowerShellTokenBoundary(s[i+4:]) {
			i += 4
			continue
		}
		switch s[i] {
		case '\'':
			word, after, ok := parsePowerShellSingleQuoted(s, i)
			if !ok {
				return nil, 0, false
			}
			words = append(words, word)
			i = after
		case '"':
			word, after, ok := parsePowerShellDoubleQuoted(s, i)
			if !ok {
				return nil, 0, false
			}
			words = append(words, word)
			i = after
		default:
			word, after, ok := parsePowerShellPlainWord(s, i)
			if !ok {
				return nil, 0, false
			}
			words = append(words, word)
			i = after
		}
	}
}

func parsePowerShellSingleQuoted(s string, i int) (string, int, bool) {
	var b strings.Builder
	for j := i + 1; j < len(s); {
		r, size := utf8.DecodeRuneInString(s[j:])
		if r == utf8.RuneError && size == 1 {
			return "", 0, false
		}
		switch {
		case r == '\'':
			if j+1 < len(s) && s[j+1] == '\'' {
				b.WriteByte('\'')
				j += 2
				continue
			}
			j++
			if !isPowerShellTokenBoundary(s[j:]) {
				return "", 0, false
			}
			return b.String(), j, true
		case isCmdExeHazardous(r), isPowerShellLineBreak(r), unicode.IsControl(r),
			isPowerShellSmartSingleQuote(r), isPowerShellSmartDoubleQuote(r), isPowerShellSmartDash(r):
			return "", 0, false
		default:
			b.WriteRune(r)
			j += size
		}
	}
	return "", 0, false
}

func parsePowerShellDoubleQuoted(s string, i int) (string, int, bool) {
	var b strings.Builder
	for j := i + 1; j < len(s); {
		r, size := utf8.DecodeRuneInString(s[j:])
		if r == utf8.RuneError && size == 1 {
			return "", 0, false
		}
		switch {
		case r == '"':
			j++
			if !isPowerShellTokenBoundary(s[j:]) {
				return "", 0, false
			}
			return b.String(), j, true
		case r == '$', isCmdExeHazardous(r), isPowerShellLineBreak(r), unicode.IsControl(r),
			isPowerShellSmartSingleQuote(r), isPowerShellSmartDoubleQuote(r), isPowerShellSmartDash(r):
			return "", 0, false
		default:
			b.WriteRune(r)
			j += size
		}
	}
	return "", 0, false
}

func parsePowerShellPlainWord(s string, i int) (string, int, bool) {
	j := i
	for j < len(s) {
		if s[j] == ' ' || s[j] == '\t' || s[j] == '\r' || s[j] == '\n' || powerShellSeparatorLen(s[j:]) > 0 {
			break
		}
		r, size := utf8.DecodeRuneInString(s[j:])
		if r == utf8.RuneError && size == 1 {
			return "", 0, false
		}
		if r < utf8.RuneSelf {
			if !isPowerShellPlainASCII(byte(r)) {
				return "", 0, false
			}
		} else {
			if unicode.IsSpace(r) || unicode.IsControl(r) ||
				isPowerShellSmartSingleQuote(r) || isPowerShellSmartDoubleQuote(r) || isPowerShellSmartDash(r) {
				return "", 0, false
			}
		}
		j += size
	}
	if j == i {
		return "", 0, false
	}
	return s[i:j], j, true
}

func isPowerShellPlainASCII(c byte) bool {
	return (c >= 'a' && c <= 'z') ||
		(c >= 'A' && c <= 'Z') ||
		(c >= '0' && c <= '9') ||
		strings.IndexByte(`_./:\,+=-`, c) >= 0
}

func isPowerShellTokenBoundary(rest string) bool {
	if rest == "" {
		return true
	}
	return rest[0] == ' ' || rest[0] == '\t' || rest[0] == '\r' || rest[0] == '\n' || powerShellSeparatorLen(rest) > 0
}

func powerShellSeparatorLen(rest string) int {
	switch {
	case strings.HasPrefix(rest, "&&"), strings.HasPrefix(rest, "||"), strings.HasPrefix(rest, "\r\n"):
		return 2
	case strings.HasPrefix(rest, ";"), strings.HasPrefix(rest, "\n"), strings.HasPrefix(rest, "\r"):
		return 1
	case strings.HasPrefix(rest, "|") && !strings.HasPrefix(rest, "|&"):
		return 1
	default:
		return 0
	}
}

// isCmdExeHazardous reports characters that cmd.exe treats specially when
// forwarding arguments through a .cmd wrapper (%*), plus PowerShell backticks.
// Text piped over stdin via @'...'@ never passes through cmd.exe %*.
func isCmdExeHazardous(r rune) bool {
	switch r {
	case '&', '|', '<', '>', '%', '^', '"', '(', ')', '!', '`', ';':
		return true
	default:
		return false
	}
}

func isPowerShellLineBreak(r rune) bool {
	return r == '\r' || r == '\n' || r == '\u0085' || r == '\u2028' || r == '\u2029'
}

func isPowerShellSmartSingleQuote(r rune) bool {
	return r >= '\u2018' && r <= '\u201B'
}

func isPowerShellSmartDoubleQuote(r rune) bool {
	return r >= '\u201C' && r <= '\u201E'
}

func isPowerShellSmartDash(r rune) bool {
	return r >= '\u2013' && r <= '\u2015'
}
