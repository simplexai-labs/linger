---
name: verify
description: Launch, diagnose, drive, capture proof for, and tear down isolated Linger instances across its Web product UI (Web, TeamHub, Document Runtime, disposable PostgreSQL via Playwright) and its Local Client stack (Desktop client, Local Installer loopback UI/API, Local Models, and BYOK). Reach for this skill after behavior changes, to reproduce a bug against real services, or before claiming a UI/installer/model change works.
---

# Verify Linger

Read [the feature map](features/README.md) first, then open the matching feature file before driving the app. Every command below runs from the repository root and targets isolated, checkout-built instances — never the developer's `pnpm dev` stack, shared database, or `~/.linger` user home.

This skill wraps the repository's canonical runners in [.agents/skills/verify-linger/SKILL.md](../../../.agents/skills/verify-linger/SKILL.md) (sharing its isolation rules, cross-platform Node scripts, Playwright config, and `test-results/verify-linger/` evidence layout) while adding pinned toolchain activation, `--journey` dispatch, `--preflight`/`--local-client` doctor checks, `cleanup.sh`, and 4-section user-POV feature maps.

Linger's primary surfaces driven here are:

1. **Web product UI** (`apps/web` backed by real `apps/teamhub`, `apps/node-services` Document Runtime, and disposable PostgreSQL via Playwright).
2. **Local Client stack** (`apps/linger-installer` loopback manager + React setup SPA, `apps/desktop` Electron shell, and Local Models / BYOK rules and daemon suites across Linux, macOS, and Windows).

For extended recipes covering Connector CLI with Computer Use, remote deployments, live Agent execution and output judging rules, and OS-packaged Desktop release upgrades, read [.agents/skills/verify-linger/SKILL.md](../../../.agents/skills/verify-linger/SKILL.md) and its [feature catalog](../../../.agents/skills/verify-linger/features/README.md).

## Launch

### Prerequisites

Install this worktree's locked Node dependencies and Playwright Chromium once (using Node `>=26.5.0 <27` from `.node-version` and `pnpm@11.7.0` from `package.json`; the shell wrappers auto-resolve pinned `mise` installations when present):

```bash
source .claude/skills/verify/scripts/toolchain.sh && verify_activate_toolchain
pnpm install --frozen-lockfile --prefer-offline
pnpm exec playwright install chromium
```

Confirm the host is ready before starting a run:

```bash
.claude/skills/verify/scripts/doctor.sh --preflight
```

### Surface 1: Isolated Web product stack

```bash
.claude/skills/verify/scripts/verify-web.sh --journey document
```

- **What it starts:** delegates to `.agents/skills/verify-linger/scripts/verify.sh` and `.agents/skills/verify-linger/playwright.config.ts`, which build production Web assets (`apps/web/dist`), serve them behind `apps/web/e2e/room-startup-production-server.mjs`, start a per-run disposable PostgreSQL container (`apps/teamhub/scripts/with-test-database.sh` with `TEAMHUB_TEST_DATABASE=isolated` and `PLAYWRIGHT_ROOM_DOCUMENT_POSTGRES_PORT=0`), run migrations and demo seeding from an empty database, and start real TeamHub plus the Node Services Document Runtime.
- **Seeded disposable account:** `alice@example.com` / `teamhub-dev-alice` (prepared by the harness control endpoint; no root `.env` or personal credentials needed).
- **Default loopback ports:** Web `23008`, TeamHub `28089`, Control `28088`, Document Runtime `24328`, dynamic PostgreSQL port, plus Composio adapter `28087` when `--journey connectors` is selected.
- **Ready condition:** Playwright waits for Web `/healthz` and Control `/healthz` after migrations, demo seeding, and Document Runtime startup finish; `document` and `connectors` specs also run `doctor.sh` (requiring `/healthz` on Web/TeamHub/Control and `/readyz` on Document Runtime) and real `/login` authentication before asserting behavior.
- **Isolation:** one run per checkout is enforced with `.cache/verify-linger.lock` because `apps/web/dist` is shared per worktree. Parallel Web runs require separate worktrees and distinct `PLAYWRIGHT_ROOM_DOCUMENT_{WEB,TEAMHUB,CONTROL,RUNTIME}_PORT` values. Occupied ports, `TEST_DATABASE_URL`, `PLAYWRIGHT_SKIP_WEB_SERVER=1`, and prebuilt `ROOM_DOCUMENT_E2E_*_BINARY` overrides are rejected.
- **Teardown:** Playwright sends graceful `SIGTERM` to the managed servers, `with-test-database.sh` removes its label-verified `teamhub-test-*` container/network/volume, and `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>` confirms nothing was left behind.

