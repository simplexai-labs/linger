import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type {
  BridgeLimits,
  BridgeMedia,
  BridgeMediaHandlers,
} from "./bridge.js";
import { startBridgeServer } from "./bridge-server.js";

const apiKey = "devkey";
const apiSecret = "bridge-test-secret-of-at-least-32-bytes";
const token = "bridge-token";
const livekitUrl = "ws://127.0.0.1:17880";

function grant(
  voiceSessionId: string,
  generation = 1,
  options: { secret?: string; expiresInSeconds?: number } = {},
) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const head = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({
    iss: apiKey,
    sub: `publisher-${voiceSessionId}`,
    exp: Math.floor(Date.now() / 1_000) + (options.expiresInSeconds ?? 600),
    video: { room: `voice-${voiceSessionId}`, roomJoin: true },
    attributes: { "linger.voice_generation": String(generation) },
  });
  const signature = createHmac("sha256", options.secret ?? apiSecret)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${signature}`;
}

/** 100 ms of PCM whose every sample is the sequence number, behind it. */
function frame(seq: number, samples = 2_400) {
  const bytes = Buffer.alloc(4 + samples * 2);
  bytes.writeUInt32BE(seq, 0);
  for (let index = 0; index < samples; index += 1)
    bytes.writeInt16LE(seq, 4 + index * 2);
  return bytes;
}

class FakeMedia implements BridgeMedia {
  readonly trackSid: string;
  readonly captured: Int16Array[] = [];
  readonly published: unknown[] = [];
  closed = false;
  queuedMs = 0;
  #gate?: Promise<void>;
  #open?: () => void;
  constructor(
    readonly handlers: BridgeMediaHandlers,
    readonly input: { url: string; credential: string; purpose: string },
    index: number,
  ) {
    this.trackSid = `TR_${index}`;
  }
  hold() {
    this.#gate = new Promise((resolve) => {
      this.#open = resolve;
    });
  }
  release() {
    this.#open?.();
    this.#gate = undefined;
  }
  /** The sequence numbers whose audio reached the track, in order. */
  sequences() {
    const seqs: number[] = [];
    for (const samples of this.captured)
      if (seqs.at(-1) !== samples[0]) seqs.push(samples[0]!);
    return seqs;
  }
  samples() {
    return this.captured.reduce((total, samples) => total + samples.length, 0);
  }
  async capture(samples: Int16Array) {
    await this.#gate;
    this.captured.push(samples);
  }
  async publishLive(payload: unknown) {
    this.published.push(payload);
  }
  async close() {
    this.closed = true;
  }
}

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function bridge(limits: Partial<BridgeLimits> = {}) {
  const media: FakeMedia[] = [];
  const connect = vi.fn(
    async (input: {
      url: string;
      credential: string;
      purpose: string;
      handlers: BridgeMediaHandlers;
    }) => {
      const created = new FakeMedia(input.handlers, input, media.length);
      media.push(created);
      return created;
    },
  );
  const logged: unknown[] = [];
  const server = await startBridgeServer({
    port: 0,
    token,
    livekitUrl,
    livekitApiKey: apiKey,
    livekitApiSecret: apiSecret,
    connect,
    logger: {
      log: (...entry: unknown[]) => logged.push(entry),
      child() {
        return this;
      },
    },
    limits: { ackIntervalMs: 20, ...limits },
  });
  servers.push(server);
  const open = async (
    phoneId = "phone_1",
    authorization = `Bearer ${token}`,
  ) => {
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.port}/v1/voice-bridge`,
      { headers: { authorization, "x-linger-phone-id": phoneId } },
    );
    const texts: Array<Record<string, unknown>> = [];
    const binaries: Buffer[] = [];
    let closed: { code: number } | undefined;
    socket.on("message", (data, isBinary) => {
      if (isBinary) binaries.push(data as Buffer);
      else texts.push(JSON.parse((data as Buffer).toString("utf8")));
    });
    socket.on("close", (code) => {
      closed = { code };
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return {
      socket,
      texts,
      binaries,
      closed: () => closed,
      start: (fields: Record<string, unknown>) =>
        socket.send(
          JSON.stringify({ type: "start", sample_rate: 24_000, ...fields }),
        ),
      text: async (type: string) => {
        await vi.waitFor(() =>
          expect(texts.some((message) => message.type === type)).toBe(true),
        );
        return texts.find((message) => message.type === type)!;
      },
      lastAck: () =>
        texts.filter((message) => message.type === "ack").at(-1)?.through,
    };
  };
  return { server, media, connect, open, logged };
}

