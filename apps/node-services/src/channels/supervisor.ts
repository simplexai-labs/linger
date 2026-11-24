import {
  channelIdempotencyKey,
  channelPlainText,
  channelText,
  formatPendingCard,
  formatUnsupportedCardNotice,
  isCardPlaceholderMessage,
  type DecisionCardLike,
} from "@linger/service-kit/channel-bridge";
import { sha256Hex, type JsonLogger } from "@linger/service-kit/node";

import type {
  ChannelAdapter,
  ChannelProvider,
  InboundChannelMessage,
  OutboundChannelMedia,
} from "./adapter.js";
import { WeChatClawBotAdapter } from "./providers/wechat-ilink.js";
import type {
  ChannelsTeamHubClient,
  InternalIMChannelBinding,
  InternalIMChannelOutboundEvent,
} from "./teamhub-client.js";

const RECONCILE_POLL_MS = 60_000;
const OUTBOUND_POLL_MS = 20_000;
const MAX_SEND_ATTEMPTS = 2;
const MAX_INBOUND_ATTACHMENTS = 5;
const MAX_OUTBOUND_DOCUMENT_BYTES = 50 * 1024 * 1024;

function isMarkdownFile(filename: string, mediaType?: string): boolean {
  const lowerName = filename.toLowerCase();
  const lowerType = mediaType?.toLowerCase();
  return (
    lowerType === "text/markdown" ||
    lowerType === "text/x-markdown" ||
    lowerName.endsWith(".md") ||
    lowerName.endsWith(".markdown")
  );
}

