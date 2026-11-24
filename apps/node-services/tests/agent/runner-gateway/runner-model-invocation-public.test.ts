import type {
  ModelInvoke,
  ModelInvokeCancel,
  ModelInvoked,
  OperationStart,
  RunnerHello,
} from "@linger/wire-contracts/runner-gateway/types";
import { createRuntimeModelCall } from "../../../src/runtime-model-call.js";
import { runtimeModelGateway } from "../../../src/agent/runner-gateway/runtime-model-gateway.js";
import { describe, expect, it, vi } from "vitest";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import type {
  RunnerGateway,
  RunnerGatewayConnection,
  RunnerModelInvokeRequest,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { RunnerModelInvokeUnavailableError } from "../../../src/agent/runner-gateway/runner-gateway.js";
import { RunnerModelInvokeYieldedError } from "../../../src/agent/runner-gateway/runner-model-invocation.js";
import {
  modelCallPolicies,
  type ModelCallKind,
} from "../../../src/model-tasks.js";
import { CURRENT_RUNNER_CAPABILITIES } from "../test-support/runner-capabilities.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import {
  acceptReadyConnection,
  defaultAgentPlacement,
  hello,
  RecordingPeer,
  event,
  settlesWithin,
  sequenceIds,
  sessionTarget,
} from "./runner-gateway-fixtures.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

/** A Computer whose Runtime reaches its model through a gateway, so it runs
 * one unit at a time. */
const invokingHello = (): RunnerHello => ({
  ...hello(),
  capabilities: [...CURRENT_RUNNER_CAPABILITIES],
  runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
});

const queued = (kind: ModelCallKind, runOperationId?: string) => ({
  priority: modelCallPolicies[kind].priority,
  kind,
  key: `${kind}:test`,
  ...(runOperationId ? { runOperationId } : {}),
});

const request = (
  overrides: Partial<RunnerModelInvokeRequest> = {},
): RunnerModelInvokeRequest => ({
  tenantId: "tenant-acme",
  ownerActorId: "human-alice",
  agentId: "agent-another-me",
  runtimeType: "codex",
  mode: "structured",
  reasoningEffort: "low",
  instructions: "Summarize.",
  input: "Notes",
  outputSchema: { type: "object" },
  timeoutMs: 60_000,
  queue: queued("memory"),
  signal: new AbortController().signal,
  ...overrides,
});

const sentInvocations = (peer: RecordingPeer): ModelInvoke[] =>
  peer.sent.filter(
    (envelope): envelope is ModelInvoke =>
      envelope.type === "execute" && envelope.kind === "model_invoke",
  );

const sentCancels = (peer: RecordingPeer): ModelInvokeCancel[] =>
  peer.sent.filter(
    (envelope): envelope is ModelInvokeCancel =>
      envelope.type === "cancel" && envelope.target === "model_invoke",
  );

const invoked = (
  connection: RunnerGatewayConnection,
  command: Pick<ModelInvoke, "command_id" | "invoke_id">,
  outcome: "completed" | "unavailable" | "canceled" = "completed",
  usage?: ModelInvoked["usage"],
) =>
  connection.receive({
    type: "executed",
    kind: "model_invoke",
    command_id: command.command_id,
    runner_id: "runner-local",
    invoke_id: command.invoke_id,
    outcome,
    ...(outcome === "completed" ? { text: '{"summary":"ok"}' } : {}),
    duration_ms: 900,
    ...(usage ? { usage } : {}),
  });

const connect = async (
  value: RunnerHello = invokingHello(),
  placement = defaultAgentPlacement(),
): Promise<{
  gateway: RunnerGateway;
  peer: RecordingPeer;
  connection: RunnerGatewayConnection;
}> => {
  const gateway = createTestRunnerGateway({
    createId: sequenceIds(),
  });
  const peer = new RecordingPeer();
  const connection = await acceptReadyConnection(
    gateway,
    peer,
    value,
    placement,
  );
  return { gateway, peer, connection };
};

