import { describe, expect, it, vi } from "vitest";

import { translator } from "../i18n/language.js";
import {
  admitInbound,
  IMessageChannel,
  inboundIdempotencyKey,
  OUTBOUND_PREFIX,
  parseNumberedAnswer,
  type BridgeState,
} from "./imessage-channel.js";
import type { ChannelState, ChannelStore } from "./imessage-state.js";
import {
  TeamHubStreamError,
  type IMessageTeamHub,
  type SseEvent,
  type TeamHubResult,
} from "./imessage-teamhub.js";
import type {
  IMsgMessage,
  IMsgSendResult,
  IMsgSendTarget,
  IMsgWatch,
} from "./imsg-rpc.js";
import { silentLog } from "./test-support.js";

const ME = "+14155550100";
const ROOM = "room-1";
const AGENT = "agent-1";
const HUMAN = "human-1";

const row = (id: number, extra: Partial<IMsgMessage> = {}): IMsgMessage => ({
  id,
  guid: `G-${String(id)}`,
  is_from_me: false,
  is_group: false,
  sender: ME,
  chat_id: 7,
  text: `hello ${String(id)}`,
  ...extra,
});

describe("admitInbound", () => {
  const handles = [ME, "me@icloud.com"];
  it.each([
    ["a group", { is_group: true }, "group"],
    ["my own row", { is_from_me: true }, "from_me"],
    ["an unknown sender", { sender: "+19995550100" }, "unknown_sender"],
    ["an echo of a reply", { text: `${OUTBOUND_PREFIX}hi` }, "own_echo"],
    ["an empty text", { text: "  " }, "empty"],
    ["no text or attachments", { text: undefined }, "empty"],
    [
      "a missing attachment only",
      {
        text: undefined,
        attachments: [{ missing: true, original_path: "/tmp/a.png" }],
      },
      "empty",
    ],
    [
      "a sticker only",
      {
        text: undefined,
        attachments: [{ is_sticker: true, original_path: "/tmp/a.png" }],
      },
      "empty",
    ],
    ["an edit", { type: "edited" }, "mutation"],
    ["an unsend", { type: "unsent" }, "mutation"],
  ])("skips %s", (_name, extra, reason) => {
    expect(admitInbound(row(1, extra), handles)).toEqual({
      accept: false,
      reason,
    });
  });

  it("accepts a text from a handle, normalized", () => {
    expect(
      admitInbound(
        row(1, { sender: "+1 (415) 555-0100", text: " hi " }),
        handles,
      ),
    ).toEqual({ accept: true, text: "hi", attachments: [], chatId: 7 });
  });

  it("accepts an attachment without text", () => {
    expect(
      admitInbound(
        row(1, {
          text: undefined,
          attachments: [
            {
              transfer_name: "photo.jpg",
              mime_type: "image/jpeg",
              original_path: "/tmp/photo.jpg",
            },
          ],
        }),
        handles,
      ),
    ).toEqual({
      accept: true,
      text: "",
      attachments: [
        {
          path: "/tmp/photo.jpg",
          filename: "photo.jpg",
          mediaType: "image/jpeg",
        },
      ],
      chatId: 7,
    });
  });

  it("falls back to the chat identifier without a sender", () => {
    expect(
      admitInbound(
        row(1, { sender: undefined, chat_identifier: "Me@iCloud.com" }),
        handles,
      ),
    ).toMatchObject({ accept: true });
  });
});

describe("parseNumberedAnswer", () => {
  it("reads radio and checkbox replies", () => {
    expect(parseNumberedAnswer(" 2 ", "radio", 3)).toEqual([2]);
    expect(parseNumberedAnswer("1, 3", "checkbox", 3)).toEqual([1, 3]);
    expect(parseNumberedAnswer("1,3", "radio", 3)).toBeUndefined();
    expect(parseNumberedAnswer("4", "radio", 3)).toBeUndefined();
    expect(parseNumberedAnswer("0", "radio", 3)).toBeUndefined();
    expect(parseNumberedAnswer("1,1", "checkbox", 3)).toBeUndefined();
    expect(parseNumberedAnswer("two", "radio", 3)).toBeUndefined();
  });
});

