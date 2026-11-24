# Agent Service: Agent lifecycle and Runtime execution

The `agent` role of Node Services: Hono/TypeScript Agent
management and TeamHub callbacks. `src/agent/main.ts` exports
`startAgentService`, which mounts the Agent routes and the Runner Gateway
WebSocket on the host's shared listener. Host rules live in
`apps/node-services/AGENTS.md`; paths below are relative to
`apps/node-services`.

## Active Execution Context V0 Authority

Ordinary Room execution uses Local Run plus live-latest reads, without
Invocation admission or exact Document input staging. Preserve the current
orchestration and Human notification prompts. Dedicated delegated actions remain
separate; their Invocation identities must not enter the ordinary Room path.

Never restore Room-owned Artifact identity, per-replacement automatic Version
creation, or an Artifact write authority beside the unified Document module.

When older Agent documentation conflicts with the records above, the records
take precedence.

## Common Commands

- `pnpm --filter @linger/node-services exec vitest run <test-file>`: run
  one test.
- `pnpm --filter @linger/node-services exec vitest run --project agent`:
  run the Agent suite; `--project agent-process` runs the real process suite.
- `pnpm --filter @linger/node-services typecheck`: typecheck Node Services,
  including the Agent feature catalog check.
- `make check-node-services`: run the boundary gate.

- Keep model/provider behavior behind the existing runtime interfaces. The only
  exception is `src/runtime-model-call.ts`: a stateless prompt on the owner's
  Agent Runtime (Codex, Claude or Pi, using its default model) through the
  Daemon's one-shot `model.invoke`, for tool-less service work such as Agent
  Memory, also used by Memory, by the LLM Wiki, and exposed
  to TeamHub as `POST /v1/model-calls`. Antigravity has no `model.invoke`, so
  a call for an Antigravity owner runs on Claude on the same Computer, or on
  Codex when only Codex is ready. Agent Memory skips Antigravity Agents,
  because it reads native history that Antigravity does not expose.
  It is not a Runtime turn and never creates a Context, Local Run, or
  Operation. Callers name an owner (or an Agent placement) and a reasoning
  effort; never add a model name, gateway, or model environment variable. Pi
  stays on Pi, on whatever model Pi defaults to, and never falls back to
  Codex or Claude. It serves structured and text calls without tools; workspace mode remains on
  Codex and Claude.
  Each background (non-interactive) call that ran on an Another Me's Computer
  and completed, or failed for a reason other than an offline Computer, a
  stopped call, a call the Daemon canceled (its connection closed or it is
  shutting down) or a missing Another Me, is reported once per execution to
  TeamHub's `POST /v0/agent-runtime/another-me/background-calls` with a
  reason code mapped from the error kind and the Daemon's structured outcome,
  never its text. The report is fire-and-forget off the caller's path; a
  failed one, including a TeamHub without the route, only logs
  `model_call.background_report_failed`. TeamHub counts the failures in a row
  and the Another Me Chat shows a banner from the third until the next
  completed call.
- TeamHub owns persisted Agent Runtime configuration, Execution Context,
  accepted input, Inbox cursor, Local Run, RuntimeSession, Runtime status,
  Local Computer and Agent placement state. Agent Runners and Operations live
  only in the Runner Gateway's memory. Agent
  Service accesses it only through generated domain APIs and must not create a
  second production persistence authority.
- Persisted Agent configuration contains canonical serializable JSON only.
  Never persist archives, secrets, live clients, callbacks, or caller-owned host
  paths. Existing inline tools remain a process-local test seam and are not
  accepted by the Agent Management HTTP protocol.
- The executor registry (`ExecutorRegistry`, behind the `AgentManager`
  contract) owns Agent identities, restore, preparation, deletion, and the
  per-Context-key state that outlives one Context instance. Each Context
  instance is one `ContextExecutor`: its residency transitions, feature
  composition, serialized admission boundary, and Runtime. A configuration or
  Runtime change replaces the whole executor. The registry consumes TeamHub
  configuration/Context snapshots; an executor reaches registry state only
  through `ExecutorHost`.
- AgentContextHost owns Context workspace and Runtime View plans, including the
  dedicated Document Comment input. Ordinary product resources use the CLI.
  TeamHub owns message bodies, stable Message identities, database Inbox state,
  product authorization and Context availability.
