# TeamHub: Collaboration and persistence authority

Go service owning Human HTTP/SSE, Agent callbacks, and active product state.

## Common Commands

- `go test ./internal/<feature> -run <TestName>`: run one focused Go test from `apps/teamhub`.
- `make -C apps/teamhub check`: run formatting, unit, script, and contract checks
  (doc links run in the root `make check-docs`).
- Before opening a pull request, run `make -C apps/teamhub fmt-check` and
  `go test ./tests/integration/layout -count=1`.
- `make -C apps/teamhub test-integration`: run the default PostgreSQL integration
  suite with plain `go test`. `PARALLEL` overrides go test's `-parallel`
  (default GOMAXPROCS); CI does not run this suite.
- `make -C apps/teamhub test-integration-process` and
  `make -C apps/teamhub test-integration-migrations`: run the build-tagged
  process and fresh-install migration suites.
- `make -C apps/teamhub generate`: regenerate OpenAPI and sqlc outputs after source changes.

## Structure

- `internal/app`: routing, authentication, request decoding, response encoding,
  and error mapping. `app.go` and `feature*.go` build the domain services.
- Connector authorization defaults to the public Web callback. For a desktop
  request, pass only a validated one-time loopback address to Composio.
  TeamHub verifies connection status independently under the signed-in Account.
- Feishu Mail is the one connected app TeamHub runs itself
  (`internal/feishu`, `externalsource/feishu.go`): Composio has no Feishu
  toolkit. Every call runs through the owner's own lark-cli on the online
  Computer that runs their active Another Me
  (`store.GetFeishuMailComputerTarget`): TeamHub sends a `feishu_mail` Computer
  tool call through Node Services (`roomagent.CallLocalComputerToolResult`),
  and the Daemon runs lark-cli against the owner's mailbox API paths only.
  TeamHub keeps no Feishu credentials and needs no Feishu app of its own; the
  Feishu app behind lark-cli must enable the mail scopes the Daemon's
  `localtools.FeishuMailScopes` names. The Apps page never shows Feishu Mail,
  not even under Connected: a person shares it by asking their Another Me, whose
  `teamhub apps connect feishu_mail` posts the chat's `connection_auth` card,
  and the account then shows among Another Me's connectors. Connect checks the
  owner's lark-cli: one already logged in with every mail scope needs no page,
  and otherwise the Computer starts a device login named after the upstream and
  keeps its device code, whose Feishu page is the connect URL. The connection's
  pending checks wait on that login, then read the mailbox address as its
  identity. Without an online Computer, lark-cli, or a scope the app enables,
  connecting answers `FEISHU_COMPUTER_OFFLINE`, `LARK_CLI_NOT_INSTALLED`,
  `LARK_CLI_NOT_CONFIGURED` (installed but never set up with a Feishu app) or
  `FEISHU_SCOPES_NOT_ENABLED`, which the Web shows as steps the Human can
  follow. The install and setup commands live only in `internal/feishu`
  (`InstallCommand`, `SetupCommand`) and reach the Web as `command` error
  details. The connection card and the Feishu Mail management dialog check
  and recheck setup through the same account-scoped endpoint. The check neither
  starts a login nor creates a connection. Connect rechecks readiness before
  creating one. A lark-cli that is only logged out is ready to start OAuth. Any other Computer
  failure is logged with the status and detail the Computer sent. Disconnecting leaves the owner's lark-cli login
  alone. While the Computer is offline, polls, syncs and tool calls fail
  without changing the connection, and a listener catches up from its
  watermark later. An Agent tool call does not check the login first: the
  six-hourly reconcile does, and a call that finds it broken fails as not
  active. lark-cli acts as whoever is logged in to it now, so an identified
  connection is bound to its mailbox address: its first mail call of an
  operation reads the logged-in address, and another mailbox refuses every
  call (`feishu.ErrMailboxChanged`) before anything is read or sent and
  expires the connection at its next check. Its Agent tools (`FEISHU_MAIL_*`) run in
  `externalsource/feishu_mail_tools.go` behind
  `agentconnectedapps.WithNativeToolkit`, so admission, confirmation cards and
  operation IDs match Composio's tools; a confirmed send runs on the Computer
  when the card is approved. A Feishu Mail connection imports no mail from
  before it: its snapshot completes empty and the nightly sync reads the inbox
  and sent folders from the connection time on. Its listener polls the inbox
  against a received-time watermark; a backlog larger than one poll reads is
  read on from its page over the next polls, and the watermark moves past it
  only once all of it is read. Email canvases target `gmail`, `outlook` or
  `feishu_mail`. Gmail and Feishu take one RFC 5322 message; Outlook uses
  Graph JSON drafts with CID inline images and attachment upload sessions.
  Outlook updates replace all attachments and invalidate the old source binding
  before the first write, so partial uploads cannot use an old confirmation.
  Graph's empty 202 acknowledges sending without supplying a sent message ID;
  an uncertain send is never replayed automatically. All three share draft
  bindings and delivery receipts.
