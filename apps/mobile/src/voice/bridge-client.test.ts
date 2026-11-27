import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { StreamHandlers } from "../session/session";
import {
  BRIDGE_PATH,
  BridgeClient,
  BridgeFailed,
  defaultBridgeClientLimits,
  type BridgeClientOptions,
  type BridgeListener,
  type BridgePurpose,
  type BridgeSession,
  type BridgeStream,
} from "./bridge-client";
import { FRAME_SAMPLES } from "./pcm";

class FakeStream implements BridgeStream {
  readonly written: Uint8Array[] = [];
  readonly texts: string[] = [];
  ended = false;
  wasReset = false;

  constructor(
    readonly path: string,
    readonly handlers: StreamHandlers,
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(bytes);
  }

  async sendText(text: string): Promise<void> {
    this.texts.push(text);
  }

  end(): void {
    this.ended = true;
  }

  reset(): void {
    this.wasReset = true;
  }

  /** A message from the Bridge. */
  reply(message: Record<string, unknown>): void {
    this.handlers.onText?.(JSON.stringify(message));
  }

  /** The session or the Bridge ended the stream. */
  drop(): void {
    this.handlers.onReset?.("SESSION_CLOSED");
  }

  start(): Record<string, unknown> {
    return JSON.parse(this.texts[0] ?? "{}") as Record<string, unknown>;
  }

  sequences(): number[] {
    return this.written.map((bytes) =>
      new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, false),
    );
  }
}

class FakeSession implements BridgeSession {
  readonly streams: FakeStream[] = [];

  openSocket(path: string, handlers: StreamHandlers): BridgeStream {
    const stream = new FakeStream(path, handlers);
    this.streams.push(stream);
    return stream;
  }

  latest(): FakeStream {
    const stream = this.streams.at(-1);
    if (!stream) throw new Error("no stream");
    return stream;
  }
}

function frame(value = 0): Int16Array {
  return new Int16Array(FRAME_SAMPLES).fill(value);
}

function client(
  input: {
    purpose?: BridgePurpose;
    held?: boolean;
    listener?: BridgeListener;
    limits?: BridgeClientOptions["limits"];
    session?: BridgeClientOptions["session"];
  } = {},
) {
  const session = new FakeSession();
  const bridge = new BridgeClient({
    voiceSessionId: "voice_session_1",
    credential: "grant",
    purpose: input.purpose ?? "chat_dictation",
    held: input.held,
    listener: input.listener ?? {},
    limits: input.limits,
    session: input.session ?? (async () => session),
  });
  return { bridge, session };
}