- The `ContextExecutor` and its Run loop (`run-loop.ts`) own the durable
  Local Run queue, active execution, steer,
  cancellation, and the only Runtime execution path. In a Meta Context a chat
  steers the running Run from any Inbox; a Run not yet sent to its Runtime,
  first or after a yield, goes back to the queue once the chat is queued, and
  TeamHub claims the chat first. Do not add a second
  scheduler, execution store, or Runtime executor beside it, and do not
  restore TeamHub Run admission.
- A Room Agent speaks only through TeamHub message writes, which the Computer
  classifies as `message` activities (`reply-delivery.ts`). Before a Room Run
  ends, the `room-reply-guard` feature (`onRunBeforeStop`) checks TeamHub's
  persisted reply status (`GET /v0/agent-runtime/runs/reply-status`) for each
  Inbox where a Human mentioned the Agent, so a chat steered in from another
  Inbox needs its own reply, and blocks the Runtime's Stop hook at most once
  so the model can still send a visible reply in the same turn. When the Stop
  hook confirms delivery (`replyConfirmed`), the Run loop skips both
  `reply_undelivered` and `reply_not_sent` and avoids a redundant post-hoc check.
  Otherwise (for instance, when a Stop hook blocked once, its check failed, or
  an older Daemon/Runtime never ran Stop hooks), before failing a Room Run for
  a missing reply while a Human's Message that mentioned the Agent (a direct
  chat always does) waits, the Run loop re-checks TeamHub's persisted reply
  status so compound scripts, decision cards, presentation sequences, and
  reactions that activity classification missed are not misreported. When no
  reply reached the Room while such a Human waits, a Run with at least one
  failed write attempt finishes failed with `reply_undelivered`, and one with
  no failed write attempt finishes failed with `reply_not_sent`. Runs where no
  Human waits on a reply are not failed as `reply_undelivered` or
  `reply_not_sent`. The Runtime's final text is private scratch and is never
  posted for it.
- Ordinary Room/Meta execution reads effective Agent configuration before a new
  Local Run. Skill saves do not activate idle Contexts. If versions changed,
  reuse graceful activation to resume the same native history; running/steered
  and recovered executions retain their exact versions in RuntimeSession
  metadata. This metadata is not a resource grant. Contexts other than ordinary
  Meta run one read-only Context resolve before a Run; it issues no session or
  credential.
- Fixed Context activation prepares the Context workspace, publishes the
  Context View, configures CLI, and creates or resumes the Provider Runtime.
  When the Computer does not offer the Agent's model or reasoning effort,
  activation finishes every queued Run as failed with `model_not_offered`, so
  the Room shows the cause; the next input activates again. Ordinary
  resource reads do not repeat activation or replace filesystem policy. Keep
  this a fixed pipeline, not a dynamic hook registry.
- A Context View is named by the SHA-256 of its content manifest. The manifest
  names each Skill by its TeamHub package manifest and digest; the Computer
  daemon fetches the package from TeamHub with the Agent CLI credential,
  verifies the digest and projects it read-only into the Context workspace.
  Agent Service stores no Skill bytes. TeamHub configuration still selects
  versions; cached bytes confer no authority. Do not reintroduce Run Tokens,
  Run grants, Run-scoped resource snapshots, staging, or checkpoint hooks.
- Agent Memory files and the recall summary come from one published document
  read at Context activation. The read-only files are inline Context View
  content, retained with the View rather than backed by a shared directory.
  Before-run synchronization neither rereads Agent Memory nor walks those files.
- Local Runner Runtimes read collaboration resources through the
  standalone TeamHub CLI, authorized by current Agent identity on each request.
  Tenant workers, resource roots, file deltas, topology registration and
  transferManifest are retired. Do not restore members/team.md/documents/fragment
  mounts or per-Run Tenant reconciliation. Keep Context-owned Skill installations, Memory,
  Playground and native Provider state; Document Comment retains its trusted
  comments.md snapshot. First use of a new view deletes only known retired Tenant
  entries, preserving user files and the other owned resources.
- Agents execute only on the user's own Local Computer over the Runner
  Gateway; each Computer owns its native Runtime home. There is no
  platform-managed cloud Computer. Never restore in-pod Host execution, a
  service-wide native home or shared app-server, E2B, or the Kubernetes cloud
  sandbox. Every Agent registration, update, and stored Ghost carries a Local
  placement; one without it is rejected.