describe("inboundIdempotencyKey", () => {
  it("is imessage: and the guid, limited to the allowed characters", () => {
    expect(inboundIdempotencyKey(row(1, { guid: "ABC-123" }))).toBe(
      "imessage:ABC-123",
    );
    expect(inboundIdempotencyKey(row(1, { guid: "p:0/AB C" }))).toBe(
      "imessage:p:0-AB-C",
    );
    expect(inboundIdempotencyKey(row(9, { guid: undefined }))).toBe(
      "imessage:rowid-9",
    );
  });
});

class Stream {
  readonly #items: SseEvent[] = [];
  #ended = false;
  #notify: () => void = () => {};

  push(event: SseEvent): void {
    this.#items.push(event);
    this.#notify();
  }

  end(): void {
    this.#ended = true;
    this.#notify();
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<SseEvent> {
    for (;;) {
      if (signal.aborted) return;
      const item = this.#items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#notify = resolve;
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  }
}

const ok = <T>(value: T): TeamHubResult<T> => ({ ok: true, value });
const failed = (status: number): TeamHubResult<never> => ({
  ok: false,
  status,
});

const roomEvent = (
  seq: number,
  eventType: string,
  payload: Record<string, unknown>,
): SseEvent => ({
  event: "room.event",
  data: JSON.stringify({
    room_id: ROOM,
    room_seq: seq,
    event_type: eventType,
    payload: { kind: eventType, ...payload },
  }),
});

const message = (
  seq: number,
  extra: Record<string, unknown> = {},
  author: { kind: string; id: string } = { kind: "agent", id: AGENT },
): SseEvent =>
  roomEvent(seq, "message.created", {
    message: {
      id: `m-${String(seq)}`,
      author,
      message_kind: "conversation",
      raw_message: `reply ${String(seq)}`,
      ...extra,
    },
  });

const questionCard = (
  input: "radio" | "checkbox" = "radio",
  extra: Record<string, unknown> = {},
) => ({
  card_type: "personal_notice",
  intent: "decision_requested",
  decision_id: "d-1",
  version: 3,
  kind: "question",
  title: "Which day?",
  status: "pending",
  decision_owner: { id: HUMAN, kind: "human", display_name: "Me" },
  question: {
    questions: [
      {
        id: "q1",
        prompt: "Pick one",
        input,
        options: [
          { id: "o1", label: "Monday" },
          { id: "o2", label: "Tuesday" },
          { id: "o3", label: "Friday" },
        ],
      },
    ],
  },
  ...extra,
});

const setup = (
  options: {
    state?: ChannelState;
    anotherMe?: TeamHubResult<{ agentActorId?: string; roomId?: string }>;
    latest?: number;
  } = {},
) => {
  let state: ChannelState = options.state ?? {};
  const faults = { nextUpdate: undefined as Error | undefined };
  const store: ChannelStore = {
    get: () => state,
    update: (patch) => {
      const fault = faults.nextUpdate;
      if (fault) {
        faults.nextUpdate = undefined;
        throw fault;
      }
      state = { ...state, ...patch };
    },
  };
  let watch: IMsgWatch | undefined;
  const sent: { target: IMsgSendTarget; text: string }[] = [];
  const sendResults: IMsgSendResult[] = [];
  const services = new Map<number, string | undefined | Error>();
  const transport = {
    chatService: vi.fn(async (chatId: number) => {
      const service = services.has(chatId) ? services.get(chatId) : "iMessage";
      if (service instanceof Error) {
        services.delete(chatId);
        throw service;
      }
      return service;
    }),
    start: vi.fn((w: IMsgWatch) => {
      watch = w;
    }),
    send: vi.fn(async (target: IMsgSendTarget, text: string) => {
      sent.push({ target, text });
      return sendResults.shift() ?? { ok: true as const };
    }),
    stop: vi.fn(async () => {}),
  };
  const streams: Stream[] = [];
  const streamFailures: number[] = [];
  const postResults: TeamHubResult<void>[] = [];
  const decideResults: TeamHubResult<void>[] = [];
  const teamhub = {
    me: vi.fn(async () => ok({ actorId: HUMAN })),
    anotherMe: vi.fn(
      async () =>
        options.anotherMe ?? ok({ agentActorId: AGENT, roomId: ROOM }),
    ),
    latestRoomSeq: vi.fn(async () => ok(options.latest ?? 10)),
    postMessage: vi.fn(
      async (_room: string, _key: string, _text: string) =>
        postResults.shift() ?? ok(undefined),
    ),
    decide: vi.fn(
      async (_id: string, _body: unknown) =>
        decideResults.shift() ?? ok(undefined),
    ),
    events: vi.fn((_room: string, _seq: number, signal: AbortSignal) => {
      const status = streamFailures.shift();
      if (status !== undefined)
        // eslint-disable-next-line require-yield
        return (async function* () {
          throw new TeamHubStreamError(status);
        })();
      const stream = new Stream();
      streams.push(stream);
      return stream.iterate(signal);
    }),
  } satisfies IMessageTeamHub;
  const server: { url: string; owner?: string } = {
    url: "https://linger.test",
  };
  const states: BridgeState[] = [];
  const waits: number[] = [];
  const channel = new IMessageChannel({
    transport,
    teamhub,
    store,
    handles: [ME],
    chatUrl: (roomId) => `https://linger.test/t/t1/rooms/${roomId}/chat`,
    log: silentLog,
    t: translator("en"),
    onState: (s) => states.push(s),
    serverUrl: () => server.url,
    ownerActorId: () => server.owner,
    wait: (ms) => {
      waits.push(ms);
      return new Promise((resolve) => setTimeout(resolve, 0));
    },
  });
  const inbound = (m: IMsgMessage) => watch!.message(m);
  const stream = () => streams.at(-1)!;
  const running = () =>
    vi.waitFor(() => {
      expect(states.at(-1)).toBe("running");
      expect(streams.length).toBeGreaterThan(0);
    });
  return {
    channel,
    transport,
    teamhub,
    sent,
    sendResults,
    services,
    postResults,
    decideResults,
    streamFailures,
    states,
    waits,
    inbound,
    stream,
    running,
    state: () => state,
    server,
    faults,
  };
};

describe("IMessageChannel inbound", () => {
  it("posts one Message for a self-chat text and none for echoes", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    // Self-chat: one row from me, one inbound copy with a new guid.
    f.inbound(row(1, { is_from_me: true, guid: "SENT" }));
    f.inbound(row(2, { guid: "COPY", text: "hello" }));
    // The echo of a reply comes back the same way.
    f.inbound(row(3, { is_from_me: true, text: `${OUTBOUND_PREFIX}r` }));
    f.inbound(row(4, { text: `${OUTBOUND_PREFIX}r` }));
    await vi.waitFor(() => expect(f.state().rowid).toBe(4));
    expect(f.teamhub.postMessage).toHaveBeenCalledOnce();
    expect(f.teamhub.postMessage).toHaveBeenCalledWith(
      ROOM,
      "imessage:COPY",
      "hello",
    );
    expect(f.state().replyChatId).toBe(7);
    await f.channel.stop();
  });

  it("retries with the same key and keeps the cursor until it lands", async () => {
    const f = setup({ state: { rowid: 1 } });
    f.postResults.push(failed(503), failed(0));
    f.channel.start();
    await f.running();
    f.inbound(row(2));
    await vi.waitFor(() =>
      expect(f.teamhub.postMessage).toHaveBeenCalledTimes(3),
    );
    const keys = f.teamhub.postMessage.mock.calls.map(([, key]) => key);
    expect(new Set(keys)).toEqual(new Set(["imessage:G-2"]));
    await vi.waitFor(() => expect(f.state().rowid).toBe(2));
    await f.channel.stop();
  });

  it("moves past a Message TeamHub refuses", async () => {
    const f = setup();
    f.postResults.push(failed(400));
    f.channel.start();
    await f.running();
    f.inbound(row(5));
    f.inbound(row(6));
    await vi.waitFor(() => expect(f.state().rowid).toBe(6));
    expect(f.teamhub.postMessage).toHaveBeenCalledTimes(2);
    await f.channel.stop();
  });

  it("ignores rows replayed after a resubscription", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.inbound(row(5));
    f.inbound(row(5));
    f.inbound(row(4));
    await vi.waitFor(() => expect(f.state().rowid).toBe(5));
    expect(f.teamhub.postMessage).toHaveBeenCalledOnce();
    await f.channel.stop();
  });

  it("stops at a signed-out session and keeps the row", async () => {
    const f = setup({ state: { rowid: 1 } });
    f.postResults.push(failed(401));
    f.channel.start();
    await f.running();
    f.teamhub.me.mockResolvedValue(failed(401));
    f.inbound(row(2));
    await vi.waitFor(() => expect(f.states.at(-1)).toBe("signed_out"));
    expect(f.state().rowid).toBe(1);
    f.teamhub.me.mockResolvedValue(ok({ actorId: HUMAN }));
    await vi.waitFor(() => expect(f.state().rowid).toBe(2));
    expect(f.teamhub.postMessage).toHaveBeenCalledTimes(2);
    await f.channel.stop();
  });
});

