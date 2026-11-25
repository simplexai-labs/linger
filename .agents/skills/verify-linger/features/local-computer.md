# Local Computer

Verify standalone CLI Computer installation, enrollment, Runner lifecycle, desktop/browser MCP tools, and recovery on a user-owned Computer.
Use the [shared execution and evidence rules](README.md).
Packaged Desktop app installation, auto-updates, permissions, and the standalone Local Installer live in [Desktop Client and Local Installer](desktop-and-installer.md); local model deployment and BYOK switching live in [Local Models and BYOK](local-models-and-byok.md).
Agent replies through a Computer are covered by [Agent entry](rooms.md#agent-entry-and-response);
interruption and reconnect journeys by [Execution lifecycle](rooms.md#execution-lifecycle).
The [architecture overview](../../../../docs/architecture.md#inside-the-computer-daemon) explains the system for Humans;
the [Local Computer conventions](../../../../apps/computer/AGENTS.md) and the [Daemon guide](../../../../apps/computer/local-daemon/README.md) own exact states and recovery rules.

## Choose the smoke layer

### Open-source Compose installation and upgrade

Use the current [README quickstart](../../../../README.md) as the user-facing contract. Allocate a clean owned source directory, Compose project and volumes. Copy .env.example, record only the names of filled settings, and build/start with the documented Compose command. Do not silently inherit an older acceptance .env or service overrides.
Create the disposable owner through the documented account command and sign in through the Web UI. Record migrations, image IDs, source revision, effective public origins and healthy services.
Install the Computer from this deployment's own /install endpoint on a dedicated platform account, enroll it, and verify the delivered release hash against its manifest. Correlate the first real reply with the Computer ID, Agent, Run and persisted author.
For Windows, use the PowerShell installer offered by that build and an interactive test desktop for computer-use. SSH process tests do not replace desktop installation and input evidence.
Test an upgrade separately with a known Document and connected Computer: start the new release, verify migrations and actual Computer upgrade, then reopen the Document and obtain a fresh reply. Retain rollback/recovery failures.
Compare the installed `app-sha256` with the target platform's release row served
by that deployment. A service image change does not imply a Computer bundle
change. Record same-package reinstall separately: preserve Computer identity,
configuration and owned files, then verify a new real reply and Document read.
An unchanged bundle digest or an already-current migration version is not proof
of a changed-bundle upgrade or a newly applied database migration.
Classify a reused database run as upgrade acceptance, never clean installation. Supplier keys remain optional dependencies for their own scenarios; basic onboarding must not gain undocumented mandatory keys.
Prove a database migration on an isolated copy of the previous release's real data, never on the live volume.
Record the starting version, then run the target release's own migration image and check the newly applied versions.
Take row-count and content-hash summaries of the affected tables before and after.
Run the migration again; the ledger and summaries must not change.
A standard logical restore of a backup is not migration proof. For restore acceptance, dump the migrated database with pg_dump -Fc and restore the unmodified archive into an empty database with pg_restore --exit-on-error. Compare message and document summaries and verify that malformed attachments remain invalid.
If preparing the copy needs a non-standard step, such as an explicit `search_path`, record it as acceptance preparation, separate from restore evidence.
Database checks do not cover the UI or the Agent; verify the migrated data in the Web UI and with a real Agent reply separately.

Pick the lowest layer that proves the change, then add the higher layers it requires.
A passing layer does not cover the layers above it.

| Layer                  | Command                                                                     | Real                                               | Simulated                 |
| ---------------------- | --------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------- |
| Deterministic          | `pnpm smoke:local-runner`                                                   | Agent Service, Go Daemon, Gateway, process cleanup | TeamHub, Runtime, model   |
| Offline Agent removal  | `LOCAL_RUNNER_SMOKE_SCENARIO=offline-agent-removal pnpm smoke:local-runner` | Same as deterministic                              | Same as deterministic     |
| Go Daemon soak         | `pnpm smoke:local-runner:soak`                                              | Go Daemon, Gateway, Context View, Operation ledger | Codex app-server, TeamHub |
| Real Runtime (Stage C) | `LINGER_LIVE_LOCAL_CODEX=1 pnpm smoke:local-runner:live`                    | Codex app-server and model                         | TeamHub and MCP           |
| Real Claude lifecycle  | see [Claude live test](#claude-live-lifecycle)                              | Claude Code and model through the Go executor      | Gateway, Web, TeamHub     |
| Windows native         | see [Windows native](#windows-native)                                       | CLI, installer, named pipes, ACLs on Windows       | Runtime and model         |

Minimum layers by change:

| Change                                     | Minimum                                                                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Contract, Gateway, Daemon, receipt/replay  | Deterministic                                                                            |
| Runtime provider, authentication, probe    | Deterministic + soak; Stage C or Claude live before release                              |
| Workspace, Artifact, Skill, MCP, output    | Deterministic + soak + Stage C                                                           |
| Installer, upgrade, rollback, uninstaller  | Installer tests + `make check-scripts-heavy` + [lifecycle](#install-and-lifecycle)       |
| Enrollment, Computer/Agent removal, Web UX | Web and service integration tests + [lifecycle](#install-and-lifecycle) on a real server |
| Agent Service startup, Context restore     | Agent tests + soak + Stage C service restart                                             |

Both smoke scripts enable the Gateway through `AGENT_RUNNER_PUBLIC_GATEWAY_URL`.

### Deterministic smoke

No model is called; run it after every Runner change.
It checks Claude `ready` → `authentication_required` → `ready` without a Daemon restart.
The run that failed during the outage ends with `RUNTIME_AUTHENTICATION_REQUIRED` and is not replayed.
It also checks three isolated Runners, two concurrent Codex runs, Gateway reconnect,
unacknowledged event replay, duplicate suppression, cancel and complete process cleanup.
Polling intervals are shortened; production refresh windows need a deployed check.

### Soak

One run sends 20 inputs across 5 Daemon, 3 Agent Service and 3 Gateway restarts.
**Pass:** `daemon_id`, Registration ID and Assignment revision never change.
Each input has exactly one Local Run, one `run.start` Operation and one successful terminal event.
All terminal events are acknowledged; no provider child or ownership record survives the final stop.
Each Agent Service restart must exit 0; a crash is not a completed restart.

To hold the Agent Service down while work runs, set
`LINGER_LOCAL_RUNNER_RECOVERY_DELAY_SECONDS` (0–600, e.g. `360`).
The Daemon and Runtime processes must stay alive for the whole window.

### Stage C

Stage C calls a real model and costs money; enable it explicitly.
It reuses the current Codex `auth.json`, `LINGER_CODEX_AUTH_FILE`, or an absolute `CODEX_HOME`.
Select the model with `LINGER_LIVE_CODEX_MODEL`; it must exist in the Computer catalog.
`LINGER_LIVE_CODEX_REASONING_EFFORT` overrides the catalog default; unsupported values fail before registration.
Without a model, `codex-default` proves only whatever the local Codex config selects.
`KEEP_LOCAL_RUNNER_LIVE_SMOKE=1` retains the redacted `/tmp/sx-lr-live.*` directory.

The fixture mounts no MCP server. The reconnect/cancel phase has Codex run one long native command,
`mkdir -p ./playground && echo $$ > ./playground/stage-c-hold.pid && exec sleep 3600`,
and tracks it through the Operation ledger and that PID.
Confirm the fixture implements current callbacks before reporting this layer as passed.

**Pass:** the script checks persisted facts, not the final reply:
Skill package SHA and Artifact input in the stable Context roots;
each input's final message published once through the CLI with an idempotency key;
`teamhub docs get` input download, then `teamhub publish` and `teamhub update` of the same Playground file as versions 1 and 2;
ACK loss and reconnect with unchanged `run_id`, `operation_id` and original epoch, and the hold command still running under its original PID;
`cleanup_runtime` cancellation persisted as `operation.cancelled` and the hold command exited;
Agent Service restart while the Computer is offline stays Ready and later resumes the same Context;
one Local Run and one receipt per input, no unacknowledged events, processes or test Agents.

**Evidence:** read `fixture-report.ndjson`, `proxy-events.ndjson`,
`agent-home/agent-manager/logs/**/events.ndjson` and the Computer's `daemon status --json`.

### Warm history after an idle Computer restart

Finish a real turn and wait for its terminal Run. Keep Node Services running. Restart only the owned Computer daemon, wait for connected and reconciled, then send a fresh request in the same Room. Require one exact delivered reply after a fresh read and a successful terminal Run. If user Chrome was connected, repeat a new random browser challenge after restart; a retained connection label alone is not proof. Preserve failures such as `Agent Runner placement does not match Context View`. Reuse `apps/node-services/tests/agent/executor/local-backend.test.ts` for the revision refresh and offline rejection regression.

### Claude live lifecycle

```bash
cd apps/computer/local-daemon
LINGER_LIVE_LOCAL_CLAUDE=1 LINGER_CLAUDE_PATH="$(command -v claude)" \
  go test ./internal/provider -run '^TestClaudeLiveLifecycle$' -count=1 -v -timeout 10m
```

It covers Skill/MCP, file and tool events, steer, no late writes after cancel,
same-Session continuation and instruction updates. It is not a Gateway, enrollment or deployment check.
Claude, Pi or authentication changes need an equivalent real-Runtime run.
Break authentication only under a dedicated or disposable OS user, never the developer's own login.

### Focused protocol tests

Gateway write blocking and replay:

```bash
cd apps/computer/local-daemon
go test ./internal/linger/transport ./internal/daemon \
  -run 'TestGateway(WriteTimeout|SendRechecks)|TestDaemon(ReconnectsAndReplaysRecordedEventAfterBackgroundWriteTimeout|ClosesConnectionBeforeCleaningUpBlockedDelivery)'
```

Daemon restart and Gateway transport loss during a running native turn, with isolated PostgreSQL and a real Go Daemon:

```bash
apps/teamhub/scripts/with-test-database.sh sh -c '
  cd apps/node-services && LINGER_GO_LOCAL_DAEMON_TEST=1 pnpm exec vitest run --project agent \
    tests/agent/runner-gateway/go-local-daemon-process.test.ts \
    -t "mid-run" --maxWorkers=1
'
```

On Linux, `make check-computer` isolates PID and `/proc` through `apps/computer/run-test.sh`.
`COMPUTER_TEST_ISOLATION=on|off` forces either mode.

For the opt-in `apps/computer/tests/codex-native-compat.test.ts`, point
`LINGER_CODEX_COMPAT_EXECUTABLE` at the installed Codex entry point.
It uses a deterministic loopback model and fresh Runtime homes; it does not prove
real model access. On Linux, native Codex refuses to create its sandbox helper
aliases beneath `/tmp`. The test therefore allocates an owned temporary directory
under the user's home and passes it as the Go subprocess's `TMPDIR`, then removes
it. Never substitute the user's real Codex state, disable the sandbox, or treat a
manual helper alias as proof that the unmodified test passed. The Computer release
does not vendor Codex; an alias failure alone is not a missing Computer bundle file.

## Install and lifecycle

**Setup:** Use a temporary `HOME` and a disposable account on the target environment.
Install with `<web-origin>/install/linger-computer.sh` (Windows: `linger-computer.ps1`).
The installed command is per environment, `linger-computer-<environment>`; the steps below write `linger-computer` for it.
Never reuse another Computer's config or state directory on a shared host.

**Journey:**

1. Install, then `linger-computer login`, approve in the browser, and run `linger-computer daemon start`.
2. Create two Local Agents on this Computer and complete one message each.
3. `daemon stop`: the Computer goes offline and keeps its identity; `daemon start` recovers it.
   Separately verify a lost network route: retain the queued Run ID, restore only the owned route, and require the same daemon/Computer and queued Run to recover without resending the request. Confirm the intended author's reply once after a fresh login and reload. A daemon process that is running but still `connecting` does not prove connectivity. If acceptance uses SSH forwarding, record both listeners and ownership; its loss is a test environment failure, not proof of a daemon failure. Direct Compose origins remain the open-source default path.
4. Delete the Computer while Agents are assigned: expect `409`.
5. Delete the Agents, then the Computer.
6. Start the old Daemon: its credential must be rejected.
7. Rerun the installer: same bundle is a verified no-op; a new bundle upgrades in place.
8. Uninstall: launcher and bundles are removed; config, credentials, state and logs remain.

**Pass:** `linger-computer daemon status --json` shows the expected `daemon.computer_id`,
`gateway_state=connected` and `reconciled=true`. A started process alone is not online.
`daemon start` prints `Connection  Connected` only after the server confirms; a running process alone is not proof.
Local uninstall never deletes the server-side Computer.

**Protocol upgrade:** start with an old Computer that already has a Local Agent and no active Run.
The new Agent Service marks it `upgrade_required` and the Web offers the installer.
After the installer runs, `computer_id`, Agent identity, placement, Runtime config and configuration revision are unchanged.
The Agent completes a new Run. The installer never calls `login`.

**Self-update (macOS, Linux and Windows, which stages through `internal/selfupdate/windows_stager.go`):** `runner.welcome` carries `target_release`.
Record the active bundle `app-sha256` before and after; a version string alone is not upgrade evidence. For macOS/Linux, install the same origin into default and isolated roots with separate command directories. Stage and activate a different app package in the isolated root, without supplying a command directory. Compare both active hashes and both directories’ launchers and dispatchers. Only the isolated active package should change.

### Login and account switching

| Situation                            | Expected                                                                 | Automated evidence                                                                                  |
| ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| First `login`                        | New Computer, credential saved                                           | `TestBrowserEnrollmentPersistsOwnerOnlyStateAndStartsTheDaemon`                                     |
| Repeat `login`, same account         | Same `computer_id`, credential generation advances                       | `TestSetupRenewsTheExistingComputerIdentity`                                                        |
| Browser signed in as another account | Current account shown; local identity replaced after confirmation        | `apps/web/src/features/local-computer/connect-computer-page.test.tsx` account sign-out test; manual |
| Set Up Again renewal with orphan     | Renewal by `daemon_id` keeps holding Computer and deletes unbound orphan | `TestAgentRuntimeLocalComputerEnrollmentByDaemonIDRemovesOnlyTheOrphan`                             |
| Server already deleted the Computer  | New Computer after confirmation; busy Daemon keeps old identity          | Manual; `TestDaemonStopIdleAndRecovery` covers the idle stop                                        |
| Crash during login                   | Recovery from the pending renewal file, no second rotation               | Manual; `TestSetupRenewsTheExistingComputerIdentity` checks the pending file is cleared             |
| Two `login` on one state directory   | Second is rejected by the setup lock                                     | `TestSetupRejectsAConcurrentSetup`                                                                  |
| Upgrade with an active Operation     | Rollback before start; after start only with a reliable idle stop        | metadata, rollback and active Operation tests in `scripts/local-computer-installer.test.ts`         |

### Windows native

Run under a dedicated Windows test user with Node 26.5.0, the pinned pnpm, Go, PowerShell 5.1 and 7:

```powershell
pnpm install --frozen-lockfile --prefer-offline
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-local-computer-windows.ps1
```

Reports land in `.linger-runtime/windows-verification/` with system, architecture, revision and exit codes.
When native builds are unavailable, cross-build with `go test -c` and point
`LINGER_TEST_WINDOWS_LAUNCHER` or `LINGER_TEST_WINDOWS_DAEMON` at the artifacts.
That proves runtime behavior, not a native source build.
Under x64 emulation set `LINGER_TEST_WINDOWS_TIMEOUT_SCALE=6` (range 1–20); it changes only test waits.
Each architecture needs its own report; skips on non-Windows hosts are not passes.

The Agent Service image builds `win32-x64` by default (`COMPUTER_RELEASE_TARGETS` in `apps/node-services/Dockerfile`); it does not build `win32-arm64`.
`/install/linger-computer.ps1` is served only when the image's release contains Windows (`install-route.ts`); a 404 there means no Windows package, not a failed install.
Trust the deployed `/install/` response and `release.json` over prose about release targets.

### Windows install, pairing and background run

This manual recipe is the Windows acceptance path.
Record each step as passed, failed or not run. A Windows Go test that was only compiled or cross-built has not run.
Use a real Windows 10/11 x64 machine with Defender real-time protection and a disposable account. Record the Smart App Control state; do not disable the installer's checks.

1. Run the official `.ps1` entry from an elevated PowerShell. Expect `login`, `daemon start` and `daemon restart` to refuse with the non-elevated-terminal error before reading credentials (`internal/computercli/session_windows.go`). `stop` and `status` still work.
2. Run it again from ordinary PowerShell. Check download progress, one line per stage and the CLI command list at the end.
3. Pair with `login` on a cold cache, approve in the browser, then `daemon start`. Require `Connection  Connected` and the expected `computer_id` in `daemon status --json`.
4. Close the terminal. The Daemon runs as a detached, hidden process (`launcher_windows.go`), so the Computer must stay online in Settings → Computers and accept a new Room request.
   Repeat from an SSH session: the Daemon leaves the session's Job when that Job allows breakaway, so closing SSH must not stop it. A Job that forbids breakaway keeps the Daemon inside. `TestDetachedDaemonSurvivesSessionJobClose` and `TestDetachedDaemonStartsInsideJobWithoutBreakaway` cover both cases and run only on Windows.
5. Sign out or reboot. There is no logon autostart, so expect the Computer offline until `daemon start`. Then require the same `computer_id` and a new delivered reply.
6. Uninstall and check progress, removed launcher and bundles, and no leftover Daemon or managed-service processes.

Also run [warm history after an idle Computer restart](#warm-history-after-an-idle-computer-restart) on this Computer. For delegation, also require the created Task, callback and delivered file; a successful parent message alone is insufficient.

The installer refuses an elevated session before download (`scripts/local-computer-windows-bootstrap.ps1`).
**Evidence:** Keep the installer transcript, `daemon status --json` before and after each step, the Computer and Agent IDs, the reply message ID and a process list after uninstall.
Cross-built binaries, `scripts/check-local-computer-windows.ps1` and Go tests with `*_windows_test.go` do not prove the installer, the pairing or the background run.

## Desktop and browser tools

Read [Desktop and Browser](../../../../docs/desktop-and-browser.md) and the [Daemon guide](../../../../apps/computer/local-daemon/README.md#controlled-desktop-and-browser-tools).
Each Operation exposes one Daemon-local MCP server (`computer`) with two public tools: `computer.ui_exec` and `computer.ui_reset`, running inside a bundled QuickJS-WASI sandbox (`apps/computer/local-daemon/internal/uiruntime/`) over private desktop (`ui.window` / `ui.computer.*`, Cua on macOS/Windows or X11 on Linux) and pinned Playwright browser (`ui.page` / `ui.browser.*`) drivers. Reuse `TestBridgeSetupIgnoresGuestCPUBudget`, `TestOversizedDispatchResultRejectsOnlyTheCall`, and `TestUIImageBudgetNeverFailsACompletedAction` for deterministic UI-runtime isolation.
The browser has three targets:

| Target                 | When                                                                                   | What to check                                                                                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolated Agent browser | Linux (always), or macOS/Windows when the default browser is not Chrome                | Profile under `computer-tools/browser-profiles/` (Linux Snap Chrome/Chromium: `~/snap/<name>/common/linger-browser-profiles/`); no user sign-ins                          |
| Agent browser window   | `launch_app` with `agent_browser: true` on macOS                                       | Computer's own window in the user's Chrome (Edge and Firefox use their own profile). Works behind other windows on the current Space; off-Space refusal tested separately |
| User's everyday Chrome | Default browser is Chrome on macOS/Windows and user connected via Playwright Extension | Tasks use the user's sign-ins; when disconnected, browser calls return `BROWSER_CONNECTION_REQUIRED` instead of silently falling back to the isolated browser             |

For the Agent browser window, record cold launch and warm operation separately. Do not claim no focus change for the cold launch without foreground samples. The user's Chrome takes no keys from the Computer (`COMPUTER_KEYS_REFUSED`). An already-running Chrome without `--disable-backgrounding-occluded-windows` is used as-is with `pauses_when_covered: true` in `structuredContent`; the Daemon never quits it and the Agent must not ask the user to restart Chrome. Restore the original front application before the warm test, then correlate foreground PID samples with the actual tool interval. A single before/after sample cannot prove no intermediate focus change. Do not claim general cross-Space support. `COMPUTER_WINDOW_OFF_SPACE` applies when the off-Space window cannot be read; a previously read window can behave differently. Record stale-view warnings and use an independent result to verify effects. Test this boundary separately, without moving the user’s desktop as a hidden setup step.

**Real probes (default skipped):** `TestMacDesktopLive`, `TestWindowsDesktopLive`, `TestUserChromeLive`, `TestNativeLinuxDesktopLive`, `TestNativeLinuxOpenURLLive`, `TestNativeLinuxGNOMELive`, and `TestUnifiedUIBrowserLive` (`LINGER_UI_BROWSER_PROBE=1`). Their switches and inputs are in the Daemon guide. They prove the driver and Daemon, not the model's tool choice.

**Agent journey:** Give a ready Agent one desktop task and one browser task with a checkable result. For the desktop, type a unique marker into TextEdit or Notepad and save through the visible dialog. Independently read the saved file. For the browser, serve an owned temporary page with a random visible challenge, a labeled input and a confirmation button. Ask the Agent to read, enter and submit the code, then report the actual confirmation. Keep the expected code out of the request. Inspect native tool results, the persisted reply and a fresh browser read. A public page can change; a memorized title or an exact answer supplied in the request does not prove reading or interaction.

For macOS file pickers, distinguish cold application launch from opening a picker
while an owned document is already open. After Command-O, reread the window list:
the immediate snapshot can still show the document before the picker appears.
Use the observed picker window and its Cancel control; confirm return to the
owned document and unchanged disk content. Do not infer cold-launch support from
that warm result. On macOS `launch_app` opens applications in the background
through LaunchServices; it does not promise a new application instance. A probe must identify its unique fixture window and
current text-field token. Never select the first restored window or kill the
returned application PID as cleanup. A compiled, opt-in-skipped probe is not a
desktop acceptance result.

<details>
<summary>Update from a local ad-hoc build or 0.1.7 and earlier</summary>

After switching the same Mac between a local ad-hoc build and an official release, or upgrading from 0.1.7 or earlier, Screen Recording can report **Not allowed** while System Settings shows the switches on, because macOS ties each grant to the app's signature. Reset both identities, `CuaDriver` (`com.trycua.driver`) and `Linger` (`com.simplexai.linger.desktop.preview`), with `tccutil reset ScreenCapture <bundle-id>` and `tccutil reset Accessibility <bundle-id>`, then relaunch Linger and grant again.

</details>

For the browser journey, have the test server return a second random receipt only after a correct form submission. Reopen the Room and match one message by the target Agent, scoped to the message list: the sidebar may preview the same text. Correlate the receipt with the server response, the browser tool calls and the finished Local Run.

Use a unique disposable file and verify its path/title and empty editor before any input. Windows Notepad may restore existing user tabs even when launched by the test. A new PID does not prove those tabs belong to the test. Never select an arbitrary element token, overwrite an existing editor, or force-kill that process as cleanup.
On Windows, `cua_windows_policy.go` enforces background-only input: `delivery_mode` and `scope` are hidden and refused with `COMPUTER_INPUT_NOT_SENT`, `bring_to_front` and `move_cursor` are dropped, and `double_click`/`right_click` are refused on Chromium/Electron windows (`Chrome_WidgetWin_*`, `CefBrowser*`) including element-token-only targets resolved from prior reads (`TestWindowsInputRefusal`, `TestWindowsTargetWindowFromElementToken`).
`TestWindowsDesktopLive` opens a disposable temporary file, sends input only to that window's single Document field, checks foreground `scroll` refusal (`COMPUTER_INPUT_NOT_SENT`), and never kills Notepad. Record its report from a run on the signed-in test desktop; a compiled probe is not a result. Until such a run exists, use the manual Agent journey above for Windows desktop acceptance.

For desktop tasks, distinguish launching an application from editing an already-open file. Correlate native tool calls with the saved content.
For browser proof, correlate the persisted reply author and local_run_id with the same Run's native activity.started/activity.finished events. Require browser navigation to the owned challenge URL, input and submit actions, and their outcomes. Record recovered tool failures instead of presenting the run as failure-free. Check the assigned Computer and platform; a current registration alone cannot establish an old Run's location after a move. Server-side local_mcp_relay logs apply only to calls traversing that relay; do not require them as the sole evidence for Daemon-local browser tools.

On Windows, an SSH-started Daemon can remain alive after logout while still running in noninteractive Session 0. A signed-in desktop elsewhere does not move that process into the desktop session. Start the dedicated test Daemon from the signed-in test desktop before desktop acceptance. Record `COMPUTER_SESSION_NONINTERACTIVE` as an unmet environment prerequisite; do not bypass the check. A Run that successfully reports this error has not passed the requested desktop task.

### Connect and disconnect the user's Chrome

**Setup:** Chrome with the official Playwright Extension on the Computer. A disposable Chrome profile is preferred. Never put the extension token in chat, evidence or logs.

1. Open "Connect my browser" from the Computer detail in Settings → Computers, or from the browser connection card an Agent sends. A card locks its Computer.
2. Paste a wrong token. Expect `BROWSER_TOKEN_REJECTED` and no saved connection.
3. Paste the extension's token. Expect `Connected`. The token file is under the Daemon state `computer-tools/browser-connections/`, `0600` on macOS and current-user ACL on Windows.
4. Ask the Agent for a task that needs a signed-in page in that Chrome. Check the result.
5. Restart the Daemon. The connection stays; the first task revalidates it.
6. Disconnect. The private file is removed. The next browser task uses the isolated browser. If the default browser is Chrome, it reports `BROWSER_CONNECTION_REQUIRED` instead.
7. For the Chrome-required branch, verify the Agent posts a connection card for
   that Computer and ends its turn. Decline that specific card with `Not now`.
   Verify persisted denial, the resulting Agent continuation, and no browser or
   HTTP fallback. A successful Run that reports the denial is not a completed
   browsing task.

Wrong-token verification waits for the extension handshake. Give the probe's
response wait enough time to observe the actual rejection; the ordinary 15-second
UI locator timeout can expire first. If it does, inspect the resulting connection
state before retrying. Capture the returned code and visible error separately
from the wait failure. Check token-file presence without reading its contents.

**Pass:** The state follows the Agent Service route `/v1/tenants/{tenantId}/owners/{ownerActorId}/local-computers/{computerId}/browser-connection`. A refused token mid-task gives `token_invalid` and an error, not a silent fallback to the isolated browser.
When `browser_file_upload` runs in everyday Chrome without "Allow access to file URLs" enabled on the Playwright Extension, expect `BROWSER_FILE_ACCESS_DISABLED` (`TestFileUploadReportsExtensionWithoutFileAccess`, macOS/Windows only); enabling it reloads the extension and closes the file chooser.
When using the private token-file probe, verify the target page before and after connection-manager restart. Record this separately from a signed-in Room task.

**Deterministic rejection coverage:** `TestRejectedTokenFailsLaterCallsAtOnce` checks that a rejected token does not reopen a connection or hold the profile. `TestRejectedConnectionRecoversAfterReconnect` checks that merely flipping a status does not count as reconnection, and a new connection generation releases the stale relay. `TestBrowserConnectionIsPrivatePerOwnerAndNeverReported` covers owner scoping, private storage and removal. These tests manipulate manager state; they do not rotate a real extension token during a running task.

**Reuse:** `apps/web/src/features/local-computer/browser-connection/browser-connection-dialog.test.tsx` and `TestUserChromeLive`.

## New Runtime acceptance

Run this recipe whenever a Runtime is added to the Computer, and again when an
existing Runtime's adapter changes how it reports tools, permissions, sessions
or failures. A single delivered reply only proves the entry path. Drive every
step on a deployment that ships the adapter under test, and repeat each prompt
on a Claude Code Agent on the same Computer as the baseline.

**Setup:** Install the Runtime's CLI on the Computer and sign it in. Confirm
the Computer reports the target release's `app-sha256` and the Runtime as
ready. Create one Agent on the new Runtime and one on Claude Code, each in its
own Room. Record `TEAMHUB_PERMISSION_REVIEW` as in
[Runtime permission decisions](tasks.md#runtime-permission-decisions).

**Journey:** Send each prompt below to both Agents, waiting for each Run to end.

1. Direct commands: send a message, add an emoji reaction, and send a card
   with an attachment. Read and write a Document, search knowledge, search
   the web, and read and write a local file in the workspace.
2. A confirm command, such as `agent update`, produces an approval card;
   approve one and deny another.
3. A judged command, such as `image-gen`, goes to TeamHub's remote review.
4. A background Task that ends by delivering a file to the Room.
5. Multi-step research that ends in a new Document.
6. A follow-up message sent while the previous Run still works.
7. A long command line, over 200 characters, and content in a non-Latin
   script in the prompt, tool input and reply.
8. A request the Runtime must fail, such as a missing file, and one that ends
   by user Stop.

**Pass:** Every step ends with the requested effect, and the delivered message,
Document or file matches the request. The working indicator appears in the
composer within about one second of sending, as for Claude Code; record the
delay for both Agents. Each tool call shows a readable name and its outcome.
A confirm or judged command waits for its decision, and a denied action has
no effect. A failed or stopped Run shows a specific reason, not an
unclassified error. The follow-up reaches the same session, and the next Run
resumes it.

**Evidence:** For each step, record the Room, Run ID, Runtime, model, elapsed
time to the working indicator, terminal status and the effect checked. Check
`runtime-presentation-runs` for the message and `daemon.log` for a failed
Operation. Report any step that differs from the Claude Code baseline, even
when the step passes. A Runtime the deployment cannot run is a blocker, not
a skipped step.

## Source-built Computer

`bash scripts/dev-local-computer.sh start|status|stop` drives a Daemon against `pnpm dev`.
It enrolls through the same PKCE flow and writes `.linger-runtime/computer/runner-token`.
After a TeamHub reset, delete `runner-token` and start again; Agents must be placed on the new Computer.

The script builds the Go CLI and Daemon into `apps/computer/dist/cli/linger-computer` and
`apps/computer/dist/daemon/linger-computer-daemon`; the CLI starts the Daemon beside it. Place this
build output first:

- TeamHub CLI: build `@linger/teamhub-cli`, copy it into `apps/computer/dist/cli/` as
  `apps/computer/scripts/bundle-teamhub-cli.mjs` does, and link a Node binary to `apps/computer/dist/runtime/bin/node`.
  Without it every Run fails with `TeamHub CLI configuration or installation is unavailable`.
  Restart the Daemon after changing the CLI.
- Codex outside `PATH` (for example the ChatGPT app copy) needs `LINGER_CODEX_PATH` in `.env`.

A source-built Computer does not prove installation or upgrade of a released package.

## Evidence

A running Operation has no terminal receipt yet.
Find its `operation_id` from the Run's `run.start` execution receipt,
then check `runner.operation.accepted` for it in the Computer's `daemon.log` and `.daemon.active_operations` in `daemon status --json`.
Check Agent Service receipts only after the terminal event.
Tool calls are logged by the Agent Service as `local_mcp_relay.tool_call_started` and `local_mcp_relay.tool_call_finished` JSON events without arguments, bodies or credentials; filter by `runId` (the `local_run_id`) or `operationId`, for example `jq 'select((.event|startswith("local_mcp_relay.tool_call")) and .runId=="<local_run_id>")'`.
Never print `auth.json`, tokens, Computer credentials or message bodies into evidence.

A `runner.welcome` proves the handshake. Only the matching removal receipt proves local cleanup.
Neither replaces a real Room request on an active Agent.

## Adding a new state or recovery path

When a change adds a business state, error code, recovery or compatibility path, update in the same pull request:

1. Deterministic behavior goes into `pnpm smoke:local-runner`, asserting state or persisted facts, not log text.
2. Behavior that needs a real Runtime, browser or package goes into the matching recipe on this page.
3. New scripts get a stable `package.json` entry and join `make check-scripts-fast` or `make check-scripts-heavy`.
4. Without a smoke change, the pull request states which existing step covers the new path.

### Claude Code gateway catalog and execution

On a dedicated Computer using Claude Code user settings for a gateway, compare the reported model picker with that gateway's catalog. Claude model labels are formatted strictly from structured fields (`displayName`, `id`, `resolvedModel`; reuse `TestClaudeCatalogFormatsStructuredLabelsAndDisambiguatesDuplicates`). Select a gateway-only model and send a real Room request. Correlate the selected ID, Run, actual provider model and reply. Redact credentials. Checking command flags only proves how discovery launches; it does not prove the gateway handled the selected model. Keep ordinary Windows Room execution separate from the restricted background Wiki invocation.
For BYOK endpoint wire-format validation (`openai-chat`, `openai-responses`, `anthropic`, Computer `≥ 0.56.0`, `TestHandleModelSourceCommandRejectsMissingOrUnknownByokProtocol`), local models, and Pi background calls (`≥ 0.55.0`), see [Local Models and BYOK](local-models-and-byok.md). Antigravity (`agy acp`) is also supported as a fourth Runtime where installed.
