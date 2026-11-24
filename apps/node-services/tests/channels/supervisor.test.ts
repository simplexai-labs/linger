import { createJsonLogger } from "@linger/service-kit/node";
import { describe, expect, it } from "vitest";

import type {
  AdapterRunContext,
  ChannelAdapter,
  OutboundChannelMessage,
  SendOutcome,
} from "../../src/channels/adapter.js";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import type {
  ChannelsTeamHubClient,
  InternalIMChannelBinding,
  InternalIMChannelInboundRequest,
  InternalIMChannelOutboundPage,
  InternalIMChannelStatusReport,
} from "../../src/channels/teamhub-client.js";

function silentLogger() {
  return createJsonLogger({ service: "test", write: () => {} });
}

class FakeAdapter implements ChannelAdapter {
  readonly provider = "wechat" as const;
  readonly capabilities = {
    maxTextChars: 3800,
    supportsClickableLinks: false,
    supportsTyping: true,
    supportsMarkdown: false,
  };

  readonly sent: OutboundChannelMessage[] = [];
  readonly typing: boolean[] = [];
  ctx: AdapterRunContext | undefined;

  async start(ctx: AdapterRunContext): Promise<void> {
    this.ctx = ctx;
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) resolve();
      else
        ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }

  async sendText(message: OutboundChannelMessage): Promise<SendOutcome> {
    this.sent.push(message);
    return { ok: true };
  }

  async setTyping(active: boolean): Promise<void> {
    this.typing.push(active);
  }
}

describe("ChannelSupervisor", () => {
  it("reconciles bindings, routes inbound messages, and delivers Another Me replies & question cards", async () => {
    const adapter = new FakeAdapter();
    const reports: InternalIMChannelStatusReport[] = [];
    const inbounds: InternalIMChannelInboundRequest[] = [];
    let outboundPage: InternalIMChannelOutboundPage = {
      room_id: "room_1",
      another_me_actor_id: "act_am",
      human_actor_id: "act_human",
      latest_room_seq: 10,
      has_more: false,
      items: [],
    };

    const bindings: InternalIMChannelBinding[] = [
      {
        id: "imc_1",
        tenant_id: "ten_1",
        account_id: "acc_1",
        human_actor_id: "act_human",
        provider: "wechat",
        enabled: true,
        credentials: { bot_token: "tok" },
        config: { remote_user_id: "u@im.wechat" },
        adapter_state: {},
        another_me_actor_id: "act_am",
        another_me_room_id: "room_1",
        outbound_room_id: "room_1",
        outbound_room_seq: 10,
        runtime_status: "starting",
      },
    ];

    const teamHub: ChannelsTeamHubClient = {
      async listEnabledBindings() {
        return bindings;
      },
      async reportStatus(_id, report) {
        reports.push(report);
      },
      async ingestInbound(_id, req) {
        inbounds.push(req);
        return { accepted: true, kind: "message", room_id: "room_1" };
      },
      async listOutbound(_id, afterSeq) {
        return {
          ...outboundPage,
          items: outboundPage.items.filter((ev) => ev.room_seq > afterSeq),
        };
      },
    };

    const supervisor = new ChannelSupervisor({
      teamHub,
      logger: silentLogger(),
      createAdapter: () => adapter,
    });

    const count = await supervisor.reconcile();
    expect(count).toBe(1);

    // Simulate inbound user message from WeChat -> typing starts.
    await adapter.ctx!.onInbound({
      externalId: "msg_1",
      senderExternalId: "u@im.wechat",
      text: "Schedule lunch",
      receivedAtMs: Date.now(),
    });
    expect(inbounds).toHaveLength(1);
    expect(inbounds[0]!.text).toBe("Schedule lunch");
    expect(adapter.typing).toEqual([true]);

    // Simulate Another Me reply + pending question card -> delivered to WeChat.
    outboundPage = {
      room_id: "room_1",
      another_me_actor_id: "act_am",
      human_actor_id: "act_human",
      latest_room_seq: 11,
      has_more: false,
      items: [
        {
          room_seq: 11,
          event_type: "message_created",
          message_id: "m_11",
          author_actor_id: "act_am",
          author_kind: "agent",
          message_kind: "conversation",
          raw_message: "**Sure**, pick a time:",
          card: {
            kind: "question",
            status: "pending",
            title: "Lunch time",
            decision_id: "dec_1",
            version: 1,
            decision_owner: { id: "act_human" },
            question: {
              questions: [
                {
                  id: "q1",
                  prompt: "Lunch time",
                  input: "radio",
                  options: [
                    { id: "o1", label: "12:00" },
                    { id: "o2", label: "13:00" },
                  ],
                },
              ],
            },
          },
        },
      ],
    };

    supervisor.wakeRoom("room_1");
    await new Promise((r) => setTimeout(r, 30));

    expect(adapter.typing).toEqual([true, false]);
    expect(adapter.sent.map((m) => m.text)).toEqual([
      "Sure, pick a time:",
      "Lunch time\n1. 12:00\n2. 13:00\nReply with a number.",
    ]);
    expect(
      reports.some(
        (r) =>
          r.outbound_room_seq === 11 && r.pending_card?.decisionId === "dec_1",
      ),
    ).toBe(true);

    await supervisor.stop();
  });
});
