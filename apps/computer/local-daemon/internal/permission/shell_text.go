package permission

import (
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

// ShellTextMessage refuses a TeamHub command whose text the shell would
// rewrite before the CLI reads it.
const ShellTextMessage = "Not run: the shell would change this teamhub command's text before teamhub reads it. " +
	"In double quotes, an unquoted heredoc, or a bare word, $1 to $9 become empty, so \"$180\" arrives as \"80\", " +
	"and text in backticks runs as a command. Pass the text on stdin through the command's --file - " +
	"(or --requirement-file -, --message-file -, --prompt-file -) with a quoted heredoc, which keeps every character:\n" +
	"teamhub message send --file - <<'EOF'\nThe quote is $180/store; run `npm test` first.\nEOF\n" +
	"Put a short value such as a title in single quotes instead."

// ShellTextRewritten reports whether a POSIX shell command runs teamhub with
// text the shell rewrites before teamhub reads it: a positional parameter,
// such as the $1 of "$180", or a backquoted command, in an argument, a
// heredoc or here-string of the command, or in a pipeline stage that feeds
// it. An Agent's shell has no positional parameters and means backquoted
// text as Markdown, so either is a mistake there. Inside a function the
// parameters are its arguments, so functions are not checked. A command the
// parser cannot read is not judged.
func ShellTextRewritten(command string) bool {
	if !strings.Contains(command, "teamhub") || !strings.ContainsAny(command, "$`") {
		return false
	}
	file, err := syntax.NewParser(syntax.Variant(syntax.LangBash)).Parse(strings.NewReader(command), "")
	if err != nil {
		return false
	}
	rewritten := false
	syntax.Walk(file, func(node syntax.Node) bool {
		switch node := node.(type) {
		case *syntax.FuncDecl:
			return false
		case *syntax.BinaryCmd:
			if node.Op == syntax.Pipe || node.Op == syntax.PipeAll {
				stages := pipelineStages(node, nil)
				for _, stage := range stages {
					if runsTeamHub(stage) {
						for _, each := range stages {
							rewritten = rewritten || stageRewritten(each)
						}
						break
					}
				}
			}
		case *syntax.Stmt:
			rewritten = rewritten || runsTeamHub(node) && stageRewritten(node)
		}
		return !rewritten
	})
	return rewritten
}

// pipelineStages lists the statements of a pipeline in order.
func pipelineStages(command *syntax.BinaryCmd, stages []*syntax.Stmt) []*syntax.Stmt {
	for _, side := range []*syntax.Stmt{command.X, command.Y} {
		if inner, ok := side.Cmd.(*syntax.BinaryCmd); ok && (inner.Op == syntax.Pipe || inner.Op == syntax.PipeAll) {
			stages = pipelineStages(inner, stages)
		} else {
			stages = append(stages, side)
		}
	}
	return stages
}

func runsTeamHub(stmt *syntax.Stmt) bool {
	call, ok := stmt.Cmd.(*syntax.CallExpr)
	return ok && len(call.Args) > 0 && path.Base(call.Args[0].Lit()) == "teamhub"
}

// stageRewritten reports a rewrite in a simple command's arguments or in the
// heredocs and here-strings that feed it.
func stageRewritten(stmt *syntax.Stmt) bool {
	call, ok := stmt.Cmd.(*syntax.CallExpr)
	if !ok {
		return false
	}
	nodes := make([]syntax.Node, 0, len(call.Args)+len(stmt.Redirs))
	for _, arg := range call.Args[1:] {
		nodes = append(nodes, arg)
	}
	for _, redirect := range stmt.Redirs {
		if redirect.Hdoc != nil {
			nodes = append(nodes, redirect.Hdoc)
		} else if redirect.Op == syntax.WordHdoc {
			nodes = append(nodes, redirect.Word)
		}
	}
	rewritten := false
	for _, node := range nodes {
		syntax.Walk(node, func(node syntax.Node) bool {
			switch node := node.(type) {
			case *syntax.ParamExp:
				rewritten = rewritten || node.Param != nil && positional(node.Param.Value)
			case *syntax.CmdSubst:
				rewritten = rewritten || node.Backquotes
			}
			return !rewritten
		})
	}
	return rewritten
}

func positional(name string) bool {
	return name != "" && strings.Trim(name, "0123456789") == ""
}

// ShellTextHook is the shell-text-hook command, Codex's PreToolUse hook for
// shell commands and the check behind the Pi extension for both POSIX bash and
// Windows PowerShell calls. It reads the hook input on stdin and refuses a
// corrupted TeamHub command by exiting 2 with the reason on stderr. Any other
// input passes.
func ShellTextHook(stdin io.Reader, stderr io.Writer) int {
	var input struct {
		ToolName     string `json:"tool_name"`
		PowerShell51 bool   `json:"powershell_51"`
		ToolInput    struct {
			Command string `json:"command"`
		} `json:"tool_input"`
	}
	if json.NewDecoder(io.LimitReader(stdin, maxHookEventBytes)).Decode(&input) != nil {
		return 0
	}
	if strings.EqualFold(input.ToolName, "powershell") {
		if msg := PowerShellTextProblem(input.ToolInput.Command, input.PowerShell51); msg != "" {
			_, _ = fmt.Fprintln(stderr, msg)
			return 2
		}
		return 0
	}
	if ShellTextRewritten(input.ToolInput.Command) {
		_, _ = fmt.Fprintln(stderr, ShellTextMessage)
		return 2
	}
	return 0
}

// ShellTextHookTimeout is Codex's limit, in seconds, for one shell-text-hook
// run. Codex runs the shell command when the hook times out.
const ShellTextHookTimeout = 10

// CodexShellTextHooks is the Codex PreToolUse configuration that runs the
// Daemon's own executable as shell-text-hook for every shell command.
func CodexShellTextHooks(daemonExecutable string) []any {
	return []any{map[string]any{"matcher": "^Bash$", "hooks": []any{map[string]any{
		"type":    "command",
		"command": shellQuote(daemonExecutable) + " shell-text-hook",
		"timeout": ShellTextHookTimeout,
	}}}}
}
