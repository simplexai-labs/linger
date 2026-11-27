import { createHmac, timingSafeEqual } from "node:crypto";
import { isRecord } from "@linger/service-kit";
import type { JsonLogger } from "@linger/service-kit/node";
import WebSocket, { type RawData } from "ws";

/**
 * The Voice Bridge joins a VoiceSession's LiveKit Room in the phone's place:
 * it publishes the phone's microphone frames as `publisher-<id>` and, for
 * Live, returns the reply audio and Live data packets. One bridge session
 * serves one VoiceSession and outlives a dropped phone socket for the hold
 * window, so a reconnecting phone resends only what the Bridge never got.
 */

export const bridgeSampleRate = 24_000;
export const liveTopic = "linger.voice.live";
/** Bytes before the PCM of one phone audio message: a u32 sequence number. */
const sequenceBytes = 4;
/** The AudioSource takes 20 ms frames; a phone message carries 20 to 100 ms. */
const captureSamples = bridgeSampleRate / 50;
const samplesPerMs = bridgeSampleRate / 1_000;
/** A phone message larger than this is more than 100 ms of 24 kHz mono PCM. */
const maxAudioMessageBytes = sequenceBytes + 2 * 2 * 2_400;
const maxTextMessageBytes = 64 * 1024;
/** Reply audio a slow phone socket has not taken is dropped beyond this. */
const maxDownlinkBufferedBytes = 512 * 1024;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const maxSequence = 0xffff_ffff;

export type BridgePurpose = "hardware_control" | "chat_dictation" | "chat_live";
const purposes = new Set<BridgePurpose>([
  "hardware_control",
  "chat_dictation",
  "chat_live",
]);

export interface BridgeLimits {
  /** How long a session whose phone dropped keeps its Room. */
  readonly holdMs: number;
  readonly maxSessions: number;
  /** Queued audio dictation and recording replay at real time. */
  readonly backlogMs: number;
  /** Live plays nothing older than this behind the newest audio received. */
  readonly liveStaleMs: number;
  readonly ackIntervalMs: number;
  readonly startTimeoutMs: number;
  /** Audio kept in the AudioSource ahead of real time. */
  readonly lookaheadMs: number;
}

export const defaultBridgeLimits: BridgeLimits = Object.freeze({
  holdMs: 10 * 60_000,
  maxSessions: 8,
  backlogMs: 10 * 60_000,
  liveStaleMs: 1_000,
  ackIntervalMs: 500,
  startTimeoutMs: 10_000,
  // Enough to bridge the phone's 20 ms frames arriving a little unevenly on
  // a LAN without holding the voice back.
  lookaheadMs: 40,
});

/** What the Room delivers back to the phone. */
export interface BridgeMediaHandlers {
  /** Live reply audio: PCM s16le mono at 24 kHz. */
  replyAudio(pcm: Int16Array): void;
  /** One `linger.voice.live` packet from the Live Runtime, parsed. */
  liveEvent(payload: unknown): void;
  /** The Room ended without the Bridge leaving it. */
  disconnected(): void;
}

