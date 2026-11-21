import { describe, expect, it } from "vitest";
import { contentWindow } from "../../src/memory/search/content-window.js";
import { tokenizeSearchText } from "../../src/bm25.js";

const terms = (query: string) => new Set(tokenizeSearchText(query));
const filler = (label: string) =>
  `${label} ${"The assistant explains general packing advice in detail. ".repeat(6)}`;

describe("inline content window", () => {
  it("keeps short content unchanged", () => {
    expect(
      contentWindow("Max is a Golden Retriever.", terms("dog breed"), 800),
    ).toBe("Max is a Golden Retriever.");
  });

  it("starts at the Room message that holds the best query match", () => {
    const content = [
      "## 2023-05-19T23:46:00.000Z · user",
      filler("Intro."),
      "## 2023-05-19T23:46:01.000Z · assistant",
      filler("Advice."),
      "## 2023-05-20T08:00:00.000Z · user",
      "I packed five pairs of shoes for my last trip but wore only two.",
      "## 2023-05-20T08:00:01.000Z · assistant",
      filler("Reply."),
    ].join("\n\n");
    const window = contentWindow(content, terms("shoes packed last trip"), 800);
    expect(window.startsWith("…\n\n## 2023-05-20T08:00:00.000Z · user")).toBe(
      true,
    );
    expect(window).toContain("five pairs of shoes");
    expect(window.length).toBeLessThanOrEqual(805);
  });

  it("bounds a shorter window the same way", () => {
    const content = [
      "## 2023-05-19T23:46:00.000Z · user",
      filler("Intro."),
      "## 2023-05-20T08:00:00.000Z · user",
      "I packed five pairs of shoes for my last trip but wore only two.",
      filler("Reply."),
    ].join("\n\n");
    const window = contentWindow(content, terms("shoes packed"), 500);
    expect(window).toContain("five pairs of shoes");
    expect(window.length).toBeLessThanOrEqual(505);
  });

  it("keeps the chunk start when nothing matches", () => {
    const content = filler("Start.").repeat(3);
    expect(contentWindow(content, terms("zebra"), 800)).toBe(
      `${content.slice(0, 799)}…`,
    );
  });

  it.each([200, 500, 800])(
    "keeps a late match within a %i-character paragraph window",
    (budget) => {
      const content = `${"Background detail. ".repeat(90)}The cobalt allowance is 37.5k USD. ${"More context. ".repeat(30)}`;
      const window = contentWindow(content, terms("cobalt allowance"), budget);
      expect(window).toContain("The cobalt allowance is 37.5k USD.");
      expect(window.length).toBeLessThanOrEqual(budget + 5);
    },
  );

  it("keeps the enclosing message heading beside a late paragraph match", () => {
    const heading = "## 2026-09-15T10:00:00+08:00 · Alice";
    const content = `${heading}\n\n${"General background. ".repeat(80)}The cobalt allowance is 37.5k USD.`;
    const window = contentWindow(content, terms("cobalt allowance"), 200);
    expect(window).toContain(heading);
    expect(window).toContain("The cobalt allowance is 37.5k USD.");
    expect(window.length).toBeLessThanOrEqual(205);
  });

  it("reserves evidence space when a heading exceeds the budget", () => {
    const content = `## ${"A long heading ".repeat(40)}\n\nThe cobalt allowance is 37.5k USD.`;
    const window = contentWindow(content, terms("cobalt allowance"), 200);
    expect(window).toContain("The cobalt allowance is 37.5k USD.");
    expect(window.length).toBeLessThanOrEqual(205);
  });

  it.each([
    ["cobalt", "Ｃｏｂａｌｔ"],
    ["\u7532\u4e59", "\u4e19\u7532\u4e59\u4e01"],
  ])("uses the shared analyzer to locate %s", (query, match) => {
    const content = `${"Background. ".repeat(100)}${match} 37.5k ${"Later. ".repeat(30)}`;
    const window = contentWindow(content, terms(query), 200);
    expect(window).toContain(`${match} 37.5k`);
    expect(window.length).toBeLessThanOrEqual(205);
  });

  it("does not turn a partial token at a window edge into a match", () => {
    const content = `${"x".repeat(192)} catalog ${"Background. ".repeat(100)}The cat is named Milo.`;
    const window = contentWindow(content, terms("cat"), 200);
    expect(window).toContain("The cat is named Milo.");
  });

  it("keeps a fitting identifier that straddles overlapping window edges", () => {
    const identifier = "reference".repeat(14);
    const content = `${"x ".repeat(45)}${identifier} ${"Background. ".repeat(30)}`;
    expect(contentWindow(content, terms(identifier), 200)).toContain(
      identifier,
    );
  });

  it("keeps supplementary characters intact at passage boundaries", () => {
    const content = `${"🌍".repeat(300)} cobalt allowance ${"🌍".repeat(300)}`;
    const window = contentWindow(content, terms("cobalt allowance"), 200);
    expect(window).toContain("cobalt allowance");
    expect(window).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(window).not.toContain("\uFFFD");
    expect(window.length).toBeLessThanOrEqual(205);
  });

  it("marks omitted paragraphs when the last complete paragraph ends with an ellipsis", () => {
    const first = "cobalt allowance";
    const ending = "To be continued…";
    const second = `${"x".repeat(200 - first.length - ending.length - 5)}${ending}`;
    const content = [first, second, "Later evidence.", "Final context."].join(
      "\n\n",
    );
    expect(contentWindow(content, terms("cobalt allowance"), 200)).toBe(
      `${first}\n\n${second}\n\n…`,
    );
  });

  it.each([".", "…"])(
    "marks later paragraphs after a leading cut with a %s ending",
    (ending) => {
      const first = `${"Background detail. ".repeat(26)}The cobalt allowance is 37.5k USD${ending}`;
      const content = [first, "Later paragraph.", "Final context."].join(
        "\n\n",
      );
      const window = contentWindow(content, terms("cobalt allowance"), 200);
      expect(window.startsWith("…")).toBe(true);
      expect(window.endsWith(`37.5k USD${ending}\n\n…`)).toBe(true);
      expect(window.length).toBeLessThanOrEqual(200);
    },
  );

  it("does not mark later paragraphs when a leading cut reaches the final paragraph", () => {
    const content = `${"Background detail. ".repeat(26)}The cobalt allowance is 37.5k USD.`;
    const window = contentWindow(content, terms("cobalt allowance"), 200);
    expect(window.startsWith("…")).toBe(true);
    expect(window.endsWith("37.5k USD.")).toBe(true);
    expect(window).not.toContain("\n\n…");
  });

  it("keeps one omission marker when the selected passage cuts the paragraph tail", () => {
    const first = `${"Background detail. ".repeat(30)}The cobalt allowance is 37.5k USD. ${"Further context. ".repeat(30)}`;
    const window = contentWindow(
      [first, "Later paragraph."].join("\n\n"),
      terms("cobalt allowance"),
      200,
    );
    expect(window).toContain("The cobalt allowance is 37.5k USD.");
    expect(window.endsWith("…")).toBe(true);
    expect(window).not.toContain("\n\n…");
  });
});
