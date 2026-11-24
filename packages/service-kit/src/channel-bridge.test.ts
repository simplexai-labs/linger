import { describe, expect, it } from "vitest";

import {
  advancePendingCard,
  channelChunks,
  channelIdempotencyKey,
  channelPlainText,
  channelText,
  formatPendingCard,
  formatQuestionCard,
  formatUnsupportedCardNotice,
  isCardPlaceholderMessage,
  isReachableExternalUrl,
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

describe("multi-question, Other, and approval cards", () => {
  it("steps through multi-question cards and accepts both numbered and Other answers", () => {
    const formatted = formatPendingCard(
      {
        kind: "question",
        status: "pending",
        title: "Trip Deck",
        decision_id: "dec_multi",
        version: 1,
        decision_owner: { id: "act_h" },
        question: {
          questions: [
            {
              id: "q1",
              prompt: "Audience?",
              input: "radio",
              options: [
                { id: "o1", label: "Friends" },
                { id: "o2", label: "Team" },
              ],
            },
            {
              id: "q2",
              prompt: "Slide count?",
              input: "radio",
              options: [
                { id: "s1", label: "5 slides" },
                { id: "s2", label: "10 slides" },
              ],
            },
            {
              id: "q3",
              prompt: "Extras?",
              input: "checkbox",
              options: [
                { id: "e1", label: "Map" },
                { id: "e2", label: "Budget" },
              ],
            },
          ],
        },
      },
      "act_h",
    );
    expect(formatted?.text).toContain("Trip Deck (1/3)");
    expect(formatted?.text).toContain("1. Friends");

    const step1 = advancePendingCard(formatted!.state, "1");
    expect(step1.action).toBe("next_question");
    if (step1.action !== "next_question") throw new Error("expected step");
    expect(step1.nextPrompt).toContain("Trip Deck (2/3)");

    // Custom "Other..." text for question 2
    const step2 = advancePendingCard(step1.nextState, "Around 8 slides");
    expect(step2.action).toBe("next_question");
    if (step2.action !== "next_question") throw new Error("expected step");
    expect(step2.nextPrompt).toContain("Trip Deck (3/3)");

    // Checkbox multiple numbers for question 3
    const done = advancePendingCard(step2.nextState, "1, 2");
    expect(done).toEqual({
      action: "submit_question",
      decisionId: "dec_multi",
      version: 1,
      answers: {
        q1: "o1",
        q2: "Around 8 slides",
        q3: ["e1", "e2"],
      },
    });
  });

  it("formats approval cards and resolves approve/deny or passes through chat", () => {
    const formatted = formatPendingCard(
      {
        kind: "runtime_permission",
        status: "pending",
        title: "Run shell script",
        decision_id: "dec_perm",
        version: 4,
        decision_owner: { id: "act_h" },
        runtime_permission: {
          rationale: "Exports slides to PDF",
          tool: "shell",
        },
      },
      "act_h",
    );
    expect(formatted?.text).toContain("Run shell script");
    expect(formatted?.text).toContain("Exports slides to PDF");
    expect(formatted?.text).toContain("1. Approve");
    expect(formatted?.text).toContain("2. Deny");

    expect(advancePendingCard(formatted!.state, "1")).toEqual({
      action: "decide_approval",
      decisionId: "dec_perm",
      version: 4,
      decision: "approve",
    });
    expect(advancePendingCard(formatted!.state, "2")).toEqual({
      action: "decide_approval",
      decisionId: "dec_perm",
      version: 4,
      decision: "deny",
    });
    expect(advancePendingCard(formatted!.state, "what does it run?")).toEqual({
      action: "passthrough",
    });
  });

  it("suppresses localhost links and card placeholder bodies", () => {
    expect(isReachableExternalUrl("http://localhost:3000/t/1")).toBe(false);
    expect(isReachableExternalUrl("http://127.0.0.1:3000/t/1")).toBe(false);
    expect(isReachableExternalUrl("https://linger.example/t/1")).toBe(true);

    expect(
      formatUnsupportedCardNotice(
        { kind: "connection_auth", status: "pending", title: "Connect Gmail" },
        "http://localhost:3000/t/1/rooms/r1/chat",
      ),
    ).toBe("Open Linger to review: Connect Gmail");

    expect(
      isCardPlaceholderMessage("@owner Trip Deck", { title: "Trip Deck" }),
    ).toBe(true);
    expect(
      isCardPlaceholderMessage("@owner Approval needed: Run shell", {
        title: "Run shell",
      }),
    ).toBe(true);
    expect(
      isCardPlaceholderMessage("Let me confirm a few details.", {
        title: "Trip Deck",
      }),
    ).toBe(false);
  });
});
