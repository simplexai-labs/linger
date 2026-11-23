# TeamHub CLI

`teamhub` is the standalone Agent business client. It calls TeamHub directly; its configuration only selects the current identity and the caller Context, and TeamHub still checks live permissions on every request. Help and schemas work offline.

The caller Context comes only from `.teamhub/cli/config.json`, which the Computer writes into the workspace: for a Meta it is its Room, for an AlterEgo its Task, for a Document Context the current Document. The CLI sends it on every request; commands have no `--room` or `--task` target flags and no environment variable override. A command that needs a Room or a Task returns `configuration_error` when the configuration lacks that Context, and so does direct mode, which sets only `TEAMHUB_URL`/`TEAMHUB_TOKEN` without a configuration file.

```bash
teamhub --help
teamhub message send --help
teamhub docs update --schema
```

## Common operations

Pass a body directly with `--content`, or read UTF-8 with `--file <path>`; `--file -` reads stdin, such as a quoted heredoc (`<<'EOF'`), which keeps `$` and backticks as typed. A byte-order mark at the start of a file or stdin names the encoding rather than the text, so `--file` and `--file -` read it correctly, including JSON inputs. `docs update --command str_replace` and `docs comment replace` drop the line break that ends a file or heredoc, since their text replaces a run of text in place. `--json` returns business JSON.

```bash
teamhub message read --json
teamhub message read --message-ids <message-id-1>,<message-id-2> --json
teamhub message send --content 'The report is done.' --attach ./report.pdf --json
teamhub docs create --title 'Project report' --file ./report.md --json
teamhub docs list --json
teamhub docs list --shared --json
teamhub docs get <document-id> --format blocks -o ./working-copy.json --json
teamhub docs update <document-id> --command str_replace --pattern 'old text' --content 'new text' --json
teamhub docs replace <document-id> ./working-copy.json --json
teamhub docs comment reply <thread-id> --content 'Checked.' --json
teamhub room collaborate --file ./team.md --json
```

Messages go to the configured Room or Task by default; `--thread <thread-id>` picks a Thread in that Room, and `--alterego <task-id>` and `--meta <task-id>` are for permitted private collaboration. `message read --inbox` accepts `room:`, `thread:`, `task:`, `meta:` and `taskmeta:` addresses, so another authorized Room is read with `--inbox room:<room-id>`; a Meta reads a Task's public messages with `--inbox task:<task-id>`. Publishing files and submitting the message are one atomic operation. For complex ordered resources use `--message` or `--message-file` with an object holding the full `segments` array; private targets accept no uploads, media or segments. A structured mention in a message is written `[@name](user:actor_id)` or `[@name](agent:actor_id)`; a plain `@name` mentions no one.

`room collaborate` publishes the Room's `team.md` and `room protocol` reads the current one. A Room where none has been published yet, the normal state of a new Room, is not an error: `room protocol` prints that no protocol has been published, and `--json` returns `published: false` with `revision: 0`.

## Errors

A failure goes to stderr as `teamhub: <code>: <message>`, followed by `Command:` and `Target:` or `Context:` lines and one `Issue: <path>: <issue-code>: <message>` line per problem. `--json` prints the same content as `{"error": {"code", "message", "command", "target", "details"}}`, with the problems in `details.issues`. An input failure lists every problem at once (up to 10, then a count of the rest), each naming where it is (a flag, a field path inside a JSON flag such as `due_text`, or a file), what is wrong, and what is expected, so one corrected run is enough. `--help` lists the fields of a JSON flag such as `--item`: whether each is required or may be null, its type or values, and its limits.

The CLI shows the messages it writes itself as written. TeamHub's and connected applications' own wording is never shown: a TeamHub failure prints its code's fixed explanation, the field issues TeamHub returned, and its `Request ID:`. A malformed command line also prints the command's `Usage:` lines, an unknown flag lists the allowed ones, and an unknown subcommand lists the commands of its group.

The code says what kind of failure it is, and the exit status what to do next:

