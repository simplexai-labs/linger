# Local Computer Conventions

## Boundary

- This directory owns the resident Local Computer Daemon, its local control
  CLI, outbound Runner Gateway transport, workspace grants, provider process
  supervision, and Runtime execution.
- The Go implementation under `local-daemon/` is the only Local Computer
  Daemon and Runtime execution implementation, and `local-daemon/cmd/linger-computer`
  is the control CLI the release bundle ships as `cli/linger-computer`. The bundled Node runs only the `teamhub` CLI and the managed
  Computer tools.
- The Desktop app (`apps/desktop`) ships the same Daemon and runs it as its
  child. A `desktop` config section selects Desktop mode: no
  self-update, shutdown when stdin closes, status lines on stdout, and the
  app's TeamHub CLI directory.
- It consumes generated Runner Gateway contracts and shared Runtime packages.
  It must not import another `apps/*` source tree or own TeamHub records, Agent
  orchestration, model selection, or Room callback behavior.
- It executes the local-model library actions a Computer owner chose
  (download, cancel, load, unload, remove, refresh) through the installer's
  `localmodels` tool, but it never chooses a model: on its own it loads only
  the downloaded model a Run names, never downloads a model, and never
  unloads another one to make room. Fit, placement and recommendation come
  from `localmodels`.

## Structure

- `local-daemon/` is a Go module. Its `internal/daemon` owns the daemon
  lifecycle; `internal/process`, `internal/provider`, and `internal/workspace`
  contain local execution mechanics; `internal/linger` contains Linger
  transport, identity, process-instance lease, Registration, Context, Local MCP
  Relay, and Local Skill adapters.
- `internal/computercli` implements the control commands over
  `internal/computerconfig` (the config parser and process environment shared
  with the Daemon), `internal/platform/privatefs`, `internal/provider`
  discovery, and `internal/linger/control` (control client and the Daemon
  owner record). It never re-implements a Daemon mechanism.
- `runtime login <type>` opens an installed Runtime on the caller's terminal so
  the user can sign in to it. It reuses the Daemon's discovery, Runtime
  environment and launcher handling, so the user signs in to the process the
  Daemon starts; only `process.PrepareForeground` skips the hidden window.
- Native provider clients live in `internal/provider/native`; process-tree
  helpers live in `internal/process`; runtime-home helpers live in
  `internal/workspace`. Keep tests next to their implementation.
- Context refresh publishes validated input files atomically into a stable
  workspace and never deletes local writable output or a running provider's cwd.
  Every Ensure also creates whichever files of the Context's own `agent/`
  package project (`pyproject.toml` for uv, `package.json` for npm) are
  missing and never replaces one the Agent changed.

- `cmd/linger-computer-launcher` is the stable Windows command: as
  `linger-computer-<environment>.exe` it runs the active bundle's CLI, and as
  `cli/teamhub.exe` the bundled Node TeamHub CLI. The Daemon's Windows-only
  `platform` subcommand serves the Windows installer helper (owner-only files,
  process identity, owned-process cleanup); nothing else calls it.
- `scripts/` builds the development bundle, and `tests/` holds the Vitest
  checks of the bundle tools and the Runner Gateway wire against the Go
  Daemon. Do not add a second Runtime detector, Runtime executor, Gateway
  client, operation ledger, or daemon entrypoint outside `local-daemon/`.
- Add grant, runner-supervision, and other CLI feature directories only when
  their behavior and colocated tests are implemented.
- Keep process entrypoints thin over owning modules. Do not add nested
  export-only barrels.
- Do not use `host`, `runtime host`, or `local host` as names for the Go
  process; use `local-daemon` or Local Computer Daemon.

## Runtime And Safety

- On Windows an npm-launched Runtime starts on the Node the bundle ships in
  `runtime/bin`, so an engine requirement a Runtime declares is independent of
  the Node installed on the machine; the machine's `PATH` stays the user's.
- Background model calls (`execute` `model_invoke`) follow the same model as
  Agent Runs when the Agent Service supplies `model` (Computer `0.62.0` or
  later), passing it explicitly to Codex (`-m` / `--config model=...`), Claude
  (`--model`), and Pi (`--model`), normalizing reasoning effort against that
  model, and calling `ensureLocalModel` for Pi library models on demand.
