import type { TeamHubMessageCard } from "@/features/teamhub/teamhub-types";
import { webSearchBackendName } from "@/features/web-search/web-search-backends";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate, Translation } from "@/i18n/language";
import {
  formatMessageParts,
  type Message,
  type MessageArguments,
  type MessagePart,
} from "@/i18n/messages";

import { cardsMessages } from "./cards.messages";
import { connectedAppDisplayName } from "./connected-app-names";

/**
 * A settled card no longer asks anything, so the chat shows what happened as
 * one centered system line, the way Room notices do: who did what to what.
 * The object links to where the result lives. A card still waiting or still
 * running returns null and stays a card.
 *
 * The notice holds the card and its reader, not text: `cardNoticeLines`
 * writes the lines in the language on screen.
 */
export interface CardNotice {
  card: TeamHubMessageCard;
  viewerId: string | undefined;
}

/** One system line: its text, cut where the `link` span sits. */
export interface CardNoticeLine {
  parts: readonly MessagePart[];
  /** Where the line's `link` span goes: where the result lives. */
  link?: NoticeTarget;
}

export type NoticeTarget = { room: string } | "apps";

type Question = NonNullable<
  TeamHubMessageCard["question"]
>["questions"][number];

const runningStatuses = new Set([
  "pending",
  "approved",
  "executing",
  "authorizing",
]);

export function settledCardNotice(
  card: TeamHubMessageCard,
  viewerId: string | undefined,
): CardNotice | null {
  const finishedApproval =
    card.kind === "runtime_permission" && card.status === "approved";
  if (runningStatuses.has(card.status) && !finishedApproval) return null;
  return { card, viewerId };
}

/**
 * The lines of a settled card: the main line, then one per answer after the
 * first on a question card.
 */
export function cardNoticeLines(
  { card, viewerId }: CardNotice,
  translation: Translation,
): CardNoticeLine[] {
  const { t } = translation;
  const line = <M extends Message>(
    message: M,
    ...values: MessageArguments<M["source"]>
  ): CardNoticeLine => ({
    parts: formatMessageParts(
      message,
      translation.language,
      translation.catalog,
      values[0],
    ),
  });

  const who = !card.decided_by
    ? t(cardsMessages.noticeSomeone)
    : card.decided_by.id === viewerId
      ? t(commonMessages.you)
      : t(cardsMessages.noticeActor, { name: card.decided_by.display_name });
  const title = card.title;
  const reason = card.answer?.comment?.trim();
  const outcome = card.outcome?.trim();

  if (card.kind === "question") {
    if (card.status !== "answered") {
      return [line(cardsMessages.noticeUnanswered, { title })];
    }
    const given = card.answer?.answers ?? {};
    const lines = (card.question?.questions ?? []).map((question) =>
      line(cardsMessages.noticeAnswered, {
        answer:
          answerLabels(question, given[question.id], t) ||
          t(cardsMessages.noAnswer),
        question: question.prompt,
        who,
      }),
    );
    if (reason)
      lines.push(line(cardsMessages.noticeAddedNote, { note: reason, who }));
    return lines.length ? lines : [{ parts: [] }];
  }

  if (card.status === "expired") {
    return [line(cardsMessages.noticeExpired, { title })];
  }
  if (card.status === "denied") {
    return [
      reason
        ? line(cardsMessages.noticeDeclinedWithReason, { reason, title, who })
        : line(cardsMessages.noticeDeclined, { title, who }),
    ];
  }

  switch (card.kind) {
    case "runtime_permission":
      if (card.answer?.approval_scope === "always") {
        return [line(cardsMessages.noticeAlwaysAllowed, { title, who })];
      }
      if (card.answer?.approval_scope === "task") {
        return [line(cardsMessages.noticeAllowedForTask, { title, who })];
      }
      return [
        card.status === "consumed"
          ? line(cardsMessages.noticeAllowedOnceRan, { title, who })
          : line(cardsMessages.noticeAllowedOnce, { title, who }),
      ];
    case "browser_connection":
      return [line(cardsMessages.noticeConnectedChrome, { who })];
    case "provider_key":
      return [line(cardsMessages.noticeAddedComposioKey, { who })];
    case "search_key": {
      const shown = card.search_key?.backend;
      const saved = card.answer?.backend ?? shown;
      if (!saved) break;
      const backend = webSearchBackendName(saved);
      return [
        shown && saved !== shown
          ? line(cardsMessages.noticeAddedSearchKeyInstead, {
              backend,
              requested: webSearchBackendName(shown),
              who,
            })
          : line(cardsMessages.noticeAddedSearchKey, { backend, who }),
      ];
    }
    case "connection_auth": {
      if (card.status === "succeeded") {
        const app = connectedAppDisplayName(card.connection_auth?.app_key);
        return [
          {
            ...line(cardsMessages.noticeConnectedApp, { app, who }),
            link: "apps",
          },
        ];
      }
      return [
        outcome
          ? line(cardsMessages.noticeDidNotFinishWithOutcome, {
              outcome,
              title,
            })
          : line(cardsMessages.noticeDidNotFinish, { title }),
      ];
    }
    case "computer_permission":
      return [line(cardsMessages.noticeGranted, { title, who })];
    case "profile_setup_apps":
    case "profile_setup_sources":
      return [
        card.answer?.decision === "skipped"
          ? line(cardsMessages.noticeSkipped, { title, who })
          : line(cardsMessages.noticeCompleted, { title, who }),
      ];
    case "room_creation": {
      const room = card.room_creation;
      if (card.status === "succeeded" && room?.created_room_id) {
        return [
          {
            ...line(cardsMessages.noticeCreatedRoom, { room: room.name, who }),
            link: { room: room.created_room_id },
          },
        ];
      }
      break;
    }
    default:
      break;
  }

  // Connector writes, Agent changes and Room creations TeamHub ran.
  if (card.status === "succeeded") {
    return [line(cardsMessages.noticeApproved, { title, who })];
  }
  if (card.status === "failed") {
    return [
      outcome
        ? line(cardsMessages.noticeApprovedFailedWithOutcome, {
            outcome,
            title,
            who,
          })
        : line(cardsMessages.noticeApprovedFailed, { title, who }),
    ];
  }
  if (card.status === "unknown") {
    return [
      outcome
        ? line(cardsMessages.noticeApprovedUnknownWithOutcome, {
            outcome,
            title,
            who,
          })
        : line(cardsMessages.noticeApprovedUnknown, { title, who }),
    ];
  }
  return [line(cardsMessages.noticeEnded, { title })];
}

function answerLabels(
  question: Question,
  value: string | string[] | undefined,
  t: Translate,
): string {
  const chosen = Array.isArray(value) ? value : value ? [value] : [];
  return chosen
    .map(
      (id) => question.options?.find((option) => option.id === id)?.label ?? id,
    )
    .join(t(cardsMessages.listSeparator));
}
