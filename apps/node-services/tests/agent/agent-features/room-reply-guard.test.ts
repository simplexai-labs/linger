import { describe, expect, it, vi } from "vitest";
import { composeContextFeatures } from "../../../src/agent/agent-features/compose.js";
import {
  defineFeature,
  type FeatureContext,
  type RunStopHookInput,
} from "../../../src/agent/agent-features/contracts.js";
import {
  createRoomReplyGuardFeature,
  ROOM_REPLY_GUARD_FEATURE_ID,
  ROOM_REPLY_REMINDER,
} from "../../../src/agent/agent-features/room-reply-guard/index.js";
import type { Message } from "../../../src/agent/executor/types.js";

function makeContext(
  kind: "meta" | "alter_ego" | "document" = "meta",
): FeatureContext {
  const controller = new AbortController();
  const ref =
    kind === "meta"
      ? ({ kind: "meta", agentId: "agent-1", roomId: "room-1" } as const)
      : kind === "alter_ego"
        ? ({
            kind: "alter_ego",
            agentId: "agent-1",
            taskId: "task-1",
          } as const)
        : ({
            kind: "document",
            agentId: "agent-1",
            documentId: "doc-1",
          } as const);
  return {
    ref,
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
    agent: {
      name: "Helper",
      instructions: "",
    },
    ...(kind === "meta" ? { roomKind: "direct" as const } : {}),
    capabilities: [],
    signal: controller.signal,
    activeRunId: () => undefined,
    steer: async () => ({ status: "skipped", reason: "test" }),
    followUp: async () => ({ status: "skipped", reason: "test" }),
  };
}

function makeRoomMessage(options: {
  readonly mentioned: boolean;
  readonly authorType?: string;
  readonly messageKind?: string;
  readonly inboxId?: string;
}): Message {
  return {
    messageId: "msg-1",
    rawMessage: "hello",
    segments: [{ type: "text", content: "hello" }],
    acceptedNotification: {
      ...(options.inboxId ? { inboxId: options.inboxId } : {}),
      messages: [
        {
          mentioned: options.mentioned,
          authorType: options.authorType ?? "user",
          messageKind: options.messageKind ?? "conversation",
        },
      ],
    },
  } as unknown as Message;
}

