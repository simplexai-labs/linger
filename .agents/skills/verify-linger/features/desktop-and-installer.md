# Desktop Client and Local Installer

Verify installation, packaging, first-run setup, lifecycle, auto-updates, permissions, diagnostics, and uninstallation for the Linger Desktop app (`apps/desktop`), standalone Local Installer (`apps/linger-installer`), and native Local Installation engine (`packages/local-installation`) across Linux, macOS, and Windows.

Use the [shared execution and evidence rules](README.md).
Standalone CLI Computer installation (`linger-computer.sh` / `linger-computer.ps1`), Docker Compose self-hosting, Runner smokes, and detailed desktop/browser MCP tool probes live in [Local Computer](local-computer.md).
Local model hardware planning, downloads, library actions, and BYOK model-source configuration live in [Local Models and BYOK](local-models-and-byok.md).

Authoritative references:

- [Desktop Release](../../../../docs/desktop-release.md)
- [Local PostgreSQL](../../../../docs/local-postgresql.md)
- [Diagnostics upload](../../../../docs/diagnostics-upload.md)
- [Desktop guide](../../../../apps/desktop/AGENTS.md)
- [Local Installer guide](../../../../apps/linger-installer/AGENTS.md)
- [Local Installation engine guide](../../../../packages/local-installation/AGENTS.md)

## Platform support matrix

### Shipped vs unsupported Desktop targets

| Target         | Shipped Desktop build | Artifacts                                                                 | Notes                                                                                         |
| -------------- | --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `darwin-arm64` | Yes                   | `Linger-<v>-macos-arm64.dmg`, `Linger-<v>-macos-arm64.app.tar.gz`         | Requires macOS 14.0+ (`LSMinimumSystemVersion` and `MIN_MACOS`). Apple silicon only.          |
| `linux-x64`    | Yes                   | `Linger-<v>-linux-x64.tar.gz`                                             | Portable archive (no `.deb`, `.rpm`, or AppImage). Bundled native runtime needs glibc ≥ 2.35. |
| `win32-x64`    | Yes                   | `Linger-<v>-windows-x64-setup.exe`, `Linger-<v>-windows-x64-portable.zip` | Per-user NSIS installer (`%LOCALAPPDATA%\Programs\Linger`, no admin) plus portable zip.       |
| `darwin-x64`   | No                    | None                                                                      | Intel Macs have no Desktop package or native bundle; use Docker Compose (`self-hosting.md`).  |
| `linux-arm64`  | No                    | None                                                                      | No Desktop package or native distribution manifest (standalone `localmodels` kit exists).     |
| `win32-arm64`  | No (native)           | None                                                                      | No native arm64 Desktop build; `win32-x64` runs only under Windows x64 emulation if tried.    |

### Cross-platform behavior matrix

