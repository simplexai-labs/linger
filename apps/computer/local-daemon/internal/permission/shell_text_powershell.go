package permission

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

// PowerShellHeredocMessage refuses a PowerShell command that passes a POSIX
// heredoc to teamhub.
const PowerShellHeredocMessage = "Not run: PowerShell does not support POSIX heredocs (<<'EOF'). Pipe a PowerShell single-quoted here-string instead (@' on its own line, the text, then '@ at column 0 | teamhub ... --file -)."

// PowerShell51QuotesMessage refuses a Windows PowerShell 5.1 command that
// passes embedded double quotes in native teamhub arguments.
const PowerShell51QuotesMessage = "Not run: Windows PowerShell 5.1 strips embedded double quotes from native command arguments, corrupting inline JSON and quoted text. Assigning JSON to a PowerShell variable (such as $q or @args) and passing it to an inline flag is corrupted the same way. Pass JSON or quoted text via the command's --*-file - flag using a PowerShell single-quoted here-string (@' on its own line, the content, then '@ at column 0 | teamhub ... --questions-file - / --message-file - / --file -), or write a UTF-8 file with the write tool (do not use PowerShell '>' or Set-Content without -Encoding utf8) and pass its path."

var (
	psPosixHeredocPattern    = regexp.MustCompile("^<<-?[ \t]*['\"]?[A-Za-z_][A-Za-z0-9_]*['\"]?")
	psVarNamePattern         = regexp.MustCompile(`^\$[A-Za-z_][A-Za-z0-9_:]*$`)
	psVarAssignTokenPattern  = regexp.MustCompile(`^\$[A-Za-z_][A-Za-z0-9_:]*=$`)
	psVarAssignPrefixPattern = regexp.MustCompile(`^\$[A-Za-z_][A-Za-z0-9_:]*=`)
	psEnvAssignPattern       = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*=`)
	psPrefixKeywords         = map[string]bool{
		"if": true, "then": true, "else": true, "elif": true,
		"do": true, "while": true, "until": true, "!": true,
		"time": true, "exec": true, "nohup": true,
	}
)

type psTokenKind uint8

const (
	psTokenBare psTokenKind = iota
	psTokenQuoted
)

type psToken struct {
	text                      string
	kind                      psTokenKind
	doubleQuoteSpans          int
	hasBackslashQuoteBoundary bool
	hasEscapedBareQuote       bool
}

type psDoubleQuote struct {
	text            string
	hasEscapedQuote bool
}

type psSegment struct {
	tokens       []psToken
	singleQuotes []string
	doubleQuotes []psDoubleQuote
}

// PowerShellTextProblem reports a refusal reason when a PowerShell command
// passes a POSIX heredoc to teamhub (invalid on all PowerShell versions) or,
// when powerShell51 is true, passes embedded double quotes in native teamhub
// arguments that Windows PowerShell 5.1 strips before teamhub reads them.
// Clean commands return "".
func PowerShellTextProblem(command string, powerShell51 bool) string {
	if !strings.Contains(strings.ToLower(command), "teamhub") ||
		(!strings.Contains(command, "<<") && (!powerShell51 || !strings.Contains(command, `"`))) {
		return ""
	}
	segments, hasUnquotedHeredoc := scanPowerShellSegments(command)
	var teamHubSegments []psSegment
	for _, segment := range segments {
		if hasPowerShellTeamHubInvocation(segment.tokens) {
			teamHubSegments = append(teamHubSegments, segment)
		}
	}
	if len(teamHubSegments) == 0 {
		return ""
	}
	if hasUnquotedHeredoc {
		return PowerShellHeredocMessage
	}
	if !powerShell51 {
		return ""
	}
	for _, segment := range teamHubSegments {
		for _, text := range segment.singleQuotes {
			if strings.Contains(text, `"`) {
				return PowerShell51QuotesMessage
			}
		}
		for _, item := range segment.doubleQuotes {
			if item.hasEscapedQuote {
				return PowerShell51QuotesMessage
			}
		}
		for _, token := range segment.tokens {
			if token.doubleQuoteSpans > 1 || token.hasBackslashQuoteBoundary || token.hasEscapedBareQuote {
				return PowerShell51QuotesMessage
			}
		}
	}
	return ""
}

