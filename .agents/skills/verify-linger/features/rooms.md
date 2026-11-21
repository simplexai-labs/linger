# Rooms, Agents and Local Computer

Verify that a Human can collaborate with a working product Agent in a durable Room.
Use the [shared execution and evidence rules](README.md); fixture identities are not real-service accounts.
Current routes use `/t/{tenantId}/rooms/{roomId}/chat`.
Resolve IDs from the owned environment rather than copying sample IDs.

## Room collaboration

**Reuse:** `room-login-chain.spec.ts`, `room-creation.spec.ts` and `room-startup.spec.ts`.
Real-service tests cover login, membership, messages and sharing; Room layout is covered by Web unit tests only.

**Journey:** Sign in through the form, create a Room, and complete or skip the optional member dialog.
Send a unique message, open its Thread, reply, and reopen the Room in a fresh session.
Follow a global-search Thread result back to the same conversation.
For membership or sharing changes, use the corresponding existing real-service scenarios.

**Pass:** The Room survives skipping optional members.
The saved message and Thread reply belong to the expected author and Room.
A search link opens the intended Thread once; closing it stays closed until another user action.
Leaving and rejoining preserve the documented role and delivery boundaries.
A frozen share excludes later messages, and revocation prevents subsequent anonymous reads.
The account model has no public signup, Space invitation, or Human DM flow.

**Evidence:** Keep the visible result and a fresh message/member read with object IDs.
For sharing, retain anonymous before/after reads and the revoked result.
For startup changes, verify draft, focus and composer usability during actual auxiliary-service delays.
Use the parent skill's startup and production-startup recipes for measurements.
Local timing samples do not establish production percentiles.

## Agent entry and response

**Reuse:** Web unit tests under `apps/web/src/features/local-computer` and `apps/web/src/features/rooms` (`agent-admission.test.ts`, `agent-create-menu.test.tsx`).
They cover UI and admission behavior, not complete live inference.

