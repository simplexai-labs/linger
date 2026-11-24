---
name: verify-linger
description: Verify Linger user journeys with existing automatic tests, natural-language scenarios, and retained evidence across Web, Desktop client, Local Installer, Local Computer, and Local Models/BYOK (Linux, macOS, Windows). Use after behavior changes, to reproduce a workflow, or for core product acceptance.
---

# Verify Linger

Read [the feature map](features/README.md), then the affected journey.
For a Desktop release or release candidate, the [upgrade from the previous release](features/desktop-and-installer.md#upgrade-from-the-previous-release) is required on every shipped target.
The map contains user goals, prerequisites, expected outcomes, evidence, and automatic checks to reuse.
Keep stable product goals while verifying entry paths against the selected revision.
Run from the repository root. This skill is for agents; product capability documentation remains in `docs/` and each app's `AGENTS.md`.

## Launch

Use Node `>=26.5.0 <27`, pnpm `11.7.0`, Go from `apps/teamhub/go.mod`, Docker Compose, Chromium, `curl`, `shasum` (or `sha256sum`), and `ss` or `lsof`. The helper uses `flock` when available and a checkout-local directory lock otherwise. Check both `node --version` and `pnpm exec node --version`; version-manager shims can select different Node versions. Install the locked dependencies and browser once:

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
```

Run the complete local Document proof:

```bash
.agents/skills/verify-linger/scripts/verify.sh
```

The executable prints a unique absolute evidence directory. [The config](playwright.config.ts) reuses [the repository's real-service config](../../../e2e/playwright.room-document.config.ts) with its working directory fixed to the repository root. Playwright builds and serves production Web assets, then starts TeamHub, Document Runtime, and a disposable PostgreSQL Compose project. It waits for Web and control `/healthz`; the test runs Doctor before UI actions. It shuts these services down after success or failure. No root `.env` or production credentials are required.

Default loopback ports are Web `23008`, TeamHub `28089`, control `28088`, and Document Runtime `24328`. PostgreSQL gets a dynamic port. The seeded disposable login is `alice@example.com` with password `teamhub-dev-alice`. The control service prepares a Room and native Document before the proof; it does not perform the edit under test.

The helper locks one run per checkout because builds share checkout-local assets and caches. Parallel work requires separate worktrees and four distinct `PLAYWRIGHT_ROOM_DOCUMENT_{WEB,TEAMHUB,CONTROL,RUNTIME}_PORT` values. The helper checks all four ports before launch and disables reuse. An occupied port is a blocker, not permission to drive its owner. Caller-provided `TEST_DATABASE_URL`, `PLAYWRIGHT_SKIP_WEB_SERVER=1`, and prebuilt `ROOM_DOCUMENT_E2E_*_BINARY` overrides are rejected.

The ordinary full development command is `pnpm dev`, but it prepares configured databases and starts additional services. This proof only needs the repository's isolated E2E stack.

The launcher forces `TEAMHUB_TEST_DATABASE=isolated`, even when the caller inherited
`shared`. It never reuses the development database. The selected mode is recorded
in `source.txt` beside the submitted revision and ports.

### Remote acceptance when local resources are limited

Build and run the same pinned source on the authorized test host. Use a distinct
Compose project, database, volumes and available ports. Record the dirty patch,
image IDs and remote directory. Do not update a colleague's checkout or reuse a
shared acceptance database. Keep credentials in private files outside Git.

The existing `verify.sh` owns a disposable local stack. It does not attach to an
arbitrary remote URL. For an already deployed remote instance, follow the feature
map through its actual UI and supported APIs. Run automatic suites on the remote
source checkout with their own disposable data. Report these as separate proofs.

Check Web login, Document WebSocket persistence and a fresh browser read. For
Agent execution, configure both `AGENT_RUNNER_PUBLIC_GATEWAY_URL` and
`TEAMHUB_CLI_BASE_URL` with addresses reachable from the isolated Computer.
The CLI origin must serve `/api/agent/v1/`; the repository's Web static host only
proxies browser `/v0/` routes. Use the deployment's Agent API route or an owned
TeamHub listener. A loopback listener works only for a Computer on that host.
Install the complete source-built Computer bundle, including `cli/`, `daemon/`
and `runtime/`; a standalone daemon is insufficient. Keep its Runtime home and
workspace separate from existing Computers. An online Computer or successful Run
is not proof that the requested message or file was delivered.

On Linux, use a process-local `umask 077` for private-state tests. Do not change
shared directory permissions to repair a test fixture. Record resource ownership
and teardown; retain a requested remote deployment instead of stopping it as if
it were the helper's disposable local stack.

## Doctor

While this run owns the services, run this read-only check whenever behavior looks wrong:

```bash
.agents/skills/verify-linger/scripts/doctor.sh
```

It requires successful Web, TeamHub, and control health responses plus Runtime readiness. It prints the corresponding listener PIDs. Compare them with the run's process tree and startup log. `source.txt` identifies this checkout's HEAD, dirty paths, tools, and ports; health alone does not establish source identity. The baseline also verifies authentication through the actual login form. A failed login or unexpected Tenant makes the instance unsuitable for that recipe.

## Drive

This skill verifies selected user scenarios; it does not replace the existing
unit/component, integration, or E2E suites. For a full acceptance run, use the
existing verification entry points in the [repository guide](../../../AGENTS.md) (`make check BASE=<target-ref>`, `make check-e2e`)
and report their results alongside these scenarios. Count discovered, executed,
and skipped tests separately. A fixture response, an opt-in live test that skipped,
or a successful source build is not a real Agent execution result.

[document.spec.ts](document.spec.ts) is the executable baseline: UI login, direct Document link, `Document mode` then `Edit`, typing in `.bn-editor`, waiting for `Saved`, and reopening in a new browser context. Use `--headed` only when a display is available. Interactive inspection uses the same owned stack:

```bash
.agents/skills/verify-linger/scripts/verify.sh --debug
```

Extend this focused spec for another real-service recipe, keep `test.step` action labels, and run only the relevant path. Use role/name selectors from the map. Drive links, forms, and editor controls; do not inject sessions, edit fixture state, call internal setters, or use `history.pushState` as the action being proved.

The Connected Apps proof replaces the Composio adapter with a disposable HTTP provider and exercises the Connectors page against real TeamHub and PostgreSQL:

```bash
VERIFY_CONNECTED_APPS=1 .agents/skills/verify-linger/scripts/verify.sh
```

The callback origin uses `WEB_PUBLIC_ORIGIN` from the isolated Web port. The proof adds `VERIFY_COMPOSIO_PORT` (default `28087`) to the owned ports, injects a disposable provider key and environment key into TeamHub, and starts TeamHub with `-composio-base-url` pointing at the provider. It runs [apps.spec.ts](apps.spec.ts) against the fixed list of managed apps: filter the Connectors categories, check the mobile layout, connect Linear through the provider popup, reopen it in a fresh session, and disconnect. The page shows only apps listed in its groups (unless already connected), so Google Drive and Facebook stay in the TeamHub catalog without a card by default. Pending authorization reconciles immediately when the popup completes on `/oauth/composio-complete` (with a 5-second fallback poll for 3 minutes, then 1 minute thereafter). The provider is an existing adapter-boundary simulation; real OAuth and Agent tool execution are out of scope and the proof must say so in `proof.json`.

The Connector CLI proof uses the same isolated stack plus an actual Computer Use session:

```bash
connector_proof_dir=$(mktemp -d "${TMPDIR:-/tmp}/teamhub-connector-proof.XXXXXX")
VERIFY_CONNECTOR_CLI=1 CONNECTOR_CLI_MANUAL=1 \
  CONNECTOR_CLI_PROOF_CONFIG="$connector_proof_dir/config.json" \
  .agents/skills/verify-linger/scripts/verify.sh
```

Build `@linger/teamhub-cli` first (`pnpm --filter @linger/teamhub-cli build`). The fixture creates a one-hour disposable Agent credential in the private configuration directory; do not print or publish it. When the test writes `manual-ready.json` to its evidence directory, use actual Computer Use to open its Room URL, log in as disposable Alice, click the selected app card and complete the simulated provider page. Save the before/after screenshot and accessibility text. Only after visibly confirming the connected card, write `manual-done.json` with the browser/tab IDs and observed result. The test then reruns the real Gmail CLI and reads back a Markdown draft as backend-generated HTML. It also checks that three concurrent authorization retries reuse one card and perform no external business action before authorization.

This recipe does not automate real supplier consent or send real email. `proof.json` must identify the simulated Composio/OAuth boundary; a passing result is not real-account acceptance. The fixture must not perform the CLI action under test.

The Room startup proof uses the same real isolated stack:

```bash
VERIFY_ROOM_STARTUP=1 .agents/skills/verify-linger/scripts/verify.sh
```

It runs `apps/web/e2e/room-startup.spec.ts`: real form login and durable messages,
then holds actual Room-list, Another Me, and voice-policy HTTP responses at the
browser transport boundary. Chat must remain usable before each response is
released, and release must preserve composer identity, draft, focus, and scroll.
It also records cold/cached in-app navigation and reads the sent draft in a fresh
session. It also holds a real Message acknowledgement while submitting a second message,
checks that a newer identical draft survives, and opens an Online Document card through
one combined open request while editor code loads in parallel. The Document is edited,
saved and read in a fresh browser context. No business response is replaced;
microphone/Voice Runtime and Agent execution are outside this proof. This stack
reports voice input as unsupported (`voice_media_supported: false`). After the held policy response is released,
voice controls stay hidden while chat state remains intact.

For production-bundle startup measurements against the same owned real services:

```bash
VERIFY_ROOM_STARTUP_PRODUCTION=1 .agents/skills/verify-linger/scripts/verify.sh
```

This builds production assets and serves the production
static host behind a loopback API/WebSocket proxy. It seeds the existing TeamHub
directory SQL regression fixture (8 Agents and their Skill bindings), opens an ordinary
Agent Direct Room, and persists 13 messages. Agent registration/execution is not
under test. The database is disposable; no remote credentials or shared CI state
are used. Five pairs of HTTP-cold/HTTP-warm full document loads are measured by
default, with an explicit 150 ms browser network latency and no CPU throttling.
`ROOM_STARTUP_SAMPLES` and `ROOM_STARTUP_LATENCY_MS` change those conditions.

`startup-measurements.json` records DOM readiness, directory timing, loaded JS,
long tasks, and panel opening at 0/1/3 seconds after chat readiness (three trials
each). Browser-frame timestamps separate the first visible shell from ready
Agent Info content; actual click delay is recorded too. Screenshots and source hashes are retained.
Performance runs disable video and keep Playwright traces only on failure; do not
run other builds/tests concurrently with measurements. These are local HTTP/1.1
reference timings, not CI latency, HTTP/2 equivalence, or production percentiles.
Compare the same fixture and conditions across builds.

The directory must start before messages finish, closed sidebar code must start
after chat readiness, and the file editor must have its own lazy chunk, absent
from startup and Agent Info opening.
The test also holds a real code response while typing, closing and reopening the
loading shell; reopening the saved panel must load its code with idle callbacks disabled and
the real Agent directory response held. An active-peer Direct Room must still
send through the composer while that response is held; a separate message read
must find the message exactly once. Releasing the directory must preserve the
composer, draft and focus. No business response is fabricated.

`VERIFY_ROOM_STARTUP=1` already builds and serves production Web assets behind the same loopback proxy; combine `VERIFY_ROOM_STARTUP_PRODUCTION=1 VERIFY_ROOM_STARTUP=1` only when you need the longer 300-second startup budget with video off, and select a case with `-g 'Room sending releases' --trace=on`.

For cross-platform Desktop Client, Local Installer, Local Models, and BYOK verification on Linux, macOS, or Windows:

```bash
node .agents/skills/verify-linger/scripts/verify-local-client.mjs
```

It runs the host-applicable deterministic checks (`@linger/service-kit` BYOK rules, `@linger/local-installation` including Windows-native ACL/process tests on Windows hosts, `@linger/linger-installer`, `@linger/desktop`, Python packaging unit tests, and Go Daemon `localmodels`/`model_source` tests), then runs an isolated live Local Installer loopback proof (private modes, CSRF Origin rejection, one-time token exchange and replay rejection, `/api/environment`, `/api/instances`, BYOK SSRF refusal, and clean `--stop`). Pass `--smoke-only` to run only the live installer loopback proof. It records `source.txt`, `source.patch`, `changed-files.sha256`, `run.log`, `proof.json`, and `exit-code.txt` under `test-results/verify-linger/local-client.XXXXXX/`, and reports non-host OS checks as `skippedOs`. Electron GUI journeys, real GPU/Metal/CUDA weight downloads, auto-updater swaps, and external BYOK inference remain separate recipes in [Desktop Client and Local Installer](features/desktop-and-installer.md) and [Local Models and BYOK](features/local-models-and-byok.md).

Every Playwright spec in `apps/web/e2e` runs against the real TeamHub and Document Runtime stack; no fixture build exists. UI behavior without a real-stack spec is covered by Web unit tests, which do not prove persistence or Agent execution.

## Evidence

Each run retains `test-results/verify-linger/run.XXXXXX/`:

- `source.txt`, `run.log`, and `exit-code.txt` record source identity, startup/shutdown, and outcome.
- `source.patch` includes staged and unstaged changes from HEAD; `changed-files.sha256` fingerprints the current changed and untracked files. Deleted paths remain in the patch and are not hashed.
- `browser/` contains `doctor.txt`, before/saved/reopened screenshots, `reopened.aria.yml`, `proof.json`, the Playwright trace, and video.
- `report/index.html` links Playwright steps and attachments.

Capture actions and resulting states. For mutations, also capture a second read of the saved value. The baseline uses a fresh browser context so prior IndexedDB and cookies cannot supply the content. Capture public API responses or resulting files when the mapped feature has those side effects. A final screenshot or HTTP 200 alone is insufficient.

Judge Agent output against the requested outcome and expected author.
For an exact-marker reply, require the exact ordinary message body.
For free-form output, inspect required facts, attribution and completion rather than identical wording.
An approval card containing the requested text is not a delivered reply.
Do not accept a substring match against serialized JSON as message proof.
Use the persisted message ID to verify its visible body after browser reload.
File creation, reply delivery, and permission decisions are separate outcomes.
Record both requested and returned model identities when the gateway exposes them.
If they differ, report the discrepancy rather than claiming the requested model was verified.

The fixture reset is disposable setup, not feature proof. The baseline uses real TeamHub and Yjs transport, with no mocked business responses. The test database disables fsync and synchronous commits, so this proves application persistence and fresh-session reads, not power-loss recovery. Extra external systems may be mocked only at an existing production adapter boundary, and the report must name that limitation. Inspect actual network/file/ref changes before calling any future dry-run side-effect-free.

Record each mapped entry point as verified, failed, or skipped with its unmet prerequisite. One passing Document link does not verify Owned by Me creation, Room attachment or Document panel navigation, comments, Wiki generation, or Agent execution. Keep evidence private because traces include disposable login/session data; do not commit it.

For additional natural-language journeys, write their results and evidence links in the run's `report.md`.
During a repair loop, use its existing `round-N/report.md` instead of maintaining a second report.
Separate documented scenarios, automatic coverage, and scenarios actually executed on this revision.
When using a temporary probe, retain its exact source and SHA-256 beside the result.
Describe assertion changes between attempts; a corrected probe still needs execution.

When supplying an external `TEST_DATABASE_URL`, allocate a fresh owned database for each real-service E2E invocation. The Go integration suite clones its control database, but the Document E2E harness seeds and writes the supplied database directly. Do not reuse its persisted records with a new temporary artifact directory. Remove only that invocation's database after teardown.

## Cleanup

Let the Playwright command finish, including its graceful SIGTERM teardown, after every attempt. To stop an interactive run, press Ctrl-C in its terminal and wait for teardown. Kill only a PID that this run started if the normal path fails. Never kill by process name or stop a shared development Compose project.

The existing database wrapper checks resource labels before removing its exact Compose container, volume, and network (`docker-compose.test.yml` uses `tmpfs` for PostgreSQL data, so no named volume is created). The Runtime harness removes its own temporary fixture directories. Inspect `run.log` for the exact `teamhub-test-*` identity and verify those resources are absent with `docker container inspect`, `docker network inspect`, and `docker volume ls --quiet --filter "label=com.docker.compose.project=<project>"`. Require the container and network lookups to report not found and the volume query to return empty. Verify the four run ports have no remaining listeners:

```bash
ss -ltnp '( sport = :23008 or sport = :28089 or sport = :28088 or sport = :24328 )'
```

On macOS without `ss`, inspect each recorded port with
`lsof -nP -iTCP:<port> -sTCP:LISTEN` instead.

Substitute the recorded ports if overridden. If teardown was interrupted, report the exact remaining resource and use the existing wrapper's label validation before any removal. Cleanup must preserve the evidence directory. Confirm `proof.json`, screenshots, and `trace.zip` still exist after successful cleanup. Failed runs retain diagnostic artifacts even when no proof was reached.

## Helpers

`scripts/verify.sh` allocates evidence and invokes Playwright. It accepts Playwright flags and returns its exit code. `scripts/doctor.sh` performs only GET requests and listener inspection. `scripts/verify-local-client.mjs` runs cross-platform (Linux, macOS, Windows) Desktop, Installer, Local Models, and BYOK checks plus an isolated live Local Installer loopback proof, retaining evidence under `test-results/verify-linger/local-client.XXXXXX/`. All three are executable; invoke them as shown above. Config and spec files run through Playwright, not as standalone scripts.

For requested repairs, follow the user's execution roles, edit scope and round limit.
Keep original failures and revalidate their business outcomes after each repair.
