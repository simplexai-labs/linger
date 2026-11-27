import { describe, expect, it } from "vitest";

import { truncateCodePoints } from "./index.js";

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

describe("truncateCodePoints", () => {
  it("keeps a value that fits", () => {
    expect(truncateCodePoints("Pricing", 24)).toBe("Pricing");
    expect(truncateCodePoints("x".repeat(24), 24)).toBe("x".repeat(24));
  });

  it("never leaves half a character at the cut", () => {
    const value = truncateCodePoints(`${"a".repeat(23)}\u{1F600}tail`, 24);
    expect(hasLoneSurrogate(value)).toBe(false);
    expect(value).toBe(`${"a".repeat(23)}\u{1F600}`);
    // 24 code points, 25 UTF-16 units: a unit cut would have halved the emoji.
    expect(value.length).toBe(25);
  });

  it("counts an astral value in code points", () => {
    const twentyFour = "\u{1F600}".repeat(24);
    expect(truncateCodePoints(twentyFour, 24)).toBe(twentyFour);
    expect([...truncateCodePoints(`${twentyFour}\u{1F600}`, 24)]).toHaveLength(
      24,
    );
  });
});
