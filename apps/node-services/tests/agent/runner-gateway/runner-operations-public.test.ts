import { runPriorities, RunPriority } from "../../../src/model-tasks.js";
import { describe, expect, it, vi } from "vitest";
import type {
  AgentToDaemonEnvelope,
  DaemonToAgentEnvelope,
  OperationStart,
} from "@linger/wire-contracts/runner-gateway/types";
import { LocalComputerOfflineError } from "../../../src/agent/runner-gateway/local-computer-management.js";
import {
  RunnerGatewayProtocolError,
  type RunnerGateway,
  type RunnerGatewayConnection,
} from "../../../src/agent/runner-gateway/runner-gateway.js";
import { OPERATION_OUTCOME_UNKNOWN } from "../../../src/agent/runner-gateway/runner-operation.js";
import { createTestRunnerGateway } from "../test-support/runner-gateway.js";
import { readyContextScope } from "../test-support/ready-context-view.js";
import { runtimeDiagnostics } from "./runtime-diagnostics-fixture.js";

import {
  hello,
  contextHello,
  authenticatedPrincipal,
  RecordingPeer,
  placeAgent,
  defaultAgentPlacement,
  localContextViewIdentity,
  acknowledgeEnsuredAgent,
  acceptReadyConnection,
  FailingStartPeer,
  FailingTerminalAckPeer,
  sessionTarget,
  runTarget,
  contextRunTarget,
  event,
  sequenceIds,
  settlesWithin,
  deferred,
} from "./runner-gateway-fixtures.js";