| Dimension                   | Linux (`linux-x64`)                                                                                                                   | macOS (`darwin-arm64`)                                                                                                                                                                   | Windows (`win32-x64`)                                                                                                                                                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Minimum OS / toolchain      | glibc ≥ 2.35 (Ubuntu 22.04+, Debian 12+) for bundled runtime & Postgres; older glibc falls back to network install.                   | macOS 14.0+ on Apple silicon. Source fallback checks Xcode CLT (`apple-developer-tools.ts`).                                                                                             | Windows 10/11 x64 (`AMD64`) with standard PowerShell, `tar.exe`, `netstat.exe`, `taskkill.exe`, `whoami.exe`.                                                                                                                                                |
| Bundled runtime layout      | `resources/runtime.tar.zst` unpacked into `<home>/cache/native-runtime/`.                                                             | Unpacked `Contents/Resources/runtime/` and `node/bin/node` so Mach-O signatures cover every binary; quarantine stripped.                                                                 | `resources\runtime.tar.zst` unpacked via zstd + `tar.exe`; `verified.json` size-only recheck avoids Defender thrashing (~11k files).                                                                                                                         |
| Signing / OS gate           | Unsigned tarball.                                                                                                                     | Official releases are signed with the Developer ID and notarized; local and fork builds without those secrets are ad-hoc signed via `rcodesign`. `CuaDriver.app` keeps vendor signature. | Unsigned unless Authenticode `.p12` + `osslsigncode` supplied (SmartScreen warning on unsigned setup).                                                                                                                                                       |
| Privilege handling          | Native PostgreSQL refuses `root` (`uid === 0`).                                                                                       | Native PostgreSQL refuses `root` (`uid === 0`).                                                                                                                                          | Supports both standard users and elevated/built-in Administrator (`windows-restricted-token.ts` starts `postgres.exe` with Administrators/Power Users disabled; private-path checks accept `Administrators` as owner when current user is an administrator). |
| Private state protection    | POSIX owner `uid` + `0700` dirs / `0600` files; `localmodels` kit `0500`.                                                             | POSIX owner `uid` + `0700` dirs / `0600` files; `localmodels` kit `0500`.                                                                                                                | PowerShell DACL (`windows-private.ts`, owner or `Administrators` when admin + `SYSTEM` only; accepts a top-level folder directly on a data drive while refusing nested folders inheriting Modify with `UNSAFE_PARENT_ACCESS`); `localmodels` kit `0400`.     |
| Auto-updater (`updater.ts`) | `download` mode only: verifies Ed25519 manifest, notifies in tray & account menu, opens release URL.                                  | `app-bundle` mode: downloads & verifies `.app.tar.gz`, swaps `.app` in place, relaunches. Developer ID updates keep TCC grants.                                                          | Setup install: `windows-setup` downloads `-setup.exe`, runs `/update /relaunch`. Portable zip: `download` mode only.                                                                                                                                         |
| Quit vs Uninstall           | Close hides to tray; Quit runs `--stop-local-models` while core services keep running. Uninstall is manual `--stop` + folder removal. | Close hides window (Dock/tray reopens); Quit runs `--stop-local-models`. Dragging `.app` to Trash does not automatically run `--stop`.                                                   | Close hides to tray; Quit runs `--stop-local-models`. NSIS replacement & Uninstall run `Linger.exe --quit` then `installer.js --instance desktop --stop` (Retry/Cancel on failure), preserving `%APPDATA%\Linger` and `%USERPROFILE%\.simplexai`.            |
| Window chrome & tray        | Frameless (`frame: false`) with custom `titlebar.html`; tray disabled under `--ozone-platform=headless --disable-gpu`.                | Native traffic lights (`hiddenInset`, `data-desktop-chrome="inset"`), menu bar tray & Dock focus.                                                                                        | `titleBarStyle: "hidden"` + native `titleBarOverlay` and system tray.                                                                                                                                                                                        |
| Floating Voice window       | Always-on-top `floating` window, no parent so it survives main-window hide/minimize, unthrottled opener.                              | Same plus `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })`.                                                                              | Same as Linux (stays open when main window minimizes/hides).                                                                                                                                                                                                 |
| OS permissions & UI control | No `window.lingerDesktop.permissions` API; X11 desktop driver (`local-computer.md`).                                                  | Setup `permissions` step (Full Disk Access, Folders, Automation) + runtime `permissions.v1` (Screen Recording + Accessibility) + `CuaDriver.app`.                                        | No macOS permissions API; bundled `cua-driver` (`local-computer.md`).                                                                                                                                                                                        |
| Process & port supervision  | Reads `/proc/<pid>/{stat,status,environ}` directly (no `procps` needed) with 64-hex `LINGER_NATIVE_PROCESS_LEASE`.                    | `/bin/ps` with `LC_ALL=C` (plus 0.1.2 localized `lstart` adoption) and active connect probe for macOS wildcard shadowing.                                                                | PowerShell `Win32_Process` tree + `netstat.exe -ano -p TCP`, lease in worker filename, `TerminateProcess` + `taskkill /T` fallback.                                                                                                                          |
| Runtime sign-in & CLI       | `usesBrowserOAuth = false` (Codex device-code login); login-shell env probe; bundles `teamhub.sh`.                                    | `usesBrowserOAuth = true` (system browser OAuth); login-shell env probe; bundles `teamhub.sh`.                                                                                           | `usesBrowserOAuth = true` (PowerShell `UseShellExecute`); no login-shell probe; bundles `teamhub.cmd` + WSL-aware `teamhub.sh`.                                                                                                                              |
| Platform filesystem quirks  | Standard POSIX paths.                                                                                                                 | `/tmp` → `/private/tmp` and `/var` → `/private/var` symlinks: use `realpath` under `/private/tmp` for isolated test homes.                                                               | Non-ASCII `%USERPROFILE%` uses UTF-8 manifests under `<digest>-utf8/` for 6 Postgres EXEs; `fs-retry.ts` retries Defender `EPERM`/`EBUSY`.                                                                                                                   |