describe("IMessageChannel service check", () => {
  it("posts only rows of iMessage chats and looks each chat up once", async () => {
    const f = setup();
    f.services.set(8, "SMS");
    f.services.set(9, undefined);
    f.services.set(7, "imessage");
    f.channel.start();
    await f.running();
    f.inbound(row(1, { chat_id: 8 }));
    f.inbound(row(2, { chat_id: 9 }));
    f.inbound(row(3, { chat_id: 7 }));
    f.inbound(row(4, { chat_id: 7 }));
    await vi.waitFor(() => expect(f.state().rowid).toBe(4));
    expect(f.teamhub.postMessage.mock.calls.map(([, key]) => key)).toEqual([
      "imessage:G-3",
      "imessage:G-4",
    ]);
    expect(f.transport.chatService.mock.calls.map(([id]) => id)).toEqual([
      8, 9, 7,
    ]);
    expect(f.state().replyChatId).toBe(7);
    await f.channel.stop();
  });

  it("retries a failed lookup without moving the cursor", async () => {
    const f = setup({ state: { rowid: 1 } });
    f.services.set(7, new Error("timeout"));
    f.channel.start();
    await f.running();
    f.inbound(row(2));
    await vi.waitFor(() => expect(f.state().rowid).toBe(2));
    expect(f.transport.chatService).toHaveBeenCalledTimes(2);
    expect(f.waits).toContain(1_000);
    expect(f.teamhub.postMessage).toHaveBeenCalledOnce();
    await f.channel.stop();
  });
});