### Surface 2: Isolated Local Installer, Desktop, Local Models, and BYOK

```bash
# Fast isolated live Local Installer API + Chromium SPA proof only (POSIX):
.claude/skills/verify/scripts/verify-local-client.sh --smoke-only

# Full host-applicable Desktop, Installer, Local Models, and BYOK suites + live proof:
.claude/skills/verify/scripts/verify-local-client.sh

# Cross-platform direct entry (required on Windows, also works on macOS/Linux):
node .agents/skills/verify-linger/scripts/verify-local-client.mjs [--smoke-only] [--with-setup-inspect]
```

- **What it starts:** delegates to `.agents/skills/verify-linger/scripts/verify-local-client.mjs`, which builds `@linger/linger-installer` (`apps/linger-installer/dist/installer.js`) and spawns it against a fresh private `mkdtemp` `--home` directory with `--source-repo <repo> --instance verify-local-client --no-open --port 0` (ephemeral loopback port).
- **Ready condition:** `<temp-home>/installer/launch.html` exists with POSIX `0700`/`0600` permissions (Windows DACLs covered by `windows-private.native.test.ts`), and `doctor.sh --local-client --home <temp-home>` confirms a live loopback listener and HTTP `401` on unauthenticated `GET /api/environment`.
- **Isolation:** each run creates its own temp `--home` and ephemeral port (`--port 0`), so runs execute safely beside any installed Desktop app or `~/.linger` directory. `doctor.sh --local-client` refuses `$HOME` and `$HOME/.linger`.
- **Teardown:** sends `SIGTERM` to the recorded installer PID, runs `installer.js --home <temp-home> --instance verify-local-client --stop`, removes only the temp `--home`, and leaves all proof artifacts intact.

## Doctor

Run this read-only diagnostic check first whenever behavior looks wrong, before launching (`--preflight`), or while an instance is live:

```bash
# Before launching: verify Node/pnpm/Go, node_modules, Chromium, Docker, and free default ports
.claude/skills/verify/scripts/doctor.sh --preflight

# While an isolated Web stack is up: delegates to verify-linger doctor.sh (Web/TeamHub/Control /healthz, Runtime /readyz, listeners)
.claude/skills/verify/scripts/doctor.sh --web
.claude/skills/verify/scripts/doctor.sh --web --with-connectors

# For Local Installer / Desktop: verify toolchain, bundle, private 700/600 modes, listener PID, and 401 auth guard
.claude/skills/verify/scripts/doctor.sh --local-client
.claude/skills/verify/scripts/doctor.sh --local-client --home /tmp/linger-verify-installer.XXXXXX
```

`doctor.sh` never mutates state, never writes to the database, and never consumes the installer's one-time bootstrap token. Compare its printed listener PIDs and checkout `HEAD` against the active run's `source.txt` and `run.log` before trusting a result.

## Drive

Drive mapped journeys through the real UI and public APIs using accessible roles, labels, and route paths (never internal React setters, injected cookies, or test-only mutation shortcuts):

### Web product UI journeys (Playwright on the isolated stack)

| Journey              | Command                                                                                          | Spec driven                                     |
| -------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- |
| Documents (baseline) | `.claude/skills/verify/scripts/verify-web.sh --journey document`                                 | `.agents/skills/verify-linger/document.spec.ts` |
| Auth and session     | `.claude/skills/verify/scripts/verify-web.sh --journey login`                                    | `apps/web/e2e/room-login-chain.spec.ts`         |
| Rooms lifecycle      | `.claude/skills/verify/scripts/verify-web.sh --journey rooms`                                    | `apps/web/e2e/room-creation.spec.ts`            |
| Scheduled routines   | `.claude/skills/verify/scripts/verify-web.sh --journey routines`                                 | `apps/web/e2e/room-routines.spec.ts`            |
| Connected apps       | `.claude/skills/verify/scripts/verify-web.sh --journey connectors`                               | `.agents/skills/verify-linger/apps.spec.ts`     |
| Room startup         | `.claude/skills/verify/scripts/verify-web.sh --journey startup`                                  | `apps/web/e2e/room-startup.spec.ts`             |
| Specific E2E spec    | `.claude/skills/verify/scripts/verify-web.sh --spec apps/web/e2e/room-document-comments.spec.ts` | Selected spec                                   |