describe("room-reply-guard feature", () => {
  it("matches only meta (Room) Contexts and advertises hasRunStopHooks", () => {
    const feature = createRoomReplyGuardFeature({
      readReplyStatus: async () => ({ replied: true }),
    });
    const meta = composeContextFeatures({
      context: makeContext("meta"),
      features: [feature],
    });
    const task = composeContextFeatures({
      context: makeContext("alter_ego"),
      features: [feature],
    });
    const doc = composeContextFeatures({
      context: makeContext("document"),
      features: [feature],
    });

    expect(meta.matched).toEqual([ROOM_REPLY_GUARD_FEATURE_ID]);
    expect(meta.hasRunStopHooks).toBe(true);
    expect(task.matched).toEqual([]);
    expect(task.hasRunStopHooks).toBe(false);
    expect(doc.matched).toEqual([]);
    expect(doc.hasRunStopHooks).toBe(false);
  });

  it("allows without querying TeamHub when no Human mention awaits a reply", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: false }));
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });

    const result = await composed.evaluateRunBeforeStop(
      {
        runId: "run-1",
        attempt: 0,
        stopHookActive: false,
        inputs: [
          makeRoomMessage({ mentioned: false }),
          makeRoomMessage({ mentioned: true, authorType: "agent" }),
        ],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ decision: { action: "allow" } });
    expect(readReplyStatus).not.toHaveBeenCalled();
  });

  it("allows when TeamHub confirms a reply landed for the Run", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: true }));
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });

    const result = await composed.evaluateRunBeforeStop(
      {
        runId: "run-1",
        attempt: 0,
        stopHookActive: false,
        inputs: [makeRoomMessage({ mentioned: true })],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      decision: { action: "allow" },
      replyConfirmed: true,
    });
    expect(readReplyStatus).toHaveBeenCalledTimes(1);
    expect(readReplyStatus).toHaveBeenCalledWith(
      '["meta","agent-1","room","room-1"]',
      "run-1",
      expect.any(AbortSignal),
    );
  });

  it("blocks once with a reminder when no reply landed, then allows subsequent stop attempts", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: false }));
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });
    const input: RunStopHookInput = {
      runId: "run-1",
      attempt: 0,
      stopHookActive: false,
      inputs: [
        makeRoomMessage({ mentioned: false }),
        makeRoomMessage({ mentioned: true }),
      ],
    };

    const first = await composed.evaluateRunBeforeStop(
      input,
      new AbortController().signal,
    );
    expect(first).toEqual({
      decision: { action: "block", reason: ROOM_REPLY_REMINDER },
      blockedBy: ROOM_REPLY_GUARD_FEATURE_ID,
    });

    const second = await composed.evaluateRunBeforeStop(
      { ...input, attempt: 1, stopHookActive: false },
      new AbortController().signal,
    );
    expect(second).toEqual({ decision: { action: "allow" } });
    expect(readReplyStatus).toHaveBeenCalledTimes(1);

    composed.onRunTerminal({
      runId: "run-1",
      terminal: { type: "succeeded", finalResponse: "" },
    });
  });

  it("blocks once until every Inbox where a Human mentioned the Agent has a reply", async () => {
    const readReplyStatus = vi.fn(async () => ({
      replied: true,
      repliedInboxIds: ["room:room-1"],
    }));
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });

    const result = await composed.evaluateRunBeforeStop(
      {
        runId: "run-inboxes",
        attempt: 0,
        stopHookActive: false,
        inputs: [
          makeRoomMessage({ mentioned: true, inboxId: "room:room-1" }),
          makeRoomMessage({ mentioned: false, inboxId: "thread:thread-2" }),
          makeRoomMessage({ mentioned: true, inboxId: "thread:thread-1" }),
        ],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      decision: {
        action: "block",
        reason: expect.stringContaining(
          "these have no reply from you yet: thread:thread-1.",
        ),
      },
      blockedBy: ROOM_REPLY_GUARD_FEATURE_ID,
    });
    expect(
      (result.decision as { readonly reason: string }).reason,
    ).not.toContain("room:room-1");
  });

  it("confirms a reply only in the Inbox that holds it", async () => {
    const replies = (repliedInboxIds?: readonly string[]) =>
      composeContextFeatures({
        context: makeContext("meta"),
        features: [
          createRoomReplyGuardFeature({
            readReplyStatus: async () => ({
              replied: true,
              ...(repliedInboxIds ? { repliedInboxIds } : {}),
            }),
          }),
        ],
      }).evaluateRunBeforeStop(
        {
          runId: "run-one-inbox",
          attempt: 0,
          stopHookActive: false,
          inputs: [
            makeRoomMessage({ mentioned: true, inboxId: "room:room-1" }),
          ],
        },
        new AbortController().signal,
      );

    await expect(replies(["room:room-1"])).resolves.toEqual({
      decision: { action: "allow" },
      replyConfirmed: true,
    });
    await expect(replies(["thread:thread-1"])).resolves.toEqual({
      decision: { action: "block", reason: ROOM_REPLY_REMINDER },
      blockedBy: ROOM_REPLY_GUARD_FEATURE_ID,
    });
    // A TeamHub that reports no Inboxes counts a reply anywhere.
    await expect(replies()).resolves.toEqual({
      decision: { action: "allow" },
      replyConfirmed: true,
    });
  });

  it("allows immediately when stopHookActive is already true", async () => {
    const readReplyStatus = vi.fn(async () => ({ replied: false }));
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });

    const result = await composed.evaluateRunBeforeStop(
      {
        runId: "run-2",
        attempt: 1,
        stopHookActive: true,
        inputs: [makeRoomMessage({ mentioned: true })],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ decision: { action: "allow" } });
    expect(readReplyStatus).not.toHaveBeenCalled();
  });

  it("fails open when TeamHub reply-status check throws", async () => {
    const readReplyStatus = vi.fn(async () => {
      throw new Error("teamhub unreachable");
    });
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [createRoomReplyGuardFeature({ readReplyStatus })],
    });

    const result = await composed.evaluateRunBeforeStop(
      {
        runId: "run-3",
        attempt: 0,
        stopHookActive: false,
        inputs: [makeRoomMessage({ mentioned: true })],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({ decision: { action: "allow" } });
  });

  it("isolates throwing stop-hook features and lets later features decide in order", async () => {
    const order: string[] = [];
    const throwing = defineFeature({
      id: "aaa-throwing",
      context: {
        ports: { onRunBeforeStop: {} },
        create: () => ({
          onRunBeforeStop: () => {
            order.push("aaa-throwing");
            throw new Error("boom");
          },
        }),
      },
    });
    const second = defineFeature({
      id: "zzz-blocker",
      context: {
        ports: { onRunBeforeStop: { after: ["aaa-throwing"] } },
        create: () => ({
          onRunBeforeStop: () => {
            order.push("zzz-blocker");
            return { action: "block", reason: "finish checklist" };
          },
        }),
      },
    });
    const composed = composeContextFeatures({
      context: makeContext("meta"),
      features: [second, throwing],
    });

    const result = await composed.evaluateRunBeforeStop(
      {
        runId: "run-4",
        attempt: 0,
        stopHookActive: false,
        inputs: [],
      },
      new AbortController().signal,
    );

    expect(order).toEqual(["aaa-throwing", "zzz-blocker"]);
    expect(result).toEqual({
      decision: { action: "block", reason: "finish checklist" },
      blockedBy: "zzz-blocker",
    });
  });
});
