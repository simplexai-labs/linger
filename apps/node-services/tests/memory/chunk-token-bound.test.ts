import { describe, expect, it } from "vitest";
import { tokenizeSearchText } from "../../src/bm25.js";
import { chunkSource } from "../../src/memory/search/chunks.js";

describe("oversized source token bounds", () => {
  it.each([
    ["short words", "go ".repeat(800)],
    ["Han bigrams", "\u4e00\u4e8c".repeat(800)],
    ["astral Han bigrams", "\u{20000}\u{20001}".repeat(800)],
  ])(
    "bounds every chunk of %s without losing source offsets",
    (_name, content) => {
      const chunks = chunkSource(content);
      expect(chunks.length).toBeGreaterThan(1);
      let coveredUntil = 0;
      for (const chunk of chunks) {
        expect(tokenizeSearchText(chunk.content).length).toBeLessThanOrEqual(
          500,
        );
        expect(chunk.content.length).toBeLessThanOrEqual(3_000);
        expect(chunk.content).toBe(content.slice(chunk.start, chunk.end));
        expect(chunk.start).toBeLessThanOrEqual(coveredUntil);
        expect(chunk.end).toBeGreaterThan(coveredUntil);
        expect(chunk.content).not.toMatch(/\p{Surrogate}/u);
        coveredUntil = chunk.end;
      }
      expect(coveredUntil).toBe(content.length);
      expect(chunkSource(content)).toEqual(chunks);
    },
  );

  it("keeps an ordinary paragraph and its heading unchanged", () => {
    const content = "# Release notes\n\nA small searchable paragraph.\n";
    const chunks = chunkSource(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      content,
      headingPath: ["Release notes"],
      start: 0,
      end: content.length,
      lineStart: 1,
      lineEnd: 3,
    });
  });
});