Pass Playwright options directly (for example `--headed`, `--debug`, or `-g "<test title>"`) for interactive inspection against the same isolated stack:

```bash
.claude/skills/verify/scripts/verify-web.sh --journey document -- --debug
```

Key stable Web handles (see each feature file for complete sequences):

- **Sign in (`/login`):** label `Email`, exact label `Password`, button `Sign in`; account logout via button `Account menu` -> menuitem `Log out`.
- **Rooms (`/t/:tenantId/rooms/:roomId/chat`):** navigation `Room navigation` -> button `Create chat` -> menuitem `Create Room` -> dialog `Create Room` (`Room name`) -> dialog `Add Room members`; composer textbox `Message Room`; button `/settings from avatar$/` -> `panel-room-settings` (`Leave Room`, `Share conversation`, `Delete Room`).
- **Documents (`/t/:tenantId/documents/:documentId` or Room sidebar `Documents`):** label `Room Document editor`, button `Document mode` -> menuitem `/\bEdit$/`, `.bn-editor`, `[data-room-document-save-status="Saved"]`, button `Comments`.
- **Connected Apps (`/t/:tenantId/apps`):** tablist `Connector categories`, button `Connected only`, button `Connect Linear`, dialog `Linear`, dialog `Disconnect account?`.
- **Routines (`?profile=actor_acme_official`):** `panel-tab-agent-info` -> tab `Routines` -> region `Routines` -> button `New routine` -> dialog `New routine` (`Instruction`, combobox `When`, textboxes `Hour`/`Minute`, button `Create`).
- **Models settings (`/t/:tenantId/settings/models`):** heading `Models`, `Model source` (`Local model` / `BYOK`), `Recheck memory`, per-model `Download` / `Load` / `Unload` / `Remove`.

### Local Installer, Desktop, and BYOK (Loopback + Chromium)

```bash
# Offline-safe loopback auth/API/BYOK-SSRF + Chromium SPA guard proof:
.claude/skills/verify/scripts/verify-local-client.sh --smoke-only

# With live localmodels setup inspection + authenticated Choose your harness / BYOK UI (uses network):
.claude/skills/verify/scripts/verify-local-client.sh --smoke-only --with-setup-inspect
```

Drives the real built installer binary and its served React SPA via `.agents/skills/verify-linger/scripts/verify-local-client.mjs`:

- **Default (`--smoke-only`, zero external network):** verifies `0700`/`0600` private modes on POSIX (Windows DACLs via native tests), missing-`Origin` `POST /api/session` (`403`), Chromium rendering of `<origin>/` when Playwright Chromium is installed (`Open the installer again.` alert, zero `pageerror`s, screenshot + ARIA snapshot), valid one-time token exchange (`200`, `HttpOnly; SameSite=Strict` cookie, automatic deletion of `launch.html`), token replay refusal (`401`), authenticated `/api/environment`, `/api/config`, `/api/instances`, `/api/jobs` (`200`), BYOK SSRF refusal on `http://169.254.169.254/latest` (`400 BYOK_INVALID_CONFIG`), and clean `--stop` (`exit 0`).
- **With `--with-setup-inspect`:** opens the bootstrap URL in Chromium, waits for real `GET /api/setup` (`localmodels` kit download + hardware inspection) to render heading `Choose your harness`, selects radio `BYOK` inside radiogroup `Installation plan`, fills textbox `Base URL` (`http://169.254.169.254/latest`) and combobox `Model` (`stub-model`), clicks button `Test`, and confirms both HTTP `400 BYOK_INVALID_CONFIG` and visible status toast `Couldn't connect`.
- **Desktop GUI & sleep/quit:** for packaged Electron GUI, upgrade-from-previous-release, and sleep/wake/quit verification on target macOS/Linux/Windows hosts, follow [Desktop, Local Installer, Local Models, and BYOK](features/desktop-installer-and-models.md) and `.agents/skills/verify-linger/scripts/verify-sleep-quit.mjs`.

## Evidence

All runs write to one canonical gitignored directory tree under `test-results/verify-linger/` (created with mode `0700`):

- Web proofs: `test-results/verify-linger/run.<XXXXXX>/`
- Local client proofs: `test-results/verify-linger/local-client.<XXXXXX>/`

