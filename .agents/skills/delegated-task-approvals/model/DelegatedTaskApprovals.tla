------------------------ MODULE DelegatedTaskApprovals ------------------------
(*
 * Formal model of Delegated Task (AlterEgo) & Connector Write Approval
 * coordination in TeamHub.
 *
 * Covered source code (sync commit: 43c02e4bf47ab271a4881a00906e4fabc49fc6ec):
 *   - apps/teamhub/internal/typedcard/decisions.go
 *       CreateDecision, DecideDecision (decisionAnswerStep.apply),
 *       RunDecision, claimDecision, finishDecision, ExpireDecision,
 *       HandOffDecision, handOffDecisionInTx
 *   - apps/teamhub/internal/typedcard/decision.go
 *       decideCard
 *   - apps/teamhub/internal/typedcard/decision_connector_write.go
 *       reusePendingConnectorWrite
 *   - apps/teamhub/internal/typedcard/decision_connection.go
 *       endSettledDecision
 *   - apps/teamhub/internal/typedcard/alter_ego_approvals.go
 *       ExpireStoppedTaskApprovals
 *   - apps/teamhub/internal/app/decision_workers.go
 *       decisionRunWorker.Work, decisionExpireWorker.Work,
 *       deliverDecisionNotice, registerDecisionExecutors (Rerun: false)
 *   - apps/teamhub/internal/app/alter_ego_card_workers.go
 *       wakeTaskWithSystemInput, stoppedTaskApprovalsWorker.Work
 *   - apps/teamhub/internal/agentconnectedapps/confirmation.go
 *       ExecuteConfirmed
 *   - apps/teamhub/internal/taskdelegation/manage.go
 *       Send, Stop, StopTask, SendSystemInput
 *   - apps/teamhub/internal/taskdelegation/room_cancel.go
 *       CancelFromRoom
 *   - apps/teamhub/internal/taskexecution/delegated.go
 *       AppendTaskInput, StopTask
 *   - apps/teamhub/internal/taskexecution/attempt_reconcile.go
 *       reconcileTaskAttempt, settleTaskTurn
 *   - apps/teamhub/internal/store/queries/task_delegation.sql
 *       ListDelegatedTaskPendingApprovals, GetDelegatedTaskForAlterEgo
 *
 * Each TLA+ action corresponds to one indivisible PostgreSQL transaction or
 * one external provider/worker boundary step in the Go implementation.
 *)
EXTENDS Naturals

CONSTANTS
    Cards,          \* Set of decision card IDs, e.g. {1, 2}
    Workers,        \* Set of River decisionRunWorker IDs, e.g. {"w1", "w2"}
    MaxStops,       \* Bound on StopTask calls
    MaxResumes,     \* Bound on MetaSendResume calls
    MaxRetries      \* Bound on River decision.run retries/rescues per card

VARIABLES
    \* PostgreSQL work_items / task_attempts state for one delegated Task T
    taskStatus,     \* "running" | "waiting_for_approval" | "idle" | "canceled"
    turnPending,    \* TRUE while the running Attempt has an unfinished AlterEgo turn

    \* PostgreSQL decisions rows (kind = 'connector_write', alter_ego_task_id = T)
    cardStatus,     \* [Cards -> {"unused","pending","approved","executing",
                    \*            "succeeded","failed","unknown","denied","expired"}]

    \* River river_job queue state
    \* DecisionExpireArgs is scheduled on CreateDecision; once cardStatus[d]
    \* leaves "pending", ExpireDecision is a pure no-op (decisions.go:728-729),
    \* so ExpireDecisionJob is enabled iff cardStatus[d] = "pending".
    runJob,         \* [Cards -> {"none","queued","running","done"}] DecisionRunArgs
    runRetriesLeft, \* [Cards -> 0..MaxRetries] remaining River retries/rescues for d
    stopExpireJobs, \* 0..MaxStops queued StoppedTaskApprovalsArgs{TenantID, TaskID: T}

    \* In-memory state of each River decisionRunWorker goroutine
    workerPhase,    \* [Workers -> {"idle","executing","finishing","handoff","waking"}]
    workerCard,     \* [Workers -> {0} \cup Cards]
    workerOutcome,  \* [Workers -> {"none","succeeded","failed","unknown"}]
    workerHasNotice,\* [Workers -> BOOLEAN]

    \* Specification / ghost variables (observation only; never read by guards)
    approvedEver,   \* [Cards -> BOOLEAN] sponsor explicitly approved card d
    execCount,      \* [Cards -> 0..2] times provider.ExecuteTool was dispatched for d
    terminalStatus, \* [Cards -> {"none","succeeded","failed","unknown","denied","expired"}]
    canceledByStop, \* BOOLEAN: Task was stopped and not subsequently resumed by Meta
    stopCount,      \* 0..MaxStops
    resumeCount     \* 0..MaxResumes

