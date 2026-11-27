import { describe, expect, it } from "vitest";

import { HttpError } from "../session/http";
import { SessionClosed } from "../session/session";
import { MemoryFiles } from "../testing/memory";
import type { Message } from "../api/types";
import { Outbox, type OutboxEntry } from "./outbox";

const hostId = "e".repeat(32);
const body = {
  raw_message: "Book the table \u{1F37D}",
  segments: [{ type: "text" as const, content: "Book the table \u{1F37D}" }],
  attachment_upload_ids: ["upload-1"],
};

function message(id: string): Message {
  return { id } as Message;
}

describe("Outbox", () => {
  it("persists the exact request before sending and resends it identically", async () => {
    const files = new MemoryFiles();
    const delivered: string[] = [];
    const outbox = new Outbox(files, hostId, (entry) =>
      delivered.push(entry.key),
    );
    await outbox.enqueue({
      key: "mobile:k1",
      roomId: "room_1",
      body,
      attachmentNames: ["menu.pdf"],
    });

    const stored = JSON.parse(
      files.files.get(`computers/${hostId}/outbox.json`) ?? "{}",
    ) as {
      entries: OutboxEntry[];
    };
    expect(stored.entries[0]).toMatchObject({
      key: "mobile:k1",
      roomId: "room_1",
      body,
      state: "sending",
    });

    const sent: { key: string; body: string }[] = [];
    let fail = true;
    const send = async (entry: OutboxEntry) => {
      sent.push({ key: entry.key, body: JSON.stringify(entry.body) });
      if (fail) throw new SessionClosed("socket closed (1006)", 1006);
      return message("m1");
    };
    expect(await outbox.flush(send)).toBe(false);
    expect(outbox.entries()).toHaveLength(1);

    // The app restarts: a new outbox reads the same entry back from disk.
    const reloaded = new Outbox(files, hostId, (entry) =>
      delivered.push(entry.key),
    );
    await reloaded.load();
    fail = false;
    expect(await reloaded.flush(send)).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[0]?.key).toBe("mobile:k1");
    expect(reloaded.entries()).toHaveLength(0);
    expect(delivered).toEqual(["mobile:k1"]);
  });

  it("keeps order: a message waiting on the network holds the later ones", async () => {
    const outbox = new Outbox(new MemoryFiles(), hostId, () => undefined);
    await outbox.enqueue({ key: "k1", roomId: "r", body, attachmentNames: [] });
    await outbox.enqueue({ key: "k2", roomId: "r", body, attachmentNames: [] });
    const sent: string[] = [];
    await outbox.flush(async (entry) => {
      sent.push(entry.key);
      throw new HttpError(503, "UNAVAILABLE", "busy");
    });
    expect(sent).toEqual(["k1"]);
    expect(outbox.entries().map((entry) => entry.state)).toEqual([
      "sending",
      "sending",
    ]);
  });

  it("marks a refused message failed, moves on, and retries it on request", async () => {
    const outbox = new Outbox(new MemoryFiles(), hostId, () => undefined);
    await outbox.enqueue({ key: "k1", roomId: "r", body, attachmentNames: [] });
    await outbox.enqueue({ key: "k2", roomId: "r", body, attachmentNames: [] });
    const sent: string[] = [];
    await outbox.flush(async (entry) => {
      sent.push(entry.key);
      if (entry.key === "k1")
        throw new HttpError(422, "ATTACHMENT_UPLOAD_UNAVAILABLE", "gone");
      return message(entry.key);
    });
    expect(sent).toEqual(["k1", "k2"]);
    expect(outbox.entries()).toEqual([
      expect.objectContaining({
        key: "k1",
        state: "failed",
        error: "ATTACHMENT_UPLOAD_UNAVAILABLE",
      }),
    ]);
    await outbox.retry("k1");
    expect(outbox.entries()[0]?.state).toBe("sending");
    await outbox.discard("k1");
    expect(outbox.entries()).toHaveLength(0);
  });
});