describe("IMessageChannel outbound", () => {
  it("starts at the Chat's end and sends only Another Me's Messages", async () => {
    const f = setup({ latest: 10 });
    f.channel.start();
    await f.running();
    expect(f.teamhub.events).toHaveBeenCalledWith(ROOM, 10, expect.anything());
    f.stream().push(message(10));
    f.stream().push(message(11, {}, { kind: "human", id: HUMAN }));
    f.stream().push(message(12, {}, { kind: "agent", id: "agent-other" }));
    f.stream().push(message(13, { message_kind: "room_notice" }));
    f.stream().push(message(14));
    f.stream().push(message(14));
    f.stream().push(
      roomEvent(15, "message.reactions.changed", {
        message_id: "m-14",
        reactions: [],
      }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(15));
    expect(f.sent).toEqual([
      { target: { to: ME }, text: `${OUTBOUND_PREFIX}reply 14` },
    ]);
    expect(f.state().inFlightSeq).toBeNull();
    await f.channel.stop();
  });

  it("replies in the chat the person last wrote from", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.inbound(row(1, { chat_id: 33 }));
    await vi.waitFor(() => expect(f.state().replyChatId).toBe(33));
    f.stream().push(message(11));
    await vi.waitFor(() => expect(f.sent).toHaveLength(1));
    expect(f.sent[0]!.target).toEqual({ chatId: 33 });
    await f.channel.stop();
  });

  it("prefixes every chunk of a long reply", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    const paragraph = "word ".repeat(500).trim();
    f.stream().push(
      message(11, { raw_message: `${paragraph}\n\n${paragraph}` }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(11));
    expect(f.sent).toHaveLength(2);
    for (const { text } of f.sent) {
      expect(text.startsWith(OUTBOUND_PREFIX)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(3000 + OUTBOUND_PREFIX.length);
    }
    await f.channel.stop();
  });

  it("never resends an event whose send was cut off", async () => {
    const f = setup({ state: { roomId: ROOM, roomSeq: 5, inFlightSeq: 6 } });
    f.channel.start();
    await f.running();
    expect(f.state()).toMatchObject({ roomSeq: 6, inFlightSeq: null });
    expect(f.teamhub.events).toHaveBeenCalledWith(ROOM, 6, expect.anything());
    f.stream().push(message(6));
    f.stream().push(message(7));
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(7));
    expect(f.sent.map((s) => s.text)).toEqual([`${OUTBOUND_PREFIX}reply 7`]);
    await f.channel.stop();
  });

  it("retries a send that never started and gives up on an uncertain one", async () => {
    const f = setup();
    f.sendResults.push({ ok: false, retrySafe: true });
    f.channel.start();
    await f.running();
    f.stream().push(message(11));
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(11));
    expect(f.sent.map((s) => s.text)).toEqual([
      `${OUTBOUND_PREFIX}reply 11`,
      `${OUTBOUND_PREFIX}reply 11`,
    ]);

    f.sendResults.push({ ok: false, retrySafe: false });
    const paragraph = "word ".repeat(500).trim();
    f.stream().push(
      message(12, { raw_message: `${paragraph}\n\n${paragraph}` }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(12));
    expect(f.sent).toHaveLength(3);
    expect(f.state().inFlightSeq).toBeNull();
    await f.channel.stop();
  });

  it("waits for Another Me", async () => {
    const f = setup({ anotherMe: ok({}) });
    f.channel.start();
    await vi.waitFor(() => expect(f.states).toContain("no_another_me"));
    expect(f.waits).toContain(60_000);
    expect(f.teamhub.events).not.toHaveBeenCalled();
    await f.channel.stop();
  });

  it("probes a signed-out session and resumes", async () => {
    const f = setup();
    f.streamFailures.push(401);
    f.channel.start();
    await vi.waitFor(() => expect(f.states).toContain("signed_out"));
    expect(f.waits).toContain(30_000);
    await f.running();
    f.stream().push({ event: "session.expired", data: "{}" });
    await vi.waitFor(() =>
      expect(f.states.filter((s) => s === "signed_out")).toHaveLength(2),
    );
    await vi.waitFor(() => expect(f.teamhub.events).toHaveBeenCalledTimes(3));
    await f.channel.stop();
  });
});

