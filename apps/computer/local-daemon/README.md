# Local Computer Daemon

This Go module is the resident Local Computer Daemon.
It carries the frozen Linger execution implementation needed for local process,
provider, workspace, and daemon lifecycle behavior while adapting all product
control through Linger's Runner Gateway.

## Ownership

- `internal/daemon`: daemon lifecycle and local reconciliation loop.
- `internal/process`: process ownership, cancellation, and cleanup.
- `internal/provider`: Codex/Claude/Pi/Antigravity execution adapters.
- `internal/workspace`: local workspace and Runtime-home preparation.
- `internal/protocol`: the Daemon's routed command/event model. The wire shapes
  come from the generated `contracts/generated/go/runnergateway` module
  (Runner Gateway protocol 2).
- `internal/linger`: Linger Gateway, device identity, process-instance lease,
  Registration, Context, Local MCP Relay, and Local Skill catalog adapters.

The Go daemon must not own TeamHub records, Agent scheduling, Context authority,
MCP policy, or Artifact publication. Those remain in TeamHub and Agent Service.

## Control CLI

`linger-computer` (`cmd/linger-computer`, implemented in `internal/computercli`)
is the local control CLI: `login`, `auth status`, `daemon
start|stop|restart|status|logs|runners|service`, `runtime check`, `doctor`, and
`version`. It reads the config through `internal/computerconfig`, talks to the
Daemon through `internal/linger/control`, and diagnoses Runtimes with the same
`internal/provider` discovery the Daemon uses. It starts the Daemon found at
`../daemon/linger-computer-daemon` beside its own bundle directory, or at
`LINGER_GO_LOCAL_DAEMON_PATH` during source development.

When `login` switches the Computer to another account, it deletes the previous
enrollment's state except `state/workspaces`. On Windows, a program can keep a
file open inside a state directory, for example an editor that an Agent opened
in a Context workspace. Windows then refuses to delete or rename that
directory. `login` leaves that directory in place, warns with its path, and
completes enrollment. The state files the Daemon opens at startup must still
be removed. `doctor --prune` is an explicit request to delete everything, so it
stops and names the open file.

## Current entrypoint

`linger-computer-daemon --config <path>` reads the owner-only config emitted by
the `linger-computer login` flow. It discovers and version-gates the
configured Codex, Claude, Pi, and Antigravity installations.
Each Runtime kind has one minimum version (`native.MinimumVersions`, Codex
0.166.0); an older installation is reported as `RUNTIME_INCOMPATIBLE` and never
runs, so the adapters do not branch on a Runtime's version. The localmodels kit
that installs the managed Runtimes reuses an existing one only at or above its
own baseline, which must not sit below these minimums. The desktop
distributions record both from the kit's release (`runtimeVersions`,
`runtimeBaselines`), and a Go test fails when either is below a minimum. Raise a minimum only
after a kit that installs a release at or above it ships in the desktop
distribution pins (`apps/desktop/distribution/*.json`).
The Codex canary workflow (`.github/workflows/codex-canary.yml`) runs the native
Codex compatibility tests daily against npm's newest stable Codex, because a
user's own newer Codex reaches the Daemon before any kit locks it. The
localmodels kit opens a lock update merge request for each new stable Codex at
least seven days old; it should merge only after the canary passes on that
version.
It performs bounded protocol and authentication probes.
A protocol probe passes once the Runtime answers the handshake, however the
process exits after its input closes. When the handshake fails, the daemon log
records `runner.runtime_probe.handshake_failed` with the exit status and the
redacted end of stderr; the diagnostic sent to TeamHub stays categorical.
It periodically refreshes authentication and unavailable Runtimes without a
restart. The daemon pauses those refreshes in the `upgrade-required`,
`authentication-failed`, and `identity-conflict` Gateway states.
The Claude check also probes idle Context homes, because each one can hold its
own refreshed login. It reconciles only the four most recently used homes and
runs `claude auth status` once per distinct credential, so its cost does not
grow with the number of Contexts. Only a definite logout in a Context home
changes the result. A slow or failed probe there, or a home the time budget
did not reach, leaves the Runtime ready; each Operation reconciles its own home
before Claude starts.

It opens owner-only local
identity/Registration/Assignment/Context/Operation stores, and connects only to
the configured Linger Runner Gateway. Runtime executable paths, process
environment, and physical workspace paths are resolved locally and never come
from an Operation wire request.

The Daemon pings the Runner Gateway connection every 10 seconds with WebSocket
control frames and drops it when no data or Pong arrives for 30 seconds, then
reconnects with the usual backoff, so a half-open connection never leaves Runs
waiting on TCP retransmission.

Opening the local Registration store deletes records of retired Runtimes such as
Hermes; connecting and reconnecting report Registration observations only for
Codex, Claude, Pi and Antigravity.

The owner-only control socket supports Runner inspection and local stop, plus
managed service start/list/stop. Managed services retain PID, process-group,
and start-token identity across daemon restarts, and stop succeeds only after
the recorded process group disappears.

## One-shot model calls

The Daemon accepts `execute` (kind `model_invoke`). `internal/daemon/model_invoke.go`
handles admission and a concurrency limit of 3 (beyond it the reply is `busy`;
`priority` only orders the Agent side's queue, and the Daemon accepts it without
distinguishing), cancels on disconnect and drain, loads a named Pi library model
on demand through `ensureLocalModel` (matching `run.start`), clamps reasoning
effort against the requested model, and checks before sending that
the encoded `executed` (kind `model_invoke`) fits the 4 MiB frame limit (otherwise
it reports `failed`). `internal/provider/model_invoke.go` and
`internal/provider/pi_model_invoke.go` run one `codex exec`, `claude -p`, or
ephemeral `pi` RPC turn in a temporary directory, passing the requested `model`
explicitly when supplied: the prompt goes through stdin, tools and
user customization are off, and it refuses workspace files at the root named
`AGENTS.md`, `AGENTS.override.md` or `CLAUDE.md` and anything under `.codex` or
`.claude` at any depth. `internal/workspace/codex_invoke_home.go` prepares a
temporary `CODEX_HOME` holding only an `auth.json` link, provider settings and
a seeded models cache (see below).
Claude uses the fixed `model-invoke/claude/.claude` under the state directory as
`CLAUDE_CONFIG_DIR`, so an OAuth login refreshed during a call is kept for the
next one. A model call does not enter the Operation ledger and takes no
execution slot.

A call that ends `failed` or `timed_out` is checked against the network its
model needs (`internal/daemon/model_network.go`), and reported `unavailable`
when this Computer cannot reach it, so the Agent side waits for the Computer as
it does for a disconnected one instead of spending attempts. The endpoints come
from the Runtime's own configuration (`internal/provider/model_endpoints.go`):
the active Codex custom provider's `base_url`, else Codex's `chatgpt.com` and
`api.openai.com` or the `chatgpt_base_url` and `openai_base_url` overriding
them; Claude's `ANTHROPIC_BASE_URL`, else `api.anthropic.com`; for Pi, the base
URL of the custom provider in `models.json` that its default model is on. The
call is unavailable only when none of them, nor the proxy `HTTPS_PROXY`,
`HTTP_PROXY` and `NO_PROXY` choose for each, accepts a TCP connection. A BYOK
gateway, whose endpoint the tool probes when it mounts, and a Runtime whose
endpoints are unknown, such as Pi on a built-in provider, need a route out of
the machine, tested with UDP sockets connected to documentation addresses,
which send nothing; local models need nothing. The check sends no data, waits
at most 3 s per connection, and never runs for a call that completed or failed
for another reason.

Codex's workspace mode turns off the shell and unified exec and keeps only the
code-mode host's `apply_patch`, with the working directory as the only writable
root. It therefore reads no files, and the Daemon appends the workspace files'
contents to the end of the prompt, because the `workspace-write` sandbox limits
writes but not reads. Codex feature disables use `-c`/`--config
features.<name>=false` rather than `--disable <name>` so a Codex release
ignores features it does not define instead of aborting on startup.

`go test -tags live_model_invoke ./internal/provider -run TestLiveCodex` runs one
structured call and one workspace call with the locally signed-in Codex (checking
that it writes the file and cannot read files outside the working directory). It
spends model quota and is not part of the default tests.

## Local models