vars == <<
    taskStatus, turnPending, cardStatus,
    runJob, runRetriesLeft, stopExpireJobs,
    workerPhase, workerCard, workerOutcome, workerHasNotice,
    approvedEver, execCount, terminalStatus, canceledByStop,
    stopCount, resumeCount
>>

TerminalStatuses == {"succeeded", "failed", "unknown", "denied", "expired"}

\* First terminal status observed for card d (for TerminalDecisionImmutable).
RecordTerminal(d, nextStatus) ==
    IF terminalStatus[d] = "none" /\ nextStatus \in TerminalStatuses
    THEN nextStatus
    ELSE terminalStatus[d]

\* True when some other worker still holds card d in memory.
OtherWorkerHolds(w, d) ==
    \E w2 \in Workers \ {w} : workerCard[w2] = d

\* Canonical idle worker selection to avoid symmetric worker permutations
\* when claiming a fresh queued job (rescue still uses a second idle worker).
CanTakeQueued(w) ==
    workerPhase[w] = "idle" /\ (w = "w1" \/ workerPhase["w1"] # "idle")

TypeOK ==
    /\ taskStatus \in {"running", "waiting_for_approval", "idle", "canceled"}
    /\ turnPending \in BOOLEAN
    /\ cardStatus \in [Cards -> {"unused", "pending", "approved", "executing",
                                 "succeeded", "failed", "unknown", "denied", "expired"}]
    /\ runJob \in [Cards -> {"none", "queued", "running", "done"}]
    /\ runRetriesLeft \in [Cards -> 0..MaxRetries]
    /\ stopExpireJobs \in 0..MaxStops
    /\ workerPhase \in [Workers -> {"idle", "executing", "finishing", "handoff", "waking"}]
    /\ workerCard \in [Workers -> ({0} \cup Cards)]
    /\ workerOutcome \in [Workers -> {"none", "succeeded", "failed", "unknown"}]
    /\ workerHasNotice \in [Workers -> BOOLEAN]
    /\ approvedEver \in [Cards -> BOOLEAN]
    /\ execCount \in [Cards -> 0..2]
    /\ terminalStatus \in [Cards -> ({"none"} \cup TerminalStatuses)]
    /\ canceledByStop \in BOOLEAN
    /\ stopCount \in 0..MaxStops
    /\ resumeCount \in 0..MaxResumes

\* Initial state: CreateDelegatedTaskInTx committed one running delegated Task.
Init ==
    /\ taskStatus = "running"
    /\ turnPending = TRUE
    /\ cardStatus = [d \in Cards |-> "unused"]
    /\ runJob = [d \in Cards |-> "none"]
    /\ runRetriesLeft = [d \in Cards |-> MaxRetries]
    /\ stopExpireJobs = 0
    /\ workerPhase = [w \in Workers |-> "idle"]
    /\ workerCard = [w \in Workers |-> 0]
    /\ workerOutcome = [w \in Workers |-> "none"]
    /\ workerHasNotice = [w \in Workers |-> FALSE]
    /\ approvedEver = [d \in Cards |-> FALSE]
    /\ execCount = [d \in Cards |-> 0]
    /\ terminalStatus = [d \in Cards |-> "none"]
    /\ canceledByStop = FALSE
    /\ stopCount = 0
    /\ resumeCount = 0

\* ---------------------------------------------------------------------------
\* Action 1: AlterEgo requests a connector_write confirmation card.
\* Code: writeConnectedAppResult (contract_server_agent_connector_confirmation.go:60)
\*       -> typedcard.CreateDecision (decisions.go:214-366)
\* Single PostgreSQL tx inserts decisions(status='pending') + DecisionExpireArgs.
\* ---------------------------------------------------------------------------
AlterEgoCreateDecision ==
    \E d \in Cards :
        /\ taskStatus = "running"
        /\ turnPending = TRUE
        /\ cardStatus[d] = "unused"
        /\ \A c \in Cards : c < d => cardStatus[c] # "unused"
        /\ cardStatus' = [cardStatus EXCEPT ![d] = "pending"]
        /\ UNCHANGED <<
            taskStatus, turnPending, runJob, runRetriesLeft, stopExpireJobs,
            workerPhase, workerCard, workerOutcome, workerHasNotice,
            approvedEver, execCount, terminalStatus, canceledByStop,
            stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 2: AlterEgo's active Local Run finishes cleanly.
\* Code: taskexecution.recordAgentTerminal (worker.go:503-563, status="succeeded")
\* ---------------------------------------------------------------------------
AlterEgoFinishTurn ==
    /\ taskStatus = "running"
    /\ turnPending = TRUE
    /\ turnPending' = FALSE
    /\ UNCHANGED <<
        taskStatus, cardStatus, runJob, runRetriesLeft, stopExpireJobs,
        workerPhase, workerCard, workerOutcome, workerHasNotice,
        approvedEver, execCount, terminalStatus, canceledByStop,
        stopCount, resumeCount
       >>

\* ---------------------------------------------------------------------------
\* Action 3: Task worker reconciles the finished Attempt.
\* Code: reconcileTaskAttempt -> settleTaskTurn (attempt_reconcile.go:32-107, 218-267)
\* Queries ListDelegatedTaskPendingApprovals (task_delegation.sql:43-57), which
\* checks ONLY decision.status = 'pending'. If none are pending, moves the Task
\* to "idle" and appends the idle completion report to its Meta.
\* ---------------------------------------------------------------------------
ReconcileSettleTurn ==
    /\ taskStatus = "running"
    /\ turnPending = FALSE
    /\ LET hasPending == \E d \in Cards : cardStatus[d] = "pending"
       IN taskStatus' = IF hasPending THEN "waiting_for_approval" ELSE "idle"
    /\ UNCHANGED <<
        turnPending, cardStatus, runJob, runRetriesLeft, stopExpireJobs,
        workerPhase, workerCard, workerOutcome, workerHasNotice,
        approvedEver, execCount, terminalStatus, canceledByStop,
        stopCount, resumeCount
       >>

\* ---------------------------------------------------------------------------
\* Action 4 & 5: Sponsor answers a pending decision card (approve or deny).
\* Code: typedcard.DecideDecision (decisions.go:487-604) -> decideCard (decision.go:25-72)
\* Checks decision.status = 'pending' under FOR UPDATE; does NOT check Task status.
\* Commits status ('approved' or 'denied') and enqueues DecisionRunArgs in one tx.
\* ---------------------------------------------------------------------------
HumanApprove ==
    \E d \in Cards :
        /\ cardStatus[d] = "pending"
        /\ cardStatus' = [cardStatus EXCEPT ![d] = "approved"]
        /\ approvedEver' = [approvedEver EXCEPT ![d] = TRUE]
        /\ runJob' = [runJob EXCEPT ![d] = "queued"]
        /\ UNCHANGED <<
            taskStatus, turnPending, runRetriesLeft, stopExpireJobs,
            workerPhase, workerCard, workerOutcome, workerHasNotice,
            execCount, terminalStatus, canceledByStop, stopCount, resumeCount
           >>

HumanDeny ==
    \E d \in Cards :
        /\ cardStatus[d] = "pending"
        /\ cardStatus' = [cardStatus EXCEPT ![d] = "denied"]
        /\ terminalStatus' = [terminalStatus EXCEPT ![d] = RecordTerminal(d, "denied")]
        /\ runJob' = [runJob EXCEPT ![d] = "queued"]
        /\ UNCHANGED <<
            taskStatus, turnPending, runRetriesLeft, stopExpireJobs,
            workerPhase, workerCard, workerOutcome, workerHasNotice,
            approvedEver, execCount, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 6: Scheduled decision.expire job runs after alterEgoApprovalTTL (10m).
\* Code: decisionExpireWorker.Work (decision_workers.go:43-52)
\*       -> typedcard.ExpireDecision (decisions.go:710-740)
\*       -> endSettledDecision (decision_connection.go:393-399)
\* If still 'pending', sets 'expired' and inserts DecisionRunArgs (alterEgo = true).
\* On any other status, ExpireDecision returns (false, 0, nil) with no DB writes.
\* ---------------------------------------------------------------------------
ExpireDecisionJob ==
    \E d \in Cards :
        /\ cardStatus[d] = "pending"
        /\ cardStatus' = [cardStatus EXCEPT ![d] = "expired"]
        /\ terminalStatus' = [terminalStatus EXCEPT ![d] = RecordTerminal(d, "expired")]
        /\ runJob' = [runJob EXCEPT ![d] = "queued"]
        /\ UNCHANGED <<
            taskStatus, turnPending, runRetriesLeft, stopExpireJobs,
            workerPhase, workerCard, workerOutcome, workerHasNotice,
            approvedEver, execCount, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 7: Meta or Human cancels the active delegated Task.
\* Code: taskdelegation.Stop (manage.go:184-205) / CancelFromRoom (room_cancel.go:26-73)
\*       -> taskdelegation.StopTask (manage.go:211-220)
\*       -> taskexecution.StopTask (delegated.go:227-273)
\* Moves Task to 'canceled' and enqueues async StoppedTaskApprovalsArgs{TenantID, TaskID}.
\* ---------------------------------------------------------------------------
StopTask ==
    /\ taskStatus \in {"running", "waiting_for_approval"}
    /\ stopCount < MaxStops
    /\ taskStatus' = "canceled"
    /\ turnPending' = FALSE
    /\ canceledByStop' = TRUE
    /\ stopExpireJobs' = stopExpireJobs + 1
    /\ stopCount' = stopCount + 1
    /\ UNCHANGED <<
        cardStatus, runJob, runRetriesLeft,
        workerPhase, workerCard, workerOutcome, workerHasNotice,
        approvedEver, execCount, terminalStatus, resumeCount
       >>

\* ---------------------------------------------------------------------------
\* Action 8: Async stoppedTaskApprovalsWorker drains one stop-expiry job.
\* Code: stoppedTaskApprovalsWorker.Work (alter_ego_card_workers.go:31-33)
\*       -> typedcard.ExpireStoppedTaskApprovals (alter_ego_approvals.go:37-62)
\* Unconditionally expires ALL 'pending' approval cards for alter_ego_task_id=T
\* without checking Task status or revision, and enqueues NO DecisionRunArgs.
\* ---------------------------------------------------------------------------
ExpireStoppedTaskApprovalsJob ==
    /\ stopExpireJobs > 0
    /\ stopExpireJobs' = stopExpireJobs - 1
    /\ cardStatus' = [d \in Cards |->
                        IF cardStatus[d] = "pending" THEN "expired" ELSE cardStatus[d]]
    /\ terminalStatus' = [d \in Cards |->
                            IF cardStatus[d] = "pending"
                            THEN RecordTerminal(d, "expired")
                            ELSE terminalStatus[d]]
    /\ UNCHANGED <<
        taskStatus, turnPending, runJob, runRetriesLeft,
        workerPhase, workerCard, workerOutcome, workerHasNotice,
        approvedEver, execCount, canceledByStop, stopCount, resumeCount
       >>