- For legacy callers that omit `model`, a Pi background model call runs on
  whatever model Pi's profile selects by default (refused when no library model
  is loaded), and a Codex call runs the model its `config.toml` selects or the
  signed-in account's catalog default when `config.toml` names none. A call the
  provider rejects with `model_not_found` is reported as
  `runtime_incompatible`, not as a transient failure.
- Codex turn cleanup keeps receiving a process's notifications after its
  Operation detaches, so a retried stop sees the turn complete. After an
  invalid-request interrupt rejection the Daemon also accepts an idle status on
  the same thread. Terminal cleanup and process exit checks still apply.

- Default tests use deterministic providers and real fixture child processes;
  they never call a live model.
- Process-test watchdogs are harness budgets for loaded developer machines, not
  product startup or shutdown SLAs. Do not add retries or weaken lifecycle,
  process-identity, or cleanup assertions to handle timing variance.
- A wire request never supplies a local path, executable, environment, or
  credential. Resolve canonical workspace grants before invoking an
  installed Runtime provider.
- The `feishu_mail` Computer tool (`localtools.FeishuMail`) runs the owner's
  own lark-cli for TeamHub's Feishu Mail. It finds lark-cli where Runtime
  discovery looks (`provider.ExecutableCandidates`: PATH, `~/.local/bin`,
  and `%APPDATA%\npm` on Windows) or where its installers put it, and runs
  the native binary beside npm's Node launcher, so Node need not be on a
  short Daemon PATH. A request names only a
  method and an API path under `/open-apis/mail/v1/user_mailboxes/me`, never
  lark-cli's other Feishu scopes. A started login's device code stays in the
  Daemon's memory under the caller's login name, so a restart drops it and
  the owner connects again. Results carry lark-cli's error type, subtype,
  Feishu code, never a decision made from its message; a
  `config` error, a lark-cli never set up with a Feishu app, is
  `not_configured`.
- Do not commit runtime state, PID files, sockets, logs, credentials, or build
  output.

## Release Versioning

- A deployment ships the Computer built from its own commit inside the
  node-services image, and a Daemon upgrades whenever its bundle's
  `app-sha256` differs from the Agent's `target_release`. A Daemon
  change therefore needs no version bump to reach Computers.
- Bump `apps/computer/package.json` only when raising the version
  floor or when the Agent Service must tell a release that decodes a new
  optional `runner.welcome` field or a new Agent frame from one that rejects
  it (the Daemon decodes frames strictly and closes the connection on an
  unknown one), or when the Web must tell a release whose CLI has a new
  command from one that lacks it. The package version is the source for the
  bundled CLI and Go Daemon `ReleaseVersion`; it is used for display, the
  floor, those fields and frames, and those CLI commands, never to trigger or
  order upgrades.
- A Daemon can outlive its Agent Service release: a desktop upgrade replaces
  the Daemon while the installed services keep running until the owner
  updates them. A Daemon-to-Agent frame family added within protocol 2 is
  sent only when `runner.welcome`'s `service_features` names it.
- Before reporting a Daemon update as delivered, distinguish an image that
  carries the new build from an existing Computer that has actually upgraded
  (its active bundle's `app-sha256`).

## Verification

- During iteration, run the focused `@linger/computer` test. Before
  delivery, run `make check BASE=<target-branch>` from the repository root; it
  includes `check-computer`. Also run `make check-computer-release` for bundle
  source, package, shared Runtime, or generated Runner Gateway changes. Run `make check-scripts-heavy` only for installer,
  uninstaller, release generator, publish, or image paths;
  ordinary Computer tests, fixtures, documentation, and example configuration
  do not require the full installer lifecycle gate. CI runs
  `make check-computer-go` (the daemon's Go unit tests) when `local-daemon/`
  changes, and `check (computer-go-windows)` builds every daemon package for
  Windows and tests only `cmd/linger-computer-launcher`, `internal/computercli`,
  `internal/computerconfig`, `internal/localmodels`, and `internal/process`
  there; other packages (`internal/uiruntime`, `internal/provider/native`, and
  so on) are not tested on Windows in CI. The rest of `check-computer` stays
  local. CI does not replace the
  corresponding local verification.
- When installer or lifecycle behavior changes, verify it under a temporary
  HOME (`make check-scripts-heavy`). Preserve install, safety-failure, rollback, and release
  integrity coverage unless an explicit equivalent replacement is documented.
- Go checks for `local-daemon/` must run from that module with focused tests,
  then through `make check-computer`.
