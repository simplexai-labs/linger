// Sends a decision card's answer and keeps the cached Message in step. A
// stale card version refetches the card, so the Human sees what changed.
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";

import { decide, getMessage } from "../api/teamhub";
import type { DecisionCard, DecisionRequest, Message } from "../api/types";
import { useTranslation } from "../i18n/use-translation";
import { messagesKey } from "../realtime/realtime-context";
import { HttpError } from "../session/http";
import { useTeamHub } from "../state/queries";
import { chatDecisionMessages as m } from "./decision-card.messages";
import { replaceMessage, type MessagePages } from "./message-cache";

export type DecisionAnswer = Omit<DecisionRequest, "expected_version">;

export interface DecisionAnswering {
  readonly busy: boolean;
  readonly problem: string | undefined;
  setProblem(problem: string | undefined): void;
  /**
   * Sends the answer; resolves whether the card took it. `describe` words a
   * failure the kind knows better than "not sent".
   */
  answer(
    request: DecisionAnswer,
    describe?: (error: unknown) => string | undefined,
  ): Promise<boolean>;
  /** Reads the card again, after a call that answers it on the server. */
  refresh(): Promise<void>;
}

export function useDecisionAnswer(
  card: Pick<DecisionCard, "decision_id" | "version">,
  roomId: string,
  messageId: string,
): DecisionAnswering {
  const { t } = useTranslation();
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();

  const store = useCallback(
    (message: Message) =>
      client.setQueryData<MessagePages>(
        messagesKey(teamHub.hostId, roomId),
        (data) => replaceMessage(data, message),
      ),
    [client, roomId, teamHub.hostId],
  );

  const refresh = async () => {
    const fresh = await teamHub
      .run((session) => getMessage(session, roomId, messageId))
      .catch(() => undefined);
    if (fresh) store(fresh);
  };

  const answer = async (
    request: DecisionAnswer,
    describe?: (error: unknown) => string | undefined,
  ): Promise<boolean> => {
    setBusy(true);
    setProblem(undefined);
    try {
      const message = await teamHub.run((session) =>
        decide(session, card.decision_id, {
          ...request,
          expected_version: card.version,
        }),
      );
      store(message);
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) {
        setProblem(t(m.cardChanged));
        await refresh();
      } else {
        setProblem(describe?.(error) ?? t(m.answerNotSent));
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, problem, setProblem, answer, refresh };
}
