# Linger verification map

These are natural-language acceptance recipes for a coding Agent acting as the verifier.
The product Agent is the Room member whose behavior is under test.
Each recipe supplies a user goal, prerequisites, observable outcomes, evidence, and existing checks to reuse.
An individual recipe can serve as a `case.md`; maintain its canonical version here.

Read [launch and evidence](../SKILL.md) before execution.
The [product docs](../../../../docs/) and each app's `AGENTS.md` own supported behavior; this map owns how to verify it.
Recipes are definitions, not execution results or claims about an uncommitted refactor.

## Choose the user journey

| User journey                                  | Recipe                                                                   | Existing proof to reuse                                                                                                     | Additional Agent verification                                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in, create a Room, discuss and share     | [Rooms](rooms.md#room-collaboration)                                     | Login, creation, Thread and sharing E2E                                                                                     | A coherent journey with real saved state and access boundaries                                                                               |
| Connect a Computer and obtain an Agent reply  | [Agent entry](rooms.md#agent-entry-and-response)                         | Admission and create-menu unit tests; Runner process tests                                                                  | Actual onboarding, Runtime, model and delivered reply                                                                                        |
| Get Another Me on the first connection        | [Another Me](rooms.md#another-me-on-the-first-computer-connection)       | Online-hook and Another Me integration tests                                                                                | Real pairing creates one Another Me and starter set, then replies                                                                            |
| Move an Agent to a second Computer            | [Move](rooms.md#move-an-agent-to-a-second-computer)                      | None end to end                                                                                                             | First requests after the move each get one reply; verify retained history                                                                    |
| Install, upgrade and remove a Computer        | [Local Computer](local-computer.md#install-and-lifecycle)                | Runner smoke layers, installer and Windows native tests                                                                     | Real installer, enrollment, deletion guards and credential revocation                                                                        |
| Install and pair on Windows                   | [Windows](local-computer.md#windows-install-pairing-and-background-run)  | Windows Go tests and `check-local-computer-windows.ps1`                                                                     | Elevated refusal, pairing, run after terminal close, state after reboot                                                                      |
| Add or change an Agent Runtime                | [New Runtime](local-computer.md#new-runtime-acceptance)                  | Runtime adapter fake-process tests; Runner smoke                                                                            | Every tool class, permissions, complex Tasks and failures against a Claude Code baseline                                                     |
| Install, update and uninstall Desktop client  | [Desktop & Installer](desktop-and-installer.md)                          | `verify-local-client.mjs`, `make check-desktop`, `make check-installer`, `make check-packages`, Windows native ACL/Pi smoke | Real `.dmg`/`.tar.gz`/`-setup.exe` install, Quick Install, updater swap, permissions, uninstall across macOS/Linux/Windows                   |
| Upgrade Desktop from the previous release     | [Upgrade](desktop-and-installer.md#upgrade-from-the-previous-release)    | Resume and local-model restore unit tests                                                                                   | Required for every release and RC: a real previous install, each upgrade path, Quit → Reopen, cold restart                                   |
| Deploy local models and switch to BYOK        | [Local Models & BYOK](local-models-and-byok.md)                          | `verify-local-client.mjs`, `localmodels` Go tests, `byok-endpoint` & Settings › Models unit/integration tests               | Real `localmodels` kit download, GPU/Metal/CUDA load, drive check, BYOK endpoint execution & quit/resume teardown across macOS/Linux/Windows |
| Sleep, wake, crash and quit with local models | [Sleep, wake and quit](local-models-and-byok.md#sleep-wake-and-quit)     | `computer-daemon-lifecycle.test.ts`, gateway liveness Go tests, `verify-sleep-quit.mjs` (frozen process tree)               | Real lid close, Windows sleep, hibernate and Modern Standby, force quit, upgrade then Quit → Reopen                                          |
| Let an Agent use the desktop and a browser    | [Desktop and browser tools](local-computer.md#desktop-and-browser-tools) | Opt-in `Test*Live` Daemon probes; dialog unit tests                                                                         | Model-driven task result; connect and disconnect the user's Chrome                                                                           |
| Stop, reconnect or recover work               | [Execution lifecycle](rooms.md#execution-lifecycle)                      | Runner smoke/soak and process tests                                                                                         | Real-model interruption and visible recovery without duplicate effects                                                                       |
| Stop one Agent's Run                          | [Stop by Run ID](rooms.md#run-status-and-stop-by-run-id)                 | Run controls and run-status transport unit tests                                                                            | Real Run reaches its terminal state; other Runs continue                                                                                     |
| Edit and collaborate on a Document            | [Documents](documents.md#edit-save-and-collaborate)                      | Isolated Document proof and real-service E2E                                                                                | Relevant entry paths, permissions and observed interaction quality                                                                           |
| Ask an Agent to produce a usable file         | [File delivery](documents.md#agent-file-delivery)                        | CLI, Document and attachment tests                                                                                          | Read source, execute tools, publish, open and inspect the actual result                                                                      |
| Edit a Document; notify an Agent by sharing   | [Document access](documents.md#agent-document-access-and-share-notices)  | Document authority, share and list tests                                                                                    | Confirm saved edit, direct Room wake, shared filter, and unchanged access after revocation                                                   |
| Share and revoke an anonymous Document link   | [Anonymous links](documents.md#anonymous-document-links-and-revocation)  | Real-service Document assets E2E                                                                                            | Signed-out read, read-only native content and fresh rejection after revocation                                                               |
| Organize files and find them again            | [Library and search](library.md)                                         | Document asset/preview E2E; Library and search unit tests                                                                   | Cross-entry identity, representative files and authorized search results                                                                     |
| Delegate a Task and inspect its result        | [Tasks](tasks.md#managed-task-and-work-item)                             | Typed-card, Dashboard and TeamHub tests                                                                                     | Direct delegation through execution to a usable Task result                                                                                  |
| Read and preserve shared Task files           | [Shared Task files](tasks.md#shared-task-files-on-a-local-computer)      | Computer projection and recovery tests                                                                                      | Actual executor write, Meta read, restart persistence and scope                                                                              |
| Approve or deny a tool action                 | [Permissions](tasks.md#runtime-permission-decisions)                     | Permission review integration and card tests                                                                                | Actual decision, exact action and resulting business effect                                                                                  |
| Connect an app and use its tools              | [Connected Apps](tasks.md#connected-apps-and-external-tools)             | Apps recipe with simulated supplier; CLI tests                                                                              | Real account, Agent grant, supplier result and revocation                                                                                    |
| Use knowledge across questions and Rooms      | [Wiki and memory](wiki.md)                                               | Memory full-flow run; Wiki UI, SQL, queue and memory tests; answer benchmark                                                | Generated content, attribution and actual memory use                                                                                         |
| Co-edit a canvas and deliver its content      | [Canvas](documents.md#canvas-and-human-edits)                            | Document conflict and canvas UI tests                                                                                       | Preserve Human edits and verify the requested destination                                                                                    |

For a full core acceptance, select the journeys exposed by the target deployment.
For a routine change, select affected journeys and their shared boundaries.
Record disabled capabilities and missing dependencies instead of silently omitting them.
Also exercise [personal meeting visibility](library.md#meetings-and-personal-visibility) and [Pocket Notes/Profile](wiki.md#pocket-notes-and-current-profile) when available.
Voice and proactive behavior have additional recipes below. Supplier events require their own authorized connections; private-chat proactive review is enabled by default.

## Release and release candidate regression

Every Desktop release and release candidate runs the [upgrade from the previous release](desktop-and-installer.md#upgrade-from-the-previous-release) on each shipped target, in addition to the journeys its changes select.
Users only reach a new version by upgrading, and upgrades broke releases that passed fresh-install checks.
A release report without this journey, or with a target marked blocked, does not support publishing that release.

## Capability coverage and entry points

Use this table to reconcile the map with the capabilities in `docs/` and the [README](../../../../README.md).
A recipe row is a test definition, not a passing result. Mark each selected variant in the run report.

| Product capability                 | Required recipe and important branches                                                                                                                                                                                                                                                                         | Conditional dependency                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Room collaboration                 | [Rooms](rooms.md): account/session/settings, Room/Thread, drafts, activity, shares, membership denial                                                                                                                                                                                                          | A second Human for access comparisons                                                                                                  |
| Document and Workspace             | [Documents](documents.md) and [Library](library.md): editing, History, comments, permissions, previews, folders and cross-entry identity                                                                                                                                                                       | Document Runtime; real Agent for comment responses                                                                                     |
| Work Items and Tasks               | [Tasks](tasks.md): ordinary responsibility changes, Dashboard, direct Task delegation, action approvals, state/resumption, Meta delivery, shared files, Routine pause/delete                                                                                                                                   | Real Computer and model for execution                                                                                                  |
| Agent memory                       | [Agent memory](wiki.md#agent-memory-across-rooms): extraction, publication, fresh Room use, correction, isolation                                                                                                                                                                                              | The Agent's online Computer with signed-in Codex or Claude Code; no model gateway                                                      |
| Agent execution                    | [Lifecycle](rooms.md#execution-lifecycle): initialization, queued input, prepared Context update, Stop, interrupted Run and next request                                                                                                                                                                       | Real Runtime; distinguish idle reconnect from interruption                                                                             |
| Runtime and Local Computer         | [Local Computer](local-computer.md), [Agent entry](rooms.md#agent-entry-and-response) and [configuration](rooms.md#agent-configuration-skills-and-deletion): install, enroll, offline, removal/revocation, busy guards                                                                                         | Run native platform checks separately on macOS/Linux/Windows                                                                           |
| Desktop Client and Local Installer | [Desktop & Installer](desktop-and-installer.md): packaged `.dmg`/`.tar.gz`/`-setup.exe` install, Quick Install, Connect to Server, auto-updater, floating voice window, OS permissions, diagnostics, loopback manager CSRF/session auth, port recovery, uninstall and legacy migration                         | Native macOS arm64 (14.0+), Linux x64 (glibc ≥ 2.35), Windows x64 standard user; isolated `LINGER_DESKTOP_USER_DATA` and `LINGER_HOME` |
| Local Models and BYOK              | [Local Models & BYOK](local-models-and-byok.md): `localmodels` kit download/sealing, hardware/drive inspection, library download/cancel/load/Make room/unload/remove, async Pi provisioning, BYOK base URL + path + endpoint, error pass-through, active-Run guard, quit/resume/uninstall teardown, scheduling | Supported Metal (Apple silicon) or NVIDIA CUDA (Linux/Windows) tier for real weights; Computer ≥ 0.56.0 + real/stub endpoint for BYOK  |
| Files, Skill, CLI and MCP          | [File delivery](documents.md#agent-file-delivery), [Skills](rooms.md#agent-configuration-skills-and-deletion), [Connected Apps](tasks.md#connected-apps-and-external-tools)                                                                                                                                    | Exact Skill binding; authorized supplier for external effects                                                                          |
| Personal Wiki                      | [Wiki](wiki.md): source admission, nightly and meeting refresh, preview, publication, grounded and unanswered questions, failed refresh ends, answer benchmark, Notes/Profile                                                                                                                                  | Wiki worker, model, Another Me; a nightly, meeting, mailbox or operator refresh trigger                                                |
| Hardware Voice                     | [Voice](#voice-input-and-recording) and [meetings](library.md#meeting-archive-separation): recording, transcription, Ask → Agent → Task, interruption/recovery                                                                                                                                                 | LiveKit, ASR, microphone/device, configured runtime                                                                                    |
| Voice Mode                         | [Voice](#voice-input-and-recording): continuous dictation, endpointing, one message per turn, stop/restart                                                                                                                                                                                                     | Live media and speech provider; separate from meeting recording                                                                        |
| Global search                      | [Search](library.md#search-and-return-to-context): message/Thread, Document body, Agent, Room, inaccessible/deleted objects                                                                                                                                                                                    | Current searchable content and second identity                                                                                         |
| Canvas                             | [Canvas](documents.md#canvas-and-human-edits): co-edit, Human text preservation, images, draft/send and supplier failure                                                                                                                                                                                       | Gmail test account/object for actual external delivery                                                                                 |
| Proactive reminders                | [Proactive reminders](#routines-and-proactive-reminders): private-chat review, quiet wake, suppression, deduplication, feedback and removal                                                                                                                                                                    | Another Me and a ready Computer; authorized supplier only for app-event variants                                                       |
| User Memory                        | [memory.md delivery](wiki.md#user-memory-delivery-to-another-me): Profile bootstrap, published version, new and existing Context delivery, correction; [nightly maintenance](wiki.md#maintenance-schedule)                                                                                                     | Memory maintenance and Another Me; distinct from Agent memory                                                                          |

Also reconcile Web routes in `apps/web/src/app/router.tsx`: login, Computer connection,
Room, stable Document links, shared Document/history links, Library/Wiki/Wiki preview/Meetings,
Dashboard detail (`/t/:tenantId/dashboard/:workItemId`), Apps, `/oauth/composio-complete`,
and Settings Account/Security/Computers/Models (`/t/:tenantId/settings/models`).
Retired or compatibility aliases (`/t/:tenantId/profile`, `/t/:tenantId/computers`,
`/t/:tenantId/settings/local-models`, `/t/:tenantId/settings/administration`,
`/t/:tenantId/library/my-documents`, `/t/:tenantId/library/shared-with-me`,
`/t/:tenantId/library/documents`, and `/t/:tenantId/library/meetings` without `?entry=`)
must redirect or return the declared unavailable result; do not revive retired features.
There is no standalone `onboarding` route; initial pairing runs through `LocalComputerGate` and Another Me Chat.

For each main journey select the applicable happy path, denied action, invalid input, reload/persistence,
and interrupted/retry path. Reuse current automatic evidence for deterministic branches.
For model/supplier/device outcomes, execute the actual dependency before marking that branch passed.
A release may have documented gaps, but must not relabel a blocked branch as covered.

## One complete core journey

Start with [Agent entry](rooms.md#agent-entry-and-response), then run [file delivery](documents.md#agent-file-delivery).
Use the same disposable Room, Agent, source Document and unique marker throughout.
Ask the product Agent to read the source and publish a report in the Room.
Open the delivered Document as the user, inspect its content, then reopen it in a fresh session.

This joins login, Computer, model, permissions, tools, messages and Documents.
Record each stage separately; an earlier successful reply cannot substitute for a later failed delivery.
The verifier may prepare input data, but must not perform the product Agent's requested work.

## Execute against the selected revision

1. Fix the revision and isolated environment using the parent skill.
2. Confirm current capabilities, entry paths, test registration and runtime prerequisites.
3. Reuse relevant automatic checks, then execute the recipe's additional real journey.
4. Inspect business evidence and record actual outcomes in the existing run report.

Use current labels and object IDs from the target build.
Selectors and commands in these pages are implementation hints, not permanent product contracts.
If an entry moved, update its hint after checking the owning capability document and code.
If expected behavior changed, resolve that difference before redefining the assertion.
Do not restore retired registration, invitations, Human DM, or non-Local Runtime flows from old recipes.

The [E2E registry](../../../../e2e/playwright.e2e-specs.ts) owns spec membership.
Use Playwright `--list` when selecting tests; record actual skips after execution.
Every registered spec runs on real TeamHub, Document Runtime and PostgreSQL.
The repository entry is `make check-e2e` (`pnpm test:e2e`): the config test, then `e2e/playwright.room-document.config.ts`.
`ROOM_DOCUMENT_E2E_SHARD=<n>/3` selects one file shard.
Logout, staying on the login page after reload, and wrong password are in `room-login-chain.spec.ts`.
No E2E covers an Agent reply; that needs a deterministic model gateway that does not exist.
The default `verify.sh` starts real TeamHub, Document Runtime and PostgreSQL.
It does not provide a product Agent, real model, external account or audio service.
When serving built Web assets, verify the build mode as well as the Git revision.
Every E2E build writes production assets to `apps/web/dist`; do not rebuild while a server is using that directory.
Runner smoke/soak uses real local processes with simulated dependencies.
Runner live still simulates TeamHub; a passing command does not prove the complete product journey.

## Conditional journeys

### Voice input and recording

For physical microphone loopback, check the test speaker mute state and restore it after playback. Record the human transcript, distinct agent reply, and inbound/outbound media separately. Report word errors even when transport passes.

Read [Voice](../../../../docs/voice.md).
Reuse the voice unit tests under `apps/web/src/features/rooms`, `make check-voice-runtime`, and the [acceptance prerequisites](../../../../apps/voice-runtime/acceptance/).
Use an actual microphone and the configured speech services for a real audio claim.
Speak a known short phrase; check transcription, one intended message, draft preservation and released microphone access after stopping.
For recording, stop and reopen the actual recording and transcript.
If testing an audio request to an Agent, verify its separate delivered answer or Task result.
Keep audio, transcript, message IDs and visible status evidence.
Start a recording from the sidebar **Meetings** control (`New Meeting` when switching from Live while saving). The production entry selects the Human's Another Me Direct Room (`recording-entry.tsx`).
Keep recording and its final audio, transcript and completion message in that same Room when navigating elsewhere.
On Linger Desktop, verify the floating Voice Mode and Recording window separately ([Desktop & Installer](desktop-and-installer.md#floating-voice-mode-and-recording-window)).
Spoken words are transcription, not control commands: saying "stop" must not stop the recording or silently create a Task.
Submit two different Ask messages. First ask a factual question that only the confirmed transcript answers.
Then explicitly request a background Task with a unique file marker. Correlate the sent receipt with the single private Room message and its recording-context attachment.
Another Me can answer or ask for clarification instead of creating a Task. Record what it actually did. Only mark Task delivery passed after a distinct Task and its usable output exist.
When an Agent was just moved between Computers, test Ask before an ordinary Room turn. A connected Computer does not prove its Agent is ready. Record a subsequent successful retry separately.
Use the recorder's Stop control and reopen the saved transcript.
The service also supports other Agent Direct Rooms. Test that boundary separately from the production entry:
one unavailable Direct Room peer must not block another capture's completion; restoring it delivers exactly one completion message.
Reuse `TestVoiceCompletionRetriesOneRoomWithoutBlockingAnother`; its synthetic media does not prove real audio.
Interrupt the owned network/session and verify the documented local buffering/upload recovery without duplicate transcript or Task.
For Voice Mode, verify endpointing, overlapping draft edits, duplicate events, stop and a subsequent fresh session.
Prerecorded audio can verify provider transport/transcription; it does not prove microphone capture, acoustics or device recovery.
On a remote Compose install, confirm a LiveKit signaling endpoint **and** its advertised media ports are reachable by both the browser and the workers. Test Live only when a live worker has registered. Do not place provider keys in evidence.
When the UI shows Listening without a message, distinguish a live input track, increasing outbound packet counts and audio energy, the server's accepted turn, and a persisted reply. For a fixed audio file, record the distinct Human and Agent message IDs plus inbound audio energy. For a real microphone, test a fresh phrase; a previous file-input reply cannot satisfy that check.
Do not count mocked LiveKit events as actual audio or actual provider transcripts.
If the deployment disables a capability, verify its unavailable state and report the real-audio journey as skipped.

Voice needs `TEAMHUB_VOICE_MEDIA=on` (the default), `LINGER_SECRET_SEED`, and `ffmpeg`/`ffprobe` on `PATH`.
Each feature also needs its provider key: `SONIOX_API_KEY` for recording and dictation, `XAI_API_KEY` for Live.
A key comes from the environment or is saved in the app; an environment key wins and cannot be replaced from the app.
When `voice_available` is true without a saved Soniox key, the Voice Mode button, Pocket Note microphone and Meetings recording control remain visible and open `VoiceKeyDialog` on click; Voice Mode also runs Grok Live with `XAI_API_KEY` alone without Soniox.
Live also needs the `LIVEKIT_*` media service. Live tools such as Slack, documents, routines and Agent creation each need their own connection or permission.

Check the key paths separately:

- Settings → Security → API keys shows the Composio row, plus Soniox and xAI rows only when `voice_available` is true.
- Saving a key in the voice dialog applies without a restart; the voice workers start within seconds. Record the policy read before and after.
- With the key in the environment, the API keys row shows `Set by your server` / `Set with <ENV_VAR> on the server.` and hides the edit button; direct `PUT /v0/voice-provider-keys/{provider}` conflict returns HTTP `409 VOICE_KEY_FROM_ENVIRONMENT`.
- A saved key is shared by everyone on the server and TeamHub currently exposes only `PUT /v0/voice-provider-keys/{provider}` (no public `DELETE` route or UI removal button). Use a disposable test environment/database and never put keys in evidence.

### Routines and proactive reminders

Use the [Routine recipe](tasks.md#routines) for explicit user schedules (including fixed-grid `every_n_minutes` intervals down to 10 minutes with overlap skipping).
[Proactive Another Me](../../../../docs/proactive.md) is always enabled. Do not require an experimental switch or a separate scoring model.
Use a disposable tracked item and one controlled trigger. For private-chat review, record a window of 20 ordinary Human/Another Me messages and the subsequent three-minute quiet period. Hidden wakes do not count toward that window.
Check the quiet clock against the latest ordinary reply from either participant, including before the first wake and a late Agent reply after an earlier wake. Only replies from a Run started by a delivered wake are excluded; steering a wake into an ordinary Run does not qualify. A mixed Human/wake initial input and a Human steer arriving before the reply also keep that reply in the quiet clock. Also assert mixed or Human-steered replies are absent from proactive output records; an earlier genuine proactive reply remains recorded. Retain message timestamps, Run input relations and wake delivery timestamps. Reuse `TestFirstQuietWakeWaitsForOrdinaryAgentReply` and `TestProactiveRecordsOnlyAnotherMesWakeAnswers` for deterministic regression; report live timing separately.
Check the current suppression, deduplication and deletion behavior from the owning feature.
Record the triggering event, actual notification and resulting item state.
A missing supplier connection blocks its event variant, not private-chat review. A synthetic wake is not a real supplier event.
Cover the current private-chat review trigger, app event trigger, pending delay, cancellation,
deduplication, Human feedback and scheduled learning as separate outcomes.
Confirm the actual author, target Room and event source; no unauthorized external message may be sent by a test.
Use deterministic tests for timers and duplicate events, and one authorized real provider event for the complete chain.

## Evidence and coverage limits

Use the existing evidence directory and report; no second test catalog is required.
For each selected journey, record revision, environment, real or simulated dependencies, expected and actual outcomes, and evidence links.
Report passed, failed, blocked, or skipped with a reason.
Separate "documented", "automated", and "executed on this revision" when describing coverage.
Screenshots support visible behavior; persisted messages, files and supplier reads prove the corresponding effects.

Agent verification complements automation where real dependencies, combined journeys or content judgment are needed.
These behaviors can also become deterministic tests when a stable assertion is practical.
Turn repeatable defects into regression tests at the lowest sufficient layer.
Keep scenario descriptions here and test logic in the existing suites.

This map cannot prove every input, role, timing, platform or model outcome.
Select relevant denial, recovery and usability variants according to the change and release risks.
Report untested combinations and output-quality limits; do not infer universal coverage from green commands or completed rows.
External actions require the account, target and authorization for that execution; a recipe itself grants none.
