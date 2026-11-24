import { spawn as spawnProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

import type { Logger } from "./log.js";

export interface IMsgAttachment {
  readonly filename?: string;
  readonly transfer_name?: string;
  readonly mime_type?: string;
  readonly total_bytes?: number;
  readonly is_sticker?: boolean;
  readonly missing?: boolean;
  readonly original_path?: string;
}

// A Messages row as `imsg rpc` reports it (docs/json.md); only the fields the
// channel reads.
export interface IMsgMessage {
  readonly id: number;
  readonly guid?: string;
  // Present only on edited or unsent updates of an earlier row.
  readonly type?: string;
  readonly is_from_me?: boolean;
  readonly is_group?: boolean;
  readonly sender?: string;
  readonly chat_id?: number;
  readonly chat_identifier?: string;
  readonly text?: string;
  readonly attachments?: readonly IMsgAttachment[];
}

export type IMsgSendTarget =
  | { readonly chatId: number }
  | { readonly to: string };

export interface IMsgSendOptions {
  readonly file?: string;
}

export type IMsgSendResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      // The message was certainly not sent, so sending again cannot double it.
      readonly retrySafe: boolean;
      // No child could take the send (starting or restarting); nothing was
      // dispatched.
      readonly notRunning?: boolean;
    };

export interface IMsgWatch {
  // The highest row the channel finished with; a new child resumes after it.
  cursor(): number | undefined;
  message(message: IMsgMessage): void;
}

export interface IMessageTransport {
  start(watch: IMsgWatch): void;
  send(
    target: IMsgSendTarget,
    text: string,
    options?: IMsgSendOptions,
  ): Promise<IMsgSendResult>;
  // The chat's service (`iMessage`, `SMS`, ...), undefined when imsg has no
  // such chat or reports none; rejects when the lookup itself failed.
  chatService(chatId: number): Promise<string | undefined>;
  stop(): Promise<void>;
}

export interface IMsgChild {
  readonly stdin: {
    write(chunk: string): boolean;
    end(): void;
    on(event: "error", listener: (error: Error) => void): unknown;
    readonly writableEnded?: boolean;
    readonly destroyed?: boolean;
  } | null;
  readonly stdout: {
    setEncoding(encoding: "utf8"): unknown;
    on(event: "data", listener: (chunk: string) => void): unknown;
  } | null;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type IMsgSpawn = (executable: string, args: string[]) => IMsgChild;

export interface IMsgRpcOptions {
  readonly executable: string;
  readonly log: Logger;
  readonly spawn?: IMsgSpawn;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

// JSON-RPC error codes imsg uses for sends (docs/rpc.md).
const MAY_HAVE_COMPLETED = -32001;
const LANE_POISONED = -32004;
const INTERNAL = -32603;
const INVALID_PARAMS = -32602;
// Local only: the request was never written to a child.
const NOT_RUNNING = -32099;

const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 30_000;
// A child that ran this long counts as healthy again for the backoff.
const HEALTHY_MS = 60_000;

interface Pending {
  resolve(value: unknown): void;
  reject(error: RpcError): void;
  timer: NodeJS.Timeout;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

function spawnImsg(executable: string, args: string[]): IMsgChild {
  // stderr carries diagnostics that can quote messages, so it is dropped.
  return spawnProcess(executable, args, {
    stdio: ["pipe", "pipe", "ignore"],
  });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return delay(ms, undefined, { signal }).catch(() => undefined);
}

// Supervises one `imsg rpc` child: a line-delimited JSON-RPC client with a
// watch subscription that survives overflows and restarts.
export class IMsgRpc implements IMessageTransport {
  readonly #options: IMsgRpcOptions;
  readonly #spawn: IMsgSpawn;
  readonly #wait: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #stopping = new AbortController();
  #watch: IMsgWatch | undefined;
  #child: IMsgChild | undefined;
  // The current child's stdin was closed; it takes no more requests.
  #closing = false;
  #exited: Promise<void> = Promise.resolve();
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #subscription: number | undefined;
  #failures = 0;
  #supervisor: Promise<void> | undefined;

