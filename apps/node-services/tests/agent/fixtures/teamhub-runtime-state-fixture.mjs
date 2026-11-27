import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const createTeamHubRuntimeStateFixture = ({
  serviceToken,
  inboxStateFile,
  defaultRunReplied = true,
  hasRunReplied,
}) => {
  const wakeClients = new Set();
  let currentEpoch = null;
  const computers = new Map();
  const configs = new Map();
  const deletedConfigs = new Map();
  const contexts = new Map();
  const contextStates = new Map();
  const daemonIdentities = new Map();
  const runtimeRegistrations = new Map();
  const runtimeAssignments = new Map();
  const reconciliations = new Map();
  const localModels = new Map();
  const runOperations = new Map();
  const runStartedAtMs = new Map();
  const receipts = [];
  let receiptOrder = 0;
  let runSequence = 0;

  const ensureRuntimeRegistration = ({
    computerId,
    daemonId,
    tenantId,
    ownerActorId,
    providerType,
    seenAt,
    runtimeDiagnostics,
  }) => {
    const placeholderDaemonId = `fixture-daemon-${computerId}`;
    if (daemonId !== placeholderDaemonId) {
      for (const [existingKey, existing] of runtimeRegistrations) {
        if (
          existing.daemon_id === placeholderDaemonId &&
          existing.computer_id === computerId &&
          existing.tenant_id === tenantId &&
          existing.owner_actor_id === ownerActorId &&
          existing.provider_type === providerType
        ) {
          runtimeRegistrations.delete(existingKey);
        }
      }
    }
    const key = [daemonId, tenantId, ownerActorId, providerType].join("\0");
    const current = runtimeRegistrations.get(key);
    const registration = {
      registration_id:
        current?.registration_id ??
        `runtime-registration-${createHash("sha256")
          .update(key)
          .digest("hex")
          .slice(0, 24)}`,
      computer_id: computerId,
      daemon_id: daemonId,
      tenant_id: tenantId,
      owner_actor_id: ownerActorId,
      provider_type: providerType,
      status: "online",
      observed_revision: current?.observed_revision ?? "1",
      capabilities: current?.capabilities ?? [],
      runtime_diagnostics:
        runtimeDiagnostics ?? current?.runtime_diagnostics ?? {},
      last_seen_at: seenAt ?? new Date().toISOString(),
    };
    runtimeRegistrations.set(key, registration);
    return registration;
  };

  const createRun = (contextKey, inputs) => {
    const runId = `local-run-fixture-${++runSequence}`;
    runStartedAtMs.set(runId, Date.now());
    return {
      run_id: runId,
      context_key: contextKey,
      status: "queued",
      attempt_count: 0,
      initial_input_ids: inputs.map((input) => input.input_id),
      steer_input_ids: [],
      input_ids: inputs.map((input) => input.input_id),
    };
  };

  // The Inbox input TeamHub freezes for one Message (see the queue migration).
  const queueInboxRun = (context, state, inbox, message, config) => {
    context.next_input_sequence = increment(context.next_input_sequence);
    const inputId = `inbox-input-fixture-${context.next_input_sequence}-${message.message_id}`;
    const body = message.segments
      .filter((segment) => segment.type === "text")
      .map((segment) => segment.content)
      .join("");
    const input = {
      input_id: inputId,
      payload: {
        messageId: inputId,
        rawMessage: "",
        segments: [{ type: "text", content: "" }],
        sourceInboxIds: [inbox.inbox_id],
        invocationMessageIds: [message.message_id],
        notificationRender: {
          agentName: config.agent.name,
          triggeredAt: new Date().toISOString(),
        },
        acceptedNotification: {
          inboxId: inbox.inbox_id,
          cursorEncoding: "room_event_v1",
          after: String(BigInt(message.sequence) - 1n),
          through: String(message.sequence),
          targeted: true,
          messages: [
            {
              id: message.message_id,
              body,
              author: "Smoke Human",
              authorActorId: message.sender.actor_id,
              authorType: message.sender.type === "agent" ? "agent" : "user",
              mentioned: true,
            },
          ],
        },
      },
      source_kind: "inbox",
      source_message_id: message.message_id,
      source_inbox_id: inbox.inbox_id,
      sequence: context.next_input_sequence,
      status: "handled",
      selection_result: {
        selected: "trusted_inbox_notification",
        effective: "enqueue",
      },
    };
    state.inputs.set(inputId, input);
    const run = createRun(context.context_key, [input]);
    state.runs.set(run.run_id, run);
    input.local_run_id = run.run_id;
    context.state_revision = increment(context.state_revision);
  };

  const authorize = (request, response) => {
    if (request.headers.authorization === `Bearer ${serviceToken}`) return true;
    writeJson(response, 401, { error: "unauthorized" });
    return false;
  };

  const observeContext = (context) => ({ ...context });
  const workStateOf = (contextKey) => {
    const runs = [
      ...requireContextState(contextStates, contextKey).runs.values(),
    ];
    const hasQueuedRuns = runs.some((run) => run.status === "queued");
    return {
      has_queued_runs: hasQueuedRuns,
      has_pending_work:
        hasQueuedRuns || runs.some((run) => run.status === "running"),
    };
  };
  // A write naming an epoch other than the current one is fenced, as in TeamHub.
  const fenced = (body, response) => {
    if (body.epoch === currentEpoch) return false;
    writeJson(response, 409, { error: { code: "CONTEXT_FENCED" } });
    return true;
  };
  const emitWake = (event, data) => {
    for (const response of wakeClients)
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const ensureContext = (ref, targetResidency) => {
    const key = contextKey(ref);
    let context = contexts.get(key);
    const created = !context;
    if (!context) {
      const config = configs.get(ref.agent_id);
      if (!config) return null;
      context = {
        context_key: key,
        ref,
        ...(ref.kind === "meta" ? { room_kind: "collaboration" } : {}),
        tenant_id: config.tenant_id,
        agent_actor_id: config.actor_id,
        target_residency: targetResidency,
        state_revision: "1",
        next_input_sequence: "0",
      };
      contexts.set(key, context);
      contextStates.set(key, createContextState());
      emitWake("context.changed", {
        context_key: key,
        state_revision: context.state_revision,
      });
    }
    return { context: observeContext(context), created };
  };
  return {
    close() {
      for (const response of wakeClients) response.end();
      wakeClients.clear();
    },
    allowsManagedCredential(agentId, tenantId) {
      const config = configs.get(agentId);
      return config !== undefined && config.tenant_id === tenantId;
    },
    async readBusinessInbox(agentId, tenantId, inboxId) {
      const config = configs.get(agentId);
      if (config === undefined || config.tenant_id !== tenantId) return null;
      const data = await readInboxFixture(inboxStateFile);
      const inbox =
        data.tenant_id === tenantId &&
        data.inboxes.find(
          (item) =>
            item.inbox_id === inboxId &&
            item.actor_ids.includes(config.actor_id),
        );
      return inbox
        ? {
            inbox,
            documents: (data.documents ?? []).filter(
              (item) => item.inbox_id === inboxId,
            ),
          }
        : null;
    },
    async handle(request, response, url) {
      const memoryRead =
        request.method === "GET"
          ? /^\/v0\/agent-runtime\/agents\/([^/]+)\/memory$/.exec(url.pathname)
          : null;
      if (memoryRead) {
        if (!authorize(request, response)) return true;
        const config = configs.get(decodeURIComponent(memoryRead[1]));
        if (config === undefined) {
          writeJson(response, 404, { error: "agent_not_found" });
          return true;
        }
        // These Runner fixtures have no published memories. Activation still
        // reads this endpoint when background memory maintenance is disabled.
        writeJson(response, 200, {
          revision: 0,
          summary: "",
          memory: "",
          sessions: {},
          cursors: {},
        });
        return true;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/__test__/inbox-wake"
      ) {
        if (!authorize(request, response)) return true;
        await readJson(request);
        const data = await readInboxFixture(inboxStateFile);
        // TeamHub queues a Run in each Message's transaction; the fixture
        // queues one per newly published Message that mentions the Agent.
        for (const inbox of data.inboxes) {
          if (!inbox.room_id) continue;
          for (const config of configs.values()) {
            if (
              config.tenant_id !== data.tenant_id ||
              !inbox.actor_ids.includes(config.actor_id)
            )
              continue;
            const result = ensureContext(
              {
                kind: "meta",
                agent_id: config.agent_id,
                room_id: inbox.room_id,
              },
              "active",
            );
            if (!result) continue;
            const key = result.context.context_key;
            const state = requireContextState(contextStates, key);
            let queued = false;
            for (const message of inbox.messages) {
              const sequence = BigInt(message.sequence);
              if (
                sequence <=
                BigInt(state.queuedThrough.get(inbox.inbox_id) ?? "0")
              )
                continue;
              state.queuedThrough.set(inbox.inbox_id, String(sequence));
              const mentioned = message.segments.some(
                (segment) =>
                  segment.type === "reference" &&
                  segment.target === config.actor_id,
              );
              if (!mentioned) continue;
              queueInboxRun(contexts.get(key), state, inbox, message, config);
              queued = true;
            }
            if (queued) emitWake("run.queued", { context_key: key });
          }
        }
        writeJson(response, 200, { published: true });
        return true;
      }
      if (
        request.method === "POST" &&
        url.pathname === "/__test__/runtime-configs"
      ) {
        if (!authorize(request, response)) return true;
        const body = await readJson(request);
        const snapshot = configSnapshot(body);
        configs.set(snapshot.agent_id, snapshot);
        deletedConfigs.delete(snapshot.agent_id);
        const placement = snapshot.runtime.placement;
        const boundIdentity = daemonIdentities.get(placement.computer_id);
        if (boundIdentity) {
          const registration = ensureRuntimeRegistration({
            computerId: placement.computer_id,
            daemonId: boundIdentity.daemon_id,
            tenantId: placement.tenant_id,
            ownerActorId: placement.owner_actor_id,
            providerType: placement.runtime_type,
            seenAt: new Date().toISOString(),
          });
          if (!runtimeAssignments.has(snapshot.agent_id)) {
            runtimeAssignments.set(snapshot.agent_id, {
              agent_management_id: snapshot.agent_id,
              agent_actor_id: snapshot.actor_id,
              tenant_id: snapshot.tenant_id,
              registration_id: registration.registration_id,
              assignment_revision: placement.assignment_revision,
            });
          }
        } else {
          const hasMatchingRegistration = [
            ...runtimeRegistrations.values(),
          ].some(
            (registration) =>
              registration.computer_id === placement.computer_id &&
              registration.tenant_id === placement.tenant_id &&
              registration.owner_actor_id === placement.owner_actor_id &&
              registration.provider_type === placement.runtime_type,
          );
          if (!hasMatchingRegistration) {
            ensureRuntimeRegistration({
              computerId: placement.computer_id,
              daemonId: `fixture-daemon-${placement.computer_id}`,
              tenantId: placement.tenant_id,
              ownerActorId: placement.owner_actor_id,
              providerType: placement.runtime_type,
              seenAt: new Date().toISOString(),
            });
          }
        }
        writeJson(response, 200, snapshot);
        return true;
      }
      // Revoking a registration as TeamHub does: its configuration is no
      // longer served, so the Agent Service forgets the Agent.
      const revokedConfig =
        request.method === "DELETE"
          ? /^\/__test__\/runtime-configs\/([^/]+)$/.exec(url.pathname)
          : null;
      if (revokedConfig) {
        if (!authorize(request, response)) return true;
        const agentId = decodeURIComponent(revokedConfig[1]);
        const existing = configs.get(agentId);
        if (existing) {
          deletedConfigs.set(agentId, {
            agent_id: existing.agent_id,
            actor_id: existing.actor_id,
            tenant_id: existing.tenant_id,
            configuration_revision: existing.configuration_revision,
            runtime: structuredClone(existing.runtime),
          });
        }
        configs.delete(agentId);
        runtimeAssignments.delete(agentId);
        response.writeHead(204).end();
        return true;
      }
      // TeamHub enrolls a Computer at credential generation 0; the smoke
      // script records it here and signs the credential as TeamHub does.
      if (
        request.method === "POST" &&
        url.pathname === "/__test__/local-computers"
      ) {
        if (!authorize(request, response)) return true;
        const body = await readJson(request);
        if (!computers.has(body.computer_id)) {
          computers.set(body.computer_id, {
            computer_id: body.computer_id,
            display_name: body.display_name,
            owner: body.owner,
            status: "offline",
            credential_generation: "0",
            runtimes: [],
            runtime_diagnostics: [],
            workspace_grants: [],
          });
        }
        writeJson(response, 200, computers.get(body.computer_id));
        return true;
      }
      if (
        request.method === "GET" &&
        url.pathname === "/__test__/runtime-state"
      ) {
        if (!authorize(request, response)) return true;
        writeJson(response, 200, {
          runs: [...contextStates.entries()].flatMap(([key, state]) => {
            const context = contexts.get(key);
            return [...state.runs.values()].map((run) => ({
              agent_id: context.ref.agent_id,
              context_kind: context.ref.kind,
              run_id: run.run_id,
              status: run.status,
              terminal_type: run.terminal?.type ?? null,
              final_response: run.terminal?.finalResponse ?? null,
            }));
          }),
          operation_receipts: [...runOperations.values()].map((record) => ({
            operation_id: record.operation_id,
            agent_id: record.agent_id,
            run_id: record.run_id,
            context_key: record.context_key,
            runtime_type: record.runtime_type,
          })),
        });
        return true;
      }
      if (!url.pathname.startsWith("/v0/agent-runtime/")) return false;
      if (!authorize(request, response)) return true;
      const route = url.pathname.slice("/v0/agent-runtime/".length);
      if (request.method === "GET" && route === "wakes") {
        response.writeHead(200, {
          "cache-control": "no-cache",
          connection: "keep-alive",
          "content-type": "text/event-stream",
        });
        response.write("event: reconcile\ndata: {}\n\n");
        wakeClients.add(response);
        const keepalive = setInterval(
          () => response.write(": keepalive\n\n"),
          10_000,
        );
        response.once("close", () => {
          clearInterval(keepalive);
          wakeClients.delete(response);
        });
        return true;
      }

      if (request.method === "POST" && route === "epochs") {
        const body = await readJson(request);
        currentEpoch = body.epoch;
        // A new epoch interrupts every running Run; queued Runs stay.
        const interrupted = [];
        for (const state of contextStates.values()) {
          for (const run of state.runs.values()) {
            if (run.status !== "running") continue;
            run.status = "failed";
            run.terminal = { type: "failed", error: "process_interrupted" };
            interrupted.push(run.run_id);
          }
        }
        writeJson(response, 200, {
          interrupted_run_ids: interrupted,
          waiting_context_keys: [...contextStates.keys()].filter(
            (key) => workStateOf(key).has_queued_runs,
          ),
        });
        return true;
      }
      if (request.method === "GET" && route === "config") {
        const config = configs.get(url.searchParams.get("agent_id"));
        writeJson(
          response,
          config ? 200 : 404,
          config ?? { error: "not_found" },
        );
        return true;
      }
      if (request.method === "GET" && route === "deletion-snapshot") {
        const agentId = url.searchParams.get("agent_id");
        const deleted = deletedConfigs.get(agentId);
        if (!deleted) {
          writeJson(response, 404, { error: "not_found" });
          return true;
        }
        writeJson(response, 200, {
          ...deleted,
          contexts: [...contexts.values()]
            .filter((context) => context.ref.agent_id === agentId)
            .map(observeContext),
        });
        return true;
      }
      if (request.method === "GET" && route === "another-me-placements") {
        writeJson(response, 200, { items: [] });
        return true;
      }
      if (
        request.method === "POST" &&
        route === "another-me/background-calls"
      ) {
        await readJson(request);
        response.writeHead(204).end();
        return true;
      }
      if (request.method === "GET" && route === "contexts") {
        const agentId = url.searchParams.get("agent_id");
        writeJson(response, 200, {
          contexts: [...contexts.values()]
            .filter((context) => !agentId || context.ref.agent_id === agentId)
            .map(observeContext),
        });
        return true;
      }
      if (request.method === "POST" && route === "contexts/recently-used") {
        await readJson(request);
        writeJson(response, 200, {
          contexts: [...contexts.values()]
            .filter(
              (context) =>
                (contextStates.get(context.context_key)?.runs.size ?? 0) > 0,
            )
            .map((context) => ({ context_key: context.context_key })),
        });
        return true;
      }
      if (request.method === "GET" && route === "context") {
        const context = contexts.get(url.searchParams.get("context_key"));
        writeJson(
          response,
          context ? 200 : 404,
          context ? observeContext(context) : { error: "not_found" },
        );
        return true;
      }
      if (request.method === "POST" && route === "contexts") {
        const body = await readJson(request);
        const result = ensureContext(body.ref, body.target_residency);
        writeJson(
          response,
          result ? 200 : 404,
          result ?? { error: "config_not_found" },
        );
        return true;
      }
      if (request.method === "POST" && route === "contexts/residency") {
        const body = await readJson(request);
        const context = contexts.get(body.context_key);
        if (!context) {
          writeJson(response, 404, { error: "context_not_found" });
          return true;
        }
        if (context.state_revision !== body.expected_revision) {
          writeJson(response, 409, { error: "revision_conflict" });
          return true;
        }
        const updated = {
          ...context,
          target_residency: body.target_residency,
          state_revision: increment(context.state_revision),
        };
        contexts.set(body.context_key, updated);
        writeJson(response, 200, observeContext(updated));
        return true;
      }
      if (request.method === "POST" && route === "contexts/delete") {
        const body = await readJson(request);
        const context = contexts.get(body.context_key);
        if (!context) {
          writeJson(response, 404, { error: "context_not_found" });
          return true;
        }
        if (
          body.expected_revision !== undefined &&
          context.state_revision !== body.expected_revision
        ) {
          writeJson(response, 409, { error: "revision_conflict" });
          return true;
        }
        contexts.delete(body.context_key);
        contextStates.delete(body.context_key);
        writeJson(response, 200, { deleted: true });
        return true;
      }

      if (request.method === "POST" && route === "contexts/reconcile") {
        await readJson(request);
        writeJson(response, 200, {
          examined_count: 0,
          existing_count: 0,
          created_count: 0,
          created_context_keys: [],
        });
        return true;
      }

      if (request.method === "GET" && route === "work-state") {
        const context = contexts.get(url.searchParams.get("context_key"));
        writeJson(response, 200, {
          ...workStateOf(context.context_key),
          message_steers: [],
        });
        return true;
      }
      if (request.method === "GET" && route === "session") {
        const state = requireContextState(
          contextStates,
          url.searchParams.get("context_key"),
        );
        writeJson(
          response,
          200,
          state.session
            ? { available: true, session: state.session }
            : { available: false },
        );
        return true;
      }
      if (request.method === "POST" && route === "sessions/checkpoint") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const state = requireContextState(contextStates, body.context_key);
        state.session = checkpointSession(state, body.checkpoint);
        writeJson(response, 200, state.session);
        return true;
      }
      if (request.method === "POST" && route === "sessions/clear") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const state = contextStates.get(body.context_key);
        if (!state) {
          writeJson(response, 404, { error: "context_not_found" });
          return true;
        }
        const cleared = state.session !== null;
        state.session = null;
        writeJson(response, 200, { cleared });
        return true;
      }
      if (request.method === "POST" && route === "trusted-turns") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const context = contexts.get(body.context_key);
        const state = requireContextState(contextStates, body.context_key);
        const inputs = [];
        for (const input of body.inputs) {
          if (state.inputs.has(input.input_id)) continue;
          context.next_input_sequence = increment(context.next_input_sequence);
          const stored = {
            ...input,
            sequence: context.next_input_sequence,
            status: "handled",
          };
          state.inputs.set(input.input_id, stored);
          inputs.push(stored);
        }
        if (inputs.length === 0) {
          const existing = [...state.runs.values()].find((run) =>
            run.initial_input_ids.some((inputId) =>
              body.inputs.some((input) => input.input_id === inputId),
            ),
          );
          writeJson(response, 200, { run_id: existing?.run_id ?? "" });
          return true;
        }
        const run = createRun(body.context_key, inputs);
        state.runs.set(run.run_id, run);
        for (const input of inputs) input.local_run_id = run.run_id;
        context.state_revision = increment(context.state_revision);
        writeJson(response, 200, { run_id: run.run_id });
        return true;
      }
      if (request.method === "GET" && route === "runs/waiting") {
        writeJson(response, 200, {
          context_keys: [...contextStates.entries()]
            .filter(([, state]) =>
              [...state.runs.values()].some((run) => run.status === "queued"),
            )
            .map(([key]) => key),
        });
        return true;
      }
      if (request.method === "POST" && route === "runs/claim") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const context = contexts.get(body.context_key);
        const state = requireContextState(contextStates, body.context_key);
        const running = [...state.runs.values()].find(
          (candidate) => candidate.status === "running",
        );
        // A repeated claim returns its Run; another claim waits for it.
        const run = running
          ? running.claim_id === body.claim_id
            ? running
            : undefined
          : [...state.runs.values()].find(
              (candidate) => candidate.status === "queued",
            );
        if (!run) {
          writeJson(response, 200, { claimed: false });
          return true;
        }
        if (run.status === "queued") {
          run.attempt_count = (run.attempt_count ?? 0) + 1;
          run.status = "running";
          run.epoch = body.epoch;
          run.claim_id = body.claim_id;
          runStartedAtMs.set(run.run_id, Date.now());
          context.state_revision = increment(context.state_revision);
        }
        const inputs = run.input_ids.map((inputId) =>
          state.inputs.get(inputId),
        );
        const first = BigInt(inputs[0]?.sequence ?? "0");
        writeJson(response, 200, {
          claimed: true,
          run: {
            run_id: run.run_id,
            attempt_count: run.attempt_count,
            cancellation_requested: Boolean(run.cancellation_requested),
            inputs,
            continues_context: [...state.inputs.values()].some(
              (input) => BigInt(input.sequence) < first,
            ),
          },
        });
        return true;
      }
      if (request.method === "POST" && route === "runs/requeue") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const context = contexts.get(body.context_key);
        const state = contextStates.get(body.context_key);
        const run = state?.runs.get(body.run_id);
        if (!context || !run) {
          writeJson(response, 404, { error: "run_not_found" });
          return true;
        }
        if (run.status === "running") {
          run.status = "queued";
          delete run.claim_id;
          delete run.epoch;
          context.state_revision = increment(context.state_revision);
        }
        writeJson(response, 200, { success: true });
        return true;
      }
      if (request.method === "GET" && route === "run") {
        const state = requireContextState(
          contextStates,
          url.searchParams.get("context_key"),
        );
        const run = state.runs.get(url.searchParams.get("local_run_id"));
        writeJson(response, run ? 200 : 404, run ?? { error: "run_not_found" });
        return true;
      }
      if (request.method === "GET" && route === "runs/reply-status") {
        const key = url.searchParams.get("context_key");
        const runId = url.searchParams.get("local_run_id");
        const context = contexts.get(key);
        const state = contextStates.get(key);
        const run = state?.runs.get(runId);
        if (!context || !run) {
          writeJson(response, 404, { error: "run_not_found" });
          return true;
        }
        const replied =
          typeof hasRunReplied === "function"
            ? Boolean(
                hasRunReplied({
                  contextKey: key,
                  runId,
                  agentId: context.ref.agent_id,
                  roomId:
                    context.ref.kind === "meta" ? context.ref.room_id : null,
                  startedAtMs: runStartedAtMs.get(runId) ?? 0,
                }),
              )
            : Boolean(defaultRunReplied);
        writeJson(response, 200, { replied });
        return true;
      }
      if (request.method === "POST" && route === "runs/operations") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const context = contexts.get(body.context_key);
        const existing = runOperations.get(body.operation_id);
        runOperations.set(body.operation_id, {
          operation_id: body.operation_id,
          run_id: body.run_id,
          context_key: body.context_key,
          agent_id: context?.ref.agent_id ?? existing?.agent_id ?? null,
          runtime_type: body.runtime_type,
          ...(body.turn_id !== undefined
            ? { turn_id: body.turn_id }
            : existing?.turn_id !== undefined
              ? { turn_id: existing.turn_id }
              : {}),
          ...(body.usage !== undefined
            ? { usage: body.usage }
            : existing?.usage !== undefined
              ? { usage: existing.usage }
              : {}),
        });
        writeJson(response, 200, { success: true });
        return true;
      }
      if (request.method === "POST" && route === "runs/finish") {
        const body = await readJson(request);
        if (fenced(body, response)) return true;
        const context = contexts.get(body.context_key);
        const state = requireContextState(contextStates, body.context_key);
        const run = state.runs.get(body.run_id);
        if (!run) {
          writeJson(response, 404, { error: "run_not_found" });
          return true;
        }
        run.status = body.terminal.type;
        run.terminal = body.terminal;
        if (body.session) {
          state.session = checkpointSession(state, body.session);
        }
        context.state_revision = increment(context.state_revision);
        writeJson(response, 200, {
          run,
          ...(state.session ? { session: state.session } : {}),
        });
        return true;
      }
      if (request.method === "POST" && route === "runs/cancel") {
        const body = await readJson(request);
        const context = contexts.get(body.context_key);
        const state = requireContextState(contextStates, body.context_key);
        const run = state.runs.get(body.run_id);
        if (!run) {
          writeJson(response, 200, { status: "not_found" });
          return true;
        }
        if (run.status !== "queued" && run.status !== "running") {
          writeJson(response, 200, { status: "already_terminal" });
          return true;
        }
        if (run.status === "queued") {
          run.status = "canceled";
          run.terminal = { type: "canceled", reason: "Run canceled" };
          context.state_revision = increment(context.state_revision);
          writeJson(response, 200, { status: "canceled" });
          return true;
        }
        run.cancellation_requested = true;
        context.state_revision = increment(context.state_revision);
        writeJson(response, 200, { status: "cancel_requested" });
        return true;
      }
      if (request.method === "POST" && route === "statuses/open") {
        const body = await readJson(request);
        const context = contexts.get(body.context_key);
        writeJson(response, 200, {
          opened: false,
          ...(context ? {} : { error: "context_not_found" }),
        });
        return true;
      }
      if (request.method === "POST" && route === "presentation-events/offer") {
        await readJson(request);
        writeJson(response, 200, { accepted: true, event_ordinal: "1" });
        return true;
      }

      if (
        request.method === "POST" &&
        route === "computer-daemon-identity/bind"
      ) {
        const body = await readJson(request);
        const current = daemonIdentities.get(body.computer_id);
        if (
          current &&
          (current.daemon_id !== body.daemon_id ||
            current.daemon_public_key !== body.daemon_public_key ||
            current.identity_version !== body.identity_version)
        ) {
          writeJson(response, 409, { error: "daemon_identity_conflict" });
          return true;
        }
        daemonIdentities.set(body.computer_id, body);
        writeJson(response, 200, {
          computer_id: body.computer_id,
          daemon_id: body.daemon_id,
        });
        return true;
      }

      if (request.method === "GET" && route === "local-runtime-registrations") {
        writeJson(response, 200, {
          registrations: [...runtimeRegistrations.values()],
        });
        return true;
      }
      if (
        request.method === "POST" &&
        route === "local-runtime-registrations/observe"
      ) {
        const body = await readJson(request);
        const key = [
          body.daemon_id,
          body.tenant_id,
          body.owner_actor_id,
          body.provider_type,
        ].join("\0");
        const current = runtimeRegistrations.get(key);
        const registration = {
          registration_id:
            current?.registration_id ??
            `runtime-registration-${createHash("sha256")
              .update(key)
              .digest("hex")
              .slice(0, 24)}`,
          computer_id: body.computer_id,
          daemon_id: body.daemon_id,
          tenant_id: body.tenant_id,
          owner_actor_id: body.owner_actor_id,
          provider_type: body.provider_type,
          status: body.status,
          observed_revision: body.observed_revision,
          capabilities: body.capabilities,
          runtime_diagnostics: body.runtime_diagnostics,
          last_seen_at: body.seen_at,
          ...(body.status === "offline"
            ? { offline_since: current?.offline_since ?? body.seen_at }
            : {}),
        };
        runtimeRegistrations.set(key, registration);
        writeJson(response, 200, registration);
        return true;
      }
      if (request.method === "GET" && route === "assignments") {
        writeJson(response, 200, {
          assignments: [...runtimeAssignments.values()],
        });
        return true;
      }
      if (request.method === "POST" && route === "assignments/set") {
        const body = await readJson(request);
        const current = runtimeAssignments.get(body.agent_management_id);
        const expectedRevision = current?.assignment_revision ?? "0";
        if (body.expected_revision !== expectedRevision) {
          writeJson(response, 409, { error: "revision_conflict" });
          return true;
        }
        const assignment = {
          agent_management_id: body.agent_management_id,
          agent_actor_id: body.agent_actor_id,
          tenant_id: body.tenant_id,
          registration_id: body.registration_id,
          assignment_revision: increment(expectedRevision),
        };
        runtimeAssignments.set(body.agent_management_id, assignment);
        writeJson(response, 200, assignment);
        return true;
      }

      if (request.method === "GET" && route === "local-computer") {
        const computer = computers.get(url.searchParams.get("computer_id"));
        writeJson(
          response,
          computer ? 200 : 404,
          computer ?? { error: "not_found" },
        );
        return true;
      }
      if (request.method === "GET" && route === "local-computers") {
        writeJson(response, 200, { computers: [...computers.values()] });
        return true;
      }
      if (request.method === "POST" && route === "local-computers/connect") {
        const body = await readJson(request);
        const current = computers.get(body.computer_id);
        if (!current) {
          writeJson(response, 404, {
            error: { code: "NOT_FOUND", message: "Local Computer not found" },
          });
          return true;
        }
        if (
          current.owner?.tenant_id !== body.owner?.tenant_id ||
          current.owner?.owner_actor_id !== body.owner?.owner_actor_id
        ) {
          writeJson(response, 403, {
            error: {
              code: "FORBIDDEN",
              message: "Computer owner does not match",
            },
          });
          return true;
        }
        if (
          String(current.credential_generation) !==
          String(body.credential_generation)
        ) {
          writeJson(response, 401, {
            error: {
              code: "UNAUTHORIZED",
              message: "Computer credential generation mismatch",
            },
          });
          return true;
        }
        const existingIdentity = daemonIdentities.get(body.computer_id);
        const identityConflict =
          (existingIdentity &&
            (existingIdentity.daemon_id !== body.daemon_id ||
              existingIdentity.daemon_public_key !== body.daemon_public_key ||
              String(existingIdentity.identity_version) !==
                String(body.identity_version))) ||
          [...daemonIdentities.entries()].some(
            ([otherComputerId, otherIdentity]) =>
              otherComputerId !== body.computer_id &&
              otherIdentity.daemon_id === body.daemon_id,
          );
        if (identityConflict) {
          writeJson(response, 409, {
            error: {
              code: "DAEMON_IDENTITY_IN_USE",
              message: "Computer daemon identity conflict",
            },
          });
          return true;
        }
        daemonIdentities.set(body.computer_id, {
          computer_id: body.computer_id,
          daemon_id: body.daemon_id,
          daemon_public_key: body.daemon_public_key,
          identity_version: String(body.identity_version),
        });
        const computer = {
          ...current,
          computer_id: body.computer_id,
          display_name:
            body.display_name ?? current.display_name ?? body.computer_id,
          ...(body.platform ? { platform: body.platform } : {}),
          owner: current.owner,
          status: body.status,
          credential_generation: String(current.credential_generation ?? "0"),
          ...(body.seen_at ? { last_seen_at: body.seen_at } : {}),
          runtimes: body.runtimes ?? current.runtimes ?? [],
          runtime_diagnostics:
            body.runtime_diagnostics ?? current.runtime_diagnostics ?? [],
          workspace_grants:
            body.workspace_grants ?? current.workspace_grants ?? [],
        };
        computers.set(body.computer_id, computer);
        for (const runtimeType of computer.runtimes) {
          ensureRuntimeRegistration({
            computerId: body.computer_id,
            daemonId: body.daemon_id,
            tenantId: computer.owner.tenant_id,
            ownerActorId: computer.owner.owner_actor_id,
            providerType: runtimeType,
            seenAt: body.seen_at,
          });
        }
        const placements = [];
        for (const config of configs.values()) {
          if (config.runtime.placement.computer_id !== body.computer_id)
            continue;
          const registration = ensureRuntimeRegistration({
            computerId: body.computer_id,
            daemonId: body.daemon_id,
            tenantId: config.runtime.placement.tenant_id,
            ownerActorId: config.runtime.placement.owner_actor_id,
            providerType: config.runtime.placement.runtime_type,
            seenAt: body.seen_at,
          });
          const existingAssignment = runtimeAssignments.get(config.agent_id);
          const assignmentRevision =
            existingAssignment?.assignment_revision ??
            config.runtime.placement.assignment_revision ??
            "1";
          runtimeAssignments.set(config.agent_id, {
            agent_management_id: config.agent_id,
            agent_actor_id: config.actor_id,
            tenant_id: config.tenant_id,
            registration_id: registration.registration_id,
            assignment_revision: assignmentRevision,
          });
          placements.push({
            agent_id: config.agent_id,
            actor_id: config.actor_id,
            tenant_id: config.tenant_id,
            owner_actor_id: config.runtime.placement.owner_actor_id,
            runtime_type: config.runtime.placement.runtime_type,
            model: config.runtime.model,
            ...(config.runtime.reasoning_effort === undefined
              ? {}
              : { reasoning_effort: config.runtime.reasoning_effort }),
            workspace_grant_id: config.runtime.placement.workspace_grant_id,
            assignment_revision: assignmentRevision,
          });
        }
        writeJson(response, 200, { computer, placements });
        return true;
      }
      if (request.method === "POST" && route === "local-computers/touch") {
        const body = await readJson(request);
        const current = computers.get(body.computer_id);
        if (!current) {
          writeJson(response, 404, { error: "not_found" });
          return true;
        }
        const computer = {
          ...current,
          status: body.status,
          ...(body.seen_at ? { last_seen_at: body.seen_at } : {}),
          ...(body.runtimes !== undefined ? { runtimes: body.runtimes } : {}),
          ...(body.runtime_diagnostics !== undefined
            ? { runtime_diagnostics: body.runtime_diagnostics }
            : {}),
        };
        computers.set(computer.computer_id, computer);
        writeJson(response, 200, computer);
        return true;
      }
      if (request.method === "POST" && route === "local-computers/remove") {
        const body = await readJson(request);
        if (!computers.has(body.computer_id)) {
          writeJson(response, 200, { status: "not_found" });
          return true;
        }
        const hasAgents = [...configs.values()].some(
          (config) => config.runtime.placement.computer_id === body.computer_id,
        );
        if (hasAgents) {
          writeJson(response, 200, { status: "has_agents" });
          return true;
        }
        computers.delete(body.computer_id);
        daemonIdentities.delete(body.computer_id);
        localModels.delete(body.computer_id);
        writeJson(response, 200, { status: "removed" });
        return true;
      }
      if (
        request.method === "POST" &&
        route === "local-computers/local-models"
      ) {
        const body = await readJson(request);
        if (!computers.has(body.computer_id)) {
          writeJson(response, 404, { error: "not_found" });
          return true;
        }
        localModels.set(body.computer_id, body.snapshot);
        response.writeHead(204).end();
        return true;
      }
      if (
        request.method === "POST" &&
        route === "local-computers/mark-offline"
      ) {
        for (const [id, computer] of computers) {
          computers.set(id, { ...computer, status: "offline" });
        }
        writeJson(response, 200, { success: true });
        return true;
      }
      if (request.method === "POST" && route === "local-computers/observe") {
        const body = await readJson(request);
        const current = computers.get(body.computer_id);
        const computer = {
          computer_id: body.computer_id,
          display_name:
            body.display_name ?? current?.display_name ?? body.computer_id,
          owner: current?.owner ?? body.owners?.[0],
          status: body.status,
          credential_generation: String(current?.credential_generation ?? "0"),
          ...(body.seen_at ? { last_seen_at: body.seen_at } : {}),
          runtimes: body.runtimes ?? current?.runtimes ?? [],
          runtime_diagnostics:
            body.runtime_diagnostics ?? current?.runtime_diagnostics ?? [],
          workspace_grants:
            body.workspace_grants ?? current?.workspace_grants ?? [],
        };
        computers.set(computer.computer_id, computer);
        writeJson(response, 200, computer);
        return true;
      }

      if (request.method === "GET" && route === "runner-reconciliations") {
        writeJson(response, 200, { records: [...reconciliations.values()] });
        return true;
      }
      if (request.method === "POST" && route === "runner-reconciliations/put") {
        const body = await readJson(request);
        const state = body.state;
        const key = [state.computerId, state.tenantId, state.agentId].join(
          "\0",
        );
        const record = { state };
        reconciliations.set(key, record);
        writeJson(response, 200, record);
        return true;
      }
      if (
        request.method === "POST" &&
        route === "runner-reconciliations/purge"
      ) {
        const body = await readJson(request);
        for (const [key, record] of reconciliations) {
          if (record.state.computerId === body.computer_id)
            reconciliations.delete(key);
        }
        writeJson(response, 200, { success: true });
        return true;
      }

      if (
        (request.method === "GET" && route === "runner-receipts") ||
        (request.method === "POST" && route === "runner-receipts/query")
      ) {
        const body = request.method === "POST" ? await readJson(request) : null;
        writeJson(response, 200, {
          records: receipts
            .filter((record) => {
              if (!body) return true;
              const identity = record.receipt.start ?? record.receipt.active;
              if (body.computer_id && identity?.runner_id !== body.computer_id)
                return false;
              if (body.query === "recent") return record.kind !== "execution";
              if (body.query === "pending_recovery")
                return record.kind === "recovery" && !record.receipt.terminal;
              if (body.query === "operation" || body.query === "recovery")
                return (
                  record.kind === body.query &&
                  identity.operation_id === body.operation_id &&
                  identity.generation === body.generation
                );
              if (body.query !== "run_start" || record.kind !== "operation")
                return false;
              return (
                identity.request?.kind === "run.start" &&
                identity.agent_id === body.agent_id &&
                identity.tenant_id === body.tenant_id &&
                identity.room_id === body.room_id &&
                identity.request.run_context?.execution_run_ref === body.run_id
              );
            })
            .slice(body?.query === "recent" ? -(body.limit ?? 1024) : 0),
        });
        return true;
      }
      if (request.method === "POST" && route === "runner-receipts/put") {
        const body = await readJson(request);
        const record = {
          kind: body.kind,
          receipt: body.receipt,
          recorded_order: ++receiptOrder,
        };
        receipts.push(record);
        writeJson(response, 200, record);
        return true;
      }
      if (request.method === "POST" && route === "runner-receipts/purge") {
        const body = await readJson(request);
        const retained = receipts.filter((record) => {
          const identity = record.receipt.start ?? record.receipt.active;
          return identity?.runner_id !== body.computer_id;
        });
        receipts.splice(0, receipts.length, ...retained);
        writeJson(response, 200, { success: true });
        return true;
      }

      process.stderr.write(
        `[runtime-state-fixture] missing ${request.method} ${route}\n`,
      );
      writeJson(response, 404, {
        error: "runtime_state_fixture_route_missing",
      });
      return true;
    },
  };
};

