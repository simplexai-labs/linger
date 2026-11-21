# Library, file entry paths and search

Verify that users can organize and find the same authorized Document across product surfaces.
Use the [shared execution and evidence rules](README.md).
The current Library routes are `/t/{tenantId}/library` (`?tab=owned|shared|meetings` and `?folder=<placementId>`, rendered without a sidebar), `/t/{tenantId}/documents/{documentId}` (with `LibrarySidebar`), `/t/{tenantId}/library/meetings?entry=<id>` (without `entry`, redirects to `/t/{tenantId}/library?tab=meetings`), and `/t/{tenantId}/wiki-preview`. Retired paths `/t/{tenantId}/library/{my-documents,shared-with-me,documents}` redirect to `/t/{tenantId}/library`.

## Create, import and organize

**Reuse:** `room-document-assets.spec.ts` and `room-document-office-preview-entry.spec.ts` cover real Document uploads and previews; Library unit tests (`library-documents-page.test.tsx`, `library-overview.test.tsx`) cover Library actions.
The real Document baseline proves direct-link editing and reopening, not every Library action.

**Journey:** Open **Library** and create a Markdown page in `My pages`.
Import a known file, open it, rename it, and reopen it through the tree and its existing link.
On Library home, `Create in My pages` exposes `New file` (creates an editable native Markdown page directly), `New folder`, `Import` (uploads a versioned file, including Markdown, rather than creating an editable native page), and `Upload folder`. In the Document sidebar (`LibrarySidebar`), choose `Create in Owned by Me` → `New file` → `md`. Folder rename, move, and delete actions live in `LibrarySidebar` (`Actions for <folder>`), not on Library home rows (`Open folder <name>`).
HTML import is supported as a file with an isolated preview, not as a BlockNote body.
When folder or deletion behavior changes, exercise the current supported action and its owning contract.
Do not infer a storage deletion from removing a placement or Room binding.

An apparently empty folder can retain a trashed Document's placement.
The current lifecycle deliberately rejects deleting that folder with
`DOCUMENT_FOLDER_NOT_EMPTY`; restoration keeps the Document's location.
Reuse `TestUnifiedDocumentLifecycleTrashesAndRestoresBindings` for this contract.
Verify the rejected deletion leaves the folder intact. Record the misleading
empty-state or missing recovery UI separately from backend contract violations.
For fixture cleanup only, use the supported Restore API, move the restored
Document to the root, delete the now-empty folder, then trash the owned Document.
Do not change the rejection assertion merely to make this recipe pass.

**Pass:** The created/imported content is readable and persists across a fresh session.
Rename updates the appropriate views while retaining the same Document identity.
Ownership, placement and access remain consistent with the current Document contract.
A failed import or rename reports the failure without presenting an unsaved object as complete.

For Duplicate, require a new Document ID and the same source content after a fresh
read. Delete that copy through the UI, confirm its read is rejected, and confirm
the original remains readable. Verify Restore through the supported API when no
UI entry is exposed, then read the restored copy in a fresh browser context.
Label the API restoration separately from UI actions. Delete only this recipe's
owned copies during cleanup; do not infer that Trash is immediate physical erasure.

**Evidence:** Keep the source filename/content, Document ID, visible tree, resulting metadata and fresh read.
Current UI hints include `Create in My pages` and `Actions for <title>` on the Library home, `Create in Owned by Me`, `Actions for <filename>`, and `Actions for <folder>` in the Document sidebar, `Actions for shared document <filename>` / `Actions for shared folder <name>` in the Shared with me tree, and `More Document actions` in the Document header.
Verify current labels before driving a refactored build.

## Cross-entry reading and previews

**Journey:** Attach an authorized Document to a Room and open it from the message, Room sidebar `Documents` launcher (`Files` tab) and **Library**.
Use representative supported text, image and Office files when those preview paths change.
For download-only formats, download and inspect the expected bytes.

**Pass:** Entry paths resolve the intended Document and content under their actual permissions.
A visible breadcrumb is not proof of preview support.
ZIP and unknown binaries can remain download-only when that is the supported behavior.
Loading or failure states remain distinguishable from an empty file.

**Evidence:** Record each exercised entry, its Document identity, the visible body or downloaded file, and a fresh-session read.
Use [Documents](documents.md) for editing, collaboration and actual Agent-produced file delivery.

## Search and return to context

**Reuse:** `apps/web/src/features/search/global-search-dialog.test.tsx` covers the search UI and its supported targets.