describe("IMessageChannel question cards", () => {
  const cardSetup = async (input: "radio" | "checkbox" = "radio") => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.stream().push(message(11, { card: questionCard(input) }));
    await vi.waitFor(() => expect(f.state().pendingCard).toBeTruthy());
    return f;
  };

  it("sends numbered options and remembers the card", async () => {
    const f = await cardSetup();
    expect(f.sent.map((s) => s.text)).toEqual([
      `${OUTBOUND_PREFIX}Which day?\nPick one\n1. Monday\n2. Tuesday\n3. Friday\nReply with a number.`,
    ]);
    expect(f.state().pendingCard).toMatchObject({
      messageId: "m-11",
      decisionId: "d-1",
      version: 3,
      questionId: "q1",
      optionIds: ["o1", "o2", "o3"],
    });
    await f.channel.stop();
  });

  it("answers a radio card with one option", async () => {
    const f = await cardSetup();
    f.inbound(row(1, { text: "2" }));
    await vi.waitFor(() => expect(f.state().pendingCard).toBeNull());
    expect(f.teamhub.decide).toHaveBeenCalledWith("d-1", {
      expected_version: 3,
      decision: "submit",
      answers: { q1: "o2" },
    });
    expect(f.teamhub.postMessage).not.toHaveBeenCalled();
    await f.channel.stop();
  });

  it("answers a checkbox card with several options", async () => {
    const f = await cardSetup("checkbox");
    expect(f.sent[0]!.text.endsWith("Reply with numbers, e.g. 1,3.")).toBe(
      true,
    );
    f.inbound(row(1, { text: "3, 1" }));
    await vi.waitFor(() => expect(f.teamhub.decide).toHaveBeenCalled());
    expect(f.teamhub.decide.mock.calls[0]![1]).toMatchObject({
      answers: { q1: ["o3", "o1"] },
    });
    await f.channel.stop();
  });

  it("posts other replies as Messages and keeps the card", async () => {
    const f = await cardSetup();
    f.inbound(row(1, { text: "4" }));
    f.inbound(row(2, { text: "let me think" }));
    await vi.waitFor(() =>
      expect(f.teamhub.postMessage).toHaveBeenCalledTimes(2),
    );
    expect(f.teamhub.decide).not.toHaveBeenCalled();
    expect(f.state().pendingCard).toBeTruthy();
    await f.channel.stop();
  });

  it("says when the card was already answered", async () => {
    const f = await cardSetup();
    f.decideResults.push(failed(409));
    f.inbound(row(1, { text: "1" }));
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]!.text).toBe(
      `${OUTBOUND_PREFIX}This question was already answered or changed. Open Linger to see it.`,
    );
    expect(f.state().pendingCard).toBeNull();
    await f.channel.stop();
  });

  it("forgets a card that changed elsewhere", async () => {
    const f = await cardSetup();
    f.stream().push(
      roomEvent(12, "card.changed", { message_id: "m-11", version: 3 }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(12));
    expect(f.state().pendingCard).toBeTruthy();
    f.stream().push(
      roomEvent(13, "card.changed", { message_id: "m-11", version: 4 }),
    );
    await vi.waitFor(() => expect(f.state().pendingCard).toBeNull());
    await f.channel.stop();
  });

  it("links other cards to Linger", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.stream().push(
      message(11, {
        card: questionCard("radio", {
          kind: "connector_write",
          title: "Send the email?",
        }),
      }),
    );
    f.stream().push(
      message(12, {
        card: questionCard("radio", { decision_owner: { id: "someone" } }),
      }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(12));
    expect(f.sent.map((s) => s.text)).toEqual([
      `${OUTBOUND_PREFIX}Send the email?\nOpen Linger to answer: https://linger.test/t/t1/rooms/${ROOM}/chat`,
      `${OUTBOUND_PREFIX}Which day?\nOpen Linger to answer: https://linger.test/t/t1/rooms/${ROOM}/chat`,
    ]);
    expect(f.state().pendingCard).toBeFalsy();
    await f.channel.stop();
  });
});

