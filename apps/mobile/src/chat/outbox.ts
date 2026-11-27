// Messages the phone has not seen the computer acknowledge. Each entry keeps
// its Room, idempotency key and exact body on disk, and every retry sends
// that identical request, so TeamHub applies it once however often the
// phone resends it.
import { HttpError } from "../session/http";
import { computerDirectory, type TextFiles } from "../computer/store";
import type { Message, MessageCreateRequest } from "../api/types";

export interface OutboxEntry {
  readonly key: string;
  readonly roomId: string;
  readonly body: MessageCreateRequest;
  readonly createdAt: string;
  /** File names shown on the pending bubble. */
  readonly attachmentNames: readonly string[];
  readonly state: "sending" | "failed";
  /** The error code that made a send fail for good. */
  readonly error?: string;
}

export type SendMessage = (entry: OutboxEntry) => Promise<Message>;

/** HTTP answers after which the identical request may still succeed. */
function transient(error: unknown): boolean {
  if (!(error instanceof HttpError)) return true;
  return (
    error.status >= 500 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429
  );
}

export class Outbox {
  #entries: OutboxEntry[] = [];
  #listeners = new Set<() => void>();
  #writes: Promise<void> = Promise.resolve();
  #flushing: Promise<boolean> | undefined;
  readonly #path: string;

  constructor(
    private readonly files: TextFiles,
    /** The computer every entry belongs to; it never sends through another. */
    readonly hostId: string,
    private readonly onDelivered: (
      entry: OutboxEntry,
      message: Message,
    ) => void,
  ) {
    this.#path = `${computerDirectory(hostId)}/outbox.json`;
  }

  async load(): Promise<void> {
    const text = await this.files.read(this.#path);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as { entries?: OutboxEntry[] };
      this.#entries = parsed.entries ?? [];
    } catch {
      this.#entries = [];
    }
    this.#emit();
  }

  entries(roomId?: string): readonly OutboxEntry[] {
    return roomId
      ? this.#entries.filter((entry) => entry.roomId === roomId)
      : this.#entries;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Persists the message before anything is sent. */
  async enqueue(
    entry: Omit<OutboxEntry, "state" | "createdAt" | "error">,
  ): Promise<OutboxEntry> {
    const queued: OutboxEntry = {
      ...entry,
      state: "sending",
      createdAt: new Date().toISOString(),
    };
    this.#entries = [...this.#entries, queued];
    this.#emit();
    await this.#persist();
    return queued;
  }

  async retry(key: string): Promise<void> {
    this.#replace(key, (entry) => ({
      ...entry,
      state: "sending",
      error: undefined,
    }));
    await this.#persist();
  }

  async discard(key: string): Promise<void> {
    this.#entries = this.#entries.filter((entry) => entry.key !== key);
    this.#emit();
    await this.#persist();
  }

  /**
   * Sends every waiting entry in the order it was written. Resolves true when
   * nothing is left waiting, false when a send must be retried later; later
   * entries wait behind it so the Room sees them in order.
   */
  flush(send: SendMessage): Promise<boolean> {
    this.#flushing ??= this.#flush(send).finally(() => {
      this.#flushing = undefined;
    });
    return this.#flushing;
  }

  async #flush(send: SendMessage): Promise<boolean> {
    for (;;) {
      const next = this.#entries.find((entry) => entry.state === "sending");
      if (!next) return true;
      try {
        const message = await send(next);
        this.#entries = this.#entries.filter((entry) => entry.key !== next.key);
        this.#emit();
        await this.#persist();
        this.onDelivered(next, message);
      } catch (error) {
        if (transient(error)) return false;
        const code = error instanceof HttpError ? error.code : "SEND_FAILED";
        this.#replace(next.key, (entry) => ({
          ...entry,
          state: "failed",
          error: code,
        }));
        await this.#persist();
      }
    }
  }

  #replace(key: string, update: (entry: OutboxEntry) => OutboxEntry): void {
    this.#entries = this.#entries.map((entry) =>
      entry.key === key ? update(entry) : entry,
    );
    this.#emit();
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #persist(): Promise<void> {
    const snapshot = JSON.stringify({ entries: this.#entries });
    this.#writes = this.#writes
      .catch(() => undefined)
      .then(() => this.files.write(this.#path, snapshot));
    return this.#writes;
  }
}
