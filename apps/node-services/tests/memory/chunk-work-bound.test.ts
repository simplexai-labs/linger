import { afterEach, expect, it, vi } from "vitest";
import * as analyzer from "../../src/bm25.js";
import { chunkSource } from "../../src/memory/search/chunks.js";

afterEach(() => vi.restoreAllMocks());

it.each([
  ["unspaced Han", "\u4e00\u4e8c".repeat(5_000)],
  ["NFKC-expanding ligatures", "\uFDFA".repeat(10_000)],
])("bounds analyzer work for %s", (_name, content) => {
  const tokenizer = vi.spyOn(analyzer, "tokenizeSearchText");
  const chunks = chunkSource(content);
  const analyzedCharacters = tokenizer.mock.calls.reduce(
    (total, [text]) => total + text.length,
    0,
  );

  expect(chunks.length).toBeGreaterThan(1);
  expect(analyzedCharacters).toBeGreaterThanOrEqual(content.length);
  // A generous linear budget catches repeated full-window scans without timing noise.
  expect(analyzedCharacters).toBeLessThanOrEqual(content.length * 20);
});
