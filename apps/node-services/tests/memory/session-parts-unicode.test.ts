import { describe, expect, it } from "vitest";
import {
  MAX_PART_CHARS,
  sessionParts,
} from "../../src/memory/session-parts.js";

describe("Session part Unicode boundaries", () => {
  it.each([MAX_PART_CHARS - 1, 2 * MAX_PART_CHARS - 1])(
    "keeps an astral character whole at offset %s when each part is encoded",
    (offset) => {
      const content = `${"a".repeat(offset)}\u{1f680}${"b".repeat(MAX_PART_CHARS)}`;
      const parts = sessionParts([{ path: "session-a.md", content }]);
      const pieces = parts.flat();
      for (const part of parts) {
        expect(
          part.reduce((sum, piece) => sum + piece.content.length, 0),
        ).toBeLessThanOrEqual(MAX_PART_CHARS);
      }
      expect(pieces.every((piece) => piece.path === "session-a.md")).toBe(true);
      const received = pieces
        .map((piece) => Buffer.from(piece.content).toString("utf8"))
        .join("");
      expect(received.includes("\ufffd")).toBe(false);
      expect(received === content).toBe(true);
    },
  );

  it("retains short Sessions and natural line boundaries", () => {
    const first = { path: "first.md", content: "First session.\n" };
    const second = { path: "second.md", content: "Second session.\n" };
    expect(sessionParts([first, second])).toEqual([[first, second]]);
  });
});
