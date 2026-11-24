import { describe, expect, it } from "vitest";
import type {
  RunActivityOutcome,
  RunEvent,
} from "../../../src/agent/executor/provider.js";
import {
  awaitedReplyInboxIds,
  awaitsReply,
  ReplyDelivery,
} from "../../../src/agent/executor/reply-delivery.js";
import type { Message } from "../../../src/agent/executor/types.js";

function inboxMessage(
  id: string,
  queued?: {
    readonly authorType: "agent" | "user";
    readonly messageKind: string;
    readonly mentioned: boolean;
  },
  inboxId = "room:room-1",
): Message {
  return {
    messageId: id,
    rawMessage: id,
    segments: [{ type: "text", content: id }],
    ...(queued
      ? {
          acceptedNotification: {
            inboxId,
            messages: [
              {
                id: `${id}-msg`,
                body: "hello",
                author: "Leo",
                ...queued,
              },
            ],
          },
        }
      : {}),
  } as unknown as Message;
}

const humanMention = (id = "mention", inboxId = "room:room-1") =>
  inboxMessage(
    id,
    {
      authorType: "user",
      messageKind: "conversation",
      mentioned: true,
    },
    inboxId,
  );

const writeEvents = (id: string, outcome?: RunActivityOutcome): RunEvent[] => [
  {
    type: "activity.started",
    activityId: id,
    kind: "message",
    title: "bash",
  },
  ...(outcome
    ? [{ type: "activity.finished" as const, activityId: id, outcome }]
    : []),
];

describe("ReplyDelivery", () => {
  it("classifies an awaiting-human run with zero message writes as replyNotSent and not replyUndelivered", () => {
    const delivery = new ReplyDelivery();
    delivery.observeInputs([humanMention()]);
    delivery.observe({
      type: "activity.started",
      activityId: "read-1",
      kind: "message_read",
      title: "bash",
    });
    delivery.observe({
      type: "activity.finished",
      activityId: "read-1",
      outcome: "failed",
    });

    expect(delivery.replyNotSent).toBe(true);
    expect(delivery.replyUndelivered).toBe(false);
    expect(delivery.hasFailures).toBe(true);
    expect(delivery.counts()).toEqual({
      failedMessageWrites: 0,
      deliveredMessageWrites: 0,
      failedMessageReads: 1,
    });
  });

  it.each([undefined, "canceled", "declined"] as const)(
    "classifies an awaiting-human run with an uncompleted or %s message write as replyNotSent",
    (outcome) => {
      const delivery = new ReplyDelivery();
      delivery.observeInputs([humanMention()]);
      for (const event of writeEvents("send-1", outcome)) {
        delivery.observe(event);
      }

      expect(delivery.replyNotSent).toBe(true);
      expect(delivery.replyUndelivered).toBe(false);
      expect(delivery.hasFailures).toBe(false);
      expect(delivery.counts()).toEqual({
        failedMessageWrites: 0,
        deliveredMessageWrites: 0,
        failedMessageReads: 0,
      });
    },
  );

  it("classifies an awaiting-human run whose message writes all failed as replyUndelivered and not replyNotSent", () => {
    const delivery = new ReplyDelivery();
    delivery.observeInputs([humanMention()]);
    for (const event of [
      ...writeEvents("send-1", "failed"),
      ...writeEvents("send-2", "failed"),
    ]) {
      delivery.observe(event);
    }

    expect(delivery.replyUndelivered).toBe(true);
    expect(delivery.replyNotSent).toBe(false);
    expect(delivery.hasFailures).toBe(true);
    expect(delivery.counts()).toEqual({
      failedMessageWrites: 2,
      deliveredMessageWrites: 0,
      failedMessageReads: 0,
    });
  });

  it("clears both replyUndelivered and replyNotSent once any message write succeeds", () => {
    const delivery = new ReplyDelivery();
    delivery.observeInputs([humanMention()]);
    for (const event of [
      ...writeEvents("send-1", "failed"),
      ...writeEvents("send-2", "succeeded"),
    ]) {
      delivery.observe(event);
    }

    expect(delivery.replyUndelivered).toBe(false);
    expect(delivery.replyNotSent).toBe(false);
    expect(delivery.hasFailures).toBe(true);
    expect(delivery.counts()).toEqual({
      failedMessageWrites: 1,
      deliveredMessageWrites: 1,
      failedMessageReads: 0,
    });
  });

  it.each([
    ["bare input without notification", inboxMessage("bare")],
    [
      "Room talk that did not mention the Agent",
      inboxMessage("talk", {
        authorType: "user",
        messageKind: "conversation",
        mentioned: false,
      }),
    ],
    [
      "routine wake that mentions the Agent",
      inboxMessage("wake", {
        authorType: "user",
        messageKind: "agent_runtime",
        mentioned: true,
      }),
    ],
    [
      "another Agent's mention",
      inboxMessage("agent", {
        authorType: "agent",
        messageKind: "conversation",
        mentioned: true,
      }),
    ],
  ] as const)(
    "does not classify %s as replyUndelivered or replyNotSent even when writes fail",
    (_label, input) => {
      const delivery = new ReplyDelivery();
      delivery.observeInputs([input]);
      for (const event of writeEvents("send-1", "failed")) {
        delivery.observe(event);
      }

      expect(delivery.replyUndelivered).toBe(false);
      expect(delivery.replyNotSent).toBe(false);
      expect(delivery.hasFailures).toBe(true);
      expect(delivery.counts()).toEqual({
        failedMessageWrites: 1,
        deliveredMessageWrites: 0,
        failedMessageReads: 0,
      });
    },
  );

  it("recognizes awaitingHuman when a steered input mentions the Agent", () => {
    const delivery = new ReplyDelivery();
    delivery.observeInputs([
      inboxMessage("talk", {
        authorType: "user",
        messageKind: "conversation",
        mentioned: false,
      }),
    ]);
    for (const event of writeEvents("send-1", "failed")) {
      delivery.observe(event);
    }
    expect(delivery.replyUndelivered).toBe(false);

    delivery.observeInputs([humanMention("steer-mention")]);
    expect(delivery.replyUndelivered).toBe(true);
    expect(delivery.replyNotSent).toBe(false);
  });

  it("extracts distinct awaitedReplyInboxIds in input order", () => {
    const inputs = [
      inboxMessage(
        "talk",
        {
          authorType: "user",
          messageKind: "conversation",
          mentioned: false,
        },
        "thread:ignored",
      ),
      humanMention("m1", "room:room-1"),
      humanMention("m2", "thread:t1"),
      humanMention("m3", "room:room-1"),
    ];

    expect(inputs.map(awaitsReply)).toEqual([false, true, true, true]);
    expect(awaitedReplyInboxIds(inputs)).toEqual(["room:room-1", "thread:t1"]);
  });
});
