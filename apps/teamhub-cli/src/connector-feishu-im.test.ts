import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runCli } from "./cli.js";
import { connectorVersions, type Json } from "./connector-runtime.js";
import { requestBodyText, requestUrlText } from "./test-support/fetch-text.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

// TeamHub serves the Feishu IM tools itself, so the fixture answers their
// calls in TeamHub's chat shape, as its tool provider does.
async function fixture(
  handler: (slug: string, args: Json) => unknown,
  held = false,
) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "feishu-im-"));
  roots.push(cwd);
  const calls: { slug: string; args: Json }[] = [];
  const output: string[] = [];
  const errors: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const endpoint = requestUrlText(url);
    const body: Json = init?.body ? JSON.parse(requestBodyText(init.body)) : {};
    if (endpoint.endsWith("/apps/account"))
      return Response.json({
        status: "ready",
        account: {
          connection_id: "connection_feishu",
          app_key: "feishu_im",
          display_name: "Feishu IM",
          identity_label: "owner@example.test",
        },
      });
    if (endpoint.endsWith("/apps/tools/bind")) {
      expect(body.tool_version).toBe(connectorVersions["feishu-im"]);
      return Response.json({
        tools: (body.tool_slugs as string[]).map((slug) => ({
          tool_slug: slug,
          tool_version: body.tool_version,
          app_key: "feishu_im",
          input_schema: { type: "object" },
        })),
      });
    }
    if (endpoint.endsWith("/apps/tools/execute")) {
      const slug = String(body.tool_slug);
      calls.push({ slug, args: body.arguments as Json });
      // TeamHub holds the final write for the sponsor instead of running it.
      if (held)
        return Response.json({
          status: "confirmation_pending",
          interaction_id: "interaction_1",
          message_id: "om_card",
          room_id: "room_1",
        });
      return Response.json({
        data: await handler(slug, body.arguments as Json),
      });
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  });
  const run = async (args: string[]) => {
    output.length = 0;
    errors.length = 0;
    const code = await runCli(["feishu-im", ...args, "--json"], {
      cwd,
      env: {
        TEAMHUB_URL: "https://teamhub.example",
        TEAMHUB_TOKEN: "th_agent_fixture",
        TEAMHUB_STATE_ROOT: cwd,
      },
      fetch: fetcher,
      stdout: (s: string) => {
        output.push(s);
      },
      stderr: (s: string) => {
        errors.push(s);
      },
    });
    return {
      code,
      result: output.length ? JSON.parse(output.join("")) : undefined,
      error: errors.length ? JSON.parse(errors.join("")) : undefined,
    };
  };
  return { cwd, calls, run };
}

// TeamHub hands the tools' fields back in Feishu's own keys.
const chat = {
  chat_id: "oc_1",
  name: "Release",
  chat_mode: "group",
  chat_type: "private",
};
const message = {
  message_id: "om_1",
  chat_id: "oc_1",
  sender_id: "ou_1",
  sender_type: "user",
  msg_type: "text",
  text: "Ship it",
  create_time: "1730000000000",
};