function readableDocumentFilename(
  downloadedFilename: string | undefined,
  fallbackLabel: string,
  asPlainText: boolean,
): string {
  const preferred =
    downloadedFilename && downloadedFilename.toLowerCase() !== "latest.md"
      ? downloadedFilename
      : fallbackLabel;
  const safe = (preferred.trim() || "document").replace(/[\\/:*?"<>|]/g, "_");
  if (!asPlainText) return safe;
  const stem = safe.replace(/\.(md|markdown)$/i, "");
  return stem.toLowerCase().endsWith(".txt") ? stem : `${stem}.txt`;
}

export type AdapterFactory = (
  binding: InternalIMChannelBinding,
) => ChannelAdapter | undefined;

interface ActiveRunner {
  readonly bindingId: string;
  readonly fingerprint: string;
  readonly adapter: ChannelAdapter;
  readonly controller: AbortController;
  readonly done: Promise<void>;
  roomId: string | undefined;
  anotherMeActorId: string | undefined;
  humanActorId: string;
  outboundSeq: number;
  draining: boolean;
  drainQueued: boolean;
}

export interface ChannelSupervisorOptions {
  readonly teamHub: ChannelsTeamHubClient;
  readonly logger: JsonLogger;
  readonly createAdapter?: AdapterFactory;
  readonly reconcileIntervalMs?: number;
  readonly outboundIntervalMs?: number;
}

function bindingFingerprint(binding: InternalIMChannelBinding): string {
  return sha256Hex(
    JSON.stringify({
      provider: binding.provider,
      credentials: binding.credentials,
      config: binding.config,
    }),
  );
}

function defaultAdapterFactory(logger: JsonLogger): AdapterFactory {
  return (binding: InternalIMChannelBinding): ChannelAdapter | undefined => {
    if (binding.provider === "wechat") {
      const botToken =
        typeof binding.credentials.bot_token === "string"
          ? binding.credentials.bot_token.trim()
          : "";
      if (!botToken) return undefined;
      const baseUrl =
        typeof binding.credentials.base_url === "string"
          ? binding.credentials.base_url.trim()
          : undefined;
      const remoteUserId =
        typeof binding.config.remote_user_id === "string"
          ? binding.config.remote_user_id.trim()
          : undefined;
      const cooldownMs = binding.cooldown_until
        ? Date.parse(binding.cooldown_until)
        : 0;
      return new WeChatClawBotAdapter({
        bindingId: binding.id,
        botToken,
        ...(baseUrl ? { baseUrl } : {}),
        ...(remoteUserId ? { remoteUserId } : {}),
        initialState: binding.adapter_state,
        ...(Number.isFinite(cooldownMs) && cooldownMs > Date.now()
          ? { initialCooldownUntilMs: cooldownMs }
          : {}),
        logger,
      });
    }
    return undefined;
  };
}

/**
 * Supervises one active protocol adapter per enabled IM channel binding.
 * Reconciles bindings from TeamHub, ingests inbound messages, and drains
 * Another Me direct-chat outbound events without storing local state on disk.
 */
export class ChannelSupervisor {
  readonly #teamHub: ChannelsTeamHubClient;
  readonly #logger: JsonLogger;
  readonly #createAdapter: AdapterFactory;
  readonly #reconcileIntervalMs: number;
  readonly #outboundIntervalMs: number;
  readonly #runners = new Map<string, ActiveRunner>();

  #reconcileInFlight: Promise<number> | undefined;
  #reconcileTimer: ReturnType<typeof setInterval> | undefined;
  #outboundTimer: ReturnType<typeof setInterval> | undefined;
  #stopped = false;

  constructor(options: ChannelSupervisorOptions) {
    this.#teamHub = options.teamHub;
    this.#logger = options.logger;
    this.#createAdapter =
      options.createAdapter ?? defaultAdapterFactory(options.logger);
    this.#reconcileIntervalMs =
      options.reconcileIntervalMs ?? RECONCILE_POLL_MS;
    this.#outboundIntervalMs = options.outboundIntervalMs ?? OUTBOUND_POLL_MS;
  }

  startBackgroundLoops(): void {
    if (this.#stopped) return;
    void this.reconcile();
    this.#reconcileTimer = setInterval(() => {
      void this.reconcile();
    }, this.#reconcileIntervalMs);
    this.#reconcileTimer.unref();

    this.#outboundTimer = setInterval(() => {
      for (const runner of this.#runners.values()) {
        void this.#drainOutbound(runner);
      }
    }, this.#outboundIntervalMs);
    this.#outboundTimer.unref();
  }

  activeCount(): number {
    return this.#runners.size;
  }

  async reconcile(): Promise<number> {
    if (this.#stopped) return 0;
    if (this.#reconcileInFlight) return this.#reconcileInFlight;
    const run = this.#reconcileOnce().finally(() => {
      this.#reconcileInFlight = undefined;
    });
    this.#reconcileInFlight = run;
    return run;
  }

  wakeRoom(roomId: string): void {
    if (this.#stopped) return;
    for (const runner of this.#runners.values()) {
      if (!runner.roomId || runner.roomId === roomId) {
        void this.#drainOutbound(runner);
      }
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#reconcileTimer) {
      clearInterval(this.#reconcileTimer);
      this.#reconcileTimer = undefined;
    }
    if (this.#outboundTimer) {
      clearInterval(this.#outboundTimer);
      this.#outboundTimer = undefined;
    }
    const runners = [...this.#runners.values()];
    this.#runners.clear();
    for (const runner of runners) {
      runner.controller.abort();
    }
    await Promise.allSettled(runners.map((runner) => runner.done));
  }

  async #reconcileOnce(): Promise<number> {
    const bindings = await this.#teamHub.listEnabledBindings();
    if (!bindings) return this.#runners.size;
    if (this.#stopped) return 0;

    const wanted = new Map<string, InternalIMChannelBinding>();
    for (const binding of bindings) {
      if (binding.enabled) {
        wanted.set(binding.id, binding);
      }
    }

    // Stop runners whose binding disappeared or changed credentials.
    const toStop: ActiveRunner[] = [];
    for (const [id, runner] of this.#runners) {
      const next = wanted.get(id);
      if (!next || bindingFingerprint(next) !== runner.fingerprint) {
        this.#runners.delete(id);
        runner.controller.abort();
        toStop.push(runner);
      } else {
        runner.roomId = next.another_me_room_id || next.outbound_room_id;
        runner.anotherMeActorId = next.another_me_actor_id;
        runner.humanActorId = next.human_actor_id;
        if (next.outbound_room_seq > runner.outboundSeq) {
          runner.outboundSeq = next.outbound_room_seq;
        }
      }
    }
    if (toStop.length > 0) {
      await Promise.allSettled(toStop.map((runner) => runner.done));
    }
    if (this.#stopped) return 0;

    // Start new runners for newly enabled bindings.
    for (const binding of wanted.values()) {
      if (this.#runners.has(binding.id)) continue;
      const adapter = this.#createAdapter(binding);
      if (!adapter) {
        this.#logger.log("warn", "channels.adapter_unavailable", {
          binding_id: binding.id,
          provider: binding.provider,
        });
        continue;
      }
      this.#startRunner(binding, adapter);
    }
    return this.#runners.size;
  }

  #startRunner(
    binding: InternalIMChannelBinding,
    adapter: ChannelAdapter,
  ): void {
    const controller = new AbortController();
    const runner: ActiveRunner = {
      bindingId: binding.id,
      fingerprint: bindingFingerprint(binding),
      adapter,
      controller,
      done: Promise.resolve(),
      roomId: binding.another_me_room_id || binding.outbound_room_id,
      anotherMeActorId: binding.another_me_actor_id,
      humanActorId: binding.human_actor_id,
      outboundSeq: binding.outbound_room_seq,
      draining: false,
      drainQueued: false,
    };

    const done = adapter
      .start({
        signal: controller.signal,
        onInbound: async (msg) => {
          await this.#handleInbound(runner, msg);
        },
        onStatus: async (update) => {
          await this.#teamHub.reportStatus(runner.bindingId, {
            runtime_status: update.runtimeStatus,
            ...(update.errorCode === null
              ? { clear_error_code: true }
              : update.errorCode !== undefined
                ? { runtime_error_code: update.errorCode }
                : {}),
            ...(update.cooldownUntil === null
              ? { clear_cooldown: true }
              : update.cooldownUntil !== undefined
                ? { cooldown_until: update.cooldownUntil }
                : {}),
            ...(update.adapterStatePatch
              ? { adapter_state_patch: update.adapterStatePatch }
              : {}),
          });
        },
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          this.#logger.log("error", "channels.adapter_crashed", {
            binding_id: binding.id,
            provider: binding.provider,
            error: String(err),
          });
        }
      });

    (runner as { done: Promise<void> }).done = done;
    this.#runners.set(binding.id, runner);
    void this.#drainOutbound(runner);
  }

  async #handleInbound(
    runner: ActiveRunner,
    msg: InboundChannelMessage,
  ): Promise<void> {
    const attachmentUploadIds: string[] = [];
    if (
      msg.attachments &&
      msg.attachments.length > 0 &&
      this.#teamHub.uploadAttachment
    ) {
      const limit = Math.min(msg.attachments.length, MAX_INBOUND_ATTACHMENTS);
      for (let index = 0; index < limit; index += 1) {
        const attachment = msg.attachments[index]!;
        const uploadId = await this.#teamHub.uploadAttachment(
          runner.bindingId,
          {
            idempotencyKey: channelIdempotencyKey(
              `${runner.adapter.provider}-att`,
              `${msg.externalId}:${String(index)}`,
            ),
            filename: attachment.filename,
            ...(attachment.mediaType
              ? { mediaType: attachment.mediaType }
              : {}),
            bytes: attachment.bytes,
          },
        );
        if (uploadId) attachmentUploadIds.push(uploadId);
      }
    }
    if (!msg.text.trim() && attachmentUploadIds.length === 0) return;

    const response = await this.#teamHub.ingestInbound(runner.bindingId, {
      external_id: msg.externalId,
      sender_external_id: msg.senderExternalId,
      ...(msg.text ? { text: msg.text } : {}),
      ...(attachmentUploadIds.length > 0
        ? { attachment_upload_ids: attachmentUploadIds }
        : {}),
      ...(msg.adapterStatePatch
        ? { adapter_state_patch: msg.adapterStatePatch }
        : {}),
    });
    if (!response) return;
    if (response.room_id) {
      runner.roomId = response.room_id;
    }
    if (response.kind === "no_another_me") {
      await this.#teamHub.reportStatus(runner.bindingId, {
        runtime_error_code: "NO_ANOTHER_ME",
      });
      return;
    }
    if (response.kind === "question_step") {
      if (response.next_prompt) {
        for (const chunk of channelText(
          response.next_prompt,
          runner.adapter.capabilities.maxTextChars,
        )) {
          await this.#sendWithRetry(runner, chunk, runner.outboundSeq);
        }
      }
      return;
    }
    if (response.kind === "decision_conflict") {
      await runner.adapter.sendText({
        text: "That prompt was already answered or changed in Linger.",
        roomSeq: runner.outboundSeq,
      });
      return;
    }
    if (response.kind === "decision_rejected") {
      await runner.adapter.sendText({
        text: "Please open Linger to complete this prompt.",
        roomSeq: runner.outboundSeq,
      });
      return;
    }
    if (runner.adapter.capabilities.supportsTyping) {
      await runner.adapter.setTyping?.(true);
    }
  }

  async #drainOutbound(runner: ActiveRunner): Promise<void> {
    if (this.#stopped || runner.controller.signal.aborted) return;
    if (runner.draining) {
      runner.drainQueued = true;
      return;
    }
    runner.draining = true;
    try {
      do {
        runner.drainQueued = false;
        let hasMore = true;
        while (hasMore && !this.#stopped && !runner.controller.signal.aborted) {
          const page = await this.#teamHub.listOutbound(
            runner.bindingId,
            runner.outboundSeq,
            50,
          );
          if (!page) break;
          runner.roomId = page.room_id;
          runner.anotherMeActorId = page.another_me_actor_id;
          runner.humanActorId = page.human_actor_id;

          if (page.items.length === 0) {
            if (page.latest_room_seq > runner.outboundSeq) {
              runner.outboundSeq = page.latest_room_seq;
              await this.#teamHub.reportStatus(runner.bindingId, {
                outbound_room_id: page.room_id,
                outbound_room_seq: runner.outboundSeq,
              });
            }
            break;
          }

          let blocked = false;
          for (const event of page.items) {
            const ok = await this.#deliverEvent(runner, event);
            if (!ok) {
              blocked = true;
              break;
            }
          }
          if (blocked) break;
          hasMore = page.has_more;
        }
      } while (runner.drainQueued && !this.#stopped);
    } finally {
      runner.draining = false;
    }
  }

  async #deliverEvent(
    runner: ActiveRunner,
    event: InternalIMChannelOutboundEvent,
  ): Promise<boolean> {
    if (event.room_seq <= runner.outboundSeq) return true;

    if (event.event_type === "card_changed") {
      runner.outboundSeq = event.room_seq;
      const status =
        typeof event.card?.status === "string" ? event.card.status : undefined;
      await this.#teamHub.reportStatus(runner.bindingId, {
        outbound_room_id: runner.roomId,
        outbound_room_seq: runner.outboundSeq,
        ...(status && status !== "pending" ? { clear_pending_card: true } : {}),
      });
      return true;
    }

    const isAnotherMe =
      event.author_actor_id === runner.anotherMeActorId &&
      event.message_kind === "conversation";
    if (!isAnotherMe) {
      runner.outboundSeq = event.room_seq;
      await this.#teamHub.reportStatus(runner.bindingId, {
        outbound_room_id: runner.roomId,
        outbound_room_seq: runner.outboundSeq,
      });
      return true;
    }

    const caps = runner.adapter.capabilities;
    const chunks: string[] = [];
    let nextPendingCard: Record<string, unknown> | undefined;
    let clearPendingCard = true;
    const card = event.card as DecisionCardLike | undefined;

    if (
      event.raw_message?.trim() &&
      !(card && isCardPlaceholderMessage(event.raw_message, card))
    ) {
      chunks.push(
        ...channelText(event.raw_message, caps.maxTextChars, {
          includeLinkUrls: caps.supportsClickableLinks,
        }),
      );
    }

    if (card) {
      const formatted = formatPendingCard(card, runner.humanActorId);
      if (formatted) {
        chunks.push(...channelText(formatted.text, caps.maxTextChars));
        nextPendingCard = formatted.state as unknown as Record<string, unknown>;
        clearPendingCard = false;
      } else {
        const notice = formatUnsupportedCardNotice(card, undefined);
        if (notice) {
          chunks.push(...channelText(notice, caps.maxTextChars));
        }
      }
    }

    const documents = event.documents ?? [];
    if (
      chunks.length === 0 &&
      documents.length === 0 &&
      event.has_html_fragment
    ) {
      chunks.push("Interactive content is available in Linger.");
    }

    if (chunks.length === 0 && documents.length === 0) {
      runner.outboundSeq = event.room_seq;
      await this.#teamHub.reportStatus(runner.bindingId, {
        outbound_room_id: runner.roomId,
        outbound_room_seq: runner.outboundSeq,
      });
      return true;
    }

    // Advance watermark at-most-once so restarts never replay messages to IM.
    runner.outboundSeq = event.room_seq;
    await this.#teamHub.reportStatus(runner.bindingId, {
      outbound_room_id: runner.roomId,
      outbound_room_seq: runner.outboundSeq,
      ...(nextPendingCard
        ? { pending_card: nextPendingCard }
        : clearPendingCard
          ? { clear_pending_card: true }
          : {}),
    });

    if (caps.supportsTyping) {
      await runner.adapter.setTyping?.(false);
    }

    for (const chunk of chunks) {
      const outcome = await this.#sendWithRetry(runner, chunk, event.room_seq);
      if (!outcome.ok) {
        await this.#teamHub.reportStatus(runner.bindingId, {
          ...(outcome.runtimeStatus
            ? { runtime_status: outcome.runtimeStatus }
            : {}),
          runtime_error_code: outcome.errorCode,
          ...(outcome.cooldownSec
            ? {
                cooldown_until: new Date(
                  Date.now() + outcome.cooldownSec * 1000,
                ).toISOString(),
              }
            : {}),
        });
        return false;
      }
    }

    for (const doc of documents) {
      const delivered = await this.#deliverDocument(
        runner,
        doc.document_id,
        doc.filename,
        doc.media_type,
        event.room_seq,
      );
      if (!delivered) {
        await this.#sendWithRetry(
          runner,
          `Open Linger to view document: ${doc.filename}`,
          event.room_seq,
        );
      }
    }

    await this.#teamHub.reportStatus(runner.bindingId, {
      touch_outbound: true,
    });
    return true;
  }

  async #deliverDocument(
    runner: ActiveRunner,
    documentId: string,
    fallbackName: string,
    fallbackMediaType: string | undefined,
    roomSeq: number,
  ): Promise<boolean> {
    if (!this.#teamHub.downloadDocument || !runner.adapter.sendMedia) {
      return false;
    }
    const downloaded = await this.#teamHub.downloadDocument(
      runner.bindingId,
      documentId,
      MAX_OUTBOUND_DOCUMENT_BYTES,
    );
    if (!downloaded) {
      this.#logger.log("warn", "channels.outbound_document_download_failed", {
        binding_id: runner.bindingId,
        document_id: documentId,
      });
      return false;
    }

    const rawName = downloaded.filename || fallbackName;
    const rawMediaType = downloaded.mediaType || fallbackMediaType;
    let payloadBytes = downloaded.bytes;
    let filename: string;
    let mediaType: string | undefined;

    if (isMarkdownFile(rawName, rawMediaType)) {
      const plain = channelPlainText(
        new TextDecoder("utf-8").decode(downloaded.bytes),
        { includeLinkUrls: runner.adapter.capabilities.supportsClickableLinks },
      );
      payloadBytes = new TextEncoder().encode(plain);
      filename = readableDocumentFilename(
        downloaded.filename,
        fallbackName,
        true,
      );
      mediaType = "text/plain";
    } else {
      filename = readableDocumentFilename(
        downloaded.filename,
        fallbackName,
        false,
      );
      mediaType = rawMediaType;
    }

    const outcome = await this.#sendMediaWithRetry(runner, {
      filename,
      ...(mediaType ? { mediaType } : {}),
      bytes: payloadBytes,
      roomSeq,
    });
    if (!outcome.ok) {
      this.#logger.log("warn", "channels.outbound_document_send_failed", {
        binding_id: runner.bindingId,
        document_id: documentId,
        error_code: outcome.errorCode,
      });
      return false;
    }
    return true;
  }

  async #sendWithRetry(runner: ActiveRunner, text: string, roomSeq: number) {
    let last = await runner.adapter.sendText({ text, roomSeq });
    for (
      let attempt = 1;
      attempt < MAX_SEND_ATTEMPTS && !last.ok && last.retryable;
      attempt += 1
    ) {
      last = await runner.adapter.sendText({ text, roomSeq });
    }
    return last;
  }

  async #sendMediaWithRetry(runner: ActiveRunner, media: OutboundChannelMedia) {
    if (!runner.adapter.sendMedia) {
      return {
        ok: false as const,
        retryable: false,
        errorCode: "MEDIA_UNSUPPORTED",
      };
    }
    let last = await runner.adapter.sendMedia(media);
    for (
      let attempt = 1;
      attempt < MAX_SEND_ATTEMPTS && !last.ok && last.retryable;
      attempt += 1
    ) {
      last = await runner.adapter.sendMedia(media);
    }
    return last;
  }
}

export function isSupportedChannelProvider(
  provider: string,
): provider is ChannelProvider {
  return provider === "wechat";
}
