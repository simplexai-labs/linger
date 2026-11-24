import { defineFeature, type FeatureDeclaration } from "../contracts.js";
import { encodeExecutionContextRef } from "../../executor/context-ref.js";
import {
  awaitedReplyInboxIds,
  awaitsReply,
} from "../../executor/reply-delivery.js";
import type { AgentLogger } from "../../observability/agent-log.js";

export const ROOM_REPLY_GUARD_FEATURE_ID = "room-reply-guard";

const DEFAULT_REPLY_CHECK_TIMEOUT_MS = 5_000;

export const ROOM_REPLY_REMINDER =
  "You have not sent a visible reply to the Room yet for this turn. Room participants cannot see your final assistant text; only messages sent through the `teamhub message` command (such as `teamhub message send`, `teamhub message card`, `teamhub message ask-user`, `teamhub message sequence`, or an emoji reaction) appear in the Room. Send your reply to the Room now, then finish.";

/** Where TeamHub found a visible reply from the Run. */
export interface RunReplyStatus {
  readonly replied: boolean;
  /** Absent from a TeamHub that only reports `replied`. */
  readonly repliedInboxIds?: readonly string[];
}

export interface RoomReplyGuardFeatureDeps {
  readonly readReplyStatus: (
    contextKey: string,
    runId: string,
    signal?: AbortSignal,
  ) => Promise<RunReplyStatus>;
  readonly logger?: AgentLogger;
  readonly checkTimeoutMs?: number;
}

/**
 * Intercepts a Room Run right before the Runtime finishes when a Human
 * mentioned this Agent in an Inbox where TeamHub has no persisted visible
 * reply from the Run. A chat steered in from another Inbox needs its own
 * reply. Blocks at most once per Run so the model can send its replies via
 * `teamhub message` in the same turn without risking an infinite loop.
 */
export function createRoomReplyGuardFeature(
  deps: RoomReplyGuardFeatureDeps,
): FeatureDeclaration {
  if (typeof deps?.readReplyStatus !== "function") {
    throw new Error("room-reply-guard feature requires readReplyStatus");
  }
  const checkTimeoutMs = deps.checkTimeoutMs ?? DEFAULT_REPLY_CHECK_TIMEOUT_MS;
  return defineFeature({
    id: ROOM_REPLY_GUARD_FEATURE_ID,
    match: {
      contextKinds: ["meta"],
    },
    context: {
      ports: {
        onRunBeforeStop: {},
        onRunTerminal: {},
      },
      create: (boundContext) => {
        const contextKey = encodeExecutionContextRef(boundContext.ref);
        const blockedRuns = new Set<string>();
        return {
          async onRunBeforeStop(context, input, signal) {
            if (input.stopHookActive || blockedRuns.has(input.runId)) {
              return { action: "allow" };
            }
            if (!input.inputs.some(awaitsReply)) {
              return { action: "allow" };
            }
            const awaited = awaitedReplyInboxIds(input.inputs);
            const checkSignal = AbortSignal.any([
              signal,
              context.signal,
              AbortSignal.timeout(checkTimeoutMs),
            ]);
            let unanswered: readonly string[] | undefined;
            let answered: boolean;
            try {
              const status = await deps.readReplyStatus(
                contextKey,
                input.runId,
                checkSignal,
              );
              const repliedInboxIds = status.repliedInboxIds;
              // Without both sides' Inboxes, a reply anywhere counts.
              unanswered =
                repliedInboxIds && awaited.length > 0
                  ? awaited.filter(
                      (inboxId) => !repliedInboxIds.includes(inboxId),
                    )
                  : undefined;
              answered = unanswered ? unanswered.length === 0 : status.replied;
            } catch (error) {
              deps.logger?.log("warn", "room_reply_guard.check_failed", {
                contextKey,
                runId: input.runId,
                error,
              });
              return { action: "allow" };
            }
            if (answered) {
              return { action: "allow", replyConfirmed: true };
            }
            blockedRuns.add(input.runId);
            deps.logger?.log("info", "room_reply_guard.blocked", {
              contextKey,
              runId: input.runId,
              attempt: input.attempt,
              ...(unanswered ? { unansweredInboxIds: unanswered } : {}),
            });
            return {
              action: "block",
              reason:
                unanswered && awaited.length > 1
                  ? `${ROOM_REPLY_REMINDER} Reply in each Inbox where you were mentioned; these have no reply from you yet: ${unanswered.join(", ")}. For a thread:<id> Inbox, send with --thread <id>.`
                  : ROOM_REPLY_REMINDER,
            };
          },
          onRunTerminal(_context, event) {
            blockedRuns.delete(event.runId);
          },
        };
      },
    },
  });
}