describe("RunnerGateway", () => {
  it("starts a trusted Context Turn naming its Context View", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const placement = defaultAgentPlacement({
      workspaceGrantId: "grant-owner",
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      contextHello(),
      placement,
    );
    const context = localContextViewIdentity();
    const operation = await gateway.startOperation(contextRunTarget(context));
    const start = peer.sent
      .filter((command) => command.type === "operation.start")
      .at(-1);
    if (start?.type !== "operation.start") {
      throw new Error("Expected operation.start");
    }
    expect(start).toMatchObject({
      protocol_version: "2",
      host_access: "trusted",
    });
    expect(start).toMatchObject({
      protocol_version: "2",
      host_access: "trusted",
      workspace_grant_id: "grant-owner",
      context_view_ref: { view_digest: context.viewDigest },
      request: {
        kind: "run.start",
        run_context: {
          execution_run_ref: "local-run-context-1",
        },
      },
    });
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
          session: { thread_id: "thread-1" },
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({ type: "run" });
  });

  it.each([
    ["task", 1],
    ["task", null],
    ["routine", 1],
  ] as const)(
    "waits for confirmed %s cleanup before starting chat (Computer capacity %s)",
    async (runKind, capacity) => {
      const gateway = createTestRunnerGateway({
        createId: sequenceIds(),
        operationCancelTimeoutMs: 10,
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer, {
        ...hello([], capacity),
        runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
      });
      try {
        const task = await gateway.startOperation({
          ...runTarget(),
          runKind,
        });
        const start = peer.sent.find(
          (command) => command.type === "operation.start",
        )!;
        const chat = gateway.startOperation({
          ...runTarget(),
          ...readyContextScope("chat"),
          runKind: "chat",
        });
        await connection.receive(
          event(start, 1, {
            type: "operation.accepted",
            command_id: start.command_id,
            runner_pid: 100,
          }),
        );
        expect(await settlesWithin(chat, 10)).toBe(false);
        expect(peer.sent.some((command) => command.type === "cancel")).toBe(
          false,
        );
        await connection.receive(
          event(start, 2, {
            type: "operation.event",
            event: {
              type: "run.started",
              turn_id: "turn-task",
              session: { threadId: "task-session", canYield: true },
            },
          }),
        );
        expect(peer.sent.some((command) => command.type === "cancel")).toBe(
          false,
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
        expect(await settlesWithin(chat, 25)).toBe(false);
        await connection.receive(
          event(start, 4, {
            type: "operation.event",
            event: {
              type: "human_interaction.requested",
              request: { request_id: "late" },
            },
          }),
        );
        const yielded = expect(task.result).rejects.toMatchObject({
          session: { threadId: "task-session" },
        });
        await connection.receive(
          event(start, 5, {
            type: "operation.cancelled",
            reason: "scheduler_yield",
          }),
        );
        await yielded;
        const events = [];
        for await (const item of task.events) events.push(item.type);
        expect(events).toEqual(["run.started", "tool.called"]);
        const interactive = await chat;
        expect(interactive.operationId).not.toBe(start.operation_id);
        void interactive.result.catch(() => undefined);
      } finally {
        connection.disconnect();
      }
    },
  );

  it.each([1, null])(
    "swaps out a running Task for any Meta Run waiting behind it (Computer capacity %s)",
    async (capacity) => {
      const gateway = createTestRunnerGateway({ createId: sequenceIds() });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer, {
        ...hello([], capacity),
        runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
      });
      try {
        const task = await gateway.startOperation({
          ...runTarget(),
          runKind: "task",
        });
        const start = peer.sent.find(
          (command) => command.type === "operation.start",
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
              turn_id: "turn-task",
              session: { threadId: "task-session", canYield: true },
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
        // A progress follow-up the Meta was claimed for while the Task ran.
        const followUp = gateway.startOperation({
          ...runTarget(),
          ...readyContextScope("meta"),
          runKind: "follow_up",
        });
        await vi.waitFor(() =>
          expect(
            peer.sent.find((command) => command.type === "cancel"),
          ).toMatchObject({
            operation_id: start.operation_id,
            reason: "scheduler_yield",
          }),
        );
        const yielded = expect(task.result).rejects.toMatchObject({
          session: { threadId: "task-session" },
        });
        await connection.receive(
          event(start, 4, {
            type: "operation.cancelled",
            reason: "scheduler_yield",
          }),
        );
        await yielded;
        const meta = await followUp;
        expect(meta.operationId).not.toBe(start.operation_id);
        void meta.result.catch(() => undefined);
      } finally {
        connection.disconnect();
      }
    },
  );

  it.each([
    ["the Computer", 1, "subscription"],
    ["the model endpoint", null, "api"],
  ] as const)(
    "swaps out a Meta Run for one raised to chat while it waits for %s",
    async (_, capacity, link) => {
      const gateway = createTestRunnerGateway({ createId: sequenceIds() });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer, {
        ...hello([], capacity),
        runtime_diagnostics: runtimeDiagnostics({ link }),
      });
      try {
        const routine = await gateway.startOperation({
          ...runTarget(),
          runKind: "routine",
        });
        const start = peer.sent.find(
          (command) => command.type === "operation.start",
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
              turn_id: "turn-routine",
              session: { threadId: "routine-session", canYield: true },
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
        const priority = new RunPriority(runPriorities.follow_up);
        const followUp = gateway.startOperation({
          ...runTarget(),
          ...readyContextScope("other"),
          runKind: "follow_up",
          priority,
        });
        expect(await settlesWithin(followUp, 25)).toBe(false);
        expect(peer.sent.some((command) => command.type === "cancel")).toBe(
          false,
        );
        // A Human's chat queued behind the waiting Run.
        priority.raise(runPriorities.chat);
        await vi.waitFor(() =>
          expect(
            peer.sent.find((command) => command.type === "cancel"),
          ).toMatchObject({
            operation_id: start.operation_id,
            reason: "scheduler_yield",
          }),
        );
        const yielded = expect(routine.result).rejects.toMatchObject({
          session: { threadId: "routine-session" },
        });
        await connection.receive(
          event(start, 4, {
            type: "operation.cancelled",
            reason: "scheduler_yield",
          }),
        );
        await yielded;
        const meta = await followUp;
        void meta.result.catch(() => undefined);
      } finally {
        connection.disconnect();
      }
    },
  );

  it.each([
    ["thinking", { type: "status.changed", status: "thinking" }],
    [
      "streaming its answer",
      { type: "message.delta", message_id: "answer", delta: "Hel" },
    ],
  ] as const)(
    "lets a Codex Run yield to chat once it is %s",
    async (_, work) => {
      const gateway = createTestRunnerGateway({
        createId: sequenceIds(),
        operationCancelTimeoutMs: 10,
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer, {
        ...hello([], 1),
        runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
      });
      try {
        const task = await gateway.startOperation({
          ...runTarget(),
          runKind: "task",
        });
        task.result.catch(() => undefined);
        const start = peer.sent.find(
          (command) => command.type === "operation.start",
        )!;
        const chat = gateway.startOperation({
          ...runTarget(),
          ...readyContextScope("chat"),
          runKind: "chat",
        });
        // The chat never starts here; the disconnect ends its wait.
        chat.then(
          (interactive) => interactive.result.catch(() => undefined),
          () => undefined,
        );
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
              turn_id: "turn-task",
              session: { threadId: "task-session", canYield: true },
            },
          }),
        );
        await connection.receive(
          event(start, 3, {
            type: "operation.event",
            event: { type: "status.changed", status: "working" },
          }),
        );
        expect(await settlesWithin(chat, 10)).toBe(false);
        expect(peer.sent.some((command) => command.type === "cancel")).toBe(
          false,
        );
        await connection.receive(
          event(start, 4, { type: "operation.event", event: work }),
        );
        await vi.waitFor(() =>
          expect(
            peer.sent.find((command) => command.type === "cancel"),
          ).toMatchObject({
            operation_id: start.operation_id,
            reason: "scheduler_yield",
          }),
        );
      } finally {
        connection.disconnect();
      }
    },
  );

  it("yields an Antigravity Run only after native work, keeping its session as a thread", async () => {
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
      operationCancelTimeoutMs: 10,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      {
        ...hello([], 1),
        runtimes: ["antigravity"],
        runtime_diagnostics: runtimeDiagnostics({
          link: "api",
          ready: ["antigravity"],
        }),
      },
      { ...defaultAgentPlacement(), runtime: { type: "antigravity" } },
    );
    try {
      const target = runTarget();
      const task = await gateway.startOperation({
        ...target,
        request: { ...target.request, runtime: { type: "antigravity" } },
        runKind: "task",
      });
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      )!;
      const chat = gateway.startOperation({
        ...target,
        ...readyContextScope("chat"),
        request: { ...target.request, runtime: { type: "antigravity" } },
        runKind: "chat",
      });
      chat.then(
        (interactive) => interactive.result.catch(() => undefined),
        () => undefined,
      );
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
            turn_id: "turn-task",
            session: { threadId: "task-session", canYield: true },
          },
        }),
      );
      // The session exists before its prompt, which Antigravity cannot load.
      expect(await settlesWithin(chat, 10)).toBe(false);
      expect(peer.sent.some((command) => command.type === "cancel")).toBe(
        false,
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
      await vi.waitFor(() =>
        expect(
          peer.sent.find((command) => command.type === "cancel"),
        ).toMatchObject({
          operation_id: start.operation_id,
          reason: "scheduler_yield",
        }),
      );
      const yielded = task.result.then(
        () => undefined,
        (error: unknown) => error,
      );
      await connection.receive(
        event(start, 4, {
          type: "operation.cancelled",
          reason: "scheduler_yield",
        }),
      );
      expect(await yielded).toMatchObject({
        session: { threadId: "task-session" },
      });
      expect(await yielded).not.toHaveProperty("session.sessionId");
    } finally {
      connection.disconnect();
    }
  });

  it("stops a Run whose Computer declined a yield", async () => {
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
      operationCancelTimeoutMs: 1_000,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      {
        ...hello([], 1),
        runtimes: ["antigravity"],
        runtime_diagnostics: runtimeDiagnostics({
          link: "api",
          ready: ["antigravity"],
        }),
      },
      { ...defaultAgentPlacement(), runtime: { type: "antigravity" } },
    );
    try {
      const target = runTarget();
      const task = await gateway.startOperation({
        ...target,
        request: { ...target.request, runtime: { type: "antigravity" } },
        runKind: "task",
      });
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      )!;
      const chat = gateway.startOperation({
        ...target,
        ...readyContextScope("chat"),
        request: { ...target.request, runtime: { type: "antigravity" } },
        runKind: "chat",
      });
      chat.then(
        (interactive) => interactive.result.catch(() => undefined),
        () => undefined,
      );
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
            turn_id: "turn-task",
            session: { threadId: "task-session", canYield: true },
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
      const cancels = () =>
        peer.sent.flatMap((command) =>
          command.type === "cancel" ? [command] : [],
        );
      await vi.waitFor(() =>
        expect(cancels().map((command) => command.reason)).toEqual([
          "scheduler_yield",
        ]),
      );
      // The Computer declined the yield and the Run goes on; Stop must
      // reach it as a Stop, not as the same yield again.
      const stopped = expect(task.result).rejects.toMatchObject({
        code: "cancelled",
      });
      const stopping = task.cancel("user_stop");
      await vi.waitFor(() =>
        expect(cancels().map((command) => command.reason)).toEqual([
          "scheduler_yield",
          "user_stop",
        ]),
      );
      expect(cancels()[1]!.command_id).not.toBe(cancels()[0]!.command_id);
      await connection.receive(
        event(start, 4, { type: "operation.cancelled", reason: "user_stop" }),
      );
      await stopping;
      await stopped;
    } finally {
      connection.disconnect();
    }
  });

  it("keeps a user-stopped Task's place through the cancel timeout and a later chat", async () => {
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
      operationCancelTimeoutMs: 10,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello([], 1),
      runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
    });
    try {
      const task = await gateway.startOperation({
        ...runTarget(),
        runKind: "task",
      });
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      )!;
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      const stopped = expect(task.result).rejects.toMatchObject({
        code: "cancelled",
      });
      await task.cancel("user_stop");
      await connection.receive(
        event(start, 2, {
          type: "operation.event",
          event: { type: "status.changed", status: "working" },
        }),
      );
      const chat = gateway.startOperation({
        ...runTarget(),
        ...readyContextScope("chat"),
        runKind: "chat",
      });
      expect(await settlesWithin(task.result, 15)).toBe(false);
      expect(await settlesWithin(chat, 15)).toBe(false);
      expect(
        peer.sent
          .filter((command) => command.type === "cancel")
          .map((command) => command.reason),
      ).toEqual(["user_stop"]);
      await connection.receive(
        event(start, 3, { type: "operation.cancelled", reason: "user_stop" }),
      );
      await stopped;
      void (await chat).result.catch(() => undefined);
    } finally {
      connection.disconnect();
    }
  });

  it("yields a Claude Run only after it has done model work", async () => {
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
      operationCancelTimeoutMs: 10,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      {
        ...hello([], 1),
        runtimes: ["claude"],
        runtime_diagnostics: runtimeDiagnostics({
          link: "api",
          ready: ["claude"],
        }),
      },
      { ...defaultAgentPlacement(), runtime: { type: "claude" } },
    );
    try {
      const target = runTarget();
      const task = await gateway.startOperation({
        ...target,
        request: { ...target.request, runtime: { type: "claude" } },
        runKind: "task",
      });
      void task.result.catch(() => undefined);
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      )!;
      const chat = gateway.startOperation({
        ...target,
        ...readyContextScope("chat"),
        request: { ...target.request, runtime: { type: "claude" } },
        runKind: "chat",
      });
      chat.then(
        (interactive) => interactive.result.catch(() => undefined),
        () => undefined,
      );
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
            turn_id: "turn-task",
            session: { threadId: "task-session", canYield: true },
          },
        }),
      );
      // A resumable session alone does not make the Run give up its place.
      expect(await settlesWithin(chat, 10)).toBe(false);
      expect(peer.sent.some((command) => command.type === "cancel")).toBe(
        false,
      );
      await connection.receive(
        event(start, 3, {
          type: "operation.event",
          event: { type: "status.changed", status: "thinking" },
        }),
      );
      await vi.waitFor(() =>
        expect(
          peer.sent.find((command) => command.type === "cancel"),
        ).toMatchObject({
          operation_id: start.operation_id,
          reason: "scheduler_yield",
        }),
      );
    } finally {
      connection.disconnect();
    }
  });

  it("asks another Run once a yield is overdue", async () => {
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
      operationYieldDeadlineMs: 20,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello([], 3),
      runtime_diagnostics: runtimeDiagnostics({ link: "subscription" }),
    });
    const startTask = async (name: string, firstSequence: number) => {
      const task = await gateway.startOperation({
        ...runTarget(),
        ...readyContextScope(name),
        runKind: "task",
      });
      void task.result.catch(() => undefined);
      const start = peer.sent
        .filter((command) => command.type === "operation.start")
        .at(-1)!;
      await connection.receive(
        event(start, firstSequence, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      await connection.receive(
        event(start, firstSequence + 1, {
          type: "operation.event",
          event: {
            type: "run.started",
            turn_id: `turn-${name}`,
            session: { threadId: `session-${name}`, canYield: true },
          },
        }),
      );
      await connection.receive(
        event(start, firstSequence + 2, {
          type: "operation.event",
          event: {
            type: "tool.called",
            call_id: `read-${name}`,
            tool_name: "read",
            input: {},
          },
        }),
      );
      return start;
    };
    try {
      // Two Tasks fill the ordinary places and a routine the last one.
      const first = await startTask("task-a", 1);
      const second = await startTask("task-b", 1);
      const routine = await gateway.startOperation({
        ...runTarget(),
        ...readyContextScope("routine"),
        runKind: "routine",
      });
      void routine.result.catch(() => undefined);
      const chat = gateway.startOperation({
        ...runTarget(),
        ...readyContextScope("chat"),
        runKind: "chat",
      });
      chat.then(
        (interactive) => interactive.result.catch(() => undefined),
        () => undefined,
      );
      const yields = () =>
        peer.sent.flatMap((command) =>
          command.type === "cancel" &&
          command.target === "operation" &&
          command.reason === "scheduler_yield"
            ? [command.operation_id]
            : [],
        );
      await vi.waitFor(() => expect(yields()).toHaveLength(1));
      // The first Computer never finishes its yield; after the deadline the
      // other Task is asked instead of the stuck one again.
      await vi.waitFor(() => expect(yields()).toHaveLength(2));
      const [stuck, asked] = yields();
      expect(new Set([stuck, asked])).toEqual(
        new Set([first.operation_id, second.operation_id]),
      );
      const yielded = asked === first.operation_id ? first : second;
      await connection.receive(
        event(yielded, 4, {
          type: "operation.cancelled",
          reason: "scheduler_yield",
        }),
      );
      await expect(chat).resolves.toBeDefined();
      expect(yields()).toHaveLength(2);
    } finally {
      connection.disconnect();
    }
  });

  it("frees a stopped Task's place once its Computer stays silent past the grace", async () => {
    const cancelTimeoutMs = 10;
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
      operationCancelTimeoutMs: cancelTimeoutMs,
      stoppedTaskGraceMs: 1_000,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello([], 1),
      runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
    });
    try {
      const task = await gateway.startOperation({
        ...runTarget(),
        runKind: "task",
      });
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      )!;
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      let taskSettled = false;
      const stopped = expect(
        task.result.finally(() => {
          taskSettled = true;
        }),
      ).rejects.toMatchObject({ code: "cancelled" });
      await task.cancel("user_stop");
      let chatStarted = false;
      const chat = gateway
        .startOperation({
          ...runTarget(),
          ...readyContextScope("chat"),
          runKind: "chat",
        })
        .then((interactive) => {
          chatStarted = true;
          return interactive;
        });
      const starts = () =>
        peer.sent
          .filter((command) => command.type === "operation.start")
          .map((command) => command.execution_context_key);
      // Past the cancel timeout but inside the grace, the stopped Task still
      // holds its places.
      await new Promise((resolve) => setTimeout(resolve, cancelTimeoutMs * 5));
      expect(taskSettled).toBe(false);
      expect(chatStarted).toBe(false);
      expect(starts()).toEqual([start.execution_context_key]);
      // The Computer never confirms the stop, so the Task's model and
      // Computer places go to the chat after the grace.
      await stopped;
      const interactive = await chat;
      void interactive.result.catch(() => undefined);
      expect(starts()).toEqual([start.execution_context_key, "context-chat"]);
      // A late terminal for the released Task is acknowledged and dropped.
      await connection.receive(
        event(start, 2, { type: "operation.cancelled", reason: "user_stop" }),
      );
      expect(peer.sent.at(-1)).toMatchObject({
        type: "operation.ack",
        operation_id: start.operation_id,
        through_seq: 2,
      });
    } finally {
      connection.disconnect();
    }
  });

  it("records the Runtime turn a Run's Operation started as soon as it starts", async () => {
    const recordRunOperation = vi.fn(async () => {});
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
      recordRunOperation,
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      contextHello(),
      defaultAgentPlacement({ workspaceGrantId: "grant-owner" }),
    );
    const operation = await gateway.startOperation({
      ...contextRunTarget(localContextViewIdentity()),
      executionEpoch: "epoch-1",
    });
    const start = peer.sent
      .filter((command) => command.type === "operation.start")
      .at(-1);
    if (start?.type !== "operation.start") {
      throw new Error("Expected operation.start");
    }
    const identity = {
      contextKey: start.execution_context_key,
      epoch: "epoch-1",
      runId: "local-run-context-1",
      operationId: start.operation_id,
      runtimeType: "codex",
    };
    expect(recordRunOperation).toHaveBeenLastCalledWith(identity);
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
        event: { type: "run.started", turn_id: "turn-1" },
      }),
    );
    expect(recordRunOperation).toHaveBeenLastCalledWith({
      ...identity,
      turnId: "turn-1",
    });
    const usage = [
      {
        model: "gpt-test",
        provider: "openai",
        input: 1,
        cache_read: 0,
        cache_write: 0,
        output: 1,
      },
    ];
    await connection.receive(
      event(start, 3, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "done",
          session: { thread_id: "thread-1" },
          usage,
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({ type: "run" });
    expect(recordRunOperation).toHaveBeenLastCalledWith({ ...identity, usage });
    expect(recordRunOperation).toHaveBeenCalledTimes(3);
  });

  it("reserves capacity atomically and cancels waiters", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello([], 1),
      new RecordingPeer(),
    );
    const target = {
      runnerId: "runner-local",
      tenantId: "tenant-acme",
      agentId: "agent-a",
      executionContextKey: "context-a",
    };
    const first = await gateway.acquireOperationCapacity(
      target,
      new AbortController().signal,
    );
    const waiting = new AbortController();
    const second = gateway.acquireOperationCapacity(
      { ...target, executionContextKey: "context-b" },
      waiting.signal,
    );
    const rejected = expect(second).rejects.toThrow();
    waiting.abort(new Error("cancel waiting Run"));
    await rejected;
    first.release();
    const next = await gateway.acquireOperationCapacity(
      target,
      new AbortController().signal,
    );
    next.release();
  });

  it.each([1, 2])(
    "prioritizes chat with a Computer capacity of %i",
    async (hard) => {
      const gateway = createTestRunnerGateway({ createId: sequenceIds() });
      const connection = await gateway.acceptConnection(
        authenticatedPrincipal(),
        hello([], hard),
        new RecordingPeer(),
      );
      const signal = new AbortController().signal;
      const acquire = (
        executionContextKey: string,
        priority: () => Promise<number>,
      ) =>
        gateway.acquireOperationCapacity(
          {
            ...runTarget(),
            executionContextKey,
            priority: { queuedAt: performance.now(), resolve: priority },
          },
          signal,
        );
      try {
        const classify = vi.fn(async () => runPriorities.routine);
        const first = await acquire("routine", classify);
        expect(classify).not.toHaveBeenCalled();
        const order: string[] = [];
        const doc = acquire(
          "document",
          async () => runPriorities.document,
        ).then((p) => {
          order.push("document");
          return p;
        });
        const chat = acquire(
          "interactive",
          async () => runPriorities.chat,
        ).then((p) => {
          order.push("chat");
          return p;
        });
        if (hard === 1) {
          expect(await settlesWithin(chat, 15)).toBe(false);
          first.release();
        }
        const interactive = await chat;
        expect(order).toEqual(["chat"]);
        interactive.release();
        first.release();
        (await doc).release();
        expect(order).toEqual(["chat", "document"]);
      } finally {
        connection.disconnect();
      }
    },
  );

  it("keeps the FIFO position of a waiting Run when its priority is refreshed", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello([], 1),
      new RecordingPeer(),
    );
    const stop = new AbortController();
    const refreshed = new AbortController();
    const acquire = (key: string, queuedAt: number, signal: AbortSignal) =>
      gateway.acquireOperationCapacity(
        {
          ...runTarget(),
          executionContextKey: key,
          priority: { queuedAt, resolve: async () => runPriorities.routine },
        },
        signal,
      );
    try {
      const active = await acquire("active", 0, stop.signal);
      const old = acquire("first", 1, refreshed.signal);
      const second = acquire("second", 2, stop.signal);
      const canceled = expect(old).rejects.toThrow();
      refreshed.abort();
      await canceled;
      const first = acquire("first", 1, stop.signal);
      active.release();
      (await first).release();
      (await second).release();
    } finally {
      stop.abort();
      connection.disconnect();
    }
  });

  it("aborts a waiting startOperation on preemptSignal without sending operation.start, and ignores it once sent", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      {
        ...hello([], 1),
        runtime_diagnostics: runtimeDiagnostics({
          link: "api",
          ready: ["codex"],
        }),
      },
      defaultAgentPlacement(),
    );
    try {
      const target = runTarget();
      const first = await gateway.startOperation({
        ...target,
        runKind: "routine",
      });
      first.result.catch(() => undefined);
      expect(
        peer.sent.filter((command) => command.type === "operation.start"),
      ).toHaveLength(1);

      const stop = new AbortController();
      const preempt = new AbortController();
      const waiting = gateway.startOperation({
        ...target,
        ...readyContextScope("waiting"),
        runKind: "follow_up",
        signal: stop.signal,
        preemptSignal: preempt.signal,
      });
      const reason = new Error("preempted");
      preempt.abort(reason);
      await expect(waiting).rejects.toBe(reason);
      expect(
        peer.sent.filter((command) => command.type === "operation.start"),
      ).toHaveLength(1);

      // Once start is sent, aborting preemptSignal does not cancel it.
      const firstStart = peer.sent.find(
        (command) => command.type === "operation.start",
      )!;
      await connection.receive(
        event(firstStart, 1, {
          type: "operation.accepted",
          command_id: firstStart.command_id,
          runner_pid: 100,
        }),
      );
      await connection.receive(
        event(firstStart, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "done",
            session: { thread_id: "thread-1" },
          },
        }),
      );
      const latePreempt = new AbortController();
      const started = await gateway.startOperation({
        ...target,
        ...readyContextScope("started"),
        runKind: "follow_up",
        preemptSignal: latePreempt.signal,
      });
      started.result.catch(() => undefined);
      expect(
        peer.sent.filter((command) => command.type === "operation.start"),
      ).toHaveLength(2);
      latePreempt.abort(new Error("late preempt"));
      expect(peer.sent.some((command) => command.type === "cancel")).toBe(
        false,
      );
    } finally {
      connection.disconnect();
    }
  });

  it("rejects a capacity reservation for an offline Computer instead of waiting", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    await expect(
      gateway.acquireOperationCapacity(
        {
          runnerId: "runner-local",
          tenantId: "tenant-acme",
          agentId: "agent-a",
          executionContextKey: "context-a",
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(LocalComputerOfflineError);
  });

  it("allows separate Context reservations on upgraded Computers and waits for global capacity", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const greeting = hello([], 2);
    await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...greeting,
      },
      new RecordingPeer(),
    );
    const target = {
      runnerId: "runner-local",
      tenantId: "tenant-acme",
      agentId: "agent-a",
      executionContextKey: "context-a",
    };
    const first = await gateway.acquireOperationCapacity(
      target,
      new AbortController().signal,
    );
    const second = await gateway.acquireOperationCapacity(
      { ...target, executionContextKey: "context-b" },
      new AbortController().signal,
    );
    let acquired = false;
    const third = gateway
      .acquireOperationCapacity(
        { ...target, executionContextKey: "context-c" },
        new AbortController().signal,
      )
      .then((permit) => {
        acquired = true;
        return permit;
      });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(acquired).toBe(false);
    first.release();
    (await third).release();
    second.release();
  });

  it("does not count bound Agent Runners against active Operation capacity", async () => {
    const gateway = createTestRunnerGateway();
    for (const agentId of ["agent-reviewer", "agent-second", "agent-third"])
      placeAgent(gateway, defaultAgentPlacement({ agentId }));
    const peer = new RecordingPeer();
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello([], 1),
        workspace_grants: [
          {
            grant_id: "grant-repo",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );
    for (let ensured = 0; ensured < 3; ensured++)
      await acknowledgeEnsuredAgent(connection, peer, true);

    const permit = await gateway.acquireOperationCapacity(
      {
        runnerId: "runner-local",
        tenantId: "tenant-acme",
        agentId: "agent-third",
        executionContextKey: "context-third",
      },
      new AbortController().signal,
    );
    permit.release();
    connection.disconnect();
  });

  it("admits more than two active Operations when the Computer has no global limit", async () => {
    const agentIds = ["agent-a", "agent-b", "agent-c"];
    const gateway = createTestRunnerGateway({
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    for (const agentId of agentIds) {
      placeAgent(gateway, defaultAgentPlacement({ agentId }));
    }
    const connection = await gateway.acceptConnection(
      authenticatedPrincipal(),
      {
        ...hello([], null),
        workspace_grants: [
          {
            grant_id: "grant-repo",
            tenant_id: "tenant-acme",
            label: "Linger workspace",
            mode: "workspace-write",
            scope: "owner",
          },
        ],
      },
      peer,
    );
    for (const _agentId of agentIds) {
      await acknowledgeEnsuredAgent(connection, peer, true);
    }

    await expect(
      Promise.all(
        agentIds.map((agentId) =>
          gateway.startOperation({
            ...sessionTarget(),
            ...readyContextScope(agentId),
            agentId,
            ownerActorId: "actor-alice",
          }),
        ),
      ),
    ).resolves.toHaveLength(3);
  });

  it("starts a late chat when ordinary work has filled both soft limits", async () => {
    const gateway = createTestRunnerGateway({ createId: sequenceIds() });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello([], 2),
      runtime_diagnostics: runtimeDiagnostics({ link: "subscription" }),
    });
    const endpoint = {
      computerId: "runner-local",
      runtimeType: "codex" as const,
    };
    const stop = new AbortController();
    const wiki = (index: number) =>
      gateway.acquireModelCall(
        endpoint,
        { kind: "wiki", priority: 70, key: String(index) },
        stop.signal,
      );
    // Eight wiki chains and one routine occupy all nine ordinary endpoint places.
    const chains = await Promise.all(
      Array.from({ length: 8 }, (_, i) => wiki(i)),
    );
    const start = (runKind: "routine" | "document" | "chat") =>
      gateway.startOperation({
        ...sessionTarget(),
        ...readyContextScope(runKind),
        runKind,
        signal: stop.signal,
      });
    try {
      const routine = await start("routine");
      const document = start("document");
      const waitingWiki = wiki(8);
      const chat = await start("chat");
      expect(
        peer.sent
          .filter((command) => command.type === "operation.start")
          .map((command) => command.execution_context_key),
      ).toEqual(["context-routine", "context-chat"]);
      expect(await settlesWithin(waitingWiki, 10)).toBe(false);
      const canceled = Promise.all([
        expect(document).rejects.toThrow(),
        expect(waitingWiki).rejects.toThrow(),
      ]);
      stop.abort();
      await canceled;
      void routine.result.catch(() => undefined);
      void chat.result.catch(() => undefined);
    } finally {
      stop.abort();
      for (const chain of chains) chain.release({ outcome: "completed" });
      connection.disconnect();
    }
  });

  it("queues a Run's whole Operation as one unit of its endpoint", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer, {
      ...hello(),
      runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
    });
    const codex = { computerId: "runner-local", runtimeType: "codex" as const };
    try {
      const wiki = await gateway.acquireModelCall(
        codex,
        { priority: 70, kind: "wiki", key: "wiki:test" },
        new AbortController().signal,
      );
      // A running unit is never interrupted: the Run waits for it.
      let sent = false;
      const started = gateway.startOperation(sessionTarget()).then((value) => {
        sent = true;
        return value;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent).toBe(false);
      expect(
        peer.sent.some((command) => command.type === "operation.start"),
      ).toBe(false);
      const memory = gateway.acquireModelCall(
        codex,
        { priority: 40, kind: "memory", key: "memory:test" },
        new AbortController().signal,
      );
      wiki.release({ outcome: "completed" });
      const operation = await started;
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      );
      if (start?.type !== "operation.start")
        throw new Error("Expected operation.start");
      let admitted = false;
      void memory.then(() => (admitted = true));
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      expect(admitted).toBe(false);
      await connection.receive(
        event(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "done",
            session: { thread_id: "thread-1" },
          },
        }),
      );
      await operation.result;
      (await memory).release({ outcome: "completed" });
      expect(admitted).toBe(true);
    } finally {
      connection.disconnect();
    }
  });

  describe("a Run's model requests move its endpoint's limit", () => {
    const codex = { computerId: "runner-local", runtimeType: "codex" as const };
    /** Foreground work, so the place it waits for is not held back. */
    const approval = { priority: 0, kind: "approval", key: "approval:test" };
    const memory = { priority: 40, kind: "memory", key: "memory:test" };

    const connectApi = async () => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 60_000,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer, {
        ...hello(),
        runtime_diagnostics: runtimeDiagnostics({ link: "api" }),
      });
      return { gateway, peer, connection };
    };

    /** Promotes an API endpoint to confirmed limit two via a fast background probe. */
    const promoteToTwo = async (
      gateway: RunnerGateway,
      peer: RecordingPeer,
      connection: RunnerGatewayConnection,
    ) => {
      const usage = {
        input_tokens: 4_000,
        cached_input_tokens: 0,
        output_tokens: 100,
      };
      const answer = async (index: number) => {
        await vi.waitFor(() =>
          expect(
            peer.sent.filter(
              (envelope) =>
                envelope.type === "execute" && envelope.kind === "model_invoke",
            ).length,
          ).toBeGreaterThanOrEqual(index + 1),
        );
        const invoke = peer.sent.filter(
          (envelope) =>
            envelope.type === "execute" && envelope.kind === "model_invoke",
        )[index]!;
        if (invoke.type !== "execute" || invoke.kind !== "model_invoke")
          throw new Error("Expected model_invoke");
        await connection.receive({
          type: "executed",
          kind: "model_invoke",
          command_id: invoke.command_id,
          runner_id: "runner-local",
          invoke_id: invoke.invoke_id,
          outcome: "completed",
          text: '{"summary":"ok"}',
          duration_ms: 900,
          usage,
        });
      };
      const invokeMemory = (input: string) =>
        gateway.invokeModel("runner-local", {
          tenantId: "tenant-acme",
          ownerActorId: "human-alice",
          agentId: "agent-another-me",
          runtimeType: "codex",
          mode: "structured",
          reasoningEffort: "low",
          input,
          timeoutMs: 60_000,
          queue: memory,
          signal: new AbortController().signal,
        });
      for (let i = 0; i < 3; i++) {
        const call = invokeMemory(`base ${i}`);
        await answer(i);
        await call;
      }
      const p1 = invokeMemory("probe 1");
      const p2 = invokeMemory("probe 2");
      await vi.waitFor(() =>
        expect(
          peer.sent.filter(
            (envelope) =>
              envelope.type === "execute" && envelope.kind === "model_invoke",
          ),
        ).toHaveLength(5),
      );
      await answer(3);
      await answer(4);
      await Promise.all([p1, p2]);
    };

    const startRun = async (
      gateway: RunnerGateway,
      peer: RecordingPeer,
      connection: RunnerGatewayConnection,
    ) => {
      const operation = await gateway.startOperation(sessionTarget());
      operation.result.catch(() => undefined);
      const start = peer.sent.find(
        (command) => command.type === "operation.start",
      );
      if (start?.type !== "operation.start")
        throw new Error("Expected operation.start");
      await connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      return { operation, start };
    };

    const respond = async (
      connection: RunnerGatewayConnection,
      start: OperationStart,
      seq: number,
      firstItemMs: number,
    ) => {
      await connection.receive(
        event(start, seq, {
          type: "operation.event",
          event: {
            type: "model.responded",
            started_at_unix_ms: 1_000,
            first_item_at_unix_ms: 1_000 + firstItemMs,
            responded_at_unix_ms: 1_000 + firstItemMs,
            granularity: "item",
            usage: {
              input: 4_000,
              cache_read: 0,
              cache_write: 0,
              output: 50,
            },
          },
        }),
      );
    };

    const admittedLater = (lease: Promise<unknown>) => {
      const state = { admitted: false };
      void lease.then(
        () => (state.admitted = true),
        () => undefined,
      );
      return state;
    };

    it("does not raise an unconfirmed limit on a Run alone, and lowers a confirmed limit when concurrent Run requests slow down", async () => {
      const { gateway, peer, connection } = await connectApi();
      try {
        const { operation, start } = await startRun(gateway, peer, connection);
        const waiting = admittedLater(
          gateway.acquireModelCall(
            codex,
            approval,
            new AbortController().signal,
          ),
        );
        for (let seq = 2; seq <= 5; seq++)
          await respond(connection, start, seq, 2_000);
        await new Promise((resolve) => setImmediate(resolve));
        expect(waiting.admitted).toBe(false);
        await connection.receive(
          event(start, 6, {
            type: "operation.completed",
            result: {
              type: "run",
              final_response: "done",
              session: { thread_id: "thread-1" },
            },
          }),
        );
        await operation.result;
        await vi.waitFor(() => expect(waiting.admitted).toBe(true));
      } finally {
        connection.disconnect();
      }

      // On a confirmed limit of two, slow Run responses at concurrency 2 lower it back to one.
      const promoted = await connectApi();
      try {
        await promoteToTwo(
          promoted.gateway,
          promoted.peer,
          promoted.connection,
        );
        const { start } = await startRun(
          promoted.gateway,
          promoted.peer,
          promoted.connection,
        );
        // Three lone Run responses set the Run baseline at 2 ms.
        for (let seq = 2; seq <= 4; seq++)
          await respond(promoted.connection, start, seq, 2);
        const alongside = await promoted.gateway.acquireModelCall(
          codex,
          approval,
          new AbortController().signal,
        );
        // Hold concurrency 2 longer than each 8 ms response so every sample runs at 2.
        await new Promise((resolve) => setTimeout(resolve, 15));
        for (let seq = 5; seq <= 8; seq++)
          await respond(promoted.connection, start, seq, 8);
        alongside.release({ outcome: "completed" });
        // Limit is back to one: a new foreground call waits while the Run holds it.
        const blocked = admittedLater(
          promoted.gateway.acquireModelCall(
            codex,
            approval,
            new AbortController().signal,
          ),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(blocked.admitted).toBe(false);
      } finally {
        promoted.connection.disconnect();
      }
    });

    it("halves a confirmed limit when the Run fails rate limited", async () => {
      const { gateway, peer, connection } = await connectApi();
      try {
        await promoteToTwo(gateway, peer, connection);
        const { start } = await startRun(gateway, peer, connection);
        const lease = await gateway.acquireModelCall(
          codex,
          approval,
          new AbortController().signal,
        );
        await connection.receive(
          event(start, 2, {
            type: "operation.failed",
            stage: "runtime_execution",
            error: {
              code: "RUNTIME_EXECUTION_FAILED",
              message: "Runtime execution failed",
              retryable: false,
              failure: { code: "rate_limited", runtime_type: "codex" },
            },
          }),
        );
        // Two places would admit it beside the running chain; one does not.
        const next = admittedLater(
          gateway.acquireModelCall(
            codex,
            approval,
            new AbortController().signal,
          ),
        );
        await new Promise((resolve) => setImmediate(resolve));
        expect(next.admitted).toBe(false);
        lease.release({ outcome: "completed" });
        await vi.waitFor(() => expect(next.admitted).toBe(true));
      } finally {
        connection.disconnect();
      }
    });
  });

  it.each(["disconnect", "replacement", "removal"] as const)(
    "rejects a start whose capacity permit predates a %s",
    async (change) => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 60_000,
        createId: sequenceIds(),
      });
      const peer = new RecordingPeer();
      const connection = await acceptReadyConnection(gateway, peer);
      const permit = await gateway.acquireOperationCapacity(
        sessionTarget(),
        new AbortController().signal,
      );
      let replacement: RunnerGatewayConnection | undefined;
      let removal: Promise<unknown> | undefined;
      try {
        if (change === "disconnect") connection.disconnect();
        if (change === "replacement")
          replacement = await acceptReadyConnection(
            gateway,
            new RecordingPeer(),
          );
        if (change === "removal") {
          removal = gateway.finalizeDeletedLocalAgentRunner("agent-reviewer");
          await vi.waitFor(() =>
            expect(peer.sent.at(-1)?.type).toBe("agent_runner.remove"),
          );
        }
        await expect(
          gateway.startOperation({
            ...sessionTarget(),
            capacityPermit: permit,
          }),
        ).rejects.toThrow();
        expect(
          peer.sent.some((command) => command.type === "operation.start"),
        ).toBe(false);
      } finally {
        replacement?.disconnect();
        connection.disconnect();
        await removal;
      }
    },
  );

  it("routes one operation to the exact Runner and deduplicates replayed events", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);

    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex", model: "codex-default" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { threadId: "" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    });

    expect(peer.sent[0]).toMatchObject({
      type: "runner.welcome",
      runner_id: "runner-local",
      reconcile_operation_ids: [],
    });
    const start = peer.sent[1] as OperationStart;
    expect(start).toMatchObject({
      type: "operation.start",
      tenant_id: "tenant-acme",
      runner_id: "runner-local",
      execution_context_key: readyContextScope().executionContextKey,
      context_view_ref: readyContextScope().contextViewRef,
      agent_id: "agent-reviewer",
      workspace_grant_id: "grant-repo",
      generation: 1,
    });

    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
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
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );

    await expect(operation.result).resolves.toEqual({
      type: "run",
      final_response: "",
      session: { thread_id: "thread-1" },
    });
    const acks = peer.sent.filter(
      (envelope) => envelope.type === "operation.ack",
    );
    expect(acks.map((ack) => ack.through_seq)).toEqual([1, 1, 2]);
  });

  it("reconciles and resends the same command after reconnect", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { threadId: "" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    });
    const start = firstPeer.sent[1] as OperationStart;
    first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(
      gateway,
      secondPeer,
      hello([
        {
          tenant_id: start.tenant_id,
          runner_id: start.runner_id,
          protocol_version: start.protocol_version,
          host_access: start.host_access,
          registration_id: start.registration_id,
          assignment_revision: start.assignment_revision,
          execution_context_key: start.execution_context_key,
          runtime_instance_id: start.runtime_instance_id,
          context_view_ref: start.context_view_ref,
          agent_id: start.agent_id,
          operation_id: start.operation_id,
          connection_epoch: start.connection_epoch,
          runner_revision: start.runner_revision,
          generation: start.generation,
          execution_lease_id: start.execution_lease_id,
          workspace_grant_id: start.workspace_grant_id,
          runtime_type: start.runtime_type,
          kind: start.request.kind,
          last_emitted_seq: 0,
          last_acked_seq: 0,
        },
      ]),
    );

    expect(secondPeer.sent[0]).toMatchObject({
      type: "runner.welcome",
      reconcile_operation_ids: [start.operation_id],
    });
    expect(secondPeer.sent[1]).toEqual(start);
    await second.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 101,
      }),
    );
    await second.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({ type: "run" });

    second.disconnect();
    const thirdPeer = new RecordingPeer();
    const third = await acceptReadyConnection(gateway, thirdPeer);
    // The ended Operation is gone; its replayed terminal is acknowledged and
    // dropped.
    expect(thirdPeer.sent[0]).toMatchObject({
      type: "runner.welcome",
      reconcile_operation_ids: [],
    });
    expect(thirdPeer.sent.map((frame) => frame.type)).toEqual([
      "runner.welcome",
    ]);
    await third.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    expect(thirdPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 2,
    });
  });

  it("ends an Operation with the terminal a restarted Daemon numbers from 1", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    void operation.result.catch(() => undefined);
    const start = firstPeer.sent[1] as OperationStart;
    for (const seq of [1, 2])
      await first.receive(
        seq === 1
          ? event(start, 1, {
              type: "operation.accepted",
              command_id: start.command_id,
              runner_pid: 100,
            })
          : event(start, 2, {
              type: "operation.event",
              event: { type: "message.delta", message_id: "m-1", delta: "x" },
            }),
      );
    first.disconnect();

    // The restarted Daemon reports nothing active; the resent start is
    // answered with an interruption it numbers from 1.
    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(gateway, secondPeer);
    expect(secondPeer.sent).toContainEqual(start);
    const interrupted = event(start, 1, {
      type: "operation.failed",
      stage: "runtime_execution",
      error: {
        code: "DAEMON_RESTARTED",
        message: "Local Computer Daemon restarted",
        retryable: false,
      },
    });
    await second.receive(interrupted);
    await expect(operation.result).rejects.toMatchObject({
      code: "DAEMON_RESTARTED",
      retryable: false,
    });
    expect(secondPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 1,
    });
    // Its replay is acknowledged at the same sequence.
    await second.receive(interrupted);
    expect(secondPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 1,
    });
  });

  it("rebases an unaccepted start that the daemon never received", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    const original = firstPeer.sent[1] as OperationStart;
    expect(original.connection_epoch).toBe(1);
    first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(gateway, secondPeer);
    const replay = secondPeer.sent[1];
    expect(replay).toMatchObject({
      type: "operation.start",
      operation_id: original.operation_id,
      command_id: original.command_id,
      connection_epoch: 2,
    });
    if (replay?.type !== "operation.start") {
      throw new Error("Expected rebased operation.start");
    }
    await second.receive(
      event(replay, 1, {
        type: "operation.accepted",
        command_id: replay.command_id,
        runner_pid: 101,
      }),
    );
    await second.receive(
      event(replay, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-rebased" },
        },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({
      type: "run",
      final_response: "",
      session: { thread_id: "thread-rebased" },
    });
    second.disconnect();
  });

  it("ends a rebased start with the terminal the daemon recorded on its first epoch", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    void operation.result.catch(() => undefined);
    const original = firstPeer.sent[1] as OperationStart;
    first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(gateway, secondPeer);
    expect(secondPeer.sent[1]).toMatchObject({
      type: "operation.start",
      connection_epoch: 2,
    });
    // The Daemon failed it on the first connection and replays that terminal.
    await second.receive(
      event(original, 1, {
        type: "operation.failed",
        stage: "operation_admission",
        error: {
          code: "EXECUTION_FAILED",
          message: "Operation acceptance delivery failed",
          retryable: false,
        },
      }),
    );
    await expect(operation.result).rejects.toMatchObject({
      code: "EXECUTION_FAILED",
    });
    expect(secondPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 1,
      connection_epoch: 1,
    });
    expect(secondPeer.closed).toEqual([]);
  });

  it("rejects a frame stamped with an epoch the start was never sent with", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    void operation.result.catch(() => undefined);
    const original = firstPeer.sent[1] as OperationStart;
    first.disconnect();

    const secondPeer = new RecordingPeer();
    const second = await acceptReadyConnection(gateway, secondPeer);
    await expect(
      second.receive(
        event({ ...original, connection_epoch: 7 }, 1, {
          type: "operation.failed",
          stage: "operation_admission",
          error: { code: "EXECUTION_FAILED", message: "x", retryable: false },
        }),
      ),
    ).rejects.toThrow("identity mismatch at connection_epoch");
  });

  it("ends an unaccepted start with an unknown outcome after three re-sends", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    let peer = new RecordingPeer();
    let connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(sessionTarget());
    void operation.result.catch(() => undefined);
    const original = peer.sent[1] as OperationStart;
    for (let resend = 1; resend <= 3; resend++) {
      connection.disconnect();
      peer = new RecordingPeer();
      connection = await acceptReadyConnection(gateway, peer);
      expect(peer.sent).toContainEqual(
        expect.objectContaining({
          type: "operation.start",
          operation_id: original.operation_id,
        }),
      );
    }
    connection.disconnect();
    peer = new RecordingPeer();
    await acceptReadyConnection(gateway, peer);
    expect(peer.sent).not.toContainEqual(
      expect.objectContaining({ type: "operation.start" }),
    );
    await expect(operation.result).rejects.toMatchObject({
      code: OPERATION_OUTCOME_UNKNOWN,
      retryable: false,
    });
  });

  it("keeps re-sending an unaccepted start the daemon reports active", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    let peer = new RecordingPeer();
    let connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(sessionTarget());
    void operation.result.catch(() => undefined);
    const start = peer.sent[1] as OperationStart;
    const retained = hello([
      {
        tenant_id: start.tenant_id,
        runner_id: start.runner_id,
        protocol_version: start.protocol_version,
        host_access: start.host_access,
        registration_id: start.registration_id,
        assignment_revision: start.assignment_revision,
        execution_context_key: start.execution_context_key,
        runtime_instance_id: start.runtime_instance_id,
        context_view_ref: start.context_view_ref,
        agent_id: start.agent_id,
        operation_id: start.operation_id,
        connection_epoch: start.connection_epoch,
        runner_revision: start.runner_revision,
        generation: start.generation,
        execution_lease_id: start.execution_lease_id,
        workspace_grant_id: start.workspace_grant_id,
        runtime_type: start.runtime_type,
        kind: start.request.kind,
        last_emitted_seq: 0,
        last_acked_seq: 0,
      },
    ]);
    for (let reconnect = 1; reconnect <= 5; reconnect++) {
      connection.disconnect();
      peer = new RecordingPeer();
      connection = await acceptReadyConnection(gateway, peer, retained);
      expect(peer.sent).toContainEqual(start);
    }
    await expect(
      Promise.race([operation.result, Promise.resolve("pending")]),
    ).resolves.toBe("pending");
  });

  it("retires terminal state when acknowledgement delivery is indeterminate", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const firstPeer = new FailingTerminalAckPeer();
    const first = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation(sessionTarget());
    const start = firstPeer.sent[1] as OperationStart;
    await first.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );

    await expect(
      first.receive(
        event(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "",
            session: { thread_id: "thread-1" },
          },
        }),
      ),
    ).rejects.toThrow("terminal acknowledgement send failed");
    await expect(operation.result).resolves.toMatchObject({ type: "run" });

    const recoveryPeer = new RecordingPeer();
    const recovery = await acceptReadyConnection(gateway, recoveryPeer);
    // The terminal ended the Operation here; a replay of it is only
    // acknowledged.
    expect(recoveryPeer.sent).toEqual([
      expect.objectContaining({
        type: "runner.welcome",
        reconcile_operation_ids: [],
      }),
    ]);
    await recovery.receive(
      event(start, 2, {
        type: "operation.completed",
        result: {
          type: "run",
          final_response: "",
          session: { thread_id: "thread-1" },
        },
      }),
    );
    expect(recoveryPeer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 2,
    });
  });

  it.each([false, true])(
    "resends an unconfirmed input after reconnect (submitted offline: %s)",
    async (submittedOffline) => {
      const gateway = createTestRunnerGateway({
        heartbeatIntervalMs: 1_000,
        createId: sequenceIds(),
      });
      const firstPeer = new RecordingPeer();
      const first = await acceptReadyConnection(gateway, firstPeer);
      const operation = await gateway.startOperation({
        tenantId: "tenant-acme",
        ownerActorId: "actor-alice",
        runnerId: "runner-local",
        ...readyContextScope(),
        agentId: "agent-reviewer",
        workspaceGrantId: "grant-repo",
        request: {
          kind: "run.start",
          runtime: { type: "codex" },
          session_options: {
            thread_name: "Reviewer",
          },
          session: { thread_id: "thread-1" },
          input: { type: "text", text: "Review" },
          run_context: {
            execution_run_ref: "run-1",
            source_inbox_ids: ["room:room-main"],
          },
          run_resources: { mcp_servers: [] },
        },
      });
      const start = firstPeer.sent[1] as OperationStart;
      await first.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      );
      if (submittedOffline) first.disconnect();
      const inputOutcome = operation.input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "Inspect the tests" },
      });
      if (!submittedOffline) {
        await vi.waitFor(() =>
          expect(firstPeer.sent.at(-1)).toMatchObject({
            type: "operation.input",
          }),
        );
        first.disconnect();
      }
      const originalInput = submittedOffline
        ? undefined
        : firstPeer.sent.at(-1);

      const secondPeer = new RecordingPeer();
      const second = await acceptReadyConnection(
        gateway,
        secondPeer,
        hello([
          {
            tenant_id: start.tenant_id,
            runner_id: start.runner_id,
            protocol_version: start.protocol_version,
            host_access: start.host_access,
            registration_id: start.registration_id,
            assignment_revision: start.assignment_revision,
            execution_context_key: start.execution_context_key,
            runtime_instance_id: start.runtime_instance_id,
            context_view_ref: start.context_view_ref,
            agent_id: start.agent_id,
            operation_id: start.operation_id,
            connection_epoch: start.connection_epoch,
            runner_revision: start.runner_revision,
            generation: start.generation,
            execution_lease_id: start.execution_lease_id,
            workspace_grant_id: start.workspace_grant_id,
            runtime_type: start.runtime_type,
            kind: start.request.kind,
            last_emitted_seq: 1,
            last_acked_seq: 1,
          },
        ]),
      );

      const input = secondPeer.sent.at(-1);
      expect(input).toMatchObject({
        type: "operation.input",
        input: { type: "text", text: "Inspect the tests" },
      });
      expect(secondPeer.sent.slice(1)).toEqual([start, originalInput ?? input]);
      await second.receive(
        event(start, 2, {
          type: "operation.input_result",
          outcome: "accepted",
          command_id:
            input?.type === "operation.input" ? input.command_id : "invalid",
          turn_id: "turn-1",
        }),
      );
      await expect(inputOutcome).resolves.toEqual({ turnId: "turn-1" });
    },
  );

  it("settles late input without disconnecting or extending the completed Run sequence", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(runTarget());
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const outcome = operation
      .input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "follow-up" },
      })
      .catch((error) => error);
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({
        type: "operation.input",
      }),
    );
    const command = peer.sent.at(-1)!;
    if (command.type !== "operation.input") throw new Error("missing input");
    const {
      type: _type,
      input: _input,
      input_context_view_ref: _view,
      ...identity
    } = command;
    const receipt = {
      ...identity,
      type: "operation.input_result" as const,
      outcome: "closed" as const,
      effect: "definitely_not_applied" as const,
    };
    await connection.receive(receipt);
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    await connection.receive(
      event(start, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    await expect(operation.result).resolves.toMatchObject({
      final_response: "done",
    });
    await connection.receive(receipt);
    expect(peer.closed).toEqual([]);
    expect(peer.sent.at(-1)).toMatchObject({
      type: "operation.ack",
      through_seq: 2,
    });
  });

  it("rejects an input acknowledgement for another turn", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(runTarget());
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const inputOutcome = operation.input({
      expectedTurnId: "turn-expected",
      input: { type: "text", text: "Inspect the tests" },
    });
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)).toMatchObject({ type: "operation.input" }),
    );
    const input = peer.sent.at(-1);
    if (input?.type !== "operation.input") {
      throw new Error("Expected an operation.input command");
    }

    await expect(
      connection.receive(
        event(start, 2, {
          type: "operation.input_result",
          outcome: "accepted",
          command_id: input.command_id,
          turn_id: "turn-other",
        }),
      ),
    ).rejects.toBeInstanceOf(RunnerGatewayProtocolError);
    expect(peer.closed).toEqual([
      { code: 1002, reason: "Runner protocol violation" },
    ]);

    const recoveryPeer = new RecordingPeer();
    const recovery = await acceptReadyConnection(gateway, recoveryPeer);
    await recovery.receive(
      event(start, 2, {
        type: "operation.input_result",
        outcome: "accepted",
        command_id: input.command_id,
        turn_id: "turn-expected",
      }),
    );
    await expect(inputOutcome).resolves.toEqual({ turnId: "turn-expected" });
  });

  it("serializes concurrent events before committing their sequence", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation(sessionTarget());
    const start = peer.sent[1] as OperationStart;

    await Promise.all([
      connection.receive(
        event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
      ),
      connection.receive(
        event(start, 2, {
          type: "operation.completed",
          result: {
            type: "run",
            final_response: "",
            session: { thread_id: "thread-1" },
          },
        }),
      ),
    ]);

    await expect(operation.result).resolves.toMatchObject({ type: "run" });
    expect(
      peer.sent
        .filter((frame) => frame.type === "operation.ack")
        .map((frame) => frame.through_seq),
    ).toEqual([1, 2]);
  });

  it("cancels an Operation whose start send was indeterminate when the Computer reports it", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const failingPeer = new FailingStartPeer();
    await acceptReadyConnection(gateway, failingPeer);

    await expect(gateway.startOperation(sessionTarget())).rejects.toThrow(
      "start send failed",
    );
    const start = failingPeer.sent.find(
      (frame) => frame.type === "operation.start",
    );
    if (start?.type !== "operation.start")
      throw new Error("Expected operation.start");

    const recoveryPeer = new RecordingPeer();
    await acceptReadyConnection(
      gateway,
      recoveryPeer,
      hello([
        {
          tenant_id: start.tenant_id,
          runner_id: start.runner_id,
          protocol_version: start.protocol_version,
          host_access: start.host_access,
          registration_id: start.registration_id,
          assignment_revision: start.assignment_revision,
          execution_context_key: start.execution_context_key,
          runtime_instance_id: start.runtime_instance_id,
          context_view_ref: start.context_view_ref,
          agent_id: start.agent_id,
          operation_id: start.operation_id,
          connection_epoch: start.connection_epoch,
          runner_revision: start.runner_revision,
          generation: start.generation,
          execution_lease_id: start.execution_lease_id,
          workspace_grant_id: start.workspace_grant_id,
          runtime_type: start.runtime_type,
          kind: start.request.kind,
          last_emitted_seq: 0,
          last_acked_seq: 0,
        },
      ]),
    );
    expect(recoveryPeer.sent.map((frame) => frame.type)).toEqual([
      "runner.welcome",
      "cancel",
    ]);
    expect(recoveryPeer.sent[1]).toMatchObject({
      target: "operation",
      operation_id: start.operation_id,
    });
  });

  it("rejects stale generations without publishing them", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { threadId: "" },
        input: { type: "text", text: "hello" },
        run_context: { execution_run_ref: "run-1", source_inbox_ids: [] },
        run_resources: { mcp_servers: [] },
      },
    });
    const start = peer.sent[1] as OperationStart;

    await expect(
      connection.receive({
        ...event(start, 1, {
          type: "operation.accepted",
          command_id: start.command_id,
          runner_pid: 100,
        }),
        generation: 2,
      } as DaemonToAgentEnvelope),
    ).rejects.toBeInstanceOf(RunnerGatewayProtocolError);
    expect(peer.closed).toEqual([
      { code: 1002, reason: "Runner protocol violation" },
    ]);
  });

  it("does not acknowledge beyond its bounded event consumer", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      createId: sequenceIds(),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, peer);
    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { thread_id: "thread-1" },
        input: { type: "text", text: "Review" },
        run_context: {
          execution_run_ref: "run-1",
          source_inbox_ids: ["room:room-main"],
        },
        run_resources: { mcp_servers: [] },
      },
    });
    const start = peer.sent[1] as OperationStart;
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    for (let index = 0; index < 64; index += 1) {
      await connection.receive(
        event(start, index + 2, {
          type: "operation.event",
          event: {
            type: "message.delta",
            message_id: "message-1",
            delta: "x",
          },
        }),
      );
    }
    const blocked = connection.receive(
      event(start, 66, {
        type: "operation.event",
        event: {
          type: "message.delta",
          message_id: "message-1",
          delta: "y",
        },
      }),
    );

    await expect(settlesWithin(blocked, 20)).resolves.toBe(false);
    const iterator = operation.events[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await expect(blocked).resolves.toBeUndefined();
    expect(
      peer.sent.filter((frame) => frame.type === "operation.ack").at(-1),
    ).toMatchObject({ through_seq: 66 });
    await iterator.return?.();
  });

  it("locally terminates an unconfirmed cancellation so reconnect does not replay it", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 1_000,
      operationCancelTimeoutMs: 20,
      createId: sequenceIds(),
    });
    const firstPeer = new RecordingPeer();
    const connection = await acceptReadyConnection(gateway, firstPeer);
    const operation = await gateway.startOperation({
      tenantId: "tenant-acme",
      ownerActorId: "actor-alice",
      runnerId: "runner-local",
      ...readyContextScope(),
      agentId: "agent-reviewer",
      workspaceGrantId: "grant-repo",
      request: {
        kind: "run.start",
        runtime: { type: "codex" },
        session_options: {
          thread_name: "Reviewer",
        },
        session: { thread_id: "thread-1" },
        input: { type: "text", text: "Review" },
        run_context: {
          execution_run_ref: "run-1",
          source_inbox_ids: ["room:room-main"],
        },
        run_resources: { mcp_servers: [] },
      },
    });
    connection.disconnect();

    await expect(operation.cancel("stop requested")).resolves.toBeUndefined();
    await expect(operation.result).rejects.toMatchObject({
      name: "RunnerOperationError",
      code: "cancelled",
    });

    const secondPeer = new RecordingPeer();
    await acceptReadyConnection(gateway, secondPeer);
    expect(secondPeer.sent.map((frame) => frame.type)).toEqual([
      "runner.welcome",
    ]);
  });
});