The Daemon runs the model library of the installer's `localmodels` tool for
the Local models page. The Computer config's `local_models` section names the
tool: `python`, `module_directory` (the sealed kit, used as `PYTHONPATH` and
working directory), `state_directory` (`LOCALMODELS_STATE`) and
`base_directory` (`--base-dir`). From `state_directory`, the Daemon derives
sibling `tools` (`LOCALMODELS_TOOLS_DIR`), `bifrost`
(`LOCALMODELS_BIFROST_DIR`), and `bifrost-addr` (`LOCALMODELS_BIFROST_ADDR`).
The Daemon prefers the address in `<tools>/owned.json`. On start and apply
calls, it checks port availability on loopback and local interfaces before
choosing an unowned address. The default address is `127.0.0.1:18480`.
Gateway registration failures can rotate the unowned address for the next
attempt.

The Daemon clears inherited values for these `LOCALMODELS_*` variables before
setting them on tool calls. When the installer recorded a shared tools
directory in the sibling `tools-dir` file (a home whose plan was applied
before per-home isolation), the Daemon uses that directory, the Bifrost
directory and address its `owned.json` records, and its `gateway-home` Pi
profile. Otherwise, if the home lacks a per-home Bifrost ownership
record, the Daemon can locate a legacy gateway through the profile in
`model-source.json` in local mode or localmodels' default tools directory
(`~/.local/share/localmodels/tools`, under `USERPROFILE` on Windows).
It checks the legacy ownership record, any local-mode gateway URL, and the
Bifrost configuration for a provider registered by a loaded library model.
While that verification succeeds, the tool uses the legacy gateway and
local-mode Runtime discovery prefers its existing `gateway-home` Pi profile.

`packages/local-installation` writes the `local_models` config for the CLI
Computer. The Desktop app writes it for its own Computer. A Computer without
this config, or whose interpreter is gone, reports `available: false` with
`TOOL_NOT_INSTALLED`. `internal/localmodels` owns the tool calls; the Daemon
only routes `execute` (kind `local_models`) to it and sends what it publishes.
The Daemon executes the actions the Computer owner chose; it never picks a
model. The only action it takes on its own is loading, before a Run, the
downloaded model that Run's Agent names.

- Answer. Every action is answered `accepted` or `refused` with a
  `LocalModelActionRefusal`. `localmodels` checks every precondition before
  it starts work, so a download or load runs as a child process whose first
  event line decides the answer: a progress or result line accepts it, and an
  error line before any progress refuses it with the tool's code (unknown
  future codes degrade to `UNKNOWN_ERROR` rather than failing the action as
  `TOOL_FAILED`) and its `pool`, `need_bytes` and `free_bytes` (`have_bytes`
  for download refusals). Extended refusal codes (`GPU_UNSUPPORTED`,
  `DRIVER_UPDATE_REQUIRED`, `RUNTIME_DEPENDENCY_MISSING`, `UNKNOWN_ERROR`)
  are downgraded to legacy codes unless `runner.welcome`'s `service_features`
  names `local_models_diagnostics`. A job that exits without an event is
  `TOOL_FAILED`. `unload`, `remove` and `cancel` are answered when the tool
  finishes; `refresh` after a status read. If the command's `expires_at`
  passes before the tool decides, the Daemon sends no answer (the Gateway,
  waiting for the same deadline, reports the action as unconfirmed) and the
  outcome reaches the owner only through snapshots: an accepted job publishes
  its progress, and a late refusal publishes a fresh status read. Command
  handling runs off the connection loop.
- Before a Run. A Pi Run whose model is a library row's `pi_model` reaches
  the Daemon because the Pi catalog lists every downloaded library model
  (Pi catalog below), and waits until that model is loaded. A model no row of the last readable snapshot
  names (a BYOK or setup-stack model) costs no tool call and no wait; once
  the installer lock wait below has ended, neither does a model that
  snapshot shows loaded. Otherwise the Daemon reads the status once. A downloaded model that is `idle` or `failed` is loaded with
  `library load <model>` and never `--unload`, so the Daemon does not evict
  a model to make room: a load that does not fit is refused, and the Run
  fails with `local_model_unavailable` when the Agent Service's welcome names
  that service feature, else with `model_unavailable` for an older service;
  neither adds the model to the models a Runtime's login refused. A `loading` model, or one whose load the Models page
  just started, is waited for without a second load. `pi_model` is present
  only while the model is on the Computer; a `failed` row whose download
  stopped (`DOWNLOAD_FAILED`, `NETWORK_UNAVAILABLE`, `DISK_INSUFFICIENT`) is
  never loaded, and nothing is ever downloaded. The wait is bounded at 10
  minutes. A Run cancelled while it waits leaves the load running, so the
  next Run finds the model loaded, and concurrent Runs for one model share
  one load; a load that ended in failure while a Run queued behind it gives
  that Run the same error, but a Run whose own budget ran out does not. A
  model that is not in the library, or a status read that fails, lets the
  Run start as before.