const id = "voice_session_1";

describe("Voice Bridge", () => {
  it("refuses a socket without the node-services token", async () => {
    const test = await bridge();
    await expect(test.open("phone_1", "Bearer wrong")).rejects.toThrow(/401/);
  });

  it("joins the configured LiveKit with the phone's grant and reports the generation", async () => {
    const test = await bridge();
    const phone = await test.open();
    const credential = grant(id, 3);
    phone.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
      endpoint: "wss://attacker.example",
    });
    expect(await phone.text("published")).toEqual({
      type: "published",
      track_sid: "TR_0",
      generation: 3,
    });
    expect(test.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        url: livekitUrl,
        credential,
        voiceSessionId: id,
        purpose: "chat_dictation",
      }),
    );
  });

  it("refuses a grant this computer did not sign or for another session", async () => {
    const test = await bridge();
    const forged = await test.open();
    forged.start({
      voice_session_id: id,
      credential: grant(id, 1, {
        secret: "another-secret-of-at-least-32-bytes",
      }),
      purpose: "chat_dictation",
    });
    expect(await forged.text("error")).toEqual({
      type: "error",
      code: "CREDENTIAL_INVALID",
    });
    const other = await test.open();
    other.start({
      voice_session_id: id,
      credential: grant("voice_session_2"),
      purpose: "chat_dictation",
    });
    expect((await other.text("error")).code).toBe("CREDENTIAL_INVALID");
    expect(test.connect).not.toHaveBeenCalled();
  });

  it("plays each sequence number once and acknowledges what it played", async () => {
    const test = await bridge();
    const phone = await test.open();
    phone.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_dictation",
    });
    await phone.text("published");
    for (const seq of [0, 1, 1, 0, 2]) phone.socket.send(frame(seq));
    await vi.waitFor(() => expect(phone.lastAck()).toBe(2));
    const media = test.media[0]!;
    expect(media.sequences()).toEqual([0, 1, 2]);
    expect(media.samples()).toBe(3 * 2_400);
    // The AudioSource takes 20 ms frames.
    expect(media.captured.every((samples) => samples.length === 480)).toBe(
      true,
    );
  });

  it("acknowledges the last audio only once LiveKit has played it out", async () => {
    const test = await bridge();
    const phone = await test.open();
    phone.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_dictation",
    });
    await phone.text("published");
    const media = test.media[0]!;
    media.queuedMs = 30;
    phone.socket.send(frame(0));
    phone.socket.send(frame(1));
    await vi.waitFor(() => expect(media.sequences()).toEqual([0, 1]));
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(phone.lastAck() ?? -1).toBeLessThan(1);
    media.queuedMs = 0;
    await vi.waitFor(() => expect(phone.lastAck()).toBe(1), { timeout: 2_000 });
  });

  it("holds the Room after a drop and resumes without replaying played audio", async () => {
    const test = await bridge();
    const credential = grant(id);
    const first = await test.open();
    first.start({
      voice_session_id: id,
      credential,
      purpose: "hardware_control",
    });
    await first.text("published");
    first.socket.send(frame(0));
    first.socket.send(frame(1));
    await vi.waitFor(() => expect(first.lastAck()).toBe(1));
    first.socket.terminate();
    await vi.waitFor(() => expect(test.server.bridge.sessionCount).toBe(1));

    const second = await test.open();
    second.start({
      voice_session_id: id,
      credential,
      purpose: "hardware_control",
      resume_from: 1,
    });
    expect((await second.text("published")).track_sid).toBe("TR_0");
    await vi.waitFor(() => expect(second.lastAck()).toBe(1));
    second.socket.send(frame(1));
    second.socket.send(frame(2));
    await vi.waitFor(() => expect(second.lastAck()).toBe(2));
    expect(test.media[0]!.sequences()).toEqual([0, 1, 2]);
    expect(test.connect).toHaveBeenCalledTimes(1);
    expect(test.media[0]!.closed).toBe(false);
  });

  it("replaces an older socket of the same session and ignores its frames", async () => {
    const test = await bridge();
    const credential = grant(id);
    const older = await test.open();
    older.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
    });
    await older.text("published");
    const newer = await test.open();
    newer.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
      resume_from: 0,
    });
    await newer.text("published");
    await vi.waitFor(() => expect(older.closed()?.code).toBe(4001));
    newer.socket.send(frame(0));
    await vi.waitFor(() => expect(newer.lastAck()).toBe(0));
    expect(test.media[0]!.sequences()).toEqual([0]);
  });

  it("lets only the same phone resume a session", async () => {
    const test = await bridge();
    const credential = grant(id);
    const owner = await test.open("phone_1");
    owner.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
    });
    await owner.text("published");
    const stranger = await test.open("phone_2");
    stranger.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
      resume_from: 0,
    });
    expect((await stranger.text("error")).code).toBe("SESSION_MISMATCH");
    expect(owner.closed()).toBeUndefined();
  });

  it("drops Live audio more than a second behind the newest", async () => {
    const test = await bridge();
    const phone = await test.open();
    phone.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_live",
    });
    await phone.text("published");
    const media = test.media[0]!;
    media.hold();
    for (let seq = 0; seq < 30; seq += 1) phone.socket.send(frame(seq));
    await new Promise((resolve) => setTimeout(resolve, 150));
    media.release();
    await vi.waitFor(() => expect(phone.lastAck()).toBe(29));
    // At most the frame already playing comes before the newest second.
    const played = media.sequences();
    expect(played.slice(-10)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    expect(played.length).toBeLessThanOrEqual(11);
  });

  it("refuses dictation audio past its backlog and keeps the session", async () => {
    const test = await bridge({ backlogMs: 300 });
    const phone = await test.open();
    const credential = grant(id);
    phone.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
    });
    await phone.text("published");
    const media = test.media[0]!;
    media.hold();
    for (let seq = 0; seq < 6; seq += 1) phone.socket.send(frame(seq));
    expect((await phone.text("error")).code).toBe("BACKLOG_FULL");
    await vi.waitFor(() => expect(phone.closed()?.code).toBe(4000));
    expect(test.server.bridge.sessionCount).toBe(1);
    media.release();
    // The phone resends everything unacknowledged; the Bridge skips what it
    // already holds.
    const resumed = await test.open();
    resumed.start({
      voice_session_id: id,
      credential,
      purpose: "chat_dictation",
      resume_from: 0,
    });
    await resumed.text("published");
    for (let seq = 0; seq < 6; seq += 1) resumed.socket.send(frame(seq));
    await vi.waitFor(() => expect(resumed.lastAck()).toBe(5));
    expect(media.sequences()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("moves Live events and reply audio both ways", async () => {
    const test = await bridge();
    const phone = await test.open();
    phone.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_live",
    });
    await phone.text("published");
    const media = test.media[0]!;
    media.handlers.liveEvent({ type: "user_partial", text: "hé" });
    expect(await phone.text("live")).toEqual({
      type: "live",
      payload: { type: "user_partial", text: "hé" },
    });
    media.handlers.replyAudio(new Int16Array([1, -2, 3]));
    await vi.waitFor(() => expect(phone.binaries).toHaveLength(1));
    expect([
      ...new Int16Array(new Uint8Array(phone.binaries[0]!).buffer),
    ]).toEqual([1, -2, 3]);
    phone.socket.send(
      JSON.stringify({
        type: "live",
        payload: { type: "tool_result", call_id: "c1", output: "{}" },
      }),
    );
    await vi.waitFor(() =>
      expect(media.published).toEqual([
        { type: "tool_result", call_id: "c1", output: "{}" },
      ]),
    );
  });

  it("leaves the Room on stop", async () => {
    const test = await bridge();
    const phone = await test.open();
    phone.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_dictation",
    });
    await phone.text("published");
    phone.socket.send(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() => expect(phone.closed()?.code).toBe(1000));
    expect(test.media[0]!.closed).toBe(true);
    expect(test.server.bridge.sessionCount).toBe(0);
  });

  it("leaves the Room when a dropped phone does not return in time", async () => {
    const test = await bridge({ holdMs: 50 });
    const phone = await test.open();
    phone.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_dictation",
    });
    await phone.text("published");
    phone.socket.terminate();
    await vi.waitFor(() => expect(test.media[0]!.closed).toBe(true));
    expect(test.server.bridge.sessionCount).toBe(0);
  });

  it("serves a bounded number of sessions", async () => {
    const test = await bridge({ maxSessions: 1 });
    const first = await test.open();
    first.start({
      voice_session_id: id,
      credential: grant(id),
      purpose: "chat_dictation",
    });
    await first.text("published");
    const second = await test.open();
    second.start({
      voice_session_id: "voice_session_2",
      credential: grant("voice_session_2"),
      purpose: "chat_dictation",
    });
    expect((await second.text("error")).code).toBe("TOO_MANY_SESSIONS");
  });
});