it("accepts duplicate closed-input after definitive result and 512-entry cache eviction", async () => {
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    createId: sequenceIds(),
  });
  const peer = new RecordingPeer();
  const connection = await acceptReadyConnection(gateway, peer);
  const operation = await gateway.startOperation(runTarget());
  const start = peer.sent.at(-1)!;
  if (start.type !== "operation.start") throw new Error("missing start");
  await connection.receive(
    event(start, 1, {
      type: "operation.accepted",
      command_id: start.command_id,
      runner_pid: 100,
    }),
  );
  const inputOutcome = operation
    .input({
      expectedTurnId: "turn-1",
      input: { type: "text", text: "late" },
    })
    .catch((error) => error);
  await vi.waitFor(() =>
    expect(peer.sent.at(-1)?.type).toBe("operation.input"),
  );
  const input = peer.sent.at(-1)!;
  if (input.type !== "operation.input") throw new Error("missing input");
  const {
    type: _type,
    input: _input,
    input_context_view_ref: _view,
    ...identity
  } = input;
  const closed = {
    ...identity,
    type: "operation.input_result" as const,
    outcome: "closed" as const,
    effect: "definitely_not_applied" as const,
  };
  await connection.receive(closed);
  expect(await inputOutcome).toMatchObject({
    effect: "definitely_not_applied",
  });
  await connection.receive(
    event(start, 2, {
      type: "operation.completed",
      result: { type: "run", final_response: "done", session: {} },
    }),
  );
  await operation.result;

  // Exceed the 512-entry cache of retired Operations.
  for (let completed = 0; completed < 513; completed++) {
    const later = await gateway.startOperation(runTarget());
    const laterStart = peer.sent.at(-1)!;
    if (laterStart.type !== "operation.start")
      throw new Error("missing later start");
    await connection.receive(
      event(laterStart, 1, {
        type: "operation.accepted",
        command_id: laterStart.command_id,
        runner_pid: 100,
      }),
    );
    await connection.receive(
      event(laterStart, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    await later.result;
  }
  expect(peer.closed).toEqual([]);

  await expect(connection.receive(closed)).resolves.toBeUndefined();
  expect(peer.closed).toEqual([]);
  connection.disconnect();
});

