# Wiki, knowledge quality and Agent memory

Verify what a user or Agent can learn from published information.
A saved source, admitted refresh, preview, published page and useful answer are separate outcomes.
Use the [shared execution and evidence rules](README.md).

**Automated full flow first:** [`lifecycle.ts`](../../../../apps/node-services/scripts/memory-benchmark/README.md)
runs one Human from connect to the second night in process, in product order, on a fixture with known facts, and checks each stage:
the Profile builds memory.md; connected My pages files and a mail initialize the Wiki;
Room chats and a meeting are staged and searchable by day, and the meeting refreshes the Wiki on its own;
each night updates the Wiki, memory.md, the Daily with the Pocket Note, Tracking Items and Monday's Weekly;
a file edit and a corrected preference replace older facts; the Another Me answers eleven known questions.
It takes about four minutes with the LLM gateway and exits non-zero on any failed check.
It does not cover TeamHub admission, publication and queues, the scheduler's timing, retries and offline wait,
the Computer Runtime or the Web; the journeys below do.

## Sources, refresh and grounded answers

**Reuse:** Wiki unit tests under `apps/web/src/features/wiki`, Memory SQL tests and the Wiki request-budget test.
`wiki-home-page.test.tsx`, `wiki-preview-pages.test.ts`, `wiki-profile-editor.test.tsx`, `wiki-refresh-status.test.tsx`, and `wiki-refresh-preview.llm-wiki.test.ts` cover Profile editing, failure banners, and the in-place preview stream.
`personal_wiki_dispatcher_test.go` covers preview storage, `wiki_source_whitelist_test.go` covers file-format source admission, and `mail_wiki_whitelist_test.go` covers mail admission and nightly mail sync.
No browser E2E spec covers Wiki generation; live verification requires an explicitly configured running Web/service environment with a real model rather than the default Document baseline.

**Setup:** Start the actual configured Wiki/Memory services and model dependencies when generation is in scope.
Use the package launcher or the packaged runtime environment; generation runs on the Another Me's Computer, so it needs the agent role in the same process.
Connect an owned Computer with a signed-in Codex, Claude Code, or Pi Runtime (Computer `≥ 0.55.0` for Pi; Antigravity falls back to Claude/Codex) and confirm the Human has an active Another Me registration.
Current refresh admission requires that registration even for an uploaded source.
A missing registration returns 404; inspect the response before waiting for generation.
Record the process time zone. Memory and the Wiki turn the day over at midnight there; Compose containers default to UTC.
Prepare a source with a unique marker and known, checkable facts.
Record the existing published output so an older page cannot satisfy the new refresh.

**When a refresh happens:** Read the scheduled sync in the [Memory README](../../../../apps/node-services/src/memory/README.md).
There is no manual refresh, no Wiki Upload or Refresh control, and no public refresh route.

- My pages edits and uploads, mail text and the 23:30 mail sync only produce and index text. They wait for the nightly refresh at 00:00.
- A recording's final transcript starts a meeting refresh that admits only that meeting's Sessions.
- A connected mailbox's first completed snapshot starts a nightly-kind refresh about one minute later.
- Room messages start no Wiki refresh. A quiet Room's Session is indexed 10 to 11 minutes after its last message and becomes searchable; the Wiki takes it in at night.

**Journey:** Add the source through My pages with Import, drop or New file, then read back that source Document.
Wait until its text is ready; a source whose text is not ready at admission waits for the next night.
Choose one trigger and record it: the scheduled 00:00 refresh, a meeting refresh, a first mailbox snapshot, or an operator request.
For an operator request on an owned environment, run `pnpm --filter @linger/node-services memory:wiki-sync -- --date <date>` in the Memory role's environment.
It sends the same internal nightly request that Memory sends at 00:00.
TeamHub keys its replay by date, the Session set, the current revision and the latest failed refresh, not by My pages changes.
Use a date not yet requested for this Wiki, and require a new refresh ID. A replayed `already_latest` does not admit the new source.
Report an operator request separately from the automatic schedule.
While the refresh runs, open the Wiki tab. It shows `Another Me is writing your Wiki`, and pages written so far appear as cards in their sections; open one.
Then wait for the actual publication within a bounded observation window.
Open the resulting page, ask a question answerable from the source, then ask one the source does not answer.
Published pages are read-only Markdown file Documents; read their actual page body and retain the Wiki revision.
When refresh or failure behavior changes, update the source and exercise the relevant recovery case.

