import {
  AlertCircleIcon,
  Cancel01Icon,
  Key01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { ConnectorsNotConfiguredMessage } from "@/features/apps/connect-app-flow";
import { externalAppsQueryOptions } from "@/features/apps/connected-apps-queries";
import { ComposioKeyForm } from "@/features/apps/provider-key-form";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { decisionCardHeading } from "./card-prompts";
import { CardActions, CardError, CardRow } from "./approval-card-parts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import { cardsMessages } from "./cards.messages";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

/**
 * Asks the Agent's Human for the deployment's Composio API key, which every
 * Connected App needs. The key goes from the dialog to TeamHub's key setting,
 * never into the chat; TeamHub resolves the card once a key is saved, and
 * that wakes the Agent to ask for the app itself.
 */
export function ProviderKeyDecision({
  card,
  currentActorId,
  messageId,
  onDecision,
}: {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const owner = currentActorId === card.decision_owner.id;
  const appKey = card.provider_key?.app_key;
  const appName = appKey
    ? catalog.data?.apps.find((app) => app.key === appKey)?.display_name
    : undefined;

  async function decline() {
    setBusy(true);
    setError("");
    try {
      await onDecision({
        decision: "deny",
        expectedVersion: card.version,
        messageId,
        requestId: card.decision_id,
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate(cardsMessages.cardUpdateFailed),
      );
    } finally {
      setBusy(false);
    }
  }

  const result = card.status === "pending" ? null : keyResult(card);
  const canSave = catalog.data?.provider_key.can_save !== false;
  return (
    <>
      <CardBox
        heading={decisionCardHeading(card, t, { app: appName })}
        label={t(cardsMessages.labelComposioKey)}
      >
        <CardRow
          icon={<Icon icon={Key01Icon} size={16} />}
          title={t(cardsMessages.composioApiKey)}
        />
        {result ? (
          <CardDone
            icon={result.icon}
            text={t(result.text)}
            tone={result.tone}
          />
        ) : owner ? (
          <CardActions>
            <Button
              disabled={busy}
              onClick={() => setOpen(true)}
              size="large"
              tone="primary"
            >
              {t(cardsMessages.addKey)}
            </Button>
            <Button
              disabled={busy}
              onClick={() => void decline()}
              size="large"
              tone="subtle"
            >
              {t(cardsMessages.notNow)}
            </Button>
          </CardActions>
        ) : null}
        {error ? <CardError>{error}</CardError> : null}
      </CardBox>
      {open && owner && !result ? (
        <ModalDialog
          className="app-key-dialog"
          closeOnBackdrop
          onClose={() => setOpen(false)}
          size="md"
          title={t(cardsMessages.addComposioKeyTitle)}
        >
          <div
            className={cn(
              "px-5 pt-2 text-sm text-app-body",
              canSave ? "pb-4" : "pb-5",
            )}
          >
            {canSave ? (
              <ComposioKeyForm
                onCancel={() => setOpen(false)}
                onSaved={() => setOpen(false)}
              />
            ) : (
              <ConnectorsNotConfiguredMessage />
            )}
          </div>
        </ModalDialog>
      ) : null}
    </>
  );
}

/** How a settled key request ended, in a few words. */
function keyResult(card: DecisionMessageCard): {
  icon: IconSvgElement;
  text: Message<string>;
  tone: ReceiptTone;
} {
  if (card.answer?.decision === "configured")
    return { icon: Tick02Icon, text: cardsMessages.keyAdded, tone: "success" };
  if (card.status === "denied")
    return {
      icon: Cancel01Icon,
      text: cardsMessages.noKeyAdded,
      tone: "muted",
    };
  return {
    icon: AlertCircleIcon,
    text: cardsMessages.notCompleted,
    tone: "danger",
  };
}