## Automated checks to reuse first

Run the cross-platform verification helper on the target host OS before starting manual GUI journeys:

```bash
node .agents/skills/verify-linger/scripts/verify-local-client.mjs
```

It runs the deterministic suites for Desktop, Local Installer, Local Installation, BYOK endpoint helpers, and Go Daemon `localmodels` / `model_source`, executes an isolated live Local Installer loopback proof, records host OS/arch and `skipped-os` items honestly, and writes evidence under `test-results/verify-linger/local-client.XXXXXX/`.

Individual repository gates and OS-gated tests (remember Linux PR CI skips the Windows-native tests below — skips on Linux or macOS are not Windows passes):

| Scope                        | Command                                                                                                                                                                                                                                                                                           | Platform notes                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Desktop check + packaging    | `make check-desktop` (`@linger/desktop` typecheck/lint/test, `python3 -m unittest discover -s apps/desktop/packaging -p '*_test.py'`, `node apps/desktop/scripts/build-daemon.mjs --all`)                                                                                                         | Runs on Linux/macOS/Windows; `src/main/teamhub-wsl.test.ts` runs only on Windows with WSL installed.                |
| Local Installer check        | `make check-installer` (`@linger/linger-installer` typecheck/lint/test)                                                                                                                                                                                                                           | Cross-platform; `storage-windows.test.ts` mocks `win32`.                                                            |
| Local Installation engine    | `make check-packages` (covers `@linger/local-installation` and `@linger/service-kit`)                                                                                                                                                                                                             | `native-dependencies.test.ts` glibc test runs on Linux x64 only.                                                    |
| Windows-native ACL & process | `pnpm --filter @linger/local-installation exec vitest run src/windows-private.native.test.ts src/native-process-windows-live.test.ts`                                                                                                                                                             | **Windows x64 only** (skipped on Linux/macOS). Proves real PowerShell DACLs, junctions, `netstat`.                  |
| Packaging & release scripts  | `pnpm exec vitest run scripts/ci/desktop-release.test.ts scripts/prepare-source-archive.test.ts scripts/prepare-source-dependencies.test.ts scripts/prepare-native-postgres.test.ts scripts/prepare-native-voice-tools.test.ts scripts/source-native.test.ts scripts/ci/windows-pi-smoke.test.ts` | Deterministic packaging, manifest, and release-script contracts.                                                    |
| Packaged Windows CI Pi smoke | `scripts/ci/windows-desktop-smoke.ps1` (invokes `scripts/ci/windows-pi-smoke.mjs` on a clean non-admin Windows x64 user)                                                                                                                                                                          | Proves silent NSIS `/S` install + packaged Pi RPC + `mcp` command; does not prove GUI, model weights, or uninstall. |

## Isolation rules for live Desktop and Installer runs

Never run live verification against a developer's real `~/.simplexai`, `<appData>/Linger`, or running Linger instance:

- Set `LINGER_DESKTOP_USER_DATA` to a fresh empty directory.
- Set `LINGER_HOME` to a separate fresh empty directory.
- Set `LINGER_BRIDGE_STATE_DIR` to a fresh empty directory so legacy bridge checks stay isolated.
- On macOS, allocate isolated directories under `/private/tmp/...` (resolved with `realpath`), never `/tmp/...`, because `localmodels` rejects symlinked runtime roots.
- On Linux without a physical display, use `xvfb-run -a` for tray/window checks, or `--ozone-platform=headless --disable-gpu` for headless checks (noting tray is intentionally disabled in headless mode).
- On Windows, run under a dedicated standard (non-Administrator) user account with default Defender enabled.
- Inspect Electron renderer or setup views via `--remote-debugging-port=<free-port>` if driving with Playwright/CDP, without injecting sessions or bypassing forms.

## Desktop Client journeys

