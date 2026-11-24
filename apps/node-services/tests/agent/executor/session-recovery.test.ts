import { describe, expect, it, vi } from "vitest";
import {
  RuntimeExecutionError,
  type AgentInput,
  type AgentProvider,
  type AgentRun,
  type ExecutionSpec,
  type PreviousRuntimeSession,
  type RunEvent,
  type RunResult,
  type RuntimeSession,
} from "../../../src/agent/executor/provider.js";
import {
  createTeamHubContextRuntimeState,
  type SessionRecoveryReason,
} from "../../../src/agent/executor/context-runtime-state.js";
import { RunLoop } from "../../../src/agent/executor/run-loop.js";
import { createAgentLogger } from "../../../src/agent/observability/agent-log.js";
import type { Message } from "../../../src/agent/executor/types.js";
import { TestContextRuntimeState } from "../test-support/context-runtime-state.js";
import { createTeamHubRuntimeStateClientFake } from "../test-support/teamhub-runtime-state-client.js";

const testMessage = (id: string, inboxId = "room:room-1"): Message => ({
  messageId: id,
  rawMessage: `Body for ${id}`,
  segments: [{ type: "text", content: `Body for ${id}` }],
  sourceInboxIds: [inboxId],
});

class ControlledRun implements AgentRun {
  readonly events: AsyncIterable<RunEvent>;
  #resolve!: (result: RunResult) => void;
  #reject!: (error: unknown) => void;
  readonly #promise: Promise<RunResult>;

  constructor() {
    this.#promise = new Promise<RunResult>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.events = {
      async *[Symbol.asyncIterator]() {
        yield { type: "run.started" };
      },
    };
  }

  complete(finalResponse = "done"): void {
    this.#resolve({ finalResponse });
  }

  fail(error: unknown): void {
    this.#reject(error);
  }

  wait(): Promise<RunResult> {
    return this.#promise;
  }

  cancel(): void {
    this.#reject(new Error("canceled"));
  }
}