- A Computer's model library is the Daemon's; Agent Service stores none of it
  (`runner-gateway/runner-local-models.ts`). It records each
  `runner.local_models` snapshot in TeamHub (`recordAgentRuntimeLocalModels`),
  drops a revision at or below the connection's last, and keeps one snapshot
  per Computer in flight, sending only the newest after it, so TeamHub never
  stores an older one last. A failed record is logged, the connection stays,
  and the unsaved snapshot is written again after a backoff of 1 to 60
  seconds (at once when a newer one arrives) until TeamHub stores it or
  answers that it never will (a 4xx). `actOnLocalComputerModels` sends `execute` `local_models` only to a
  connection that has reported a library (an older Daemon would treat the
  command as a protocol error), and answers with the Computer's
  accept or refusal, `LOCAL_MODELS_ACTION_TIMEOUT` past the command's
  `expires_at` (at most 30 seconds; the Daemon never answers after that
  deadline, so the outcome is unknown, not refused), or
  `LOCAL_COMPUTER_OFFLINE`.
- A Computer's model source is the Daemon's too
  (`runner-gateway/runner-local-capabilities.ts`, `modelSource`). Agent Service
  sends `execute` `model_source` only to Computer 0.54.0 or later
  (`FIRST_MODEL_SOURCE_COMPUTER_VERSION`), because an older one closes the
  connection on a kind it cannot decode, and maps the Computer's refusals in
  `executor/http/local-computer-http.ts`. A BYOK key stays inside the request
  and the envelope; it is never logged, stored or returned. A command with a
  BYOK input goes only to Computer 0.56.0 or later
  (`FIRST_BYOK_ENDPOINT_COMPUTER_VERSION`), whose welcome also names the
  `byok_endpoint` service feature.
- Runtime stop-hook bridging (`stop_hook` on `provider.prepare`,
  `operation.prepare`, and `operation.start`) goes only to Computer 0.57.0 or
  later (`FIRST_STOP_HOOK_COMPUTER_VERSION`), because an older Computer rejects
  unknown envelope fields and closes the connection; Runs on older Computers
  rely on `RunLoop`'s post-hoc reply check (`reply_not_sent` / `reply_undelivered`).
- `local_model_unavailable` in `runner.welcome`'s `service_features` goes to
  every Computer that receives the field: the Go Daemon decodes the list as
  strings and ignores a value it does not know. A Daemon that sees it reports a
  Pi Run whose local model it could not load with the `local_model_unavailable`
  failure code; otherwise it falls back to `model_unavailable`. TeamHub must
  accept the code before an Agent Service announcing the feature reaches it.