| Exit | Meaning                                     | Codes                                                                                                                                         |
| ---- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 2    | Fix the command or its input.               | `usage`, `invalid_input`, `configuration_error`, `target_ambiguous`, `account_ambiguous`, TeamHub's `invalid_request` and other input codes   |
| 3    | The current state conflicts; read it again. | `conflict`, `version_conflict`, `idempotency_conflict`, `tracking_item_conflict`, limits such as `task_limit_reached`                         |
| 4    | Not authorized, or waiting for the user.    | `unauthenticated`, `forbidden`, `authorization_required`, `provider_key_required`, `search_key_requested`                                     |
| 5    | Not found or not visible.                   | `not_found`, `tracking_item_not_found`, `connection_not_found`, `tool_not_found`                                                              |
| 1    | Anything else.                              | `connection_failed` (nothing was sent), `outcome_unknown` (a write may have happened), `internal_error` (a CLI bug), `dependency_unavailable` |

After `outcome_unknown`, run the same command again with the printed `--operation-id`; TeamHub returns the original result instead of writing twice. A Tracking Item write has no Operation ID: rerun `add` with the same `idempotency_key`, or run `tracking-items list` and compare the revision before repeating `update` or `done`.

`-` reads stdin only where a path is expected (`--file -`, `--item-file -`). The inline twin of such a flag, for example `--content` or `--item`, rejects a lone `-` with `invalid_input` instead of sending it as text.

## Documents and recovery

`docs update` changes only the given heading, text or block; do not simulate a partial edit with a full replacement. Block operations need real stable IDs. `str_replace` accepts only a unique, exact single-line match; a missing or ambiguous match or a moved anchor returns a conflict. `docs replace` saves only a Native blocks/HTML working copy that carries its original revision baseline; after a conflict, download to another path and reconcile. Plain file downloads have no Native save command.

An Agent reads, edits and manages every Document its Human has; no access request exists. `docs list --shared` returns only the Documents someone shared with this Agent, and each entry carries `shared_with_me`.

Write commands that accept `--operation-id` should use one unique ID per logical operation. The CLI keeps no local receipts: after an unknown outcome, rerun the same command and input with the operation ID the error printed, and TeamHub returns the original result. Without `--operation-id` every run is a new write. An operation ID does not replace CAS. `duplicate_request: true` means TeamHub reused the original result and comes with a `reason`; neither a conflict nor an unknown outcome is a success. When a Connected Apps write has an unknown outcome, check the external application first; the CLI never resends it.

A TeamHub write with an operation ID also reports `outcome_unknown` when its successful HTTP response has an interrupted, malformed, oversized, or non-object JSON body. The error preserves the same operation ID for a deliberate retry; receiving success headers alone does not cause the CLI to invent a result or resend the write. A successful `204 No Content` remains a complete empty result.

Task completion uses only the generation, attempt and input revision accepted before work started; Runtime-managed configuration freezes them. `task list` returns authorized summaries only; it does not replace the original Task input or refresh the submission baseline of an old result.

The current entry points are the ones help lists.

`agent list` and `agent get --agent-id <actor-id>` show the General Agents under a Sponsor. `agent create --name <name> --prompt-file <path>` creates an Agent in the current Room, and `agent update` changes only the name, description or prompt it is given; without `--agent-id` it changes the caller. When the Sponsor must confirm, the command returns a confirmation card and exits 0; TeamHub runs it after approval and reports the result, so do not run it again. `room invite --agent-id <actor-id>` adds an existing Agent from `agent list` to the current Room at once, with the Sponsor's authority; a Direct Room or Thread keeps its members. A Task context cannot use these commands.

`room handoff --inbox room:<room-id> --content <instruction>` lets Another Me, in its direct chat and in a turn its Human started by writing or deciding a card, hand that request to itself in another Room where both are members. TeamHub posts a hidden handoff there that wakes Another Me's Context in that Room, which then posts and mentions Agents itself; the direct chat never writes in that Room. Results come back with `message direct`.

```bash
teamhub room invite --agent-id <actor-id> --json
teamhub agent create --name 'Reviewer' --description 'Checks patches' --prompt-file ./reviewer.md --json
teamhub agent update --agent-id <actor-id> --prompt-file ./reviewer.md --json
```

## Windows Subsystem for Linux

When Pi runs the Desktop TeamHub CLI from WSL, use Linux paths directly for Room message attachments (`--attach` and JSON `content-path`), command input files (`--file`, `--prompt-file`), and `docs` file and image arguments. Quote paths with spaces. Message text is passed through as text.

