package permission

import (
	"bytes"
	"strings"
	"testing"
)

// An Agent's Room message lost its prices: "$180/store/month" arrived as
// "80/store/month" because its shell expanded the empty $1.
func TestShellTextRewrittenFindsTextTheShellChanges(t *testing.T) {
	for _, command := range []string{
		`teamhub message send --content "Quote: $180/store/month, the separately itemized $450/store"`,
		"teamhub message send --content \"Run `npm test` before merging\"",
		`teamhub message send --content "${1} items"`,
		`teamhub message send --content Price:$5`,
		"teamhub message send --file - <<EOF\nPrice $180\nEOF",
		`teamhub message send --file - <<< "Price $180"`,
		`cd /tmp && teamhub task send --task-id workitem_1 --message "Keep $180" --steer`,
		`echo ok; teamhub room handoff --inbox room:room_1 --content "Budget $450"`,
		`/usr/local/bin/teamhub message direct --content "Spent $3 today"`,
		`printf '%s\n' "Price $180" | teamhub message send --file -`,
		"cat <<EOF | sed 's/a/b/' | teamhub message send --file -\nRun `x`\nEOF",
		`teamhub message send --content "$(printf '%s' "$1")"`,
	} {
		if !ShellTextRewritten(command) {
			t.Errorf("ShellTextRewritten(%q) = false, want true", command)
		}
	}
}

func TestShellTextRewrittenLeavesLiteralAndIntendedExpansionsAlone(t *testing.T) {
	for _, command := range []string{
		"teamhub message send --file - <<'EOF'\nPrice $180, run `npm test`\nEOF",
		"teamhub message send --file - <<\\EOF\nPrice $180\nEOF",
		"teamhub message send --file - <<\"EOF\"\nPrice `date`\nEOF",
		`teamhub message send --content 'Price $180, run ` + "`npm test`" + `'`,
		"teamhub message send --content \"Price \\$180, run \\`npm test\\`\"",
		`id=$(teamhub task create --name "Rivals" --json | jq -r .id) && teamhub task send --task-id "$id" --message "Go"`,
		`teamhub message send --content "Total: $TOTAL, exit $?"`,
		`send() { teamhub message send --content "$1"; }; send hello`,
		`awk '{print $1}' sales.csv | teamhub message send --file -`,
		`git commit -m "Price $180"`,
		`echo "$1" > note.md && teamhub message send --file note.md`,
		`teamhub message send --content "unterminated $1`,
		`teamhub message send --content "Done."`,
	} {
		if ShellTextRewritten(command) {
			t.Errorf("ShellTextRewritten(%q) = true, want false", command)
		}
	}
}

func TestShellTextHookRefusesWithTheReasonOnStderr(t *testing.T) {
	var stderr bytes.Buffer
	input := `{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"teamhub message send --content \"$180\""}}`
	if code := ShellTextHook(strings.NewReader(input), &stderr); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	if !strings.Contains(stderr.String(), "<<'EOF'") {
		t.Fatalf("stderr = %q, want the heredoc fix", stderr.String())
	}
	for _, input := range []string{
		`{"tool_name":"Bash","tool_input":{"command":"teamhub message send --content \"Done.\""}}`,
		`{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch"}}`,
		`not json`,
	} {
		stderr.Reset()
		if code := ShellTextHook(strings.NewReader(input), &stderr); code != 0 || stderr.Len() != 0 {
			t.Errorf("ShellTextHook(%q) = %d with %q, want 0 and no output", input, code, stderr.String())
		}
	}
}

func TestShellTextHookPowerShellAndPosixRouting(t *testing.T) {
	var stderr bytes.Buffer

	// PowerShell 5.1 embedded quotes are refused with PowerShell51QuotesMessage.
	ps51Blocked := `{"tool_name":"powershell","powershell_51":true,"tool_input":{"command":"teamhub message ask-user --title \"Pick\" --questions '[{\"question\":\"Where?\"}]'"}}`
	if code := ShellTextHook(strings.NewReader(ps51Blocked), &stderr); code != 2 {
		t.Fatalf("ps51 blocked exit = %d, want 2", code)
	}
	if strings.TrimSpace(stderr.String()) != PowerShell51QuotesMessage {
		t.Fatalf("ps51 blocked stderr = %q, want %q", stderr.String(), PowerShell51QuotesMessage)
	}

	// PowerShell 5.1 allows clean commands and here-strings.
	for _, allowed := range []string{
		`{"tool_name":"powershell","powershell_51":true,"tool_input":{"command":"teamhub message send --content \"Done.\""}}`,
		`{"tool_name":"powershell","powershell_51":true,"tool_input":{"command":"@'\n[{\"question\":\"Where?\"}]\n'@ | teamhub message ask-user --title \"Pick\" --questions-file -"}}`,
	} {
		stderr.Reset()
		if code := ShellTextHook(strings.NewReader(allowed), &stderr); code != 0 || stderr.Len() != 0 {
			t.Errorf("ShellTextHook(%q) = %d with %q, want 0", allowed, code, stderr.String())
		}
	}

	// PowerShell 7 refuses POSIX heredocs but allows embedded double quotes.
	stderr.Reset()
	ps7Heredoc := `{"tool_name":"powershell","powershell_51":false,"tool_input":{"command":"teamhub message send --file - <<'EOF'\nHello\nEOF"}}`
	if code := ShellTextHook(strings.NewReader(ps7Heredoc), &stderr); code != 2 {
		t.Fatalf("ps7 heredoc exit = %d, want 2", code)
	}
	if strings.TrimSpace(stderr.String()) != PowerShellHeredocMessage {
		t.Fatalf("ps7 heredoc stderr = %q, want %q", stderr.String(), PowerShellHeredocMessage)
	}

	stderr.Reset()
	ps7Quotes := `{"tool_name":"powershell","powershell_51":false,"tool_input":{"command":"teamhub message ask-user --title \"Pick\" --questions '[{\"question\":\"Where?\"}]'"}}`
	if code := ShellTextHook(strings.NewReader(ps7Quotes), &stderr); code != 0 || stderr.Len() != 0 {
		t.Fatalf("ps7 quotes = %d with %q, want 0", code, stderr.String())
	}

	// Bash and omitted tool_name remain routed to POSIX ShellTextRewritten.
	for _, posix := range []string{
		`{"tool_name":"bash","tool_input":{"command":"teamhub message send --content \"$180\""}}`,
		`{"tool_input":{"command":"teamhub message send --content \"$180\""}}`,
	} {
		stderr.Reset()
		if code := ShellTextHook(strings.NewReader(posix), &stderr); code != 2 {
			t.Errorf("ShellTextHook(%q) = %d, want 2", posix, code)
		}
		if strings.TrimSpace(stderr.String()) != ShellTextMessage {
			t.Errorf("ShellTextHook(%q) stderr = %q, want ShellTextMessage", posix, stderr.String())
		}
	}
}