/** One Room connection with the published microphone track. */
export interface BridgeMedia {
  readonly trackSid: string;
  /** Milliseconds queued in the AudioSource that have not played yet. */
  readonly queuedMs: number;
  capture(samples: Int16Array): Promise<void>;
  publishLive(payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export type ConnectBridgeMedia = (input: {
  readonly url: string;
  readonly credential: string;
  readonly voiceSessionId: string;
  readonly purpose: BridgePurpose;
  readonly handlers: BridgeMediaHandlers;
}) => Promise<BridgeMedia>;

export interface BridgeOptions {
  readonly livekitUrl: string;
  readonly livekitApiKey: string;
  readonly livekitApiSecret: string;
  readonly connect: ConnectBridgeMedia;
  readonly logger: JsonLogger;
  readonly limits?: Partial<BridgeLimits>;
  readonly now?: () => number;
}

interface StartMessage {
  readonly voiceSessionId: string;
  readonly credential: string;
  readonly purpose: BridgePurpose;
  readonly resumeFrom?: number;
}

interface Grant {
  readonly generation: number;
  readonly expiresAtMs: number;
}

type ErrorCode =
  | "BAD_START"
  | "CREDENTIAL_INVALID"
  | "SESSION_MISMATCH"
  | "TOO_MANY_SESSIONS"
  | "CONNECT_FAILED"
  | "BACKLOG_FULL"
  | "BAD_FRAME"
  | "ROOM_CLOSED"
  | "SHUTTING_DOWN";

const errorClose = 4000;
const replacedClose = 4001;

/** Owns every bridge session of this process. */
export class VoiceBridge {
  readonly #options: BridgeOptions;
  readonly #limits: BridgeLimits;
  readonly #sessions = new Map<string, BridgeSession>();
  #closing = false;

  constructor(options: BridgeOptions) {
    this.#options = options;
    this.#limits = { ...defaultBridgeLimits, ...options.limits };
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  /** Serves one phone socket: its first text message must be `start`. */
  accept(socket: WebSocket, phoneId: string) {
    const phone = new PhoneSocket(socket);
    const timer = setTimeout(
      () => socket.close(errorClose, "start timed out"),
      this.#limits.startTimeoutMs,
    );
    socket.once("close", () => clearTimeout(timer));
    phone.route((data, isBinary) => {
      phone.route(undefined);
      clearTimeout(timer);
      const start = isBinary ? undefined : parseStart(data);
      if (!start) {
        sendError(socket, "BAD_START");
        socket.close(errorClose, "bad start");
        return;
      }
      void this.#start(phone, phoneId, start).catch((error: unknown) => {
        this.#options.logger.log("error", "voice_bridge.start_failed", {
          voice_session_id: start.voiceSessionId,
          error,
        });
        sendError(socket, "CONNECT_FAILED");
        socket.close(errorClose, "start failed");
      });
    });
  }

  async close() {
    this.#closing = true;
    await Promise.all(
      [...this.#sessions.values()].map((session) =>
        session.close("SHUTTING_DOWN"),
      ),
    );
  }

  async #start(phone: PhoneSocket, phoneId: string, start: StartMessage) {
    const socket = phone.socket;
    if (this.#closing) {
      sendError(socket, "SHUTTING_DOWN");
      socket.close(1001, "shutting down");
      return;
    }
    const grant = verifyGrant(
      start.credential,
      start.voiceSessionId,
      this.#options.livekitApiKey,
      this.#options.livekitApiSecret,
    );
    let session = this.#sessions.get(start.voiceSessionId);
    const now = (this.#options.now ?? Date.now)();
    // A held session accepts the very grant it joined with even after it
    // expired: the Room connection outlives the grant, and a fresh grant
    // would advance the publisher generation.
    const sameGrant = session?.credential === start.credential;
    if (!grant || (!sameGrant && grant.expiresAtMs <= now)) {
      sendError(socket, "CREDENTIAL_INVALID");
      socket.close(errorClose, "credential invalid");
      return;
    }
    if (session && start.resumeFrom === undefined) {
      // A start without resume_from begins again: the phone holds nothing
      // the old session still has to play.
      await session.close();
      session = undefined;
    }
    if (session) {
      if (session.phoneId !== phoneId || session.purpose !== start.purpose) {
        sendError(socket, "SESSION_MISMATCH");
        socket.close(errorClose, "session mismatch");
        return;
      }
      await session.attach(phone, start.credential, grant);
      return;
    }
    if (this.#sessions.size >= this.#limits.maxSessions) {
      sendError(socket, "TOO_MANY_SESSIONS");
      socket.close(errorClose, "too many sessions");
      return;
    }
    const created = new BridgeSession({
      id: start.voiceSessionId,
      phoneId,
      purpose: start.purpose,
      bridge: this.#options,
      limits: this.#limits,
      removed: () => {
        if (this.#sessions.get(created.id) === created)
          this.#sessions.delete(created.id);
      },
    });
    this.#sessions.set(created.id, created);
    await created.attach(phone, start.credential, grant);
  }
}

type MessageHandler = (data: RawData, isBinary: boolean) => void;

/**
 * Holds a phone socket's messages until a session takes them, so audio sent
 * right after `start` waits for the Room instead of being lost. Past a small
 * buffer it stops reading the socket, which pushes back on the phone.
 */
class PhoneSocket {
  readonly socket: WebSocket;
  #handler?: MessageHandler;
  readonly #buffered: Array<[RawData, boolean]> = [];

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (this.#handler) {
        this.#handler(data, isBinary);
        return;
      }
      this.#buffered.push([data, isBinary]);
      if (this.#buffered.length >= 64) socket.pause();
    });
  }

  /** Sends later messages, and any held ones, to handler. */
  route(handler: MessageHandler | undefined) {
    this.#handler = handler;
    if (!handler) return;
    while (this.#handler === handler && this.#buffered.length > 0) {
      const [data, isBinary] = this.#buffered.shift()!;
      handler(data, isBinary);
    }
    if (this.socket.readyState === WebSocket.OPEN) this.socket.resume();
  }
}

