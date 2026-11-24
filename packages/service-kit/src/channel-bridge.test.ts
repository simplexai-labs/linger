import { describe, expect, it } from "vitest";

import {
  channelChunks,
  channelIdempotencyKey,
  channelPlainText,
  channelText,
  formatQuestionCard,
  maskExternalId,
  parseNumberedAnswer,
} from "./channel-bridge.js";

describe("channelPlainText", () => {
  it("strips markdown markers while preserving code and links", () => {
    const md = [
      "## Weekly Plan",
      "",
      "- Ship **WeChat** via `iLink`",
      "- Read [docs](https://example.com/docs)",
      "",
      "```ts",
      "const **keep** = 1;",
      "```",
    ].join("\n");

    expect(channelPlainText(md)).toBe(
      [
        "Weekly Plan",
        "",
        "- Ship WeChat via iLink",
        "- Read docs (https://example.com/docs)",
        "",
        "const **keep** = 1;",
      ].join("\n"),
    );

    expect(channelPlainText(md, { includeLinkUrls: false })).toContain(
      "- Read docs",
    );
    expect(channelPlainText(md, { includeLinkUrls: false })).not.toContain(
      "https://example.com/docs",
    );
  });
});

describe("channelChunks", () => {
  it("splits on paragraph and sentence boundaries without cutting emoji graphemes", () => {
    const emoji = "\u{1F468}\u200D\u{1F4BB}";
    const chunks = channelChunks(`${emoji}${emoji}${emoji}`, 6);
    expect(chunks.join("")).toBe(`${emoji}${emoji}${emoji}`);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(6);
    }

    const paragraphs = channelText("First paragraph.\n\nSecond paragraph.", 20);
    expect(paragraphs).toEqual(["First paragraph.", "Second paragraph."]);
  });
});

describe("parseNumberedAnswer", () => {
  it("parses valid radio and checkbox replies and rejects invalid ones", () => {
    expect(parseNumberedAnswer("2", "radio", 3)).toEqual([2]);
    expect(parseNumberedAnswer("1, 3", "checkbox", 3)).toEqual([1, 3]);
    expect(parseNumberedAnswer("1,2", "radio", 3)).toBeUndefined();
    expect(parseNumberedAnswer("1,1", "checkbox", 3)).toBeUndefined();
    expect(parseNumberedAnswer("0", "radio", 3)).toBeUndefined();
    expect(parseNumberedAnswer("4", "radio", 3)).toBeUndefined();
    expect(parseNumberedAnswer("hello", "radio", 3)).toBeUndefined();
  });
});

describe("formatQuestionCard", () => {
  it("formats single-question pending cards owned by the human", () => {
    const formatted = formatQuestionCard(
      {
        kind: "question",
        status: "pending",
        title: "Which day?",
        decision_id: "dec_1",
        version: 2,
        decision_owner: { id: "act_human" },
        question: {
          questions: [
            {
              id: "q1",
              prompt: "Pick one",
              input: "radio",
              options: [
                { id: "o1", label: "Monday" },
                { id: "o2", label: "Tuesday" },
              ],
            },
          ],
        },
      },
      "act_human",
    );
    expect(formatted).toEqual({
      text: "Which day?\nPick one\n1. Monday\n2. Tuesday\nReply with a number.",
      decisionId: "dec_1",
      version: 2,
      questionId: "q1",
      input: "radio",
      optionIds: ["o1", "o2"],
    });
  });

  it("ignores non-question or unowned cards", () => {
    expect(
      formatQuestionCard(
        { kind: "mail_send", status: "pending", title: "Send email" },
        "act_human",
      ),
    ).toBeUndefined();
  });
});

describe("channelIdempotencyKey and maskExternalId", () => {
  it("produces contract-safe keys and masks identifiers", () => {
    const key = channelIdempotencyKey("wechat", "1234567890123456789");
    expect(key).toBe("im:wechat:1234567890123456789");
    expect(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)).toBe(true);
    expect(channelIdempotencyKey("wx", "1").length).toBeGreaterThanOrEqual(8);
    expect(maskExternalId("user_123456")).toBe("***3456");
    expect(maskExternalId("abc")).toBe("***");
  });
});
