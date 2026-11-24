import { createJsonLogger } from "@linger/service-kit/node";
import { describe, expect, it, vi } from "vitest";

import {
  extractWeChatInboundText,
  parseWeixinApiJson,
  WeChatClawBotAdapter,
  WeChatPairingManager,
} from "../../src/channels/providers/wechat-ilink.js";

function silentLogger() {
  return createJsonLogger({ service: "test", write: () => {} });
}

describe("parseWeixinApiJson", () => {
  it("quotes uint64 message_id fields losslessly without altering string literals", () => {
    const raw =
      '{"ret":0,"msgs":[{"message_id":9007199254740993123,"item_list":[{"type":1,"text_item":{"text":"message_id: 123"}}]}]}';
    const parsed = parseWeixinApiJson<{
      msgs: {
        message_id: string;
        item_list: { text_item: { text: string } }[];
      }[];
    }>(raw);
    expect(parsed.msgs[0]!.message_id).toBe("9007199254740993123");
    expect(parsed.msgs[0]!.item_list[0]!.text_item.text).toBe(
      "message_id: 123",
    );
  });
});

describe("extractWeChatInboundText", () => {
  it("extracts text items and WeChat server-side voice transcriptions", () => {
    expect(
      extractWeChatInboundText({
        message_type: 1,
        item_list: [{ type: 1, text_item: { text: "hello" } }],
      }),
    ).toBe("hello");

    expect(
      extractWeChatInboundText({
        message_type: 1,
        item_list: [
          { type: 3, voice_item: { text: "transcribed voice note" } },
        ],
      }),
    ).toBe("transcribed voice note");

    // Ignores bot echo and group messages.
    expect(
      extractWeChatInboundText({
        message_type: 2,
        item_list: [{ type: 1, text_item: { text: "echo" } }],
      }),
    ).toBeUndefined();
    expect(
      extractWeChatInboundText({
        message_type: 1,
        group_id: "grp_1",
        item_list: [{ type: 1, text_item: { text: "group msg" } }],
      }),
    ).toBeUndefined();
  });
});

describe("WeChatPairingManager", () => {
  it("runs POST get_bot_qrcode, handles IDC redirect, verify code, and confirmation", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const responses = [
      new Response(
        JSON.stringify({
          qrcode: "qr_token_1",
          qrcode_img_content: "https://liteapp.weixin.qq.com/qr/1",
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          status: "scaned_but_redirect",
          redirect_host: "idc2.ilinkai.weixin.qq.com",
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ status: "need_verifycode" }), {
        status: 200,
      }),
      new Response(
        JSON.stringify({
          status: "confirmed",
          bot_token: "bot_tok_xyz",
          ilink_bot_id: "bot_1@im.bot",
          ilink_user_id: "user_1@im.wechat",
          baseurl: "https://idc2.ilinkai.weixin.qq.com",
        }),
        { status: 200 },
      ),
    ];

    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      return responses.shift()!;
    });

    const mgr = new WeChatPairingManager({
      fetchImpl: fetchMock,
      logger: silentLogger(),
    });
    const started = await mgr.startPairing(["old_tok"]);
    expect(started.status).toBe("waiting_scan");
    expect(started.qrCodeUrl).toBe("https://liteapp.weixin.qq.com/qr/1");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toContain("ilink/bot/get_bot_qrcode?bot_type=3");
    expect(JSON.parse(calls[0]!.body!)).toEqual({
      local_token_list: ["old_tok"],
    });

    const redirected = await mgr.pollPairing(started.pairingId);
    expect(redirected?.status).toBe("scanned");

    const needCode = await mgr.pollPairing(started.pairingId);
    expect(needCode?.status).toBe("need_verify_code");
    expect(calls[2]!.url).toContain("https://idc2.ilinkai.weixin.qq.com/");

    const confirmed = await mgr.submitVerifyCode(started.pairingId, "4829");
    expect(calls[3]!.url).toContain("verify_code=4829");
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.credentials).toEqual({
      bot_token: "bot_tok_xyz",
      base_url: "https://idc2.ilinkai.weixin.qq.com",
    });
    expect(confirmed?.config).toEqual({
      bot_id: "bot_1@im.bot",
      remote_user_id: "user_1@im.wechat",
      display_label: "WeChat",
    });
  });
});

describe("WeChatClawBotAdapter", () => {
  it("delivers inbound voice transcript, sends reply with context_token, and honors -14 cooldown", async () => {
    const controller = new AbortController();
    const inbound: { externalId: string; text: string }[] = [];
    const statuses: string[] = [];
    let sentBody: Record<string, unknown> | undefined;

    const fetchMock: typeof fetch = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.includes("notifystart") || url.includes("notifystop")) {
        return new Response(JSON.stringify({ ret: 0 }), { status: 200 });
      }
      if (url.includes("getupdates")) {
        if (inbound.length === 0) {
          return new Response(
            '{"ret":0,"get_updates_buf":"buf_2","msgs":[{"message_id":9007199254740993999,"from_user_id":"user_1@im.wechat","message_type":1,"context_token":"ctx_abc","item_list":[{"type":3,"voice_item":{"text":"check my calendar"}}]}]}',
            { status: 200 },
          );
        }
        controller.abort();
        return new Response(JSON.stringify({ ret: 0, msgs: [] }), {
          status: 200,
        });
      }
      if (url.includes("sendmessage")) {
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ret: 0, message_id: "100" }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    });

    const adapter = new WeChatClawBotAdapter({
      bindingId: "imc_1",
      botToken: "tok_1",
      remoteUserId: "user_1@im.wechat",
      logger: silentLogger(),
      fetchImpl: fetchMock,
    });

    await adapter.start({
      signal: controller.signal,
      onInbound: async (msg) => {
        inbound.push({ externalId: msg.externalId, text: msg.text });
      },
      onStatus: async (st) => {
        statuses.push(st.runtimeStatus);
      },
    });

    expect(inbound).toEqual([
      { externalId: "9007199254740993999", text: "check my calendar" },
    ]);
    expect(statuses).toContain("connected");

    const outcome = await adapter.sendText({
      text: "You have 2 meetings.",
      roomSeq: 12,
    });
    expect(outcome).toEqual({ ok: true });
    expect((sentBody?.msg as Record<string, unknown>)?.context_token).toBe(
      "ctx_abc",
    );
  });
});