\* ---------------------------------------------------------------------------
\* Action 9: Meta sends a follow-up or resumes a canceled/idle/waiting Task.
\* Code: taskdelegation.Service.Send (manage.go:142-180)
\*       -> taskexecution.AppendTaskInput (delegated.go:62-221)
\* ---------------------------------------------------------------------------
MetaSendResume ==
    /\ taskStatus \in {"canceled", "idle", "waiting_for_approval"}
    /\ resumeCount < MaxResumes
    /\ taskStatus' = "running"
    /\ turnPending' = TRUE
    /\ canceledByStop' = FALSE
    /\ resumeCount' = resumeCount + 1
    /\ UNCHANGED <<
        cardStatus, runJob, runRetriesLeft, stopExpireJobs,
        workerPhase, workerCard, workerOutcome, workerHasNotice,
        approvedEver, execCount, terminalStatus, stopCount
       >>

\* ---------------------------------------------------------------------------
\* Action 10: River decisionRunWorker claims a queued decision.run job.
\* Code: RunDecision -> claimDecision (decisions.go:609-669)
\* With DecisionKindConnectorWrite registered with Rerun: false (decision_workers.go:68):
\*   - status = 'approved'  -> status := 'executing', worker runs ExecuteConfirmed
\*   - status = 'executing' -> status := 'unknown', worker skips run and hands off
\*   - any other status     -> status unchanged, worker skips run and hands off
\* ---------------------------------------------------------------------------
WorkerClaimDecision ==
    \E w \in Workers, d \in Cards :
        /\ CanTakeQueued(w)
        /\ runJob[d] = "queued"
        /\ runJob' = [runJob EXCEPT ![d] = "running"]
        /\ workerCard' = [workerCard EXCEPT ![w] = d]
        /\ workerOutcome' = [workerOutcome EXCEPT ![w] = "none"]
        /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = FALSE]
        /\ IF cardStatus[d] = "approved"
           THEN /\ cardStatus' = [cardStatus EXCEPT ![d] = "executing"]
                /\ workerPhase' = [workerPhase EXCEPT ![w] = "executing"]
                /\ UNCHANGED terminalStatus
           ELSE IF cardStatus[d] = "executing"
           THEN /\ cardStatus' = [cardStatus EXCEPT ![d] = "unknown"]
                /\ terminalStatus' = [terminalStatus EXCEPT ![d] = RecordTerminal(d, "unknown")]
                /\ workerPhase' = [workerPhase EXCEPT ![w] = "handoff"]
           ELSE /\ workerPhase' = [workerPhase EXCEPT ![w] = "handoff"]
                /\ UNCHANGED <<cardStatus, terminalStatus>>
        /\ UNCHANGED <<
            taskStatus, turnPending, runRetriesLeft, stopExpireJobs,
            approvedEver, execCount, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 11: River rescues a stuck running decision.run job onto a second worker