describe("IMessageChannel account binding", () => {
  it("binds to the first account and server it runs for", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    expect(f.state()).toMatchObject({
      actorId: HUMAN,
      serverUrl: "https://linger.test",
    });
    await f.channel.stop();
  });

  it.each([
    [
      "another account",
      { actorId: "human-2", serverUrl: "https://linger.test" },
      {},
    ],
    ["another server", { actorId: HUMAN, serverUrl: "https://old.test" }, {}],
    ["an enrollment of someone else", {}, { owner: "human-9" }],
  ])("pauses for %s", async (_name, bound, server) => {
    const f = setup({ state: bound });
    Object.assign(f.server, server);
    f.channel.start();
    await vi.waitFor(() => expect(f.states).toContain("other_account"));
    expect(f.waits).toContain(30_000);
    expect(f.teamhub.anotherMe).not.toHaveBeenCalled();
    f.inbound(row(1));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(f.teamhub.postMessage).not.toHaveBeenCalled();
    await f.channel.stop();
  });
});

describe("IMessageChannel review fixes", () => {
  it("forgets a card once a later Message goes out", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.stream().push(message(11, { card: questionCard() }));
    await vi.waitFor(() => expect(f.state().pendingCard).toBeTruthy());
    f.stream().push(message(12));
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(12));
    expect(f.state().pendingCard).toBeNull();
    f.inbound(row(1, { text: "1" }));
    await vi.waitFor(() => expect(f.teamhub.postMessage).toHaveBeenCalled());
    expect(f.teamhub.decide).not.toHaveBeenCalled();
    await f.channel.stop();
  });

  it("waits for a restarting imsg without using up attempts", async () => {
    const f = setup();
    for (let i = 0; i < 7; i++)
      f.sendResults.push({
        ok: false,
        retrySafe: true,
        notRunning: true,
      });
    f.channel.start();
    await f.running();
    f.stream().push(message(11));
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(11));
    expect(f.sent).toHaveLength(8);
    expect(f.waits.filter((ms) => ms === 2_000)).toHaveLength(7);
    await f.channel.stop();
  });

  it("gives up after two minutes without imsg", async () => {
    const f = setup();
    f.transport.send.mockResolvedValue({
      ok: false,
      retrySafe: true,
      notRunning: true,
    });
    f.channel.start();
    await f.running();
    f.stream().push(message(11));
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(11));
    expect(f.waits.filter((ms) => ms === 2_000)).toHaveLength(60);
    expect(f.state().inFlightSeq).toBeNull();
    await f.channel.stop();
  });

  it("links to Linger when an answer is refused", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.stream().push(message(11, { card: questionCard() }));
    await vi.waitFor(() => expect(f.state().pendingCard).toBeTruthy());
    f.decideResults.push(failed(404));
    f.inbound(row(1, { text: "1" }));
    await vi.waitFor(() => expect(f.sent).toHaveLength(2));
    expect(f.sent[1]!.text).toBe(
      `${OUTBOUND_PREFIX}Couldn't submit this answer. Open Linger to answer: https://linger.test/t/t1/rooms/${ROOM}/chat`,
    );
    expect(f.state().pendingCard).toBeNull();
    await f.channel.stop();
  });

  it("recovers from an unexpected failure", async () => {
    const f = setup();
    f.channel.start();
    await f.running();
    f.faults.nextUpdate = Object.assign(new Error("disk full"), {
      code: "ENOSPC",
    });
    f.inbound(row(1));
    await vi.waitFor(() => expect(f.states).toContain("error"));
    await vi.waitFor(() => expect(f.state().rowid).toBe(1));
    expect(f.states.at(-1)).toBe("running");
    await f.channel.stop();
  });

  it("uses the isolated iMessage channel Room and falls back on 404 from an older server", async () => {
    const channelRoom = "room-imessage";
    const f = setup();
    const openChannelRoom = vi.fn(async () => ok({ roomId: channelRoom }));
    const teamhub: IMessageTeamHub = {
      ...f.teamhub,
      openChannelRoom,
    };
    const channel = new IMessageChannel({
      transport: f.transport,
      teamhub,
      store: {
        get: () => f.state(),
        update: (p) => Object.assign(f.state(), p),
      },
      handles: [ME],
      chatUrl: (id) => `https://linger.test/t/t1/rooms/${id}/chat`,
      log: silentLog,
      t: translator("en"),
      onState: (s) => f.states.push(s),
      serverUrl: () => "https://linger.test",
      wait: async () => {},
    });
    channel.start();
    await vi.waitFor(() => expect(f.states).toContain("running"));
    expect(openChannelRoom).toHaveBeenCalledWith("imessage");
    expect(f.teamhub.latestRoomSeq).toHaveBeenCalledWith(channelRoom);
    await channel.stop();

    const legacy = setup();
    const legacyTeamHub: IMessageTeamHub = {
      ...legacy.teamhub,
      openChannelRoom: vi.fn(async () => failed(404)),
    };
    const legacyChannel = new IMessageChannel({
      transport: legacy.transport,
      teamhub: legacyTeamHub,
      store: {
        get: () => legacy.state(),
        update: (p) => Object.assign(legacy.state(), p),
      },
      handles: [ME],
      chatUrl: (id) => `https://linger.test/t/t1/rooms/${id}/chat`,
      log: silentLog,
      t: translator("en"),
      onState: (s) => legacy.states.push(s),
      serverUrl: () => "https://linger.test",
      wait: async () => {},
    });
    legacyChannel.start();
    await vi.waitFor(() => expect(legacy.states).toContain("running"));
    expect(legacy.teamhub.latestRoomSeq).toHaveBeenCalledWith(ROOM);
    await legacyChannel.stop();
  });

  it("sends outbound Document cards as staged files and falls back to a link on error", async () => {
    const f = setup();
    const sends: { target: IMsgSendTarget; text: string; file?: string }[] = [];
    const transport = {
      ...f.transport,
      send: vi.fn(
        async (
          target: IMsgSendTarget,
          text: string,
          options?: { file?: string },
        ) => {
          sends.push({
            target,
            text,
            ...(options?.file ? { file: options.file } : {}),
          });
          return { ok: true as const };
        },
      ),
    };
    const downloadDocument = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          bytes: new TextEncoder().encode("# Report\nDetails"),
          filename: "report.md",
          mediaType: "text/markdown",
        }),
      )
      .mockResolvedValueOnce(failed(404));
    const cleaned = vi.fn(async () => {});
    const channel = new IMessageChannel({
      transport,
      teamhub: { ...f.teamhub, downloadDocument },
      store: {
        get: () => f.state(),
        update: (p) => Object.assign(f.state(), p),
      },
      handles: [ME],
      chatUrl: (id) => `https://linger.test/t/t1/rooms/${id}/chat`,
      documentUrl: (id) => `https://linger.test/t/t1/documents/${id}`,
      log: silentLog,
      t: translator("en"),
      onState: (s) => f.states.push(s),
      serverUrl: () => "https://linger.test",
      wait: async () => {},
      stageAttachment: async (filename) => ({
        filePath: `/tmp/staged/${filename}`,
        cleanup: cleaned,
      }),
    });
    channel.start();
    await vi.waitFor(() => expect(f.states).toContain("running"));
    f.stream().push(
      message(11, {
        raw_message: "See the summary attached.report.md",
        segments: [
          { type: "text", content: "See the summary attached." },
          {
            type: "document",
            content: "report.md",
            document_id: "doc_1",
            presentation: "card",
          },
        ],
        attachments: [],
      }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(11));
    expect(sends).toEqual([
      {
        target: { to: ME },
        text: `${OUTBOUND_PREFIX}See the summary attached.`,
      },
      {
        target: { to: ME },
        text: `${OUTBOUND_PREFIX}report.md`,
        file: "/tmp/staged/report.md",
      },
    ]);

    f.stream().push(
      message(12, {
        raw_message: "Second report.missing.pdf",
        segments: [
          { type: "text", content: "Second report." },
          {
            type: "document",
            content: "missing.pdf",
            document_id: "doc_2",
            presentation: "card",
          },
        ],
        attachments: [],
      }),
    );
    await vi.waitFor(() => expect(f.state().roomSeq).toBe(12));
    expect(sends.at(-1)).toEqual({
      target: { to: ME },
      text: `${OUTBOUND_PREFIX}missing.pdf — open in Linger: https://linger.test/t/t1/documents/doc_2`,
    });
    await channel.stop();
    expect(cleaned).toHaveBeenCalledOnce();
  });

  it("uploads inbound attachments before posting the Message", async () => {
    const f = setup();
    const uploadAttachment = vi.fn(async () => ok({ uploadId: "up.1" }));
    const postMessage = vi.fn(async () => ok(undefined));
    const channel = new IMessageChannel({
      transport: f.transport,
      teamhub: { ...f.teamhub, uploadAttachment, postMessage },
      store: {
        get: () => f.state(),
        update: (p) => Object.assign(f.state(), p),
      },
      handles: [ME],
      chatUrl: (id) => `https://linger.test/t/t1/rooms/${id}/chat`,
      log: silentLog,
      t: translator("en"),
      onState: (s) => f.states.push(s),
      serverUrl: () => "https://linger.test",
      wait: async () => {},
      readAttachment: async () => new TextEncoder().encode("img-bytes"),
    });
    channel.start();
    await vi.waitFor(() => expect(f.states).toContain("running"));
    f.inbound(
      row(2, {
        text: "Check this",
        attachments: [
          {
            transfer_name: "pic.png",
            mime_type: "image/png",
            original_path: "/tmp/pic.png",
          },
        ],
      }),
    );
    await vi.waitFor(() => expect(f.state().rowid).toBe(2));
    expect(uploadAttachment).toHaveBeenCalledWith(ROOM, {
      filename: "pic.png",
      mediaType: "image/png",
      bytes: new TextEncoder().encode("img-bytes"),
    });
    expect(postMessage).toHaveBeenCalledWith(
      ROOM,
      "imessage:G-2",
      "Check this",
      {
        attachmentUploadIds: ["up.1"],
      },
    );
    await channel.stop();
  });
});
