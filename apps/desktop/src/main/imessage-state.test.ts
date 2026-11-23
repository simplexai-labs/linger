import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { IMessageStateStore } from "./imessage-state.js";
import { tempDirectory } from "./test-support.js";

describe("IMessageStateStore", () => {
  it("persists owner-only and reads it back", () => {
    const file = path.join(tempDirectory(), "imessage", "state.json");
    new IMessageStateStore(file).update({ rowid: 5, roomId: "r", roomSeq: 2 });
    expect(new IMessageStateStore(file).get()).toEqual({
      rowid: 5,
      roomId: "r",
      roomSeq: 2,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("starts empty from a damaged file", () => {
    const file = path.join(tempDirectory(), "state.json");
    writeFileSync(file, "{not json");
    expect(new IMessageStateStore(file).get()).toEqual({});
    writeFileSync(file, JSON.stringify({ rowid: "five" }));
    expect(new IMessageStateStore(file).get()).toEqual({});
  });

  it("forgets the reply target or everything", () => {
    const file = path.join(tempDirectory(), "state.json");
    const store = new IMessageStateStore(file);
    store.update({
      rowid: 5,
      replyChatId: 7,
      actorId: "h",
      pendingCard: {
        chatTarget: { chatId: 7 },
        messageId: "m",
        decisionId: "d",
        version: 1,
        questionId: "q",
        input: "radio",
        optionIds: ["o"],
      },
    });
    new IMessageStateStore(file).resetTarget();
    expect(new IMessageStateStore(file).get()).toEqual({
      rowid: 5,
      actorId: "h",
    });
    new IMessageStateStore(file).clear();
    expect(existsSync(file)).toBe(false);
    expect(new IMessageStateStore(file).get()).toEqual({});
  });
});