\* while the first worker is still executing ExecuteConfirmed.
\* Code: RescueStuckJobsAfter (jobs/jobs.go:72) + claimDecision (decisions.go:633-669)
\* ---------------------------------------------------------------------------
WorkerRescueClaim ==
    \E w \in Workers, d \in Cards :
        /\ workerPhase[w] = "idle"
        /\ runJob[d] = "running"
        /\ runRetriesLeft[d] > 0
        /\ \E w2 \in Workers \ {w} : workerCard[w2] = d /\ workerPhase[w2] = "executing"
        /\ runRetriesLeft' = [runRetriesLeft EXCEPT ![d] = runRetriesLeft[d] - 1]
        /\ workerCard' = [workerCard EXCEPT ![w] = d]
        /\ workerOutcome' = [workerOutcome EXCEPT ![w] = "none"]
        /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = FALSE]
        /\ IF cardStatus[d] = "approved"
           THEN /\ cardStatus' = [cardStatus EXCEPT ![d] = "executing"]
                /\ workerPhase' = [workerPhase EXCEPT ![w] = "executing"]
                /\ UNCHANGED terminalStatus
           ELSE IF cardStatus[d] = "executing"
           THEN /\ cardStatus' = [cardStatus EXCEPT ![d] = "unknown"]
                /\ terminalStatus' = [terminalStatus EXCEPT ![d] = RecordTerminal(d, "unknown")]
                /\ workerPhase' = [workerPhase EXCEPT ![w] = "handoff"]
           ELSE /\ workerPhase' = [workerPhase EXCEPT ![w] = "handoff"]
                /\ UNCHANGED <<cardStatus, terminalStatus>>
        /\ UNCHANGED <<
            taskStatus, turnPending, runJob, stopExpireJobs,
            approvedEver, execCount, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 12: ExecuteConfirmed refuses before provider side effect (revoked grant,
\* changed draft/canvas digest, or 4xx refusal before effect).
\* Code: agentconnectedapps.ExecuteConfirmed (confirmation.go:82-125, 163-167)
\* ---------------------------------------------------------------------------
WorkerExecutePreflightFail ==
    \E w \in Workers :
        /\ workerPhase[w] = "executing"
        /\ workerOutcome' = [workerOutcome EXCEPT ![w] = "failed"]
        /\ workerPhase' = [workerPhase EXCEPT ![w] = "finishing"]
        /\ UNCHANGED <<
            taskStatus, turnPending, cardStatus, runJob,
            runRetriesLeft, stopExpireJobs, workerCard, workerHasNotice,
            approvedEver, execCount, terminalStatus, canceledByStop,
            stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 13: ExecuteConfirmed dispatches provider.ExecuteTool and returns a
