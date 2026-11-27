# Linger verification map

This directory provides concise, runnable 4-section verification recipes for Linger's Web product UI and Local Client (Local Installer, Desktop client, Local Models, and BYOK) surfaces. It wraps the canonical runners and extended acceptance catalog in [.agents/skills/verify-linger/features/README.md](../../../../.agents/skills/verify-linger/features/README.md) (which also covers Connector CLI with Computer Use, remote deployments, live Agent execution and output judging rules, and OS-packaged release upgrades). Read this index before driving the app, then follow the matching feature file as the recipe.

## Baseline preconditions

- Run from the repository root with Node `>=26.5.0 <27` (`.node-version`) and `pnpm@11.7.0` (`package.json`). All scripts under `.claude/skills/verify/scripts/` activate pinned `mise` versions automatically when available.
- Install worktree dependencies (`pnpm install --frozen-lockfile --prefer-offline`) and Playwright Chromium (`pnpm exec playwright install chromium`) once.
- Run `.claude/skills/verify/scripts/doctor.sh --preflight` and require `Preflight passed (0 failures).` before starting a Web proof.
- Web journeys start from an empty disposable PostgreSQL container (`TEAMHUB_TEST_DATABASE=isolated`), migrated and seeded with disposable user `alice@example.com` / `teamhub-dev-alice` and seeded Agent `actor_acme_official`.
- Local Installer journeys start from an empty private temp `--home` directory (`mktemp -d "${TMPDIR:-/tmp}/linger-verify-installer.XXXXXX"`) on an ephemeral loopback port (`--port 0`). Never point verification at `~/.linger`.
- Never drive an instance, port, or database that was not started by the current verification run.

## Driving conventions

- Start every recipe from its baseline preconditions unless its preconditions state an extra step (such as enabling an online Computer or the disposable Composio adapter).
- Prefer ARIA roles, accessible names, labels, and route paths over CSS selectors, DOM order, or coordinates.
- Treat every command as literal. Keep quoted names, routes, and flags unchanged.
- Drive Web UI journeys through `.claude/skills/verify/scripts/verify-web.sh` (wraps `.agents/skills/verify-linger/scripts/verify.sh`, retaining evidence under `test-results/verify-linger/run.<XXXXXX>/`).
- Drive Local Client journeys through `.claude/skills/verify/scripts/verify-local-client.sh` on POSIX or `node .agents/skills/verify-linger/scripts/verify-local-client.mjs` on Windows/macOS/Linux (retaining evidence under `test-results/verify-linger/local-client.<XXXXXX>/`).
- Run `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>` after every run — passing, failing, or interrupted. Cleanup removes processes and scratch state, never proof artifacts.

## Proof and skip reporting

- Capture both the user action and the resulting state, not only a final screen.
- UI proof includes screenshots, ARIA snapshots or Playwright traces, and visible app/object identity.
- API and CLI proof includes the command or endpoint, HTTP status or exit code, and verified response payload.
- Mutation proof includes a second read from a fresh browser context (no reused cookies or IndexedDB) plus the matching backend state (`persisted_seq`, `/v0/*` read, or event log).
- Record the feature ID, sub-feature ID, and exact entry point used in the run report or `proof.json`.
- Report an unreachable or missing-precondition path with the attempted command and the unmet precondition. Never weaken a journey or report a skipped entry point as verified through another path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order:

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with <harness>` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps and missing seed/hardware preconditions that can waste or invalidate a run.

Keep implementation internals out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Sign in, session guard, and sign out](./auth-and-session.md) covers form login, `return_to` redirects, wrong-password errors, logout, and post-logout route protection.
- [Rooms, messaging, sharing, and deletion](./rooms.md) covers two-step Room creation, member addition, messaging, leave/rejoin sync, frozen anonymous sharing and revocation, and Room deletion.
- [Native Room Documents and comments](./documents.md) covers opening Documents across entry paths, Edit mode, persistence across fresh sessions, renaming, and anchored comments.
- [Connected Apps and scheduled Routines](./connectors-and-routines.md) covers Connectors category browsing, mobile layout, OAuth popup connect/reopen/disconnect, and Agent weekly Routine creation, editing, and firing.
- [Local Installer, Desktop client, Local Models, and BYOK](./desktop-installer-and-models.md) covers isolated Local Installer loopback auth/CSRF/token replay, browser harness selection and BYOK SSRF refusal, Desktop setup/upgrade/sleep-quit checks, and Settings Models management.