it.each(["release", "disconnect"] as const)(
  "wakes a capacity waiter at once on a %s",
  async (change) => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const connection = await acceptReadyConnection(
      gateway,
      new RecordingPeer(),
      { ...hello(), capacity: 1 },
    );
    const permit = await gateway.acquireOperationCapacity(
      runTarget(),
      new AbortController().signal,
    );
    const waiting = gateway
      .acquireOperationCapacity(runTarget(), new AbortController().signal)
      .then(
        (acquired) => ({ acquired, error: undefined }),
        (error: unknown) => ({ acquired: undefined, error }),
      );
    try {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const changedAt = Date.now();
      if (change === "release") permit.release();
      else connection.disconnect();
      const outcome = await waiting;
      expect(Date.now() - changedAt).toBeLessThan(500);
      if (change === "release") expect(outcome.acquired).toBeDefined();
      else expect(outcome.error).toBeInstanceOf(LocalComputerOfflineError);
      outcome.acquired?.release();
    } finally {
      permit.release();
      connection.disconnect();
    }
  },
);

it("loses no capacity wake while many waiters acquire, release and leave", async () => {
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    createId: sequenceIds(),
  });
  const greeting = hello([], 2);
  const connection = await acceptReadyConnection(gateway, new RecordingPeer(), {
    ...greeting,
  });
  const startedAt = Date.now();
  try {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 30 }, async (_, index) => {
        const controller = new AbortController();
        // Every fifth waiter leaves the queue before it is served.
        if (index % 5 === 4) setTimeout(() => controller.abort(), 1);
        const permit = await gateway.acquireOperationCapacity(
          { ...runTarget(), executionContextKey: `context-${index % 3}` },
          controller.signal,
        );
        await new Promise((resolve) => setTimeout(resolve, 1 + (index % 3)));
        permit.release();
      }),
    );
    expect(
      outcomes.filter(({ status }) => status === "fulfilled").length,
    ).toBeGreaterThanOrEqual(24);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  } finally {
    connection.disconnect();
  }
});