**Source admission:** Add one admitted file and one that the whitelist leaves out, such as a scanned PDF, an image or CSV.
The left-out file must never reach generation: it is absent from the refresh's frozen sources, and `wiki_document_verdicts` gives its reason. The Web does not list left-out sources.
Profile uses the same admission rule; see [Pocket Notes and current Profile](#pocket-notes-and-current-profile).

**Pass:** The source is persisted under the intended identity.
The preview cards are only new or changed pages of the running refresh, each in its own section; a changed page replaces its published card. Publication replaces them; a failed or conflicted refresh removes them.
Preview content is not published content: search and Agent answers must not use it.
New output is attributable to this source and refresh, not merely any existing `wiki_page` binding.
The answer contains the expected facts and usable provenance.
Missing information remains distinguishable from supported facts; a plausible answer alone is insufficient.
Failed refresh does not present incomplete output as a successful publication or erase the previous safe output.
A later successful refresh exposes the updated source content.

**Failed refresh must end:** A refresh that misses a required routed page splits the rejected batch in halves down to one source. A single source that still fails is skipped with a `wiki_sources_skipped` ERROR log, and its frozen version settles with this publication.
The same version is not retried; a new version of that source is processed again. If an update skips every source with no pending removals, the previous version is published again (if removals were pending, generation fails). Initialization with no passing source fails the whole generation.
Memory Session triggers stop after five failed runs of one version with `memory_session_trigger_skipped`.
Source: `apps/node-services/src/llm-wiki/wiki-initialization.ts`, `apps/node-services/src/memory/session-triggers.ts` and the [Memory README](../../../../apps/node-services/src/memory/README.md).
To verify, use one source that cannot produce its routed page and one good source. Observe the refresh that skips it, then at least one later refresh of the same Wiki.
For Session triggers, also observe several quiet-Room cycles of the failing Session.
**Pass:** The good source publishes. The bad source is skipped once and is not admitted again until it changes. No repeating generate-and-correct cycle uses the Computer's model.
**Evidence:** Refresh IDs and dispositions, the skip log entries, `model_call.invoked` counts per refresh and per quiet cycle, and the published revision.
A short local run does not prove the absence of repeated failures over a full day.
**Reuse:** `wiki-initialization.llm-wiki.test.ts` and `tests/memory/session-triggers.test.ts`.

**Evidence:** Keep source ID/version, trigger, refresh ID and state, preview observations, resulting page IDs/versions, representative content and question/answer observations.
Use current public APIs and fresh reads for persistence.
Inspect quality against the known source; avoid asserting exact prose for a free-form summary.
A disappearing progress banner is not completion evidence.

**Windows background generation:** Use the Computer assigned to Another Me. A successful Room reply or Task exercises a different invocation mode and does not prove the Wiki model workspace can write.
If generation returns no pages or repeatedly reports missing target pages, record three observations separately: the provider finished its turn, it wrote the requested files inside the operation directory, and Wiki accepted and published the candidate.
To isolate a write failure, run the opt-in `TestLiveCodexWorkspaceModelInvoke` from the same revision on that Computer, with its actual runtime and a private test configuration.
Require both output files and the outside-directory canary exclusion. Record the returned model, output file names and runtime version.
A completed model call that only describes files in its final answer is a failure.
Passing the probe does not replace publishing and reopening a Wiki page through the product.
Preserve the original result before changing configuration. Keep sandbox restrictions enabled.

## Knowledge quality benchmark (LoCoMo and LongMemEval)

**Use when** a change can move answer quality: Raw staging or indexing, Session facts, knowledge search/read,
the Personal Knowledge policy, Wiki generation, the day read (memory.md and Daily) or memory.md delivery.
A unit test, the full-flow run or one grounded answer cannot show a quality regression; this benchmark compares many known answers.

**Setup:** Follow [the benchmark README](../../../../apps/node-services/scripts/memory-benchmark/README.md):
a disposable localhost `memory_benchmark*` PostgreSQL migrated by TeamHub, and the LLM gateway keys from the root `.env`.
It replays each history day by day through the product code: Room-day Raw, index and facts, then each night's Wiki update and day read,
then indexes the final Wiki and Dailies. Weekly and Tracking Items do not run.

**Journey:** Run the baseline revision and the changed revision on the same plan, arms, models and at least three rounds.
Use `locomo-validate7` as a smoke check that the harness runs on this revision,
then `locomo-amb120` and `longmemeval-third60` for a quality claim.
Choose arms by what changed: `product` (memory.md plus search, what the Another Me has) always;
`search`, `wiki` (Wiki pages and Dailies only) and `memory-md` to locate a change; `none` as the floor.
Pass the baseline run with `--baseline` so the report sets the two side by side.
Reuse a prepared `--state` only when preparation is unchanged (answering, search or the policy changed);
`--skip-nightly` is for search-only changes and allows only `search` and `none`.

**Pass:** The judge passes its known-answer controls, every planned question has an answer or a recorded error,
the report shows no unexplained nightly failures, and `none` stays well below `product`.
A regression is a mean drop larger than the baseline's own min–max spread, per arm and per question type.
Report a difference inside that spread as no measurable change, not as an improvement.

**Evidence:** Keep both runs' `report.md`, `summary.json` and `manifest.json` (revision, dirty hash, models, judge protocol, stages),
and the nightly checkpoints of any failed night.
Inspect a sample of changed per-question JSON files, including tool calls and the judge's reason, before attributing a change.
The benchmark uses the gateway model and in-process Memory and Wiki code; it does not prove TeamHub authorization,
the CLI projection, Runtime cost or latency, time-sliced daytime refresh, or the live journeys above.

## Agent memory across Rooms

**Setup:** Read [Agent memory](../../../../docs/wiki-and-memory.md#agent-memory).
Maintenance always runs on the Agent's own Computer with its Codex, Claude Code, or Pi Runtime and needs that Computer online.
This is distinct from the Human knowledge maintained by the Memory service.

**Journey:** Give one product Agent a durable test convention in Room A.
Extraction runs after every five successful Room Runs of that Agent. Consolidation into memory waits until the Agent has had no Run for six hours, or until a Context compaction.
Wait for that publication evidence, then use the same Agent in a fresh Room B Context.
Ask it to apply the convention without copying that fact into the new prompt or its Instructions.
Provide a correction and check its use after the same update boundary.
For isolation changes, compare a different Agent that has not received the test fact.
Keep the test fact out of all Documents readable by the Agent. Retrieval from a Document is not evidence of memory inheritance.

**Pass:** The same Agent uses the published convention in the new Context.
Current explicit corrections take precedence over stale memory.
Another Agent does not automatically inherit this Agent's memory.
Maintenance failures preserve the previous published state and remain observable.
Do not expect every sentence to become memory or an active Context to restart immediately.

**Evidence:** Correlate Agent identity, source Context, maintenance/publication record, new Context and observed answer.
An existing conversation or a prompt repeating the fact does not prove memory use.
A single successful example does not establish universal recall, privacy or answer quality.

Periodic native Context compaction applies to Codex and Claude Code Runtimes.
The feature owner is `apps/node-services/src/agent/agent-features/context-restart/feature.ts`; reuse `tests/agent/agent-features/context-restart.test.ts`.
A timer unit test does not prove a real Runtime compacted and reactivated its Context.

## Pocket Notes and current Profile

**Journey:** Write and autosave a disposable Pocket Note on **today's** date (`PUT /v0/tenants/{tenantId}/me/pocket-notes/today`), then reopen it; today's note is editable and has no delete action (`DELETE .../pocket-notes/<today>` returns HTTP 400). Using an existing or seeded read-only **past-date** Pocket Note in `All notes`, delete it through its `Delete this note?` confirmation dialog (`DELETE /v0/tenants/{tenantId}/me/pocket-notes/{noteDate}`).
Verify its removal after a fresh read; preserve today's and unrelated notes.
When Profile retrieval is in scope, update a unique fact through `Edit profile` (`?edit=1` → `POST /v0/tenants/{tenantId}/personal-profile/revisions`), `Add source`, or Another Me's `personal-profile` Skill.
Files and the Another AI summary need no connection; an app source needs an authorized connection. Connecting an app alone does not generate a Profile.
Observe the resulting Profile revision and corresponding Raw indexing.
Query from an authorized Another Me Context without repeating the fact in the question.

**Profile source admission:** Profile accepts only material that passes the Wiki source admission rule.
Upload one admitted file and one rejected file, such as a scanned PDF. The rejected file must not contribute facts.
A file whose text is still being normalized makes the generation wait instead of entering unchecked.
Mail enters only when its content hash matches an admitted Wiki source Version for that owner.
With no eligible evidence, the current Profile stays unchanged.
Reuse `personal_profile_supplement_test.go`, `wiki_source_whitelist_test.go`, and `mail_wiki_whitelist_test.go`.

**Pass:** Note deletion affects the selected past date only.
Profile retrieval reflects the current revision after synchronization, without retaining the superseded revision as current knowledge.
Profile Raw indexing does not imply publication into the OpenWiki page graph.

**Evidence:** Keep note date, Profile revision, admitted and rejected source IDs, indexing state and independently checked query results.
Reuse `wiki-profile-editor.test.tsx`, `apps/web/src/features/rooms/pocket-notes/pocket-note-launcher.test.tsx`, and Memory Profile indexing tests.
The UI entry is `apps/web/src/features/rooms/pocket-notes/pocket-note-panel.tsx`.

## Sources and current entry hints

The current Wiki route is `/t/{tenantId}/library/wiki`.
The main route opens Profile by default (with `Edit profile` toggling `?edit=1`). Use the Wiki tab (`?tab=wiki`) for generated collections.
Profile's Add source opens the account source dialog; it is not proof of Wiki publication.
While a refresh runs, the Wiki tab shows `Another Me is writing your Wiki`; after a failure it shows `Wiki update failed` (appending the actionable `failure_reason` suffix when present, such as `— Your Computer was offline.`, `— Runtime sign-in required.`, `— Runtime incompatible. Update your local CLI or Linger.`, or `— Local Runtime is unavailable.`).
Pages being generated appear as ordinary section cards that open on the `/t/{tenantId}/wiki-preview` route; there is no separate preview region.
Do not infer success from a progress message alone.
Resolve IDs from the current run and clean up only its owned Documents and resources.

- [Personal wiki](../../../../docs/wiki-and-memory.md#personal-wiki)
- [Agent memory](../../../../docs/wiki-and-memory.md#agent-memory)
- [Memory README](../../../../apps/node-services/src/memory/README.md)

## User Memory and nightly maintenance

### Maintenance schedule

Memory runs in the process time zone:

- When a Profile revision is published, TeamHub enqueues River job `personal_profile.memory_sync` (1-minute delay), which calls Memory `POST /internal/v1/profile-memory-syncs` to absorb the new revision into `memory.md`.
- At 23:30 TeamHub reads new mail for each connected mailbox. It requests no refresh.
- At 00:00 the nightly run reads the closed day. It proposes `memory.md` edits, runs proactive dreaming, writes the Daily report and Tracking Items, and requests the nightly Wiki refresh.
- Weekly maintenance writes the Weekly report from that week's Daily reports and updates `memory.md` (`syncWeeklyMemory`).

Report each scheduled step separately from an explicitly invoked command such as `memory:daily`, `memory:weekly` or `memory:wiki-sync`.
A missed night is not proved by an explicit command that passed.

### User Memory delivery to Another Me

A Human's memory.md is distinct from an Agent's cross-Room memory and a generated Wiki page.
Use a synthetic Profile fact and correlate its published `user_memory_revisions` version with the read-only projection `memory/me/memory.md`. Do not edit the projection as setup.
In a fresh Another Me Context, ask a question that requires that fact without repeating it in the prompt. Record the identity version and actual answer.
Give an explicit correction in conversation. It applies in that conversation at once; other Contexts get it after the nightly run publishes a new version.
In an already-open Context, verify that the next ordinary input carries `<user-memory-update>` and that the version is acknowledged only after a successful Run.
In a deterministic test (`apps/node-services/tests/memory/user-memory.test.ts`), confirm unsupported quoted evidence drops that Session edit and preserves the previous safe version when no valid edits remain.
Do not count another Agent's memory, a retrieved Document, a reply that repeats the test prompt, or a completed model turn without publication as memory.md delivery.

### Human Memory pipeline

The Human Memory pipeline is separate from Agent memory across Rooms.
Collect an owned, uniquely marked Room/meeting/note source, run the supported Daily and Weekly maintenance, and inspect the stored outputs.
Daily reports live under `timeline/daily/`, Weekly reports under `timeline/weekly/`, and the portrait under `me/`.
Verify current Wiki publication receipts and freshness before treating generated content as available knowledge.
Repeat an unchanged source and check checkpoint/idempotency behavior; change or delete the source and verify the documented reconciliation.
Simulate a provider failure in deterministic tests; previous safe publications must remain usable and retries must stay bounded.

Combine SQL tests with the live source → publication → grounded-answer journey; report each boundary separately.
Retain source hashes, receipt IDs, publication revision, model identity, call count, output checks and failure classification.
Do not include private conversation material or Runtime credentials in shared reports.

### Background recovery and first failure

On the default Compose stack, observe a background call in flight before restarting the isolated Node Services process. Record its identity, restoration or disposition, and the published revision.
Test clean shutdown separately from a forced exit.
Only claim useful recovery if the original work reaches its documented outcome and no duplicate publication appears. An empty queue is insufficient.
Background model calls queue below interactive work and can be swapped out by it; see [Model Scheduling](../../../../docs/model-scheduling.md).

Record the Local Computer OS and runtime. Reopen the published body after reload, follow one citation to its source, then ask one supported and one unsupported question. A completed model turn alone does not prove publication.

Include failure before the first publication. No old Revision exists, and the terminal failure must stop Memory's publication wait instead of appearing as an ordinary 404 until its deadline.
The internal revision read returns 409 `WIKI_GENERATION_FAILED`. An untouched Wiki or a queued follow-up remains unpublished and returns 404.
Reuse `TestFirstWikiFailureReachesPublicationWaiter` and `wiki-publication-wait.test.ts`, then confirm the pending maintenance request progresses on the real service.
This does not prove the underlying generation failure is repaired.