- Installer lock. A quit starts the installer's stop after the app is gone;
  it cancels and unloads the library's models while holding the installer's
  local-models lock, `operation.sqlite` beside the tool's state directory
  (the installer's `localModelsLockFile` names the same file),
  and the installer's resume reloads the saved `runtime_model` under the
  same lock. A relaunch inside either window would read the models as still
  loaded, or start a second load. So once per Daemon, before the first Run
  decision for a library model, the Daemon takes and at once releases that
  lock (`BEGIN EXCLUSIVE` with no busy wait, then `ROLLBACK`), retrying
  every second while it is busy, for at most 3 minutes, and then reads the
  status afresh. A Run that arrives during a restore therefore waits for it,
  and the restore's load then shows as `loading`, which the Run waits on
  instead of starting another. A missing lock file, or one that is not a
  regular file of the current user, is not waited for. A restore that takes
  the lock only after the probe is not ordered; its load still shows as
  `loading` once it starts.
- Pi catalog. localmodels registers a model with Pi only while it is
  loaded, so after a quit Pi lists none of them, and with no model at all
  Pi asks for a sign-in. When Pi runs on the managed local models source
  (no saved source, or `local`; never `subscription` or BYOK) and is `ready`
  or `authentication_required`, the Daemon adds to the Pi diagnostic it
  reports every library row with a `pi_model` that is loaded, loading, or
  downloaded and loadable (not an interrupted download). A model Pi listed
  while it was loaded keeps that entry (label, reasoning effort, context
  window), remembered in `state/local-models/pi-catalog.json`; one Pi never
  listed gets its name, its context size and no reasoning effort. Until the
  library has been read, and while a read fails, the remembered entries
  stand in, so the first discovery and the hello already list them. Pi's
  own entries and its default model stay as Pi reports them and come first
  within the catalog bound (models are dropped past it, IDs over the bound
  are skipped, labels are clipped). A Pi diagnostic that is
  `authentication_required` only because its own catalog was empty is
  reported `ready` once library models fill it; a model call (`model_invoke`)
  on such a Pi, which names no model and finds none loaded, ends
  `runtime_unavailable`. Remembered entries are learned only from Pi's own
  catalog, and one goes when its row leaves the library. The runtime
  monitor probes from Pi's own result and adds library models only to what
  it publishes, so an authentication refresh neither keeps a merged model
  nor undoes the `ready`; its retain rules treat a Pi published `ready` this way like a natively ready one, so a probe that times out during a load does not report it failed. A remembered entry the catalog schema would refuse is dropped, never sent. A status read whose set of such models differs
  from the last one, including the first read that finds any and the first
  after a failed read, asks for discovery again.
- Jobs. A download or load runs in its own process group and writes its event
  lines to a file under `state/local-models/jobs`, which the Daemon tails, so
  a Daemon restart neither signals the job nor breaks its output. `cancel` is
  `library cancel <model>`; the Daemon never signals a job. Calls that print
  one document also write to files and a timeout kills only the tool process:
  a call may start or restart the local model gateway, which must survive.
- Restart. `localmodels` keeps job records on disk, so a restarted Daemon
  trusts `library status` and rereads it every 2 seconds while a download or
  load it did not start is running. A failed status read (including the first
  one after connecting) is retried with backoff up to one minute until a read
  succeeds, so a transient failure never ends the watch.
- Snapshots. `runner.local_models` carries `library-status/v1` mapped to
  `LocalModelsSnapshot` (pools gain `kind` and `gpu_index`, and keep the
  tool's `external_holders`, the closeable desktop apps it found holding that
  pool's memory, without their PIDs; `[]` stays `[]` for "none found" and an
  omitted field stays omitted for "not reported"; sent only when
  `runner.welcome`'s `service_features` names
  `local_models_external_holders` and stripped otherwise; the Models page calls only those "Other
  apps" and shows the rest of `used_bytes` beyond `holders` neutrally, since
  an engine can hold more than its catalog estimate). Structural and
  security invariants (`id`, unique model IDs, `fit`, `state`, `pool`,
  `pi_model` length, non-negative speeds, HTTPS `source_url`) still fail
  closed as `TOOL_FAILED`, while extensible display and diagnostic enums
  degrade gracefully so newer `localmodels` releases do not break the Models
  page: unknown `family` becomes `other`, unknown `architecture` is omitted,
  unknown `capabilities` are dropped and deduplicated, unknown
  `availability.reason.code` becomes `UNAVAILABLE`, unknown `error.code`
  becomes `UNKNOWN_ERROR` (with `cause`/`path` cleared; unknown `error.cause`
  is cleared), unknown `note.code` is dropped, unknown `download.step`
  becomes `download`, and unknown `pool.holders[].kind` becomes `component`.
  Optional model-card strings (`publisher`, `parameters`, `active_parameters`,
  `license`) and diagnostic metadata are clipped to contract bounds. Extended
  diagnostics (`GPU_UNSUPPORTED`, `DRIVER_UPDATE_REQUIRED`,
  `RUNTIME_DEPENDENCY_MISSING`, `UNAVAILABLE`, `UNKNOWN_ERROR`, `memory_kind`,
  driver/runtime fields) and optional `debug` metadata are sent only when
  `runner.welcome`'s `service_features` names `local_models_diagnostics` and
  are downgraded otherwise. Per-model inference engine fields (`engine`,
  `engine_label`, `concurrency`, `host_ram_bytes`) are sanitized forward-
  compatibly (unknown `engine` or out-of-range `concurrency` is omitted,
  `engine_label` is clipped) and sent only when `runner.welcome`'s
  `service_features` names `local_models_engine` (Computer 0.61.0 or later).
  The snapshot is sent after
  every welcome, after every action or job end, and at most every 2 seconds
  for progress. When a job enters the `download` phase, the Daemon publishes
  that progress line onto the current snapshot right away so refreshes do not
  see the stale `absent` state while `library status` runs, then rereads the
  status and applies the line on top; entering `verify`, `load`, or `warm`
  rereads the status first so pool use, placement, and unloaded models appear
  atomically before publishing. Later lines of the phase update that snapshot
  without another read.
- Error causes. `library status` keeps only a failed row's `code` and
  `detail`; the `cause` and `path` of a `GATEWAY_REGISTRATION_FAILED` reach
  the Daemon only on the job's error line (`GATEWAY_HOME_NOT_PRIVATE`: the
  gateway's private folder at `path` has another owner). The Daemon keeps them
  per model and puts them back on that row in every read while it still fails
  with that code; the model's next accepted job, or a row that moved on,
  drops them. They live in memory, so after a Daemon restart the row shows
  only its code.
- Pi. The Daemon aligns `PI_CODING_AGENT_DIR` on `localmodels` tool calls with
  the Pi profile Runtime discovery probes. When `<state>/model-source.json`
  exists (`byok`, `subscription`, or `local`), it isolates tool calls through
  the shared `localGatewayPiProfile` resolver (matching `OverlayEnvironment`
  for `local` mode): passing an existing managed `gateway-home/.pi/agent`
  profile (the verified legacy profile while models are loaded on that
  gateway, then `ToolsDirectory(stateDir)`, `stateDir`, and an explicitly
  configured legacy `gateway-home`), and omitting
  `PI_CODING_AGENT_DIR` otherwise so `localmodels` registers models into this
  home's `tools/gateway-home/.pi/agent` without colliding with `byok-home` or
  personal `~/.pi/agent`. Without an applicable legacy profile or
  `model-source.json`, tool calls follow `workspace.PiSourceEnvironment`
  on the base environment (excluding any stale `byok-home`). When a model is
  loaded on a Computer with Pi enabled and not yet installed, `internal/localmodels`
  installs the pinned Pi runtime asynchronously in the background under
  `HarnessRoot` (passing the bundled Node binary via `--node` when available,
  matching the installer's 2 m status/plan and 20 m apply budgets, and backing
  off from 30 s up to 5 m on failure while surfacing
  `RUNTIME_DIAGNOSTIC_FAILED` after a failed attempt) before asking the Runtime
  monitor for a full discovery, so TeamHub sees Pi become ready with the loaded
  model. Each model's `pi_model` (`<provider>/<id>`, as an Agent's
  `runtime_model` stores it) is passed through as `localmodels` reports it; the
  endpoint keeps only the loaded engine's `base_url`.

## Model source

`internal/localmodels/source.go` runs `localmodels source status|check|models|apply`
for `execute` commands of kind `model_source`, on their own goroutine so they
never block Operation commands; `apply` is serialized, maps timeouts to
`MODEL_SOURCE_TIMEOUT`, scrubs submitted BYOK API keys and recognizable
credentials (`redact.Text`) from tool error messages before they leave the
Computer, and logs structured refusal codes. Read-only `status`, `check`, and
`models` calls use 40 s budgets inside the Runner Gateway's 45 s timeout, and
`apply` fits inside a 165 s total budget under the Gateway's 180 s timeout
(giving `source apply` up to 150 s while reserving 15 s for synchronous
post-apply Runtime discovery, or up to 30 s when `source apply` finishes
earlier). Output decoding scans sequential JSON documents so
JSONL progress lines followed by pretty-printed JSON parse reliably. A BYOK key
reaches the tool on stdin, never in argv or logs, together with the address as
base URL, path and endpoint and the protocol the owner's client chose; `check`
sends one request there and `models` lists base URL + path + `/models`. The BYOK
summary carries `path` and `endpoint` only after a `runner.welcome` that names
the `byok_endpoint` service feature. `localmodels` writes
`<state>/model-source.json` without `runtime_paths`; on `source apply`, BYOK
`remount`, and installer `applySource`, the caller merges valid executable
non-harness paths from before the rewrite alongside any `runtime_paths` that
`apply` reported, without pinning paths inside `<home>/runtime/harness`. The
Daemon re-reads the file on every discovery tick to overlay the Runtimes'
environment (`OverlayEnvironment`) and executable paths (`OverlayRuntimePaths`),
scanning `<home>/runtime/harness/bin/<runtime>` and the highest-version
`<home>/runtime/harness/tools/<runtime>/<version>/<runtime>` on each read so
managed Runtime updates take effect without rewriting `model-source.json`. It
also drops any stale `byok-home` entry in `local` mode in favor of the managed
`gateway-home` Pi profile, never falls back to cloud models in `local` mode
(`agentRuntimeModel`), and under BYOK lists only the BYOK model in each
Runtime's catalog.

Before a Run or model call on a Runtime whose profile is the BYOK source's,
the Daemon checks the saved loopback gateway's `/health` (`EnsureGateway` in
`source_gateway.go`), off the admission lock. A gateway that does not answer,
because the endpoint was down when Linger started or a quit stopped it, is
mounted again with `source apply --mode byok` from the configuration
`localmodels` saved, serialized with `apply`; the kit probes the endpoint
first. A failed mount fails the Run before its Runtime starts, with the
public failure code of the tool's structured code: `BYOK_UNREACHABLE` and
`NETWORK_UNAVAILABLE` become `network_error`, `BYOK_AUTH_FAILED`
`authentication_required`; any other stays `execution_failed`. Model calls
answer `unavailable` for the two network codes, `auth_required` for
`BYOK_AUTH_FAILED` and `runtime_unavailable` for any other, with the tool's
code in the reason. Runs that waited for a remount that failed meanwhile share its
error instead of probing the endpoint again.

## Codex models cache

Signed in with ChatGPT, Codex blocks its first `thread/start` on a 4–5 s
download of the model catalog unless its `CODEX_HOME` holds a
`models_cache.json` fetched within five minutes. Every Context home, the model
session home (`model-invoke/codex-sessions/codex-home`), each one-shot call's
temporary home and the model-listing discovery probe's home are therefore
seeded by `internal/workspace/codex_models_cache.go`. It takes the newest
cache among the other Context homes, the model session home and the user's
source home that has the same `auth.json` account and the installed Codex
version, and writes it with `fetched_at` set to now. A home whose own cache is
still fresh is left alone. app-server refreshes the catalog online in the
background as soon as it starts, so the stamp only saves the blocking fetch.
API-key and signed-out homes have no account identity and are not seeded;
Codex does not fetch the catalog for them.

