# Tasks, decisions and external actions

Verify responsibility, execution, approval and business effects as separate facts.
Use the [shared execution and evidence rules](README.md).

## Managed Task and Work Item

**Reuse:** TeamHub Task delegation, lifecycle, approval and authority integration tests; Web background-task and Task-sidebar component tests. These do not prove live model execution.

**Setup:** Use a ready Agent in a Room Meta Context and its own AlterEgo on the same Computer. Start with the Agent's actual Direct Room, then cover ordinary Rooms separately. Confirm the current CLI inventory and permissions. Use disposable inputs and a checkable output.

**Journey:** Ask Meta to delegate a bounded task through `teamhub task create --name --requirement`. Creation starts the Task directly; do not look for the retired Task-creation approval card. Confirm the Task's origin Room, Work Room and executor. While it runs, send Meta another message and inspect the background-task indicator.

Put the marked-file requirement and self-contained final report into Meta's `task create --requirement`; the Human does not message AlterEgo in the Work Room. The file belongs under `./playground/<taskId>/`. Verify the Task becomes idle. Read the actual final report from `task check` or the persisted Task callback record, then verify coordinator delivery separately from Meta's visible paraphrase. Ask Meta to read the shared file and publish the requested Document into the origin Room. Open that delivered version in a fresh browser session. The verifier must not copy or publish the file for Meta. To prove shared-file reading rather than a paraphrased callback, let the executor generate a fresh harmless marker in the file and return only its path and hash. Compare that hash with an independent file read and the published content. Correlate the coordinator Context with its native session and selected tool-call results; Agent actor identity alone does not distinguish Meta from AlterEgo. Never retain model reasoning or credentials as evidence.

Exercise `task send` on an idle Task and confirm the same Task resumes. For a separate long-running Task, use `task stop`; verify cancellation, preservation of its files and successful later resumption. Before stopping, prove both the Task and its participant Run are running and retain an existing harmless file. If testing prevention of a delayed write, observe beyond its original scheduled time before resuming, so a late effect cannot be hidden by the next task. Keep the canceled-state evidence separate from resumed-state evidence. Verify the old Run stays canceled and a new Run succeeds within the same Task; do not infer termination of arbitrary OS child processes from these states. Check a failed execution separately from a canceled one. The five execution states are running, waiting_for_approval, idle, failed and canceled; idle is not an irreversible completion state.

