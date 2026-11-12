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
  staple; see the script's docstring.
- `python3 packaging/win/package.py`: build
  `out/Linger-<version>-x64-setup.exe` (per-user NSIS installer) and
  `out/Linger-<version>-x64.zip` on Linux after `node build.mjs` with the
  `win32-x64` daemon target. Needs the
  `wintool` image from `packaging/win/Dockerfile`. Neither is
  Authenticode-signed and Windows has no self-update yet.
- `python3 packaging/linux/package.py`: build
  `out/Linger-<version>-linux-x64.tar.gz` (one folder with the `linger`
  executable) after `node build.mjs` with the `linux-x64` daemon target.

## Structure

- `src/main/modules.ts`: `Module` interface, typed bus and the host that starts
  modules in dependency layers and stops them in reverse.
- `src/main/*.ts`: one file per module (Enrollment, WorkspaceGrants,
  ComputerDaemon, Status, PowerGuard, WindowManager, Tray, DesktopIpc). `status.ts`, `tray-menu.ts` and `tray-icon.ts` hold the pure
  status summary, tray menu and tray icons, drawn from the logo PNGs in
  `resources/tray/` with a status badge.
- `src/main/local-server.ts`: LocalServer, the setup page's Quick Install
  path. It fetches the pinned Node runtime and unpacks the linger source package
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
  installer (`POST /api/runtime-login`), which opens the browser on its
  localhost callback page itself; Desktop opens only a Codex device page.
  The dialog waits, checks every few seconds and closes once signed in. The
  printed link and Claude Code's paste-code form sit behind "Having
  trouble?"; Cancel stops the login (`DELETE /api/runtime-login`); the
  dialog also offers installing another runtime instead (a new job with
  that `setupChoice`). No secret passes through the page. Then it saves the
  installed runtime's executable and profile paths
  (`GET /api/instances/desktop/runtime`) as `runtimeEnvironment` in the
  Desktop config, and the runtime its `setupChoice` runs (`local-models` runs
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
  again, and closing the setup window hides the password. After a logout
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
  Quick Install installs the `recommendation` of the localmodels setup
  report (`installer.js --inspect`, run once as the setup window opens):
  `local-models` is the planned model served by Pi, shown with the model,
  GPU, memory and download; otherwise the named runtime, with the tool's
  reason for no local model. The page adds no host rule of its own; while
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
  when the instance's `user.env` changed. A source folder removed since is
  unpacked again from the app's package first. A Quick Install that stopped
  before the computer enrolled is not resumed: setup shows again and Install
  finishes it, reusing a finished job only while its origin answers (a stopped
  server gets a new job, which starts the services again). The start failure
  page's Set Up Again forgets the record, unenrolls the computer, clears the
  server address and shows setup; the instance and its data stay. Before installing or resuming it moves the
  `COMPOSIO_API_KEY`, `SONIOX_API_KEY`, `XAI_API_KEY` and `TZ` of an unpacked
  source package's `.env` into `<home>/instances/desktop/user.env` once and
  deletes that `.env` (never a `LINGER_CHECKOUT`'s), logging only the names
  of other values it drops; the installer reads only `user.env` for the
  desktop. Setup then waits up to five minutes for the
  server to create the Another Me; on timeout it reads `local-computers` and
  says what is missing (offline computer, no writable folder, or no signed-in
  runtime with each runtime's reported state) and logs
  `local_server.another_me_missing`. Customize → API keys takes the
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
  step, the start failure page and the tray. The zip holds the Desktop logs
  and `config.json`, the installer job JSON and logs, the instance JSON and
  service logs under each install home. Credential files (`gateway.json`, `caller.key`,
  `control.key`, `credential.json`, `launch.html`, `*.env`, `*.input.json`,
  keys, cookies, databases) never go in, every saved voice key is replaced
  wherever a log printed it, and every text passes through `redact` plus a
  secret-key JSON filter. It imports no Electron API, so it is
  tested with Windows paths on any platform.
- `src/main/window-manager.ts`: one `BaseWindow` with two views, the title bar
  (`app://shell/titlebar`) and the SPA. macOS keeps native traffic lights,
  Windows uses `titleBarOverlay`, Linux draws its own controls. Closing hides
  the window to the tray. Closing the setup window does not quit either: an
  installation keeps running, and opening Linger again (a second launch, the
  Dock, the tray) shows setup until the computer is enrolled
  (`app-window.ts`), the main window after. The main window's server form
  without a server says Back to Setup instead of Cancel.
- `src/shell/*.html`: app-owned pages (title bar, offline/setup page). They
  have no network access and talk to the main process via `src/preload/shell.ts`.
- `src/preload/index.ts`: the only SPA API, `window.lingerDesktop`.
- `src/shared/api.ts`, `src/shared/shell.ts`: preload contract types and IPC
  channel names.
- `src/main/computer-daemon.ts`: ComputerDaemon. While the computer is
  enrolled it writes `<userData>/computer/config.json` (owner-only; Computer
  id, name, Gateway URL, workspace grants and the bundled teamhub CLI
  directory) and starts `linger-computer-daemon --config <file>` with the
  credential in `LINGER_COMPUTER_TOKEN` (`gateway.token_env`). The config's
  `desktop` section puts the daemon in Desktop mode: no self-update, it exits
  when its stdin closes, and it reports `{"type":"status",...}` lines on
  stdout, which drive the tray and the SPA status. Its log goes to
  `<userData>/logs/computer-daemon.log`. Crashes restart with backoff; new
  folders or a new name restart it once tasks finish.
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
  carries a `simplex-` project name, before it reads
  `desktop/local-server.json`
  (`packages/local-installation/src/legacy-migration.ts`). A failed migration
  puts LocalServer in the failed state with the installer's error, which names
  each instance that is still legacy; Retry runs the migration again. There is
  no downgrade path: an older build reads neither the converted instances nor
  the moved data folder. The bundle ID and
  Windows AppUserModelID are `com.simplexai.linger.desktop.preview`. The
  Windows setup installs into `%LOCALAPPDATA%\Programs\Linger`; on upgrade it
  closes and removes `%LOCALAPPDATA%\Programs\Simplex` and moves the
  "Open at login" Run value from `ai.simplex.desktop.preview` to the new id.
- `src/main/legacy-migration.ts`: on start, stops a bridge an older version
  left running and moves its credential and the Desktop 0.16 daemon identity
  into the daemon layout, so the computer keeps its id.
  `src/main/legacy-bridge.ts` keeps only the old bridge paths and the socket
  handshake that this needs; the bridge itself was deleted.
- `scripts/build-daemon.mjs`: cross-compiles the daemon, stamped with the
  `apps/computer` release the Gateway checks.

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
   `node` in PATH from source.

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
  names compared case-insensitively for Windows.
- Without a display, run with `--ozone-platform=headless --disable-gpu`. The
  tray and native menus are skipped in that mode; use Xvfb to check them.