interface Queued {
  readonly seq: number;
  readonly pcm: Int16Array;
}

class BridgeSession {
  readonly id: string;
  readonly phoneId: string;
  readonly purpose: BridgePurpose;
  credential?: string;
  readonly #bridge: BridgeOptions;
  readonly #limits: BridgeLimits;
  readonly #removed: () => void;
  #generation = 0;
  #media?: Promise<BridgeMedia>;
  #phone?: PhoneSocket;
  readonly #queue: Queued[] = [];
  #queuedSamples = 0;
  /** The highest sequence number received; lower ones are duplicates. */
  #received = -1;
  /** The highest sequence number handed to LiveKit or discarded. */
  #played = -1;
  /** What #played was before the last chunk, which may still be queued. */
  #playedBefore = -1;
  /** The Room the play loop captures into, read for its queued audio. */
  #playing?: BridgeMedia;
  #acked = -1;
  #wake?: () => void;
  #hold?: NodeJS.Timeout;
  #ackTimer?: NodeJS.Timeout;
  #closed = false;
  #closing?: Promise<void>;
  /** Serializes attaches, so a replacement grant reconnects only once. */
  #attaching: Promise<void> = Promise.resolve();

  constructor(input: {
    id: string;
    phoneId: string;
    purpose: BridgePurpose;
    bridge: BridgeOptions;
    limits: BridgeLimits;
    removed: () => void;
  }) {
    this.id = input.id;
    this.phoneId = input.phoneId;
    this.purpose = input.purpose;
    this.#bridge = input.bridge;
    this.#limits = input.limits;
    this.#removed = input.removed;
    void this.#play();
  }