- `internal/urlpreview`: `GET /v0/url-preview/framing` reads a page's
  framing rules (`X-Frame-Options`, CSP `frame-ancestors`) for the Web link
  preview panel, which cannot read a cross-origin frame's headers. It sends
  a cookieless HEAD (GET only when the server refuses HEAD, which may spend
  a one-time link), follows up to five redirects itself and answers
  `allowed`, `refused` or `unknown` within five seconds. It requests only
  public addresses, checked at connection time, on ports 80 and 443, reads
  at most 64 KiB of headers and runs at most eight probes at once; others
  answer `unknown` at once. Through the environment's HTTP(S) proxy it checks
  every address the name resolves to before asking; the proxy resolves the
  name again, so only certificates guard https against a name that changes
  its answer in between.
- `internal/<feature>`: business behavior, transactions and data access with
  package tests: `collaboration` (Human Rooms and Messages),
  `agentregistry` (Agents, templates, Skill bindings, Another Me),
  `voice` (voice features), and the older feature packages.
- `internal/store/queries`: sqlc SQL sources; generated files live in `internal/store`.
- `internal/skill`: parses Skill Packages, resolves effective Skill sets, and
  reconciles the repository-level built-in Skill catalog into TeamHub.
- `migrations`: TeamHub-owned schema changes.
- `tests/integration/<feature>`: independent PostgreSQL business test packages.
- `tests/testsupport`: shared database lifecycle and pure harness utilities;
  business fixtures stay in their owning test package.

## Important Conventions

- `another_me_background_failures` counts an Another Me's background model
  calls that failed in a row, as the Agent Service reports them; a completed
  call deletes the row. `GET /v0/tenants/{tenantId}/another-me` carries
  `background_failure` from the third failure on. The `another-me` hint goes
  out when it appears, when its reason changes and when it clears; a higher
  count alone shows on the next fetch. Reason codes TeamHub does not know are
  stored as `unknown`.
- The Human's default Another Me Agent is named `Linger`. Changing the Human's
  name updates the delegate description, never the Agent's display name.
  A forward migration renames generated names; custom Agent names stay.
  The instruction template describes the delegate's role without overriding
  its display name. Template migrations preserve custom instructions and
  advance only the profile configuration revision.
- Gmail canvas drafts persist their source digest alongside the provider draft ID.
  Preparing and executing a send confirmation both check the current authorized
  canvas against that source; changed recipients, body, or attachments require a
  refreshed draft and a new confirmation. Delivery status and link bookkeeping
  do not change the source digest. Draft saves run one at a time per connection under a
  `gmail_canvas_draft_leases` lease that holds no database connection during
  the upload; a save whose lease expired leaves its draft unbound. A save
  waits at most 30 seconds for the lease, then fails as retryable; a lease a
  crashed process left blocks that connection's saves until it expires
  (10 minutes).
  Large MIME drafts use Gmail resumable uploads in bounded chunks through the
  authenticated proxy, avoiding its request-body limit. Each chunk must be fully
  acknowledged; transport failures do not replay a possibly completed write.
