import { expect, it } from "vitest";
import {
  dailyReport,
  experienceCard,
} from "../../src/memory/flashback/card.js";

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

it("cuts a long activity line between characters, not inside one", () => {
  const { items } = dailyReport(
    {
      date: "2026-11-20",
      title: "Daily",
      content: `## Daily Work\n\n- ${"a".repeat(198)}\u{1F600}${"b".repeat(10)}\n`,
    },
    [],
  );
  const [item] = items;
  expect(item?.kind).toBe("work");
  expect(item?.text.endsWith("…")).toBe(true);
  expect(hasLoneSurrogate(item?.text ?? "")).toBe(false);
  expect([...(item?.text ?? "")]).toHaveLength(200);
  expect(item?.text.startsWith(`${"a".repeat(198)}\u{1F600}`)).toBe(true);
});

it("keeps a short line with an emoji exactly as it is", () => {
  const line = "Review \u{1F600} notes";
  const { items } = dailyReport(
    {
      date: "2026-11-20",
      title: "Daily",
      content: `## Daily Work\n\n- ${line}\n`,
    },
    [],
  );
  expect(items[0]?.text).toBe(line);
});

it("cuts a long situation in a meeting card the same way", () => {
  const card = experienceCard(
    `## Objective Summary\n\n${"a".repeat(360)}\u{1F600}\n`,
  );
  expect(card.situation.endsWith("…")).toBe(true);
  expect(hasLoneSurrogate(card.situation)).toBe(false);
  expect([...card.situation]).toHaveLength(360);
});
