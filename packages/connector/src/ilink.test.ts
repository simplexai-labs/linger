import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { ILinkConnector, ILINK_CAPABILITIES, type Transport } from "./ilink.js";

/**
 * A transport that answers from a script and records what it was asked.
 *
 * `putAnswers` are consumed by media uploads, so a test can drive the CDN leg
 * separately from the JSON legs.
 */
function scripted(
  answers: { status?: number; text: string }[],
  putAnswers: { status?: number; downloadParam?: string }[] = [],
): Transport & { calls: { path: string; body: unknown }[] } {
  const calls: { path: string; body: unknown }[] = [];
  return {
    calls,
    async post(path, body) {
      calls.push({ path, body });
      const answer = answers.shift() ?? { status: 200, text: "{}" };
      return {
        status: answer.status ?? 200,
        text: answer.text,
        header: () => null,
        errorMessage: null,
      };
    },
    async put() {
      const answer = putAnswers.shift() ?? { status: 200 };
      const downloadParam = answer.downloadParam ?? "download-param";
      return {
        status: answer.status ?? 200,
        text: "",
        header: (name: string) =>
          name === "x-encrypted-param" ? downloadParam : null,
        errorMessage: null,
      };
    },
  };
}

const connector = (transport: Transport) =>
  new ILinkConnector({
    credentials: { token: "test-token" },
    transport,
    now: () => 0,
  });

describe("ILinkConnector capabilities", () => {
  it("declares Markdown, because the client renders it", () => {
    expect(ILINK_CAPABILITIES.markdown).toBe(true);
  });

  it("declares no group support, because a bot identity receives no group events", () => {
    expect(ILINK_CAPABILITIES.groups).toBe(false);
  });

  it("declares the real text limit, so a sender splits before the surface truncates", () => {
    expect(ILINK_CAPABILITIES.maxTextLength).toBe(2000);
  });
});

describe("ILinkConnector polling", () => {
  it("turns one update into one human-attributed message with its reply token", async () => {
    const transport = scripted([
      {
        text: JSON.stringify({
          ret: 0,
          cursor: 7,
          updates: [
            {
              message_id: 9001,
              from_user_id: "peer@im.wechat",
              create_time_ms: 1_700_000_000_000,
              context_token: "token-abc",
              item_list: [
                { type: 1, text_item: { text: "how are the positions" } },
              ],
            },
          ],
        }),
      },
    ]);
    const events = await connector(transport).poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      kind: "message",
      message: {
        externalId: "9001",
        peerId: "peer@im.wechat",
        conversationId: "",
        text: "how are the positions",
        sentAt: 1_700_000_000_000,
        replyToken: "token-abc",
      },
    });
  });

  it("carries the cursor forward, so the next poll does not replay the window", async () => {
    const transport = scripted([
      { text: JSON.stringify({ ret: 0, cursor: 7, updates: [] }) },
      { text: JSON.stringify({ ret: 0, cursor: 9, updates: [] }) },
    ]);
    const client = connector(transport);
    await client.poll();
    await client.poll();
    expect(transport.calls[0]?.body).toMatchObject({ cursor: 0 });
    expect(transport.calls[1]?.body).toMatchObject({ cursor: 7 });
  });

  it("returns nothing for a transport error rather than throwing into the host loop", async () => {
    const transport = scripted([{ status: 502, text: "bad gateway" }]);
    await expect(connector(transport).poll()).resolves.toEqual([]);
  });

  it("returns nothing for an unparseable body", async () => {
    const transport = scripted([{ text: "<html>not json</html>" }]);
    await expect(connector(transport).poll()).resolves.toEqual([]);
  });

  it("drops an update with no text instead of inventing an empty message", async () => {
    const transport = scripted([
      {
        text: JSON.stringify({
          ret: 0,
          updates: [{ message_id: 1, from_user_id: "p" }],
        }),
      },
    ]);
    await expect(connector(transport).poll()).resolves.toEqual([]);
  });
});