Connected application commands may have their own file options. For those options, convert an absolute Linux path explicitly, for example `gdrive download ... --output "$(wslpath -w /home/me/report.pdf)"`.

## Connected applications

Nine applications have dedicated commands: Gmail, Outlook (mail via `teamhub outlook` and calendar via `teamhub outlook-calendar`), Feishu Mail (`teamhub feishu-mail`), Slack, Google Calendar, Notion, Google Drive, Figma and GitHub. `teamhub gmail --help` and `teamhub outlook-calendar --help` discover them offline, and each command keeps its own help, examples and Composio support boundary.
Choose an account with `--account <connection ID|full label>`; labels match case-insensitively, connection IDs exactly. A connection ID that no longer matches a delegated account returns `account_ambiguous` with the delegated candidates instead of switching accounts. Without a delegation, the command posts an authorization card in an allowed chat that names the requested label and exits with `authorization_required`; the Agent ends its turn, and the card's result wakes it to run the original command again.
Mail `--markdown` is converted to HTML by TeamHub; only `--attach` adds attachments.

Feishu Mail has the same verbs as Gmail, including `canvas-draft`, but TeamHub runs its tools itself instead of Composio, through the owner's own lark-cli on their Computer. Use these commands rather than lark-cli's own mail commands, which skip the sponsor's card. `send` and `reply` first save a draft and then send it, so the sponsor's card shows exactly what the draft holds. Attachments travel inside the call, about 640 KiB in total. Search text is at most 50 characters, and `list --folder all` needs `--query`, since Feishu lists one folder at a time.

GitHub reads the connected account, its repositories, issues and pull requests at once; `github comment` and `github create-issue` wait for the sponsor's confirmation card.

Other Connected Apps (such as Canva or Linear) have no dedicated commands and are called through `teamhub apps search/execute`. TeamHub runs the tools it knows as reads at once, including Linear's list, get and search tools and a `LINEAR_RUN_QUERY_OR_MUTATION` document that declares only queries; every other call waits for the sponsor's confirmation card.

`teamhub apps connect <app-key>` asks for access to any Connected App that supports Agent tools; without an authorized account it posts an authorization card in the current chat. `teamhub apps auto-reminders list|set` lists or toggles automatic reminders for the Sponsor's own connections.

## Web search

`teamhub web` searches the web and reads pages through providers whose API keys are saved once for the whole deployment, in TeamHub; keys never reach the Computer.

```bash
teamhub web search 'postgres 19 features' --recency month --site postgresql.org
teamhub web open https://www.postgresql.org/about/ --output ./about.md
teamhub web list
teamhub web connect tavily
```

- `web search <query>` runs on Tavily, Brave Search, Firecrawl, Exa, You.com or DuckDuckGo (`--backend`), with `--limit 1-20`, `--recency day|week|month|year` and repeatable `--site <domain>`; DuckDuckGo takes at most 10 results and one site. Without `--backend` it uses the default backend the user chose, else the first backend with a key in that order, else DuckDuckGo, which needs no key and blocks searches that come too often. You.com also works without a key when named, with limited, lower quality results. Results carry title, URL, snippet and an optional date, never the backend.
- `web open <url>` fetches the page from this computer by default (`--backend direct`) and converts its main content to Markdown; `--backend tavily|firecrawl|exa|you` reads it through the provider instead, which helps with pages that need JavaScript or block plain requests. The Markdown is cut at 20,000 characters with `truncated: true`, and `--output <file>` saves it to a new file and never overwrites one.
  Relative links and images use the page's first `<base href>` when it resolves to an HTTP(S) URL; otherwise they use the final page URL.
- `web list` shows each backend's commands, filters, readiness and live quota; `web connect <backend>` posts a key card unless that backend is ready.
- A backend never falls back to another one. When the requested backend, or the default one, has no key, a rejected key or no keyless searches left, TeamHub posts a key card in the chat and the command exits 4 with `search_key_requested`, the backend and the card in `details`. The Agent ends its turn: a key saved from the card reruns the request and wakes the Agent with its results. A used-up quota (`search_quota_exhausted`) or rate limit (`provider_rate_limited`) lists `ready_backends` to choose from.

Email canvases support Gmail, Outlook and Feishu Mail. New emails open in a
canvas and the Human sends from its card; replies keep the mail reply command.
`teamhub outlook canvas-draft` saves a canvas to Outlook without sending.