it("reserves capacity from fresh occupancy for concurrent waiters", async () => {
  const gateway = createTestRunnerGateway({
    heartbeatIntervalMs: 60_000,
    createId: sequenceIds(),
  });
  const peer = new RecordingPeer();
  const connection = await acceptReadyConnection(gateway, peer, {
    ...hello(),
    capacity: 1,
  });
  let secondAcquired = false;
  const first = gateway.acquireOperationCapacity(
    runTarget(),
    new AbortController().signal,
  );
  const second = gateway
    .acquireOperationCapacity(runTarget(), new AbortController().signal)
    .then((permit) => {
      secondAcquired = true;
      return permit;
    });
  const firstPermit = await first;
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(secondAcquired).toBe(false);
  firstPermit.release();
  const secondPermit = await second;
  secondPermit.release();
  connection.disconnect();
});

describe("an input still in flight at the terminal", () => {
  const inFlightInput = async (
    options: { operationCancelTimeoutMs?: number; capacity?: number } = {},
  ) => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
      ...(options.operationCancelTimeoutMs === undefined
        ? {}
        : { operationCancelTimeoutMs: options.operationCancelTimeoutMs }),
    });
    const peer = new RecordingPeer();
    const connection = await acceptReadyConnection(
      gateway,
      peer,
      hello([], options.capacity ?? 2),
    );
    const operation = await gateway.startOperation(runTarget());
    const start = peer.sent.at(-1)!;
    if (start.type !== "operation.start") throw new Error("missing start");
    await connection.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const outcome = operation
      .input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "follow-up" },
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(peer.sent.at(-1)?.type).toBe("operation.input"),
    );
    const input = peer.sent.at(-1)!;
    if (input.type !== "operation.input") throw new Error("missing input");
    const {
      type: _type,
      input: _input,
      input_context_view_ref: _view,
      ...identity
    } = input;
    const closed = (effect: "definitely_not_applied" | "uncertain") => ({
      ...identity,
      type: "operation.input_result" as const,
      outcome: "closed" as const,
      effect,
    });
    const complete = async () => {
      await connection.receive(
        event(start, 2, {
          type: "operation.completed",
          result: { type: "run", final_response: "done", session: {} },
        }),
      );
      await operation.result;
    };
    return {
      gateway,
      peer,
      connection,
      operation,
      start,
      outcome,
      closed,
      complete,
    };
  };

  it.each(["definitely_not_applied", "uncertain"] as const)(
    "settles from a %s closed receipt that arrives after the terminal",
    async (effect) => {
      const { peer, connection, outcome, closed, complete } =
        await inFlightInput();
      await complete();
      let settled = false;
      void outcome.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);

      await connection.receive(closed(effect));
      expect(await outcome).toMatchObject({
        name: "RunnerOperationInputError",
        effect,
        reason: "no_active_turn",
      });
      // Replays of the receipt after the input settled are ignored.
      await expect(
        connection.receive(closed("definitely_not_applied")),
      ).resolves.toBeUndefined();
      expect(peer.closed).toEqual([]);
      connection.disconnect();
    },
  );

  it("is uncertain when no receipt arrives within the cancel timeout", async () => {
    const { peer, connection, outcome, closed, complete } = await inFlightInput(
      { operationCancelTimeoutMs: 20 },
    );
    await complete();
    expect(await outcome).toMatchObject({
      name: "RunnerOperationInputError",
      effect: "uncertain",
      reason: "transport",
    });
    // A receipt after the timeout neither reopens the input nor fails the
    // connection.
    await expect(
      connection.receive(closed("definitely_not_applied")),
    ).resolves.toBeUndefined();
    expect(peer.closed).toEqual([]);
    connection.disconnect();
  });

  it("is uncertain after the connection is lost and is never resent", async () => {
    const { gateway, connection, outcome, complete } = await inFlightInput();
    await complete();
    connection.disconnect();
    const recoveryPeer = new RecordingPeer();
    await acceptReadyConnection(gateway, recoveryPeer);
    expect(await outcome).toMatchObject({
      name: "RunnerOperationInputError",
      effect: "uncertain",
      reason: "transport",
    });
    expect(
      recoveryPeer.sent.filter((frame) => frame.type === "operation.input"),
    ).toEqual([]);
  });

  it("frees capacity at the terminal while it still routes the receipt", async () => {
    const { gateway, peer, connection, outcome, closed, complete } =
      await inFlightInput({ capacity: 1 });
    const next = gateway.acquireOperationCapacity(
      {
        runnerId: "runner-local",
        tenantId: "tenant-acme",
        agentId: "agent-reviewer",
        executionContextKey: runTarget().executionContextKey,
      },
      new AbortController().signal,
    );
    expect(await settlesWithin(next, 20)).toBe(false);
    await complete();
    expect(await settlesWithin(next, 1_000)).toBe(true);
    (await next).release();

    await connection.receive(closed("definitely_not_applied"));
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    expect(peer.closed).toEqual([]);
    connection.disconnect();
  });

  it("is uncertain at once when the Gateway ends the Operation itself", async () => {
    const { operation, outcome } = await inFlightInput({
      operationCancelTimeoutMs: 20,
    });
    // The Daemon never confirms the cancellation, so the Gateway ends the
    // Operation locally while the Daemon may still run the input.
    await operation.cancel("stop requested");
    expect(await settlesWithin(outcome, 5)).toBe(true);
    expect(await outcome).toMatchObject({
      effect: "uncertain",
      reason: "transport",
    });
  });

  it("keeps waiting for a receipt of an input resent on the new connection", async () => {
    const { gateway, connection, start, outcome, closed } =
      await inFlightInput();
    connection.disconnect();
    const resent = deferred<void>();
    const release = deferred<void>();
    class GatedPeer extends RecordingPeer {
      override async send(envelope: AgentToDaemonEnvelope): Promise<void> {
        await super.send(envelope);
        if (envelope.type === "operation.input") {
          resent.resolve();
          await release.promise;
        }
      }
    }
    const recoveryPeer = new GatedPeer();
    placeAgent(gateway, defaultAgentPlacement());
    const recovery = await gateway.acceptConnection(
      authenticatedPrincipal(),
      hello([], 2),
      recoveryPeer,
    );
    const reconciled = acknowledgeEnsuredAgent(recovery, recoveryPeer, true);
    await resent.promise;
    // The Daemon replays its terminal while reconciliation is still running.
    await recovery.receive(
      event(start, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    release.resolve();
    await reconciled;
    await recovery.receive(closed("definitely_not_applied"));
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    expect(recoveryPeer.closed).toEqual([]);
    recovery.disconnect();
  });

  it("is uncertain at once when the connection that carried it is replaced", async () => {
    const { gateway, outcome, complete } = await inFlightInput();
    await complete();
    const replacementPeer = new RecordingPeer();
    const replacement = await acceptReadyConnection(gateway, replacementPeer);
    expect(await settlesWithin(outcome, 5)).toBe(true);
    expect(await outcome).toMatchObject({
      effect: "uncertain",
      reason: "transport",
    });
    expect(
      replacementPeer.sent.filter((frame) => frame.type === "operation.input"),
    ).toEqual([]);
    replacement.disconnect();
  });

  it("ignores the late close of a connection replaced before the input was sent", async () => {
    const gateway = createTestRunnerGateway({
      heartbeatIntervalMs: 60_000,
      createId: sequenceIds(),
    });
    const stalePeer = new RecordingPeer();
    const stale = await acceptReadyConnection(gateway, stalePeer);
    const operation = await gateway.startOperation(runTarget());
    const start = stalePeer.sent.at(-1)!;
    if (start.type !== "operation.start") throw new Error("missing start");
    await stale.receive(
      event(start, 1, {
        type: "operation.accepted",
        command_id: start.command_id,
        runner_pid: 100,
      }),
    );
    const currentPeer = new RecordingPeer();
    const current = await acceptReadyConnection(gateway, currentPeer);
    const outcome = operation
      .input({
        expectedTurnId: "turn-1",
        input: { type: "text", text: "follow-up" },
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(currentPeer.sent.at(-1)?.type).toBe("operation.input"),
    );
    const input = currentPeer.sent.at(-1)!;
    if (input.type !== "operation.input") throw new Error("missing input");
    const {
      type: _type,
      input: _input,
      input_context_view_ref: _view,
      ...identity
    } = input;
    await current.receive(
      event(start, 2, {
        type: "operation.completed",
        result: { type: "run", final_response: "done", session: {} },
      }),
    );
    await operation.result;
    stale.disconnect();
    await current.receive({
      ...identity,
      type: "operation.input_result",
      outcome: "closed",
      effect: "definitely_not_applied",
    });
    expect(await outcome).toMatchObject({ effect: "definitely_not_applied" });
    expect(currentPeer.closed).toEqual([]);
    current.disconnect();
  });

  it.each(["receipt", "timeout"] as const)(
    "stops routing receipts to the Operation once its input settles by %s",
    async (settledBy) => {
      const { peer, connection, outcome, closed, complete } =
        await inFlightInput({ operationCancelTimeoutMs: 20 });
      await complete();
      if (settledBy === "receipt")
        await connection.receive(closed("definitely_not_applied"));
      await outcome;
      // A routed receipt is checked against the Operation identity; one that
      // reaches no Operation is dropped without a check.
      await expect(
        connection.receive({
          ...closed("definitely_not_applied"),
          execution_lease_id: "lease-other",
        }),
      ).resolves.toBeUndefined();
      expect(peer.closed).toEqual([]);
      connection.disconnect();
    },
  );
});
