# Sign in, session guard, and sign out

Authentication lets a user sign into their Linger Space with email and password, return directly to a deep-linked pairing or Room destination after signing in, see clear feedback on invalid credentials, and sign out so protected routes cannot be reopened after reload.

## Sub-features

- `auth-login-landing` signs a user in through `/login` and lands in their Room with a verified Cookie session.
- `auth-return-to` preserves `/connect-computer` query parameters across login and opens the pairing heading after sign-in.
- `auth-wrong-password` shows an alert on bad credentials, keeps the user on `/login`, and allows immediate retry.
- `auth-logout-guard` logs out via the account menu and keeps a previously visited Room URL redirected to `/login` even after a full page reload.
- `auth-relogin-budget` confirms a subsequent sign-in returns to the Room with only the initial `/login` check and one mandatory post-login `/v0/session` verification.

## How to get to it (user POV)

- Open `/login` directly or visit `/` or any `/t/:tenantId/...` URL while signed out (redirects to `/login`).
- Open `/login?return_to=<encoded-path>` from a Local Computer pairing link (`/connect-computer?...`).
- Choose the `Account menu` button in the signed-in shell and pick `Log out`.

## Driving it with Playwright (verify-web.sh)

Preconditions:

- `.claude/skills/verify/scripts/doctor.sh --preflight` reports `Preflight passed (0 failures).`
- Default isolated ports (`23008`, `28089`, `28088`, `24328`) are free and Docker is running.
- The disposable database is seeded with `alice@example.com` / `teamhub-dev-alice`.

- **Run the complete auth journey.** Run `.claude/skills/verify/scripts/verify-web.sh --journey login`. All 5 tests in `apps/web/e2e/room-login-chain.spec.ts` pass against real Web, TeamHub, and disposable PostgreSQL, and the script prints `Evidence retained: <evidence-dir>`.
- **Verify initial sign-in landing (`auth-login-landing`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey login -- -g "a new user lands in the Room"`. On `/login`, filling `Email` (`alice@example.com`) and exact `Password` (`teamhub-dev-alice`) and clicking button `Sign in` navigates to `/rooms/<id>/chat` with textbox `Message Room` visible.
- **Verify deep-link `return_to` (`auth-return-to`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey login -- -g "return_to keeps"`. Signing in from `/login?return_to=%2Fconnect-computer...` lands on the exact `/connect-computer?...` URL with heading `Connect Login proof` visible.
- **Verify wrong-password recovery (`auth-wrong-password`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey login -- -g "wrong password"`. Submitting `wrong-password` renders a visible `alert` while keeping URL on `/login`, and resubmitting `teamhub-dev-alice` lands in `/rooms/<id>/chat`.
- **Verify logout and reload guard (`auth-logout-guard`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey login -- -g "account menu logs out"`. Clicking button `Account menu` then menuitem `Log out` navigates to `/login`; revisiting the previous Room URL and calling `page.reload()` stays on `/login` with heading `Log in` visible.
- **Inspect and clean up.** Run `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>` and verify `<evidence-dir>/source.txt`, `<evidence-dir>/run.log`, `<evidence-dir>/report/index.html`, and `<evidence-dir>/browser/*/trace.zip` remain present while all ports and disposable Postgres resources are absent.

## Gotchas

- Linger has no public self-signup, Space invitation, or Human-to-Human DM registration flow; do not expect a Sign up link on `/login`.
- Use `{ exact: true }` on `Password` and `Sign in` so password visibility toggles or auxiliary controls cannot cause strict-mode locator collisions.
- Do not verify logout by checking only client-side URL change; revisit the protected Room URL and reload to prove the session cookie is actually invalidated on TeamHub.
- Visiting `/login` while already signed in automatically redirects back into the Space; clear cookies or use a fresh browser context when testing signed-out paths.