- A Human sends a Gmail canvas from its chat card (`internal/mailcanvas`):
  editing only saves the Document; `POST /v0/documents/{id}/mail` carries the
  source digest of the email the card last showed and queues one River
  delivery that uploads the draft and sends it, refusing a canvas that changed
  since. Each canvas has one `mail_canvas_deliveries` row: a `failed` or
  `unknown` delivery may be sent again or declined (an unknown one only after
  the Human checked Gmail), while `declined` (Don't send) and `sent` are final.
  A rejected or interrupted upload is `failed` (it sent nothing); only an
  interrupted or unconfirmed send becomes `unknown`, which is never replayed
  on its own. Sending an `unknown` delivery again whose earlier Gmail draft
  is gone (404; Gmail deletes a draft once it is sent) fails with a
  may-have-been-sent message and starts a new draft next time; other upload
  errors keep the draft. A delivery that is in flight, `sent` or `unknown`
  blocks Voice Live and Agent sends of that canvas, and an Agent's confirmed
  send of a canvas-bound draft records a `sent` (or `unknown`) row, so the
  card cannot send it again. `GET` reports `sent` whenever the header says so, and
  `can_edit`; only editors may send or decline. While the latest content is
  still rendering these routes answer 503 with `Retry-After`.
- The live voice's About the User holds the Human's whole memory.md and the
  email addresses they use: their own (login, active Gmail connection,
  addresses in the current Profile) and up to ten recipients of Gmail canvases
  they sent, read from `document_texts`; all of it goes to the voice provider
  with the instructions. Live writes a recipient as heard and leaves matching
  it to TeamHub: before a canvas write, TeamHub compares each `to`/`cc`
  address not on that list with it, name before `@` and domain apart (edit
  distance, or a shared start with Jaro-Winkler): a close one holds the write
  as `needs_confirmation` with reason `check_recipient` and the suggested
  address (the known one, or the heard name at the known domain). The write
  goes ahead when the model writes the suggestion, or keeps its own with
  `confirmed` once the user stood by it (no recorded question is needed: the
  model may have suggested the known address itself, and sending asks again).
  It never replaces an address itself.
- Live whole-document rewrites preserve top-level image, file, audio and video
  blocks. The model keeps their exported `document-asset:` lines in order;
  missing, repeated or reordered markers are rejected before any write.
  Nested media requires targeted text edits. Text runs are edited from last
  to first with revision checks; a conflict stops the rewrite and reports
  whether earlier runs changed. Gmail canvases keep their separate header,
  body and attachment rules; an inline image still blocks a body rewrite.
- Live voice write tools that finish a send return a `next` asking the model
  to say it was sent; a result without one can leave the voice silent.
- The live voice's persona is warm and lightly playful and says what it does
  in the first person; Voice Runtime's tone rules have each reply open with a
  brief reaction and keep it to two or three short sentences. Humor softens
  when the user is rushed or upset. Started work is not done; its
  acknowledgement must not repeat an already-spoken preamble. Change the
  persona here and the tone rules in Voice Runtime together.
- Live voice writes need the user's yes from a turn after the question
  (`voiceLiveConfirmed`), except `voicelive.DirectYesTools`: sending a Gmail
  canvas, which is open beside the chat, runs when the user's own turn told
  the model to send it and that turn neither asked about it nor wrote,
  changed or attached to a canvas; otherwise the details are read back and
  the yes comes in the user's next turn.

- A Room permits 100 Routines: recurring ones count while they exist, and
  one-shot ones count until they fire. There is no separate one-shot limit.
  Interval Routines store `interval_minutes` (10 to 10080 in 10-minute
  increments), advance on a fixed `dueAt + k * interval` grid without drift or
  catch-up, and skip overlapping scheduled fires while an undelivered quiet
  wake or non-terminal trigger Message from the last 24 hours remains
  unfinished. Agent API, CLI, and Live Voice standardize on `every_n_minutes` +
  `interval_minutes` (and still accept `every_n_hours` + `interval_hours` on
  input for compatibility with older CLI/Desktop builds); Web API keeps
  `every_n_hours` + `interval_hours` for whole-hour intervals and uses
  `every_n_minutes` + `interval_minutes` for non-whole-hour intervals.

- Room input acceptance: Runtime State validates canonical
  conversation/targeted agent_runtime inputs atomically with Local Run and cursor.
  Document reads are live-latest and mutations retain CAS. CLI business
  operations use current Agent/resource authority, not Context/Run prerequisites.

- An Agent writes only in its Context Room. To act in another Room, an
  AnotherMe in its direct chat uses Room handoff (`internal/agentroomhandoff`,
  `teamhub room handoff`): TeamHub posts a hidden `agent_runtime` message,
  authored by the Human and mentioning the AnotherMe, in another live Room
  where both are members, and it wakes the AnotherMe's Context there, which
  then speaks for itself. `teamhub message read --list-inboxes` returns each
  authorized Room's display `name` alongside `inbox_id` so AnotherMe can
  resolve a natural-language Room name to `room:<room-id>` before handing off.
  Only a Run whose inputs carry a message the Human
  wrote, or a card they decided, in the direct chat may hand off
  (`X-TeamHub-Run-Id`); proactive wakes, Routines and Task callbacks may not,
  because they often carry outside content. A refusal names its reason in an
  error issue, which the CLI shows the Agent. The handoff body is hidden from the Web timeline but other
  Agents in that Room can read it. Results come back through
  `send_direct_message`.

- Go generates only types for the contracts TeamHub serves. Mount each
  operation in the caller's route table in `internal/app/routes_*.go`;
  `TestRoutesMountEveryContractOperationExactlyOnce` fails on a missing,
  extra, or wrongly bound route. Handlers are `App` methods that read bound
  query and header parameters with `contractParams[T]` and path parameters
  with `c.Param`.
- Text TeamHub writes for a person to read stays English and ships with the
  meaning the client words it from: a status or error with a stable code, a
  card with its kind and fields, catalog text with its id. Add the code (an
  enum in `contracts/openapi`) beside the English rather than wording it per
  language here; the client keeps the English for a code it does not know.
- `internal/app` opens no transaction and calls no store queries: handlers
  call a domain service and map its errors. `TestAppLayerHoldsNoTransactionsOrQueries`
  (`tests/integration/layout`) fails on a transaction, SQL, a `store.Queries` or
  `pgx.Tx` reference, or the pool outside `app.go` and `feature*.go`. The Task
  and Work Item handlers listed in that test are the only exception.
- New data access uses sqlc queries in `internal/store/queries`; do not add
  hand-written SQL.
- `app.New(ctx, cfg, deps)` builds the App from a complete Config and starts
  nothing; `App.StartWorkers(ctx, skip...)` starts background work. Tests use
  `config.ForTest(...)`, inject fakes through `app.Deps`, and skip the
  `app.Worker` parts they drive; do not add per-test options to `app` or
  default-filling to `New`.
- Call Agent management through one handwritten adapter over the generated Go client.
- Keep TeamHub as an independent Go module; do not introduce `go.work` without a
  second handwritten Go module. Use the repository-local `replace` for the
  generated contracts module.
- The generated contracts module ID is
  `github.com/simplexai-labs/linger/contracts-go`; it resolves only
  through that `replace`.
- Commit a persisted collaboration fact and its Room Event in the same transaction.
- PostgreSQL is recovery authority; SSE is a low-latency wake signal.
- PostgreSQL is also the recovery authority for Agent Runtime configuration,
  Execution Context, accepted input, Inbox cursor, Local Run, RuntimeSession,
  Runtime status coordination, and Local Computer state. Expose
  command-oriented generated APIs; never expose generic table CRUD to Agent
  Service.
- Never import another app's source or log Runtime secrets.
- Before opening or updating a long-lived branch with SQL migrations, fetch
  the current target branch, sync its migrations, and run
  `bash apps/teamhub/scripts/check-migration-history.sh <target-ref>` from the
  repository root; the script requires the target ref. The local check includes uncommitted and new SQL files.
  `00852_baseline.sql` is the schema baseline; nothing below it remains. It
  reuses the version of the last migration it replaced, so a database already
  at 852 skips it and an older one must be recreated.
  Target migration filenames, versions and SQL are immutable; add a
  forward migration above the target's latest version instead of rewriting or
  deleting an existing file. Renumber only unpublished branch migrations and
  update their test fixtures and release references.
  Pull request validation checks changed SQL against the current remote target
  tip, not the older diff base. A missing upstream migration requires syncing
  the target; Git conflict resolution alone does not prove version uniqueness.
  The check compares Git trees, not deployment or Goose database state. If a
  deployment has already applied a branch's version, provide a new forward
  repair rather than editing its recorded history.
- Do not add an empty-database goose UpTo/DownTo integration test for every
  migration. Prove current behavior on the template clone. Fresh-install
  tests use `//go:build integration_migration_history` and stay off the
  default pull request suite. The baseline installs only into an empty database and
  refuses a database that already holds a TeamHub schema; databases created
  before the baseline are recreated, not upgraded. Later versions append
  normal forward migrations.
- Ordinary tests in the main integration package use `newIntegrationDatabase(t)`;
  independent business packages use `tests/testsupport/database.Suite` and call
  its `Run` from `TestMain`. Each test owns a private clone; never seed or migrate
  a caller-supplied database. Only
  `integration_migration_history` tests may use `newEmptyDatabase`
  or call goose `Up`, `UpTo`, or `DownTo` directly.
- Keep integration coverage for PostgreSQL transactions, locks, constraints,
  migrations, and HTTP boundaries. Test pure validation, normalization, state
  transitions, and stable ID generation in the owning package instead.
- A top-level `TestXxx` must not invoke another top-level `TestYyy`; extract a
  non-Test helper when scenarios share setup or assertions.
- Every default top-level `TestXxx` in `tests/integration` must start with exactly
  one marker: `allowParallelIntegrationTest(t)` (runs beside other tests under
  go test's `-parallel`) or
  `serialIntegrationTest(t, reason)`, where `reason` is one of the
  `serialIntegrationReason` constants (`processEnv`, `processLogger`,
  `suiteMeta`, `wallClockBound`, `subprocess`). The Go layout
  test (`tests/integration/layout`) enforces the marker, the reason set, and the
  forbidden body patterns; it caps neither the parallel count nor the test count
  and does not match test names.
- The suite is plain `go test`; there is no shard planner, timing file, test
  binary artifact, or database prefetch pipeline.
  The control connection pool is sized from the effective `-parallel` value + 2.
- A parallel test owns its database, HTTP server, temporary object storage, and
  provider fakes. Its object root comes from `integrationArtifactRoot(t)`, a
  per-test directory of hard links to the template Skill objects;
  `integrationSkillArtifactRoot()` is only the template source. A top-level test
  stays parallel unless it (1) mutates process-global state: environment
  variables, the default slog logger, `GOMAXPROCS`, or the integration
  database suite and its template inspection; (2) spawns subprocesses whose CPU load or shared resources matter; or (3) asserts a
  wall-clock upper bound that load can break. Criterion (3) keeps only the tests
  whose bound is the behavior under test, marked `wallClockBound`; a receive or
  poll used only as a hang guard uses a 30s window instead. Test names never
  decide concurrency. Lock and activity introspection (`pg_locks`,
  `pg_stat_activity`, `pg_blocking_pids`, `pg_terminate_backend`) is allowed in
  parallel tests only when scoped to the test's own database
  (`database = (SELECT oid FROM pg_database WHERE datname = current_database())`
  for `pg_locks`, `datname = current_database()` for `pg_stat_activity`) or to
  PIDs taken from the test's own pool. Raw `t.Parallel()` calls are forbidden.
- New asynchronous, retried, or periodic TeamHub work runs on River through
  `internal/jobs`. Enqueue with `jobs.InsertTx` in the transaction that commits
  the fact requiring the work, and use River periodic jobs for sweeps.
- Do not add tables or columns for job leases, attempts, retry schedules, or
  outbox delivery, and do not start new polling goroutines in `app.go`.
  Exceptions need sub-second latency or a long-lived connection (realtime/SSE,
  voice, presentation sequence pacing, the River due notifier);
  state the reason in the pull request. SQL that inserts River rows calls
  `notify_river_queue` so the job does not wait for the queue's poll. Such a
  loop is woken on commit and sleeps until its next due time, with a fallback
  of at least one minute; it never polls on a short fixed interval.
- Voice recording timestamps come from a recorder clock distinct from PostgreSQL.
  A recorder is bound to a persisted Capture epoch; normalize a reported start
  earlier than the Capture's clock to that clock before confirming its timeline.
  A missing start stays unconfirmed. Keep audio duration and transcript offsets
  on the confirmed timeline, and enqueue an already-requested Stop when the
  initial recorder becomes known, including after restart reconciliation.
  Every voice job retries a failing step, so give each wait that a person sees
  a terminal that outlasts a dependency outage. After Stop, a failed
  reconciliation of an epoch whose recorder sent its terminal receipt spends
  the epoch's `stop_reconcile_failures` budget with the shared `voiceRetryDelay`
  backoff; an exhausted budget fails the Capture with that epoch so its voice
  session can close. Never fail an epoch whose recorder may still write its
  staging: it keeps its owed stop. A shutdown or not-yet-due deferral spends
  nothing.
- A stopped Capture whose recorder saved no audio is not failed outright: its
  epoch fails with `audio_unavailable` and materialization finalizes the
  Capture from its live transcript, without an audio Document, once that
  transcript has speech, kept its integrity and is covered up to its frozen
  end (Stop, or the earlier end of the input track). Completion then writes the
  transcript Document, the completion Message (transcript card only) and Quick
  Notes, and the Meeting Wiki picks it up as any finalized recording. The
  Meetings browser still lists only recordings with audio. Without speech,
  integrity or coverage within the transcript wait, the Capture fails.
- Voice: `TEAMHUB_VOICE_MEDIA` (`on` by default) builds the voice media plane
  over LiveKit; `off`, a missing `LINGER_SECRET_SEED`, or missing ffmpeg keep
  voice off (the last two log `voice.media_unavailable`) without stopping
  TeamHub.
  `internal/voicekey` resolves the Soniox and xAI keys at each use, the
  environment key over one saved in the product (`voice_provider_keys`, sealed
  with `TEAMHUB_SECRET_ENCRYPTION_KEY`), so a save applies without a restart
  on every replica. A save wakes the Node Services voice workers best effort.
  Only a save checks a key with its provider, never a use. A Soniox key is
  also probed on the realtime stream (the start request, no audio, five
  seconds at most), and Soniox's HTTP status gives a refusal its code
  (`VOICE_KEY_REJECTED`, `VOICE_KEY_NO_BALANCE`,
  `VOICE_KEY_NO_REALTIME_PERMISSION`, else `VOICE_PROVIDER_UNAVAILABLE`).
- Web search: `internal/websearch` runs Agent searches and page reads through
  Tavily, Brave, Firecrawl and You.com with deployment-wide keys in
  `web_search_keys` (sealed with `TEAMHUB_SECRET_ENCRYPTION_KEY`, read at each
  call) and the chosen default in `web_search_settings`. TeamHub calls only the
  providers' fixed API hosts; the CLI reads `direct` pages itself. A search
  without a backend runs the chosen default as if it were named, even when its
  key stopped working; without one it uses the first backend with a usable key,
  else You.com's keyless MCP trial, which TeamHub does not count. A failed call
  never falls back to another backend. `include_quota=false` lists the
  backends without calling any provider. A missing or refused key,
  or the end of the trial, posts a `search_key` card that stores the request.
  A key added from that card replays the request first: a provider 401/403
  leaves the key unsaved and the card open; any other outcome saves it and
  answers the card `configured` with the backend and the call's results or
  error code. Any save answers every other pending card `configured` with the
  saved backend, which the Agent reruns with; saves outside a card use the
  official check (Brave has none and stays unverified until its first call).
- Local models: `local_computer_model_snapshots` keeps each Computer's latest
  model library snapshot and the last host any snapshot carried; removing the
  Computer deletes the row in the same transaction. Recording a snapshot
  publishes a `local-models` invalidation (id is the Computer ID) to the
  owner's Tenant. Any member of the Computer's Tenant reads the library;
  `used_by` lists active Agents on runtime `pi` on that Computer whose
  `runtime_model` equals the model's `pi_model` exactly (loaded or not), limited to the
  Agents the reader sees in the Agent directory. Only the owner acts
  (`LOCAL_MODEL_ACTION_FORBIDDEN`), and only while the Computer is online by
  the Computers page's 60-second rule (`LOCAL_COMPUTER_OFFLINE`). `POST .../local-models`
  (`refreshLocalComputerModels`) forwards an empty-model `refresh` command through
  the same owner/online gate, while `POST .../local-models/{modelId}/actions` acts on
  one model (`refresh` stays invalid there). A connected Computer that has not
  decided within the action's 30 seconds answers 504
  `LOCAL_MODEL_ACTION_UNCONFIRMED`: it may still act, and the snapshots show
  the outcome. The Computer's refusal codes map to `LocalModelsErrorCode` in
  `internal/app/handlers_local_models.go` (and `LOAD_NO_ROOM` / `MEMORY_INSUFFICIENT`
  map to `LOCAL_MODEL_NO_ROOM` and `BYOK_GATEWAY_FAILED` maps to HTTP 502
  `BYOK_GATEWAY_FAILED` with the Computer's diagnostic message and a `gateway`
  detail entry in `internal/app/handlers_model_source.go`).
- A Computer's model source lives on the Computer
  (`internal/app/handlers_model_source.go`); TeamHub never stores a BYOK key.
  A switch checks for running work, runs `apply` on the Computer, then moves
  the owner's Agents on it in one transaction
  (`agentregistry.SwitchComputerRuntime`). Both `apply` and the Agent switch run
  under a context detached from the HTTP client's cancellation (bounded by
  `modelSourceApplyLifetime`, 190 s) so navigating away mid-switch cannot leave
  the Computer switched while TeamHub Agents remain on the old Runtime model.
  TeamHub rejects invalid `apply` statuses (empty `runtime_model` or mismatched
  `mode`) before updating Agents. Work found before `apply` refuses the switch
  with `AGENT_HAS_ACTIVE_RUNS` unless the owner sent `force_terminate`; work
  that starts during `apply` keeps only its Agent behind, answered with the same
  code after the others moved. Allowlisted BYOK endpoint refusals and
  `BYOK_GATEWAY_FAILED` forward Computer messages scrubbed of credentials, URL
  query strings/userinfo, and user-home paths (`safeComputerMessage`), unmapped
  refusals return generic `MODEL_SOURCE_FAILED` (HTTP 502), and timeouts,
  `MODEL_SOURCE_EXPIRED`, or client disconnects return `MODEL_SOURCE_UNCONFIRMED`
  (HTTP 504).
- Do not add write-only audit, event, or provenance tables. A new audit table
  needs a named product or compliance reader in the same pull request.
