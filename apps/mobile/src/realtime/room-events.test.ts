import { describe, expect, it } from "vitest";

import type { RoomEventEnvelope, RoomEventPage } from "../api/types";
import type { ServerSentEvent } from "../session/http";
import {
  MAX_ROOM_CURSORS,
  RoomCursors,
  RoomEventSync,
  type RoomEventSource,
} from "./room-events";

function envelope(roomId: string, seq: number): RoomEventEnvelope {
  return {
    event_id: `${roomId}-${seq}`,
    tenant_id: "t1",
    room_id: roomId,
    room_seq: seq,
    occurred_at: "2026-11-22T10:00:00Z",
    event_type: "message.created",
    payload: { kind: "message.created" },
  } as unknown as RoomEventEnvelope;
}

class FakeSource implements RoomEventSource {
  paths: string[] = [];
  pages: { roomId: string; after: number }[] = [];
  history = new Map<string, RoomEventEnvelope[]>();
  emit: ((event: ServerSentEvent) => void) | undefined;
  close: ((reason: string) => void) | undefined;

  subscribe(
    path: string,
    handlers: {
      onEvent(event: ServerSentEvent): void;
      onClose(reason: string): void;
    },
  ): () => void {
    this.paths.push(path);
    this.emit = handlers.onEvent;
    this.close = handlers.onClose;
    return () => undefined;
  }

  async listRoomEvents(roomId: string, after: number): Promise<RoomEventPage> {
    this.pages.push({ roomId, after });
    const all = (this.history.get(roomId) ?? []).filter(
      (event) => event.room_seq > after,
    );
    const items = all.slice(0, 2);
    return {
      items,
      latest_room_seq: all.at(-1)?.room_seq ?? after,
      has_more: all.length > 2,
    };
  }

  send(event: string, data: unknown): void {
    this.emit?.({ event, data: JSON.stringify(data) });
  }
}

const immediateTimers = {
  setTimeout: (callback: () => void) => {
    callback();
    return 0;
  },
  clearTimeout: () => undefined,
};

describe("RoomCursors", () => {
  it("places events by room_seq and builds the stream path", () => {
    const cursors = new RoomCursors();
    expect(cursors.watch("room_a", 4)).toBe(true);
    expect(cursors.watch("room_a", 2)).toBe(false);
    expect(cursors.classify({ room_id: "room_a", room_seq: 4 })).toBe(
      "duplicate",
    );
    expect(cursors.classify({ room_id: "room_a", room_seq: 5 })).toBe("apply");
    expect(cursors.classify({ room_id: "room_a", room_seq: 7 })).toBe("gap");
    expect(cursors.classify({ room_id: "room_b", room_seq: 1 })).toBe(
      "untracked",
    );
    cursors.watch("room_b", 0);
    expect(cursors.streamPath()).toBe(
      "/v0/events?room=room_a%3A4&room=room_b%3A0",
    );
  });

  it("keeps only the most recently watched Rooms", () => {
    const cursors = new RoomCursors();
    for (let index = 0; index <= MAX_ROOM_CURSORS; index += 1)
      cursors.watch(`room_${index}`, 0);
    expect(cursors.seq("room_0")).toBeUndefined();
    expect(cursors.seq(`room_${MAX_ROOM_CURSORS}`)).toBe(0);
  });
});

describe("RoomEventSync", () => {
  it("applies in order, skips duplicates, and pages over a gap", async () => {
    const source = new FakeSource();
    const applied: string[] = [];
    const sync = new RoomEventSync(
      source,
      {
        applyRoomEvent: (event) => {
          applied.push(`${event.room_id}:${event.room_seq}`);
        },
        onInvalidated: () => undefined,
        onResync: () => undefined,
        onSessionExpired: () => undefined,
      },
      immediateTimers,
    );
    sync.start();
    sync.watch("room_a", 10);
    expect(source.paths.at(-1)).toBe("/v0/events?room=room_a%3A10");

    source.send("room.event", envelope("room_a", 11));
    source.send("room.event", envelope("room_a", 11));
    source.history.set(
      "room_a",
      [12, 13, 14, 15].map((seq) => envelope("room_a", seq)),
    );
    source.send("room.event", envelope("room_a", 15));
    source.send("room.event", envelope("room_a", 16));
    await sync.idle();

    expect(applied).toEqual([
      "room_a:11",
      "room_a:12",
      "room_a:13",
      "room_a:14",
      "room_a:15",
      "room_a:16",
    ]);
    expect(source.pages).toEqual([
      { roomId: "room_a", after: 11 },
      { roomId: "room_a", after: 13 },
    ]);
    expect(sync.cursors.seq("room_a")).toBe(16);
  });

  it("passes hints through, reopens from the cursor and stops on session.expired", async () => {
    const source = new FakeSource();
    const seen: string[] = [];
    const sync = new RoomEventSync(
      source,
      {
        applyRoomEvent: () => undefined,
        onInvalidated: (event) =>
          seen.push(`invalidated:${event.resource}:${event.id}`),
        onResync: (event) => seen.push(`resync:${event.reason}`),
        onSessionExpired: () => seen.push("expired"),
      },
      immediateTimers,
    );
    sync.start();
    sync.watch("room_a", 3);
    source.send("room.event", envelope("room_a", 4));
    await sync.idle();
    source.send("resource.invalidated", {
      tenant_id: "t1",
      resource: "room",
      id: "room_a",
    });
    source.send("stream.resync", { reason: "hints_lost" });
    source.close?.("ended");
    expect(source.paths.at(-1)).toBe("/v0/events?room=room_a%3A4");
    source.send("session.expired", { code: "SESSION_EXPIRED" });
    expect(seen).toEqual([
      "invalidated:room:room_a",
      "resync:hints_lost",
      "expired",
    ]);
  });

  it("does not treat cancelling its own previous stream as a failure", () => {
    // Like the real subscribe, cancelling reports the close synchronously.
    class CancellingSource extends FakeSource {
      override subscribe(
        path: string,
        handlers: {
          onEvent(event: ServerSentEvent): void;
          onClose(reason: string): void;
        },
      ): () => void {
        super.subscribe(path, handlers);
        return () => handlers.onClose("cancelled");
      }
    }
    const source = new CancellingSource();
    const pending: (() => void)[] = [];
    const sync = new RoomEventSync(
      source,
      {
        applyRoomEvent: () => undefined,
        onInvalidated: () => undefined,
        onResync: () => undefined,
        onSessionExpired: () => undefined,
      },
      {
        setTimeout: (callback: () => void) => pending.push(callback),
        clearTimeout: () => undefined,
      },
    );
    sync.start();
    sync.watch("room_a", 3);
    pending.shift()?.();
    expect(source.paths).toEqual(["/v0/events", "/v0/events?room=room_a%3A3"]);
    expect(pending).toEqual([]);
  });
});
