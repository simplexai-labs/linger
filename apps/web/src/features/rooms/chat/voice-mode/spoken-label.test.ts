import { describe, expect, it } from "vitest";

import { spokenLabel } from "./spoken-label";

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

describe("spokenLabel", () => {
  it("collapses whitespace and keeps a name that fits", () => {
    expect(spokenLabel("  Project   settings ", 60)).toBe("Project settings");
  });

  it("never leaves half a character at the cut", () => {
    // 59 ASCII characters put the 60th code point across a unit cut.
    const label = spokenLabel(`${"a".repeat(59)}\u{1F600}tail`, 60);
    expect(hasLoneSurrogate(label)).toBe(false);
    expect([...label]).toHaveLength(60);
  });

  it("counts a name of emoji in code points", () => {
    const sixty = "\u{1F600}".repeat(60);
    expect(spokenLabel(sixty, 60)).toBe(sixty);
    expect([...spokenLabel(`${sixty}\u{1F600}`, 60)]).toHaveLength(60);
  });
});
