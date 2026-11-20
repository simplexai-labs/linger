import { isRecord } from "@linger/service-kit";
import type { RunEvent } from "./provider.js";
import type { Message } from "./types.js";

/**
 * The Run's TeamHub message calls, as the Computer classifies them: a
 * `message` activity is a message write (`teamhub message send` and its
 * siblings), `message_read` any other `teamhub message` call, and a command
 * that exits non-zero finishes as failed. An emoji Reaction is a message
 * write too.
 */
export class ReplyDelivery {
  readonly #started = new Map<string, "message" | "message_read">();
  #awaitingHuman = false;
  #targetInboxId?: string;
  #fallbackDelivered = false;
  #attemptedWrites = 0;
  #failedWrites = 0;
  #deliveredWrites = 0;
  #failedReads = 0;

  /** Records the inputs the Run took up, at its start or as steers. */
  observeInputs(messages: readonly Message[]): void {
    for (const message of messages) {
      const inboxId = awaitedHumanInboxId(message);
      if (inboxId !== undefined) {
        this.#awaitingHuman = true;
        if (inboxId !== "") this.#targetInboxId = inboxId;
      }
    }
  }

  /** Marks that the executor surfaced the Run's final text via fallback delivery. */
  markFallbackDelivered(): void {
    this.#fallbackDelivered = true;
  }

  /** Authorized Room or Thread Inbox where the waiting Human mentioned the Agent. */
  get targetInboxId(): string | undefined {
    return this.#targetInboxId;
  }

  observe(event: RunEvent): void {
    if (event.type === "activity.started") {
      if (event.kind === "message") this.#attemptedWrites += 1;
      if (event.kind === "message" || event.kind === "message_read")
        this.#started.set(event.activityId, event.kind);
      return;
    }
    if (event.type !== "activity.finished") return;
    const kind = this.#started.get(event.activityId);
    if (!kind) return;
    this.#started.delete(event.activityId);
    if (kind === "message_read") {
      if (event.outcome === "failed") this.#failedReads += 1;
    } else if (event.outcome === "succeeded") {
      this.#deliveredWrites += 1;
    } else if (event.outcome === "failed") {
      this.#failedWrites += 1;
    }
  }

  /**
   * The Agent tried to post and no attempt reached the Room. An Agent that
   * never tried chose not to reply, which is not a delivery failure.
   */
  get replyUndelivered(): boolean {
    return this.#failedWrites > 0 && this.#deliveredWrites === 0;
  }

  /**
   * A Human who mentioned the Agent is waiting and neither a message command
   * nor fallback delivery reached the Room.
   */
  get replyNotSent(): boolean {
    return (
      this.#awaitingHuman &&
      this.#attemptedWrites === 0 &&
      !this.#fallbackDelivered
    );
  }

  get hasFailures(): boolean {
    return this.#failedWrites > 0 || this.#failedReads > 0;
  }

  counts(): {
    readonly failedMessageWrites: number;
    readonly deliveredMessageWrites: number;
    readonly failedMessageReads: number;
  } {
    return {
      failedMessageWrites: this.#failedWrites,
      deliveredMessageWrites: this.#deliveredWrites,
      failedMessageReads: this.#failedReads,
    };
  }
}

/**
 * Strips model thinking wrapper blocks from final assistant text before
 * fallback Room delivery so pure-thinking or whitespace output stays empty.
 */
export function extractDeliverableReplyText(text: string): string {
  return text
    .replace(/<(think|thinking)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<(think|thinking)\b[^>]*>[\s\S]*$/iu, "")
    .trim();
}

/**
 * Returns the target Inbox ID (or "" when omitted on a synthetic input) when
 * TeamHub queued this input for a Human's Message that mentioned this Agent,
 * or undefined when the input does not require a Human reply. Room talk the
 * Agent only reads along with, a Routine wake, a Task callback and another
 * Agent's Message may rightly go unanswered.
 */
function awaitedHumanInboxId(message: Message): string | undefined {
  const notification = (message as unknown as Record<string, unknown>)
    .acceptedNotification;
  if (!isRecord(notification) || !Array.isArray(notification.messages))
    return undefined;
  const awaiting = notification.messages.some(
    (queued) =>
      isRecord(queued) &&
      queued.mentioned === true &&
      queued.authorType === "user" &&
      queued.messageKind === "conversation",
  );
  if (!awaiting) return undefined;
  return typeof notification.inboxId === "string"
    ? notification.inboxId.trim()
    : "";
}