**Task Context guard:** With the Task target, AlterEgo cannot create another Task, send Room messages or publish a new Document. Record the target and the explicit Task-context rejection; absence of an effect alone is insufficient. Meta and AlterEgo share an Agent credential, so this Context guard is not isolation between identities. AlterEgo reports to Meta and writes shared files. Tool, connector and connection-authorization approvals still apply to individual actions. Record the actual card destination, including the Sponsor Direct Room when the applicable contract falls back from the origin Room. Deny one harmless action before its expiry and verify both a persisted denial and no effect. Distinguish an expired card from a denied one. Approve a separate exact action and verify its effect and continuation. Do not confuse these cards with Task-creation approval. See [Document access](documents.md#agent-document-access-and-share-notices).

**Pass:** Meta delegates without a creation decision, remains responsive, receives the correct final report and delivers the actual requested output. Task state, coordinator delivery, shared files and published Documents agree. A Run's success or the last visible Room message alone does not establish Task delivery. An ordinary Work Item assignment, comment or status change does not automatically start a Local Run.

**Evidence:** Retain Task ID, origin Room, Work Room, Agent and Context identities, state transitions, final reply, shared-file hash and published Document/version. Read the current Task check result and persisted state; do not use retired Candidate or `task finish` APIs. Capture background activity while it exists, since the indicator disappears when nothing is running.

The current behavior is described in [Task Delegation](../../../../docs/task-delegation.md).

## Task claim wakes and eventual delivery

Commits and due times wake the Task Worker and River; neither polls on a short interval.

**Reuse:** These tests cover the deterministic boundaries:

- `apps/teamhub/tests/integration/task_claim_wake_test.go`: `TestTaskClaimWakesAndNextClaimDelay`, `TestTaskClaimableHintsFollowClaimableTime`, `TestParticipantRunTerminalMakesRunningTaskClaimable`, `TestNonTaskRunTerminalEnqueuesNoTaskJob`, `TestParticipantRunsTerminalEachEnqueueTaskJob`, `TestTaskArchiveAndParticipantRunFinishDoNotDeadlock`, `TestScheduleReconcileKeepsTaskMadeDueDuringLease`, `TestScheduleReconcileAfterHeartbeatOutlastsClaimLease` and `TestTaskReconcileIsCappedAtAttemptDeadline`.
- `apps/teamhub/tests/integration/river_due_notifier_test.go`: due time, recent-due recheck, step spacing, job finish and `TestEnqueueDocumentTextSyncNotifiesIndexing`.
- `apps/teamhub/internal/realtime/notification_test.go` (`TestDecodeNotification`) for the hint shapes.
- `apps/node-services/tests/agent/task-manager/task-worker.test.ts` (`Task Worker idle loop`), `teamhub-task-worker-client.test.ts`, `apps/node-services/tests/agent/agent-features/inbox-source/teamhub-agent-wake-stream.test.ts` and `apps/node-services/tests/agent/bootstrap/bootstrap-run-wake.test.ts`.

**Journey:** Use the [managed Task](#managed-task-and-work-item) setup with an idle deployment.
Delegate a short Task through Meta and let the AlterEgo Local Run finish.
Record the Run's terminal time, its `task_execution.participant_run_finished` River job, the Task's next claim and Meta's delivery.
Then restart the Agent Service while a Task runs; the stream's opening `reconcile` must resume claiming. Coordinate an observable first file effect with the restart, and record the exact AlterEgo Run before shutdown. Verify graceful requeue, the same Run with an increased attempt count, the same native session, Task idle, and the delivered coordinator result. Keep Worker start, Run start, Task state and message timestamps separate. Without the actual claim response, do not report its delay header or exact claim latency as measured. A prompt that avoids repeating an existing effect proves that sample only.

**Pass:** A terminal participant Run makes its running Task claimable without waiting for the 60-second reconcile.
Each terminal Run enqueues one job; a non-Task Run enqueues none.
The Task reaches idle and Meta delivers the final report once.
After a lost hint or restart, the Task is still claimed within the Worker's 60-second cap.

**Proof boundaries:** The TeamHub tests use real PostgreSQL and TeamHub HTTP; they drive the Run through test helpers.
They do not run the Agent Service, a Computer or a model. The Node tests use a fake TeamHub.
No existing test joins a terminal Run to Meta's delivered report; only a live run proves that chain.
Observed latency is evidence, not a contract. A River job due in under 5 seconds can start up to about 5 seconds late.
A new Agent Service against an old TeamHub gets no hints and claims once a minute; record the TeamHub revision.

**Evidence:** Retain Task, Run and River job IDs with timestamps, the claim response's `Task-Next-Claim-Delay-Ms`, the Task state transitions and the delivered message ID.

## Shared Task files on a Local Computer

**Setup:** Read [Task Delegation on the computer](../../../../docs/task-delegation.md#on-the-computer).
Confirm each claimed behavior in the selected source and run.
Use one Agent's source-Room Meta and Task executor on the same owned Computer.
Shared Task files live on that Computer; cloud volumes and mixed placement are outside this scope.

**Journey:** Ask Meta to include a uniquely marked report under `./playground/<taskId>/` in its Task requirement.
Ask the source-Room Meta to read that exact path without copying the contents into its prompt.
For an active-work test, ask Meta to send the update requirement through `task send --steer` while the Task runs, then read the executor's updated file from Meta. The verifier must not edit the file itself.
Restart the owned Computer or release/rebuild the Context, then read the same file again.
Check that another Room or Agent does not receive this Task's projected entry.
Before a Computer restart, record that no owned Run is active, the daemon PID,
the file hashes and actual playground links. After restart, verify the new PID,
preserved hashes and an actual Meta file read followed by a fresh-browser reply.
Map each inspected workspace to its persisted Context identity; directory names
alone cannot prove Agent or Room scope. Compare source Meta, both Task executors,
another Room of the same Agent and a different Agent. A daemon restart does not
prove Context deletion or full workspace cleanup. The cleanup invariant is preservation,
not deletion of shared Task output. `TestForgottenAgentAndGenerationCleanupKeepSharedTaskFiles`
exercises Agent forgetting and generated-directory removal against real files and links.
Record that deterministic proof separately from a live Context release. Automatic Task-file
garbage collection is outside this feature scope; do not invent it as a passing cleanup criterion.

**Pass:** Both authorized Contexts resolve the same authoritative Task files.
New Task entries appear in an already-running Meta; updates remain visible and Context cleanup preserves the files.
The verifier does not copy files between Contexts to make sharing pass.
Shared files are not automatically published Documents or Room messages.
Local links do not provide operating-system isolation from other processes under the same account.

**Evidence:** Retain Task, Agent, source Room, Context identities, actual file paths/content hashes and before/after reads.
Resolve `agent_management_id` from the current registration when inspecting physical paths; the public Actor ID is a different identity.
Separate file sharing, mid-run visibility, persistence, projection scope and final delivery results.
Reuse `apps/computer/local-daemon/internal/linger/context/shared_task_test.go` and `apps/teamhub/internal/agentruntimestate/shared_task_scope_test.go` for deterministic path, rollback and scope boundaries.

## Runtime permission decisions

**Reuse:** TeamHub permission-review integration tests and typed-card UI tests.
Use real TeamHub for an actual permission claim; a fake callback returning allow cannot prove the policy.

**Setup:** Record the deployed `TEAMHUB_PERMISSION_REVIEW` value. It is opt-in and defaults to false; a disabled judge does not install the Runtime permission hook. Report enabled-judge approval/denial scenarios as not executed on that deployment, rather than treating missing cards as failures. Connector write confirmations and deterministic Task-target guards are separate mechanisms and do not require this flag. Never silently change the deployment default to satisfy a test.

**Journey:** Request a harmless, explicit action in the owned test workspace and a reply in the current Room.
Keep the actual configured permission behavior enabled.
If an expected approval is part of the scenario, inspect and decide that exact card under the user's authorization.
For a denial check, deny a separate action and verify that it produces no corresponding effect.

**Pass:** Distinguish allow, deny, pending approval and unavailable service.
Only the permitted action executes, under the approved scope and exact-action semantics.
A denied or pending action is not completed through a different route.
Submitting the same public Decision again with its old card version returns 409.
Verify that it creates no duplicate grant, completion receipt or business effect.
Do not expect replayed 200 responses for Human Decision submissions.
A tool succeeding does not prove the final Room reply was delivered.
For the expected reply, verify the author and ordinary body; card titles and serialized JSON can contain the same marker.

**Evidence:** Link the action and decision to its actual tool result and business effect.
Record both requested and returned permission-model identities when exposed.
If they differ, identify the discrepancy and limit any model-specific claim.
An unavailable service or missing fixture route is not a policy denial or a passing permission test.
The verifier must not disable review, fabricate allow, or silently approve a card to satisfy an unrelated success criterion.

## Connected Apps and external tools

**Reuse:** `VERIFY_CONNECTED_APPS=1 .agents/skills/verify-linger/scripts/verify.sh`.
It verifies real TeamHub persistence with simulated Composio/OAuth.
The parent skill also documents the existing Connector CLI proof and its manual browser handshake.
Neither proves a real supplier account was used.

**Setup:** For a real claim, identify the authorized supplier account, Agent grant and allowed target/action.
Use the current provider and tool prerequisites from the [TeamHub CLI README](../../../../apps/teamhub-cli/README.md).
The Connectors page (`/t/{tenantId}/apps`, nav label `Connectors`) renders the 16 grouped managed apps from `apps/web/src/features/apps/app-groups.ts` (backed by the 18-app catalog in `apps/teamhub/internal/externalsource/catalog.go`, omitting `googledrive` and `facebook` unless already connected), filtered by category tabs and a `Connected only` toggle.
It has no search box, provider toolkit sync or paginated catalog; GitLab and HubSpot are not offered.
Connecting needs a Composio API key from `COMPOSIO_API_KEY` or saved in the Connectors setup modal or `Settings → Security → API keys`.

**Journey:** Connect the account from the app's card through the provider popup.
Pending authorization reconciles immediately when the popup lands on `/oauth/composio-complete` (`POST /v0/external-connection-completions`), with a 5-second fallback poll for the first 3 minutes and a 1-minute poll thereafter.
The first active connection grants only the owner's active `anotherme` Agent(s) by default; general Agents are not auto-granted and require an explicit grant or authorization card.
Inspect and change Agent grants in `Agent info` → `Connectors`; the Connectors manage dialog has no Agent grant section (it does own `Auto reminders` for app-listening triggers).
Ask the product Agent for a bounded read of a known supplier object.
Gmail, Outlook, Slack, Google Calendar, Notion, Google Drive, Figma and GitHub have dedicated `teamhub` commands, and `fal` / `higgsfield` use `teamhub image-gen` and `teamhub video-gen`; other apps use `teamhub apps search` and `teamhub apps execute`.
An Outlook Calendar connection exposes only calendar tools; Outlook mail tools under it return `tool_not_found`.
If a draft or write is explicitly in scope, perform that exact action and read the resulting object through the supplier.
Confirmation-class writes wait for the Sponsor's card; see the [TeamHub CLI README](../../../../apps/teamhub-cli/README.md).
Revoke the relevant Agent grant or disconnect the disposable account, then verify that access is no longer usable.

**Pass:** The intended account and Agent grant are used.
The result matches the real supplier object, not a simulated provider response or the Agent's unsupported statement.
No action occurs before required authorization.
Revocation prevents subsequent access under that grant.
When retry/deduplication is in scope, verify resulting object counts as well as returned operation IDs.

**Evidence:** Keep grant state, tool identity, provider object ID and an independent provider read.
Redact credentials and private account data from shareable reports.
Report app availability, OAuth, tool execution and external write as distinct outcomes.

## Routines

**Reuse:** `room-routines.spec.ts` covers persisted Routine selection, reopening, editing and one firing through real services.

**Journey:** In an owned environment, create a safe bounded schedule using the current Routine UI (`Agent info` → `Routines`) or authorized tool (including fixed-grid `every_n_minutes` intervals down to 10 minutes with overlap skipping).
Reopen it, change it, observe the intended firing, then disable or delete it.
Check timezone and target Room when scheduling behavior is affected.
Exercise the `Upcoming` (enabled one-time schedules), `Recurring`, `Paused` and collapsible `Done` (elapsed one-time schedules) groups.
Pause or enable a Routine, use Undo within the displayed five-second window, and verify the persisted state.
Delete a disposable editable ordinary Routine from inside its `Edit routine` dialog and reopen the list (only non-editable `every_n_minutes` Routines expose a row-level `Delete routine` button).
App-listening triggers are not listed inside `Agent info` → `Routines` in production; toggle them via **Connectors** (`AppManageDialog` → `Auto reminders`) or `teamhub apps auto-reminders list|set`.

**Pass:** Saved configuration matches the user's intent.
The observed event fires under the current schedule without duplicate business effects.
No new scheduled firing occurs after the disable or delete takes effect.
Judge already accepted work separately under the current cancellation contract.
Observe the requested Agent result separately from a successful trigger.
An effective Agent-targeted instruction enters its Inbox without a Human timeline message.
When an Agent-created Routine targets itself, the wake message uses an eligible Human author;
it must still target that Agent and stay out of the ordinary Human timeline.
Human repeated creation can create a second Routine; do not call that a scheduler duplicate.
Agent CLI retries with the same invocation ID must not create a second Routine or a second wake.
Separately prove competing scheduler jobs for one occurrence produce only one firing.
A reminder without an effective Agent target remains visible; verify the current sender and target separately.

**Evidence:** Retain Routine identity, schedule/timezone, trigger event, resulting Run/message and disabled/deleted state.
Default-on proactive review and supplier-dependent event variants have separate prerequisites in the [map](README.md#routines-and-proactive-reminders).

## Sources

- [Task Delegation](../../../../docs/task-delegation.md)
- [TeamHub ownership](../../../../apps/teamhub/AGENTS.md)
- [Permission integration tests](../../../../apps/teamhub/tests/integration/runtime_permission_review_test.go)
- [Routine E2E](../../../../apps/web/e2e/room-routines.spec.ts)

## Ordinary Work Items and Dashboard

**Setup:** Use two disposable members, a source Room, and a normal Work Item rather than a managed Task.
The Dashboard (`/t/{tenantId}/dashboard/{workItemId}`; there is no bare `/dashboard` route) is a read surface. Create, assign, comment and change status through the public Human API (`/v0/tenants/{tenantId}/work-items`, `/v0/work-items/{workItemId}*`) or internal Agent Service API (`/v0/agents/{agentId}/work-items*`, which has no Agent assignment-update endpoint).
Do not report an API mutation as a UI edit or invent a Dashboard editing control.

**Journey:** Create an item with a unique title; assign it, add a comment and advance its status.
Open its Dashboard link, apply the Room filter, reopen the item and inspect the current responsible member and status.
Compare a second Human in the same Tenant: direct reads and Human Work Item commands remain allowed. Compare the personal Dashboard projection (`?scope=personal`) separately; absence there is not denied access (record if `scope=personal` unexpectedly returns all Tenant items as a backend defect). Use a different Tenant for a Human denial and require not found without record disclosure. Separately test an Agent with no assignment, creator grant, description/comment reference grant, or explicit grant.
Archive only the owned item through its supported operation.

**Pass:** Responsibility, status and comments persist without automatically creating a Local Run or a Task Room.
For Agents, Room membership alone grants no Work Item permission; the reverse is also true. Human authority comes from Tenant membership, not Room membership.
Task result links and ordinary item links resolve to their own identities.
A missing item or denied link gives the actual unavailable state, not another item's cached details.

**Evidence:** Retain mutation receipts, item IDs, before/after execution inventory, two identity reads and Dashboard screenshots.
**Reuse:** `apps/teamhub/tests/integration/work_item_test.go`, `apps/teamhub/tests/integration/work_item_comment_agent_test.go`, `apps/teamhub/internal/app/contract_routes_test.go`, and `apps/web/src/features/work-items/work-items-page.test.tsx`.

## External action failure and recovery

Extend Connected Apps and Canvas with an owned supplier object and an independently observed final effect.
Test cancellation before authorization, revoked/expired grants, a supplier rejection, and retry after a transient failure.
For a send/write operation, count final supplier objects; a timeout does not permit blind resend.
Inspect partial success and idempotency according to the connector's contract.
Keep provider request/result identities and a fresh supplier read, with tokens and unrelated account data redacted.
A simulated provider proves only the integration boundary; actual OAuth, drafts and delivery remain separate results.