**Journey:** Create an authorized Room message and Document with distinct unique markers.
Search through the product, open each result, and confirm the intended context and content.
For a Thread result, use the [Room recipe](rooms.md#room-collaboration).
After trashing the Document, repeat its search. For Room messages, test a principal without Room access separately; losing Room access does not withdraw an active Agent’s Space-wide Document access.

**Pass:** Supported searches find the intended saved objects and open usable destinations.
A result from another fixture object must not substitute for the new marker.
Search does not disclose bodies or navigation targets beyond current visibility rules.
Substring matching does not promise semantic or fuzzy search.

For a denial comparison, inspect result identities and types. Every Human in the same Space can read and search every active Document in that Space (`TestHumanReadsEveryActiveDocumentOfTheSpace`), so prove denied Document search by trashing the Document or searching from an Account in a **different Space**. For Room Messages, non-members and post-leave hits stay absent while an authorized Room with the same marker may still appear; do not require the entire Search dialog to be empty. Pair a positive owner read with a separate-session negative read of the exact object.

**Evidence:** Keep the query, result identities, opened body and the authorized/denied comparison when exercised.

## Meetings and personal visibility

**Journey:** Open an authorized archived meeting in the **Meetings** tab (`/t/{tenantId}/library?tab=meetings`, supporting `Past 7 days` default 7-day strip, `All meetings` year heatmap, and `Today` list-only view) with distinct participants and a unique transcript marker.
Inspect its recording and transcript (`Transcript` / `Summary` tabs on `/t/{tenantId}/library/meetings?entry=<id>`), attribution and source Document identity.
Delete it from Meetings (`HideMeetingDialog`), then reopen the list and calendar.
For a fresh recording, `summary.md` appears only after the meeting's Wiki refresh publishes. The meeting page has no refresh action.

**Pass:** The meeting disappears from the Space's Meetings list and calendar (`capture_sessions.hidden_at` is currently scoped by `(id, tenant_id)`, so hiding is Space-wide in single-Human deployments rather than per-Human).
The `capture_sessions` record, underlying recording/transcript Documents, and already-published Memory/Wiki outputs remain intact and readable under their existing permissions.

**Evidence:** Keep Human identity, Capture/Document IDs, deletion confirmation, refreshed Meetings list, and fresh direct Document reads.
Reuse `apps/web/src/features/memory/meeting-page.test.tsx`, `apps/web/src/features/memory/meetings-panel.test.tsx`, and `apps/teamhub/tests/integration/hidden_meeting_test.go`.
The UI action is owned by `apps/web/src/features/memory/hide-meeting-dialog.tsx`.
Seeded archived media proves browsing and hiding, not real recording or transcription.

## Sources

- [Library rules](../../../../apps/web/src/features/library/AGENTS.md)
- [Documents editor rules](../../../../apps/web/src/features/rooms/documents/AGENTS.md)
- [Document assets E2E](../../../../apps/web/e2e/room-document-assets.spec.ts)
- [Office preview entry E2E](../../../../apps/web/e2e/room-document-office-preview-entry.spec.ts)
- [Current routes](../../../../apps/web/src/app/router.tsx)

## Organization and representative formats

Use a disposable folder tree and uniquely marked files to create, rename, move, copy (`Copy to My Documents`), share and delete through available UI controls (folder rename/move/delete via `LibrarySidebar`).
Check the same Document from `My pages` (`Owned by Me`), `Shared with me`, Room and Task bindings.
Distinguish a new copy from another binding to the same Document; compare IDs and fresh content.
Test a denied destination and a deleted source; failed operations must not leave an apparent success or an orphaned visible entry.

Inspect representative PDF, DOCX, XLSX, PPTX, image, text, Markdown, HTML and Mermaid previews where supported.
Compare rendered content with known source facts, including a table/image and a non-ASCII filename.
An unsupported format needs an honest download/unavailable state, not a blank successful preview.
HTML/Mermaid content must not gain parent-page scripting or private API access.
Use existing preview fixtures for deterministic cases and retain one real user open/download per relevant format.
Record unavailable viewers, uncalculated spreadsheet formulas and unsupported rendering explicitly.

## Meeting archive separation

Run [Meetings and personal visibility](#meetings-and-personal-visibility) to confirm hiding removes the meeting from Meetings views while leaving the underlying archive Documents and published Wiki summary intact.
A seeded archive validates browsing and hiding only; actual recording, transcription and recovery use the [Voice recipe](README.md#voice-input-and-recording).