- Extended local-model diagnostics and debug metadata (`local_models_diagnostics`
  in `runner.welcome`'s `service_features`) are advertised only to Computer
  0.58.0 or later (`FIRST_LOCAL_MODELS_DIAGNOSTICS_COMPUTER_VERSION`), the
  first release that acts on it; every Computer since 0.52.0 decodes
  `service_features` as strings and ignores a value it does not know. A
  Daemon talking to an older Agent Service downgrades those snapshot and
  refusal fields to legacy values.
- Extended `executed` `model_invoke` outcomes (`context_too_long` and
  `unsupported`, gated by `model_invoke_outcomes` in `runner.welcome`'s
  `service_features`) are advertised only to Computer 0.60.0 or later
  (`FIRST_MODEL_INVOKE_OUTCOMES_COMPUTER_VERSION`); otherwise a Daemon
  downgrades them to `failed` and `runtime_unavailable`.
- Per-model local inference engine metadata (`local_models_engine` in
  `runner.welcome`'s `service_features`) is advertised only to Computer 0.61.0
  or later (`FIRST_LOCAL_MODELS_ENGINE_COMPUTER_VERSION`); a Daemon talking to
  an older Agent Service strips `engine`, `engine_label`, `concurrency`, and
  `host_ram_bytes` from `LocalModel` rows.
- Post-load local-model concurrency probing (`local_models_concurrency_probe`
  in `runner.welcome`'s `service_features`) is advertised only to Computer
  0.64.0 or later (`FIRST_LOCAL_MODELS_CONCURRENCY_PROBE_COMPUTER_VERSION`); a
  Daemon talking to an older Agent Service strips `concurrency_probing` from
  `LocalModel` rows. `ModelQueue` trusts `LocalModel.concurrency` only from
  Computers at or above `FIRST_LOCAL_MODELS_CONCURRENCY_PROBE_COMPUTER_VERSION`:
  a verified `1` locks `{ initial: 1, max: 1 }`, while a verified `N >= 2`
  starts at `{ initial: N, max: 8 }` and retains adaptive growth above `N`
  (older Computers and unprobed/unmeasured loads fall back to
  `{ initial: 1, max: 8 }`). Loading another model in the library does not drop
  the endpoint to `1` or reset an existing learned limit.
- `local_models_external_holders` is advertised to every Computer (a Daemon
  ignores an unknown feature); a Daemon talking to an older Agent Service
  strips `external_holders` from `LocalModelPool` rows.
- Explicit model selection on `execute` `model_invoke` (`model`) is sent only
  to Computer 0.62.0 or later (`FIRST_MODEL_INVOKE_MODEL_COMPUTER_VERSION`),
  because an older Computer rejects unknown envelope fields and closes the
  connection. Background calls resolve the placed Agent's configured model on
  its Runtime and fall back to the target Runtime's catalog default on
  cross-Runtime fallback or when unconfigured.
- `previous_session` on `operation.start` goes only to Computer 0.63.0 or later
  (`FIRST_PREVIOUS_SESSION_COMPUTER_VERSION`), because older Computers reject
  unknown envelope fields and close the connection. On `session_not_found` or
  `context_too_long`, `RunLoop` requeues the Run once, clears the persisted
  Runtime Session with `recovery_reason`, and reactivates in a fresh native
  session so the Run resumes with inlined recent messages and (on Computer
  0.63.0+) an exported `./playground/.previous-context.md` transcript.
- Default unit, integration, and fixture smoke tests use deterministic adapters
  and do not call a live model provider. Explicitly named live suites such as
  `smoke:local-runner:live` may use an authenticated provider and must remain
  outside the default gate.

## Structure

- `src/agent/executor`: the Agent executor. The process assembly
  (`application.ts`) builds the registry (`registry.ts`), which creates one
  `ContextExecutor` (`context-executor.ts`) per Context instance; the
  executor composes its features (`context-features.ts`), reaches registry
  state through `executor-host.ts`, and runs its Run loop (`run-loop.ts`).
  Around them: Context identity (`context-ref.ts`), domain types, Ghost
  configuration, the Provider seam, Runtime History, the public contract
  (`agent-manager-api.ts`), lifecycle locks (`lifecycle-coordinator.ts`),
  restart restore (`restart-restore.ts`), the TeamHub Runtime State layer
  (`teamhub-runtime-state-client.ts`, `context-store.ts`, `ghost-store.ts`,
  `context-runtime-state.ts`, `runtime-status.ts`), the activation layer
  (`workspace.ts`, `activation.ts`, `local-backend.ts`,
  `teamhub-context-resolvers.ts`), and the HTTP adapters (`http/`).
  Internal business operations use the standalone TeamHub CLI.
- `src/agent/agent-features`: feature declarations, the generated static catalog,
  scope composition, and the explicit builtin assembly; Context-bound sources
  and interaction features live here.
- `src/agent/prompt`: Agent Service-owned prompt templates and pure prompt rendering.
- `tests/agent/executor`: tests of the executor modules, the public
  AgentManager behavior, and the real process test.
- `tests/agent/executor-hook-trace.test.ts`: golden traces of feature hook
  timing against the executor's own steps, in `tests/agent/__golden__/`.

## Important Conventions

- Implement generated Agent management routes and use one handwritten adapter
  over the generated TeamHub callback client.
- TeamHub configuration snapshots contain JSON Agent configuration only.
  Canonical V0 Skill/MCP descriptors may enter the generated protocol; Skill
  archives, secrets, live objects, and caller-owned host paths may not.
- Resolve immutable Skill archives below the trusted Agent dependency root,
  then project verified independent copies into the Runtime workspace. Never
  expose cache directories as writable mounts or share mutable projections.
- Default tests use deterministic providers and fake model calls, and never
  call a live model.
- A structural executor change must reproduce the hook-trace goldens exactly;
  update them with `-u` only for an intended behavior change and say so in
  the commit.
- Keep `agent-manager-process.test.ts` in the `agent-process` Vitest project,
  which runs alone after every other project. It starts the real host with
  `NODE_SERVICES_ROLES=agent`. Its startup wait is a test watchdog, not a
  product SLA; do not mask load contention with retries or by changing product
  Runner, MCP, or WebSocket deadlines.
- Runtime secrets stay in process environment and must not be logged.

- The connected-apps prompt routes new Gmail, Outlook and Feishu Mail emails
  to the canvas Skill and the Human's Send card; replies keep the reply command.
