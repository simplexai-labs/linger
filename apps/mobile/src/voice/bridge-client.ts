// The phone's end of the Voice Bridge (docs/mobile.md, "Voice"): a socket
// stream to /v1/voice-bridge inside the encrypted session. The phone numbers
// every 20 ms frame and keeps it until the Bridge acknowledges that it
// reached LiveKit, so a dropped session resumes on a new stream without
// losing or doubling audio.
import { now, record } from "../lib/timing";
import type { StreamHandlers } from "../session/session";
import { FRAME_MS, BRIDGE_SAMPLE_RATE, encodeFrame } from "./pcm";

export const BRIDGE_PATH = "/v1/voice-bridge";

export type BridgePurpose = "hardware_control" | "chat_dictation" | "chat_live";

/** The part of a session stream the client drives. */
export interface BridgeStream {
  write(bytes: Uint8Array): Promise<void>;
  sendText(text: string): Promise<void>;
  end(): void;
  reset(): void;
}

/** The part of PhoneSession the client drives. */
export interface BridgeSession {
  openSocket(path: string, handlers: StreamHandlers): BridgeStream;
}

export interface BridgeClientLimits {
  /** Unacknowledged audio the phone keeps, in frames: 10 minutes. */
  readonly maxUnackedFrames: number;
  /**
   * Live keeps only the newest 200 ms. The Bridge plays audio at real time,
   * so whatever waits here before it publishes stays as delay for the whole
   * call; a second kept was a second of lag on every reply.
   */
  readonly liveFrames: number;
  /** How long the Bridge holds a dropped VoiceSession before it leaves. */
  readonly holdMs: number;
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** The wait after BACKLOG_FULL, so the Bridge's queue plays down. */
  readonly backlogRetryMs: number;
}

export const defaultBridgeClientLimits: BridgeClientLimits = Object.freeze({
  maxUnackedFrames: (10 * 60_000) / FRAME_MS,
  liveFrames: 200 / FRAME_MS,
  holdMs: 10 * 60_000,
  retryBaseMs: 500,
  retryMaxMs: 5_000,
  backlogRetryMs: 2_000,
});

export type BridgeConnection = "connecting" | "connected" | "reconnecting";

export interface BridgeListener {
  /** The Bridge joined the Room and publishes the microphone track. */
  published?(published: { trackSid: string; generation: number }): void;
  /** One `linger.voice.live` packet from the Live Runtime. */
  live?(payload: Record<string, unknown>): void;
  /** Live reply audio: s16le mono 24 kHz, 20 ms per message. */
  replyAudio?(pcm: Uint8Array): void;
  connection?(state: BridgeConnection): void;
  /** The client gave up; it sends nothing more. */
  failed?(code: string): void;
}

export interface BridgeClientOptions {
  readonly voiceSessionId: string;
  /** The publisher grant; a resume must reuse it, a new one advances the generation. */
  readonly credential: string;
  readonly purpose: BridgePurpose;
  /** Resolves with an open session, waiting while the connection manager reconnects. */
  session(signal: AbortSignal): Promise<BridgeSession>;
  /** Audio stays on the phone until release(), for example until ASR is ready. */
  readonly held?: boolean;
  readonly listener: BridgeListener;
  readonly limits?: Partial<BridgeClientLimits>;
}

/** Codes after which another stream cannot help. */
const TERMINAL = new Set([
  "BAD_START",
  "CREDENTIAL_INVALID",
  "SESSION_MISMATCH",
  "TOO_MANY_SESSIONS",
  "BAD_FRAME",
  "ROOM_CLOSED",
]);

/** The client gave up; `code` is the Bridge's error code or HOLD_EXPIRED. */
export class BridgeFailed extends Error {
  constructor(readonly code: string) {
    super(`Voice Bridge failed: ${code}`);
    this.name = "BridgeFailed";
  }
}

/** The Bridge left before every frame was acknowledged. */
export class BridgeStopped extends Error {
  constructor() {
    super("Voice Bridge stopped");
    this.name = "BridgeStopped";
  }
}

interface Frame {
  readonly seq: number;
  /** When the frame was queued, for the frame-to-ack counter. */
  readonly queuedAt: number;
  readonly bytes: Uint8Array;
}

interface Link {
  stream?: BridgeStream;
  published: boolean;
  /** Every frame up to this one went out on this stream. */
  sentThrough: number;
  error?: string;
  resumed: boolean;
}