func isPowerShellTeamHubWord(word string) bool {
	trimmed := strings.TrimRight(word, `/\`)
	if trimmed == "" {
		return false
	}
	if idx := strings.LastIndexAny(trimmed, `/\`); idx >= 0 {
		trimmed = trimmed[idx+1:]
	}
	return isBarePowerShellTeamHub(trimmed)
}

func isPSBoundaryByte(b byte) bool {
	return b == ' ' || b == '\t' || b == '\r' || b == '\n' || strings.IndexByte(";|&)+,}", b) >= 0
}

func skipPSHereString(script string, start int) int {
	if start+2 > len(script) || script[start] != '@' || (script[start+1] != '\'' && script[start+1] != '"') {
		return -1
	}
	closing := string([]byte{script[start+1], '@'})
	pos := start + 2
	for pos < len(script) && (script[pos] == ' ' || script[pos] == '\t' || script[pos] == '\r') {
		pos++
	}
	if pos >= len(script) || script[pos] != '\n' {
		return -1
	}
	pos++
	for pos < len(script) {
		if strings.HasPrefix(script[pos:], closing) {
			return pos + 2
		}
		nl := strings.IndexByte(script[pos:], '\n')
		if nl < 0 {
			return len(script)
		}
		pos += nl + 1
	}
	return len(script)
}

func skipPSSubexpression(script string, start int) int {
	i := start + 2
	depth := 1
	for i < len(script) && depth > 0 {
		ch := script[i]
		if ch == '\'' {
			i++
			for i < len(script) {
				if script[i] == '\'' {
					if i+1 < len(script) && script[i+1] == '\'' {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			continue
		}
		if ch == '"' {
			i++
			for i < len(script) {
				if script[i] == '`' && i+1 < len(script) {
					_, size := utf8.DecodeRuneInString(script[i+1:])
					i += 1 + size
					continue
				}
				if strings.HasPrefix(script[i:], "$(") {
					i = skipPSSubexpression(script, i)
					continue
				}
				if script[i] == '"' {
					if i+1 < len(script) && script[i+1] == '"' {
						i += 2
						continue
					}
					i++
					break
				}
				i++
			}
			continue
		}
		if ch == '`' && i+1 < len(script) {
			_, size := utf8.DecodeRuneInString(script[i+1:])
			i += 1 + size
			continue
		}
		switch ch {
		case '(':
			depth++
		case ')':
			depth--
		}
		i++
	}
	return i
}

