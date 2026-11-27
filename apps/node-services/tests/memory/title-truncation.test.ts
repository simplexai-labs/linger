import { describe, expect, it } from "vitest";

import { MAX_TITLE_CODE_POINTS, truncateTitle } from "../../src/memory/text.js";

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

describe("truncateTitle", () => {
  it("keeps a title that fits, unchanged", () => {
    expect(truncateTitle("Pricing")).toBe("Pricing");
    expect(truncateTitle("x".repeat(MAX_TITLE_CODE_POINTS))).toBe(
      "x".repeat(MAX_TITLE_CODE_POINTS),
    );
  });

  it("keeps the whole character a unit cut would have halved", () => {
    // 511 ASCII characters plus an emoji is 512 code points but 513 units, so a
    // unit cut would stop inside the emoji.
    const title = `${"a".repeat(MAX_TITLE_CODE_POINTS - 1)}\u{1F600}tail`;
    const truncated = truncateTitle(title);
    expect(hasLoneSurrogate(truncated)).toBe(false);
    expect(truncated).toBe(`${"a".repeat(MAX_TITLE_CODE_POINTS - 1)}\u{1F600}`);
    expect(truncated.length).toBe(MAX_TITLE_CODE_POINTS + 1);
  });

  it("counts an astral title in code points", () => {
    const astral = "\u{1F600}".repeat(MAX_TITLE_CODE_POINTS);
    expect(truncateTitle(astral)).toBe(astral);
    expect([...truncateTitle(`${astral}\u{1F600}`)]).toHaveLength(
      MAX_TITLE_CODE_POINTS,
    );
  });
});