\* result ("succeeded" or "unknown").
\* Code: agentconnectedapps.ExecuteConfirmed (confirmation.go:126-143)
\* ---------------------------------------------------------------------------
WorkerExecuteDispatched ==
    \E w \in Workers, res \in {"succeeded", "unknown"} :
        /\ workerPhase[w] = "executing"
        /\ LET d == workerCard[w]
           IN /\ execCount[d] < 2
              /\ execCount' = [execCount EXCEPT ![d] = execCount[d] + 1]
              /\ workerOutcome' = [workerOutcome EXCEPT ![w] = res]
              /\ workerPhase' = [workerPhase EXCEPT ![w] = "finishing"]
        /\ UNCHANGED <<
            taskStatus, turnPending, cardStatus, runJob,
            runRetriesLeft, stopExpireJobs, workerCard, workerHasNotice,
            approvedEver, terminalStatus, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 14 & 15: Worker crashes or hits its 3m Timeout mid-ExecuteConfirmed
\* (either before or after provider.ExecuteTool dispatched), leaving the DB row
\* in 'executing' and re-queuing the River job within MaxRetries.
\* Code: decisionRunWorker.Timeout (decision_workers.go:24-26) + RunDecision (decisions.go:618-624)
\* ---------------------------------------------------------------------------
WorkerCrashBeforeDispatch ==
    \E w \in Workers :
        /\ workerPhase[w] = "executing"
        /\ LET d == workerCard[w]
           IN /\ runRetriesLeft[d] > 0
              /\ ~OtherWorkerHolds(w, d)
              /\ runRetriesLeft' = [runRetriesLeft EXCEPT ![d] = runRetriesLeft[d] - 1]
              /\ runJob' = [runJob EXCEPT ![d] = "queued"]
              /\ workerPhase' = [workerPhase EXCEPT ![w] = "idle"]
              /\ workerCard' = [workerCard EXCEPT ![w] = 0]
              /\ workerOutcome' = [workerOutcome EXCEPT ![w] = "none"]
              /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = FALSE]
        /\ UNCHANGED <<
            taskStatus, turnPending, cardStatus, stopExpireJobs,
            approvedEver, execCount, terminalStatus, canceledByStop,
            stopCount, resumeCount
           >>

