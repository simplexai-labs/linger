// The phone's end of one encrypted session with a paired computer. It owns
// one WebSocket: the handshake runs first, then every message is one Noise
// transport message carrying one frame. docs/mobile.md is the specification.
import {
  CONTROL_STREAM,
  DATA_CHUNK,
  FrameType,
  STREAM_WINDOW,
  decodeFrame,
  encodeFrame,
  jsonBytes,
  parseJson,
  utf8,
  utf8Bytes,
  type Frame,
  type FrameKind,
} from "./frames";
import { now, record, timed } from "../lib/timing";
import { Initiator, type CipherState, type KeyPair } from "./noise";

const EMPTY = new Uint8Array(0);
const HANDSHAKE_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const SILENCE_LIMIT_MS = 70_000;

/** The minimal WebSocket surface both React Native and Node provide. */
export interface SocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export type Hello =
  | { type: "pair"; invite: string; name: string; platform: "ios" | "android" }
  | { type: "resume" };

export interface Welcome {
  readonly type: "welcome" | "pending";
  readonly phone_id: string;
  readonly name?: string;
  /** The confirmation code a pending phone shows; the Human compares it. */
  readonly code?: string;
  readonly lan: readonly string[];
  /** The first Relay node, from a computer that names only one. */
  readonly relay?: string;
  /** Every Relay node the computer links to; unvalidated until parsed. */
  readonly relays?: unknown;
}

/** The computer completed the handshake and refused the phone. */
export class SessionRefused extends Error {
  constructor(readonly code: string) {
    super(`The computer refused this phone: ${code}`);
    this.name = "SessionRefused";
  }
}

export class SessionClosed extends Error {
  constructor(
    readonly reason: string,
    /** The WebSocket close code, when a close frame ended the socket. */
    readonly closeCode?: number,
  ) {
    super(`Session closed: ${reason}`);
    this.name = "SessionClosed";
  }
}

/**
 * The socket reached a computer but the handshake against the pinned key
 * failed: the phone could not decrypt the reply, or the computer closed with
 * 4400 before its welcome. Routes reach a computer by the Host ID derived
 * from that key, so this means the key no longer answers.
 */
export class HandshakeFailed extends SessionClosed {
  constructor(closeCode?: number) {
    super("handshake failed", closeCode);
    this.name = "HandshakeFailed";
  }
}

/** The close code the Gateway sends when the handshake itself failed. */
const CLOSE_HANDSHAKE = 4400;

export interface ResponseHead {
  readonly status: number;
  readonly headers: Readonly<Record<string, readonly string[]>>;
}

export interface StreamHandlers {
  onResponse?(head: ResponseHead): void;
  onData?(chunk: Uint8Array): void;
  onText?(text: string): void;
  onEnd?(): void;
  onReset?(code: string): void;
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return undefined;
}

/** One request or socket inside a session. */
export class SessionStream {
  #credit = STREAM_WINDOW;
  #waiters: (() => void)[] = [];
  #finished = false;

  constructor(
    readonly id: number,
    private readonly session: PhoneSession,
    readonly handlers: StreamHandlers,
  ) {}

  get finished(): boolean {
    return this.#finished;
  }

