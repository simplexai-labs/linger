# Native Room Documents and comments

Native Room Documents let a user open a collaborative document directly or from a Room sidebar, switch into Edit mode, write formatted content that synchronizes over the Document Runtime and persists in PostgreSQL, rename the document title, and attach persistent comment threads visible across sessions.

## Sub-features

- `doc-direct-edit-persist` opens a native Document via its direct route, enters Edit mode, types a unique marker, waits for `Saved` and persisted sequence advancement, and reads the saved text from a fresh browser context.
- `doc-sidebar-and-viewport` opens the same Document from the Room sidebar `Documents` launcher, verifies readable width across desktop viewports (`1440`, `2560`, `3440`), and confirms scrolling and sidebar maximize/restore.
- `doc-rename-inline` renames a Document from its title header while keeping the editor body editable and focused.
- `doc-comments-anchor-sse` attaches a comment to selected Document text, toggles the `All Document comments` drawer (including at `390px` mobile width), and delivers the thread to a second browser session over Room SSE.

## How to get to it (user POV)

- Open `/t/:tenantId/documents/:documentId` directly while signed in.
- Inside a Room (`/t/:tenantId/rooms/:roomId/chat`), click `Show sidebar` (if collapsed), choose button `Documents` in `Panel sidebar`, and select the file button in `Room files`.
- Open `/t/:tenantId/library` and select the Document from Library.

## Driving it with Playwright (verify-web.sh)

Preconditions:

- `.claude/skills/verify/scripts/doctor.sh --preflight` reports `Preflight passed (0 failures).`
- Default isolated ports (`23008`, `28089`, `28088`, `24328`) are free and Docker is running.
- Real TeamHub, Document Runtime, and disposable PostgreSQL are managed by `verify-web.sh`.

- **Run the baseline Document persistence proof (`doc-direct-edit-persist`).** Run `.claude/skills/verify/scripts/verify-web.sh --journey document`. The spec runs `doctor.sh`, signs in through `/login`, opens `/t/<tenantId>/documents/<documentId>`, clicks button `Document mode` -> menuitem `/\bEdit$/`, types a unique timestamped marker in `.bn-editor`, waits for `[data-room-document-save-status="Saved"]` and `harness.state().persisted_seq > 0`, and reopens the Document in a brand-new browser context (fresh cookies and IndexedDB). Evidence lands in `<evidence-dir>/browser/` (`doctor.txt`, `before.png`, `saved.png`, `reopened.png`, `reopened.aria.yml`, `proof.json`, `trace.zip`, `video.webm`) and `<evidence-dir>/report/index.html`.
- **Verify sidebar navigation, viewports, and inline rename (`doc-sidebar-and-viewport`, `doc-rename-inline`).** Run `.claude/skills/verify/scripts/verify-web.sh --spec apps/web/e2e/room-document-collaboration.spec.ts`. Confirms editor bounds at `1440`/`2560`/`3440` px, Room sidebar `Documents` launcher scroll + `Maximize sidebar` / `Restore sidebar`, and `Rename document` -> `Document title` persistence without blocking editing.
- **Verify anchored comments across sessions and narrow viewports (`doc-comments-anchor-sse`).** Run `.claude/skills/verify/scripts/verify-web.sh --spec apps/web/e2e/room-document-comments.spec.ts`. Confirms `Comments` drawer fits within a `390px` viewport, selecting text and clicking `Add comment` -> `New Document comment` persists the thread, and a second session reads it via `GET /v0/documents/<id>/comment-threads` and the `All Document comments` drawer.
- **Verify anonymous Document links and attachments.** Run `.claude/skills/verify/scripts/verify-web.sh --spec apps/web/e2e/room-document-assets.spec.ts`. Confirms anonymous shared Document read and revocation plus preview behavior.
- **Clean up and confirm proof.** Run `.claude/skills/verify/scripts/cleanup.sh <evidence-dir>` and confirm all ports and `teamhub-test-*` resources are absent while `<evidence-dir>` proof files remain intact.

## Gotchas

- Never treat a single-session `page.reload()` as persistence proof: local IndexedDB can replay unsaved Yjs updates. Always verify saved content from a new `browser.newContext()` with a fresh login.
- The `Edit` menuitem inside `Document mode` can include a current-mode icon; match `/\bEdit$/` rather than exact `"Edit"`.
- Passing the direct-link proof (`--journey document`) does not automatically prove Room sidebar entry, Library creation, comments, or `@Agent` comment mentions. Record each entry point separately.
- The isolated test PostgreSQL disables `fsync` and synchronous commits for speed, so passing proves application and WebSocket persistence rather than power-loss durability.
- Do not run another build against `apps/web/dist` concurrently while `verify-web.sh` is serving production assets from that checkout.
