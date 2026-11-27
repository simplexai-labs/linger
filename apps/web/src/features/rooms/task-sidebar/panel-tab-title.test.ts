import { describe, expect, it } from "vitest";

import { panelTabTitle } from "./panel-tab-title";

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

describe("panelTabTitle", () => {
  it("keeps a short name as it is, with its spacing collapsed", () => {
    expect(panelTabTitle("  Hello   there ")).toBe("Hello there");
    expect(panelTabTitle("")).toBe("");
  });

  it("cuts a long name between characters, not inside one", () => {
    // 23 ASCII characters and an astral one put the 24th character across the
    // cut where a unit count would split it.
    const title = panelTabTitle(`${"a".repeat(23)}\u{1F600}tail`);
    expect(hasLoneSurrogate(title)).toBe(false);
    expect([...title]).toHaveLength(25);
    expect(title.endsWith("\u2026")).toBe(true);
  });

  it("can shorten a sequence of code points but keeps the string well-formed", () => {
    // A ZWJ family or a flag is several code points; the cut takes whole code
    // points, so the name stays valid text even when the glyph is incomplete.
    const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
    const cut = panelTabTitle(`${"a".repeat(23)}${family}`);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect([...cut]).toHaveLength(25);
    expect(cut.endsWith("\u2026")).toBe(true);
  });

  it("counts an astral name in code points", () => {
    const twentyFour = "\u{1F600}".repeat(24);
    expect(panelTabTitle(twentyFour)).toBe(twentyFour);
    expect([...panelTabTitle(`${twentyFour}\u{1F600}`)]).toHaveLength(25);
  });
});
