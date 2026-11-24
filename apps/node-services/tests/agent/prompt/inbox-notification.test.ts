import { describe, expect, it } from "vitest";

import {
  DEFAULT_INBOX_PROMPT_TEMPLATE,
  renderInboxNotificationPrompt,
} from "../../../src/agent/prompt/index.js";
import { renderRuntimeContinuationReminder } from "../../../src/agent/prompt/inbox-notification.js";

describe("Inbox notification message previews", () => {
  it("pairs each Inbox summary with its previews in the compact default", () => {
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).toContain("{{inbox_updates}}");
    expect(DEFAULT_INBOX_PROMPT_TEMPLATE).not.toContain(
      "Respond to direct mentions",
    );
    expect(
      renderInboxNotificationPrompt(DEFAULT_INBOX_PROMPT_TEMPLATE, {
        agent_name: "Reviewer",
        changed_inbox_count: "1",
        changed_inboxes: `- Inbox room-1
  New messages for you: 1`,
        message_previews: `  Showing all 1 new message:
    message-5 Alice: "Latest"

`,
        triggered_at: "2026-08-26T00:00:00.000Z",
      }),
    ).toBe(`Inbox updates are available:
- Inbox room-1
  New messages for you: 1
  Showing all 1 new message:
    message-5 Alice: "Latest"

Use the messages shown above when they provide enough context. If more context is needed, use teamhub message read or teamhub message search to read history that is not already represented in your current context. Read earlier messages only when they may affect your response. Follow your role instructions.`);
  });
});

describe("renderRuntimeContinuationReminder", () => {
  it("inlines recent messages and exact cursor/message-id commands when available", () => {
    const rendered = renderRuntimeContinuationReminder(
      ["room:room-1", "thread:thread-9"],
      {
        inboxId: "room:room-1",
        nextCursor: "cur_abc",
        messages: [
          {
            messageId: "msg-1",
            author: "Alice",
            authorKind: "human",
            body: "Please deploy v2",
            createdAt: "2026-05-01T10:00:00Z",
          },
          {
            messageId: "msg-2",
            author: "Bot",
            authorKind: "agent",
            body: "Long output...",
            truncated: true,
            createdAt: "2026-05-01T10:01:00Z",
          },
        ],
      },
    );
    expect(rendered).toContain("new native session");
    expect(rendered).toContain("teamhub message read --cursor cur_abc");
    expect(rendered).toContain("teamhub message read --message-ids <id>");
    expect(rendered).toContain('Other input inboxes: ["thread:thread-9"]');
    expect(rendered).toContain('<recent_messages inbox="room:room-1">');
    expect(rendered).toContain(
      'message_id="msg-1" Alice (human): "Please deploy v2"',
    );
    expect(rendered).toContain(
      'message_id="msg-2" Bot (agent) [truncated]: "Long output..."',
    );
    expect(rendered).not.toContain("/workspace/agent-memory");
  });

  it("renders a concise inbox-specific read command when no recent messages are attached", () => {
    const threadRendered = renderRuntimeContinuationReminder(["thread:t-42"]);
    expect(threadRendered).toContain("teamhub message read --thread t-42");
    expect(threadRendered).not.toContain("<recent_messages");

    const taskRendered = renderRuntimeContinuationReminder(["task:task-7"]);
    expect(taskRendered).toContain("teamhub message read --inbox task:task-7");

    const emptyRendered = renderRuntimeContinuationReminder([]);
    expect(emptyRendered).toContain("teamhub message read --list-inboxes");
  });
});
