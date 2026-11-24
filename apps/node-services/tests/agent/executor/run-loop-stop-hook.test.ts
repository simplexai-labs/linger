import { describe, expect, it, vi } from "vitest";
import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import type { FeatureContext } from "../../../src/agent/agent-features/contracts.js";
import {
  createRoomReplyGuardFeature,
  ROOM_REPLY_REMINDER,
} from "../../../src/agent/agent-features/room-reply-guard/index.js";
import type {
  AgentInput,
  AgentProvider,
  AgentRun,
  ExecutionSpec,
  ProviderSteerAck,
  RunEvent,
  RunResult,
  RuntimeSession,
} from "../../../src/agent/executor/provider.js";
import { RunLoop } from "../../../src/agent/executor/run-loop.js";
import type { Message } from "../../../src/agent/executor/types.js";
import type { AgentLogger } from "../../../src/agent/observability/agent-log.js";
import { TestContextRuntimeState } from "../test-support/context-runtime-state.js";

const ROOM_REF = {
  kind: "meta",
  agentId: "agent-1",
  roomId: "room-1",
} as const;

function makeRoomMessage(
  id: string,
  text: string,
  mentioned: boolean,
): Message {
  return {
    messageId: id,
    rawMessage: text,
    segments: [{ type: "text", content: text }],
    acceptedNotification: {
      messages: [
        {
          mentioned,
          authorType: "user",
          messageKind: "conversation",
        },
      ],
    },
  } as unknown as Message;
}

function makeMetaContext(): FeatureContext {
  const controller = new AbortController();
  return {
    ref: ROOM_REF,
    configurationRevision: "rev-1",
    runtime: {},
    identity: {
      agentId: "agent-1",
      actorId: "actor-agent-1",
      agentType: "employee",
    } as unknown as FeatureContext["identity"],
    tenantId: "tenant-1",
    actorId: "actor-agent-1",
    agentName: "Helper",
    agent: { name: "Helper", instructions: "" },
    roomKind: "direct",
    capabilities: [],
    signal: controller.signal,
    activeRunId: () => undefined,
    steer: async () => ({ status: "skipped", reason: "test" }),
    followUp: async () => ({ status: "skipped", reason: "test" }),
  };
}

class StopHookFakeProvider implements AgentProvider {
  readonly starts: Array<{ input: AgentInput; spec: ExecutionSpec }> = [];
  readonly #onStart: (
    spec: ExecutionSpec,
    emit: (event: RunEvent) => void,
  ) => Promise<RunResult>;

  constructor(
    onStart: (
      spec: ExecutionSpec,
      emit: (event: RunEvent) => void,
    ) => Promise<RunResult>,
  ) {
    this.#onStart = onStart;
  }

  async createSession(): Promise<RuntimeSession> {
    return { threadId: "thread-1" };
  }

  async resumeSession(session: RuntimeSession): Promise<RuntimeSession> {
    return session;
  }

  async startRun(
    _session: RuntimeSession,
    input: AgentInput,
    spec: ExecutionSpec,
  ): Promise<AgentRun> {
    this.starts.push({ input, spec });
    const emitted: RunEvent[] = [];
    const resultPromise = this.#onStart(spec, (event) => {
      emitted.push(event);
    });
    return {
      steerTarget: { turnId: "turn-1" },
      events: (async function* (): AsyncIterable<RunEvent> {
        yield { type: "run.started" };
        await resultPromise;
        for (const event of emitted) {
          yield event;
        }
      })(),
      wait: () => resultPromise,
      cancel: () => undefined,
    };
  }

  async steer(): Promise<ProviderSteerAck> {
    return { turnId: "turn-1" };
  }

  async close(): Promise<void> {
    return undefined;
  }
}

function createSilentLogger(): {
  logger: AgentLogger;
  entries: Array<{ level: string; event: string; fields?: unknown }>;
} {
  const entries: Array<{ level: string; event: string; fields?: unknown }> = [];
  const logger: AgentLogger = {
    log: (level, event, fields) => {
      entries.push({ level, event, fields });
    },
    child: () => logger,
  };
  return { logger, entries };
}