### Quick Install ("Run on This Computer") and starter workspace

**Setup:** Packaged Desktop build for the host target (`darwin-arm64`, `linux-x64`, or `win32-x64`) with isolated `LINGER_DESKTOP_USER_DATA`, `LINGER_HOME`, and `LINGER_BRIDGE_STATE_DIR`, non-root / non-admin user, and free disk space on the chosen install location.

**Journey:**

1. Launch the packaged app (`Linger.app`, `./linger`, or installed `Linger.exe`). On macOS, the notarized app opens without a Gatekeeper warning. On Windows, record SmartScreen separately.
2. On **Welcome**, open **Customize**, verify the install location picker and free-space check, select a model source (Local model, Subscription, or BYOK — see [Local Models and BYOK](local-models-and-byok.md)), and run **Quick Install**.
3. Observe installation stage progression (`prepare` → `download` → `services`/`workspace` → optional `signin` → `connect` → `agents`).
4. On **Ready**, confirm the generated owner email appears, verify password **Show** / **Copy** (and that the clipboard clears after 60 seconds if untouched), click **Open account file location** to confirm `local-account.json` is owner-private, and click **Open Linger**.
5. Confirm the main window opens signed in, `Another Me` (`Linger`) and `Getting Started` exist, and this machine's Computer shows **Online** in both the tray menu and Settings → Computers.
6. Sign out and verify "Sign in with this computer's account" (`POST /v0/local/identity` HMAC check) signs back in without re-running setup.

**Pass:** All 5 native services (`postgres`, `livekit`, `teamhub`, `node-services`, `web`) and the bundled Computer Daemon reach healthy/online state; `desktop/local-server.json` is written; owner credentials stay private on disk; no root/elevated process is used.

**Evidence:** Screenshots of Welcome/Customize, Installing progress, Ready (with password masked), and signed-in Room with Online Computer; redacted `local-server.json` summary; `daemon status --json`; file permission/ACL listing for `local-account.json` and `credential.json` (never print secrets).

### Connect to Server and PKCE enrollment

**Setup:** Clean isolated `LINGER_DESKTOP_USER_DATA` and a reachable TeamHub + Web origin with a disposable account.

**Journey:** Choose **Connect to Server**, enter the server URL, sign in through the actual login form, complete PKCE enrollment (`connect` step), and finish `permissions` (macOS) or setup completion (Linux/Windows). When testing Connector OAuth in Desktop, trigger a provider link and confirm the browser callback returns to `127.0.0.1:<ephemeral>/oauth/connector/<hex>` and brings the Desktop window back to the front.

**Pass:** `computer/credential.json` and `computer/config.json` are written with owner-only permissions/DACL; the Computer appears Online on the target server; no local PostgreSQL or TeamHub processes are spawned.

### Window chrome, close-to-tray, Quit, Resume and Set Up Again

**Journey:**