## Runtime system prompts

An Agent's instructions replace each Runtime's own system prompt, which would
otherwise tell the model it is a coding assistant and, for Claude, which Claude
model it is:

- Codex takes them as `baseInstructions`.
- Claude takes them as the initialize request's `systemPrompt`. Claude Code's
  own prompt lists Claude model IDs and names a Claude model, which a
  non-Claude model behind BYOK or a local model takes for its identity. Claude
  still sends its one-line Agent SDK preamble first. The Daemon ends the prompt
  with the working directory: Claude 2.1.322 also sends its environment
  (working directory, platform, date) as a separate system message, but an
  older supported release may put it only in its own prompt. The Claude
  settings also set an empty `attribution`, so Claude does not tell the model
  to sign commits and pull requests as Claude Code.
- Pi takes them as `--system-prompt`, which drops its built-in
  coding-assistant prompt, tool list and pointers to Pi's own docs.
- Antigravity appends them; see [Antigravity](#antigravity).

## Personal instructions

An Agent run follows only the instructions the Daemon gives it, never the
Computer user's own instruction files:

- Claude loads the Context's Skills through the `project` setting source,
  which would also load every `CLAUDE.md`, `AGENTS.md` and `.claude/rules`
  from the workspace up to the root, including the user's home. The Claude
  settings set `CLAUDE_CODE_DISABLE_CLAUDE_MDS`, so none is read.
- A Codex Context home takes the user's provider configuration but not their
  `AGENTS.md`, `AGENTS.override.md` or `instructions.md`; a copy an earlier
  projection left is removed. `instructions`, `developer_instructions`,
  `model_instructions_file` and `experimental_instructions_file` are dropped
  from the projected `config.toml` and its profiles.
- Pi runs with `--no-context-files`, and it always gets `--system-prompt` and
  `--append-system-prompt`, empty when there is nothing to pass, so it reads
  neither the user's `SYSTEM.md` nor their `APPEND_SYSTEM.md`.
- Antigravity is the exception: its ACP server has no switch that turns off
  the user's own rules, skills and `~/.gemini/config/mcp_config.json`, so an
  Antigravity run sees them next to the Daemon's instructions and servers.

The user's own Claude Skills and the Skills of plugins they installed are still
offered to Agents (`internal/workspace/claude_skills.go`).

## Shell text check

An Agent's shell rewrites text in double quotes, an unquoted heredoc, or a bare
word before a command reads it: `$1` to `$9` become empty and backquoted text
runs as a command, so `teamhub message send --content "$180"` sends `80`.
Before a shell command runs, the Daemon refuses a `teamhub` command whose
arguments, heredoc or here-string, or a pipeline stage that feeds it, hold such
text, and the refusal tells the Agent to pass the text on stdin with a quoted
heredoc (`internal/permission/shell_text.go`). Named variables such as `"$id"`,
`$(...)`, and the positional parameters of a shell function pass.

- Claude checks it in its tool policy, on both the PreToolUse hook and
  `can_use_tool`.
- Codex runs `linger-computer-daemon shell-text-hook` as a
  PreToolUse hook for every shell command. Codex on Windows runs PowerShell,
  so it gets no hook.
- Pi loads the managed extension (`extensions/pi-mcp.mjs`) for every Run. It
  runs the same hook before a `bash` call that names `teamhub` and holds `$` or
  a backquote.
- Antigravity is not checked: its permission request can only allow or reject
  a call, with no reason the Agent would read.

A hook that cannot run lets the command through.

## Antigravity

The Antigravity CLI (`agy`) runs through its Agent Client Protocol (ACP)
server, `agy acp`: JSON-RPC 2.0 over stdio, one object per line. Its print
mode (`agy -p`) is not used, because it signs in only with Google and waits
for a browser sign-in when signed out.

- Discovery runs `agy --version`, then an ACP `initialize`, then an empty
  `session/new` in HOME. ACP's authentication-required error (`-32000`) on
  `session/new` means signed out. No prompt is sent, so a probe stores no
  conversation.
- When `session/new` needs authentication and the environment carries
  `GEMINI_API_KEY` or `GOOGLE_API_KEY`, the adapter selects the
  `gemini-api-key` method once and retries. A Google sign-in is never
  replaced by a key.
- The model catalog is the session's `model` config option: one model per
  family. A family's reasoning efforts are the levels its
  `<family>-<level>` entries in `availableModels` name. A Run selects them
  with `session/set_config_option` (`model`, then `thought_level`).
- Each Operation runs in its own `agy acp` process; nothing is parked. A
  first Run opens `session/new`, and its turn-started event reports the
  session id as the checkpoint, like a Codex thread. Later Runs reopen it with
  `session/load` and drop the history it replays. An id Antigravity has not
  stored is not a usable session: `session/load` accepts it, but the prompt
  then fails, so Linger never assigns one. A stored session replays at least
  the prompt that made it, so a load that replays no prompt, or that
  Antigravity refuses, finds no session and returns `session_not_found` so Agent
  Service can clear the persisted session and restart the Run cleanly in a fresh
  native session with recent messages. A resumed Run still reports its
  turn-started event before `session/load`, because loading takes seconds
  and the Room shows the Agent working from that event. A Run yields to
  the scheduler only after native work, because its session holds no prompt
  before that.
- On a fresh `run.start` that names `previous_session` (Computer 0.63.0 or
  later), the provider executor reads the superseded native session through
  `runtimehistory`, writes a bounded, redacted Markdown tail to
  `./playground/.previous-context.md`, and appends that path to the turn's
  `<system-reminder>` only when the file was written.
- A tool call is named by Antigravity's own tool name, such as
  `run_command`; its title is the whole command line, which the call's
  redacted input already shows.
- `run_command` moves a command that outlasts its `WaitMsBeforeAsync` to the
  background and ends the turn with `end_turn`. Once the command finishes,
  Antigravity continues on its own with no new prompt. The process stops when
  the Run ends, which would kill the command and lose the reply. So a turn
  that ends with an open tool call keeps the Run open. The Run ends once no
  tool call is open and the session has sent nothing for 15 seconds. ACP has
  no event for the end of such a continuation. If `agy` exits during the wait,
  the Run fails. The wait ends after 30 minutes, because a backgrounded
  server never finishes and a Run has no time budget.
- The Run's reply is its last text message, even when tool calls follow it,
  because Agent Service reads the reply from the stream the same way.
- The Daemon's instructions go in `_meta.antigravity.systemPrompt.append`, and
  its MCP servers in the session's `mcpServers`.
- `session/request_permission` goes to the Run's permission review when the
  Context has one, with `execute` calls reviewed as shell commands from
  `rawInput.CommandLine`. A completed `run_command` whose `rawOutput.exit_code`
  is not zero finishes as failed. Otherwise
  the adapter selects the allow option, as the Runtime runs with the Agent's
  full local authority.
- Antigravity reports a model error, such as a rejected API key, as reply text
  and ends the turn with `end_turn`. With no structured signal, such a Run
  completes and the Room shows the text.
- History reads, provider prepare, Local Skill scans and local models do not
  support Antigravity, so Agent Memory skips Antigravity Agents.
- The Gateway hello leaves out the Antigravity diagnostic while `agy` is not
  installed, so such a Computer still connects to an Agent Service released
  before Antigravity support. When `agy` is installed later, the next
  diagnostics update reports it and the Gateway adds its Runtime
  Registration, so no restart is needed. Once `agy` is installed, the Agent
  Service must run this release first. The control API and `runtime check` keep reporting
  Antigravity as not installed.

## Frozen source

The daemon implementation is intentionally maintained as a frozen in-repository
snapshot. It does not implement automatic upstream updates; changes are reviewed
and versioned as part of the Linger Computer daemon.

## Windows host boundary

On Windows a named pipe private to the current user carries the same HTTP control
interface. The pipe name comes from the state directory's absolute path, with
forward slashes, as a lowercase SHA-256 digest. Private files are checked against
the current SID and ACL, not POSIX permission bits. Writing a separate credential
does not change the permissions of an existing parent directory.

The installer and the Daemon refuse a private path when another account can
replace one of its parent directories. One exception applies: the Codex Windows
sandbox may hold that right on a parent, such as AppData. The sandbox acts
through the `CodexSandboxUsers` group and the capability SIDs in
`%USERPROFILE%\.codex\cap_sid`. A sandboxed Codex command can therefore replace
such a parent; Linger accepts this so it installs beside Codex. Private paths
themselves still grant access only to the current user and SYSTEM. Their
owner is the current user or, when that user is an administrator,
Administrators, which owns what an elevated process (Run as administrator,
the built-in Administrator) creates.

Process recovery uses the creation time and a held process handle, so a reused
process ID is never mistaken for the original. Ordinary tasks are held by a Job
Object; managed services are held by a separate supervisor process. An upgrade
must keep the old program directory that still hosts a supervisor.

`linger-computer-daemon.exe platform` reads one JSON request from standard input.
`action` selects a file-permission, process-recovery, service-cleanup or Runtime
diagnosis operation. Standard output returns only JSON; errors go to standard
error with a non-zero exit code. This entry does not start the Daemon, and
credentials never appear in command arguments.

Run native acceptance from the repository root with
`scripts/check-local-computer-windows.ps1`. Its fixtures cover ACLs, named pipes,
process trees, managed services and the three Runtime protocols. A cross build
only shows that the source compiles; it does not replace native Windows
acceptance. Multi-line arguments that the generic batch launcher cannot express
fail explicitly. The official npm launcher calls Node directly; prompts still go
through the standard-input protocol.

## Controlled desktop and browser tools

Each Operation with installed drivers exposes two Model Context Protocol (MCP)
tools, `computer.ui_exec` and `computer.ui_reset`. The Daemon keeps the native
desktop service and the Playwright browser service private. Only the public
entry appears in the model's tool catalog. Each nested action keeps its original
permission check, arguments, evidence collector, operation lease and receipt.

`ui_exec` runs an async JavaScript function body. The bundled Node child hosts
QuickJS compiled to WebAssembly. A separate engine compiles the script. The
execution engine has no filesystem, network, process or module loader, and it
rejects dynamic code evaluation. The Daemon limits memory, runtime, call count
and output. Only the explicit `state` object is intended to persist between
calls within one Operation. An uncaught script error resets `state`, so a
script catches the failures it expects. `ui_reset` discards this state and image handles.
Applications and action records survive a reset. An unknown write outcome
blocks further writes to its driver in this Operation. Every `ui_exec` and
`ui_reset` result lists the Operation's unknown actions. Retained images share
a 12 MiB budget; once it is spent, an action returns a text note in place of
its image until `ui_reset`, so a completed action never reports an error.

Use `await ui.page(url)` for a managed browser and `ui.window(pid, window_id)`
for a macOS window. Use `ui.computer.list_windows({app: appName})` to discover
a named window and check its title. `await target.observe()` returns the visible
text and actions. Call `view.click(role, name)` on that observation and use its
returned view for the next step. A newer driver call in the same namespace
expires the previous observation. In a browser, `view.fill(fields)` resolves
all named fields against one observation before sending the driver call. If an
action has no browser snapshot, the helper obtains one. Use `ui.help("browser")`
or `ui.help("computer")` for the underlying methods. `ui.emit(result)` selects
text or native images for the model; the script receives opaque image handles.

The public tool allows ten minutes. The default script budget is 165 seconds,
with up to nine minutes per call. Nested calls reserve time to return their
receipts. Cancellation stops scheduling actions; an already dispatched action
can still complete within its hard deadline. After a script error, inspect the
returned receipts and current state before taking another action.

After actions such as click and type, Playwright
writes the page snapshot to a file and returns only a link; the Daemon reads the
file, puts the snapshot back into the result and deletes the file, so the model
need not call `browser_snapshot` again. Only links under `.linger/browser-output/`
are replaced.

A Codex Context home receives the public entry as a URL server in its projected
`config.toml`, together with `mcp_oauth_credentials_store = "file"`. Codex
otherwise reads the OAuth credentials of every URL server from the OS keyring,
and on Linux a session bus whose Secret Service never answers blocks the turn
until the Run times out. The managed servers never use OAuth, and the setting
applies only to that runtime home, not to the user's own Codex home.

The tool catalog is cached per Computer installation; an Operation's tool service
expires as soon as it closes. After connecting to the Runner Gateway, the Daemon
discovers the catalog once in the background so the first run does not wait. On
macOS this starts the CuaDriver service in the background without requesting
system permissions or taking the foreground; an Agent that never uses the
computer tools pays only this one background start. Preparation only reads the
catalog; it opens no pages and sends no input.

macOS uses the signed CuaDriver.app. The Computer starts the service with the
automatic permission wizard off and sets `CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS` to
0: by default Cua waits up to 1 second after each action for a window change,
adding 0.3–0.4 seconds to every click and key press, and the Agent reads the
window itself after a series of inputs. The service directory is a hash of the
state directory and driver path, and its `environment` file records the
service's start environment; when that differs from the current version, the
Daemon stops the old service before starting the new one. The Daemon takes the
service's pid from the socket peer rather than a file in /tmp, which macOS cleans
after 3 days unused.

On one computer, a desktop call holds the screen and clipboard until it ends, and
other tasks' desktop calls queue. Browser calls run in lanes of their own, one
per Agent: the tasks of one Agent take turns in its browser, and different
Agents' browser calls run at the same time as each other and as desktop reads.
A desktop input that needs the front window or the clipboard waits for the
browser calls in flight. From the moment it starts waiting, new browser calls
wait for it, because a browser call can bring Chrome forward or copy and paste
in the page. A browser call holds its turn until it returns, so one long call,
such as a slow navigation or `browser_wait_for`, delays the waiting input and
with it every Agent's next browser call. These inputs are keys and text, foreground and modifier clicks,
double-clicks, which may fall back to the front app, drags, cursor moves,
scripts, batches, app launches, bringing a window to the front, window moves,
the clipboard tools, all native Linux input, every Windows input, and text
recognition on Windows or when it pages on macOS. A
macOS background click, right-click or scroll to a known app runs beside
browser calls, unless the app is a Chromium browser other than the Computer's
own Chrome. A queued call that is cancelled returns
`COMPUTER_BUSY` without sending input. `check_permissions` only reads permissions
and never requests them, and the permission answer must come from the Cua service
itself. Only the owner's Request on a permission card asks macOS: the Daemon runs
`cua-driver permissions grant` in the background, one at a time for at most 10
minutes, because CuaDriver refuses to prompt from its tools.

`launch_app` opens an application, with an optional file or URL, in the
background through LaunchServices without taking the foreground. With a file or
URL it waits for a new window or 5 seconds; without one it returns at once if the
application already has a window. The result lists the application's pid and
windows, marking new ones.

On macOS, key input means `press_key`, `hotkey` and `type_text` without an
`element_token` or coordinates. With only `pid`, keys go to that application's
current focus, as a person typing would. If the application is not frontmost, the
Daemon activates it once and sends keys through Cua's desktop session. With
`window_id` as well, that window must be the application's focused window, and
keys use Cua's exact-window foreground delivery; otherwise the call returns
`COMPUTER_INPUT_NOT_SENT`, names the window in front and suggests `bring_to_front`
first. When the application is already frontmost, the Daemon does not raise any
of its windows again, since re-raising would end a rename field or close a menu.
On macOS the key tools take no `scope` or `target`; `delivery_mode` applies only to
input with an element or coordinates.

Cua's `z_index` does not follow window switches inside an application, so the
Daemon tracks each application's focused window itself. After `bring_to_front`
confirms the foreground, or after the Daemon activates an application, it records
that window and all of the application's windows at that moment. A window that
appears later with a higher layer counts as frontmost, such as a new document, a
form or a panel. A new window with a title counts as frontmost even at a lower
layer, because TextEdit restores old documents at launch and Cua may give the new
one a lower layer than theirs; a new window without a title must have a higher
layer, because Finder briefly shows untitled windows. When activating a
background application, the Daemon brings along the window of that application
the Agent named last.

The Daemon remembers the application it raised last. When the user brings
another application forward, key input returns `COMPUTER_USER_TOOK_OVER` and the
Daemon does not take the foreground back. Before every key and every 16
characters of text, the Daemon checks the frontmost application; if it changed
midway, it stops and returns `COMPUTER_INPUT_PARTIAL` with the number of
characters typed.

`type_text` with only `pid` first asks Cua to insert into the focused element
through Accessibility, bypassing input methods and auto-capitalization. When Cua
refuses, for example with several Finder windows or focus in a save panel, the
Daemon writes the text to the clipboard and sends `cmd+v` to the frontmost
application. Before pasting it saves the whole clipboard and restores it 200 ms
after the paste, unless someone changed the clipboard in between. It also
restores on cancellation; saving and restoring each have a 5-second limit that
cancellation does not shorten. A file the Agent copied in Finder before typing a
path therefore stays on the clipboard. No browser call runs during the paste.

A single macOS input tool reports only whether the input was delivered;
`run_actions` reads the window once after the last step. When a Finder list row
refuses `double_click`'s AXOpen, the Daemon brings the application forward and
double-clicks again, as a person would; if that still fails, the error suggests
`click` plus `cmd+down`. A click with a `modifier`, such as cmd-click to
multi-select in Finder, uses foreground delivery, because Cua holds modifier keys
only for foreground events. A `type_text` right after a shortcut in the same batch
waits 300 ms first, for cmd+shift+n or cmd+shift+g to open its field. An AX click
on a menu bar title (`AXMenuBarItem`, such as File) opens the menu, and the
application takes no other input until the menu closes; the Daemon then adds a
hint to click a menu item from the window read, or to press escape with only
`pid`. The tool descriptions also tell the model that cmd+delete on a file
selected in the Trash puts it back, and that context menus do not appear in
window reads.

The Agent calls `get_window_state` once at the end of a series of inputs, with
`since:"latest"` to see the effect. `get_window_state` may take only `pid`; the
Daemon then reads that application's focused window, such as a panel that just
opened. Choosing the focused window skips windows that are off screen, such as a
save panel's accessory view. When the focused window has no readable
accessibility tree, for example a save panel that forms an empty window of its
own, the Daemon reads the application's most recently used window instead, which
holds the panel in its tree; it does the same when the chosen window just closed,
such as the Go to Folder panel after Return.

A read without `max_elements` walks at most 500 nodes; Cua's default of 250 cuts
off deep files once Finder expands subfolders. The tool descriptions ask for
`max_depth:3` on save and open panels, where every control sits, because a deeper
read walks the panel's file list. Every Cua call writes one `cua.call.timing` log
with the raise, the Cua request and the total time. On Windows, after a successful
input with `pid` and `window_id`, the Daemon still reads that window's text diff
and appends it to the result. When the Agent calls `get_window_state` itself,
macOS reads text only, with no screenshot by default.

A read without `timeout_ms` gets a 4000 ms walk budget for the accessibility tree: Cua's own 1000 ms cuts a browser page of a thousand nodes, and a cut tree counts as unreadable.
A screenshot is attached only when the Agent passes `include_screenshot: true`. When a window's tree cannot be read, the Daemon waits 400 ms and reads the text again with a 6000 ms budget, and only then reads once more with a screenshot.
Screenshots become JPEG of the same size before they reach the Runtime: the Runtime resends earlier screenshots every turn, so a 1 MB PNG slows every later turn. Coordinate clicks keep the same pixel grid.
macOS also offers `run_script`: Cua runs one JavaScript program in a single call, with loops, waits, reads and input inside the driver, and returns only its value to the model.
The Daemon admits only background, output-file-free scripts, fits the time limit into the call's remaining time, and cuts the result to its text: the first and last call-log lines and 40000 characters, with no screenshots.
On macOS, `click` takes `delivery_mode: "foreground"` and `action`: the first for web controls that react only to a real pointer, the second for accessibility actions such as `show_alternate_ui`.

The macOS and Linux developer instructions identify the public entry. Codex
calls the public tools directly, outside code mode and deferred tool search.
Web tools depend on the link the Runtime reaches its model through
(`RuntimeModel.Link`). On a vendor subscription, Claude Code keeps `WebSearch`
and `WebFetch`, deferred behind `ToolSearch`, so its developer instructions name
them and how to load them; Codex keeps its own `web_search`. Both are told to
use their own tools first and, when those fail, `teamhub web search` and
`teamhub web open`, which search and read through the search providers the user
set up, or DuckDuckGo without a key. On an API link, an endpoint and key set up
in the Runtime's own configuration, provider-hosted search may not run, so the
instructions name `teamhub web search`, `open` and `list` and tell the model to
use them instead of its own web tools. A Runtime whose profile is a
localmodels-managed gateway profile (local models or BYOK, see
`localmodels.GatewayRuntime`) is on an API link that cannot run provider-hosted
search at all: Codex launches with `web_search="disabled"` after every user
override, Claude's `--tools` leaves out `WebSearch` and `WebFetch`, and the
instructions name only the `teamhub web` commands. Pi has no web tools of its
own and always gets that `teamhub web` line. Without a TeamHub CLI for the
Agent, only Claude's own tools are named. A parked Codex process launched with
the other web setting is not reused.

On macOS these tools show only the fields the Computer routes. They hide Cua's `scope` and `capture_id`; only `click` takes `delivery_mode`, as described above.
Within `ui_exec`, scripts can call individual input methods. An input to a
specified macOS window includes its next observation. Browser actions return
a snapshot without Playwright's generated code transcript.
`run_actions` sends each step as its own driver call, in order and without pauses, and stops at the first failed step.
On macOS it reads the window after the last step and returns the full tree
when available. By default it reads the last step's window, or the
application's focused window when that step gave no `window_id`; pass `read` to
read another window or add a `query`. When a step is refused or its result is
unknown, the result lists the completed, unsent and possibly applied steps.
An `element_token` from an older read is refused, never rebound to another element with the same role and label. A step can name its target by role and name instead; the Daemon finds it when the step runs, and white space in a label, such as a no-break space, matches any white space.
On Windows, after a successful input the Daemon waits 100 ms before reading the
window diff, because Cua already waits for its own read-back after input. The MCP
initialize result carries no usage instructions, because Codex prepends them to
every tool description and the model's tool listing would be truncated.

When the default browser is not Chrome, the local browser uses a separate Agent
profile directory, stored under `computer-tools/browser-profiles/` in the state
directory. Cua can observe the native Chrome window that Playwright connects to.

On macOS, `launch_app` with `agent_browser: true` opens the Computer's own
browser window for a site that watches for automated browsers. The Agent drives
it only with the computer tools, never through Playwright or a debugging port.
In Chrome it is a window of the Computer's own in the user's everyday Chrome,
with the user's sign-ins, history and device trust. The window opens through
Chrome's command line, one site per call, so no key reaches the user's other
windows. A covered window keeps working only when Chrome runs with
`--disable-backgrounding-occluded-windows`, which Chrome reads only when it
starts. A Chrome that is not running starts with it. A Chrome the user started
without it is used as it runs: Chrome freezes the Computer's window while
another window covers it completely, so `launch_app` sets
`pauses_when_covered` and tells the Agent to ask the user to leave part of the
window uncovered when a page stops changing. The Daemon never quits the user's
Chrome and never asks the user to, because a quit loses text typed into a page
and not yet sent. After a start, before the Computer opens its window, it
waits until the list of Chrome windows stops changing, so every restored
window is there. The Computer's window is the new
window with one tab: the one whose address bar shows the site just opened, or
the only new window when the home page moved to another site. Two or more new
one-tab windows that the site does not tell apart are refused with
`COMPUTER_WINDOW_AMBIGUOUS`. Every window the Computer opened there stays its
own for pacing and the key rule, until Chrome restarts. The address bar and
the tabs are found by role and place in the window, not by their names, which
follow the user's language. The Daemon finds the running Chrome by its
executable wherever the app is installed. The user's Chrome takes no keys from
the Computer (`COMPUTER_KEYS_REFUSED`), in any of its windows, in tool calls,
`run_actions` steps and scripts: a shortcut
runs as a menu command in the Chrome window that has the keyboard, and Cua
types text as keys that all read as the A key. A key named by its
`element_token` goes to the app the token was read from, and a key that names
no app is refused while that Chrome runs. Not even Return bound to a search
box goes: Cua refuses a background key while its app has another window, and
the user's Chrome always has one. A script's guard refuses a key whose
arguments name an app or window of their own, and no script opens an app or
URL, so the key rule knows every app a script reaches. The Agent fills fields
with `set_value`, presses the page's buttons and goes back through its links.
The Daemon removes the separate Chrome profile `computer-tools/agent-chrome`
when it starts, after quitting the Chrome that still runs on it.
Edge and Firefox each run as a separate instance with their own profile under
`computer-tools/agent-<browser>` in the state directory, so the user signs in
there once. Safari cannot run a second profile; the Computer uses its own
window in the user's Safari. Without a `bundle_id`, the Daemon picks the first
installed of Chrome, Edge, Firefox and Safari.
It opens a site only at its home page and refuses any other web address with
`COMPUTER_HOME_PAGE_ONLY`: the Agent reaches a search, listing or item through
the site's own search box, menus and links, as a person does.
Input to that browser is paced: 150 to 400 ms between inputs (100 to 250 ms inside a script; typed text 8 ms per character; one script `cua.sleep` at most 1.5 s), at most 300
inputs per task and 1500 per day, and at most 20 inputs per `run_script`.
`report_blocker` with the page URL stops
the task; `rate_limited` also puts the site (its registrable domain) in a
60-minute cooldown. The record lives in `computer-tools/agent-chrome-pace.json`.
Once a task opens a site there, the browser tools refuse that site for the
rest of the task, and `launch_app` refuses to open it in another browser.
A change of the front tab between the task's inputs that also changed the
number of tabs refuses inputs there with `COMPUTER_TAB_CHANGED`, because they
could reach another page, until the Agent reads the window with
`get_window_state`; it goes on only when the front tab is its page. A tab its
own input opened late, after the reads that followed the input, looks the
same, so the task is not stopped, and the next input is held to the tabs the
window shows then. The Daemon reads the tab strip before an input
only when the window's title in `list_windows` differs from the front tab's
title after the last input, so a tab opened or closed behind the front tab
does not stop the task: the input still reaches the task's page, and its
result reports the new count without saying the input changed it; after
an input it reads the strip only to its depth, unless a script returned reads
the Agent may act on, and not at all after a script that sent no input. A
bounded read that shows no tabs or fewer than before is read again in full. A
tab that the task's own input or script opens or closes is the task's: the
task holds the browser's input lease, and the count is kept once the tab strip
settles, since the browser shows such a tab a moment later. The input's
result then says, from that same read, when it opened or closed a tab or
changed the title of the tab in front. A click there on an element whose row
lists no press notes that the press reaches it anyway, since Cua warns that
such a press may have done nothing; a repeat by x,y waits for a read that
shows no effect. Reading the tab
strip replaces Cua's snapshot of the window, so the Daemon remembers the rows
of recent reads and moves an Agent's element token, in an input or written
into a script, to the current snapshot when its row reads the same there.
A script's reads after its last input count too: the script guard returns
them beside the script's value, and the Daemon takes them out of the result.
A read that started before an input finished, such as one beside an input
the script did not await, does not count. Only the windows
the task opened with `launch_app` are held, each to its own tab count. A script that names no window in
its `args` is taken to drive that window; a script to another app is neither
paced nor held, and no script may open an app or URL. The browser
window is the largest window whose tab strip reads: a starting Chrome can list
a larger surface without an accessibility window, which is skipped. The
`launch_app` result tells the Agent to move between pages through the site's
own controls and never type into the address bar.

Desktop input keeps one persistent action record,
`computer-tools/action.json`. Each Agent's browser and each seat in the
everyday Chrome keep their own, `computer-tools/action-browser-<hash>.json`.
Each record file is removed once its action settles. An unknown record blocks its own desktop, Agent browser or seat,
and a Daemon restart reads every record again. The two sides also block each
other where one could still reach the other: an unknown browser action blocks
desktop input that needs the front window or the clipboard, and an unknown
desktop input of that kind blocks browser calls, so does a record that an
older Daemon left without saying which kind it was. Such a call returns
`COMPUTER_ACTION_UNKNOWN` and names the Agent and the record file that blocks it.
A record that an earlier Daemon left has no task here to settle it; the error
says so. Removing that file once the action is known to be finished frees its
desktop, Agent browser or seat at the next call, with no restart. A record of
this Daemon's own task still settles only through that task. An unknown action on a whole everyday Chrome profile, left before
the extension kept many clients, also blocks every seat of that profile. After a
cancellation, the original connection must confirm that the Cua session was
cleaned up; the exit of a shared service's proxy process does not count, and a
Daemon restart does not clear unknown actions. Without the original connection's
cleanup receipt, later input stays blocked. The exception is when the Cua service
process itself has exited, as macOS jetsam ends this background application under
memory pressure: when the connection is gone and the recorded service process no
longer exists, the action can no longer run, so the Daemon settles the record. That
call returns `COMPUTER_DRIVER_RESTARTED`, and the next call starts a new service
and session. A normal exit closes the Chrome the Computer started itself.

Windows uses the bundled `cua/cua-driver.exe` (Cua 0.35.4); the release manifest's
`cua_entry` points to it, and the installer refuses a bundle without it. Each
Operation starts its own `cua-driver.exe mcp --direct`. Only that driver enters
the Operation's Job Object; applications started by `launch_app` belong to the
user and stay after the task. The Daemon must run in the signed-in user's desktop
session: session 0 returns `COMPUTER_SESSION_NONINTERACTIVE`, the lock screen and
secure desktop return `COMPUTER_DESKTOP_LOCKED` without sending input, and an
unavailable UI Automation returns `COMPUTER_PERMISSION_REQUIRED` without
elevating. Whole-screen read-only tools use a separate desktop session, which
does not affect the window tools. Browser and file tools do not depend on Cua.

Windows input stays in the background, because Cua's foreground and desktop
routes send real input through the system queue, where it reaches whichever
window is in front or under the pointer when it arrives. The Daemon hides
`delivery_mode` and `scope` from the Windows input tools and refuses them with
`COMPUTER_INPUT_NOT_SENT` before anything is sent. It also leaves out
`bring_to_front`, which keeps another app in front of the user, and
`move_cursor`, which moves the user's pointer. `double_click` and
`right_click` are refused in a Chromium window (class `Chrome_WidgetWin_*` or
`CefBrowser*`: Chrome, Edge and Electron apps), where Cua sends them as real
mouse events. Cua's background refusals, which recommend a foreground retry or
`bring_to_front`, reach the Agent as `COMPUTER_INPUT_NOT_SENT` with the
background route instead. Cua 0.35.4 refuses a background scroll in a
Chromium window, so the Agent reads such a page with a `get_window_state`
query instead; elsewhere a list or pane scrolls by its own `element_token`
through UI Automation. Windows Operations get `WindowsToolGuide`.

Linux controls the signed-in user's X11 desktop. The driver `local_linux.py` is
embedded in the Go binary; it reads windows through AT-SPI and sends input with
`xdotool`. The host needs `python3-pyatspi`, `xdotool`, ImageMagick, `xclip` and a
user systemd manager. The Daemon must run as the desktop user and inherit
`DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_SESSION_TYPE`. With a
missing dependency or under Wayland, `check_permissions` explains why; browser and
file tools still work.

`open_application` and `open_url` start the program through `systemd-run --user`
with `KillMode=process`, so it outlives the tool call. `xdg-open` hands a URL to
`gio`, which exits as soon as it started the browser; the default control-group
mode would kill the browser with it. `open_url` then waits up to 8 seconds for
the active window or its title to change, and fails when neither does. After
any input, a page that is still loading is read again until it loads, for at
most 8 seconds; the result marks `loading` when it has not. A desktop with no
active window, as right after a GNOME login, still launches: any window that
appears counts as opened.

`type_text` pastes the text. A terminal emulator gets it on both the clipboard
and the primary selection and receives `shift+Insert`, which every common
terminal pastes; any other window gets it on the clipboard and receives
`ctrl+v`, so a GTK field keeps the selection the paste replaces. `scroll` first moves the pointer to
the middle of the active window when the pointer is outside it, because the
wheel scrolls whatever is under the pointer. `press_key` accepts key names in any
case, such as `f5` or `insert`. Text over 64 KiB is refused before any input.

Input goes to the active window, so input planned for the window the Agent
last observed fails with `WINDOW_CHANGED` when another window, such as one the
user clicked, became active since. The result shows the active window, and the
next input to it goes through. `open_application` and `open_url` are not
checked, because they bring up a window of their own.

GTK4 applications report their controls as sensitive rather than enabled, and
on X11 report every control at the screen origin. The driver counts either
state as enabled, and clicks a GTK4 control at the X11 window position plus
its client-side shadow (`_GTK_FRAME_EXTENTS`) plus the control's position in
the window. A launched window that shows no controls yet is read again for up
to 3 seconds, because its X11 window appears before the application registers
with AT-SPI.

Input on a locked screen would reach the lock dialog, so every input first asks
the desktop's screen saver service (GNOME, freedesktop, Cinnamon or Xfce) and
fails with `SCREEN_LOCKED` while it is active. Only input enters the action
record; a screenshot or window read that a Daemon crash interrupts sent
nothing and leaves no block. When the driver exits, as after a lost
accessibility bus, the next call starts a new driver.

A window read walks at most 1,500 shown accessibility nodes, 30 levels deep, and
skips hidden subtrees such as closed menus. A larger page still returns the
browser toolbar and the top of the page, and the result says that part of the
window was left out. GNOME's `toolkit-accessibility` setting is off by default,
and then Firefox and Chrome expose no controls; a window without controls then
tells the Agent to ask the user to turn it on. Screenshots are sent as JPEG
unless the PNG is smaller, as on macOS and Windows.

The user attaches their everyday Chrome from Settings, Computers, or from the
card an Agent posts in a Room chat when it needs that browser. The connection uses the official Playwright Extension's token, stored
readable only by the current user under `computer-tools/browser-connections/`.
macOS and Windows support this mode; Linux returns `unsupported`. When the default
browser is Chrome and it is not connected, the status is `not_connected` and
browser calls wait for the user to connect rather than use a separate browser. A
Computer that can connect the everyday browser declares the host capability
`browser_connection`. A Linux Computer, or one without the local browser tools,
does not declare it, answers a connection request as unsupported, and does not
tell Agents to post a connection card.

On Linux the managed browser is the first Google Chrome or Chromium found in the
usual install folders, Snap included, and then on `PATH`. A Snap browser keeps
its Agent profiles under `~/snap/<name>/common/linger-browser-profiles/`,
because confinement denies the hidden state folder. Without `DISPLAY` or
`WAYLAND_DISPLAY` the browser tools fail with that reason before starting Chrome.
Before a launch, the Daemon stops a Chrome that an earlier Daemon left on the
same Agent profile, identified by the profile's `SingletonLock` and that
process's command line. Otherwise Chrome would hand every new launch to the
old process. A managed Chrome that exits during a task, closed by the user or
crashed, starts again on the next browser call. A cancelled browser call whose
outcome is unknown blocks that Agent's later browser calls until its task ends;
the task then stops the Agent Chrome, which proves no command still runs, and
settles the record. The owner's everyday Chrome is never stopped. A task holds
one seat in it. When every installed version of the Playwright Extension in
the profile is 0.5.0 or later, the extension keeps several Playwright clients
connected, each in its own tab group. Each Agent then has its own seat, and
Agents work in their own background tabs at once. An earlier extension may drop
one client when the next connects, so its whole profile is one seat. Chrome lets the extension
set a file input only when the user turns on Allow access to file URLs for it,
which is off by default. When the profile's preferences show it off, the Daemon
fails `browser_file_upload` with `BROWSER_FILE_ACCESS_DISABLED` before Chrome
sees it. The Agent asks the user to turn it on, then opens the file chooser
again: Chrome reloads the extension on the change, which closes the chooser,
and saves the setting a few seconds later. Release
bundles patch Playwright to keep focus emulation on its CDP connections, this
Chrome and the Agent Chrome alike. Without it a background tab is hidden: it
stops rendering, clicks wait for it, and mouse and key events are lost. One task or Live call holds a seat at a time, so tasks of
one Agent take turns. An unknown action blocks the calls to its seat and
settles once the task's Playwright child, the only sender, has stopped. A task
waits up to 40 seconds for a seat and a Live call up to 8 seconds; the call
then fails with `BROWSER_BUSY`, which Live reports as `browser_busy`. A task
passes the seat on when it ends and its Playwright child has stopped, even when
an unrelated part of its cleanup fails. The `computer` tool names are Cua 0.35.4's real names, such as
`move_cursor`, `press_key`, `launch_app` and `bring_to_front`. `doctor` reports
Chrome and the extension.

The release bundle pins Playwright MCP 0.0.83 and QuickJS-WASI 3.6.2.
CLI and Desktop ship the same engine in `cli/computer-tools/node_modules/quickjs-wasi/`.
The release manifest covers its JavaScript files and WebAssembly binary.
Pi's MCP extension uses the
official 1.2.0 API. Cua is pinned to the official 0.35.4 release assets: the
signed macOS application and `cua-driver.exe` for Windows x64 and ARM64. The
bundle includes every dependency resource and a per-file SHA-256 manifest; the
installer refuses files outside the manifest, damaged resources and symlinks. The
runtime never runs `npx latest` or downloads tool dependencies. Pi still uses its
existing RPC executor, and images keep their native content types. Pi loads
every extension through jiti, which a Pi unpacked from its bare npm bundle (the
managed runtime harness installs it so) lacks; the Daemon puts the bundle's
`node_modules`, which carries jiti, on that Pi's `NODE_PATH`. A Pi installed
with its dependencies resolves its own jiti first. Node reads `NODE_PATH` at
startup, so the extension then restores the value Pi inherited, and the
commands Pi starts never resolve a package from the bundle.

The same extension carries Pi's permission review, so the Daemon loads it for a
Run with permission review even without MCP servers. Its `tool_call` hook opens
an RPC `input` dialog titled `linger.permission_review` for each `bash` and
`mcp__*` call, with the call as JSON. The Daemon answers it with a JSON verdict
from the Run's permission review, with `bash` reviewed as a shell command. A
Run without review gets an allow verdict, because a resident Pi process may
serve both kinds of Run. A missing or unreadable verdict blocks the call. The
Daemon cancels any other extension dialog.

The compatibility probe of the pinned Playwright catalog is
`TestPinnedPlaywrightCatalog`; it needs `LINGER_PLAYWRIGHT_COMPAT_ENTRY` and
`LINGER_PLAYWRIGHT_COMPAT_NODE`. The macOS read-only probe is
`TestPinnedCuaReadOnlyPermissions`; point `LINGER_CUA_COMPAT_EXECUTABLE` at a
verified asset.

Real desktop probes run on demand and are skipped by default:

| Test                         | Switch                                                | Covers                                                                                                                   |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `TestMacDesktopLive`         | `LINGER_MAC_DESKTOP_PROBE=1`                          | Non-Latin background input in TextEdit, whole-screen screenshot, separate browser                                        |
| `TestWindowsDesktopLive`     | `LINGER_WINDOWS_EXPECT=ready\|locked\|noninteractive` | Three lines of non-Latin text in Notepad, keys, whole-screen tools, lock screen, session 0, separate browser             |
| `TestUserChromeLive`         | `LINGER_USER_CHROME_PROBE=1`                          | Wrong token, connect, reconnect after restart, private storage, disconnect                                               |
| `TestNativeLinuxDesktopLive` | `LINGER_NATIVE_LINUX_LIVE=1`                          | Mousepad Unicode save, AT-SPI windows, screenshot, out-of-bounds, unknown-key and oversized-text refusal, cancelled drag |
| `TestNativeLinuxOpenURLLive` | `LINGER_NATIVE_LINUX_BROWSER_LIVE=1`                  | `open_url` in the default browser, a second URL in the running browser, a page that answers late                         |
| `TestNativeLinuxGNOMELive`   | `LINGER_NATIVE_LINUX_GNOME_LIVE=1`                    | GTK4 Text Editor read as text, `WINDOW_CHANGED` after the user activates another window, GTK4 Calculator clicks          |

The first three read `LINGER_COMPUTER_TOOLS` (the unpacked tool directory) and
`LINGER_NODE`; the Linux tests need only an isolated X11 session,
`TestNativeLinuxGNOMELive` a GNOME one, and
`TestNativeLinuxOpenURLLive` also a default browser.
`LINGER_PROBE_EVIDENCE` sets the evidence JSON path. `TestUserChromeLive` reads
the whole line the extension copied from `LINGER_USER_CHROME_TOKEN_FILE` or the
clipboard. Windows probes must run on the interactive desktop, for example started
with `schtasks /IT`.

During development, `LINGER_COMPUTER_CUA_PATH` makes the Daemon use an already
authorized Cua executable.

Before delivery, still run `make check BASE=<target-branch>` from the repository
root; it includes the Computer's fast checks.