  /** Sends body bytes, waiting for window credit the computer grants. */
  async write(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.length; ) {
      const chunk = bytes.subarray(offset, offset + DATA_CHUNK);
      await this.#reserve(chunk.length);
      this.session.write(FrameType.data, this.id, chunk);
      offset += chunk.length;
    }
  }

  /** Sends one text message on a socket stream. */
  async sendText(text: string): Promise<void> {
    const bytes = utf8Bytes(text);
    await this.#reserve(bytes.length);
    this.session.write(FrameType.text, this.id, bytes);
  }

  end(): void {
    if (!this.#finished) this.session.write(FrameType.end, this.id, EMPTY);
  }

  reset(): void {
    if (this.#finished) return;
    this.session.write(
      FrameType.reset,
      this.id,
      jsonBytes({ code: "CANCELLED" }),
    );
    this.finish();
  }

  grant(increment: number): void {
    this.#credit += increment;
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const wake of waiters) wake();
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.session.release(this.id);
    this.grant(0);
  }

  async #reserve(size: number): Promise<void> {
    while (this.#credit < size) {
      if (this.#finished || this.session.closed)
        throw new SessionClosed("stream ended");
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    if (this.#finished || this.session.closed)
      throw new SessionClosed("stream ended");
    this.#credit -= size;
  }
}

export class PhoneSession {
  readonly welcome: Welcome;
  #socket: SocketLike;
  #send: CipherState;
  #receive: CipherState;
  #streams = new Map<number, SessionStream>();
  #sockets = new Set<number>();
  #nextStream = 1;
  #closed = false;
  #closeReason = "";
  #closeCode: number | undefined;
  #closeWireReason = "";
  #closeListeners = new Set<(reason: string) => void>();
  #lastHeard = Date.now();
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  #pending: boolean;
  #approvedListeners = new Set<() => void>();

  private constructor(
    socket: SocketLike,
    send: CipherState,
    receive: CipherState,
    welcome: Welcome,
  ) {
    this.#socket = socket;
    this.#send = send;
    this.#receive = receive;
    this.welcome = welcome;
    this.#pending = welcome.type === "pending";
    socket.onmessage = (event) => this.#onMessage(event.data);
    socket.onclose = (event) => {
      this.#closeCode = event.code;
      this.#closeWireReason = event.reason;
      this.#shutdown(
        `socket closed (${event.code}${event.reason ? ` ${event.reason}` : ""})`,
      );
    };
    socket.onerror = () => this.#shutdown("socket error");
    this.#pingTimer = setInterval(() => this.#keepAlive(), PING_INTERVAL_MS);
  }

  /**
   * Opens a socket, runs the handshake, and resolves once the computer
   * accepted the phone. It rejects with SessionRefused when the computer
   * answered with a refusal code.
   */
  static open(input: {
    url: string;
    computerPublicKey: Uint8Array;
    staticKey: KeyPair;
    hello: Hello;
    socketFactory: SocketFactory;
    signal?: AbortSignal;
  }): Promise<PhoneSession> {
    const started = now();
    return new Promise((resolve, reject) => {
      const socket = input.socketFactory(input.url);
      socket.binaryType = "arraybuffer";
      const initiator = new Initiator({
        staticKey: input.staticKey,
        computerPublicKey: input.computerPublicKey,
      });
      let transport: { send: CipherState; receive: CipherState } | undefined;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        try {
          socket.close(1000, "");
        } catch {
          // The socket was never open.
        }
        reject(error);
      };
      const onAbort = () => fail(new SessionClosed("aborted"));
      const timer = setTimeout(
        () => fail(new SessionClosed("handshake timed out")),
        HANDSHAKE_TIMEOUT_MS,
      );
      input.signal?.addEventListener("abort", onAbort);
      socket.onopen = () => {
        record("session.socket_open", now() - started);
        try {
          socket.send(timed("noise.write_first", () => initiator.writeFirst()));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      socket.onerror = () => fail(new SessionClosed("socket error"));
      socket.onclose = (event) =>
        fail(
          event.code === CLOSE_HANDSHAKE
            ? new HandshakeFailed(event.code)
            : new SessionClosed(`socket closed (${event.code})`, event.code),
        );
      socket.onmessage = (event) => {
        if (settled) return;
        const message = toBytes(event.data);
        if (!message) return;
        try {
          if (!transport) {
            // The computer's handshake reply: answer with our key and hello.
            timed("noise.read_second", () => initiator.readSecond(message));
            const third = timed("noise.write_third", () =>
              initiator.writeThird(jsonBytes(input.hello)),
            );
            transport = third.transport;
            socket.send(third.message);
            return;
          }
          // The first transport message is the computer's welcome.
          const welcome = parseJson(
            transport.receive.decrypt(EMPTY, message),
          ) as Welcome | { type: "error"; code: string };
          if (welcome.type !== "welcome" && welcome.type !== "pending") {
            fail(
              new SessionRefused(
                ("code" in welcome ? welcome.code : undefined) ?? "UNKNOWN",
              ),
            );
            return;
          }
          settled = true;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          record("session.open", now() - started);
          resolve(
            new PhoneSession(
              socket,
              transport.send,
              transport.receive,
              welcome,
            ),
          );
        } catch {
          // A wrong key, a tampered message or a computer that changed its
          // key all end here; the phone never accepts a different key.
          fail(new HandshakeFailed());
        }
      };
    });
  }

  /** The phone waits for the Human to approve it on the computer. */
  get pending(): boolean {
    return this.#pending;
  }

  /** Runs once when the computer approves this pending phone. */
  onApproved(listener: () => void): () => void {
    if (!this.#pending) {
      listener();
      return () => undefined;
    }
    this.#approvedListeners.add(listener);
    return () => this.#approvedListeners.delete(listener);
  }

  get closed(): boolean {
    return this.#closed;
  }

  get closeReason(): string {
    return this.#closeReason;
  }

  /**
   * The close frame that ended the socket, if one did. The Gateway puts a
   * refusal code such as PHONE_REMOVED in the reason when it removes a phone.
   */
  get closeFrame(): { code: number; reason: string } | undefined {
    return this.#closeCode === undefined
      ? undefined
      : { code: this.#closeCode, reason: this.#closeWireReason };
  }

  onClose(listener: (reason: string) => void): () => void {
    if (this.#closed) {
      listener(this.#closeReason);
      return () => undefined;
    }
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    try {
      this.#socket.close(1000, "");
    } catch {
      // Already closed.
    }
    this.#shutdown("closed by the phone");
  }

  /** Opens an HTTP request stream; the caller writes the body and ends it. */
  openRequest(
    head: { method: string; path: string; headers?: Record<string, string[]> },
    handlers: StreamHandlers,
  ): SessionStream {
    return this.#open(
      FrameType.request,
      { method: head.method, path: head.path, headers: head.headers ?? {} },
      handlers,
    );
  }

  /** Opens a message stream to a computer socket such as the Voice Bridge. */
  openSocket(path: string, handlers: StreamHandlers): SessionStream {
    return this.#open(FrameType.socket, { path }, handlers);
  }

  #open(
    kind: FrameKind,
    head: unknown,
    handlers: StreamHandlers,
  ): SessionStream {
    if (this.#closed) throw new SessionClosed(this.#closeReason);
    const id = this.#nextStream;
    this.#nextStream += 2;
    const stream = new SessionStream(id, this, handlers);
    this.#streams.set(id, stream);
    if (kind === FrameType.socket) this.#sockets.add(id);
    this.write(kind, id, jsonBytes(head));
    return stream;
  }

  /** @internal Encrypts and sends one frame. Frames leave in call order. */
  write(kind: FrameKind, stream: number, payload: Uint8Array): void {
    if (this.#closed) throw new SessionClosed(this.#closeReason);
    const ciphertext = timed("noise.encrypt_frame", () =>
      this.#send.encrypt(EMPTY, encodeFrame(kind, stream, payload)),
    );
    this.#socket.send(ciphertext);
  }

  /** @internal */
  release(id: number): void {
    this.#streams.delete(id);
    this.#sockets.delete(id);
  }

  /** Socket streams open now, such as a voice call's. */
  get openSockets(): number {
    return this.#sockets.size;
  }

  #keepAlive(): void {
    if (this.#closed) return;
    if (Date.now() - this.#lastHeard > SILENCE_LIMIT_MS) {
      this.close();
      return;
    }
    try {
      this.write(
        FrameType.control,
        CONTROL_STREAM,
        jsonBytes({ type: "ping" }),
      );
    } catch {
      this.#shutdown("ping failed");
    }
  }

  #onMessage(data: unknown): void {
    const message = toBytes(data);
    if (!message || this.#closed) return;
    let frame: Frame;
    try {
      frame = decodeFrame(
        timed("noise.decrypt_frame", () =>
          this.#receive.decrypt(EMPTY, message),
        ),
      );
    } catch {
      this.close();
      return;
    }
    this.#lastHeard = Date.now();
    if (frame.stream === CONTROL_STREAM) {
      if (frame.kind === FrameType.control && this.#pending) {
        const message = parseJson(frame.payload) as { type?: string };
        if (message.type === "approved") {
          this.#pending = false;
          for (const listener of this.#approvedListeners) listener();
          this.#approvedListeners.clear();
        }
      }
      return;
    }
    const stream = this.#streams.get(frame.stream);
    if (!stream) return;
    switch (frame.kind) {
      case FrameType.response:
        stream.handlers.onResponse?.(parseJson(frame.payload) as ResponseHead);
        break;
      case FrameType.data:
        stream.handlers.onData?.(frame.payload);
        break;
      case FrameType.text:
        stream.handlers.onText?.(utf8(frame.payload));
        break;
      case FrameType.window:
        if (frame.payload.length === 4) {
          stream.grant(
            new DataView(
              frame.payload.buffer,
              frame.payload.byteOffset,
              4,
            ).getUint32(0, false),
          );
        }
        break;
      case FrameType.end:
        stream.finish();
        stream.handlers.onEnd?.();
        break;
      case FrameType.reset: {
        let code = "RESET";
        try {
          code = (parseJson(frame.payload) as { code?: string }).code ?? code;
        } catch {
          // An empty reset keeps the generic code.
        }
        stream.finish();
        stream.handlers.onReset?.(code);
        break;
      }
      default:
        break;
    }
  }

  #shutdown(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeReason = reason;
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    const streams = [...this.#streams.values()];
    this.#streams.clear();
    this.#sockets.clear();
    for (const stream of streams) {
      stream.finish();
      stream.handlers.onReset?.("SESSION_CLOSED");
    }
    for (const listener of this.#closeListeners) listener(reason);
    this.#closeListeners.clear();
  }
}