describe("ILinkConnector sending", () => {
  it("reports delivery with the surface's message id", async () => {
    const transport = scripted([
      { text: JSON.stringify({ ret: 0, message_id: 4242 }) },
    ]);
    const result = await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "text", text: "acknowledged" },
      replyToken: "token-abc",
    });
    expect(result).toEqual({ delivered: true, externalId: "4242" });
  });

  it("sends the reply token, so the surface keeps the conversation in one thread", async () => {
    const transport = scripted([{ text: JSON.stringify({ ret: 0 }) }]);
    await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "text", text: "x" },
      replyToken: "token-abc",
    });
    expect(transport.calls[0]?.body).toMatchObject({
      msg: { context_token: "token-abc" },
    });
  });

  it("classifies ret -2 as a stale session, not as a rate limit to retry", async () => {
    // This is the finding that matters: retrying never reopens the window.
    const transport = scripted([
      { text: JSON.stringify({ ret: -2, errmsg: "prepare failed" }) },
    ]);
    const result = await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "text", text: "x" },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("session-stale");
  });

  it("classifies errcode -14 as a dead token, which no retry can fix", async () => {
    const transport = scripted([{ text: JSON.stringify({ errcode: -14 }) }]);
    const result = await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "text", text: "x" },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("blocked");
  });

  it("refuses text above the surface limit instead of letting it truncate", async () => {
    const transport = scripted([]);
    const result = await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "text", text: "x".repeat(2001) },
    });
    expect(result).toEqual({
      delivered: false,
      reason: "too-large",
      detail: "2001 characters",
    });
    expect(transport.calls).toHaveLength(0);
  });

  it("treats a non-200 as an unknown failure, never as delivered", async () => {
    const transport = scripted([{ status: 500, text: "" }]);
    const result = await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "text", text: "x" },
    });
    expect(result.delivered).toBe(false);
    expect(result.reason).toBe("unknown");
  });
});

describe("ILinkConnector media", () => {
  /** A real file, because the upload leg reads bytes rather than a shape. */
  async function withFile<T>(
    name: string,
    run: (file: string) => Promise<T>,
  ): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "connector-"));
    const file = path.join(dir, name);
    await writeFile(file, "bytes");
    try {
      return await run(file);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  it("reserves an upload, ships the bytes, then sends an item that refers to them", async () => {
    // All three legs are the point: the bytes landing on the CDN without the
    // final send looks like success and shows the person nothing.
    await withFile("chart.png", async (file) => {
      const transport = scripted(
        [
          {
            text: JSON.stringify({
              upload_full_url: "https://cdn.example/put?sig=1",
            }),
          },
          { text: JSON.stringify({ ret: 0, message_id: 77 }) },
        ],
        [{ downloadParam: "enc-param-1" }],
      );
      const result = await connector(transport).send({
        peerId: "peer@im.wechat",
        item: { kind: "image", path: file },
      });
      expect(result).toEqual({ delivered: true, externalId: "77" });
      expect(transport.calls.map((call) => call.path)).toEqual([
        "/ilink/bot/getuploadurl",
        "/ilink/bot/sendmessage",
      ]);
      expect(transport.calls[1]?.body).toMatchObject({
        msg: {
          item_list: [
            {
              type: 2,
              image_item: {
                media: { encrypt_query_param: "enc-param-1", encrypt_type: 1 },
              },
            },
          ],
        },
      });
    });
  });

  it("labels a non-image as a file item carrying its own name", async () => {
    await withFile("statement.pdf", async (file) => {
      const transport = scripted(
        [
          { text: JSON.stringify({ upload_param: "param-2" }) },
          { text: JSON.stringify({ ret: 0 }) },
        ],
        [{ downloadParam: "enc-param-2" }],
      );
      await connector(transport).send({
        peerId: "peer@im.wechat",
        item: { kind: "file", path: file },
      });
      const mediaType = (transport.calls[0]?.body as { media_type?: number })
        .media_type;
      expect(mediaType).toBe(3);
      expect(transport.calls[1]?.body).toMatchObject({
        msg: {
          item_list: [
            {
              type: 4,
              file_item: { file_name: "statement.pdf", len: "5" },
            },
          ],
        },
      });
    });
  });

  it("reports a failed upload instead of sending an item with no target", async () => {
    await withFile("chart.png", async (file) => {
      const transport = scripted(
        [{ text: JSON.stringify({}) }],
        [{ status: 403 }],
      );
      const result = await connector(transport).send({
        peerId: "peer@im.wechat",
        item: { kind: "image", path: file },
      });
      expect(result.delivered).toBe(false);
      // Only the reserve leg ran; nothing claimed to be delivered.
      expect(transport.calls).toHaveLength(1);
    });
  });

  it("reports a missing local file rather than throwing into the host loop", async () => {
    const transport = scripted([]);
    const result = await connector(transport).send({
      peerId: "peer@im.wechat",
      item: { kind: "image", path: "/nonexistent/chart.png" },
    });
    expect(result.delivered).toBe(false);
    expect(transport.calls).toHaveLength(0);
  });

  it("refuses to send with no peer, because the surface has no ambient recipient", async () => {
    const result = await connector(scripted([])).send({
      peerId: "",
      item: { kind: "text", text: "x" },
    });
    expect(result.delivered).toBe(false);
  });
});

describe("ILinkConnector authentication", () => {
  it("refuses an empty token at authenticate, before a send wastes a window", async () => {
    const client = new ILinkConnector({
      credentials: { token: "" },
      transport: scripted([]),
      now: () => 0,
    });
    await expect(client.authenticate()).rejects.toThrow("token is empty");
  });
});
