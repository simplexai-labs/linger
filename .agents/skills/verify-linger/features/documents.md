# Documents and Agent delivery

Verify the content a user can actually reopen and use.
A local file, saved editor state, published Document and delivered Room message are different outcomes.
Use the [shared execution and evidence rules](README.md).

## Edit, save and collaborate

**Reuse:** The parent skill's `scripts/verify.sh` runs the existing direct-link Document proof.
Real-service `room-document-*` specs cover collaboration, comments, assets, Office previews and recovery.
Reuse those assertions before adding manual variants.

**Journey:** Open a native Document (writable active Documents open in Edit mode by default; confirm or switch via `Document mode`) and add a unique marker.
Wait for Saved, then read the same Document in a fresh browser context.
When entry paths are affected, also open it from a Room attachment, the Room sidebar `Documents` launcher (`Files` tab; `UnifiedDocumentSidebar` hides `Comments` and `Table of contents`), and `Library`.
Use two browser sessions of the Space's Human account for concurrent-edit and comment visibility checks (each Space has one Human; `DocumentShareDialog` invites Agents only).
Exercise read-only and denied boundaries on Wiki pages, sent Gmail canvases, anonymous links, trashed Documents, revoked Agent credentials, or foreign Spaces.

**Pass:** Both sessions read the intended persisted content under the same Document identity.
Comments attach to the intended selection and appear in the other session.
For an Agent mention, save the selection, then verify that the Agent receives the comment and replies in that same thread. A visible mention alone does not prove delivery.
For regression diagnosis, `TestDocumentCommentInputEventsSettleWithoutSweep` checks that saving the anchor wakes the queued Run without the periodic sweep.
An active Agent has its Human's access to ordinary active Documents of the Space. A comment mention wakes the Agent; it does not grant access.
Saving an @Agent comment shows no confirmation and creates no share or comment delegation first. See [Comment @Agent mentions](#comment-agent-mentions).
Read-only access remains read-only; denied access does not reveal protected content.
After credential revocation or logout, the old local editor copy must not replay into a new access epoch.
Verify the current unsaved-change confirmation before logging out.
Check that a reopened editor waits for remote state and persistence acknowledgement before showing Saved.
A conflict preserves the newer Human edit instead of silently replacing it.

**Evidence:** Capture the edit, saved state, fresh-session body and relevant Document/comment IDs.
Use a new context because a reload can reuse IndexedDB.
For recovery changes, use the existing offline/restart and permanent-save-failure cases.
Their disposable database does not prove power-loss recovery.

Current UI hints are `Room Document editor`, `Document mode`, `Comments`, `New Document comment` (Edit mode and versioned Documents), and `New selection comment` (Read mode).
The Edit menu item includes a current-mode icon; match the name ending in Edit.
Use the source specs for comment scrolling, toolbar layout, Mermaid editing, selection deletion, HTML import structure preservation (`apps/node-services/tests/document-normalizer/document-html.test.ts`), literal CSV/TSV/XLSX table cells and search flattening (`document-table-literals.test.ts`, `apps/teamhub/internal/document/search_text_test.go`), and descendant ID retention on block replacement (`packages/document-model/src/semantic.test.ts`).

## Agent file delivery

**Setup:** Complete [Agent entry](rooms.md#agent-entry-and-response) with real services and an authenticated Runtime.
Prepare an authorized source Document with a unique marker and known facts, such as A=12 and B=7.
The verifier creates only this input, not the requested output.
When a built-in Skill is under test, inspect its actual binding/version and Runtime availability.
Correct output alone does not establish which Skill was loaded.

**Journey:** Ask the product Agent to read that source and produce a Markdown report in the current Room.
Use the current Agent credential and the `teamhub` business CLI.
Ask it to identify the source, preserve its marker and calculate the total.
Reference the input Document without copying its facts or expected total into the task prompt.
Let the Agent use its real tools and the configured permission behavior.
Open the delivered file from the Room and inspect its body, then reopen it in a fresh session.
For changed Office or PDF behavior, use a representative output and inspect it with an appropriate viewer.

**Pass:** The Agent uses the intended source and produces the requested content.
For this prepared source, both original values and the total of 19 must appear correctly.
Its file is explicitly published as a Document and delivered to the requested Room. A Task executor writes shared files and reports to Meta; Meta publishes and delivers the output.
The user can open the actual published version and read the expected facts.
The file remains accessible after the Agent finishes and the browser session changes.
If a separate text reply was requested, verify that reply independently.

**Evidence:** Link source ID/version, user request, relevant tool outcome, delivered message, output Document/version and inspected content.
A file in the Runtime workspace does not prove product delivery.
An attachment card does not prove readable or correct bytes.
A Run ending successfully does not prove either outcome.
An approval card containing the marker must not satisfy a delivery or reply assertion.
Use [permission decisions](tasks.md#runtime-permission-decisions) if the action waits for approval.

**Reuse:** TeamHub CLI and Document tests cover authorization, publication and deterministic file behavior.
Existing attachment E2E covers user opening and preview.
The additional Agent journey connects those boundaries and evaluates output usefulness.

### Agent Document access and share notices

Use an active Agent and an ordinary, never-shared native Document in its Human's Space. Ask it to read a unique fact and save a unique edit without an approval card. Reopen the Document from a fresh browser session. Verify the revision and actual body.
Compare the target's membership in `teamhub docs list --json` and `teamhub docs list --shared --json`; other shared Documents may already exist.
Share the Document with the Agent from the Human's Share panel. Correlate the share with one hidden mention in the Human–Agent direct Room and its wake. The notice changes the shared filter, not the Agent's owner role or the permission count.
Revoke the share. The target disappears from the shared filter; the Agent still edits it. Verify append and targeted text replacement separately: one successful edit command does not cover another command that returned an error. Include a Document with an attached comment: append must retain the original text, comment thread and selected quote. Reopen it in a fresh browser and verify both the appended paragraph and the original comment. Separately check that removing a Room binding or Task assignment does not withdraw Document access.
Try an ordinary Agent edit on a published Wiki page: it must not persist. The staging generator is a separate exception. With a revoked credential, a trashed Document and a foreign Space, assert rejection without disclosing content. Test anonymous link revocation separately.
Record source, revision, principal, share, notice and Run IDs; distinguish database-backed permission tests from real Agent and browser evidence.
Reuse `TestAgentEditsEveryDocumentItsHumanEdits`, `TestAgentListsEveryDocumentAndSeesWhatWasSharedWithIt` and `TestUnifiedDocumentDirectAgentRolesLeaveAgentAccess`.

### Comment @Agent mentions

Run two entry variants separately: a Room-bound Document opened in that Room,
and a personal Document opened directly from Library without a Room binding.
For the latter, do not add a Room binding or fabricate `current_context` to make
the test pass. Both must create the mentioned Agent's work.
Keep the saved comment, attached anchor, Runtime input and same-thread reply as
separate assertions. A 201 comment response alone proves none of the latter work.

**Implemented:** There are no comment delegations and no Web confirmation. A Human comment, reply or edit can @mention any active Agent of the Space. Saving it queues that Agent's Document Run directly.

**Covered by TeamHub integration and Web unit tests:**

- Standalone Library entry: `TestStandaloneDocumentCommentMentionStartsRun` covers create, reply and first-mention edit without `current_context`, shares or Room bindings. Each saves a Run atomically, blocks dispatch while its anchor is pending, then admits it after attachment. Editing an already-mentioned comment is a separate rejection case: the old comment version returns 409 without overwriting the accepted edit, the same Agent receives no additional input, and the queued Run for the original comment version fails with `document_input_failed` and cannot be claimed, even after anchor attachment.

- Create: `TestRoomDocumentCommentMentionDispatchesAgentWithoutGrant` uses an Agent with no Room membership and no share. One Run is queued. It becomes dispatchable after the anchor attaches. The Agent reads the thread, and the Human sees its reply.
- Reply: a Human reply with @Agent creates exactly one Runtime input. A reply from a second bound Room reuses the same Document Context and queues a second Run.
- Edit: an edit that keeps the same @Agent creates no new Run. If the original Run is still queued, changing its comment invalidates its admission; it does not continue with the edited text. A claimed Run is not canceled by that queued-input cleanup. `TestEditingPlainDocumentCommentMentionsAgentWithoutSharing` adds the first Agent mention by editing a plain comment, then checks the Run for that comment.
- Non-grant: these tests prove dispatch without a grant. The edit test checks that the Document has zero direct-share rows both before the edit and after the Run is queued.
- Invalid actors: an unknown actor returns 400 with no thread, Runtime input or event. An Agent-authored @Agent returns invalid input and creates no Run or Document Context. An Agent reply to an unknown actor fails. An Agent may name its Human for display only.
- Rejections: resolving the thread fails its queued Run. TestHumanDocumentCommentAgentMentionRequiresExactDurableHead covers both Room and standalone entries: a missing durable head returns 400, a mismatched head returns 409, and neither creates a Context or comment thread. Standalone refusals must not invent a Room binding. The conflict fixture uses a sequence one ahead of the current head; it proves exact-head rejection, not every historical revision or edit-after-mention combination.
- Web: `apps/web/src/features/rooms/documents/room-document-mention-composer.test.tsx` posts comment and reply mentions without an authorization step.

Reuse `TestAgentCommentMentionsHumanWithoutRecursivelyInvokingAgent`, `TestHumanDocumentCommentAgentMentionCreatesOneDocumentContextAcrossRooms`, `TestDocumentCommentMentionsRejectUndiscoverableActorWithoutSideEffects`, `TestResolvedDocumentCommentMentionNeverDispatchesAgent` and `TestHumanDocumentCommentAgentMentionRequiresExactDurableHead`.

**Live evidence:** Record outcomes in the run report, not this reusable map. The tests above use a database and service stubs, not a real model. For a live result, save the @Agent comment in the browser and see that no dialog appears. Find the queued Run and the Agent's reply in the same thread. Then check that `teamhub docs list --shared --json` and the Share panel have not changed. Report test evidence and live evidence separately.

### Anonymous Document links and revocation

Create a link through the Document Share dialog and open it in a signed-out browser context.
Verify the actual body and supported access level, then disable the link and repeat the anonymous read.
A native Document exposes read-only Markdown through this route, without an editable collaboration session.
After revocation, a fresh read must reject the old link and withhold the document body.
Retain before/after anonymous responses and screenshots; an already downloaded copy cannot be recalled.
Reuse `apps/web/e2e/room-document-assets.spec.ts` and `apps/teamhub/tests/integration/unified_document_link_shares_test.go`.

## Canvas and Human edits

**Setup:** Use an authorized Room Document and the current supported canvas target.
In Linger the canvas target is a Gmail canvas (`skills/builtin/canvas/1.0.4/targets/gmail.md`). Read the [Documents AGENTS.md](../../../../apps/web/src/features/rooms/documents/AGENTS.md) before selecting the destination.

**Journey:** Ask the Agent to create a Gmail canvas, then edit fields/body as the Human (either inline on `MessageMailCanvas` or in the Mail side panel).
Verify the Mail side panel header shows `Mail` with `Drafting`/`Saved`/`Sent` status (without Document title, author row, `Document mode`, or `Table of contents`) and supports attachments up to 15 MiB via the dashed `+` tile below the body.
Ask the Agent to revise a different part and preserve the Human change; the Agent edits only the Linger canvas and must not call `gmail draft` or `gmail send`.
Close and reopen the canvas; refresh the page and inspect persisted content.
For delivery or decline, use the Human's `Send` (`POST /v0/documents/{documentId}/mail` with `source_digest` CAS) or `Don't send` (`POST .../mail/decline`) controls on the chat card with an authorized Gmail connection ([Connected Apps](tasks.md#connected-apps-and-external-tools)).

**Pass:** The intended new canvas opens without repeatedly reopening after the user closes it.
Human edits survive the Agent's subsequent revision and a fresh read.
Clicking `Send` delivers through Gmail (`TestHumanSendsAGmailCanvasOnlyWhenSendIsClicked`), turns the canvas read-only once `status: sent` syncs (suppressing `Agent is editing…`), and corresponds to an actual provider object with the expected content.
Setting a status field or showing a link alone is insufficient.

**Evidence:** Preserve Document versions, visible edits, `source_digest` conflict/retry outcomes and the provider read when delivery was exercised.
Report local canvas editing and external delivery separately.

## Sources

- [Documents editor rules](../../../../apps/web/src/features/rooms/documents/AGENTS.md)
- [Library rules](../../../../apps/web/src/features/library/AGENTS.md)
- [Agent CLI](../../../../apps/teamhub-cli/AGENTS.md)
- [Executable Document baseline](../document.spec.ts)
- [Collaboration and recovery E2E](../../../../apps/web/e2e/room-document-collaboration.spec.ts)
- [Comments E2E](../../../../apps/web/e2e/room-document-comments.spec.ts)
- [Attachments and previews](../../../../apps/web/e2e/room-document-assets.spec.ts)
- [Frontmatter E2E](../../../../apps/web/e2e/room-document-frontmatter.spec.ts)
- [Office preview entry E2E](../../../../apps/web/e2e/room-document-office-preview-entry.spec.ts)

## History, comments and concurrent changes

**Setup:** Use a disposable native Document, two authorized Human sessions and a real Agent for the comment-response variant.
**Journey:** Save a marked edit, make a later edit, open `More Document actions` → `Page history`, toggle `Highlight changes`, and restore the selected earlier checkpoint with `Restore checkpoint`.
Add a comment and reply, resolve/reopen it where supported, then address a comment to an authorized Agent.
Observe that Agent's actual response or edit and reopen the same Document from Room and Library.
For a concurrent edit, retain one Human edit while another session or Agent changes a different part.
For a stale whole-document replacement, verify the version conflict and retained local change rather than force-overwriting it.

**Pass:** History identifies the selected revision; restoration creates the contractually required current state without erasing history.
Comment work uses the Document's permissions, not arbitrary Room access. The answer is attached to the intended comment/Document.
Unrelated Human changes survive; denied or conflicted changes do not silently overwrite current content.
Revoking a share or removing a Room binding does not fence the Agent or withdraw its edit access. Revoking the Agent or trashing the Document denies fresh content access.
For a trash-access comparison, first make the Agent fetch the disposable
Document with the current `teamhub docs get <documentId> --json` command and
read its downloaded content. Delete it through the Human UI (`More Document actions` → `Delete` → `Delete Document?`, which notes it cannot currently be restored from the product), then request a new
`docs get` in a new Run. Require an explicit server `not_found` or `forbidden`
result; a CLI usage error, connection failure or an Agent's claim is not proof.
Do not read a previously downloaded copy as the fresh-access check. Trashing
the server Document does not promise to erase old downloaded files or memory.
**Evidence:** Keep Document/revision/comment IDs, before/after content and separate session reads.
**Reuse:** Real Document E2E, Document comment integration tests, native mutation/History tests and runtime concurrency tests.

### Comment anchors in multiple bound Rooms

Bind a native Document to two Rooms. Open both views, comment on a selection, then remove the selection and save. Without reloading, check each Room for the changed thread. Count the new `document.comment.changed` events per Room and associate them with the actual edit. Separately exercise delayed attachment of an Agent mention when the initial job has already run (`TestDocumentBodySaveAttachingAThreadWakesItsCommentRun`). Prove the Agent's comment Run wakes without relying on the periodic scan. Evidence: Room, Document, thread and Run IDs, event sequences, and both open views.

Distinguish anchor reconciliation from ordinary comment creation or reply. TeamHub emits a Room event for each active bound Room when a saved body attaches or orphans a thread. Ordinary comment writes emit `document.comment_updated`; a Room-context event is conditional. A standalone comment need not fan out Room events. Reuse `TestUnifiedDocumentCommentsFollowCurrentBindingUnion` for ordinary writes, but do not count it as the two-Room anchor UI proof.

Initial attachment already emits `thread_reanchored` in each bound Room. Capture the post-attachment baseline before deleting the selection. Assert an additional event per Room together with the persisted `orphaned` state; attachment events cannot prove removal.

For documents with anchored comments, raw block operations must fail without changing the body or comment references. Use native `docs update --command append` for a supported tail append. Title changes remain allowed. Reuse `packages/document-model/src/native-edit.test.ts`; do not equate a guarded rejection with successful block editing.