  constructor(options: IMsgRpcOptions) {
    this.#options = options;
    this.#spawn = options.spawn ?? spawnImsg;
    this.#wait = options.wait ?? abortableDelay;
  }

  start(watch: IMsgWatch): void {
    this.#watch = watch;
    this.#supervisor ??= this.#supervise();
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    const child = this.#child;
    if (child) {
      // imsg drains accepted requests and exits once stdin closes.
      this.#closing = true;
      child.stdin?.end();
      const timeout = this.#options.stopTimeoutMs ?? 5_000;
      const killed = await Promise.race([
        this.#exited.then(() => false),
        delay(timeout).then(() => true),
      ]);
      if (killed) child.kill("SIGKILL");
    }
    await this.#supervisor;
  }

  async send(
    target: IMsgSendTarget,
    text: string,
    options?: IMsgSendOptions,
  ): Promise<IMsgSendResult> {
    const file = options?.file;
    const params: Record<string, unknown> =
      "chatId" in target
        ? { chat_id: target.chatId, text }
        : { to: target.to, text, service: "imessage" };
    if (file) params.file = file;
    try {
      await this.#request("send", params);
      return { ok: true };
    } catch (error) {
      if (!(error instanceof RpcError)) return { ok: false, retrySafe: false };
      if (error.code === NOT_RUNNING)
        return { ok: false, retrySafe: true, notRunning: true };
      // imsg refuses every later send until the child restarts.
      if (error.code === LANE_POISONED) this.#restart("lane_poisoned");
      const data = error.data;
      const retrySafe =
        data && typeof data === "object"
          ? (data as { retry_safe?: unknown }).retry_safe === true
          : // Without delivery data imsg refused the request before
            // dispatch; only these codes may hide a dispatched send.
            error.code !== MAY_HAVE_COMPLETED && error.code !== INTERNAL;
      this.#options.log.warn("imessage.send_failed", {
        code: error.code,
        retry_safe: retrySafe,
        disposition:
          data && typeof data === "object"
            ? (data as { disposition?: unknown }).disposition
            : undefined,
      });
      return { ok: false, retrySafe };
    }
  }

  async chatService(chatId: number): Promise<string | undefined> {
    try {
      const chat = (await this.#request("chats.get", { chat_id: chatId })) as {
        service?: unknown;
      };
      return typeof chat?.service === "string" ? chat.service : undefined;
    } catch (error) {
      // imsg answers an unknown chat with invalid params; that is an answer,
      // not a failed lookup.
      if (error instanceof RpcError && error.code === INVALID_PARAMS)
        return undefined;
      throw error;
    }
  }

  async #supervise(): Promise<void> {
    const signal = this.#stopping.signal;
    while (!signal.aborted) {
      const started = Date.now();
      await this.#runChild();
      if (signal.aborted) return;
      if (Date.now() - started >= HEALTHY_MS) this.#failures = 0;
      const wait = Math.min(
        RESTART_MIN_MS * 2 ** this.#failures,
        RESTART_MAX_MS,
      );
      this.#failures += 1;
      this.#options.log.warn("imessage.imsg_restarting", { wait_ms: wait });
      await this.#wait(wait, signal);
    }
  }

