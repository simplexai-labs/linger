import { expect, it } from "vitest";
import { clipSourceText } from "../../src/agent/agent-features/agent-memory/coordinator.js";

const limit = 4_000;

/** A high surrogate with no low surrogate after it is half a character. */
function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

it("counts the omitted characters the way the note words them", () => {
  // Two astral characters are two characters, not four code units.
  const text = `${"a".repeat(limit - 1)}\u{1F600}\u{1F600}`;
  const clipped = clipSourceText(text);
  expect(clipped).toBe(`${"a".repeat(limit - 1)}… [2 characters omitted]`);
  expect(hasLoneSurrogate(clipped)).toBe(false);
});

it("never keeps half of a character at the cut", () => {
  const text = `${"a".repeat(limit - 1)}\u{1F600}${"b".repeat(5)}`;
  const clipped = clipSourceText(text);
  expect(hasLoneSurrogate(clipped)).toBe(false);
  expect(clipped).toBe(`${"a".repeat(limit - 1)}… [6 characters omitted]`);
});

it("keeps a source that fits, and the note for plain text", () => {
  expect(clipSourceText("short")).toBe("short");
  expect(clipSourceText("a".repeat(limit))).toBe("a".repeat(limit));
  expect(clipSourceText("a".repeat(limit + 3))).toBe(
    `${"a".repeat(limit)}… [3 characters omitted]`,
  );
});
