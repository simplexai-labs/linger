# Desktop: Electron client for private deployments

The Electron main process hosts the desktop modules: it loads the
remote Web SPA, enrolls the computer and runs the Go Local Computer daemon
(`apps/computer/local-daemon`) as its child, which connects to the Runner
Gateway and runs Agents. The daemon exits with the app.

## Common Commands

- `pnpm --filter @linger/desktop test`: unit tests (no Electron binary needed).
- `pnpm --filter @linger/desktop typecheck`: typecheck the app.
- `pnpm --filter @linger/desktop build`: bundle `dist/` with esbuild and
  build the Go daemon for this machine into `dist/computer/<platform>-<arch>/`
  (needs Go). `LINGER_DESKTOP_DAEMON_TARGETS=darwin-arm64,darwin-x64` (or
  `win32-x64`) builds the targets a package needs;
  `node scripts/build-daemon.mjs --all` builds every shipped target.
- `pnpm --filter @linger/desktop electron:install`: download the Electron
  binary; pnpm does not run its install script. Set `ELECTRON_MIRROR` when the
  default host is unreachable.
- `pnpm --filter @linger/desktop start`: build and run from source.
- `python3 packaging/mac/package.py [--arch arm64|x64]`: build
  `out/Linger-<version>-<arch>.dmg` for Apple silicon and Intel on Linux
  after `node build.mjs` with the darwin daemon targets. The daemon is signed
  with the app. Needs the `dmgtool` image from
  `packaging/mac/Dockerfile` and `rcodesign` (ad-hoc signature). Add
  `--developer-id P12 --developer-id-password FILE` for a Developer ID
  signature with the hardened runtime, and `--notary-key JSON` to notarize and
  staple the DMG in one Apple submission (stapling `Linger.app` separately for
  `--update-archive`; `Linger.app` inside the DMG is notarized by Apple with
  the DMG submission but not separately stapled); see the script's docstring.
  Notarizing needs the bundled macOS
  archives Developer ID signed first: the Sign macOS native archives workflow
  runs `packaging/mac/sign_native_archives.py` with the release secrets (see
  [Bundled archives](../../docs/desktop-release.md#bundled-archives)).
- `python3 packaging/win/package.py`: build
  `out/Linger-<version>-x64-setup.exe` (per-user NSIS installer) and
  `out/Linger-<version>-x64.zip` on Linux after `node build.mjs` with the
  `win32-x64` daemon target. Needs the
  `wintool` image from `packaging/win/Dockerfile`. Neither is
  Authenticode-signed. The updater runs the setup program with
  `/update /relaunch` (a progress page only; Retry/Cancel prompts stay
  visible); the portable folder only links to the release page.
- `python3 packaging/linux/package.py`: build
  `out/Linger-<version>-linux-x64.tar.gz` (one folder with the `linger`
  executable) after `node build.mjs` with the `linux-x64` daemon target.

## Structure

- Connector OAuth opens in the system browser. The desktop prepares an
  expiring, one-time IPv4 loopback callback before TeamHub creates the link.
  The callback restores the originating window and forwards the return to its
  signed-in SPA, which requests TeamHub verification.

- The Web link preview panel shows other sites in native views
  (`src/main/preview-views.ts`, `preview.view` in the preload API). Each is a
  `WebContentsView` the page asks for by id (at most eight) and lays over its
  panel; a top-level page ignores framing rules (`X-Frame-Options`, CSP
  `frame-ancestors`), so every site shows. Previews share the persistent
  `persist:linger-preview` session, apart from the app's session with the
  Linger server: sign-ins made there last across restarts, and sites get no
  permissions beyond clipboard writes. They keep Electron's user agent, so
  sites that refuse embedded browsers, such as Google sign-in, need the
  system browser. Only the Linger page's main frame may drive the views. It
  learns each view's address and history after every navigation, never its
  content. A view loads only http and https; links asking for a new tab load
  in place, and only script popups (sign-in windows) open a window: at most
  two per view, titled with their site and closed with the view. A crashed
  view reloads once. While a layer of the page (a portal beside the app
  root, an open dialog or popover, or an element hit-tested over the panel)
  covers the panel, or the panel is inert or being resized, the page hides
  the view and the panel shows empty. The window closes every view when its
  page navigates, crashes or its window closes.
- Web builds without native previews still frame sites. The window drops
  framing refusals for frames of the app, except the panel's frame, named
  `linger-url-preview:<id>`. When that frame's final response refuses
  framing, the window sends `preview.frame-refused`, and the panel offers
  the system browser instead.

- `src/main/modules.ts`: `Module` interface, typed bus and the host that starts
  modules in dependency layers and stops them in reverse.
- `src/main/*.ts`: one file per module (Enrollment, WorkspaceGrants,
  ComputerDaemon, Status, PowerGuard, WindowManager, Tray, DesktopIpc). `status.ts`, `tray-menu.ts` and `tray-icon.ts` hold the pure
  status summary, tray menu and tray icons, drawn from the logo PNGs in
  `resources/tray/` with a status badge.
- `src/main/local-server.ts`: LocalServer, the setup page's Quick Install
  path. It fetches the pinned Node runtime (sources in the download region's
  order, `scripts/installs/README.md`) and unpacks the linger source package
  into the install location (the default home, or a folder picked under
  Customize; tar runs inside the target with relative paths, and the
  finished folder is moved into place with `renameRetrying`, which waits out
  Windows' short-lived locks on new files) and starts the bundled
  `dist/installer/installer.js` headless (`--no-open`), which runs every
  service natively. It drives the installer's local API itself (`InstallerApi`):
  the session from `installer/launch.html`, one job for instance `desktop`
  with the chosen AI runtime and local models, then the job's progress, which
  the setup page shows as five steps. Each Install or Try Again is a new attempt: its timers and bar
  start over, and the bar never moves back within one. There is no
  installer window. When the job waits for the runtime sign-in (its
  `runtime` stage `waiting_user`, or `RUNTIME_AUTH_REQUIRED`), it asks the
  installer (`GET /api/runtime-login`) whether the runtime is signed in
  after all; only when it is not does a "Sign in to <Runtime>" step show,
  with a dialog. Authorize starts the runtime's own login through the
  installer (`POST /api/runtime-login`). On macOS and Windows the runtime
  opens the browser on its localhost callback page itself. On Linux Desktop
  asks for Codex's `method: "browser"` login, which keeps the CLI from
  opening a browser, and opens the link itself through `xdg-open`, waiting
  for its result (`open-url.ts`), because Electron's `shell.openExternal`
  never reports failure there; when no browser opens the dialog says so.
  "Use a code on another device" restarts Codex with `method: "device"` on
  any platform, and Desktop opens that device page too. While a login runs
  the dialog shows its link with Open in browser and Copy link, and a
  Codex device code with Copy code; it checks every few seconds, closes
  once signed in and brings the window forward. A failed login's `reason`
  (`unavailable`, `timed_out`, `ended`) picks its message. Claude Code's
  paste-code form sits behind "Having trouble?"; Cancel stops the login
  (`DELETE /api/runtime-login`); the
  dialog also offers installing another runtime instead (a new job with
  that `setupChoice`). No sign-in secret passes through the page. The
  dialog also offers BYOK, with the same form as Customize's BYOK
  (`byokFields` in `setup.html`): a base URL used verbatim, an optional path
  (default `/v1`) and endpoint (default the runtime's own), key and model.
  Its refresh button and Test run the installer headless
  (`--list-byok-models`, `--check-byok`, the endpoint and key on stdin),
  which lists `base + path + /models` and sends one request to
  `base + path + endpoint` in the format the page derived from that address.
  Then it saves the installed runtime's executable and profile paths
  from the live completed job as `runtimeEnvironment` in the
  Desktop config. After sign-in, when reusing a completed job, or when the installer
  omits the runtime, it reads `GET /api/instances/desktop/runtime` for the current
  environment. The job's setup choice identifies the runtime for sign-in when available.
  On Windows that lookup can take minutes (#385, #549): the
  desktop waits for it while the installer answers, asks again after a
  dropped connection (the installer joins the running lookup), and gives up
  only after `RUNTIME_LOOKUP_LIMIT_MS` (10 minutes) with the typed `failure`
  `runtime_lookup_timed_out` or, once unreachable for the reconnect window,
  `runtime_lookup_unreachable`; the setup page words both. After 15 seconds
  the status carries `waiting: "runtime"` and the page says what the bar
  waits on. Desktop also saves the runtime its `setupChoice` runs (`local-models` runs
  on Pi) as `preferredRuntime`. The daemon config carries that as
  `preferred_runtime`, and the daemon marks that runtime's diagnostic
  `preferred`, so TeamHub creates Another Me and the starter Agents on it
  while it is ready instead of on the first ready runtime. Then it signs in
  with the local owner account, switches the window to the server and
  enrolls this computer, so setup ends on "Linger is ready". That screen shows the owner account from the instance's
  owner-only `local-account.json` (`setup-account.ts`): the email, the
  password masked until Show, Copy (the main process writes the clipboard
  and clears it after 60 s if it still holds the password) and "Open account
  file location" (`shell.showItemInFolder`); an unreadable file shows why
  instead. Only the email and file are kept; Show and Copy read the file
  again, and closing the setup window hides the password. When the
  installer set a database from the earlier Simplex app aside
  (`simplex-backup-*` in the instance, see the local-installation package),
  the desktop logs `local_server.legacy_data_set_aside`, clears its
  enrollment so it enrolls this computer again in the fresh database, keeps
  that folder as `legacyBackup` in its config so this happens once, and the
  ready screen says where the earlier data went. After a logout
  the SPA's login page asks `window.lingerDesktop.localAccount.available()`
  on load, every 15 s and when the window comes back into view; it is true
  only while the window shows the origin in `local-server.json`, the
  services are `ready` and TeamHub proves it is this installation's server
  (one check per 2 s at most). The proof: `proveLocalServer` posts a fresh
  32-byte nonce to TeamHub's own port (`POST /v0/local/identity` on
  `127.0.0.1:<source.ports.teamhub>` from `instance.json`) and compares,
  in constant time, its HMAC-SHA256 under `TEAMHUB_LOCAL_IDENTITY_KEY` (the
  instance's private `local-identity.key`, read by `readLocalIdentity`) over
  the nonce and the window's origin. The installer puts the key only in
  TeamHub's process environment, never in `services.env`, `native.env` or
  another service's environment, so no other local service can answer. A
  new key restarts TeamHub. It asks TeamHub's port rather than the web
  port, which a program could take and relay through. "Sign in with this
  computer's account": `localAccount.signIn()` reads the file in the main
  process and signs the window's session in with `signInWithPassword`,
  which proves the server first and only then posts the password to the
  same TeamHub port, setting the cookies for the origin; the install-time
  sign-in does the same. A failed proof logs `local_server.identity_unverified`
  with a reason (never the key, nonce or proof) and says "Linger on this
  computer is not responding."; the page gets only `{ ok }` or the reason it
  failed (mapped by status and error kind by `signInFailure`), never the
  password. Known gap: the proof covers TeamHub, not the web listener. If
  the web process dies and another program takes the web port while
  TeamHub stays up, the proof still passes and the sign-in sets the session
  cookies for the web origin, which that program then receives. The
  password never leaves for it, but the session does. Asking the web origin
  for a proof would not help, because the web server forwards `/v0` to
  TeamHub and a relay forwards it the same way; a fix needs a check that
  the web port belongs to the web process the installer started. Every
  existing session cookie for the origin has the same exposure.
  On a Mac older than `MIN_MACOS` (14.0, the `LSMinimumSystemVersion`
  `packaging/mac/package.py` writes), read with Electron's
  `process.getSystemVersion()`, it neither fetches Node.js nor runs the
  installer, and the failed step says "Linger needs macOS 14.0 or later.
  This Mac runs macOS <version>. Update macOS in System Settings > General >
  Software Update, then try again."; see
  [Packaging Details](../../docs/desktop-release.md#packaging-details) for
  where the minimum comes from.
  Quick Install installs the `recommendation` of the localmodels setup
  report (`installer.js --inspect`, run for the selected install location
  as the setup window opens and again when that location changes, including
  after a failed install). Checks keep their tool cache in the default home,
  leave alternative locations untouched, and never migrate installations.
  In the report, `local-models` is the planned model served by Pi, shown with the model,
  GPU, memory and download (the card's memory is the whole stack's, so
  "with its services"); otherwise the named runtime, with why there is no
  local model. The page words each reason by its code and the structured
  counts or numeric versions it carries (`gpuIndex`, `freeBytes`,
  `requiredBytes`, `detectedCudaVersion`, `requiredCudaVersion`,
  `driverVersion`); the tool's message goes only to the main process log
  (`local_server.inspected`), never to the page. Under Customize the Local
  model card stays visible once the check ends: disabled, "Not available on
  this computer", with that reason. For `cuda-driver-update-required` and
  `cuda-driver-version-unknown`, the page explains the NVIDIA graphics driver
  requirement (with required driver branch via `@linger/service-kit/nvidia-driver`),
  offers one-click verified Windows GeForce RTX driver installation
  (`driver.start-install`, downloading from NVIDIA's allowlisted CDN, verifying
  NVIDIA Authenticode signature before elevated silent install, and persisting
  `pendingDriverUpdate` across reboots), NVIDIA App launch on Windows
  (`driver.open-nvidia-app`), NVIDIA's official download and upgrade guide links
  (`SETUP_EXTERNAL_URLS`), and Check again (`local.recheck`), and auto-rechecks
  when installation completes or the setup window regains focus after a driver
  action.
  Off macOS the page names the system tray, not the menu bar.
  Under Customize the local model runs only behind Pi: with another runtime
  it is greyed (`aria-disabled`, still focusable), does not toggle, and says
  "Local models are only available with the Pi runtime."; choosing another
  runtime clears it, and choosing Pi offers it again.
  When the tool reports local models blocked now (`stack.state:
"blocked-now"`: the model fits the hardware, but other programs hold the
  memory it needs now; a tool before that field marks it by `basis:
"capacity"` or reason `free-memory-required`, either one), the install
  would plan again against the memory free then and stop, so the local model
  shows on hold and is not offered. `gpu-memory-required` names the GPU and
  its free against needed memory and says to close programs that use the
  GPU; `free-memory-required` gives the RAM counts (from the reason, or the
  tool's `stack.memory` when the reason has none). The page still words
  `gpu-ownership-unknown`, which localmodels 0.1.0.dev39 reports. Quick Install installs the
  runtime the installer recommends instead, and Check again
  (`local.recheck`) runs the check again. A tool before `stack.state` still
  recommends `local-models` there, so the installer's setup adapter
  (`packages/local-installation/src/setup-plan.ts`) replaces that pick with
  an installed runtime (signed-in first), else Codex; that override and the
  fallbacks go once the pinned tool reports `state`. The page adds no host rule of its own; while
  the check runs the button waits with a spinner and says what it waits for
  (the first run downloads the localmodels tool, counted by `download`
  event lines before the report), and Customize marks the
  recommended runtime and model. While installing, a step that downloads
  shows its bytes, what remains and the rate from the installer's byte
  counter (`localmodels.stack-progress/v1` for the local model and
  engine); a counter of one file (`partial`) shows only that file. When
  the check fails the installer picks, or Codex when it cannot inspect the
  computer either. It records the install location, source, origin and engine in
  `desktop/local-server.json` under the default home (written to a temporary
  file and renamed, so a power loss leaves the old record or none) and, while
  the window still uses that origin and the computer is enrolled, restarts the
  services on launch with `installer.js --resume`, which also restarts them
  when the instance's `user.env` changed. Before it starts the installer
  (`--resume`, or the installer that sets up) it asks
  `session.resolveProxy` for the Soniox websocket URL (`system-proxy.ts`,
  at most 1.5 s, alongside the Node runtime check) and passes an HTTP
  proxy, the first choice of a fixed or PAC setting, as
  `LINGER_SYSTEM_HTTPS_PROXY`; the installer gives it to TeamHub and
  node-services only. `DIRECT`, SOCKS, a failure or a timeout pass none,
  and an `HTTPS_PROXY` in the app's own environment wins. It logs
  `local_server.system_proxy` (`source`, `ms`), never the address. A
  system proxy changed while the app runs applies at the next launch. A
  launch whose resolution fails (a PAC or WPAD lookup past the timeout, or a
  PAC server not up yet) passes none, so TeamHub and node-services restart
  without the proxy, and the next launch that resolves it restarts them with
  it again. When another program took the web
  port, the installer moves the services to a free one and reports the new
  origin (`details.origin`, or the setup job's `origin`). The record, the
  window's `serverUrl` and the `savedEnrollments` entry follow it together
  (`setServer` with the previous origin emits `server.moved`, not
  `server.changed`), so the Computer stays enrolled: it reaches TeamHub
  through the gateway URL TeamHub gave it, and the session cookies are not
  port-scoped. The record and `serverUrl` change only together, so a later
  launch still resumes. A source folder removed since, or
  one the installer no longer accepts as a Linger checkout (such as one the
  earlier Simplex app unpacked, or this package's own folder with files
  missing since), is unpacked again from the app's package first and
  replaces the recorded one. The record also names the app
  version that unpacked the source; when this app brings another source
  package (it was installed over an older one), that launch unpacks it and
  resumes on it, with the "Updating Linger" page instead of the older
  interface. Only when the installer reports the services serving from the
  new folder (`details.source`) and the origin answers does it record that
  folder and prune the older one; otherwise the older services keep running
  from their folder, the record keeps naming it, and the start failure page's
  Retry moves them again. A prune never removes a folder a running process
  still starts from (`foldersInUse`; when processes cannot be listed, it
  removes nothing) and logs `local_server.source_in_use` instead. An app older than the recorded version
  (a downgrade) leaves the services on their newer source and logs
  `local_server.source_newer_than_app`. When local models fail to come back on a
  resume, the installer still brings up the services and reports
  `details.localModelsDegraded`, which the desktop logs as
  `local_server.local_models_unavailable` and exposes on
  `LocalServerStatus.localModelsDegraded` so the person can still reach the
  workspace and the Models page. If an older installer still fails a resume for
  the local model, the start failure names the stack's first known binding reason code
  (`details.reasons`, such as `pi-extensions-unavailable`) in its own words
  and, by `details.code` and `details.causeCode`, the action that works:
  Set Up Again for `LOCAL_MODELS_APPROVAL_REQUIRED` and for
  `LOCAL_MODELS_RECOVERY_REQUIRED` when `details.causeCode` indicates the saved
  plan cannot be re-applied without replanning (`STACK_REPLAN_FAILED`,
  `STACK_PLAN_CHANGED`, `STACK_APPROVAL_MISMATCH`, `STACK_PLAN_INVALID`), and
  Try Again or Set Up Again for transient `LOCAL_MODELS_RECOVERY_REQUIRED`
  failures (the resume applies the approved plan again). During Quick Install,
  `LOCAL_MODELS_RECOVERY_REQUIRED` with `binding-unavailable` in
  `errorReasons` skips blind replanning and surfaces the structured reason copy;
  transient apply failures (`STACK_COMPONENT_FAILED`, `STACK_APPLY_INTERRUPTED`)
  after a plan was approved in the same run retry that approved plan once to
  resume downloads instead of forcing a replan, while other
  `LOCAL_MODELS_RECOVERY_REQUIRED` causes (including ones without a prior
  approval in the same run) still replan once, and `LOCAL_MODELS_UNAVAILABLE`
  selects user guidance by `errorCauseCode` (`HUB_UNREACHABLE`,
  `DISK_INSUFFICIENT`, `GPU_CONFLICT`, `STACK_PLAN_FAILED`, or memory when
  `MEMORY_INSUFFICIENT`/absent). While installing or resuming, `LocalServer`
  emits `local-server.busy` so `PowerGuard` keeps the system from suspending
  mid-download without toggling the saved `preventSleep` preference. A Quick Install that stopped
  before the computer enrolled is not resumed: setup shows again and Install
  finishes it, reusing a finished job only while its origin answers (a stopped
  server gets a new job, which starts the services again). It follows a
  running or finished job only when that job's `setupChoice` is what the
  person chose now (`local-models` for the local model; any but
  `local-models` for the installer's pick); otherwise it asks for a new job.
  The installer answers at once with that job `queued` and runs it once it
  has stopped the earlier one, such as a local model download that kept
  running after a quit or services still starting; setup polls the queued
  job like any other, so a subscription chosen since never shows the earlier
  download. The start failure
  page's Set Up Again forgets the record (`local-server.json`), clears the
  active enrollment while keeping per-origin `savedEnrollments` in
  `config.json` (`legacy_data_set_aside` clears `savedEnrollments` as well),
  clears the server address, and shows setup; the instance and its data stay.
  `Enrollment` (`src/main/enrollment.ts`) sends the local `daemon_id` derived
  from `<userData>/computer/state/daemon-identity.json`'s public key along
  with any remembered `computerId` for that origin and owner so re-enrolling or
  recovering an interrupted exchange renews the existing Computer ID and
  surfaces `DAEMON_IDENTITY_IN_USE` / `DAEMON_IDENTITY_MISMATCH` conflicts.
  It sends `daemon_id` only when the server's `/v0/me` lists the
  `local_computer_enrollment_daemon_id` server capability; a TeamHub older
  than the desktop omits it and would reject the field. `config.json` keeps
  the `daemonId` the active enrollment named, and at start an enrollment that
  named none or another one is renewed once the server lists the capability,
  so a computer an earlier Set Up Again paired anew gets back the Computer
  that holds its Daemon Identity, with its Agents. TeamHub removes the Computer
  the renewal named when it never bound a Daemon Identity and has no Agents
  (the orphan that earlier Set Up Again left), in the same transaction.
  Before installing or resuming it moves the
  `COMPOSIO_API_KEY`, `SONIOX_API_KEY`, `XAI_API_KEY` and `TZ` of an unpacked
  source package's `.env` into `<home>/instances/desktop/user.env` once and
  deletes that `.env` (never a `LINGER_CHECKOUT`'s), logging only the names
  of other values it drops; the installer reads only `user.env` for the
  desktop. Setup fails immediately on `identity_conflict`, `auth_failed`, or
  `upgrade_required` daemon connection states (`computer-daemon.ts` maps
  `identity-conflict` to `identity_conflict`, and `status.ts` summarizes it as
  an error asking to reconnect), then waits up to five minutes for the
  server to create the Another Me and for the enrolled Computer to report
  `online` when `local-computers` is served; on timeout it reads
  `local-computers` and says what is missing (offline computer, no writable
  folder, or no signed-in runtime with each runtime's reported state) and logs
  `local_server.another_me_missing` or
  `local_server.computer_offline_after_agents`. Customize → API keys takes the
  Composio key only (`provider-keys.ts`); voice keys are saved in the app,
  and a `SONIOX_API_KEY` or `XAI_API_KEY` written into `user.env` by hand
  still reaches the services and overrides the app's. Install saves the edits
  before the installer starts (`installer.js --instance desktop --user-keys`,
  the keys on stdin) into the owner-only `instances/desktop/user.env` of the
  install location, and the page only learns which keys are saved. Both
  engines pass them to the services whenever they are configured (an edit
  runs a new job even after a finished one); Native also starts its bundled
  LiveKit whenever this computer has voice tools, with or without a voice
  key (see Source Package and Release). There is no settings page
  after setup yet: keys change on the next Install or Try Again.
- `src/main/diagnostics.ts`: Diagnostics, "Show Logs" (opens
  `<userData>/logs`) and "Save Diagnostics" (a redacted
  `linger-diagnostics-<time>.zip` in Downloads) for the setup page's failed
  step, the start failure page and the tray; the Web client's Settings runs
  the same save through the preload's `diagnostics.save`. The zip holds the
  Desktop logs and `config.json`, the installer job JSON and logs, the
  instance JSON and service logs under each install home. Credential files (`gateway.json`, `caller.key`,
  `control.key`, `credential.json`, `launch.html`, `*.env`, `*.input.json`,
  keys, cookies, databases) never go in, every saved voice key is replaced
  wherever a log printed it, and every text passes through `redact` plus a
  secret-key JSON filter, and the person's home folder becomes `~`. It also
  bundles the newest bounded `localmodels` stack run records
  (`runtime/localmodels/state/stacks/*.run.json` and `.progress`), local
  deployment records (`runtime/localmodels/state/deployments/local/*.json`),
  and deployment engine logs (`runtime/localmodels/models/deployments/*/server.log`),
  capped in count and byte size and excluding `byok.json`, `api-key`, and model
  weights. It
  imports no Electron API, so it is tested with Windows paths on any
  platform.
- `src/main/diagnostics-upload.ts`: "Send Diagnostics" on the setup page, the
  start failure page and the tray, shown only while a receiver is set up
  (`diagnosticsUploadUrl` in `config.json`, else `HOSTED_DIAGNOSTICS_UPLOAD_URL`, which `build.mjs` bakes
  in from the release pipeline's `LINGER_DIAGNOSTICS_UPLOAD_URL` secret and
  leaves unset in other builds). `DiagnosticsSender` builds the zip
  into `<userData>/diagnostics-outbox`, waits for consent showing every file,
  the size and the host, uploads it with the
  [`linger.diagnostics-upload/v1`](../../docs/diagnostics-upload.md)
  protocol and shows the receiver's report id; a retryable failure keeps the
  zip for Try Again. The setup page draws the flow itself; the tray and the
  start failure page use native dialogs (`diagnostics-dialogs.ts`).
- `src/main/window-manager.ts`: one `BaseWindow` with two views, the title bar
  (`app://shell/titlebar`) and the SPA. macOS keeps native traffic lights,
  Windows uses `titleBarOverlay`, Linux draws its own controls. Closing hides
  the window to the tray. Closing the setup window does not quit either: an
  installation keeps running, and opening Linger again (a second launch, the
  Dock, the tray) shows setup until the computer is enrolled
  (`app-window.ts`), the main window after. The main window's server form
  without a server says Back to Setup instead of Cancel.
  Main window loading policy (`windowLoadDecision` in `src/main/navigation.ts`):
  all server loads (`boot`, `local_ready`, `resume_ready`, `server_changed`,
  `port_moved`, `retry`, `prewarm`) pass through one decision helper so
  duplicate `loadURL` calls on hot start are skipped when the target origin is
  already loaded or pending without a shell page or load failure. `BaseWindow`
  is created with `show: false` and revealed on the first `did-finish-load` or
  `did-fail-load` after `show()`, with a short 1500 ms timeout fallback so a
  stalled load still reveals the window; `preloadAuthenticated` loads the
  enrolled server in the hidden window without showing it, and `prewarmAssets`
  warms `/` and `/assets/*` in `session.defaultSession`'s HTTP cache. On
  launch the window loads `serverUrl` without a blocking HTTP probe; if
  `did-fail-load` fires for the current `serverUrl` and
  `localServer.isStarting(serverUrl)` sees an active resume (or a valid
  matching `local-server.json` before `LocalServer.start()` runs), it shows the
  Starting page instead of `offline.html`; stale failures from an older port
  are ignored, and `setServer` pushes the updated origin to the title bar right
  away. `window.did_finish_load` logs
  `{ reason, duration_ms, target }` with origin + pathname only (never query or
  hash), and `LocalServer` resume emits `local_server.resume_started`,
  `local_server.resume_stage` (`stage`, `ms`), `local_server.resume_succeeded`
  (`total_ms`), and `local_server.resume_failed` (`stage`, `total_ms`,
  redacted `error` bounded to 500 chars with query/hash stripped). A resume
  whose saved BYOK gateway did not come back still succeeds and logs
  `local_server.byok_gateway_unavailable` (`code`, `message`); the Computer
  mounts the gateway again before the next Run on it. Once ready, a server
  the window shows can still stop: its supervisor restarts it, and the
  desktop resumes it like a launch when it does not answer
  (`local_server.unreachable_resume` with `trigger`): at once on
  `local-server.retry`, and after `UNREACHABLE_GRACE_MS` (longer than the
  supervisor's restart delays) on `local-server.unreachable` (WindowManager
  emits it when it shows `offline.html` for a failed load) or the
  `WATCH_MS` watch. Those two resume at most once a minute, and only after
  `UNREACHABLE_PROBES` checks in a row spread over the grace went unanswered,
  each allowed `UNREACHABLE_PROBE_TIMEOUT_MS` (longer than the launch's 1 s
  fast check), so a server slowed by heavy load is not taken for a stopped
  one; a resume that fails shows the start failure page as on launch.
- `src/main/voice-window.ts`: the floating voice window. Electron cannot open
  Document Picture-in-Picture windows, so the SPA opens a small native window
  with `window.open("")` under the target `linger-voice-window-<n>`
  (`voiceWindowRequest` in `navigation.ts` allows only that, from the server's
  page; every other `window.open` is still denied) and renders its Voice Mode
  or Recording window into it, so the call and its state stay in the main
  page. The window is always on top (on every macOS Space), has no
  parent so it stays up when the main window is minimized or closed to the
  tray, and closes with the page (reload, crash, main window closed). While it
  is open the page is not background-throttled. Only a window the main page
  itself opened is kept; one from a frame in it is destroyed. It opens at the
  bottom right of the main window's screen and resizes down to 240x96. Its
  native close button ends the call or the recording;
  `lingerDesktop.voiceWindow.showMainWindow()` (its presence is how the SPA
  knows the app supports this) restores and focuses the main window, on macOS
  bringing the app in front of the active one, and the SPA then closes the
  floating window and keeps the session in the page. An app without
  `voiceWindow` keeps the in-page windows.
- `src/shell/*.html`: app-owned pages (title bar, offline/setup page). They
  have no network access and talk to the main process via `src/preload/shell.ts`.
  Their text lives in the `*.messages.ts` beside them; the main process
  serves each page through `localizePage` (`src/i18n/page.ts`), which adds the
  page's messages in the current language and the small runtime in
  `src/shell/messages.html` (`t`, `tSpans`, and `data-t` / `data-t-<attribute>`
  fill-in). Markup carries message names, never English or translated text.
  The setup page stays sandboxed with `window.open` and navigation blocked;
  the main process flags checked Inkling 2 Mini models with `featuredInkling`
  via `@linger/service-kit/featured-models`, preload exposes
  `featuredAnnouncementUrl`, and external partner links call
  `setup.run({ op: "external.open", url })`, which accepts only the exact
  HTTPS URLs listed in `SETUP_EXTERNAL_URLS` (`src/shared/setup.ts`) and opens
  them through `shell.openExternal`.
- `src/i18n`: the shell's languages (English and Simplified Chinese) on the
  shared core `@linger/service-kit/messages`. `language.ts` matches a language
  and formats messages; `locales/zh-CN.json` is the shell's Chinese catalog,
  one namespace per `*.messages.ts`, following the Web glossary
  (`apps/web/src/i18n/locales/zh-CN.glossary.md`). `catalog.test.ts` finds
  every `*.messages.ts` and fails on a missing or extra translation, a changed
  placeholder or tag, or a page naming a message it lacks.
- `src/main/language.ts`: Language. The shell follows the language picked in
  the Web client's Settings, which the SPA reports (`language.set`) once a
  choice is stored; the main process keeps it in its config. Before any
  choice it follows the system's preferred languages (Simplified Chinese for
  `zh`, `zh-CN`, `zh-Hans-*`; English otherwise). A change emits
  `language.changed`: the tray menu and status rebuild, the title bar reloads,
  and the offline page takes it on its next load. The setup page takes the
  language when it opens; it runs before the SPA has ever reported one, so it
  uses the stored choice or the system's language. Main-process text (menus,
  dialogs, notifications) uses `Language.t` with the messages in
  `src/main/*.messages.ts`; a message missing from the catalog shows in
  English. Errors from transfers and servers stay in English.
- `src/preload/index.ts`: the only SPA API, `window.lingerDesktop`. Its
  `update` reads the Updater's state (without the release page URL) and runs
  the tray's install and check, for the SPA's account menu; `settings` exposes
  `preventSleep` (`get`, `set`, `onChange`) so Settings › Computers mirrors and
  stays in sync with the tray's Prevent Sleep toggle; `driverUpdate`
  (`src/main/driver-updater.ts`, `src/main/windows-driver-platform.ts`) detects
  and launches NVIDIA App / GeForce Experience on Windows, opens the allowlisted
  NVIDIA download/guide URLs, and on Windows x64 runs verified one-click GeForce
  RTX DCH WHQL downloads (allowlisted CDN, Windows Authenticode check, elevated
  `-s -noreboot -noeula` install, `PowerGuard` sleep block, and `config.json`
  `pendingDriverUpdate` post-reboot resume) with `getInstallState` /
  `onInstallState` / `startInstall` / `clearInstallState`.
- `src/shared/api.ts`, `src/shared/shell.ts`: preload contract types and IPC
  channel names.
- `src/main/computer-daemon.ts`: ComputerDaemon. While the computer is
  enrolled it writes `<userData>/computer/config.json` (owner-only; Computer
  id, name, Gateway URL, workspace grants and the bundled teamhub CLI
  directory) and starts `linger-computer-daemon --config <file>` with the
  credential in `LINGER_COMPUTER_TOKEN` (`gateway.token_env`). The config's
  `desktop` section puts the daemon in Desktop mode: no self-update, it exits
  when its stdin closes, and it reports `{"type":"status",...}` lines on
  stdout (`gateway_state`, `active_operations`, `active_model_invokes`).
  `active_operations` drives the tray busy state, quit confirmation, idle
  restarts, updater waiting and the SPA status (`runtime.activity`);
  `active_model_invokes` (omitted by older daemons, treated as `0`) emits
  `runtime.model_activity` for `PowerGuard` only, so background model calls
  (Memory, Wiki) hold `prevent-app-suspension` while running and through a
  short release tail (`MODEL_ACTIVITY_TAIL_MS`) without marking the Computer
  busy. Its log goes to
  `<userData>/logs/computer-daemon.log`. Crashes and launch failures retry
  with backoff. The Desktop reports the reason after three consecutive
  attempts fail before the daemon reports a status. The exit log
  (`computer_daemon.exited`) records the last stderr line outside the
  daemon's log records, when present, or the `panic:` line for a Go panic.
  A synchronous launch failure logs the error as `computer_daemon.launch_failed`.
  Invalid launch arguments are reported without their values.
  New folders or a new name restart the daemon once tasks finish.
  On macOS it writes `{"type":"hello","features":["permissions.v1"]}` to
  the daemon's stdin after spawn and answers `permission.request` lines with
  `permission.response` from `src/main/system-permissions.ts` (the app's
  own Screen Recording and Accessibility, which shell commands of Agents
  are attributed to); a `relaunch` request is answered, then quits and
  relaunches the app. The permission card in the SPA running this
  computer's own Computer takes Linger's steps (prompt, System Settings,
  relaunch) and opens CuaDriver's System Settings pane through
  `lingerDesktop.permissions.act` instead; CuaDriver's prompt and restart,
  and every step from another page, go through TeamHub to the daemon.
- `src/main/computer-credential.ts`: the Gateway credential in
  `<userData>/computer/credential.json` (0600).
- Installs from before the product was renamed Linger move once on start.
  `index.ts` renames the packaged app's data folder from `<appData>/Simplex`
  to `<appData>/Linger` before `app.setPath("userData")`. A `Linger` folder
  that already holds `computer/credential.json` wins and the old folder stays
  (logged as `desktop.legacy_user_data_kept`); one without a credential is set
  aside as `Linger.before-move-<time>`, so the Computer keeps its identity.
  LocalServer runs `installer.js --migrate` when an instance record still
  carries a `simplex-` project name, in the default home and in the home
  `desktop/local-server.json` names when the person chose another install
  location, before it resumes
  (`packages/local-installation/src/legacy-migration.ts`). Instances the
  installer left unconverted are logged as
  `local_server.legacy_instance_skipped` with their home and reason and do
  not hold the app back; only when `desktop` in the home in use stayed
  unconverted, or the installer could not run there, LocalServer enters the
  failed state with that reason, and Retry runs the migration again. There is
  no downgrade path: an older build reads neither the converted instances nor
  the moved data folder. The bundle ID and
  Windows AppUserModelID are `com.simplexai.linger.desktop.preview`. On
  Windows, `markStartMenuShortcut` (`src/main/start-menu-shortcut.ts`) updates
  `Linger.lnk` only when `LINGER_DESKTOP_USER_DATA` is unset and the shortcut
  already targets the current executable (after canonicalizing both absolute
  paths); write failures log a warning without aborting startup. The
  Windows setup installs into `%LOCALAPPDATA%\Programs\Linger`; on upgrade it
  closes and removes `%LOCALAPPDATA%\Programs\Simplex` and moves the
  "Open at login" Run value from `ai.simplex.desktop.preview` to the new id.
  The uninstaller (per-user, like the setup) first runs `Linger.exe --quit`,
  which a running Linger obeys without asking, then the bundled
  `installer.js --instance desktop --stop` under `ELECTRON_RUN_AS_NODE`. That
  stops the installation manager the desktop started (cancelling a running
  job) and the `desktop` instance's services in the default home and in the
  location `desktop/local-server.json` names; services already stopped are
  left alone and it gives up after about two minutes. When the stop fails,
  the uninstaller offers Retry; Cancel (the default when silent) ends it with
  exit code 1 before anything is removed, so the uninstall can be run again.
  The stop helper records its latest outcome in `<home>/installer/stop-latest.json`
  and retains the first failure in `stop-first-failure.json`. These bounded
  records contain only allowlisted failure stages, codes and service names,
  never error text or paths; a successful retry keeps the first failure.
  It keeps `%APPDATA%\Linger` and the Linger home with all their data; a
  later install starts the services again (resume, or setup's Install).
  Setup over an installed release stops it the same way before it replaces
  the files, since the services run on `Linger.exe` and hold it open. Setup
  always stops them with its own `installer.js`, copied to the plugins
  folder, on the old `Linger.exe`: an earlier release's script may not stop
  them (0.1.2's left TeamHub, web and node-services running on Windows). Each
  install writes `resources\stops-services`; a release without it would start
  on `--quit`, so setup skips `--quit` for it (CloseLinger asks the person to
  quit a running app). Retry in that prompt runs the stop again. Nothing running: the stop finds nothing and setup goes on. The
  stop also asks the pinned localmodels kit, when that kit is installed in the
  home, to unload every model its model library loaded (`library status`,
  then `library cancel` for each `loading` model, `library status` every
  500 ms for up to 10 s until none is loading, and `library unload` for each
  model the last read shows `loaded`; a model still loading then is a stop
  failure), to end its foundations
  controller under `runtime/model-services` (`foundations stop`), and to stop
  the stack's processes and the gateway the tool started, the library's
  Bifrost included (`stack down`); it downloads nothing, and Linger does not
  end the tool's processes itself. Every stop command runs even when an
  earlier command fails. A present tool kit that fails verification makes
  the stop fail, so the uninstaller retains the application for repair and
  retry.
  On Windows the tool cannot prove and end a controller from a kit that has
  no stop command.
  A quit the person chose (the tray, the app menu, the Dock) does the same
  for the local models, except the controller, which serves the services
  that keep running: `LocalServer` starts `installer.js --home <default
home> --stop-local-models` under `ELECTRON_RUN_AS_NODE`, detached, with
  its output in `<home>/installer/local-models-stop.log`, and does not wait
  for it. If the installed kit fails verification, the helper exits with a
  failure and logs the repair guidance; the app still quits, and no unverified
  tool runs. It runs only when `desktop/local-server.json` names an
  installation. The Computer exits with the app, so nothing uses the models
  until the next launch, whose resume applies the approved plan again even
  though the services still run, unless the person switched the Computer's
  model source to a subscription; a BYOK source gets its gateway mounted
  again instead. A
  quit for an update or a relaunch, and the `--quit` of setup or the
  uninstaller (which stop the models themselves right after), leave them.
- `src/main/legacy-migration.ts`: on start, stops a bridge an older version
  left running and moves its credential and the Desktop 0.16 daemon identity
  into the daemon layout, so the computer keeps its id.
  `src/main/legacy-bridge.ts` keeps only the old bridge paths and the socket
  handshake that this needs; the bridge itself was deleted.
- `scripts/build-daemon.mjs`: cross-compiles the daemon, stamped with the
  `apps/computer` release the Gateway checks.
- `scripts/stage-computer-tools.mjs`: stages the browser and computer-control
  tools and their Node.js for each daemon target into
  `dist/computer-tools/<target>/` with the root
  `scripts/computer-tool-bundle.mjs`; `packaging/computer_tools.py` puts them in
  `resources/cli/` and `resources/runtime/` and checks every package for them
  (see [Computer Tools](../../docs/desktop-release.md#computer-tools)).

## Important Conventions

- Brand artwork lives in `apps/assets/logo`. Its exporter synchronizes desktop
  resources; macOS tray assets contain only the monochrome L and dot, while
  other platforms use the full-color dark tile with runtime status badges.

- Business logic stays in the main process or the backend. The daemon only
  executes Runner commands.
- The gateway credential lives only in the credential file and the daemon's
  environment, never in `config.json` or logs. Never log cookies, credentials
  or channel bodies.
- Every IPC handler checks that the sender frame is on the configured server
  origin and validates input with zod. The SPA cannot change the server URL.
- Keep Electron imports out of files with unit tests; inject Electron APIs.

## Local Full Stack

1. In the repository root, start everything with `pnpm dev` against your
   PostgreSQL (the Web dev server on `http://127.0.0.1:3000`, TeamHub, the
   Agent Service and the rest), or with `docker compose up --build`.
2. Install the DMG from `packaging/mac/package.py` (or run
   `pnpm --filter @linger/desktop start`) and enter
   `http://127.0.0.1:3000` as the server address during setup. That is the
   only value the user enters; enrollment returns the rest.
3. With the default local configuration the computer connects to the Agent
   Service at `ws://127.0.0.1:4319/v1/runner-gateway` and the bundled teamhub
   CLI talks to `TEAMHUB_BASE_URL`. When these services are not reachable from
   the computer at those addresses (another host, a tunnel), set
   `AGENT_RUNNER_PUBLIC_GATEWAY_URL` and `TEAMHUB_CLI_BASE_URL` to origins the
   computer can reach.
4. The computer needs Codex or Claude Code installed and signed in; the
   daemon finds them through the login shell PATH. The teamhub CLI runs on
   the app's own Node (`ELECTRON_RUN_AS_NODE`) in packaged builds and on the
   `node` in PATH from source. The Desktop TeamHub shell launcher uses
   `wslpath` and `WSLENV` when WSL starts the Windows executable, so the
   script path and `ELECTRON_RUN_AS_NODE` reach that process correctly.
   The CLI translates absolute Linux paths for local attachments, input files
   and Document file outputs using the invoking WSL distribution. Message text
   and remote paths stay unchanged. The same local file checks apply to the
   translated path.

## Source Package and Release

Read [Packaging Details](../../docs/desktop-release.md#packaging-details) before
changing `build.mjs`, `packaging/`, `distribution/`, the source package, or the
bundled native PostgreSQL, voice tools, TeamHub, or services, and before
building a package.

## Development Environment

- `LINGER_SERVER_URL`: initial server origin.
- `LINGER_CHECKOUT`: a linger checkout that local installs use instead of
  the source package; the setup page does not show it. Keys come from the
  instance's `user.env` there too: the checkout's `.env` is not read.
- `LINGER_DESKTOP_USER_DATA`: separate user data directory.
- `LINGER_COMPUTER_DAEMON`: daemon executable to run instead of the bundled
  one (`resources/computer/` when packaged, `dist/computer/` from source).
- `LINGER_BRIDGE_STATE_DIR`: where an older version's bridge kept its state,
  for the one-time migration.
- `LINGER_CODEX_PATH`, `LINGER_CLAUDE_PATH`, `LINGER_PI_PATH`: absolute
  runtime paths for the daemon config. Other `LINGER_*` and `ELECTRON_*`
  variables do not reach the daemon. The config's
  `runtimeEnvironment` (the local server's runtime: these paths plus
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`) replaces them,
  names compared case-insensitively for Windows. Its four
  `LINGER_LOCALMODELS_*` paths become the daemon config's `local_models`
  section, which the daemon's model library runs. Every `--resume` reports
  the runtime again; a change updates `runtimeEnvironment` and restarts the
  daemon once its tasks end (`computer.runtime`), so an install from before
  the daemon knew the tool gains it.
- `LINGER_LOCALMODELS_DEV_PYTHON`, `LINGER_LOCALMODELS_DEV_MODULE_DIR`:
  absolute Python and module directory for running a local `localmodels`
  checkout in Quick Install and the Desktop Computer without fetching the
  published kit. `LOCALMODELS_DEBUG` (`simulate` or `tiny`) or
  `~/.config/localmodels/debug.json` enables fast local-model testing in both
  source and packaged builds.
- Without a display, run with `--ozone-platform=headless --disable-gpu`. The
  tray and native menus are skipped in that mode; use Xvfb to check them.
