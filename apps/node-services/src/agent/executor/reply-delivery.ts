import type { RunEvent } from "./provider.js";

/**
 * The Run's tool activity and TeamHub message calls. The Computer classifies
 * writes (`teamhub message send` and siblings) as `message` and other
 * `teamhub message` calls as `message_read`. Nonzero exits are failures.
 */
export class ReplyDelivery {
  readonly #started = new Map<string, "message" | "message_read">();
  #failedWrites = 0;
  #deliveredWrites = 0;
  #failedReads = 0;
  #hasToolActivity = false;

  observe(event: RunEvent): void {
    if (
      event.type === "tool.called" ||
      event.type === "tool.returned" ||
      event.type === "activity.started" ||
      event.type === "activity.finished"
    ) {
      this.#hasToolActivity = true;
    }
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

  /** A message write was attempted, but none reached the Room. */
  get replyUndelivered(): boolean {
    return this.#failedWrites > 0 && this.#deliveredWrites === 0;
  }

  get hasToolActivity(): boolean {
    return this.#hasToolActivity;
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