  // Runs one child until it exits.
  async #runChild(): Promise<void> {
    let child: IMsgChild;
    try {
      child = this.#spawn(this.#options.executable, ["rpc"]);
    } catch (error) {
      this.#options.log.warn("imessage.imsg_spawn_failed", {
        error: String(error),
      });
      return;
    }
    this.#child = child;
    this.#closing = false;
    this.#subscription = undefined;
    // A write after the child exited fails with EPIPE; exit reports that.
    child.stdin?.on("error", (error) =>
      this.#options.log.info("imessage.imsg_stdin_error", {
        code: (error as NodeJS.ErrnoException).code,
      }),
    );
    let buffered = "";
    const exited = new Promise<void>((resolve) => {
      let done = false;
      const finish = (code: number | null, error?: Error): void => {
        if (done) return;
        done = true;
        this.#child = undefined;
        for (const [id, pending] of this.#pending) {
          clearTimeout(pending.timer);
          // The child is gone, so whether a send ran is unknown.
          pending.reject(new RpcError(INTERNAL, "imsg exited"));
          this.#pending.delete(id);
        }
        this.#options.log.info("imessage.imsg_exited", {
          code,
          ...(error ? { error: error.message } : {}),
        });
        resolve();
      };
      child.on("exit", (code) => finish(code));
      child.on("error", (error) => finish(null, error));
    });
    this.#exited = exited;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line) this.#receive(line);
      }
    });
    this.#subscribe(this.#watch?.cursor());
    await exited;
  }

  #subscribe(sinceRowid: number | undefined): void {
    this.#subscription = undefined;
    this.#request("watch.subscribe", {
      attachments: true,
      // Omitted on the first start: the watch begins at the current tail, so
      // history is never replayed.
      ...(sinceRowid && sinceRowid > 0 ? { since_rowid: sinceRowid } : {}),
    }).then(
      (result) => {
        const id = (result as { subscription?: unknown })?.subscription;
        if (typeof id === "number") this.#subscription = id;
        this.#options.log.info("imessage.watch_subscribed", {
          resumed: sinceRowid !== undefined && sinceRowid > 0,
        });
      },
      (error: unknown) => {
        // Usually the Messages database is not readable yet; a new child
        // tries again after the backoff.
        this.#options.log.warn("imessage.watch_failed", {
          code: error instanceof RpcError ? error.code : undefined,
        });
        this.#restart("watch_failed");
      },
    );
  }

  #restart(reason: string): void {
    const child = this.#child;
    if (!child) return;
    this.#options.log.warn("imessage.imsg_restart", { reason });
    this.#closing = true;
    child.stdin?.end();
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      this.#options.stopTimeoutMs ?? 5_000,
    );
    void this.#exited.then(() => clearTimeout(timer));
  }

  #request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const child = this.#child;
    const stdin = child?.stdin;
    if (!stdin || this.#closing || stdin.writableEnded || stdin.destroyed)
      return Promise.reject(new RpcError(NOT_RUNNING, "imsg is not running"));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // No answer: a send may still run, so this is not retry-safe.
        reject(new RpcError(INTERNAL, `imsg ${method} timed out`));
      }, this.#options.requestTimeoutMs ?? 60_000);
      this.#pending.set(id, { resolve, reject, timer });
      stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  #receive(line: string): void {
    let record: {
      id?: unknown;
      method?: unknown;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: { code?: unknown; message?: unknown; data?: unknown };
    };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      this.#options.log.warn("imessage.imsg_bad_line", {});
      return;
    }
    if (typeof record.id === "number" && !record.method) {
      const pending = this.#pending.get(record.id);
      if (!pending) return;
      this.#pending.delete(record.id);
      clearTimeout(pending.timer);
      if (record.error)
        pending.reject(
          new RpcError(
            typeof record.error.code === "number"
              ? record.error.code
              : INTERNAL,
            String(record.error.message ?? "imsg error"),
            record.error.data,
          ),
        );
      else pending.resolve(record.result);
      return;
    }
    const params = record.params ?? {};
    if (params.subscription !== this.#subscription) return;
    if (record.method === "message") {
      const message = params.message as IMsgMessage | undefined;
      if (message && typeof message.id === "number")
        this.#watch?.message(message);
    } else if (record.method === "watch.overflow") {
      const resume = params.resume_after_rowid;
      this.#options.log.warn("imessage.watch_overflow", {});
      this.#subscribe(
        typeof resume === "number" ? resume : this.#watch?.cursor(),
      );
    }
  }
}