describe("RunLoop session recovery and previous context forwarding", () => {
  it.each<SessionRecoveryReason>(["session_not_found", "context_too_long"])(
    "requeues the Run, clears the persisted session, and requests recovery on %s",
    async (reason) => {
      const state = new TestContextRuntimeState({
        databasePath: ":memory:",
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      });
      state.setRuntimeSession({ threadId: "old-thread" });
      const clearSpy = vi.spyOn(state, "clearRuntimeSession");
      const requeueSpy = vi.spyOn(state, "requeueLocalRun");
      const finishSpy = vi.spyOn(state, "finishLocalRun");

      const provider: AgentProvider = {
        createSession: vi.fn(),
        resumeSession: vi.fn(),
        startRun: vi.fn(async () => {
          if (reason === "session_not_found") {
            throw new RuntimeExecutionError({
              code: "session_not_found",
              runtime_type: "codex",
            });
          }
          const run = new ControlledRun();
          queueMicrotask(() =>
            run.fail(
              new RuntimeExecutionError({
                code: "context_too_long",
                runtime_type: "codex",
              }),
            ),
          );
          return run;
        }),
        close: vi.fn(async () => undefined),
        steer: vi.fn(),
      };

      const recoveryCalls: Array<{
        runId: string;
        reason: SessionRecoveryReason;
        hadPriorProgress: boolean;
      }> = [];
      const loop = new RunLoop({
        logger: createAgentLogger({ component: "test" }),
        executionContextRef: {
          kind: "meta",
          agentId: "agent-1",
          roomId: "room-1",
        },
        provider,
        runtimeName: "codex",
        runtimeSession: { threadId: "old-thread" },
        newSession: false,
        state,
        prepareInput: (message) => message,
        onRunEvent: () => [],
        canRecoverSession: () => true,
        onSessionRecoveryRequested: (
          runId,
          failureReason,
          hadPriorProgress,
        ) => {
          recoveryCalls.push({
            runId,
            reason: failureReason,
            hadPriorProgress,
          });
        },
      });

      const runId = state.enqueueTrustedTurn([testMessage("msg-1")]);
      loop.start();
      await vi.waitFor(() => expect(recoveryCalls).toHaveLength(1));
      await loop.drain({ cancelActive: false });

      expect(recoveryCalls[0]).toEqual({
        runId,
        reason,
        hadPriorProgress: false,
      });
      expect(requeueSpy).toHaveBeenCalledWith(runId);
      expect(clearSpy).toHaveBeenCalledWith({ recoveryReason: reason });
      expect(finishSpy).not.toHaveBeenCalled();
      expect(state.getLocalRun(runId)?.status).toBe("queued");
      state.close();
    },
  );

  it("does not loop when canRecoverSession rejects a second recovery or when already on a fresh session", async () => {
    for (const scenario of ["already_recovered", "fresh_session"] as const) {
      const state = new TestContextRuntimeState({
        databasePath: ":memory:",
        ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
      });
      state.setRuntimeSession({ threadId: "thread-1" });
      const recoverySpy = vi.fn();
      const finishSpy = vi.spyOn(state, "finishLocalRun");

      const provider: AgentProvider = {
        createSession: vi.fn(),
        resumeSession: vi.fn(),
        startRun: vi.fn(async () => {
          const run = new ControlledRun();
          queueMicrotask(() =>
            run.fail(
              new RuntimeExecutionError({
                code: "context_too_long",
                runtime_type: "claude",
              }),
            ),
          );
          return run;
        }),
        close: vi.fn(async () => undefined),
        steer: vi.fn(),
      };

      const loop = new RunLoop({
        logger: createAgentLogger({ component: "test" }),
        executionContextRef: {
          kind: "meta",
          agentId: "agent-1",
          roomId: "room-1",
        },
        provider,
        runtimeName: "claude",
        runtimeSession: { threadId: "thread-1" },
        newSession: scenario === "fresh_session",
        state,
        prepareInput: (message) => message,
        onRunEvent: () => [],
        canRecoverSession: () => scenario !== "already_recovered",
        onSessionRecoveryRequested: recoverySpy,
      });

      const runId = state.enqueueTrustedTurn([testMessage(`msg-${scenario}`)]);
      loop.start();
      await vi.waitFor(() => expect(finishSpy).toHaveBeenCalledTimes(1));
      await loop.drain({ cancelActive: false });

      expect(recoverySpy).not.toHaveBeenCalled();
      expect(state.getLocalRun(runId)?.status).toBe("failed");
      state.close();
    }
  });

  it("forwards previousSession and inlines recentMessages only on the first Run of a new session", async () => {
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
    });
    const baseClaim = state.claimLocalRun.bind(state);
    vi.spyOn(state, "claimLocalRun").mockImplementation(() => {
      const claimed = baseClaim();
      if (!claimed) return null;
      return {
        ...claimed,
        continuesContext: true,
        recentMessages: {
          inboxId: "room:room-1",
          nextCursor: "cur-prev",
          messages: [
            {
              messageId: "prev-1",
              author: "Bob",
              authorKind: "human",
              body: "Earlier instruction",
              createdAt: "2026-05-01T09:59:00Z",
            },
          ],
        },
      };
    });

    const starts: Array<{ input: AgentInput; spec: ExecutionSpec }> = [];
    const provider: AgentProvider = {
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      startRun: vi.fn(
        async (
          _session: RuntimeSession,
          input: AgentInput,
          spec: ExecutionSpec = {},
        ) => {
          starts.push({ input, spec });
          const run = new ControlledRun();
          queueMicrotask(() => run.complete("ok"));
          return run;
        },
      ),
      close: vi.fn(async () => undefined),
      steer: vi.fn(),
    };

    const previousSession: PreviousRuntimeSession = {
      providerType: "codex",
      sessionId: "thread-old-9",
    };
    const loop = new RunLoop({
      logger: createAgentLogger({ component: "test" }),
      executionContextRef: {
        kind: "meta",
        agentId: "agent-1",
        roomId: "room-1",
      },
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "thread-new-1" },
      newSession: true,
      previousSession,
      state,
      prepareInput: (message) => message,
      onRunEvent: () => [],
    });

    const run1 = state.enqueueTrustedTurn([testMessage("msg-first")]);
    loop.start();
    await vi.waitFor(() =>
      expect(state.getLocalRun(run1)?.status).toBe("succeeded"),
    );

    const run2 = state.enqueueTrustedTurn([testMessage("msg-second")]);
    loop.notifyWorkAvailable();
    await vi.waitFor(() =>
      expect(state.getLocalRun(run2)?.status).toBe("succeeded"),
    );
    await loop.drain({ cancelActive: false });

    expect(starts).toHaveLength(2);
    expect(starts[0]!.spec.previousSession).toEqual(previousSession);
    expect(starts[0]!.input.text).toContain("new native session");
    expect(starts[0]!.input.text).toContain(
      '<recent_messages inbox="room:room-1">',
    );
    expect(starts[0]!.input.text).toContain("Earlier instruction");
    expect(starts[0]!.input.text).toContain(
      "teamhub message read --cursor cur-prev",
    );

    expect(starts[1]!.spec.previousSession).toBeUndefined();
    expect(starts[1]!.input.text).not.toContain("new native session");
    expect(starts[1]!.input.text).not.toContain("<recent_messages");
    state.close();
  });

  it("TeamHubContextRuntimeState preserves cleared session identity and maps recent_messages", async () => {
    const ref = { kind: "meta", agentId: "agent-1", roomId: "room-1" } as const;
    const contextKey = JSON.stringify(["meta", "agent-1", "room", "room-1"]);
    const clearSession = vi.fn(async () => ({ cleared: true }));
    const client = createTeamHubRuntimeStateClientFake({
      getWorkState: async () => ({
        has_queued_runs: true,
        has_pending_work: true,
      }),
      getSession: async () => ({
        available: true,
        session: {
          expected_revision: "0",
          revision: "2",
          provider_kind: "claude",
          schema_version: "1",
          session: { sessionId: "claude-old-7" },
          configuration_revision: "3",
          updated_at: "2026-05-01T10:00:00.000Z",
        },
      }),
      clearSession,
      claimRun: async () => ({
        claimed: true,
        run: {
          run_id: "run-9",
          attempt_count: 2,
          continues_context: true,
          cancellation_requested: false,
          recent_messages: {
            inbox_id: "room:room-1",
            next_cursor: "cur-9",
            messages: [
              {
                message_id: "m-1",
                author: "Alice",
                author_kind: "human",
                body: "Prior message",
                truncated: true,
                created_at: "2026-05-01T09:58:00.000Z",
              },
            ],
          },
          inputs: [
            {
              input_id: "in-1",
              sequence: "5",
              status: "handled" as const,
              source_kind: "inbox" as const,
              created_at: "2026-05-01T10:00:00.000Z",
              payload: testMessage("m-2") as unknown as Record<string, unknown>,
            },
          ],
        },
      }),
    });

    const state = await createTeamHubContextRuntimeState({
      client,
      ref,
      configurationRevision: "3",
      providerKind: "claude",
    });

    const cleared = await state.clearRuntimeSession({
      recoveryReason: "context_too_long",
    });
    expect(cleared).toBe(true);
    expect(clearSession).toHaveBeenCalledWith({
      context_key: contextKey,
      epoch: client.epoch,
      configuration_revision: "3",
      recovery_reason: "context_too_long",
    });
    expect(state.consumeClearedSession?.()).toEqual({
      providerType: "claude",
      sessionId: "claude-old-7",
    });
    expect(state.consumeClearedSession?.()).toBeNull();

    const claimed = await state.claimLocalRun();
    expect(claimed?.recentMessages).toEqual({
      inboxId: "room:room-1",
      nextCursor: "cur-9",
      messages: [
        {
          messageId: "m-1",
          author: "Alice",
          authorKind: "human",
          body: "Prior message",
          truncated: true,
          createdAt: "2026-05-01T09:58:00.000Z",
        },
      ],
    });
    await state.close();
  });

  it("fails the Run visibly instead of leaving it queued when clearRuntimeSession rejects", async () => {
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
    });
    state.setRuntimeSession({ threadId: "old-thread" });
    vi.spyOn(state, "clearRuntimeSession").mockRejectedValueOnce(
      new Error("invalid request (400)"),
    );
    const finishSpy = vi.spyOn(state, "finishLocalRun");
    const recoverySpy = vi.fn();
    const failedSpy = vi.fn();
    let recovered = false;

    const provider: AgentProvider = {
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      startRun: vi.fn(async () => {
        const run = new ControlledRun();
        queueMicrotask(() =>
          run.fail(
            new RuntimeExecutionError({
              code: "context_too_long",
              runtime_type: "codex",
            }),
          ),
        );
        return run;
      }),
      close: vi.fn(async () => undefined),
      steer: vi.fn(),
    };

    const loop = new RunLoop({
      logger: createAgentLogger({ component: "test" }),
      executionContextRef: {
        kind: "meta",
        agentId: "agent-1",
        roomId: "room-1",
      },
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "old-thread" },
      newSession: false,
      state,
      prepareInput: (message) => message,
      onRunEvent: () => [],
      canRecoverSession: () => !recovered,
      onSessionRecoveryFailed: (runId) => {
        recovered = true;
        failedSpy(runId);
      },
      onSessionRecoveryRequested: recoverySpy,
    });

    const runId = state.enqueueTrustedTurn([testMessage("msg-clear-fail")]);
    loop.start();
    await vi.waitFor(() => expect(finishSpy).toHaveBeenCalledTimes(1));
    await loop.drain({ cancelActive: false });

    expect(recoverySpy).not.toHaveBeenCalled();
    expect(failedSpy).toHaveBeenCalledWith(runId);
    expect(provider.startRun).toHaveBeenCalledTimes(1);
    expect(state.getLocalRun(runId)?.status).toBe("failed");
    state.close();
  });

  it("notes partial work in the continuation reminder after a mid-turn restart", async () => {
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: { kind: "meta", agentId: "agent-1", roomId: "room-1" },
    });
    const baseClaim = state.claimLocalRun.bind(state);
    vi.spyOn(state, "claimLocalRun").mockImplementation(() => {
      const claimed = baseClaim();
      return claimed ? { ...claimed, continuesContext: true } : null;
    });
    const starts: AgentInput[] = [];
    const provider: AgentProvider = {
      createSession: vi.fn(),
      resumeSession: vi.fn(),
      startRun: vi.fn(async (_session: RuntimeSession, input: AgentInput) => {
        starts.push(input);
        const run = new ControlledRun();
        queueMicrotask(() => run.complete("ok"));
        return run;
      }),
      close: vi.fn(async () => undefined),
      steer: vi.fn(),
    };

    const loop = new RunLoop({
      logger: createAgentLogger({ component: "test" }),
      executionContextRef: {
        kind: "meta",
        agentId: "agent-1",
        roomId: "room-1",
      },
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "thread-new-2" },
      newSession: true,
      state,
      prepareInput: (message) => message,
      onRunEvent: () => [],
      consumePartialWorkRecovery: () => true,
    });

    const runId = state.enqueueTrustedTurn([testMessage("msg-partial")]);
    loop.start();
    await vi.waitFor(() =>
      expect(state.getLocalRun(runId)?.status).toBe("succeeded"),
    );
    await loop.drain({ cancelActive: false });

    expect(starts).toHaveLength(1);
    expect(starts[0]!.text).toContain("already ran some steps");
    state.close();
  });
});