  attach(phone: PhoneSocket, credential: string, grant: Grant) {
    const attaching = this.#attaching.then(() =>
      this.#attach(phone, credential, grant),
    );
    this.#attaching = attaching.catch(() => undefined);
    return attaching;
  }

  async #attach(phone: PhoneSocket, credential: string, grant: Grant) {
    const socket = phone.socket;
    if (this.#closed) {
      sendError(socket, "ROOM_CLOSED");
      socket.close(errorClose, "session closed");
      return;
    }
    if (!this.#media || grant.generation !== this.#generation) {
      // A new grant names a new publisher generation, which TeamHub's
      // readiness tracks; only a Room joined with it can satisfy it.
      // The old Room leaves first: the same identity joining again would
      // otherwise remove the new participant's predecessor mid-handover.
      const previous = this.#media;
      this.#media = (async () => {
        const old = await previous?.catch(() => undefined);
        await old?.close().catch(() => undefined);
        return this.#connect(credential);
      })();
      this.#generation = grant.generation;
      this.credential = credential;
    }
    let media: BridgeMedia;
    try {
      media = await this.#media;
    } catch (error) {
      await this.close();
      throw error;
    }
    if (this.#closed || socket.readyState !== WebSocket.OPEN) {
      if (socket.readyState === WebSocket.OPEN) {
        sendError(socket, "ROOM_CLOSED");
        socket.close(errorClose, "session closed");
      }
      if (!this.#phone && !this.#closed) this.#startHold();
      return;
    }
    const previous = this.#phone;
    if (previous) {
      this.#detach(previous);
      previous.socket.close(replacedClose, "replaced");
    }
    clearTimeout(this.#hold);
    this.#hold = undefined;
    this.#phone = phone;
    socket.once("close", () => {
      if (this.#phone !== phone) return;
      this.#detach(phone);
      if (!this.#closed) this.#startHold();
    });
    send(socket, {
      type: "published",
      track_sid: media.trackSid,
      generation: this.#generation,
    });
    this.#acked = -1;
    this.#ack();
    this.#ackTimer = setInterval(() => this.#ack(), this.#limits.ackIntervalMs);
    phone.route((data, isBinary) => {
      if (isBinary) this.#onAudio(phone, data);
      else this.#onText(data);
    });
    this.#bridge.logger.log("info", "voice_bridge.attached", {
      voice_session_id: this.id,
      purpose: this.purpose,
      generation: this.#generation,
      resumed_through: this.#received,
    });
  }

  #connect(credential: string) {
    return this.#bridge.connect({
      url: this.#bridge.livekitUrl,
      credential,
      voiceSessionId: this.id,
      purpose: this.purpose,
      handlers: {
        replyAudio: (pcm) => {
          const socket = this.#phone?.socket;
          if (
            socket?.readyState !== WebSocket.OPEN ||
            socket.bufferedAmount > maxDownlinkBufferedBytes
          )
            return;
          // A copy: the socket may still hold it after the frame is reused.
          socket.send(
            Buffer.from(
              new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength),
            ),
            { binary: true },
          );
        },
        liveEvent: (payload) => {
          const socket = this.#phone?.socket;
          if (socket?.readyState === WebSocket.OPEN)
            send(socket, { type: "live", payload });
        },
        disconnected: () => {
          this.#bridge.logger.log("info", "voice_bridge.room_closed", {
            voice_session_id: this.id,
          });
          void this.close("ROOM_CLOSED");
        },
      },
    });
  }

  #detach(phone: PhoneSocket) {
    phone.route(undefined);
    if (this.#phone !== phone) return;
    this.#phone = undefined;
    clearInterval(this.#ackTimer);
    this.#ackTimer = undefined;
  }

  #startHold() {
    clearTimeout(this.#hold);
    this.#hold = setTimeout(() => {
      this.#bridge.logger.log("info", "voice_bridge.hold_expired", {
        voice_session_id: this.id,
      });
      void this.close();
    }, this.#limits.holdMs);
  }

  #onText(data: RawData) {
    const text = rawText(data);
    if (text === undefined || text.length > maxTextMessageBytes) return;
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (!isRecord(message)) return;
    if (message.type === "stop") {
      void this.close();
      return;
    }
    if (
      message.type === "live" &&
      this.purpose === "chat_live" &&
      isRecord(message.payload)
    ) {
      const payload = message.payload;
      void this.#media
        ?.then((media) => media.publishLive(payload))
        .catch((error: unknown) => {
          this.#bridge.logger.log("warn", "voice_bridge.live_publish_failed", {
            voice_session_id: this.id,
            error,
          });
        });
    }
  }

  #onAudio(phone: PhoneSocket, data: RawData) {
    const socket = phone.socket;
    const bytes = rawBytes(data);
    if (
      bytes.length <= sequenceBytes ||
      bytes.length > maxAudioMessageBytes ||
      (bytes.length - sequenceBytes) % 2 !== 0
    ) {
      sendError(socket, "BAD_FRAME");
      socket.close(errorClose, "bad frame");
      return;
    }
    const seq = bytes.readUInt32BE(0);
    if (seq <= this.#received) return;
    const pcm = new Int16Array((bytes.length - sequenceBytes) / 2);
    for (let index = 0; index < pcm.length; index += 1)
      pcm[index] = bytes.readInt16LE(sequenceBytes + index * 2);
    if (this.purpose === "chat_live") {
      // A stale turn is worse than a lost one: keep only the newest audio.
      this.#push(seq, pcm);
      const keep = this.#limits.liveStaleMs * samplesPerMs;
      while (this.#queuedSamples > keep && this.#queue.length > 1) {
        const dropped = this.#queue.shift()!;
        this.#queuedSamples -= dropped.pcm.length;
        this.#played = Math.max(this.#played, dropped.seq);
      }
    } else {
      if (
        this.#queuedSamples + pcm.length >
        this.#limits.backlogMs * samplesPerMs
      ) {
        // Later frames would leave a hole; the phone resumes once the
        // queue has played down, resending from the last ack.
        sendError(socket, "BACKLOG_FULL");
        this.#detach(phone);
        socket.close(errorClose, "backlog full");
        if (!this.#closed) this.#startHold();
        return;
      }
      this.#push(seq, pcm);
    }
    this.#wake?.();
  }

  #push(seq: number, pcm: Int16Array) {
    this.#received = seq;
    this.#queue.push({ seq, pcm });
    this.#queuedSamples += pcm.length;
  }

  /**
   * Acknowledges audio that left the AudioSource. The last chunk counts only
   * once LiveKit's own queue is empty, so a phone that ends its turn on this
   * ack loses no tail.
   */
  #ack() {
    const socket = this.#phone?.socket;
    const through =
      (this.#playing?.queuedMs ?? 0) > 0 ? this.#playedBefore : this.#played;
    if (through <= this.#acked || socket?.readyState !== WebSocket.OPEN) return;
    this.#acked = through;
    send(socket, { type: "ack", through });
  }

  /** Waits for LiveKit's queue to play out, or for more phone audio. */
  async #drain() {
    const left = this.#playing?.queuedMs ?? 0;
    if (left <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, left + 10);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.#wake = undefined;
  }

  /** Plays queued phone audio at real time, 20 ms per AudioSource frame. */
  async #play() {
    while (!this.#closed) {
      const next = this.#queue.shift();
      if (!next) {
        await this.#drain();
        if (this.#queue.length > 0 || this.#closed) continue;
        // Everything received has played: the phone may end its turn now.
        this.#ack();
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
        this.#wake = undefined;
        continue;
      }
      this.#queuedSamples -= next.pcm.length;
      for (
        let offset = 0;
        offset < next.pcm.length && !this.#closed;
        offset += captureSamples
      ) {
        let media: BridgeMedia;
        try {
          media = await this.#media!;
        } catch {
          return;
        }
        this.#playing = media;
        const ahead = media.queuedMs - this.#limits.lookaheadMs;
        if (ahead > 0)
          await new Promise((resolve) => setTimeout(resolve, ahead));
        if (this.#closed) return;
        try {
          await media.capture(next.pcm.slice(offset, offset + captureSamples));
        } catch (error) {
          // A replaced Room may refuse the last frame; the next one goes to
          // the new Room.
          if (this.#closed || (await this.#media) !== media) continue;
          this.#bridge.logger.log("error", "voice_bridge.capture_failed", {
            voice_session_id: this.id,
            error,
          });
          void this.close("ROOM_CLOSED");
          return;
        }
      }
      this.#playedBefore = this.#played;
      this.#played = Math.max(this.#played, next.seq);
    }
  }

  close(code?: ErrorCode) {
    this.#closing ??= (async () => {
      this.#closed = true;
      this.#removed();
      this.#wake?.();
      clearTimeout(this.#hold);
      const phone = this.#phone;
      if (phone) {
        this.#detach(phone);
        if (code) sendError(phone.socket, code);
        phone.socket.close(code === "SHUTTING_DOWN" ? 1001 : 1000, "closed");
      }
      this.#queue.length = 0;
      this.#queuedSamples = 0;
      const media = await this.#media?.catch(() => undefined);
      await media?.close().catch(() => undefined);
      this.#bridge.logger.log("info", "voice_bridge.closed", {
        voice_session_id: this.id,
        ...(code ? { code } : {}),
      });
    })();
    return this.#closing;
  }
}

