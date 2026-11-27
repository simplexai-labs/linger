// One `GET /v0/events` stream per session. Room Events apply in room_seq
// order per Room; a gap pages `GET /v0/rooms/{id}/events?after=` before the
// stream continues. The stream carries no SSE ids, so a reopened stream
// passes each Room's last applied room_seq instead.
import type { ServerSentEvent } from "../session/http";
import type {
  ResourceInvalidated,
  RoomEventEnvelope,
  RoomEventPage,
  StreamResync,
} from "../api/types";

/** TeamHub accepts at most this many Room cursors on one stream. */
export const MAX_ROOM_CURSORS = 50;

export type Placement = "apply" | "duplicate" | "gap" | "untracked";

/** The last applied room_seq of each watched Room, most recent last. */
export class RoomCursors {
  #seq = new Map<string, number>();

  /**
   * Starts or refreshes watching a Room from a snapshot. Returns true when
   * the stream must reopen to include it.
   */
  watch(roomId: string, snapshotSeq: number): boolean {
    const current = this.#seq.get(roomId);
    this.#seq.delete(roomId);
    this.#seq.set(roomId, current === undefined ? snapshotSeq : current);
    while (this.#seq.size > MAX_ROOM_CURSORS) {
      const oldest = this.#seq.keys().next().value;
      if (oldest === undefined) break;
      this.#seq.delete(oldest);
    }
    return current === undefined;
  }

  seq(roomId: string): number | undefined {
    return this.#seq.get(roomId);
  }

  classify(event: Pick<RoomEventEnvelope, "room_id" | "room_seq">): Placement {
    const last = this.#seq.get(event.room_id);
    if (last === undefined) return "untracked";
    if (event.room_seq <= last) return "duplicate";
    return event.room_seq === last + 1 ? "apply" : "gap";
  }

  advance(roomId: string, seq: number): void {
    const last = this.#seq.get(roomId);
    if (last !== undefined && seq > last) this.#seq.set(roomId, seq);
  }

  /** The `/v0/events` path with one `room=<id>:<seq>` per watched Room. */
  streamPath(): string {
    const rooms = [...this.#seq.entries()].map(
      ([roomId, seq]) => `room=${encodeURIComponent(`${roomId}:${seq}`)}`,
    );
    return rooms.length > 0 ? `/v0/events?${rooms.join("&")}` : "/v0/events";
  }
}

export interface RoomEventSource {
  subscribe(
    path: string,
    handlers: {
      onEvent(event: ServerSentEvent): void;
      onClose(reason: string): void;
    },
  ): () => void;
  listRoomEvents(roomId: string, after: number): Promise<RoomEventPage>;
}

export interface RoomEventHandlers {
  /** Runs once per Room Event, in room_seq order per Room. */
  applyRoomEvent(event: RoomEventEnvelope): void | Promise<void>;
  onInvalidated(event: ResourceInvalidated): void;
  /** The server may have dropped hints: refetch what is on screen. */
  onResync(event: StreamResync): void;
  /** TeamHub ended the device Session behind this stream. */
  onSessionExpired(): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const REOPEN_DEBOUNCE_MS = 150;
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

export class RoomEventSync {
  readonly cursors = new RoomCursors();
  #cancel: (() => void) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #timer: unknown;
  #failures = 0;
  #stopped = false;
  #generation = 0;

  constructor(
    private readonly source: RoomEventSource,
    private readonly handlers: RoomEventHandlers,
    private readonly timers: Timers = defaultTimers,
  ) {}

  start(): void {
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) this.timers.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  /** Watches a Room from the room_seq its loaded snapshot reflects. */
  watch(roomId: string, snapshotSeq: number): void {
    if (this.cursors.watch(roomId, snapshotSeq))
      this.#reopen(REOPEN_DEBOUNCE_MS);
  }

  /** Resolves after every queued Room Event was applied. */
  idle(): Promise<void> {
    return this.#queue;
  }

  #reopen(delay: number): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) this.timers.clearTimeout(this.#timer);
    this.#timer = this.timers.setTimeout(() => {
      this.#timer = undefined;
      this.#open();
    }, delay);
  }

  #open(): void {
    if (this.#stopped) return;
    // The new generation comes first: cancelling the previous stream reports
    // its close, which must not count as this stream failing.
    this.#generation += 1;
    const generation = this.#generation;
    this.#cancel?.();
    this.#cancel = this.source.subscribe(this.cursors.streamPath(), {
      onEvent: (event) => {
        if (generation === this.#generation) this.#dispatch(event);
      },
      onClose: () => {
        if (generation !== this.#generation || this.#stopped) return;
        this.#cancel = undefined;
        const delay = Math.min(
          RETRY_CAP_MS,
          RETRY_BASE_MS * 2 ** this.#failures,
        );
        this.#failures = Math.min(this.#failures + 1, 16);
        this.#reopen(delay);
      },
    });
  }

  #dispatch(event: ServerSentEvent): void {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (event.event) {
      case "room.event":
        this.#enqueue(() => this.#place(data as RoomEventEnvelope));
        break;
      case "resource.invalidated":
        this.handlers.onInvalidated(data as ResourceInvalidated);
        break;
      case "stream.resync":
        this.#failures = 0;
        this.handlers.onResync(data as StreamResync);
        break;
      case "session.expired":
        this.stop();
        this.handlers.onSessionExpired();
        break;
      default:
        break;
    }
  }

  #enqueue(task: () => Promise<void>): void {
    this.#queue = this.#queue.then(task).catch(() => {
      // A failed gap fill or apply leaves the cursor where it was; a fresh
      // stream replays from there.
      this.#reopen(RETRY_BASE_MS);
    });
  }

  async #place(event: RoomEventEnvelope): Promise<void> {
    switch (this.cursors.classify(event)) {
      case "apply":
        await this.handlers.applyRoomEvent(event);
        this.cursors.advance(event.room_id, event.room_seq);
        return;
      case "gap":
        await this.#fill(event.room_id);
        // The page normally covers this event; apply it if it did not.
        if (this.cursors.classify(event) === "apply") {
          await this.handlers.applyRoomEvent(event);
          this.cursors.advance(event.room_id, event.room_seq);
        }
        return;
      default:
        return;
    }
  }

  async #fill(roomId: string): Promise<void> {
    for (;;) {
      const after = this.cursors.seq(roomId);
      if (after === undefined || this.#stopped) return;
      const page = await this.source.listRoomEvents(roomId, after);
      let applied = 0;
      for (const item of page.items) {
        if (this.cursors.classify(item) !== "apply") continue;
        await this.handlers.applyRoomEvent(item);
        this.cursors.advance(item.room_id, item.room_seq);
        applied += 1;
      }
      if (!page.has_more || applied === 0) return;
    }
  }
}
