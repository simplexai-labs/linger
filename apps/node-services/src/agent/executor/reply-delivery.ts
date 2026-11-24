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
  #failedWrites = 0;
  #deliveredWrites = 0;
  #failedReads = 0;

  /** Records the inputs the Run took up, at its start or as steers. */
  observeInputs(messages: readonly Message[]): void {
    if (messages.some(awaitsReply)) this.#awaitingHuman = true;
  }

  observe(event: RunEvent): void {
    if (event.type === "activity.started") {
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
   * A Human who mentioned the Agent is waiting, every write attempt failed,
   * and no write reached the Room.
   */
  get replyUndelivered(): boolean {
    return (
      this.#awaitingHuman &&
      this.#failedWrites > 0 &&
      this.#deliveredWrites === 0
    );
  }

  /**
   * A Human who mentioned the Agent is waiting and no write reached the Room
   * without any failed write attempt (the Agent never posted, or a write
   * activity did not finish as delivered or failed). Its Runtime ended the
   * turn in text nobody sees; small models do this when they answer without
   * calling the message command.
   */
  get replyNotSent(): boolean {
    return (
      this.#awaitingHuman &&
      this.#deliveredWrites === 0 &&
      this.#failedWrites === 0
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
 * Whether TeamHub queued this input for a Human's Message that mentioned this
 * Agent. TeamHub counts a Human's Message in a direct chat as mentioning its
 * Agent, with or without an @. Room talk the Agent only reads
 * along with, a Routine wake, a Task callback and another Agent's Message may
 * rightly go unanswered.
 */
export function awaitsReply(message: Message): boolean {
  const notification = (message as unknown as Record<string, unknown>)
    .acceptedNotification;
  if (!isRecord(notification) || !Array.isArray(notification.messages))
    return false;
  return notification.messages.some(
    (queued) =>
      isRecord(queued) &&
      queued.mentioned === true &&
      queued.authorType === "user" &&
      queued.messageKind === "conversation",
  );
}

/** The Inboxes in which these inputs await a reply, in input order. */
export function awaitedReplyInboxIds(
  messages: readonly Message[],
): readonly string[] {
  const inboxIds = messages
    .filter(awaitsReply)
    .map(
      (message) =>
        (message as unknown as { acceptedNotification: { inboxId?: unknown } })
          .acceptedNotification.inboxId,
    );
  return [
    ...new Set(
      inboxIds.filter(
        (inboxId): inboxId is string => typeof inboxId === "string",
      ),
    ),
  ];
}