function parseStart(data: RawData): StartMessage | undefined {
  const text = rawText(data);
  if (text === undefined || text.length > maxTextMessageBytes) return;
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }
  if (!isRecord(message) || message.type !== "start") return;
  const {
    voice_session_id: voiceSessionId,
    credential,
    purpose,
    sample_rate: sampleRate,
    resume_from: resumeFrom,
  } = message;
  if (
    typeof voiceSessionId !== "string" ||
    !sessionIdPattern.test(voiceSessionId) ||
    typeof credential !== "string" ||
    credential.length === 0 ||
    typeof purpose !== "string" ||
    !purposes.has(purpose as BridgePurpose) ||
    sampleRate !== bridgeSampleRate ||
    (resumeFrom !== undefined &&
      (!Number.isSafeInteger(resumeFrom) ||
        (resumeFrom as number) < 0 ||
        (resumeFrom as number) > maxSequence))
  )
    return;
  return {
    voiceSessionId,
    credential,
    purpose: purpose as BridgePurpose,
    ...(resumeFrom === undefined ? {} : { resumeFrom: resumeFrom as number }),
  };
}

/**
 * Checks the LiveKit grant TeamHub issued for this VoiceSession: signed with
 * this computer's LiveKit secret, for its publisher identity in its Room. A
 * socket can then attach only to the session its grant names.
 */
export function verifyGrant(
  token: string,
  voiceSessionId: string,
  apiKey: string,
  apiSecret: string,
): Grant | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return;
  const [header, payload, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", apiSecret)
    .update(`${header}.${payload}`)
    .digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return;
  let claims: unknown;
  let head: unknown;
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return;
  }
  if (!isRecord(head) || head.alg !== "HS256" || !isRecord(claims)) return;
  const video = claims.video;
  const attributes = claims.attributes;
  const generation = Number(
    isRecord(attributes) ? attributes["linger.voice_generation"] : undefined,
  );
  if (
    claims.iss !== apiKey ||
    claims.sub !== `publisher-${voiceSessionId}` ||
    !isRecord(video) ||
    video.room !== `voice-${voiceSessionId}` ||
    video.roomJoin !== true ||
    typeof claims.exp !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0
  )
    return;
  return { generation, expiresAtMs: claims.exp * 1_000 };
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return data;
}

function rawText(data: RawData): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes(data));
  } catch {
    return;
  }
}

function send(socket: WebSocket, message: Record<string, unknown>) {
  if (socket.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: ErrorCode) {
  send(socket, { type: "error", code });
}
