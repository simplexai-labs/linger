# Rooms, messaging, sharing, and deletion

Rooms let a signed-in user create collaborative spaces, optionally add online Agents as members, exchange persistent messages, leave and rejoin without losing role or history, share a frozen read-only conversation snapshot with anonymous readers (and revoke it), and delete a Room permanently.

## Sub-features

- `room-create-and-members` creates a Room first, opens the optional `Add Room members` dialog, adds an eligible Agent (`actor_acme_official`), and persists membership across sessions.
- `room-message-and-leave-rejoin` sends a durable message, leaves the Room via Room settings (including Cancel check), hides the composer across all sessions while preserving history, and rejoins with owner permissions intact.
- `room-unavailable-guard` shows a friendly unavailable page with `Back to my Rooms` when visiting a nonexistent or inaccessible Room URL.
- `room-share-and-revoke` creates an anonymous frozen snapshot link (`#room_share_...`) with Markdown and image attachments, excludes later messages from the snapshot, and blocks reads after revocation.
- `room-delete` deletes a Room after a single confirmation dialog, removes it from navigation, and shows the unavailable page from a fresh browser session.

## How to get to it (user POV)

- Sign in and land on `/t/:tenantId/rooms/:roomId/chat`, or select a Room link in the `Room navigation` sidebar.
- Choose button `Create chat` in `Room navigation`, then menuitem `Create Room`.
- Open Room settings from the Room header avatar button (`Open <Room name> settings from avatar`) to access `Edit Room details`, `Leave Room`, `Share conversation`, and `Delete Room`.
- Open a generated `#room_share_...` URL in a signed-out browser session.

## Driving it with Playwright (verify-web.sh)

Preconditions:

- `.claude/skills/verify/scripts/doctor.sh --preflight` reports `Preflight passed (0 failures).`
- Default isolated ports (`23008`, `28089`, `28088`, `24328`) are free and Docker is running.
- For `room-create-and-members`, the test harness marks the owner Computer online (`connectOwnerComputer()`) so seeded Agent `actor_acme_official` is eligible for membership.

- **Run all Room lifecycle journeys.** Run `.claude/skills/verify/scripts/verify-web.sh --journey rooms`. All 4 tests in `apps/web/e2e/room-creation.spec.ts` pass and retain screenshots and traces under `<evidence-dir>/browser/`.
- **Create a Room and add a member (`room-create-and-members`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey rooms -- -g "creates the Room"`. Filling `Room name` (`Two step durable proof`), clicking `Create Room`, picking `official` in `Choose members`, and clicking `Add members` persists `actor_acme_official` in `GET /v0/rooms/<roomId>/members` and displays `official` in region `Room members` from a second fresh browser session (`created-room.png`, `agent-membership.png`).
- **Send message, leave, rejoin, and check unavailable Room (`room-message-and-leave-rejoin`, `room-unavailable-guard`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey rooms -- -g "leaves and rejoins"`. Sending `Before leaving proof` renders it in `Room timeline`; clicking `Leave Room` -> `Leave` replaces `Message Room` with `Join <Room name>` on both open sessions while preserving timeline text after reload; clicking `Join <Room name>` restores composer and `Edit Room details`; navigating to a missing Room shows heading `This Room is not available to you` (`leave-confirmation.png`, `left-room.png`, `rejoined-owner.png`, `friendly-unavailable.png`).
- **Share frozen snapshot and revoke (`room-share-and-revoke`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey rooms -- -g "shares a frozen Room"`. Sending formatted Markdown + PNG attachment, clicking `Share conversation` -> `Create share link`, opening textbox `Conversation link` URL in a guest context renders bold text and loaded image without a composer; sending a later message stays absent from guest reload; clicking `Revoke` causes guest reload to show an `alert` containing `unavailable or has been revoked` (`share-created.png`, `anonymous-snapshot.png`, `share-revoked.png`).
- **Delete a Room (`room-delete`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey rooms -- -g "deletes a Room"`. Opening `panel-room-settings`, clicking `Delete Room`, and confirming in dialog `Delete Room` (with no text input required) removes the Room link from `Room navigation` and returns `This Room is not available to you` in a fresh browser session (`delete-room-dialog.png`, `deleted-room-unavailable.png`).
- **Verify startup responsiveness.** Run `.claude/skills/verify/scripts/verify-web.sh --journey startup`. `apps/web/e2e/room-startup.spec.ts` confirms the composer remains usable while auxiliary Room-list, Another Me, and voice-policy responses are held.
- **Clean up and confirm proof.** Run `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>` and confirm all ports and disposable Compose resources are gone while `<evidence-dir>` files remain.

## Gotchas

- Only Agents can be added to a Room in the single-Human Space model, and an Agent is offered in `Choose members` only when its Computer is online. Without `connectOwnerComputer()`, the picker omits `actor_acme_official`.
- The Share dialog contains both a `Conversation link` textbox and a `Copy conversation link` button; target role `textbox` with name `Conversation link` to read the URL.
- Live Agent replies are NOT proved by `--journey rooms`: this isolated stack runs real TeamHub and PostgreSQL without a live Local Computer daemon or LLM provider. Report real Agent inference separately.
- Do not test deletion only by observing client-side navigation away; reopen the deleted Room URL in a fresh browser session to verify server persistence.
