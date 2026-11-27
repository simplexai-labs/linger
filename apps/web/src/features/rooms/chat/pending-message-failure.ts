import type { Translate } from "@/i18n/language";

import { composerMessages } from "./composer.messages";

/**
 * Why this client could not finish a send. The Outbox stores the reason, never
 * the sentence, so a pending row reads in the language on screen after a
 * switch or a reload. A stored name keeps its meaning forever.
 */
export type PendingMessageFailureReason =
  | "delivery_interrupted"
  | "delivery_may_have_reached"
  | "delivery_unconfirmed"
  | "local_save_failed"
  | "local_storage_full"
  | "outbox_cancel_failed"
  | "outbox_cleanup_failed";

export interface PendingMessageFailure {
  reason: PendingMessageFailureReason;
  /** What the browser said about a storage failure; shown as it came. */
  detail?: string;
}

/** The sentence for a failure; nothing for a reason this client does not know. */
export function describePendingMessageFailure(
  { detail, reason }: PendingMessageFailure,
  t: Translate,
): string | undefined {
  switch (reason) {
    case "delivery_interrupted":
      return t(composerMessages.deliveryInterrupted);
    case "delivery_may_have_reached":
    case "delivery_unconfirmed":
      return t(composerMessages.deliveryUnconfirmed);
    case "local_save_failed":
      return detail
        ? t(composerMessages.saveLocallyFailedDetail, { detail })
        : t(composerMessages.saveLocallyFailed);
    case "local_storage_full":
      return t(composerMessages.saveLocallyStorageFull);
    case "outbox_cancel_failed":
      return detail
        ? t(composerMessages.outboxCancelFailedDetail, { detail })
        : t(composerMessages.outboxCancelFailed);
    case "outbox_cleanup_failed":
      return detail
        ? t(composerMessages.outboxCleanupFailedDetail, { detail })
        : t(composerMessages.outboxCleanupFailed);
    default:
      return undefined;
  }
}