WorkerCrashAfterDispatch ==
    \E w \in Workers :
        /\ workerPhase[w] = "executing"
        /\ LET d == workerCard[w]
           IN /\ execCount[d] < 2
              /\ runRetriesLeft[d] > 0
              /\ ~OtherWorkerHolds(w, d)
              /\ execCount' = [execCount EXCEPT ![d] = execCount[d] + 1]
              /\ runRetriesLeft' = [runRetriesLeft EXCEPT ![d] = runRetriesLeft[d] - 1]
              /\ runJob' = [runJob EXCEPT ![d] = "queued"]
              /\ workerPhase' = [workerPhase EXCEPT ![w] = "idle"]
              /\ workerCard' = [workerCard EXCEPT ![w] = 0]
              /\ workerOutcome' = [workerOutcome EXCEPT ![w] = "none"]
              /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = FALSE]
        /\ UNCHANGED <<
            taskStatus, turnPending, cardStatus, stopExpireJobs,
            approvedEver, terminalStatus, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 16: Worker commits finishDecision in one PostgreSQL tx.
\* Code: typedcard.finishDecision (decisions.go:672-700)
\* UPDATE decisions SET status=$2 WHERE id=$1 AND status='executing'.
\* If another worker already transitioned it to 'unknown', RowsAffected() == 0
\* and finishDecision returns nil without modifying the row.
\* ---------------------------------------------------------------------------
WorkerFinishDecision ==
    \E w \in Workers :
        /\ workerPhase[w] = "finishing"
        /\ LET d == workerCard[w]
               res == workerOutcome[w]
           IN /\ IF cardStatus[d] = "executing"
                 THEN /\ cardStatus' = [cardStatus EXCEPT ![d] = res]
                      /\ terminalStatus' = [terminalStatus EXCEPT ![d] = RecordTerminal(d, res)]
                 ELSE UNCHANGED <<cardStatus, terminalStatus>>
              /\ workerPhase' = [workerPhase EXCEPT ![w] = "handoff"]
              /\ workerOutcome' = [workerOutcome EXCEPT ![w] = "none"]
        /\ UNCHANGED <<
            taskStatus, turnPending, runJob, runRetriesLeft,
            stopExpireJobs, workerCard, workerHasNotice, approvedEver,
            execCount, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 17: Worker runs HandOffDecision in one PostgreSQL tx.