interface Waiter {
  resolve(): void;
  reject(error: Error): void;
}

export class BridgeClient {
  readonly #options: BridgeClientOptions;
  readonly #limits: BridgeClientLimits;
  readonly #frames: Frame[] = [];
  #nextSeq = 0;
  #link: Link | undefined;
  #started = false;
  #anyStartSent = false;
  #everPublished = false;
  #held: boolean;
  #pumping = false;
  #stopped = false;
  #failure: BridgeFailed | undefined;
  #gap = false;
  #failures = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #holdTimer: ReturnType<typeof setTimeout> | undefined;
  #waiting: AbortController | undefined;
  #drains: Waiter[] = [];

  constructor(options: BridgeClientOptions) {
    this.#options = options;
    this.#limits = { ...defaultBridgeClientLimits, ...options.limits };
    this.#held = options.held ?? false;
  }

  /**
   * True once audio was lost on the way: the phone dropped frames past its
   * cap, or the Bridge's hold ran out. A recording then needs its local copy.
   */
  get gap(): boolean {
    return this.#gap;
  }

  get failure(): BridgeFailed | undefined {
    return this.#failure;
  }

  /** Frames the Bridge has not acknowledged yet. */
  get unacknowledged(): number {
    return this.#frames.length;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#connect();
  }

  /** Lets held audio go out. */
  release(): void {
    this.#held = false;
    void this.#pump();
  }