1. Confirm OS-specific window chrome: macOS native traffic lights (`data-desktop-chrome="inset"`), Windows `titleBarOverlay`, Linux custom `titlebar.html` controls.
2. Close the main window: verify the app remains alive in the tray (or Dock on macOS) and relaunching the executable focuses the single existing instance instead of starting a second one.
3. Click **Quit** from tray/menu: verify the app exits and detached `installer.js --stop-local-models` runs while core collaboration services stay running (see [Local Models and BYOK](local-models-and-byok.md#quit-reopen-resume-and-uninstall-teardown)).
4. Relaunch Desktop: verify `--resume` reconnects to the existing instance without re-entering setup. For sleep and wake, force quit and quitting mid-Run or mid-download, run [Sleep, wake and quit](local-models-and-byok.md#sleep-wake-and-quit).
5. Simulate an unavailable local server so `offline.html?failed=...` appears; test **Try Again**, **Show Logs**, **Save Diagnostics**, and **Set Up Again**. Confirm **Set Up Again** returns to Welcome while preserving instance data and `savedEnrollments` (and renews the holding Computer without leaving an orphan — see [Login and account switching](local-computer.md#login-and-account-switching)).

### Auto-updater and in-place upgrade

**Setup:** An installed older Desktop version plus a staged HTTPS release directory (pointed to via `updateFeedUrl` in `config.json`) serving an Ed25519-signed `manifest.json` + `manifest.json.sig` (schema 2) and target asset.

**Journey:**

1. Verify a tampered manifest signature or mismatched asset SHA-256 is rejected without altering the installed app.
2. Serve a valid newer version and verify platform behavior:
   - **macOS (`app-bundle`):** `.app.tar.gz` downloads and verifies, **Restart to Update** waits for active work, swaps `Linger.app`, relaunches into `Updating Linger` source migration, and preserves Rooms and enrollment.
   - **Windows Setup (`windows-setup`):** `-setup.exe` downloads and verifies, **Restart to Update** runs `/update /relaunch` (passive progress page, no admin UAC), stops services, replaces `%LOCALAPPDATA%\Programs\Linger`, and relaunches. Test Cancel/locked-file recovery separately on a disposable host.
   - **Linux & Windows Portable (`download`):** tray and account menu show **Download Linger `<version>`…** / **Download Update** and open the release page without attempting in-place swap.

**Pass:** Version advances, `Updating Linger` switches the local server to the newer source package (downgrades remain blocked), and persisted Rooms/Documents remain readable after restart.

This journey proves the updater mechanics. The [upgrade from the previous release](#upgrade-from-the-previous-release) below proves that a real install survives the upgrade.

### Upgrade from the previous release

**Required for every release and release candidate** on each shipped target (`darwin-arm64`, `linux-x64`, `win32-x64`). A fresh-install pass does not substitute for it, and a target that was not upgraded is reported as blocked, not passed.

**Why it matters:** existing users reach a new version only by upgrading an install that already holds state: native services and supervisors started by the old app, its source folder, a saved local-model plan and gateway, Pi and Runtime settings, and OS permission grants. A fresh install has none of that state, so fresh-install checks passed while each of these upgrades broke:

- #174 (Linux, 0.1.3 RC1/RC2): service supervisors kept running from the old app folder after an upgrade or re-extract.
- #175, #210 (0.1.3 RCs): the new app ran on the old services; when moving them failed, Try Again pruned the folder they ran from and Linger stopped serving on every relaunch.
- #179 (macOS, non-English locale): services started by 0.1.2 failed 0.1.3's process identity check.
- #320 (0.1.4 → 0.1.5): stopped local models could not be replanned by the newer `localmodels` kit (`STACK_REPLAN_FAILED`).
- #344 (0.1.3 → 0.1.4 auto-update, macOS): Screen Recording stayed on in System Settings but was refused, so computer use failed.
- #512 (0.1.5 → 0.1.6, macOS): resume refused to stop a local-model service the earlier release had started and left the old TeamHub and node-services running, so the Computer could not connect.
- #579, #605 (WHI-973, Windows): after an upgrade and Quit → Reopen, local models were split between the legacy Magpie gateway and Bifrost, `magpie.exe serve` was not restarted, Pi's `settings.json` still pointed at Magpie, and the default Agent failed with `ECONNREFUSED`.
- #590: a cold `--stop` → `--resume` did not reload an adopted local model, so Pi had no model.
- #603 (macOS): a PostgreSQL left running by the earlier release no longer matched the repinned archive, and setup stopped at the services step.

**Setup:**

- The previous published stable release (`gh release list --repo simplexai-labs/linger`; Releases → Latest) and the candidate, both digest-checked against their `SHA256SUMS.txt`.
- A host or VM per target that never ran the candidate, as the user the product supports (non-root; Windows standard user). Upgrade needs the default data locations, so use a disposable machine or account instead of isolated `LINGER_DESKTOP_USER_DATA`/`LINGER_HOME` overrides, and never a developer's real install.
- On a machine a person also uses, never change per-user shared state for an install or upgrade test: the `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Linger` key, `%USERPROFILE%\.local\share\localmodels` and `~/.local/share/localmodels`, or `~/.pi`. Run those tests under a separate OS user or in a VM instead. The Windows NSIS `-setup.exe`, including one the person runs by hand, installs into the folder the Uninstall key names, so pointing that key at a test install sends the person's own upgrade there and stops their services. Releases up to 0.1.6 write the shared `localmodels` directories whatever `LINGER_HOME` says, and place models on GPUs regardless of `CUDA_VISIBLE_DEVICES`.
- For the in-app update to a candidate, which is a prerelease and so never reaches the default feed: an owned HTTPS host with a trusted certificate serving the candidate's own signed `manifest.json` and `manifest.json.sig` at `<feed>/latest/download/` and its package at `<feed>/download/desktop-v<version>/`, named by `updateFeedUrl` in the old app's `config.json`.

**Journey:**

1. Install the previous release the way users do and run **Quick Install** with **Local model** where the hardware supports it (otherwise BYOK; record which). Sign in, confirm the default gateway serves the model (Bifrost on every platform for new installs; on Windows also repeat with an install that an earlier release set up on Magpie, when one is available), send a unique marker to Another Me and to one other Agent, and get replies. Create a Document and change a few settings (Room model, a Computer setting, a saved BYOK key when used).
2. Record the baseline: app version, `local-server.json` source folder, service and model PIDs with their executable paths, gateway process and port, `GET .../local-models` and `GET .../model-source` JSON, and Pi's default model.
3. Upgrade with services and the local model still running, by each path users take:
   - **macOS:** in-app **Restart to Update** (`app-bundle`), and separately drag the new `Linger.app` from the `.dmg` over the old one.
   - **Windows:** in-app **Restart to Update** (`/update /relaunch`), and separately run the new `-setup.exe` over the running install.
   - **Linux:** extract the new `.tar.gz` over the old folder and, separately, into a new folder, then launch it.
4. On the first launch, confirm `Updating Linger` moves the services to the new source without Set Up Again, then use the app.
5. **Quit → Reopen** from the tray or menu, then a **cold restart**: reboot, or `installer.js --instance desktop --stop` followed by a relaunch.
6. Repeat steps 1–5 from a release two or more versions older (a skipped version) when that release still supports the same update path.

**Pass after each upgrade, Quit → Reopen and cold restart:**

- The app starts without the setup wizard or the start failure page; the account menu and `local-server.json` show the candidate version and its source folder; no process runs from the old app or source folder.
- Account, Rooms, messages, the Document, Agents, Computer enrollment and the changed settings are kept; the Computer is **Online** without pairing again.
- The local model is `loaded` and answering through its gateway. A fresh Windows install serves it only through Bifrost (`bifrost-http.exe`), with no `magpie.exe` and no `magpie/...` Pi default. A Windows install that 0.1.7 set up on Magpie may stay on Magpie after the upgrade (a known issue until such installs move to Bifrost), but it must start and its Agents must reply. A BYOK source is remounted without entering the key again.
- Another Me and the other Agent each deliver a reply to a new marker, with no `ECONNREFUSED` and no Runtime `Update needed`.
- On macOS, computer use still works without granting permissions again.

**Evidence:** for each target and upgrade path, the from and to versions and digests, the baseline and after records from step 2, `daemon status --json`, the process list with executable paths, persisted message and Run IDs of the replies, a **Save Diagnostics** archive, and screenshots of `Updating Linger`, the account menu version and Settings › Models. Record a failure on the first launch even when Try Again or a reboot later recovers it.

**Automation:** `verify-local-client.mjs` and the unit suites cover the resume logic but install no previous release. `scripts/acceptance/room-journey.mjs` checks the Agent reply after each step. `scripts/smoke-local-runner.sh` covers only an in-place Computer bundle upgrade, not Desktop. The Desktop release-to-release upgrade itself has no automation yet.

### Floating Voice Mode and Recording window

**Setup:** Signed-in Desktop connected to a server with Voice enabled (LiveKit running and provider key configured).

**Journey:** Start Voice Mode or Recording and open its floating window (`window.open("", "linger-voice-window-<n>")`). Minimize or hide the main Desktop window to tray; confirm the floating window stays visible and always-on-top while active audio stays unthrottled. On **macOS**, switch Spaces and enter a fullscreen app to confirm `setVisibleOnAllWorkspaces` keeps the window visible. Use the return-to-main control (`showMainWindow`), then close or navigate the main window and verify the floating window closes without orphaning.

### OS permissions and desktop control

- **macOS (`darwin-arm64`):** Exercise the Setup `permissions` step (Full Disk Access, Folders, Automation) and verify live status refresh after granting in System Settings. Trigger a desktop action needing Screen Recording or Accessibility and verify runtime `permissions.v1` opens the correct System Settings pane and advises relaunching Linger after granting Screen Recording. On signed/notarized builds, run `spctl --assess --type execute --verbose /Applications/Linger.app` and confirm `CuaDriver.app` retains its vendor signature.
- **Linux (`linux-x64`) and Windows (`win32-x64`):** Confirm `window.lingerDesktop.permissions` is not exposed and no macOS permission dialog appears. Verify desktop control uses the X11 driver (Linux) or bundled `cua-driver` (Windows) per [Desktop and browser tools](local-computer.md#desktop-and-browser-tools).

### Redacted diagnostics and hosted upload

**Journey:**

1. Trigger **Save Diagnostics** from the tray or offline screen and unpack `linger-diagnostics-<stamp>.zip`.
2. Inspect every file inside the archive: confirm absence of `*.env`, `*.input.json`, `local-account.json`, `credential.json`, `gateway.json`, `caller.key`, `control.key`, `launch.html`, `postgres-password`, `auth.json`, and database/key files; confirm home paths are redacted to `~` and secret tokens do not appear.
3. With `diagnosticsUploadUrl` unset, confirm **Send Diagnostics** is hidden. With `diagnosticsUploadUrl` set in `config.json` to an owned HTTPS stub implementing `linger.diagnostics-upload/v1`, confirm **Send Diagnostics** displays the explicit file-list consent prompt before uploading and succeeds only after confirmation.

### Physical Windows installation, Room proof and graphical uninstall

Follow [Physical Windows acceptance](../../../../docs/desktop-release.md#physical-windows-acceptance) on a clean standard-user Windows 10/11 x64 desktop with default Defender:

1. Verify `Linger-<v>-windows-x64-setup.exe` SHA-256 and complete interactive Setup + Quick Install (also test `/S` silent install separately). Verify elevated / built-in Administrator installation starts `postgres.exe` via restricted token (`windows-restricted-token.ts`) and that a top-level folder directly on a data drive (e.g. `D:\Linger`) is accepted while a nested folder inheriting Modify surfaces `UNSAFE_PARENT_ACCESS` guidance.
2. Run one unique Room journey with `node scripts/acceptance/room-journey.mjs` (and verify file bytes + Agent logs with `node scripts/local-runner-message-evidence.mjs --run-evidence`). Quit and reopen Desktop; confirm Room reply and file persist.
3. Run the graphical uninstaller from **Add or remove programs** while Desktop and local services are running. Confirm `Linger.exe --quit` and `installer.js --instance desktop --stop` stop all 5 services, local models, and the Daemon, remove `%LOCALAPPDATA%\Programs\Linger` payloads/shortcuts/startup registrations, and preserve `%APPDATA%\Linger` and `%USERPROFILE%\.simplexai`.
4. Confirm zero lingering `postgres`, `livekit`, `teamhub`, `node-services`, `web`, or `linger-computer-daemon` processes or listeners remain. Exit code `0` alone is not cleanup proof; record before/after payload, process, listener, and retained-data checksums. Label Windows ARM emulation evidence separately from native Windows x64.

## Standalone Local Installer and Native Engine journeys

### Loopback manager, CSRF/session security and wizard install

**Setup:** Build `@linger/linger-installer` (`pnpm --filter @linger/linger-installer build`) and start with an isolated home and ephemeral port:

```bash
node apps/linger-installer/dist/installer.js \
  --home "$TMP_HOME" --source-repo "$PWD" --instance verify-local --no-open --port 0
```

**Journey:**

1. Confirm `<TMP_HOME>/installer` is owner-private (`0700` POSIX / user+SYSTEM ACL Windows) and `manager.sqlite` holds the single-manager exclusive lock (a second launch reports `INSTALLER_BUSY` instead of corrupting state).
2. Confirm `POST /api/session` without a matching `Origin` header is rejected with HTTP `403 FORBIDDEN`.
3. Exchange the one-time token from `launch.html` with matching `Origin`: expect HTTP `200` and `Set-Cookie: linger_installer_session=...; Path=/api; HttpOnly; SameSite=Strict`. Replay the same token and expect HTTP `401 UNAUTHORIZED`.
4. Open the wizard UI in a browser: confirm `"local-models"` is intentionally omitted in the standalone React wizard (`SetupChoicePanel.tsx`), while Codex, Claude Code, Pi, and BYOK are available. Exercise BYOK validation (including `POST /api/byok/check` refusing metadata SSRF URLs like `http://169.254.169.254/latest` with `400 BYOK_INVALID_CONFIG`).
5. Start an installation job: verify `/api/jobs/:id/events` streams monotonic progress, closing the browser tab does not abort the running job, reopening attaches to live progress, and completion exposes generated credentials with all 5 native services healthy.

### Headless CLI lifecycle and port conflict recovery

**Journey:**

1. Run `--user-keys` to update `COMPOSIO_API_KEY`; test an unrecognized key in `user.env` and confirm it logs a warning and is ignored.
2. Run `--stop`: confirm all 5 services stop cleanly, `<TMP_HOME>/installer/stop-latest.json` reports `{"failed":[]}` (no `stop-first-failure.json`), and zero owned PIDs remain.
3. Occupy one of the instance's saved non-origin ports (for example TeamHub or PostgreSQL) with a disposable loopback listener, then run `--resume`: confirm dual-stack conflict detection (`127.0.0.1` and `::1`), automatic port relocation in `native.env`, and clean restart without breaking account data.
4. Run `--stop-local-models` and confirm local models/Bifrost stop while collaboration services stay running.

### OS-specific engine proofs

- **Windows x64:** Run the installer under a **non-ASCII `%USERPROFILE%` / `--home` path** and confirm UTF-8 manifests are staged under `<digest>-utf8/` for the 6 PostgreSQL executables so `initdb` and `postgres` succeed. Run `windows-private.native.test.ts` and `native-process-windows-live.test.ts`, inspect `icacls` on `services.env` (owner + `SYSTEM` only), and verify WSL `teamhub.sh` (`teamhub-wsl.test.ts`) when WSL is present.
- **Linux x64:** Verify root (`uid === 0`) PostgreSQL refusal, `/proc`-only process identity without `procps`, and glibc < 2.35 fallback to network installation when testing older distros.
- **macOS arm64:** Verify wildcard-shadowing port conflict detection (`*:port`), `LC_ALL=C` `/bin/ps` parsing under a non-English locale (`LANG=de_DE.UTF-8`), and `/private/tmp` realpath handling.

### Legacy Simplex migration and pre-goose-852 DB set-aside

**Journey:**

1. Seed an isolated `--home` with a legacy `simplex-*` native `instance.json` (`SIMPLEX_*` keys in `services.env`, `livekit.env`, `native.env`) plus a legacy Docker-mode record (`mode: "release"`), then run `installer.js --home "$TMP_HOME" --migrate`. Confirm the native record migrates to `linger-<name>-<hash>` with `LINGER_*` keys while the Docker-mode record is refused and left untouched.
2. Seed a native instance whose PostgreSQL database has `public.accounts` without goose baseline `852`, then run `--resume`. Confirm PostgreSQL stops, `data/agent`, `data/artifacts`, `computer-enrollment.token`, and `native/postgres-data` are moved aside into `simplex-backup-<UTC>`, `local-account.json` is marked unprovisioned, and a fresh database initializes cleanly.

**Cleanup (all OSes):** Run `installer.js --home "$TMP_HOME" --instance <name> --stop`, quit any launched Desktop instance, verify zero lingering listeners or owned PIDs, and remove only the isolated temp directories. Keep evidence under `test-results/verify-linger/` intact.

## Sources

- [Desktop packaging and build](../../../../apps/desktop/build.mjs)
- [Desktop distribution pins](../../../../apps/desktop/distribution/)
- [Desktop packaging scripts and tests](../../../../apps/desktop/packaging/)
- [Desktop release workflow](../../../../.github/workflows/desktop-release.yml)
- [Windows CI Pi smoke](../../../../scripts/ci/windows-desktop-smoke.ps1)
- [Local Installer entry point](../../../../apps/linger-installer/src/main.ts)
- [Local Installation engine](../../../../packages/local-installation/src/)