Standard retained files per run:

- `source.txt`: git `HEAD`, dirty status, Node/pnpm/Go versions, selected mode/spec, and exact ports.
- `source.patch` and `changed-files.sha256`: exact diff and SHA-256 fingerprints of uncommitted/untracked files tested.
- `run.log` and `exit-code.txt`: complete command output and process exit status.
- `browser/`: `doctor.txt` (for `document`/`connectors`), action/result screenshots, ARIA snapshots (`*.aria.yml`), Playwright traces (`trace.zip`), videos (`video.webm`), and per-spec `proof.json`.
- `report/index.html` (Web runs) or top-level `proof.json` (Local Client runs): structured outcome, assertions, `skippedOs`, and explicit mock/environment limitations.

Proof standards:

- Exercise the real user path (forms, dialogs, buttons, routes, real services). Never prove a feature via internal state setters, fixture shortcuts, or test-only endpoints.
- Capture both the user action and the resulting state, not only a final screen.
- For mutations (Room creation/deletion, Document edits, Routine edits, Connected App authorization), verify persistence from a second read in a fresh browser context and inspect backend side effects (`persisted_seq`, `/v0/*` API reads, or event logs).
- Mocks are allowed only at an existing production adapter boundary (for example the disposable Composio HTTP server in `--journey connectors` or link-local SSRF refusal in BYOK) and must be named in `proof.json`.
- Whenever a run uses a smoke or dry-run mode (such as `--smoke-only`), inspect what it actually exercised and what remained skipped (Electron GUI, GPU weight downloads, external BYOK providers) rather than claiming full coverage.
- Keep evidence local and private: Playwright traces and logs can contain disposable login cookies. Never print one-time installer tokens or personal API keys into logs or reports.

## Cleanup

Run the cleanup verifier after EVERY run — including failed or interrupted attempts:

```bash
.claude/skills/verify/scripts/cleanup.sh test-results/verify-linger/<run-dir>
```

What `cleanup.sh` enforces:

- Terminates only exact PIDs recorded in `<evidence-dir>/pids.txt` — never kills by process name (`pkill`/`killall`).
- Removes only scratch temp homes listed in `<evidence-dir>/temp-homes.txt` under `${TMPDIR:-/tmp}/linger-verify-*`.
- Inspects `run.log` for any `teamhub-test-*` Compose project name; if a container or network survived an interrupted run, validates `com.linger.teamhub.test-managed=true` and `com.linger.teamhub.test-run-token=<project>` labels before calling `docker compose down --volumes`, then verifies zero containers, networks, and volumes remain for that project.
- Verifies every recorded port has zero remaining TCP listeners (`ss` or `lsof`).
- Confirms `<evidence-dir>` and its proof files (`source.txt`, `run.log`, `exit-code.txt`, and `proof.json` or `browser/*/trace.zip`) still exist after teardown. Cleanup never deletes evidence.

## Helpers

All helpers live in `.claude/skills/verify/scripts/` and are executable (wrapping `.agents/skills/verify-linger/scripts/` as the single underlying implementation):

| Helper                   | Invocation                                                                                                            | Purpose                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolchain.sh`           | `source .claude/skills/verify/scripts/toolchain.sh && verify_activate_toolchain`                                      | Activates pinned Node (`.node-version`) and pnpm (`package.json`) and provides port inspection helpers                                            |
| `doctor.sh`              | `.claude/skills/verify/scripts/doctor.sh [--preflight \| --web [--with-connectors] \| --local-client [--home <dir>]]` | Read-only preflight, live health/readiness (delegating `--web` to `verify-linger/scripts/doctor.sh`), listener PID, and installer isolation check |
| `verify-web.sh`          | `.claude/skills/verify/scripts/verify-web.sh [--journey <name> \| --spec <path>] [-- <playwright-args>]`              | Activates toolchain, maps `--journey`/`--spec`, and execs `.agents/skills/verify-linger/scripts/verify.sh`                                        |
| `verify-local-client.sh` | `.claude/skills/verify/scripts/verify-local-client.sh [--smoke-only] [--with-setup-inspect]`                          | Activates toolchain and execs cross-platform `.agents/skills/verify-linger/scripts/verify-local-client.mjs`                                       |
| `cleanup.sh`             | `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>`                                                             | Cleans up any stranded owned PIDs/containers/temp homes, checks ports free, confirms evidence survived                                            |