describe("RunnerGateway model invocation", () => {
  it("runs Memory and Wiki on a Pi-only Computer", async () => {
    const { gateway, peer, connection } = await connect(
      {
        ...invokingHello(),
        runtimes: ["pi"],
        runtime_diagnostics: runtimeDiagnostics({ ready: ["pi"], link: "api" }),
      },
      defaultAgentPlacement({
        agentId: "agent-another-me",
        runtime: { type: "pi" },
      }),
    );
    const owner = { tenantId: "tenant-acme", ownerActorId: "human-alice" };
    const anotherMe = {
      tenantId: "tenant-acme",
      agentActorId: "actor-another-me",
    };
    const model = createRuntimeModelCall({
      gateway: runtimeModelGateway(gateway),
      placements: async () => [
        {
          ...owner,
          agentId: "agent-another-me",
          agentActorId: anotherMe.agentActorId,
          computerId: "runner-local",
          runtimeType: "pi",
        },
      ],
    });
    try {
      expect(gateway.supportsModelInvoke("runner-local", "pi")).toBe(true);
      const memory = model.chain(
        { kind: "memory", key: "facts", owner },
        (chain) =>
          chain.call({
            step: "extract",
            schemaName: "facts",
            outputSchema: { type: "object" },
            input: "Room fact",
          }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      expect(sentInvocations(peer)[0]).toMatchObject({
        runtime_type: "pi",
        mode: "structured",
      });
      await invoked(connection, sentInvocations(peer)[0]!);
      await expect(memory).resolves.toMatchObject({
        output: { summary: "ok" },
      });

      const wiki = model.chain(
        { kind: "wiki", key: "refresh", anotherMe },
        (chain) => chain.text({ step: "write", input: "Wiki evidence" }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]).toMatchObject({
        runtime_type: "pi",
        mode: "text",
      });
      await invoked(connection, sentInvocations(peer)[1]!);
      await expect(wiki).resolves.toMatchObject({ output: '{"summary":"ok"}' });
    } finally {
      model.close();
      connection.disconnect();
    }
  });

  it.each([
    { daemonVersion: "0.54.0", piReady: true },
    { daemonVersion: "dev", piReady: false },
  ])(
    "never routes an unsupported Pi placement to ready Codex ($daemonVersion, $piReady)",
    async ({ daemonVersion, piReady }) => {
      const { gateway, peer, connection } = await connect({
        ...invokingHello(),
        daemon_version: daemonVersion,
        runtimes: piReady ? ["codex", "pi"] : ["codex"],
        runtime_diagnostics: runtimeDiagnostics({
          ready: piReady ? ["codex", "pi"] : ["codex"],
        }),
      });
      const model = createRuntimeModelCall({
        gateway: runtimeModelGateway(gateway),
        placements: async () => [],
      });
      try {
        expect(gateway.supportsModelInvoke("runner-local", "codex")).toBe(true);
        await expect(
          model.text({
            kind: "memory",
            key: "facts",
            input: "Room fact",
            placement: {
              tenantId: "tenant-acme",
              ownerActorId: "human-alice",
              agentId: "agent-reviewer",
              computerId: "runner-local",
              runtimeType: "pi",
            },
          }),
        ).rejects.toMatchObject({
          kind: "runtime_unavailable",
          message: expect.stringContaining("Pi"),
        });
        expect(sentInvocations(peer)).toEqual([]);
      } finally {
        model.close();
        connection.disconnect();
      }
    },
  );

  it("sends model.invoke and resolves with the Daemon's outcome", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      expect(gateway.supportsModelInvoke("runner-local", "codex")).toBe(true);
      const pending = gateway.invokeModel(
        "runner-local",
        request({
          sessionKey: "permission-review:abc",
          maxOutputChars: 24_000,
        }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const [command] = sentInvocations(peer);
      expect(command).toEqual({
        type: "execute",
        kind: "model_invoke",
        protocol_version: "2",
        command_id: expect.any(String),
        invoke_id: expect.any(String),
        runner_id: "runner-local",
        connection_epoch: expect.any(Number),
        tenant_id: "tenant-acme",
        owner_actor_id: "human-alice",
        agent_id: "agent-another-me",
        runtime_type: "codex",
        mode: "structured",
        reasoning_effort: "low",
        instructions: "Summarize.",
        input: "Notes",
        output_schema: { type: "object" },
        session_key: "permission-review:abc",
        timeout_ms: 60_000,
        max_output_chars: 24_000,
      });
      // A reply for another call is not this one's answer.
      await invoked(connection, { ...command!, invoke_id: "invoke-other" });
      await invoked(connection, command!);
      await expect(pending).resolves.toEqual({
        outcome: "completed",
        text: '{"summary":"ok"}',
        duration_ms: 900,
      });
      expect(peer.closed).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });

  it("starts queued calls by priority as the endpoint frees", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const results = [
        request({ input: "wiki", queue: queued("wiki") }),
        request({ input: "profile", queue: queued("profile") }),
        request({ input: "memory", queue: queued("memory") }),
      ].map((value) => gateway.invokeModel("runner-local", value));
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      expect(sentInvocations(peer)[0]!.input).toBe("wiki");
      // A reply nobody waits for still frees its place.
      await invoked(connection, sentInvocations(peer)[0]!, "unavailable");
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("memory");
      await invoked(connection, sentInvocations(peer)[1]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(3));
      expect(sentInvocations(peer)[2]!.input).toBe("profile");
      await invoked(connection, sentInvocations(peer)[2]!);
      await expect(Promise.all(results)).resolves.toMatchObject([
        { outcome: "unavailable" },
        { outcome: "completed" },
        { outcome: "completed" },
      ]);
    } finally {
      connection.disconnect();
    }
  });

  it("promotes concurrency after a silent background probe stays as fast, and aborts a probe when interactive work arrives", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const usage = {
        input_tokens: 4_000,
        cached_input_tokens: 0,
        output_tokens: 100,
      };
      // Build the single-unit baseline with three background calls.
      for (let i = 0; i < 3; i++) {
        const pending = gateway.invokeModel(
          "runner-local",
          request({ input: `base ${i}`, queue: queued("memory") }),
        );
        await vi.waitFor(() =>
          expect(sentInvocations(peer)).toHaveLength(i + 1),
        );
        await invoked(
          connection,
          sentInvocations(peer)[i]!,
          "completed",
          usage,
        );
        await pending;
      }

      // Two waiting background calls trigger a silent probe for two.
      const probeA = gateway.invokeModel(
        "runner-local",
        request({ input: "probe A", queue: queued("memory") }),
      );
      const probeB = gateway.invokeModel(
        "runner-local",
        request({ input: "probe B", queue: queued("memory") }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(5));
      const [cmdA, cmdB] = sentInvocations(peer).slice(3);

      // Interactive work arriving mid-probe aborts it and yields both probing calls.
      probeA.catch(() => undefined);
      probeB.catch(() => undefined);
      const ask = gateway.invokeModel(
        "runner-local",
        request({ input: "urgent ask", queue: queued("voice_ask") }),
      );
      await vi.waitFor(() => expect(sentCancels(peer)).toHaveLength(2));
      expect(sentCancels(peer).map((cancel) => cancel.invoke_id)).toEqual(
        expect.arrayContaining([cmdA!.invoke_id, cmdB!.invoke_id]),
      );
      await invoked(connection, cmdA!, "canceled");
      await invoked(connection, cmdB!, "canceled");
      await expect(probeA).rejects.toBeInstanceOf(
        RunnerModelInvokeYieldedError,
      );
      await expect(probeB).rejects.toBeInstanceOf(
        RunnerModelInvokeYieldedError,
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(6));
      expect(sentInvocations(peer)[5]!.input).toBe("urgent ask");
      await invoked(connection, sentInvocations(peer)[5]!, "completed", usage);
      await ask;

      // Once foreground work finishes, a clean background probe promotes to two.
      const p1 = gateway.invokeModel(
        "runner-local",
        request({ input: "probe 1", queue: queued("memory") }),
      );
      const p2 = gateway.invokeModel(
        "runner-local",
        request({ input: "probe 2", queue: queued("memory") }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(8));
      const [run1, run2] = sentInvocations(peer).slice(6);
      await invoked(connection, run1!, "completed", usage);
      await invoked(connection, run2!, "completed", usage);
      await Promise.all([p1, p2]);

      // Confirmed limit is now two: two interactive calls run at once.
      const a1 = gateway.invokeModel(
        "runner-local",
        request({ input: "ask 1", queue: queued("approval") }),
      );
      const a2 = gateway.invokeModel(
        "runner-local",
        request({ input: "ask 2", queue: queued("approval") }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(10));
      for (const command of sentInvocations(peer).slice(8))
        await invoked(connection, command, "completed", usage);
      await Promise.all([a1, a2]);
    } finally {
      connection.disconnect();
    }
  });

  it("swaps out a background call holding the only place so recording work starts", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const memory = gateway.invokeModel(
        "runner-local",
        request({ input: "memory" }),
      );
      memory.catch(() => undefined);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const background = sentInvocations(peer)[0]!;
      const notes = gateway.invokeModel(
        "runner-local",
        request({ input: "notes", queue: queued("meeting_notes") }),
      );
      const ask = gateway.invokeModel(
        "runner-local",
        request({ input: "voice", queue: queued("voice_ask") }),
      );
      await vi.waitFor(() =>
        expect(sentCancels(peer)).toEqual([
          expect.objectContaining({
            invoke_id: background.invoke_id,
            connection_epoch: background.connection_epoch,
            reason: "scheduler_yield",
          }),
        ]),
      );
      // The place frees once the Computer answers that the call stopped.
      expect(sentInvocations(peer)).toHaveLength(1);
      await invoked(connection, background, "canceled");
      await expect(memory).rejects.toBeInstanceOf(
        RunnerModelInvokeYieldedError,
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("notes");
      await invoked(connection, sentInvocations(peer)[1]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(3));
      expect(sentInvocations(peer)[2]!.input).toBe("voice");
      await invoked(connection, sentInvocations(peer)[2]!);
      await Promise.all([notes, ask]);
      // Recording work never swaps out other recording work.
      expect(sentCancels(peer)).toHaveLength(1);
    } finally {
      connection.disconnect();
    }
  });

  it("keeps the answer of a background call that finished before its cancel", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const memory = gateway.invokeModel(
        "runner-local",
        request({ input: "memory" }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const notes = gateway.invokeModel(
        "runner-local",
        request({ input: "notes", queue: queued("meeting_notes") }),
      );
      await vi.waitFor(() => expect(sentCancels(peer)).toHaveLength(1));
      await invoked(connection, sentInvocations(peer)[0]!);
      await expect(memory).resolves.toMatchObject({ outcome: "completed" });
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      await invoked(connection, sentInvocations(peer)[1]!);
      await notes;
    } finally {
      connection.disconnect();
    }
  });

  it("keeps recording work queued behind a background call a Computer before 0.53.0 cannot stop", async () => {
    const { gateway, peer, connection } = await connect({
      ...invokingHello(),
      daemon_version: "0.52.0",
    });
    try {
      const memory = gateway.invokeModel(
        "runner-local",
        request({ input: "memory" }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const notes = gateway.invokeModel(
        "runner-local",
        request({ input: "notes", queue: queued("meeting_notes") }),
      );
      const ask = gateway.invokeModel(
        "runner-local",
        request({ input: "voice", queue: queued("voice_ask") }),
      );
      expect(sentInvocations(peer)).toHaveLength(1);
      await invoked(connection, sentInvocations(peer)[0]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("notes");
      await invoked(connection, sentInvocations(peer)[1]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(3));
      expect(sentInvocations(peer)[2]!.input).toBe("voice");
      await invoked(connection, sentInvocations(peer)[2]!);
      await Promise.all([memory, notes, ask]);
      expect(sentCancels(peer)).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });

  it("swaps out a chat Run holding the only place so recording notes complete", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const chat = await gateway.startOperation({
        ...sessionTarget(),
        runKind: "chat",
      });
      const start = peer.sent.find(
        (envelope): envelope is OperationStart =>
          envelope.type === "operation.start",
      )!;
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      await connection.receive(
        event(start, 2, {
          type: "operation.event",
          event: {
            type: "run.started",
            turn_id: "turn-chat",
            session: { threadId: "chat-session", canYield: true },
          },
        }),
      );
      await connection.receive(
        event(start, 3, {
          type: "operation.event",
          event: {
            type: "tool.called",
            call_id: "read",
            tool_name: "read",
            input: {},
          },
        }),
      );
      const notes = gateway.invokeModel(
        "runner-local",
        request({
          input: "notes",
          timeoutMs: 20_000,
          queue: queued("meeting_notes"),
        }),
      );
      await vi.waitFor(() =>
        expect(
          peer.sent.filter((command) => command.type === "cancel"),
        ).toHaveLength(1),
      );
      expect(
        peer.sent.find((command) => command.type === "cancel"),
      ).toMatchObject({
        operation_id: start.operation_id,
        reason: "scheduler_yield",
      });
      expect(sentInvocations(peer)).toHaveLength(0);
      const yielded = expect(chat.result).rejects.toMatchObject({
        session: { threadId: "chat-session" },
      });
      await connection.receive(
        event(start, 4, {
          type: "operation.cancelled",
          reason: "scheduler_yield",
        }),
      );
      await yielded;
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      expect(sentInvocations(peer)[0]).toMatchObject({
        input: "notes",
        timeout_ms: 20_000,
      });
      await invoked(connection, sentInvocations(peer)[0]!);
      await expect(notes).resolves.toMatchObject({ outcome: "completed" });
    } finally {
      connection.disconnect();
    }
  });

  it.each(["next step", "schema correction"] as const)(
    "at one place a chat runs before the Wiki chain's %s",
    async (next) => {
      const { gateway, peer, connection } = await connect();
      const model = createRuntimeModelCall({
        gateway: runtimeModelGateway(gateway),
        placements: async () => [],
      });
      const target = sessionTarget();
      const wiki = model.chain(
        {
          kind: "wiki",
          key: "wiki:interleave",
          placement: {
            tenantId: target.tenantId,
            ownerActorId: target.ownerActorId,
            agentId: target.agentId,
            computerId: target.runnerId,
            runtimeType: "codex",
          },
        },
        async (chain) => {
          if (next === "schema correction") {
            return (
              await chain.call({
                step: "write",
                input: "first",
                schemaName: "page",
                outputSchema: { type: "object", required: ["summary"] },
              })
            ).output;
          }
          const first = await chain.text({ step: "read", input: "first" });
          return (await chain.text({ step: "write", input: first.output }))
            .output;
        },
      );
      try {
        await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
        const chat = gateway.startOperation({ ...target, runKind: "chat" });
        expect(await settlesWithin(chat, 10)).toBe(false);
        const first = sentInvocations(peer)[0]!;
        await connection.receive({
          type: "executed",
          kind: "model_invoke",
          command_id: first.command_id,
          invoke_id: first.invoke_id,
          runner_id: first.runner_id,
          outcome: "completed",
          text: next === "schema correction" ? "{}" : "first result",
          duration_ms: 900,
        });
        const operation = await chat;
        const start = peer.sent.find(
          (envelope): envelope is OperationStart =>
            envelope.type === "operation.start" &&
            envelope.operation_id === operation.operationId,
        )!;
        expect(start.request.run_context.execution_run_ref).toBe(
          target.request.run_context.execution_run_ref,
        );
        expect(sentInvocations(peer)).toHaveLength(1);
        await connection.receive(
          event(start, 1, {
            type: "operation.accepted",
            command_id: start.command_id,
            runner_pid: 100,
          }),
        );
        await connection.receive(
          event(start, 2, {
            type: "operation.completed",
            result: {
              type: "run",
              final_response: "done",
              session: { thread_id: "thread-chat" },
            },
          }),
        );
        await operation.result;
        await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
        const second = sentInvocations(peer)[1]!;
        expect(second.input).toContain(
          next === "schema correction" ? "Required Correction" : "first result",
        );
        await invoked(connection, second);
        await expect(wiki).resolves.toEqual(
          next === "schema correction" ? { summary: "ok" } : '{"summary":"ok"}',
        );
      } finally {
        model.close();
        connection.disconnect();
      }
    },
  );

  it("runs a swapped-out Wiki step again without spending one of its attempts", async () => {
    const { gateway, peer, connection } = await connect();
    const model = createRuntimeModelCall({
      gateway: runtimeModelGateway(gateway),
      placements: async () => [],
    });
    const target = sessionTarget();
    const wiki = model.chain(
      {
        kind: "wiki",
        key: "wiki:yield",
        placement: {
          tenantId: target.tenantId,
          ownerActorId: target.ownerActorId,
          agentId: target.agentId,
          computerId: target.runnerId,
          runtimeType: "codex",
        },
      },
      async (chain) =>
        (await chain.text({ step: "write", input: "page" })).output,
    );
    try {
      // More swaps than the kind's attempts: a swap is not a failed attempt.
      const swaps = modelCallPolicies.wiki.attempts + 1;
      for (let swap = 0; swap < swaps; swap += 1) {
        await vi.waitFor(() =>
          expect(sentInvocations(peer)).toHaveLength(2 * swap + 1),
        );
        const step = sentInvocations(peer)[2 * swap]!;
        expect(step.input).toBe("page");
        const ask = gateway.invokeModel(
          "runner-local",
          request({ input: `ask ${swap}`, queue: queued("voice_ask") }),
        );
        await vi.waitFor(() =>
          expect(sentCancels(peer)).toHaveLength(swap + 1),
        );
        await invoked(connection, step, "canceled");
        await vi.waitFor(() =>
          expect(sentInvocations(peer)).toHaveLength(2 * swap + 2),
        );
        await invoked(connection, sentInvocations(peer)[2 * swap + 1]!);
        await ask;
      }
      await vi.waitFor(() =>
        expect(sentInvocations(peer)).toHaveLength(2 * swaps + 1),
      );
      await invoked(connection, sentInvocations(peer)[2 * swaps]!);
      await expect(wiki).resolves.toBe('{"summary":"ok"}');
    } finally {
      model.close();
      connection.disconnect();
    }
  });

  it("holds the chain's place for a sent step after the caller stops waiting", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const stop = new AbortController();
      const chain = await gateway.acquireModelCall(
        { computerId: "runner-local", runtimeType: "codex" },
        queued("wiki"),
        stop.signal,
      );
      const step = gateway.invokeModel(
        "runner-local",
        request({
          callLease: chain,
          queue: queued("wiki"),
          signal: stop.signal,
        }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const observed = expect(step).rejects.toThrow("caller left");
      stop.abort(new Error("caller left"));
      await observed;
      chain.release({ outcome: "aborted" });
      const ask = gateway.invokeModel(
        "runner-local",
        request({ queue: queued("voice_ask") }),
      );
      expect(await settlesWithin(ask, 10)).toBe(false);
      expect(sentInvocations(peer)).toHaveLength(1);
      await invoked(connection, sentInvocations(peer)[0]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      await invoked(connection, sentInvocations(peer)[1]!);
      await ask;
    } finally {
      connection.disconnect();
    }
  });

  it("runs an approval in the place of the Run it reviews, and queues one for any other Run first", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      await gateway.startOperation(sessionTarget());
      const start = peer.sent.find(
        (command): command is OperationStart =>
          command.type === "operation.start",
      )!;
      const background = gateway.invokeModel(
        "runner-local",
        request({ input: "memory" }),
      );
      const other = gateway.invokeModel(
        "runner-local",
        request({
          input: "other review",
          queue: queued("approval", "operation-elsewhere"),
        }),
      );
      const review = gateway.invokeModel(
        "runner-local",
        request({
          input: "review",
          queue: queued("approval", start.operation_id),
        }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      expect(sentInvocations(peer)[0]!.input).toBe("review");
      await invoked(connection, sentInvocations(peer)[0]!);
      await expect(review).resolves.toMatchObject({ outcome: "completed" });
      connection.disconnect();
      await expect(other).rejects.toBeInstanceOf(LocalComputerOfflineError);
      await expect(background).rejects.toBeInstanceOf(
        LocalComputerOfflineError,
      );
    } finally {
      connection.disconnect();
    }
  });

  it("drops a queued call whose caller stops waiting", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const running = gateway.invokeModel("runner-local", request());
      const controller = new AbortController();
      const queued = gateway.invokeModel(
        "runner-local",
        request({ input: "abandoned", signal: controller.signal }),
      );
      const next = gateway.invokeModel(
        "runner-local",
        request({ input: "next" }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      controller.abort(new Error("caller gave up"));
      await expect(queued).rejects.toThrow("caller gave up");
      await invoked(connection, sentInvocations(peer)[0]!);
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(2));
      expect(sentInvocations(peer)[1]!.input).toBe("next");
      await invoked(connection, sentInvocations(peer)[1]!);
      await Promise.all([running, next]);
    } finally {
      connection.disconnect();
    }
  });

  it("rejects running and queued calls when the Computer disconnects", async () => {
    const { gateway, peer, connection } = await connect();
    const calls = [1, 2, 3].map(() =>
      gateway.invokeModel("runner-local", request()),
    );
    await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
    connection.disconnect();
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(LocalComputerOfflineError);
    }
    await expect(
      gateway.invokeModel("runner-local", request()),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("refuses a Runtime that is not ready", async () => {
    const current = await connect();
    try {
      for (const runtimeType of ["claude", "pi"] as const) {
        expect(
          current.gateway.supportsModelInvoke("runner-local", runtimeType),
        ).toBe(false);
      }
      await expect(
        current.gateway.invokeModel(
          "runner-local",
          request({ runtimeType: "claude" }),
        ),
      ).rejects.toBeInstanceOf(RunnerModelInvokeUnavailableError);
      expect(sentInvocations(current.peer)).toEqual([]);
    } finally {
      current.connection.disconnect();
    }
  });

  it("sends Skill-sized instructions within the 3 MiB prompt", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      const instructions = "i".repeat(250_000);
      const pending = gateway.invokeModel(
        "runner-local",
        request({ instructions }),
      );
      await vi.waitFor(() => expect(sentInvocations(peer)).toHaveLength(1));
      const [command] = sentInvocations(peer);
      expect(command!.instructions).toBe(instructions);
      await invoked(connection, command!);
      await expect(pending).resolves.toMatchObject({ outcome: "completed" });
    } finally {
      connection.disconnect();
    }
  });

  it("sends explicit model only to Computers at or above 0.62.0", async () => {
    const current = await connect({
      ...invokingHello(),
      daemon_version: "0.62.0",
    });
    try {
      const pending = current.gateway.invokeModel(
        "runner-local",
        request({ model: "gpt-5.4" }),
      );
      await vi.waitFor(() =>
        expect(sentInvocations(current.peer)).toHaveLength(1),
      );
      const [command] = sentInvocations(current.peer);
      expect(command!.model).toBe("gpt-5.4");
      await invoked(current.connection, command!);
      await expect(pending).resolves.toMatchObject({ outcome: "completed" });
    } finally {
      current.connection.disconnect();
    }

    const older = await connect({
      ...invokingHello(),
      daemon_version: "0.61.0",
    });
    try {
      const pending = older.gateway.invokeModel(
        "runner-local",
        request({ model: "gpt-5.4" }),
      );
      await vi.waitFor(() =>
        expect(sentInvocations(older.peer)).toHaveLength(1),
      );
      const [command] = sentInvocations(older.peer);
      expect(command!.model).toBeUndefined();
      await invoked(older.connection, command!);
      await expect(pending).resolves.toMatchObject({ outcome: "completed" });
    } finally {
      older.connection.disconnect();
    }
  });

  it("rejects a prompt over 3 MiB before it reaches the Computer", async () => {
    const { gateway, peer, connection } = await connect();
    try {
      await expect(
        gateway.invokeModel(
          "runner-local",
          request({ input: "€".repeat(1_048_577) }),
        ),
      ).rejects.toThrow("Model invocation prompt exceeds 3 MiB");
      expect(sentInvocations(peer)).toEqual([]);
    } finally {
      connection.disconnect();
    }
  });
});