**Setup:** Start the real Agent Service and an owned Local Computer with an authenticated Runtime.
Record Runtime version, configured model and available model identity evidence.
Select a model ID from the actual Runtime catalog; a local routing alias may not be a product model ID.
For source development, `scripts/dev-local-computer.sh` builds the Go CLI and the Go Daemon beside it.
The Daemon also requires its sibling TeamHub CLI bundle and the adjacent Node runtime.
Use the complete Computer bundle or follow the [source-built Computer layout](local-computer.md#source-built-computer).
A ready Runtime catalog proves discovery, not that the business CLI is installed or a Run can execute.
Another Me initialization may need additional configured services; a sidebar name alone is not readiness proof.
A source-built Computer does not prove installation or upgrade of a released package.
Deployment releases come from the `node-services` image through `/install/`; see [Release Versioning](../../../../apps/computer/AGENTS.md#release-versioning).
Record the active bundle `app-sha256` against the deployment target; the package version alone is not upgrade evidence.
The image builds macOS, Linux and `win32-x64` packages; see [Windows install](local-computer.md#windows-install-pairing-and-background-run).
Check current Computer version floors (`0.53.0` single-call stop, `0.54.0` `model_source`, `0.55.0` Pi background Memory/Wiki, `0.56.0` BYOK endpoint commands) and complete Daemon/Runtime Registration identities before driving a released Computer.
The Gateway speaks Runner protocol 2. An older Computer only receives `target_release` and updates itself.
An old Computer or incomplete identity is not a usable execution environment.

**Journey:** Connect the Computer through the product UI.
Create a general Agent through the current creation entry, then open its Direct Room.
Verify Another Me initialization separately when it is part of the requested scope.
General Agent success does not cover Another Me onboarding.
Send a simple request, then mention the Agent from an ordinary Room.
Use the current directory/admission rules to add it; do not seed away the creation or admission step under test.

**Pass:** An unavailable Runtime gives an actionable setup state.
A ready Runtime can execute the request, and the requested reply is delivered to the correct conversation.
Check the expected Agent identity and actual message content, then reopen that message.
A pending approval card, working indicator, or successful Local Run is not proof of the requested reply.
For free-form answers, judge the requested facts and outcome; use exact text only when the request requires it.

**Evidence:** Correlate the Human message, Agent, Room and Local Run with the actual delivered message.
Retain screenshots, relevant public state and model/configuration metadata without credentials or private reasoning.
If testing Agent Instructions, save a change while idle and inspect its effect on a subsequent request.
An old conversation must not count as proof that new instructions took effect.

## Another Me on the first Computer connection

TeamHub creates Another Me in the transaction that records the Computer online with a ready Runtime, a model and a writable workspace grant (`apps/teamhub/internal/agentregistry/another_me.go`).
There is no provisioning job, opening generator or Retry route.

**Setup:** A fresh disposable Human with no Computer, and a Computer with a signed-in Codex, Claude Code, Pi, or Antigravity Runtime.
**Journey:**

1. Before pairing, sign in and confirm `LocalComputerGate` (`Before you start`) overlays the shell outside `/t/{tenantId}/settings/*`; `GET /v0/tenants/{tenantId}/another-me` returns an empty object; recording to Another Me is unavailable.
2. Pair the Computer and start the Daemon. Do not reload by hand; the gate polls `local-computers` and `another-me` every 3 seconds alongside realtime invalidation and auto-navigates into Another Me (`Linger`) Chat once created.
3. In Another Me Chat, send a simple request and wait for the reply. When testing cross-Room handoff, also verify `teamhub room handoff` (`POST /api/agent/v1/room-handoffs`) from a human-initiated direct-chat request.
4. Optional failure branch: make the first creation fail on an owned instance. The Computer must still connect, and a later heartbeat must create Another Me once.

**Pass:** The gate clears without a page reload and opens Another Me (`Linger`) Chat with its template greeting (`Hi <name>, I'm Linger — your personal AI.`) and the profile setup apps card, both read. Placement prioritizes the Computer's installation `preferredRuntime` first and the model with `is_default: true` first (plus `default_reasoning_effort` else first allowed effort).
The starter workspace exists once: Research Analyst, Code Reviewer and a Getting Started Room with the Human, Another Me and Research Analyst. A starter Agent that cannot be placed is skipped and logged.
Repeated heartbeats do not create a second Another Me or a second starter set. The first request gets a delivered reply.
**Evidence:** Agent ID, Chat Room ID, starter Agent and Room IDs, Computer ID, and the reply message ID.
**Reuse:** `apps/teamhub/internal/agentruntimestate/online_hook_test.go` and `apps/teamhub/tests/integration/another_me_test.go`. They use a fixture Computer, not a real pairing.

## Move an Agent to a second Computer

A reported failure mode: the first message after a switch to a second Computer gets no reply, and the second message does. Check both an Agent move and a user continuing from another machine.

**Setup:** Two online Computers of the same Sponsor, both with a ready Runtime. Use an owned General Agent or Another Me with prior history.
**Journey:** Talk to the Agent on Computer A. Open the model button in the direct Room composer. In `Runtime settings`, select Computer B with a writable grant and choose `Move Agent`. Send three short, distinct requests, each after the previous reply. Then ask what its last answer before the move was.
Also run the second variant: keep the placement and continue the same Chat from a browser on another machine.
**Pass:** Each of the three requests gets exactly one reply, in order. The first is not skipped and is not answered later inside another reply. History from before the move stays readable. The Agent CLI credential on A is no longer accepted.
**Evidence:** Placement before and after, message IDs, Run IDs and Run statuses for all three requests, and the Runner removal on A. If the first request has no reply, record whether its Run exists and its terminal state; that separates delivery from wake-up.

## Execution lifecycle

The executor lives in `apps/node-services/src/agent/executor/`: one `ExecutorRegistry` and one `ContextExecutor` per Context.
The hook-order goldens pin feature timing. Before failing a Room Run with `reply_not_sent` or `reply_undelivered`, `RunLoop` confirms persisted replies via `GET /v0/agent-runtime/runs/reply-status`; when a Run definitely never started (`ProviderRunStartError` outside admission unavailability), the failure omits `runtime_type` so Room messages do not name the Runtime. Verify these real-environment branches separately and record their current results in the run report: hot and cold reply, steer, Stop (also while a submit is in flight), native question, approval, Activity and status line, Work Item Task Run, idle park and resume, restart recovery, the next message after a Runtime change, and the Memory context-host path.

**Reuse:** `pnpm smoke:local-runner`, `pnpm smoke:local-runner:soak`, and Node Services Runner process tests.
These cover deterministic lifecycle boundaries with simulated TeamHub or model dependencies.
`pnpm smoke:local-runner:live` uses a real model but still simulates TeamHub.
Check that its fixture implements current callbacks before treating it as a usable live entry.

**Journey:** With the real product stack, send a request and an additional input while work is active.
When cancellation is in scope, stop an owned long-running request and observe its terminal state.
For reconnect behavior, stop and restart the owned Computer.
For service recovery, interrupt only the service started for this run.
Choose the recovery contract for that interruption; not every interrupted execution should automatically rerun.

**Pass:** Accepted inputs are not lost or confused with another Run.
An acknowledged cancellation does not present later work as a successful completion of that request.
Reconnection preserves the intended Computer and Agent identity.
Recovery either resumes under the current contract or reports the actual failure without duplicating business effects.
After recovery, verify a new user request and its actual result.

**Evidence:** Preserve before/after Run identities, accepted inputs, terminal states and output counts. For mid-run corrections, retain distinct Human message IDs, their initial/steer links to the same Run, the applied steer outcome, and the final reply. Select the delivered message by its ID and expected author; the same text may also appear in navigation previews and Activity. Record whether the correction arrived before or during tool execution. A live panel with only a header proves entry and Run binding, not streaming tool progress; observe a later visible event before claiming that branch.
A process reconnect alone does not establish restored model context or exactly-once delivery.
Report idle reconnect and interrupted-execution recovery separately.

### Run status and Stop by Run ID

The Dock reads only pushed Run statuses: the `GET /v0/rooms/{roomId}/run-statuses` snapshot plus `agent_run.status_changed` on `/v0/events` (with a 60-second post-end snapshot reread and `stream.resync` / `resource.invalidated` refreshes). A failed snapshot read retries with 1–30 s backoff.
Stop calls `POST /v0/rooms/{roomId}/runs/{runId}/cancel` for that row's Run only. Finished Runs with unconfirmed follow-ups stay in the Dock as `Needs attention` (`Follow-up delivery unconfirmed`) with a `Resend` button calling `POST /v0/rooms/{roomId}/runs/{runId}/redeliver-unconfirmed-inputs`. Replied Runs re-enter the Dock when a follow-up joins them. The Web keeps no Message receipts and does not poll.
`GET /v0/rooms/{roomId}/active-runs` and `POST .../agents/{agentId}/cancel-messages` are deleted; do not use them as entry points.
Source: `apps/web/src/features/rooms/chat/room-run-controls.tsx`, `apps/web/src/features/teamhub/run-status-transport.ts` and the [Room run-control contract](../../../../contracts/openapi/paths/room-run-control.yaml).

**Journey:** In a Room with two working Agents, wait for the status line to show the chosen Agent and press its named Stop button. Hovering or focusing the line holds that Agent in place. The activity button opens the currently shown Agent's Activity panel; it is not a multi-Agent dropdown. Repeat while that Agent's request is still being submitted. Stop a queued Run. Stop a Run that just ended.
**Pass:** The page shows Stopping for `cancel_requested`, and Stopped for `canceled` or `already_terminal`. The other Agent's Run keeps going. Before stopping, retain one snapshot with both distinct Agent Run IDs active in the same Room. A second accepted message alone does not prove simultaneous execution. Afterward, correlate the canceled Run with its actor, the other Run with its delivered reply, and a fresh request to the canceled Agent with a new Run. A canceled queued Run never starts the provider. Published messages and saved files stay.
While a Run is queued or in its first segment with no activities yet, the Dock shows animated typing dots (`Starting` tooltip), then the Activity title (`Thinking` only when `status === "thinking"` with no title, or `Working` as fallback), and the Agent leaves the Dock on the reply. Interrupted Runs (`failure.code === "interrupted"`, including `process_interrupted` hard kills) render as `Stopped` in the Dock with a warn line (never prefixed with `Run failed:`) and canceled tone in Activity; pre-event aborted Runs show `Run stopped`. Other failures show `Run failed` above the composer only. The Thread and Chat show the same state.
**Evidence:** The cancel request's `runId`, the Run status events before and after, and a fresh `run-statuses` read. A network log with no `active-runs` poll. For a submit-in-flight check, hold the actual POST response after the server commits it, leave Room events flowing, click the visible Stop before releasing the receipt, then release the original response. This proves cancellation while the browser awaits acknowledgement, not every server-side submission race. Do not fabricate a successful response.
**Reuse:** `room-run-controls.test.tsx`, `run-status-transport.test.ts` and `message-timeline-card.test.tsx`. Unit tests do not prove a real Runtime stopped.

## Related UI checks and sources

Reuse existing browser tests for Agent Info tabs, searchable activity, avatars, Room navigation and responsive layout.
A Message activity view must refer to that Message's Run; completed activity is not current live activity. For historical activity, hover a message avatar and choose View activity. Agent Info Details/Routines/Connectors are not the history entry. Select one unique user request, correlate its Run through persisted input/reply evidence and the actual runtime-presentation-events request, then inspect the visible summary. Historical navigation may use `runStatusId` without a DOM `data-run-id` attribute; do not require that optional attribute as the business assertion. With more than ten entries, verify Next has distinct entries and Previous restores the first page. Report live updates and full pagination boundaries separately.
Check Agent removal, Sponsor Direct Room removal and unrelated Room access when changing that lifecycle.
When Computer removal changes, verify the TeamHub API blocks deletion with `409 LOCAL_COMPUTER_HAS_AGENTS` (or `409 LOCAL_COMPUTER_BUSY` during active Operations) while `RemoveComputerDialog` lets users move or delete assigned General Agents inline (hard-blocking only when an assigned Agent such as Another Me has no other target Computer) and successful removal revokes that Computer's credentials.
The Collaboration panel reads the current Room's published `team.md`; fixture rendering does not prove Agent publication.

- [Architecture](../../../../docs/architecture.md)
- [Agent Service](../../../../apps/node-services/src/agent/AGENTS.md)
- [Local Computer](../../../../apps/computer/AGENTS.md)
- [Real Room startup](../../../../apps/web/e2e/room-startup.spec.ts)
- [Real Room creation and sharing](../../../../apps/web/e2e/room-creation.spec.ts)

## Account, session and personal settings

**Setup:** Use disposable Alice and Bob accounts in the isolated database.
Never change a real teammate's password or profile for verification.
**Journey:** Check wrong-password rejection, successful login and return to an authorized deep link.
Change Name, Bio and Organization in Settings → Profile, then reload and read them in a fresh login.
The visible label is Profile; its current route is `/t/{tenantId}/settings/account`.
Upload a supported avatar and cover image; read both after a fresh login.
Check invalid-format and oversized-image feedback, then confirm saved images
remain unchanged. The current page exposes upload/replacement, not removal.
Restore disposable image fields through the account API for cleanup when needed;
do not count that cleanup as a user-facing removal scenario.
In Settings → Security, reject a wrong current password, change the password, then sign in in a fresh browser context.
Check that the old password fails and the new password succeeds. Sign out and revisit a protected URL.
Keep a second signed-in browser context before changing the password. Verify that
the change revokes that other session while preserving the changing session.
The current contract rejects a wrong current password with HTTP 400 and
`INVALID_CURRENT_PASSWORD`; do not mistake that for a successful change.
Restore the disposable account's original password through the UI, then verify
it with a fresh login. If restoration is unconfirmed, retain the temporary
credential only in private recovery storage and report the unresolved state.

**Pass:** The account identity and tenant scope remain unchanged. Saved fields survive reload.
Invalid input does not replace saved state. A signed-out/expired session cannot reuse cached private content.
A return URL cannot send the user to an unrelated external site.
Settings exposes four tabs: `Profile` (`/settings/account`), `Security` (`/settings/security`), `Computers` (`/settings/computers`), and `Models` (`/settings/models`, with `/settings/local-models` redirecting). For local model management, BYOK configuration, and `Runtime settings` links to `Settings › Models`, see [Local Models and BYOK](local-models-and-byok.md).
**Evidence:** Save screenshots and sanitized status/identity reads; never retain entered passwords or session cookies.
**Reuse:** `room-login-chain.spec.ts` (login, return target, wrong password, logout), `apps/teamhub/tests/integration/account_password_change_test.go` (real PostgreSQL password-change persistence, `INVALID_CURRENT_PASSWORD`, session revocation, and rate limiting), and the Settings unit tests; browser E2E does not yet cover password change.

## Agent configuration, Skills and deletion

**Setup:** Use an owned General Agent, a ready Computer and a harmless `SKILL.md` with a unique observable instruction.
Keep Another Me onboarding and Profile generation separate from General Agent initialization.
**Journey:** Save instructions while idle; send a subsequent request and observe the new instruction taking effect.
Upload the Skill through Agent Info → Details → Skills, confirm its exact binding, and ask the Agent to apply it.
Remove that binding, start the next eligible Run and verify the manifest no longer includes it.
Reject an invalid package without leaving a binding. Exercise the documented busy-update refusal with owned running work.
Delete the General Agent after its work stops and reopen its former Direct Room and ordinary shared Room.

Wait for the prior Local Run to become terminal before testing a newly bound Skill. A visible reply can precede Run termination; an immediate next message may become `steer` on that old Run and correctly retain its previous resources. Record the input relation and Run ID before calling a missing Skill a delivery defect.

**Pass:** New work uses the current configuration; already accepted work retains its exact resources.
A prepared but unused Context cannot accept work using a stale profile after another Room initializes it.
Rejected writes preserve the prior configuration. Skill visibility alone is not authorization to business resources.
Deletion removes the Agent and Sponsor Direct history according to the current contract, while unrelated Room history remains. Before deleting an owned disposable Agent, obtain an actual reply in a shared Room. After deletion, use a fresh browser login to compare both Human and Agent message IDs, bodies and authors. Check the same previously accepted Agent CLI credential against the same read-only endpoint: successful before deletion, unauthorized afterwards. Keep any temporary credential outside evidence and remove it after the check. A missing local credential file alone does not prove server-side revocation.
Assigned Agents block Computer removal; successful removal revokes that Computer's credentials.
**Evidence:** Record configuration revision, manifest version, Local Run identity, requested result and fresh removal reads.
**Reuse:** Agent Info/Skill tests, Agent registration integration tests, and Context/first-Session regression tests.

## Conversation navigation and sharing boundaries

Extend Room collaboration with a Thread reply, quoted message, attachment, public reaction and draft retention across rapid Room switches.
Open a search result in its original Thread and inspect its actual Room/message identity.
Check compact and wide layouts, keyboard focus, long messages and image previews on representative content.
Open View activity for the selected message and confirm its Run; default summaries must not expose raw tool arguments.

For a Room history snapshot, use a signed-out browser and prove the snapshot excludes later messages.
Revoke it and verify a fresh anonymous request fails. Do not equate a snapshot with live Room membership or Document download permission.
Check Room messages and their search visibility under a principal without Room access. Test Document access separately; an active Agent retains its Human’s Document access when removed from a Room.
Retain screenshot, share/message IDs, source/snapshot counts and fresh authorization responses.
Do not reintroduce retired registration, invitations or Human-to-Human Direct Rooms.

### Foreground work while background work holds the model

[Model scheduling](../../../../docs/model-scheduling.md) ranks chat above background work on the same endpoint. A Runtime behind a gateway or key starts with one place. Record the Computer version; a Computer before 0.53.0 cannot stop a single background call. Start background Wiki generation on the same Computer as a Direct Room chat. There is no manual refresh; use an operator `memory:wiki-sync` request or a meeting refresh as described in the [Wiki recipe](wiki.md#sources-refresh-and-grounded-answers). Send one request while background work is queued and another while it is in flight. Record separate message, Run, and background start/end times. The chat must start without waiting for the background call to finish; the Computer stops that call and queues it again. After the foreground work ends, verify that the queued background work resumes. Do not infer priority from reply speed.

For a service restart, request one countable effect in an isolated Room. Coordinate effect detection and restart within one harness. Immediately before restart, retain the running Run, first effect, and absence of the final reply; a task that already replied is not an in-flight recovery proof. Stop the Agent Service cleanly during the Run, then restart it. Verify the same Run reaches a terminal success with an incremented attempt count, the native session thread remains unchanged, and a fresh browser sees the unique correct reply. Read the effect count independently. Retain graceful shutdown and requeue events, rather than inferring clean shutdown from an empty container-event history. If the prompt requires checking an existing effect before retry, scope the conclusion to that sample; do not claim universal exactly-once effects. A hard kill is a separate case: capture a running Run without a final reply, force-stop only the owned Agent Service, and restore it. Verify that the old Run becomes failed with process_interrupted without another attempt. Send a fresh user request, verify its actual reply and the unchanged native conversation thread, and independently count prior effects. Report queued-Run continuation separately; it needs a real queued prerequisite. Do not equate a reconnected Computer with a recovered Run.

For queued cancellation, prove the selected Local Run is actually queued before pressing Stop, and retain its unclaimed state after cancellation. Restore temporary environment overrides after each scheduling probe.

Pausing a Computer process is not a reliable way to hold a Room Run queued. The service may report Computer offline before the verifier can operate Stop. Treat failure to observe a queued Run as an unmet test prerequisite, not proof of queued cancellation or a product defect. Always arm restoration before pausing an owned process, coordinate readiness within one harness, and prove a fresh user request works afterwards.