  /** Numbers one frame of PCM and sends it once the Bridge published. */
  sendAudio(samples: Int16Array): void {
    if (this.#stopped) return;
    const seq = this.#nextSeq;
    this.#nextSeq += 1;
    this.#frames.push({
      seq,
      queuedAt: now(),
      bytes: encodeFrame(seq, samples),
    });
    const live = this.#options.purpose === "chat_live";
    const limit = live
      ? this.#limits.liveFrames
      : this.#limits.maxUnackedFrames;
    while (this.#frames.length > limit) {
      this.#frames.shift();
      if (!live) this.#gap = true;
    }
    void this.#pump();
  }

  /** Publishes a Live client event on the Room's Live topic. */
  sendLive(payload: Record<string, unknown>): void {
    const link = this.#link;
    if (this.#stopped || !link?.published || !link.stream) return;
    link.stream
      .sendText(JSON.stringify({ type: "live", payload }))
      .catch(() => undefined);
  }

  /** Resolves once the Bridge acknowledged every frame sent so far. */
  drain(): Promise<void> {
    if (this.#failure) return Promise.reject(this.#failure);
    if (this.#frames.length === 0) return Promise.resolve();
    if (this.#stopped) return Promise.reject(new BridgeStopped());
    return new Promise((resolve, reject) =>
      this.#drains.push({ resolve, reject }),
    );
  }

  /**
   * Tells the Bridge to leave the Room at once and ends the stream. Audio it
   * has not played is discarded, so callers drain first.
   */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clearTimers();
    this.#waiting?.abort();
    const link = this.#link;
    this.#link = undefined;
    const stream = link?.stream;
    if (stream)
      void stream
        .sendText(JSON.stringify({ type: "stop" }))
        .catch(() => undefined)
        .finally(() => stream.end());
    this.#settleDrains(new BridgeStopped());
  }

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    this.#options.listener.connection?.(
      this.#everPublished ? "reconnecting" : "connecting",
    );
    const waiting = new AbortController();
    this.#waiting = waiting;
    let session: BridgeSession;
    try {
      session = await this.#options.session(waiting.signal);
    } catch {
      if (!this.#stopped) this.#retry(this.#backoff());
      return;
    }
    if (this.#stopped) return;
    // Every start after the first resumes: the Bridge may still hold the
    // session, and a start without resume_from would begin it again.
    const resumed = this.#anyStartSent;
    const link: Link = { published: false, sentThrough: -1, resumed };
    this.#link = link;
    let stream: BridgeStream;
    try {
      stream = session.openSocket(BRIDGE_PATH, {
        onText: (text) => this.#onText(link, text),
        onData: (chunk) => {
          if (link === this.#link && link.published)
            this.#options.listener.replyAudio?.(chunk);
        },
        onEnd: () => this.#lost(link),
        onReset: () => this.#lost(link),
      });
    } catch {
      this.#lost(link);
      return;
    }
    link.stream = stream;
    const start: Record<string, unknown> = {
      type: "start",
      voice_session_id: this.#options.voiceSessionId,
      credential: this.#options.credential,
      purpose: this.#options.purpose,
      sample_rate: BRIDGE_SAMPLE_RATE,
    };
    if (resumed) start.resume_from = this.#frames[0]?.seq ?? this.#nextSeq;
    this.#anyStartSent = true;
    try {
      await stream.sendText(JSON.stringify(start));
    } catch {
      // The stream already ended; onReset reconnects.
    }
  }

  #onText(link: Link, text: string): void {
    if (link !== this.#link) return;
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case "published": {
        link.published = true;
        this.#everPublished = true;
        this.#failures = 0;
        if (this.#holdTimer !== undefined) clearTimeout(this.#holdTimer);
        this.#holdTimer = undefined;
        this.#options.listener.published?.({
          trackSid:
            typeof message.track_sid === "string" ? message.track_sid : "",
          generation:
            typeof message.generation === "number" ? message.generation : 0,
        });
        this.#options.listener.connection?.("connected");
        void this.#pump();
        return;
      }
      case "ack":
        if (typeof message.through === "number")
          this.#acknowledge(message.through);
        return;
      case "live":
        if (typeof message.payload === "object" && message.payload !== null)
          this.#options.listener.live?.(
            message.payload as Record<string, unknown>,
          );
        return;
      case "error":
        if (typeof message.code === "string") link.error = message.code;
        return;
      default:
        return;
    }
  }

  #acknowledge(through: number): void {
    let drop = 0;
    while (
      drop < this.#frames.length &&
      (this.#frames[drop]?.seq ?? 0) <= through
    )
      drop += 1;
    const last = this.#frames[drop - 1];
    if (last) record("voice.frame_to_ack", now() - last.queuedAt);
    if (drop > 0) this.#frames.splice(0, drop);
    if (this.#frames.length === 0) this.#settleDrains();
  }

  #settleDrains(error?: Error): void {
    const drains = this.#drains;
    this.#drains = [];
    for (const waiter of drains)
      if (error) waiter.reject(error);
      else waiter.resolve();
  }

  /** Sends every frame this stream has not carried yet, in order. */
  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const link = this.#link;
        if (this.#stopped || this.#held || !link?.published || !link.stream)
          return;
        const next = this.#firstAfter(link.sentThrough);
        if (!next) return;
        try {
          await link.stream.write(next.bytes);
        } catch {
          return;
        }
        if (link !== this.#link) continue;
        link.sentThrough = Math.max(link.sentThrough, next.seq);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #firstAfter(seq: number): Frame | undefined {
    let low = 0;
    let high = this.#frames.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.#frames[middle]?.seq ?? 0) <= seq) low = middle + 1;
      else high = middle;
    }
    return this.#frames[low];
  }

  #lost(link: Link): void {
    if (link !== this.#link) return;
    this.#link = undefined;
    if (this.#stopped) return;
    const code = link.error;
    if (code && TERMINAL.has(code)) {
      // A resume the Bridge no longer knows, with a grant that expired
      // meanwhile, means it already left the Room: audio was lost.
      if (code === "CREDENTIAL_INVALID" && link.resumed) this.#gap = true;
      this.#fail(code);
      return;
    }
    if (this.#everPublished && this.#holdTimer === undefined)
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = undefined;
        if (this.#link?.published) return;
        this.#gap = true;
        this.#fail("HOLD_EXPIRED");
      }, this.#limits.holdMs);
    this.#retry(
      code === "BACKLOG_FULL" ? this.#limits.backlogRetryMs : this.#backoff(),
    );
  }

  #backoff(): number {
    const delay = Math.min(
      this.#limits.retryMaxMs,
      this.#limits.retryBaseMs * 2 ** Math.min(this.#failures, 10),
    );
    this.#failures += 1;
    return delay;
  }

  #retry(delay: number): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#connect();
    }, delay);
  }

  #fail(code: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#failure = new BridgeFailed(code);
    this.#clearTimers();
    this.#waiting?.abort();
    const link = this.#link;
    this.#link = undefined;
    link?.stream?.reset();
    this.#settleDrains(this.#failure);
    this.#options.listener.failed?.(code);
  }

  #clearTimers(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    if (this.#holdTimer !== undefined) clearTimeout(this.#holdTimer);
    this.#retryTimer = undefined;
    this.#holdTimer = undefined;
  }
}
