package permission

import (
	"strings"
	"testing"
)

func TestPowerShellTextProblemBlocksPS51QuotesAndHeredocs(t *testing.T) {
	for _, command := range []string{
		`teamhub message ask-user --title "Pick" --questions '[{"question":"Where?","options":["A","B"]}]'`,
		`teamhub.exe message send --content 'He said "hi"'`,
		"& 'C:\\Users\\alice\\cli\\teamhub.cmd' message send --content \"He said `\"hi`\"\"",
		`& "C:\Program Files\Linger\teamhub.exe" message ask-user --title "Pick" --questions '[{"question":"A"}]'`,
		`teamhub message send --content "He said \"hi\""`,
		`teamhub message send --content "He said \"hi there\""`,
		`teamhub docs update doc_1 --command str_replace --pattern "He said \"hi there\"" --content "Done"`,
		`teamhub message ask-user --title "Pick" --questions "[{\"question\":\"hi\"}]"`,
		`teamhub message ask-user --title "Pick" --questions="{\"a\":1}"`,
		`teamhub message ask-user --title "Pick" --questions [{"question":"Where?","options":["A","B"]}]`,
		`teamhub message send --message {"segments":[{"type":"text","content":"hi"}]}`,
		`try { teamhub message ask-user --questions '[{"question":"A"}]' } catch { echo err }`,
		"teamhub message send --content `\"hello`\"",
		`teamhub message send --content "He said ""hi"""`,
		`(teamhub message ask-user --title "Pick" --questions '[{"question":"Where?"}]')`,
		"teamhub message ask-user `\n  --title \"Pick\" `\n  --questions '[{\"question\":\"Where?\"}]'",
	} {
		got := PowerShellTextProblem(command, true)
		if got != PowerShell51QuotesMessage {
			t.Errorf("PowerShellTextProblem(%q, true) = %q, want PowerShell51QuotesMessage", command, got)
		}
		if !strings.Contains(got, "$q") || !strings.Contains(got, "@args") {
			t.Errorf("PowerShell51QuotesMessage should warn about PowerShell variable assignment: %q", got)
		}
	}

	// POSIX heredocs are invalid on both PowerShell 5.1 and PowerShell 7.
	for _, command := range []string{
		"teamhub message send --file - <<'EOF'\nHello\nEOF",
		"teamhub message send --file - <<\"EOF\"\nHello\nEOF",
		"teamhub message send --file - <<EOF\nHello\nEOF",
		"cat <<-EOF | teamhub message send --file -\nHello\nEOF",
	} {
		for _, ps51 := range []bool{false, true} {
			if got := PowerShellTextProblem(command, ps51); got != PowerShellHeredocMessage {
				t.Errorf("PowerShellTextProblem(%q, %v) = %q, want PowerShellHeredocMessage", command, ps51, got)
			}
		}
	}
}

func TestPowerShellTextProblemAllowsSafeCommandsAndPS7(t *testing.T) {
	for _, command := range []string{
		`teamhub message ask-user --title "Friday team outing" --questions-file ./q.json`,
		`teamhub message ask-user --title="Friday outing" --questions-file ./q.json`,
		`teamhub docs create --title "Path: C:\"`,
		`teamhub message send --file "C:\work\" --content "hi"`,
		`teamhub message send --file ("C:\a\"+"b.md")`,
		`teamhub message send --content "Date: $(Get-Date -Format "yyyy-MM-dd")"`,
		`teamhub apps execute --connectionId c1 --toolSlug s1 --toolVersion v1 --arguments "{}"`,
		`teamhub apps execute --connectionId c1 --toolSlug s1 --toolVersion v1 --arguments {}`,
		`if ($ok) { teamhub message send --content "hi" }`,
		"(@'\nIt's fine\n'@) | teamhub message send --file -",
		`$body = "teamhub" + ' says "hello"'`,
		`$body="teamhub" + ' says "hello"'`,
		`$x = 'teamhub' -replace 'a', '"b"'`,
		`teamhub message send --content "Done."`,
		`teamhub message send --content ""`,
		`teamhub message send --content 'It''s fine'`,
		"@'\n[{\"question\":\"Where?\",\"options\":[\"Hotpot\",\"BBQ\"]}]\n'@ | teamhub message ask-user --title \"Pick\" --questions-file -",
		"@\"\n{\"a\":\"b\"}\n\"@ | teamhub message send --message-file -",
		"@'\nIn bash, use <<'EOF' for heredocs.\n'@ | teamhub message send --file -",
		`teamhub message send --content "In bash use <<'EOF'"`,
		`teamhub docs update doc_1 --command str_replace --pattern-file ./p.txt --file ./body.md`,
		`node -e 'console.log("ok")'; teamhub message send --content "Done."`,
		`Write-Output 'He said "hi"' | teamhub message send --file -`,
		`node -e 'console.log("hi")'`,
		"@'\nteamhub message send --content '\"hi\"'\n'@ | Set-Content a.txt",
		"$items = \"a\",@'\n{\"k\":\"v\"}\n'@\n$items | teamhub message send --file -",
	} {
		if got := PowerShellTextProblem(command, true); got != "" {
			t.Errorf("PowerShellTextProblem(%q, true) = %q, want empty", command, got)
		}
	}

	// PowerShell 7 preserves embedded double quotes in native arguments.
	if got := PowerShellTextProblem(`teamhub message ask-user --title "Pick" --questions '[{"question":"Where?"}]'`, false); got != "" {
		t.Errorf("PowerShellTextProblem(..., false) = %q, want empty", got)
	}
}
