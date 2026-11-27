---
name: delegated-task-approvals
description: Formally model-check TeamHub's Delegated Task (AlterEgo) and Connector Write approval coordination protocol using TLC (TLA+). Use before or after changing decision creation, approval/denial/expiry, decision.run execution or retry/rescue behavior, stopped-task approval expiry, delegated Task stop/resume, or Attempt reconciliation in apps/teamhub.
---

# Delegated Task & Approval Decision Formal Verification

This skill checks every interleaving of TeamHub's PostgreSQL transactions and
River workers for a delegated Task (AlterEgo) that opens `connector_write`
approval cards. Hand-written integration tests exercise happy-path sequential
orders; TLC exhaustively explores concurrent approvals, denials, expiries, Task
stops and resumes, Attempt reconciliation, worker timeouts/crashes, and River
job rescues.

## When to use this skill

Run this check whenever a change touches any file in the [coverage record](#coverage-record)
below, or adds a new path that mutates `decisions` (for `connector_write` or
delegated Task approvals), `work_items.task_execution_status`, or the River jobs
`decision.run`, `decision.expire`, and `task_delegation.expire_stopped_approvals`.

Check whether covered files drifted since the last sync commit:

```bash
git diff 43c02e4bf47ab271a4881a00906e4fabc49fc6ec..HEAD -- \
  apps/teamhub/internal/typedcard/decisions.go \
  apps/teamhub/internal/typedcard/decision.go \
  apps/teamhub/internal/typedcard/decision_connector_write.go \
  apps/teamhub/internal/typedcard/decision_connection.go \
  apps/teamhub/internal/typedcard/alter_ego_approvals.go \
  apps/teamhub/internal/app/decision_workers.go \
  apps/teamhub/internal/app/alter_ego_card_workers.go \
  apps/teamhub/internal/app/contract_server_agent_connector_confirmation.go \
  apps/teamhub/internal/agentconnectedapps/confirmation.go \
  apps/teamhub/internal/taskdelegation/manage.go \
  apps/teamhub/internal/taskdelegation/room_cancel.go \
  apps/teamhub/internal/taskexecution/delegated.go \
  apps/teamhub/internal/taskexecution/attempt_reconcile.go \
  apps/teamhub/internal/store/queries/task_delegation.sql
```

If any of those files changed (or your current diff changes them), inspect the
diff against [the TLA+ model](model/DelegatedTaskApprovals.tla) before trusting
a pass.

## Run the check

Run all six invariants across the full reachable state space from the repository
root:

```bash
.agents/skills/delegated-task-approvals/scripts/check.sh
```

The script pins `tla2tools.jar` `1.7.4` (TLC `2.19`) and verifies its SHA-256
checksum (`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`). It
uses `java` from `PATH` (or `JAVA_BIN`) and caches the jar at
`${XDG_CACHE_HOME:-$HOME/.cache}/tla2tools/1.7.4/tla2tools.jar` (override with
`TLA2TOOLS_JAR`). On a cold machine without the cached jar, the first run
downloads `tla2tools.jar` from the official TLA+ GitHub release.

Useful flags:

- Check a single invariant (with `TypeOK`):
  ```bash
  .agents/skills/delegated-task-approvals/scripts/check.sh --invariant AtMostOnceExecution
  ```
- Run TLC once on [the full config](model/DelegatedTaskApprovals.cfg) including
  deadlock checking (stops at the first violation):
  ```bash
  .agents/skills/delegated-task-approvals/scripts/check.sh --combined
  ```

Read every TLC result with the pstack `/statechart` skill against
`model/DelegatedTaskApprovals.tla` and `model/DelegatedTaskApprovals.cfg`. It
turns each invariant violation into its shortest path in plain words and, once
all invariants pass (or on a reduced bound), draws how the system moves between
states.

## Properties checked

| Invariant                                   | Promise (plain words)                                                                                                                                                                     | Harm if broken                                                                                                        | Baseline at `43c02e4b`            |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `NoUnapprovedExecution`                     | An external connector write executes only after explicit sponsor approval.                                                                                                                | Linger sends an email, chat message, or external write the user never approved or denied.                             | **PASS** (49,827 distinct states) |
| `AtMostOnceExecution`                       | An approved connector write executes against the provider at most once, even across worker crashes, timeouts, and River retries or rescues.                                               | Linger sends duplicate emails, Slack messages, or external mutations on retry.                                        | **PASS** (49,827 distinct states) |
| `TerminalDecisionImmutable`                 | Once a decision reaches a terminal status (`succeeded`, `failed`, `unknown`, `denied`, `expired`), its status never changes again, and a dispatched write never ends `pending`/`denied`.  | The confirmation card or Agent notice contradicts what happened externally.                                           | **PASS** (49,827 distinct states) |
| `CanceledTaskStaysCanceledUntilMetaResumes` | Once a user or Meta stops a delegated Task, it stays `canceled` until the Meta explicitly sends a resume message; approval answers, expiries, or in-flight `decision.run` notices do not. | A Task the user explicitly canceled silently starts running again on its own.                                         | **PASS** (49,827 distinct states) |
| `WaitingTaskHasLiveWake`                    | Whenever a delegated Task is in `waiting_for_approval`, at least one approval card, queued/running `decision.run` job, or active worker can still wake it.                                | A delegated Task stays permanently frozen in `waiting_for_approval` with no open card and no job left to wake it.     | **FAIL** (open finding, 6 steps)  |
| `NoPrematureIdleReport`                     | `settleTaskTurn` does not mark a Task `idle` and report completion to its Meta while any approval card is pending, approved/executing, or has an undelivered `decision.run` wake.         | The Meta receives a false "Task is idle" report and delivers incomplete work while an approved write has not run yet. | **FAIL** (open finding, 4 steps)  |

## Known open findings at sync commit `43c02e4b`

Both failing invariants above were verified against real TeamHub + PostgreSQL
and are real product bugs, not modeling errors:

1. **Delayed stop-expiry wedges a resumed Task (`WaitingTaskHasLiveWake`, also `NoDeadlock`)**:
   AlterEgo creates card 1 -> `taskdelegation.StopTask` moves Task to `canceled` and enqueues `StoppedTaskApprovalsArgs{TenantID, TaskID}` (no task revision or cutoff timestamp) -> Meta resumes Task with `taskdelegation.Send` -> Turn settles to `waiting_for_approval` on a pending card -> delayed `stoppedTaskApprovalsWorker` runs `ExpireStoppedTaskApprovals`, which unconditionally expires every `pending` approval for `alter_ego_task_id` without checking whether the Task is still `canceled` and enqueues no wake -> Task remains in `waiting_for_approval` forever; the card's scheduled `ExpireDecision` later sees `status = 'expired'` and wakes nobody.
2. **Premature `idle` report to Meta while approved write is queued (`NoPrematureIdleReport`)**:
   AlterEgo creates card 1 -> AlterEgo finishes turn (`recordAgentTerminal`) -> sponsor approves card 1 (`DecideDecision` moves card to `approved` and enqueues `decision.run`) -> before `decision.run` delivers its wake, `reconcileTaskAttempt` -> `settleTaskTurn` queries `ListDelegatedTaskPendingApprovals` (`WHERE status = 'pending'`), finds 0 pending rows, sets Task to `idle`, and writes the idle completion report to the Meta while the approved write has not even run.

When fixing one of these bugs in product code, update the matching action in
[DelegatedTaskApprovals.tla](model/DelegatedTaskApprovals.tla) to reflect the
new SQL/Go guard, re-run `check.sh`, and confirm that invariant flips from
`FAIL` to `PASS`.

## Coverage record

- **Sync commit**: `43c02e4bf47ab271a4881a00906e4fabc49fc6ec`

| Repository file                                                                                                                       | Covered functions / queries                                                                                                                                                  | Model actions                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [decisions.go](../../../apps/teamhub/internal/typedcard/decisions.go)                                                                 | `CreateDecision`, `DecideDecision`, `decisionAnswerStep.apply`, `RunDecision`, `claimDecision`, `finishDecision`, `ExpireDecision`, `HandOffDecision`, `handOffDecisionInTx` | `AlterEgoCreateDecision`, `HumanApprove`, `HumanDeny`, `ExpireDecisionJob`, `WorkerClaimDecision`, `WorkerRescueClaim`, `WorkerFinishDecision`, `WorkerHandOffDecision` |
| [decision.go](../../../apps/teamhub/internal/typedcard/decision.go)                                                                   | `decideCard`                                                                                                                                                                 | `HumanApprove`, `HumanDeny`                                                                                                                                             |
| [decision_connector_write.go](../../../apps/teamhub/internal/typedcard/decision_connector_write.go)                                   | `reusePendingConnectorWrite`                                                                                                                                                 | `AlterEgoCreateDecision`                                                                                                                                                |
| [decision_connection.go](../../../apps/teamhub/internal/typedcard/decision_connection.go)                                             | `endSettledDecision`                                                                                                                                                         | `ExpireDecisionJob`                                                                                                                                                     |
| [alter_ego_approvals.go](../../../apps/teamhub/internal/typedcard/alter_ego_approvals.go)                                             | `ExpireStoppedTaskApprovals`                                                                                                                                                 | `ExpireStoppedTaskApprovalsJob`                                                                                                                                         |
| [decision_workers.go](../../../apps/teamhub/internal/app/decision_workers.go)                                                         | `decisionRunWorker.Work`, `decisionExpireWorker.Work`, `deliverDecisionNotice`, `registerDecisionExecutors` (`Rerun: false`)                                                 | `WorkerClaimDecision`, `WorkerRescueClaim`, `WorkerCrashBeforeDispatch`, `WorkerCrashAfterDispatch`, `WorkerDeliverNotice`, `ExpireDecisionJob`                         |
| [alter_ego_card_workers.go](../../../apps/teamhub/internal/app/alter_ego_card_workers.go)                                             | `wakeTaskWithSystemInput`, `stoppedTaskApprovalsWorker.Work`                                                                                                                 | `WorkerDeliverNotice`, `ExpireStoppedTaskApprovalsJob`                                                                                                                  |
| [contract_server_agent_connector_confirmation.go](../../../apps/teamhub/internal/app/contract_server_agent_connector_confirmation.go) | `writeConnectedAppResult`                                                                                                                                                    | `AlterEgoCreateDecision`                                                                                                                                                |
| [confirmation.go](../../../apps/teamhub/internal/agentconnectedapps/confirmation.go)                                                  | `ExecuteConfirmed`                                                                                                                                                           | `WorkerExecutePreflightFail`, `WorkerExecuteDispatched`, `WorkerCrashBeforeDispatch`, `WorkerCrashAfterDispatch`                                                        |
| [manage.go](../../../apps/teamhub/internal/taskdelegation/manage.go)                                                                  | `Send`, `Stop`, `StopTask`, `SendSystemInput`                                                                                                                                | `MetaSendResume`, `StopTask`, `WorkerDeliverNotice`                                                                                                                     |
| [room_cancel.go](../../../apps/teamhub/internal/taskdelegation/room_cancel.go)                                                        | `CancelFromRoom`                                                                                                                                                             | `StopTask`                                                                                                                                                              |
| [delegated.go](../../../apps/teamhub/internal/taskexecution/delegated.go)                                                             | `AppendTaskInput`, `StopTask`                                                                                                                                                | `MetaSendResume`, `StopTask`, `WorkerDeliverNotice`                                                                                                                     |
| [attempt_reconcile.go](../../../apps/teamhub/internal/taskexecution/attempt_reconcile.go)                                             | `reconcileTaskAttempt`, `settleTaskTurn`                                                                                                                                     | `ReconcileSettleTurn`                                                                                                                                                   |
| [task_delegation.sql](../../../apps/teamhub/internal/store/queries/task_delegation.sql)                                               | `ListDelegatedTaskPendingApprovals`, `GetDelegatedTaskForAlterEgo`                                                                                                           | `ReconcileSettleTurn`, `WorkerDeliverNotice`                                                                                                                            |

## Bounds, assumptions, and non-goals

- **Bounds** ([DelegatedTaskApprovals.cfg](model/DelegatedTaskApprovals.cfg)):
  1 delegated Task (`generation = 1`), `Cards = {1, 2}`, `Workers = {"w1", "w2"}`,
  `MaxStops = 1`, `MaxResumes = 1`, `MaxRetries = 1` per card. Total reachable
  state space is 49,827 distinct states (~14 s with `-workers 1`).
- **Assumptions**:
  - PostgreSQL transactions execute with `FOR UPDATE` row locking on the single
    `decisions` or `work_items` row, so each modeled DB transaction is atomic.
  - `DecisionKindConnectorWrite` is registered with `Rerun: false`.
  - Worker crashes/timeouts happen within River's `MaxAttempts: 5` retry budget
    (permanent River job exhaustion is excluded so `WaitingTaskHasLiveWake`
    reports protocol wedges rather than infrastructure outage).
  - `AlterEgoCreateDecision` is restricted to `taskStatus = "running" /\ turnPending = TRUE`;
    in reality `CreateDecision` for `connector_write` does not lock `work_items`,
    so an in-flight CLI request arriving after `StopTask` is strictly worse than
    what the model assumes.
- **Not covered**:
  - `runtime_permission` one-time approval consumption (`ConsumeRuntimePermission`).
  - `connection_auth`, `agent_change` (`Rerun: true`), `provider_key`, `search_key`,
    and `room_creation` decision kinds.
  - Gmail/Outlook/Feishu canvas draft leases (`gmail_canvas_draft_leases`) and
    draft/canvas digest validation inside `ExecuteConfirmed`.
  - PostgreSQL lock-order deadlocks across Rooms, Tasks, and Decisions.
  - `failTaskAttempt` (failed/timed-out AlterEgo runs) and `MaxRunningTasks` cap enforcement.

## Distinguishing a real bug from a modeling error

When TLC reports a counterexample (or when reading one through `/statechart`):

1. **Replay every step against the real Go code.** Open each file named in the
   action's header comment in [DelegatedTaskApprovals.tla](model/DelegatedTaskApprovals.tla)
   and check whether every SQL `WHERE` clause, transaction lock, and status check
   permits that transition in PostgreSQL.
2. **If a step cannot happen in the real code**, the model drifted or missed a
   guard. Fix the action in `DelegatedTaskApprovals.tla` so it matches the real
   indivisible step in the code, then re-run `check.sh`.
3. **If every step can happen in the real code**, it is a real bug. Confirm it
   with a focused PostgreSQL integration test if helpful (matching the pattern
   in `apps/teamhub/tests/integration/task_delegation_approvals_test.go`), and
   **never weaken the invariant or model to hide the failure**.

## Updating the verification after an intended code change

1. Diff the covered files against the sync commit and inspect every change to
   SQL predicates, transaction boundaries, River job payloads, `Rerun` flags, or
   status checks.
2. Update [DelegatedTaskApprovals.tla](model/DelegatedTaskApprovals.tla) from
   the code (keeping each indivisible PostgreSQL transaction or external step as
   one TLA+ action) before running TLC.
3. Change an invariant in `DelegatedTaskApprovals.tla` **only** when the
   product promise intentionally changed (with clear evidence in docs, comments,
   or tests); record the old and new promise.
4. Run `.agents/skills/delegated-task-approvals/scripts/check.sh` and inspect
   the result with `/statechart`.
5. For every invariant that passes after your update, confirm it can still fail
   by temporarily breaking the guarded condition (e.g., flipping `Rerun` or
   removing a `WHERE` guard in a scratch copy), verifying TLC catches it, and
   reverting the scratch break.
6. Update the coverage table above and move the **Sync commit** in both this
   file and `DelegatedTaskApprovals.tla` forward to the verified commit **only
   after** confirming the model accurately describes the code at that commit.