\* Code: typedcard.HandOffDecision -> handOffDecisionInTx (decisions.go:758-814)
\* Returns a non-empty DecisionNotice for AlterEgoTaskID iff decisionEnded(status).
\* ---------------------------------------------------------------------------
WorkerHandOffDecision ==
    \E w \in Workers :
        /\ workerPhase[w] = "handoff"
        /\ LET d == workerCard[w]
           IN IF cardStatus[d] \in TerminalStatuses
              THEN /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = TRUE]
                   /\ workerPhase' = [workerPhase EXCEPT ![w] = "waking"]
                   /\ UNCHANGED <<workerCard, runJob>>
              ELSE /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = FALSE]
                   /\ workerPhase' = [workerPhase EXCEPT ![w] = "idle"]
                   /\ workerCard' = [workerCard EXCEPT ![w] = 0]
                   /\ runJob' = [runJob EXCEPT ![d] =
                                   IF OtherWorkerHolds(w, d) THEN "running" ELSE "done"]
        /\ UNCHANGED <<
            taskStatus, turnPending, cardStatus, runRetriesLeft,
            stopExpireJobs, workerOutcome, approvedEver, execCount,
            terminalStatus, canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Action 18: Worker delivers the DecisionNotice to the delegated Task.
\* Code: deliverDecisionNotice (decision_workers.go:57-62)
\*       -> wakeTaskWithSystemInput (alter_ego_card_workers.go:15-22)
\*       -> taskdelegation.SendSystemInput (manage.go:225-259)
\*       -> taskexecution.AppendTaskInput (delegated.go:65-232)
\* When input.Cause == TaskInputSystem and task_execution_status == "canceled",
\* AppendTaskInput returns Delivery: "ignored" without restarting the Task.
\* Otherwise it starts a new Attempt ("running") or queues a turn on the
\* running Attempt.
\* ---------------------------------------------------------------------------
WorkerDeliverNotice ==
    \E w \in Workers :
        /\ workerPhase[w] = "waking"
        /\ workerHasNotice[w] = TRUE
        /\ LET d == workerCard[w]
           IN /\ IF taskStatus = "canceled"
                 THEN UNCHANGED <<taskStatus, turnPending>>
                 ELSE /\ taskStatus' = "running"
                      /\ turnPending' = TRUE
              /\ workerPhase' = [workerPhase EXCEPT ![w] = "idle"]
              /\ workerCard' = [workerCard EXCEPT ![w] = 0]
              /\ workerHasNotice' = [workerHasNotice EXCEPT ![w] = FALSE]
              /\ runJob' = [runJob EXCEPT ![d] =
                              IF OtherWorkerHolds(w, d) THEN "running" ELSE "done"]
        /\ UNCHANGED <<
            cardStatus, runRetriesLeft, stopExpireJobs,
            workerOutcome, approvedEver, execCount, terminalStatus,
            canceledByStop, stopCount, resumeCount
           >>