describe("teamhub feishu-im", () => {
  it("lists the owner's chats", async () => {
    const f = await fixture(() => ({ chats: [chat] }));

    const listed = await f.run(["chats"]);

    expect(listed.code).toBe(0);
    expect(f.calls).toEqual([
      { slug: "FEISHU_IM_LIST_CHATS", args: { page_size: 20 } },
    ]);
    expect(listed.result.chats).toEqual([
      {
        chatId: "oc_1",
        name: "Release",
        chatMode: "group",
        chatType: "private",
      },
    ]);
  });

  it("lists one chat's messages oldest first", async () => {
    const f = await fixture(() => ({ messages: [message] }));

    const listed = await f.run(["messages", "oc_1", "--limit", "10"]);

    expect(listed.code).toBe(0);
    expect(f.calls).toEqual([
      {
        slug: "FEISHU_IM_LIST_MESSAGES",
        args: { chat_id: "oc_1", page_size: 10 },
      },
    ]);
    expect(listed.result).toMatchObject({
      chatId: "oc_1",
      messages: [
        {
          messageId: "om_1",
          chatId: "oc_1",
          senderId: "ou_1",
          senderType: "user",
          msgType: "text",
          text: "Ship it",
          createdAt: "1730000000000",
        },
      ],
    });
  });

  it("reads one message without changing its read state", async () => {
    const f = await fixture(() => message);

    const read = await f.run(["get", "om_1"]);

    expect(read.code).toBe(0);
    expect(f.calls).toEqual([
      { slug: "FEISHU_IM_GET_MESSAGE", args: { message_id: "om_1" } },
    ]);
    expect(read.result.message).toMatchObject({
      messageId: "om_1",
      text: "Ship it",
    });
  });

  it("sends text to a chat", async () => {
    const f = await fixture(() => ({
      message_id: "om_2",
      sent: true,
    }));

    const sent = await f.run(["send", "--chat", "oc_1", "--content", "Hello"]);

    expect(sent.code).toBe(0);
    expect(f.calls).toEqual([
      {
        slug: "FEISHU_IM_SEND_MESSAGE",
        args: {
          receive_id: "oc_1",
          receive_id_type: "chat_id",
          text: "Hello",
        },
      },
    ]);
    expect(sent.result.result).toEqual({
      action: "sent",
      acknowledged: true,
      messageId: "om_2",
    });
  });

  it("sends to a person by open_id or user ID", async () => {
    const f = await fixture(() => ({ message_id: "om_3", sent: true }));

    const byOpenId = await f.run([
      "send",
      "--user",
      "ou_1",
      "--content",
      "Hello",
    ]);
    expect(byOpenId.code).toBe(0);
    expect(f.calls[0]!.args).toEqual({
      receive_id: "ou_1",
      receive_id_type: "open_id",
      text: "Hello",
    });

    const byUserId = await f.run([
      "send",
      "--user-id",
      "u_1",
      "--content",
      "Hello",
    ]);
    expect(byUserId.code).toBe(0);
    expect(f.calls[1]!.args).toEqual({
      receive_id: "u_1",
      receive_id_type: "user_id",
      text: "Hello",
    });
  });

  it("replies in the message's own chat", async () => {
    const f = await fixture(() => ({ message_id: "om_4", sent: true }));

    const replied = await f.run(["reply", "om_1", "--content", "Thanks"]);

    expect(replied.code).toBe(0);
    expect(f.calls).toEqual([
      {
        slug: "FEISHU_IM_REPLY_MESSAGE",
        args: { message_id: "om_1", text: "Thanks" },
      },
    ]);
    expect(replied.result.result).toMatchObject({
      action: "sent",
      messageId: "om_4",
    });
  });

  it("ends with the confirmation card when TeamHub holds a send", async () => {
    const f = await fixture(() => ({}), true);

    const sent = await f.run(["send", "--chat", "oc_1", "--content", "Hello"]);

    expect(sent.code).toBe(0);
    expect(sent.result.result).toEqual({
      action: "confirmation_requested",
      confirmation: {
        status: "pending",
        interactionId: "interaction_1",
        messageId: "om_card",
        roomId: "room_1",
      },
    });
  });

  it("refuses a send with no target before calling TeamHub", async () => {
    const f = await fixture(() => {
      throw new Error("must not call TeamHub");
    });

    const sent = await f.run(["send", "--content", "Hello"]);

    expect(sent.code).toBe(2);
    expect(sent.error.error.code).toBe("usage");
    expect(f.calls).toEqual([]);
  });

  it("refuses a message list with no chat ID before TeamHub", async () => {
    const f = await fixture(() => {
      throw new Error("must not call TeamHub");
    });

    const listed = await f.run(["messages"]);

    expect(listed.code).toBe(2);
    expect(listed.error.error.code).toBe("usage");
    expect(f.calls).toEqual([]);
  });

  it("refuses text longer than Feishu accepts before TeamHub", async () => {
    const f = await fixture(() => {
      throw new Error("must not call TeamHub");
    });

    const sent = await f.run([
      "send",
      "--chat",
      "oc_1",
      "--content",
      "x".repeat(4097),
    ]);

    expect(sent.code).toBe(2);
    expect(sent.error.error.code).toBe("invalid_input");
    expect(f.calls).toEqual([]);
  });
});
