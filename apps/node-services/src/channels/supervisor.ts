import {
  channelText,
  formatQuestionCard,
  type DecisionCardLike,
} from "@linger/service-kit/channel-bridge";
import { sha256Hex, type JsonLogger } from "@linger/service-kit/node";

import type {
  ChannelAdapter,
  ChannelProvider,
  InboundChannelMessage,
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
    const response = await this.#teamHub.ingestInbound(runner.bindingId, {
      external_id: msg.externalId,
      sender_external_id: msg.senderExternalId,
      text: msg.text,
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
    if (response.kind === "decision_conflict") {
      await runner.adapter.sendText({
        text: "That question was already answered or changed in Linger.",
        roomSeq: runner.outboundSeq,
      });
      return;
    }
    if (response.kind === "decision_rejected") {
      await runner.adapter.sendText({
        text: "Please open Linger to answer this prompt.",
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

    if (event.raw_message?.trim()) {
      chunks.push(
        ...channelText(event.raw_message, caps.maxTextChars, {
          includeLinkUrls: caps.supportsClickableLinks,
        }),
      );
    }

    if (event.card) {
      const card = event.card as DecisionCardLike;
      const question = formatQuestionCard(card, runner.humanActorId);
      if (question) {
        chunks.push(...channelText(question.text, caps.maxTextChars));
        nextPendingCard = {
          decisionId: question.decisionId,
          version: question.version,
          questionId: question.questionId,
          input: question.input,
          optionIds: [...question.optionIds],
        };
        clearPendingCard = false;
      } else if (card.status === "pending" && card.title) {
        chunks.push(`Open Linger to review: ${card.title}`);
      }
    }

    if (chunks.length === 0) {
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

    await this.#teamHub.reportStatus(runner.bindingId, {
      touch_outbound: true,
    });
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
}

export function isSupportedChannelProvider(
  provider: string,
): provider is ChannelProvider {
  return provider === "wechat";
}
