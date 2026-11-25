# Connected Apps and scheduled Routines

Connected Apps let a user browse categorized external integrations, authorize an app through OAuth, inspect active connections across sessions, and disconnect an app. Scheduled Routines let a user configure recurring weekday or daily instructions on an Agent inside a Room, edit the schedule from another session, and have TeamHub fire each due occurrence once.

## Sub-features

- `apps-browse-and-filter` switches Connector category tabs (`All`, `Productivity`), toggles `Connected only`, and verifies zero horizontal overflow at `390px` mobile width.
- `apps-connect-reopen-disconnect` opens the OAuth popup for `Linear`, reconciles `Active` status on return, confirms persistence in a fresh browser context, disconnects through `Disconnect account?`, and verifies `Connect Linear` returns on reload.
- `routines-create-weekly` opens an Agent's `Routines` tab in Room sidebar details and saves a Mon–Fri weekly routine with timezone and clock time.
- `routines-reopen-and-edit` opens the saved routine from a fresh browser session in a different timezone, edits the selected weekdays, and preserves the routine's stored timezone.
- `routines-fire-once` triggers a due routine occurrence and confirms exactly one `routine.changed` (`fired`) event in `/v0/rooms/:roomId/events` plus a 24-hour advance of `next_run_at`.

## How to get to it (user POV)

- Open `/t/:tenantId/apps` (or `/t/:tenantId/apps?app=linear`) from the signed-in shell to manage Connected Apps.
- Inside a Room, open an Agent's details panel (`/t/:tenantId/rooms/:roomId/chat?profile=<agentActorId>` or click the Agent in the Room), ensure `Show sidebar` is expanded, and select tab `Routines`.

## Driving it with Playwright (verify-web.sh)

Preconditions:

- `.claude/skills/verify/scripts/doctor.sh --preflight` reports `Preflight passed (0 failures).`
- Default isolated ports (`23008`, `28089`, `28088`, `24328`) are free; `--journey connectors` additionally requires `VERIFY_COMPOSIO_PORT` (default `28087`) to be free.
- `--journey connectors` injects a disposable HTTP Composio provider (`.agents/skills/verify-linger/apps-provider.mjs`) at the existing `-composio-base-url` production adapter boundary; real supplier OAuth is out of scope and recorded in `proof.json`.

- **Run the Connected Apps journey (`apps-browse-and-filter`, `apps-connect-reopen-disconnect`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey connectors`. Confirms `doctor.sh`, verifies `tablist "Connector categories"` (`All`, `Productivity`), toggles `Connected only` (`No connected apps yet.`), checks `scrollWidth === 390` at `390×844`, clicks `Connect Linear`, approves `Authorize Linear` in the provider popup, waits for dialog `Linear` to show `Active`, verifies `Active` in a fresh browser session, clicks `Disconnect` -> `Disconnect account?` -> `Disconnect` -> `Close`, and confirms `Connect Linear` returns after reload (`connectors.png`, `connectors-mobile.png`, `connected.png`, `reopened.png`, `disconnected.png`, `proof.json`).
- **Run the live Doctor check with Connectors (when inspecting interactively).** While the connectors stack is live (for example with `-- --debug`), run `.claude/skills/verify/scripts/doctor.sh --web --with-connectors` and confirm all 5 endpoints including `composio-provider` return `OK`.
- **Run the scheduled Routines journey (`routines-create-weekly`, `routines-reopen-and-edit`, `routines-fire-once`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey routines`. Joins `actor_acme_official` to the Room, opens `?profile=actor_acme_official`, switches `panel-tab-agent-info` to tab `Routines`, creates `Weekly multi-day proof` (`When` -> `Weekdays`, `21:00`, `Asia/Shanghai`), verifies `GET /v0/rooms/<roomId>/routines`, reopens in a fresh `America/New_York` browser context, toggles off `Tue` and saves (`Mon, Wed, Thu, Fri`, timezone preserved), switches to `Every day`, fires the due occurrence, and verifies exactly one `routine.changed` (`change_kind: "fired"`) event plus `+24h` `next_run_at` (`weekly-selection.png`, `weekly-reopened.png`, `weekly-fired.png`, `created-routine.json`, `trigger-proof.json`).
- **Clean up and confirm proof.** Run `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>` for each run and confirm zero stranded containers/ports while evidence survives.

## Gotchas

- Connected Apps reconciliation after popup close uses immediate callback wake on `/oauth/composio-complete` with a 5-second fallback poll (up to 3 minutes, then 1 minute), so give the `Active` check up to 90 seconds rather than failing on the first render.
- The Connectors page displays only apps listed in its managed category groups unless already connected; catalog apps outside those groups will not show cards by default.
- `--journey connectors` exercises a simulated Composio HTTP adapter, not real third-party OAuth or live Agent tool calls. Never report it as real-account acceptance; state the adapter boundary in your report.
- A Routine created from an Agent's details panel mentions that Agent, so firing emits a hidden `agent_runtime` wake rather than a visible timeline message; prove firing through `/v0/rooms/<roomId>/events` (`routine.changed` / `fired`) and updated `next_run_at`.
- If the Room sidebar is collapsed, click button `Show sidebar` before querying `panel-tab-agent-info`.