// Only deterministic smoke input, not a filesystem projection or PG authority.
const readInboxFixture = async (filename) =>
  filename ? JSON.parse(await readFile(filename, "utf8")) : { inboxes: [] };
const configSnapshot = (body) => {
  const registration = body.registration;
  const placement = registration.runtime.placement;
  const revision = String(registration.revision ?? "1");
  const assignmentRevision = String(placement.assignmentRevision ?? "1");
  const canonicalPayload = {
    agent_id: registration.agentId,
    actor_id: `actor-${registration.agentId}`,
    tenant_id: registration.tenantId,
    configuration_revision: revision,
    runtime_configuration_revision: revision,
    agent: registration.agent,
    runtime: {
      type: "local",
      model: registration.runtime.model,
      ...(registration.runtime.reasoningEffort === undefined
        ? {}
        : { reasoning_effort: registration.runtime.reasoningEffort }),
      placement: {
        tenant_id: placement.tenantId,
        owner_actor_id: placement.ownerActorId,
        computer_id: placement.computerId,
        runtime_type: placement.runtimeType,
        workspace_grant_id: placement.workspaceGrantId,
        assignment_revision: assignmentRevision,
      },
    },
    resources: {
      skills: registration.resources.skills,
      mcp_servers: registration.resources.mcpServers,
    },
  };
  return {
    ...canonicalPayload,
    permission_review: false,
    content_hash: createHash("sha256")
      .update(JSON.stringify(canonicalPayload))
      .digest("hex"),
  };
};

const contextKey = (ref) =>
  JSON.stringify(
    ref.kind === "meta"
      ? ["meta", ref.agent_id, "room", ref.room_id]
      : ["alter_ego", ref.agent_id, ref.task_id],
  );

const createContextState = () => ({
  queuedThrough: new Map(),
  inputs: new Map(),
  runs: new Map(),
  session: null,
});

const requireContextState = (states, key) => {
  const state = states.get(key);
  if (!state)
    throw new Error(`Runtime State fixture Context ${key} was not found`);
  return state;
};

const checkpointSession = (state, checkpoint) => ({
  ...checkpoint,
  revision: increment(state.session?.revision ?? "0"),
  updated_at: new Date().toISOString(),
});

const increment = (value) => (BigInt(value) + 1n).toString();

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const encoded = Buffer.concat(chunks).toString("utf8");
  return encoded ? JSON.parse(encoded) : {};
};

const writeJson = (response, status, body) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
