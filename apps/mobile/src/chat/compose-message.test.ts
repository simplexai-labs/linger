import { describe, expect, it } from "vitest";

import type { Message } from "../api/types";
import {
  composeMessage,
  insertMention,
  mentionQuery,
  presentDirectMessage,
  type Mentionable,
} from "./compose-message";

const analyst: Mentionable = {
  id: "actor_analyst",
  kind: "agent",
  display_name: "Research Analyst",
};
const ana: Mentionable = {
  id: "actor_ana",
  kind: "human",
  display_name: "Ana",
};

describe("composeMessage", () => {
  it("leads a direct Agent chat's message with that Agent's @", () => {
    expect(
      composeMessage({ text: "hi", mentions: [], directAgent: analyst }),
    ).toEqual({
      raw_message: "@Research Analyst hi",
      segments: [
        {
          type: "reference",
          content: "@Research Analyst",
          target: "actor_analyst",
          target_type: "agent",
        },
        { type: "text", content: " hi" },
      ],
    });
  });

  it("turns chosen members' tokens into references and ignores dropped ones", () => {
    expect(
      composeMessage({
        text: "@Ana and @Research Analyst, look \u{1F440}",
        mentions: [ana, analyst],
      }).segments,
    ).toEqual([
      {
        type: "reference",
        content: "@Ana",
        target: "actor_ana",
        target_type: "user",
      },
      { type: "text", content: " and " },
      {
        type: "reference",
        content: "@Research Analyst",
        target: "actor_analyst",
        target_type: "agent",
      },
      { type: "text", content: ", look \u{1F440}" },
    ]);
    expect(composeMessage({ text: "plain", mentions: [ana] }).segments).toEqual(
      [{ type: "text", content: "plain" }],
    );
  });

  it("does not match a token inside a longer name", () => {
    expect(
      composeMessage({ text: "@Anabel", mentions: [ana] }).segments,
    ).toEqual([{ type: "text", content: "@Anabel" }]);
  });
});

describe("presentDirectMessage", () => {
  const message = {
    author: { id: "me", tenant_id: "t", kind: "human", display_name: "Me" },
    raw_message: "@Research Analyst hi",
    segments: composeMessage({ text: "hi", mentions: [], directAgent: analyst })
      .segments,
  } as unknown as Message;

  it("hides the leading @ of the direct chat's Agent", () => {
    const shown = presentDirectMessage(message, "actor_analyst");
    expect(shown.raw_message).toBe("hi");
    expect(shown.segments).toEqual([{ type: "text", content: "hi" }]);
  });

  it("keeps other messages as they are", () => {
    expect(presentDirectMessage(message, "actor_other")).toBe(message);
    expect(presentDirectMessage(message, undefined)).toBe(message);
  });
});

describe("mention typing", () => {
  it("finds the @query before the caret", () => {
    expect(mentionQuery("hello @Res", 10)).toEqual({ start: 6, query: "Res" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail@host", 9)).toBeUndefined();
  });

  it("inserts the member's token and moves the caret after it", () => {
    expect(insertMention("hello @Res more", 6, 10, analyst)).toEqual({
      text: "hello @Research Analyst  more",
      caret: 24,
    });
  });
});
