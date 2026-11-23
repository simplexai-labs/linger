import { describe, expect, it } from "vitest";

import {
  imessageChunks,
  imessagePlainText,
  imessageText,
} from "./imessage-text.js";

describe("imessagePlainText", () => {
  it("drops Markdown markers but keeps the words", () => {
    expect(
      imessagePlainText(
        "# Plan\n\n**Bold**, *italic*, _under_, ~~gone~~ and `a*b*c`.\n* one\n+ two\n1. first",
      ),
    ).toBe(
      "Plan\n\nBold, italic, under, gone and a*b*c.\n- one\n- two\n1. first",
    );
  });

  it("writes links as text and address", () => {
    expect(
      imessagePlainText(
        "See [the docs](https://example.com/a) or [https://x.io](https://x.io).",
      ),
    ).toBe("See the docs (https://example.com/a) or https://x.io.");
  });

  it("keeps fenced code as it is", () => {
    expect(
      imessagePlainText("Run:\n```sh\necho **not bold** # here\n```\nDone"),
    ).toBe("Run:\necho **not bold** # here\nDone");
  });

  it("leaves snake_case and lone markers alone", () => {
    expect(imessagePlainText("use snake_case_name and 2 * 3 * 4")).toBe(
      "use snake_case_name and 2 * 3 * 4",
    );
  });
});

describe("imessageChunks", () => {
  it("keeps short text in one chunk", () => {
    expect(imessageChunks("hello")).toEqual(["hello"]);
    expect(imessageChunks("  ")).toEqual([]);
  });

  it("prefers paragraph, then line, then sentence boundaries", () => {
    const a = "a".repeat(60);
    expect(imessageChunks(`${a}\n\n${a}`, 100)).toEqual([a, a]);
    expect(imessageChunks(`${a}\n${a}`, 100)).toEqual([a, a]);
    const sentence = `${"word ".repeat(11)}end. ${"more ".repeat(10)}`;
    const chunks = imessageChunks(sentence, 80);
    expect(chunks[0]!.endsWith("end.")).toBe(true);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
  });

  it("never cuts an emoji in half", () => {
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}";
    const text = "x".repeat(9) + family + "y".repeat(5);
    const chunks = imessageChunks(text, 10);
    expect(chunks.join("")).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(family.length + 10);
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
    expect(chunks.some((chunk) => chunk.includes(family))).toBe(true);
  });

  it("splits Markdown into plain chunks", () => {
    expect(imessageText("**hi**")).toEqual(["hi"]);
  });
});
