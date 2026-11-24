import { createJsonLogger } from "@linger/service-kit/node";
import { describe, expect, it } from "vitest";

import type {
  AdapterRunContext,
  ChannelAdapter,
  OutboundChannelMedia,
  OutboundChannelMessage,
  SendOutcome,
} from "../../src/channels/adapter.js";
import { ChannelSupervisor } from "../../src/channels/supervisor.js";
import type {
  ChannelAttachmentUploadInput,
  ChannelsTeamHubClient,
  DownloadedChannelDocument,
  InternalIMChannelBinding,
  InternalIMChannelInboundRequest,
  InternalIMChannelInboundResponse,
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
  readonly sentMedia: OutboundChannelMedia[] = [];
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

  async sendMedia(media: OutboundChannelMedia): Promise<SendOutcome> {
    this.sentMedia.push(media);
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
      "Lunch time\n1. 12:00\n2. 13:00\nReply with a number, or type your own answer.",
    ]);
    expect(
      reports.some(
        (r) =>
          r.outbound_room_seq === 11 &&
          r.pending_card?.kind === "question" &&
          r.pending_card?.decisionId === "dec_1",
      ),
    ).toBe(true);

    await supervisor.stop();
  });

  it("handles multi-question progression, approval cards, inbound attachments, and outbound documents", async () => {
    const adapter = new FakeAdapter();
    const reports: InternalIMChannelStatusReport[] = [];
    const inbounds: InternalIMChannelInboundRequest[] = [];
    const uploads: ChannelAttachmentUploadInput[] = [];
    const docs = new Map<string, DownloadedChannelDocument>([
      [
        "doc_md",
        {
          filename: "latest.md",
          mediaType: "text/markdown",
          bytes: new TextEncoder().encode("# Trip Plan\n\n- **Boat** tour"),
        },
      ],
      [
        "doc_pptx",
        {
          filename: "slides.pptx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          bytes: new Uint8Array([80, 75, 3, 4]),
        },
      ],
    ]);

    let nextInboundResp: InternalIMChannelInboundResponse = {
      accepted: true,
      kind: "message",
      room_id: "room_1",
    };
    let outboundPage: InternalIMChannelOutboundPage = {
      room_id: "room_1",
      another_me_actor_id: "act_am",
      human_actor_id: "act_human",
      latest_room_seq: 20,
      has_more: false,
      items: [],
    };

    const teamHub: ChannelsTeamHubClient = {
      async listEnabledBindings() {
        return [
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
            outbound_room_seq: 20,
            runtime_status: "connected",
          },
        ];
      },
      async reportStatus(_id, report) {
        reports.push(report);
      },
      async ingestInbound(_id, req) {
        inbounds.push(req);
        return nextInboundResp;
      },
      async listOutbound(_id, afterSeq) {
        return {
          ...outboundPage,
          items: outboundPage.items.filter((ev) => ev.room_seq > afterSeq),
        };
      },
      async uploadAttachment(_id, input) {
        uploads.push(input);
        return `upl_${String(uploads.length)}`;
      },
      async downloadDocument(_id, docId) {
        return docs.get(docId);
      },
    };

    const supervisor = new ChannelSupervisor({
      teamHub,
      logger: silentLogger(),
      createAdapter: () => adapter,
    });
    await supervisor.reconcile();

    // 1. Multi-question card suppresses redundant @human placeholder line.
    outboundPage = {
      room_id: "room_1",
      another_me_actor_id: "act_am",
      human_actor_id: "act_human",
      latest_room_seq: 21,
      has_more: false,
      items: [
        {
          room_seq: 21,
          event_type: "message_created",
          message_id: "m_21",
          author_actor_id: "act_am",
          author_kind: "agent",
          message_kind: "conversation",
          raw_message: "@alice Deck setup",
          card: {
            kind: "question",
            status: "pending",
            title: "Deck setup",
            decision_id: "dec_multi",
            version: 1,
            decision_owner: { id: "act_human" },
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
                  prompt: "Style?",
                  input: "radio",
                  options: [
                    { id: "s1", label: "Minimal" },
                    { id: "s2", label: "Warm" },
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

    expect(adapter.sent.map((m) => m.text)).toEqual([
      "Deck setup (1/2)\nAudience?\n1. Friends\n2. Team\nReply with a number, or type your own answer.",
    ]);

    // 2. Answering step 1 returns question_step and sends next_prompt immediately.
    nextInboundResp = {
      accepted: true,
      kind: "question_step",
      room_id: "room_1",
      next_prompt:
        "Deck setup (2/2)\nStyle?\n1. Minimal\n2. Warm\nReply with a number, or type your own answer.",
    };
    await adapter.ctx!.onInbound({
      externalId: "msg_step1",
      senderExternalId: "u@im.wechat",
      text: "1",
      receivedAtMs: Date.now(),
    });
    expect(adapter.sent[adapter.sent.length - 1]!.text).toContain(
      "Deck setup (2/2)",
    );

    // 3. Inbound photo attachment is uploaded and forwarded with attachment_upload_ids.
    nextInboundResp = { accepted: true, kind: "message", room_id: "room_1" };
    await adapter.ctx!.onInbound({
      externalId: "msg_photo",
      senderExternalId: "u@im.wechat",
      text: "",
      attachments: [
        {
          filename: "photo.jpg",
          mediaType: "image/jpeg",
          bytes: new Uint8Array([0xff, 0xd8, 0xff]),
        },
      ],
      receivedAtMs: Date.now(),
    });
    expect(uploads).toHaveLength(1);
    expect(inbounds[inbounds.length - 1]!.attachment_upload_ids).toEqual([
      "upl_1",
    ]);

    // 4. Outbound documents (Markdown -> .txt, PPTX -> original binary) + approval card.
    outboundPage = {
      room_id: "room_1",
      another_me_actor_id: "act_am",
      human_actor_id: "act_human",
      latest_room_seq: 23,
      has_more: false,
      items: [
        {
          room_seq: 22,
          event_type: "message_created",
          message_id: "m_22",
          author_actor_id: "act_am",
          author_kind: "agent",
          message_kind: "conversation",
          raw_message: "Here are your files.",
          documents: [
            {
              document_id: "doc_md",
              filename: "Trip Plan",
              media_type: "text/markdown",
            },
            {
              document_id: "doc_pptx",
              filename: "slides.pptx",
              media_type:
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            },
          ],
        },
        {
          room_seq: 23,
          event_type: "message_created",
          message_id: "m_23",
          author_actor_id: "act_am",
          author_kind: "agent",
          message_kind: "conversation",
          raw_message: "@alice Send invite",
          card: {
            kind: "connector_write",
            status: "pending",
            title: "Send invite",
            decision_id: "dec_appr",
            version: 1,
            decision_owner: { id: "act_human" },
            connector_write: { summary: "Create calendar event for Friday" },
          },
        },
      ],
    };
    supervisor.wakeRoom("room_1");
    await new Promise((r) => setTimeout(r, 30));

    expect(adapter.sentMedia).toHaveLength(2);
    expect(adapter.sentMedia[0]!.filename).toBe("Trip Plan.txt");
    expect(adapter.sentMedia[0]!.mediaType).toBe("text/plain");
    expect(new TextDecoder().decode(adapter.sentMedia[0]!.bytes)).toBe(
      "Trip Plan\n\n- Boat tour",
    );
    expect(adapter.sentMedia[1]!.filename).toBe("slides.pptx");
    expect(Array.from(adapter.sentMedia[1]!.bytes)).toEqual([80, 75, 3, 4]);

    expect(adapter.sent[adapter.sent.length - 1]!.text).toContain(
      "Reply 1 to approve or 2 to deny.",
    );
    expect(
      reports.some(
        (r) =>
          r.outbound_room_seq === 23 &&
          r.pending_card?.kind === "approval" &&
          r.pending_card?.decisionId === "dec_appr",
      ),
    ).toBe(true);

    await supervisor.stop();
  });
});