\* ---------------------------------------------------------------------------
\* Quiescent terminal stutter so TLC deadlock checking flags only genuine
\* wedged states (such as waiting_for_approval with no live wake).
\* ---------------------------------------------------------------------------
Done ==
    /\ taskStatus \in {"idle", "canceled"}
    /\ stopExpireJobs = 0
    /\ \A d \in Cards :
        /\ cardStatus[d] \notin {"pending", "approved", "executing"}
        /\ runJob[d] \notin {"queued", "running"}
    /\ \A w \in Workers : workerPhase[w] = "idle"
    /\ UNCHANGED vars

Next ==
    \/ AlterEgoCreateDecision
    \/ AlterEgoFinishTurn
    \/ ReconcileSettleTurn
    \/ HumanApprove
    \/ HumanDeny
    \/ ExpireDecisionJob
    \/ StopTask
    \/ ExpireStoppedTaskApprovalsJob
    \/ MetaSendResume
    \/ WorkerClaimDecision
    \/ WorkerRescueClaim
    \/ WorkerExecutePreflightFail
    \/ WorkerExecuteDispatched
    \/ WorkerCrashBeforeDispatch
    \/ WorkerCrashAfterDispatch
    \/ WorkerFinishDecision
    \/ WorkerHandOffDecision
    \/ WorkerDeliverNotice
    \/ Done

Spec == Init /\ [][Next]_vars

\* ===========================================================================
\* Safety Invariants
\* ===========================================================================

\* 1. An external connector write executes only after explicit sponsor approval.
NoUnapprovedExecution ==
    \A d \in Cards : execCount[d] > 0 => approvedEver[d]

\* 2. An approved connector write executes at most once across retries/rescues.
AtMostOnceExecution ==
    \A d \in Cards : execCount[d] <= 1

\* 3. Once a decision reaches a terminal status it never changes again, and a
\*    dispatched write never ends as pending, denied, or expired.
TerminalDecisionImmutable ==
    \A d \in Cards :
        /\ (terminalStatus[d] # "none" => cardStatus[d] = terminalStatus[d])
        /\ (execCount[d] > 0 => cardStatus[d] \in {"executing", "succeeded", "failed", "unknown"})

\* 4. Once a Task is stopped, it stays canceled until the Meta explicitly
\*    resumes it with Send; approval answers, expiries, or in-flight notices
\*    must never silently restart a canceled Task.
CanceledTaskStaysCanceledUntilMetaResumes ==
    canceledByStop => taskStatus = "canceled"

\* 5. A Task in waiting_for_approval must always have at least one live card,
\*    queued/running decision.run job, or active worker able to wake it.
WaitingTaskHasLiveWake ==
    taskStatus = "waiting_for_approval" =>
        \E d \in Cards :
            \/ cardStatus[d] \in {"pending", "approved", "executing"}
            \/ runJob[d] \in {"queued", "running"}
            \/ \E w \in Workers : workerCard[w] = d /\ workerPhase[w] # "idle"

\* 6. A Task must not settle to idle and report completion to its Meta while
\*    any of its approval cards is still pending, executing, or has an
\*    undelivered decision.run wake in flight.
NoPrematureIdleReport ==
    taskStatus = "idle" =>
        \A d \in Cards :
            /\ cardStatus[d] \notin {"pending", "approved", "executing"}
            /\ runJob[d] \notin {"queued", "running"}
            /\ \A w \in Workers : workerCard[w] # d

=============================================================================