func scanPowerShellSegments(script string) ([]psSegment, bool) {
	var segments []psSegment
	hasUnquotedHeredoc := false
	var current psSegment
	var tokenText strings.Builder
	tokenKind := psTokenBare
	tokenDoubleQuoteSpans := 0
	tokenHasBackslashQuoteBoundary := false
	tokenHasEscapedBareQuote := false
	inToken := false
	scriptBlockDepth := 0
	literalBraceDepth := 0

	flushToken := func() {
		if !inToken {
			return
		}
		current.tokens = append(current.tokens, psToken{
			text:                      tokenText.String(),
			kind:                      tokenKind,
			doubleQuoteSpans:          tokenDoubleQuoteSpans,
			hasBackslashQuoteBoundary: tokenHasBackslashQuoteBoundary,
			hasEscapedBareQuote:       tokenHasEscapedBareQuote,
		})
		tokenText.Reset()
		tokenKind = psTokenBare
		tokenDoubleQuoteSpans = 0
		tokenHasBackslashQuoteBoundary = false
		tokenHasEscapedBareQuote = false
		inToken = false
	}
	pushBareToken := func(text string) {
		flushToken()
		current.tokens = append(current.tokens, psToken{
			text: text,
			kind: psTokenBare,
		})
	}
	flushSegment := func() {
		flushToken()
		literalBraceDepth = 0
		if len(current.tokens) > 0 || len(current.singleQuotes) > 0 || len(current.doubleQuotes) > 0 {
			segments = append(segments, current)
			current = psSegment{}
		}
	}

	for i := 0; i < len(script); i++ {
		ch := script[i]
		if ch == ' ' || ch == '\t' || ch == '\r' {
			flushToken()
			continue
		}
		if (!inToken || strings.HasSuffix(tokenText.String(), "=") || strings.HasSuffix(tokenText.String(), ",")) &&
			(strings.HasPrefix(script[i:], "@'") || strings.HasPrefix(script[i:], `@"`)) {
			if end := skipPSHereString(script, i); end >= 0 {
				flushToken()
				i = end - 1
				continue
			}
		}
		if ch == '#' && !inToken {
			nl := strings.IndexByte(script[i:], '\n')
			if nl < 0 {
				break
			}
			i += nl - 1
			continue
		}
		if ch == '`' {
			if strings.HasPrefix(script[i+1:], "\r\n") {
				flushToken()
				i += 2
				continue
			}
			if i+1 < len(script) && script[i+1] == '\n' {
				flushToken()
				i++
				continue
			}
			if i+1 < len(script) {
				r, size := utf8.DecodeRuneInString(script[i+1:])
				if r == '"' {
					tokenHasEscapedBareQuote = true
				}
				tokenText.WriteRune(r)
				inToken = true
				i += size
				continue
			}
		}
		if ch == '\n' {
			flushSegment()
			continue
		}
		if ch == ';' || ch == '|' {
			flushSegment()
			if ch == '|' && i+1 < len(script) && (script[i+1] == '|' || script[i+1] == '&') {
				i++
			}
			continue
		}
		if ch == '{' {
			if !inToken && !hasPowerShellTeamHubInvocation(current.tokens) {
				flushSegment()
				scriptBlockDepth++
				continue
			}
			literalBraceDepth++
			tokenText.WriteByte(ch)
			inToken = true
			continue
		}
		if ch == '}' {
			if literalBraceDepth > 0 {
				literalBraceDepth--
				tokenText.WriteByte(ch)
				inToken = true
				continue
			}
			if scriptBlockDepth > 0 {
				scriptBlockDepth--
				flushSegment()
				continue
			}
			tokenText.WriteByte(ch)
			inToken = true
			continue
		}
		if strings.HasPrefix(script[i:], "$(") {
			pushBareToken("$(")
			i++
			continue
		}
		if ch == '(' || ch == ')' || ch == '+' {
			pushBareToken(string(ch))
			continue
		}
		if ch == '=' && inToken && tokenKind == psTokenBare && psVarNamePattern.MatchString(tokenText.String()) {
			tokenText.WriteByte('=')
			flushToken()
			continue
		}
		if ch == '&' {
			if i+1 < len(script) && script[i+1] == '&' {
				flushSegment()
				i++
				continue
			}
			// In PowerShell, bare '&' is the call operator (for example & teamhub ...).
			pushBareToken("&")
			continue
		}
		if strings.HasPrefix(script[i:], "<<") && !strings.HasPrefix(script[i:], "<<<") {
			flushToken()
			if loc := psPosixHeredocPattern.FindStringIndex(script[i:]); loc != nil {
				hasUnquotedHeredoc = true
				i += loc[1] - 1
				continue
			}
			i++
			continue
		}
		if ch == '\'' {
			var inner strings.Builder
			i++
			for i < len(script) {
				if script[i] == '\'' {
					if i+1 < len(script) && script[i+1] == '\'' {
						inner.WriteByte('\'')
						i += 2
						continue
					}
					break
				}
				inner.WriteByte(script[i])
				i++
			}
			innerText := inner.String()
			current.singleQuotes = append(current.singleQuotes, innerText)
			tokenText.WriteString(innerText)
			if !inToken {
				tokenKind = psTokenQuoted
			}
			inToken = true
			continue
		}
		if ch == '"' {
			if inToken && strings.HasSuffix(tokenText.String(), `\`) {
				tokenHasBackslashQuoteBoundary = true
			}
			var inner strings.Builder
			hasEscapedQuote := false
			i++
			for i < len(script) {
				if script[i] == '`' && i+1 < len(script) {
					r, size := utf8.DecodeRuneInString(script[i+1:])
					if r == '"' {
						hasEscapedQuote = true
					}
					inner.WriteRune(r)
					i += 1 + size
					continue
				}
				if strings.HasPrefix(script[i:], "$(") {
					subEnd := skipPSSubexpression(script, i)
					inner.WriteString(script[i:subEnd])
					i = subEnd
					continue
				}
				if script[i] == '"' {
					if i+1 < len(script) && script[i+1] == '"' {
						hasEscapedQuote = true
						inner.WriteByte('"')
						i += 2
						continue
					}
					break
				}
				inner.WriteByte(script[i])
				i++
			}
			innerText := inner.String()
			current.doubleQuotes = append(current.doubleQuotes, psDoubleQuote{
				text:            innerText,
				hasEscapedQuote: hasEscapedQuote,
			})
			tokenDoubleQuoteSpans++
			if i < len(script) && script[i] == '"' &&
				strings.HasSuffix(innerText, `\`) &&
				i+1 < len(script) && !isPSBoundaryByte(script[i+1]) {
				tokenHasBackslashQuoteBoundary = true
			}
			tokenText.WriteString(innerText)
			if !inToken {
				tokenKind = psTokenQuoted
			}
			inToken = true
			continue
		}
		tokenText.WriteByte(ch)
		inToken = true
	}
	flushSegment()
	return segments, hasUnquotedHeredoc
}

func hasPowerShellTeamHubInvocation(tokens []psToken) bool {
	i := 0
	sawCallOperator := false
	for i < len(tokens) {
		token := tokens[i]
		if token.kind == psTokenBare {
			if token.text == "&" || token.text == "." {
				sawCallOperator = true
				i++
				continue
			}
			if token.text == "(" || token.text == "$(" ||
				psPrefixKeywords[token.text] ||
				psEnvAssignPattern.MatchString(token.text) ||
				psVarAssignTokenPattern.MatchString(token.text) {
				i++
				continue
			}
			if psVarNamePattern.MatchString(token.text) &&
				i+1 < len(tokens) && tokens[i+1].kind == psTokenBare && tokens[i+1].text == "=" {
				i += 2
				continue
			}
		}
		break
	}
	if i >= len(tokens) {
		return false
	}
	target := tokens[i]
	if target.kind != psTokenBare && !sawCallOperator {
		return false
	}
	candidate := psVarAssignPrefixPattern.ReplaceAllString(target.text, "")
	candidate = strings.TrimPrefix(candidate, "$(")
	candidate = strings.TrimPrefix(candidate, "(")
	return isPowerShellTeamHubWord(candidate)
}