describe("RunLoop + room-reply-guard stop hook", () => {
  it("succeeds without shell heuristics when stop hook confirms a reply landed", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: true }));
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    const stateReplySpy = vi
      .spyOn(state, "hasLocalRunReplied")
      .mockReturnValue(false);
    const { logger } = createSilentLogger();

    const decisions: Array<{ action: string; reason?: string }> = [];
    const provider = new StopHookFakeProvider(async (spec) => {
      expect(spec.onStopHook).toBeDefined();
      decisions.push(
        await spec.onStopHook!(
          { runtime: "codex", attempt: 0, stopHookActive: false },
          new AbortController().signal,
        ),
      );
      return { finalResponse: "internal text" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "thread-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    expect(decisions).toEqual([{ action: "allow" }]);
    expect(readReplyStatus).toHaveBeenCalledTimes(1);
    // Stop hook already confirmed with TeamHub, so #completedTerminal skips
    // redundant fallback checks even though zero `message` activities occurred.
    expect(stateReplySpy).not.toHaveBeenCalled();
    expect(state.getLocalRun(runId)?.status).toBe("succeeded");
  });

  it("blocks once, lets the model recover, and finishes succeeded when TeamHub confirms the retry", async () => {
    let repliedInDb = false;
    const readReplyStatus = vi.fn(async () => ({ replied: repliedInDb }));
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    vi.spyOn(state, "hasLocalRunReplied").mockImplementation(() => repliedInDb);
    const { logger, entries } = createSilentLogger();

    const decisions: Array<{ action: string; reason?: string }> = [];
    const provider = new StopHookFakeProvider(async (spec) => {
      const first = await spec.onStopHook!(
        { runtime: "pi", attempt: 0, stopHookActive: false },
        new AbortController().signal,
      );
      decisions.push(first);
      // Model obeys the stop-hook reminder and sends a Room message.
      repliedInDb = true;
      const second = await spec.onStopHook!(
        { runtime: "pi", attempt: 1, stopHookActive: true },
        new AbortController().signal,
      );
      decisions.push(second);
      return { finalResponse: "" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "pi",
      runtimeSession: { threadId: "session-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    expect(decisions).toEqual([
      { action: "block", reason: ROOM_REPLY_REMINDER },
      { action: "allow" },
    ]);
    expect(state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(
      entries.some((entry) => entry.event === "local_run.stop_hook_blocked"),
    ).toBe(true);
    expect(
      entries.some((entry) => entry.event === "local_run.stop_hook_recovered"),
    ).toBe(true);
  });

  it("fails with reply_not_sent if the model still sends nothing after a stop-hook block", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: false }));
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    vi.spyOn(state, "hasLocalRunReplied").mockReturnValue(false);
    const { logger } = createSilentLogger();

    const provider = new StopHookFakeProvider(async (spec) => {
      const first = await spec.onStopHook!(
        { runtime: "claude", attempt: 0, stopHookActive: false },
        new AbortController().signal,
      );
      expect(first.action).toBe("block");
      // Model ignores the reminder and tries to stop again.
      const second = await spec.onStopHook!(
        { runtime: "claude", attempt: 1, stopHookActive: true },
        new AbortController().signal,
      );
      expect(second.action).toBe("allow");
      return { finalResponse: "still private text" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "claude",
      runtimeSession: { threadId: "session-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    const finished = state.getLocalRun(runId);
    expect(finished?.status).toBe("failed");
    expect(finished?.terminal).toMatchObject({
      type: "failed",
      failure: { code: "reply_not_sent", runtime_type: "claude" },
    });
  });

  it("falls back to reply_not_sent when the stop-hook TeamHub check fails and no message activity occurred", async () => {
    const readReplyStatus = vi.fn(async () => {
      throw new Error("teamhub timeout");
    });
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    const stateReplySpy = vi
      .spyOn(state, "hasLocalRunReplied")
      .mockRejectedValue(new Error("teamhub still unavailable"));
    const { logger } = createSilentLogger();

    const decisions: Array<{ action: string; reason?: string }> = [];
    const provider = new StopHookFakeProvider(async (spec) => {
      decisions.push(
        await spec.onStopHook!(
          { runtime: "codex", attempt: 0, stopHookActive: false },
          new AbortController().signal,
        ),
      );
      return { finalResponse: "internal text" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "thread-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    expect(decisions).toEqual([{ action: "allow" }]);
    expect(readReplyStatus).toHaveBeenCalledTimes(1);
    expect(stateReplySpy).toHaveBeenCalledTimes(1);
    const finished = state.getLocalRun(runId);
    expect(finished?.status).toBe("failed");
    expect(finished?.terminal).toMatchObject({
      type: "failed",
      failure: { code: "reply_not_sent", runtime_type: "codex" },
    });
  });

  it("succeeds after a stop-hook block when a delivered message activity occurs even if the final TeamHub reply check rejects", async () => {
    const readReplyStatus = vi
      .fn<() => Promise<{ readonly replied: boolean }>>()
      .mockResolvedValueOnce({ replied: false })
      .mockRejectedValueOnce(new Error("teamhub 503"));
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    const stateReplySpy = vi
      .spyOn(state, "hasLocalRunReplied")
      .mockRejectedValue(new Error("teamhub 503"));
    const { logger, entries } = createSilentLogger();

    const decisions: Array<{ action: string; reason?: string }> = [];
    const provider = new StopHookFakeProvider(async (spec, emit) => {
      decisions.push(
        await spec.onStopHook!(
          { runtime: "codex", attempt: 0, stopHookActive: false },
          new AbortController().signal,
        ),
      );
      emit({
        type: "activity.started",
        activityId: "msg-1",
        kind: "message",
      } as RunEvent);
      emit({
        type: "activity.finished",
        activityId: "msg-1",
        outcome: "succeeded",
      });
      decisions.push(
        await spec.onStopHook!(
          { runtime: "codex", attempt: 1, stopHookActive: true },
          new AbortController().signal,
        ),
      );
      return { finalResponse: "" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "thread-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    expect(decisions).toEqual([
      { action: "block", reason: ROOM_REPLY_REMINDER },
      { action: "allow" },
    ]);
    expect(stateReplySpy).not.toHaveBeenCalled();
    expect(state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(
      entries.some((entry) => entry.event === "local_run.stop_hook_recovered"),
    ).toBe(true);
  });

  it("suppresses reply_undelivered and skips fallback reply check when stop hook confirms delivery despite a failed write", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: true }));
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    const stateReplySpy = vi
      .spyOn(state, "hasLocalRunReplied")
      .mockReturnValue(false);
    const { logger, entries } = createSilentLogger();

    const decisions: Array<{ action: string; reason?: string }> = [];
    const provider = new StopHookFakeProvider(async (spec, emit) => {
      emit({
        type: "activity.started",
        activityId: "msg-1",
        kind: "message",
        title: "bash",
      });
      emit({
        type: "activity.finished",
        activityId: "msg-1",
        outcome: "failed",
      });
      decisions.push(
        await spec.onStopHook!(
          { runtime: "codex", attempt: 0, stopHookActive: false },
          new AbortController().signal,
        ),
      );
      return { finalResponse: "internal text" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "codex",
      runtimeSession: { threadId: "thread-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    expect(decisions).toEqual([{ action: "allow" }]);
    expect(readReplyStatus).toHaveBeenCalledTimes(1);
    expect(stateReplySpy).not.toHaveBeenCalled();
    expect(state.getLocalRun(runId)?.status).toBe("succeeded");
    expect(entries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        event: "local_run.teamhub_messages_failed",
        fields: expect.objectContaining({
          runId,
          failedMessageWrites: 1,
          deliveredMessageWrites: 0,
          replyUndelivered: false,
        }),
      }),
    );
  });

  it("fails with reply_undelivered when a write failed and the model still sends nothing after a stop-hook block", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: false }));
    const composed = composeContextFeatures({
      context: makeMetaContext(),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const state = new TestContextRuntimeState({
      databasePath: ":memory:",
      ref: ROOM_REF,
    });
    vi.spyOn(state, "hasLocalRunReplied").mockReturnValue(false);
    const { logger } = createSilentLogger();

    const provider = new StopHookFakeProvider(async (spec, emit) => {
      emit({
        type: "activity.started",
        activityId: "msg-1",
        kind: "message",
        title: "bash",
      });
      emit({
        type: "activity.finished",
        activityId: "msg-1",
        outcome: "failed",
      });
      const first = await spec.onStopHook!(
        { runtime: "claude", attempt: 0, stopHookActive: false },
        new AbortController().signal,
      );
      expect(first.action).toBe("block");
      const second = await spec.onStopHook!(
        { runtime: "claude", attempt: 1, stopHookActive: true },
        new AbortController().signal,
      );
      expect(second.action).toBe("allow");
      return { finalResponse: "still private text" };
    });

    const loop = new RunLoop({
      logger,
      executionContextRef: ROOM_REF,
      provider,
      runtimeName: "claude",
      runtimeSession: { threadId: "session-1" },
      state,
      prepareInput: (m) => m,
      onRunEvent: () => [],
      onRunBeforeStop: (input, signal) =>
        composed.evaluateRunBeforeStop(input, signal),
    });

    const runId = state.enqueueTrustedTurn([
      makeRoomMessage("m1", "@Helper hi", true),
    ]);
    loop.start();
    await loop.drain({ cancelActive: false });
    state.close();

    const finished = state.getLocalRun(runId);
    expect(finished?.status).toBe("failed");
    expect(finished?.terminal).toMatchObject({
      type: "failed",
      failure: { code: "reply_undelivered", runtime_type: "claude" },
    });
  });
});