async function settle(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BridgeClient", () => {
  it("opens the bridge socket with a start and frames audio after published", async () => {
    const published = vi.fn();
    const { bridge, session } = client({ listener: { published } });
    bridge.start();
    await settle();
    const stream = session.latest();
    expect(stream.path).toBe(BRIDGE_PATH);
    expect(stream.start()).toEqual({
      type: "start",
      voice_session_id: "voice_session_1",
      credential: "grant",
      purpose: "chat_dictation",
      sample_rate: 24_000,
    });
    bridge.sendAudio(frame(1000));
    await settle();
    expect(stream.written).toHaveLength(0);

    stream.reply({ type: "published", track_sid: "TR_1", generation: 3 });
    bridge.sendAudio(frame(-2));
    await settle();
    expect(published).toHaveBeenCalledWith({ trackSid: "TR_1", generation: 3 });
    expect(stream.sequences()).toEqual([0, 1]);
    const first = stream.written[0]!;
    expect(first.length).toBe(4 + FRAME_SAMPLES * 2);
    const view = new DataView(first.buffer, first.byteOffset);
    expect(view.getInt16(4, true)).toBe(1000);
    expect(view.getInt16(4 + 2 * (FRAME_SAMPLES - 1), true)).toBe(1000);
    expect(new DataView(stream.written[1]!.buffer).getInt16(4, true)).toBe(-2);
  });

  it("resumes after a drop and resends only unacknowledged frames", async () => {
    const { bridge, session } = client();
    bridge.start();
    await settle();
    const first = session.latest();
    first.reply({ type: "published", track_sid: "TR_1", generation: 1 });
    for (let index = 0; index < 3; index += 1) bridge.sendAudio(frame());
    await settle();
    first.reply({ type: "ack", through: 1 });
    expect(bridge.unacknowledged).toBe(1);

    first.drop();
    bridge.sendAudio(frame());
    await settle(10_000);
    const second = session.latest();
    expect(second).not.toBe(first);
    expect(second.start()).toMatchObject({
      resume_from: 2,
      credential: "grant",
    });
    second.reply({ type: "published", track_sid: "TR_1", generation: 1 });
    await settle();
    expect(second.sequences()).toEqual([2, 3]);
    expect(bridge.gap).toBe(false);
  });

  it("keeps only the newest 200 ms of Live audio across a drop", async () => {
    const { bridge, session } = client({ purpose: "chat_live" });
    bridge.start();
    await settle();
    const kept = defaultBridgeClientLimits.liveFrames;
    for (let index = 0; index < kept + 15; index += 1)
      bridge.sendAudio(frame());
    session
      .latest()
      .reply({ type: "published", track_sid: "T", generation: 1 });
    await settle();
    expect(session.latest().sequences()).toEqual(
      Array.from({ length: kept }, (_, index) => 15 + index),
    );
    expect(bridge.gap).toBe(false);
  });

  it("drops the oldest frames past its cap and reports a gap", async () => {
    const { bridge, session } = client({ limits: { maxUnackedFrames: 5 } });
    bridge.start();
    await settle();
    for (let index = 0; index < 8; index += 1) bridge.sendAudio(frame());
    expect(bridge.gap).toBe(true);
    session
      .latest()
      .reply({ type: "published", track_sid: "T", generation: 1 });
    await settle();
    expect(session.latest().sequences()).toEqual([3, 4, 5, 6, 7]);
  });

  it("waits out BACKLOG_FULL and resumes from the oldest unacknowledged frame", async () => {
    const { bridge, session } = client({ limits: { backlogRetryMs: 2_000 } });
    bridge.start();
    await settle();
    const first = session.latest();
    first.reply({ type: "published", track_sid: "T", generation: 1 });
    for (let index = 0; index < 4; index += 1) bridge.sendAudio(frame());
    await settle();
    first.reply({ type: "ack", through: 0 });
    first.reply({ type: "error", code: "BACKLOG_FULL" });
    first.drop();
    await settle(1_900);
    expect(session.streams).toHaveLength(1);
    await settle(200);
    const second = session.latest();
    expect(second.start()).toMatchObject({ resume_from: 1 });
    second.reply({ type: "published", track_sid: "T", generation: 1 });
    await settle();
    expect(second.sequences()).toEqual([1, 2, 3]);
  });

  it("drains once the last frame is acknowledged", async () => {
    const { bridge, session } = client();
    await expect(bridge.drain()).resolves.toBeUndefined();
    bridge.start();
    await settle();
    const stream = session.latest();
    stream.reply({ type: "published", track_sid: "T", generation: 1 });
    bridge.sendAudio(frame());
    bridge.sendAudio(frame());
    await settle();
    let drained = false;
    const draining = bridge.drain().then(() => {
      drained = true;
    });
    stream.reply({ type: "ack", through: 0 });
    await settle();
    expect(drained).toBe(false);
    stream.reply({ type: "ack", through: 1 });
    await draining;
    expect(drained).toBe(true);
  });

  it("holds audio until released", async () => {
    const { bridge, session } = client({ held: true });
    bridge.start();
    await settle();
    session
      .latest()
      .reply({ type: "published", track_sid: "T", generation: 1 });
    bridge.sendAudio(frame());
    await settle();
    expect(session.latest().written).toHaveLength(0);
    bridge.release();
    await settle();
    expect(session.latest().sequences()).toEqual([0]);
  });

  it("gives up when the hold expires and rejects a pending drain", async () => {
    const failed = vi.fn();
    let reachable = true;
    const session = new FakeSession();
    const { bridge } = client({
      listener: { failed },
      limits: { holdMs: 60_000 },
      session: () =>
        reachable ? Promise.resolve(session) : new Promise(() => undefined),
    });
    bridge.start();
    await settle();
    session
      .latest()
      .reply({ type: "published", track_sid: "T", generation: 1 });
    bridge.sendAudio(frame());
    await settle();
    const draining = bridge.drain();
    draining.catch(() => undefined);
    reachable = false;
    session.latest().drop();
    await settle(59_000);
    expect(failed).not.toHaveBeenCalled();
    await settle(2_000);
    expect(failed).toHaveBeenCalledWith("HOLD_EXPIRED");
    expect(bridge.gap).toBe(true);
    await expect(draining).rejects.toBeInstanceOf(BridgeFailed);
  });

  it("stops for good on a terminal error", async () => {
    const failed = vi.fn();
    const { bridge, session } = client({ listener: { failed } });
    bridge.start();
    await settle();
    session.latest().reply({ type: "error", code: "ROOM_CLOSED" });
    session.latest().drop();
    await settle(30_000);
    expect(failed).toHaveBeenCalledWith("ROOM_CLOSED");
    expect(session.streams).toHaveLength(1);
    expect(bridge.failure?.code).toBe("ROOM_CLOSED");
  });

  it("moves Live events and reply audio both ways", async () => {
    const live = vi.fn();
    const replyAudio = vi.fn();
    const { bridge, session } = client({
      purpose: "chat_live",
      listener: { live, replyAudio },
    });
    bridge.start();
    await settle();
    const stream = session.latest();
    stream.reply({ type: "published", track_sid: "T", generation: 1 });
    stream.reply({
      type: "live",
      payload: { type: "user_partial", text: "hé" },
    });
    expect(live).toHaveBeenCalledWith({ type: "user_partial", text: "hé" });
    const pcm = new Uint8Array(960);
    stream.handlers.onData?.(pcm);
    expect(replyAudio).toHaveBeenCalledWith(pcm);
    bridge.sendLive({ type: "tool_result", call_id: "c1", text: "{}" });
    await settle();
    expect(JSON.parse(stream.texts.at(-1)!)).toEqual({
      type: "live",
      payload: { type: "tool_result", call_id: "c1", text: "{}" },
    });
  });

  it("asks the Bridge to leave and ends the stream on stop", async () => {
    const { bridge, session } = client();
    bridge.start();
    await settle();
    const stream = session.latest();
    stream.reply({ type: "published", track_sid: "T", generation: 1 });
    bridge.stop();
    await settle();
    expect(JSON.parse(stream.texts.at(-1)!)).toEqual({ type: "stop" });
    expect(stream.ended).toBe(true);
    bridge.sendAudio(frame());
    await settle(10_000);
    expect(stream.written).toHaveLength(0);
    expect(session.streams).toHaveLength(1);
  });
});
