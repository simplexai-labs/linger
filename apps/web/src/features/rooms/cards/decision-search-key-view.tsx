import {
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon, type IconSvgElement } from "@/components/ui/icon";
import { StatusPill } from "@/components/ui/status-pill";
import { AppLogoTile } from "@/features/apps/app-logo";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubWebSearchBackend,
  TeamHubWebSearchKeyBackend,
} from "@/features/teamhub/teamhub-types";
import {
  isWebSearchKeyBackend,
  webSearchBackendInfoQueryOptions,
  webSearchBackendName,
} from "@/features/web-search/web-search-backends";
import {
  WebSearchKeyForm,
  type WebSearchKeyTarget,
} from "@/features/web-search/web-search-key-form";
import { WebSearchKeysUnavailable } from "@/features/web-search/web-search-keys-unavailable";
import { webSearchBackendLogo } from "@/features/web-search/web-search-logos";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import { webSearchBackendDescription } from "@/features/web-search/web-search-backend-text";

import {
  CardActions,
  CardError,
  CardRow,
  CardRowDetails,
} from "./approval-card-parts";
import { decisionCardHeading } from "./card-prompts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import { cardsMessages as m } from "./cards.messages";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

type KeyBackend = TeamHubWebSearchBackend & { id: TeamHubWebSearchKeyBackend };

/**
 * Asks the Agent's Human for a web search API key. The card shows the
 * backend the Agent named (Requested) or the one TeamHub picked for it
 * (Suggested); every other backend opens below with its own field. A key
 * goes from its field to TeamHub, never into the chat, and saving any
 * backend's key answers the card. The card reads the backend list without
 * quota, so it never calls a provider.
 */
export function SearchKeyDecision({
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
  const list = useQuery(webSearchBackendInfoQueryOptions(client));
  const [othersOpen, setOthersOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const view = card.search_key;
  if (!view) return null;
  const owner = currentActorId === card.decision_owner.id;
  const pending = card.status === "pending";
  const keyBackends = (list.data?.backends ?? []).filter(isWebSearchKeyBackend);
  const shownID =
    !pending && card.answer?.backend ? card.answer.backend : view.backend;
  const shown = keyBackends.find((backend) => backend.id === shownID);
  const others = keyBackends.filter((backend) => backend.id !== view.backend);
  const target: WebSearchKeyTarget = shown ?? {
    id: shownID,
    name: webSearchBackendName(shownID),
  };

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
      setError(cause instanceof Error ? cause.message : t(m.cardUpdateFailed));
    } finally {
      setBusy(false);
    }
  }

  const result = pending ? null : keyResult(card, view.backend, t);
  const canSave = list.data?.can_save_keys !== false;
  return (
    <CardBox heading={decisionCardHeading(card, t)} label={t(m.labelSearchKey)}>
      <CardRow
        detail={shown && webSearchBackendDescription(shown, t)}
        icon={
          <AppLogoTile name={target.name} url={webSearchBackendLogo(shownID)} />
        }
        title={
          <>
            {target.name}{" "}
            {pending ? (
              view.origin === "requested" ? (
                <StatusPill tone="info">{t(m.requested)}</StatusPill>
              ) : (
                <StatusPill>{t(m.suggested)}</StatusPill>
              )
            ) : null}
          </>
        }
      />
      {result ? (
        <CardDone icon={result.icon} text={result.text} tone={result.tone} />
      ) : owner ? (
        <>
          {view.reason === "missing" ? null : (
            <p className="px-2 pb-2 text-xs text-app-muted">
              {t(
                view.reason === "rejected"
                  ? m.searchKeyNoLongerAccepted
                  : m.freeSearchesUsedUp,
                { backend: target.name },
              )}
            </p>
          )}
          {canSave ? (
            <>
              <div className="px-2">
                <WebSearchKeyForm
                  backend={target}
                  decisionId={card.decision_id}
                />
              </div>
              {others.length ? (
                <OtherProviders
                  backends={others}
                  decisionId={card.decision_id}
                  onToggle={() => setOthersOpen((open) => !open)}
                  open={othersOpen}
                />
              ) : null}
            </>
          ) : (
            <div className="px-2 text-xs">
              <WebSearchKeysUnavailable />
            </div>
          )}
          <CardActions>
            <Button
              disabled={busy}
              onClick={() => void decline()}
              size="large"
              tone="subtle"
            >
              {t(m.notNow)}
            </Button>
          </CardActions>
        </>
      ) : null}
      {error ? <CardError>{error}</CardError> : null}
    </CardBox>
  );
}

/** Every backend but the card's, each with its own field, in a capped list. */
function OtherProviders({
  backends,
  decisionId,
  onToggle,
  open,
}: {
  backends: KeyBackend[];
  decisionId: string;
  onToggle: () => void;
  open: boolean;
}) {
  const t = useT();
  return (
    <>
      <button
        aria-expanded={open}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-app-body transition-colors duration-150 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-app-focus motion-reduce:transition-none"
        onClick={onToggle}
        type="button"
      >
        {open
          ? t(m.hideOtherProviders)
          : t(m.otherProvidersCount, { count: backends.length })}
        <Icon
          className={cn(
            "shrink-0 text-app-muted transition-transform duration-(--chat-resize-duration) ease-(--app-out-quint) motion-reduce:transition-none",
            open && "rotate-180",
          )}
          icon={ArrowDown01Icon}
          size={14}
        />
      </button>
      <CardRowDetails open={open}>
        <ul
          aria-label={t(m.otherProviders)}
          className="max-h-62 overflow-y-auto overscroll-contain px-2"
        >
          {backends.map((backend) => (
            <li className="flex flex-col gap-1 py-2.5" key={backend.id}>
              <div className="flex min-w-0 items-center gap-2.5">
                <AppLogoTile
                  name={backend.name}
                  small
                  url={webSearchBackendLogo(backend.id)}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5 text-sm text-app-ink">
                    <span className="truncate">{backend.name}</span>
                    {backend.tier === "free" ? (
                      <StatusPill tone="success">{t(m.freeLimited)}</StatusPill>
                    ) : null}
                  </p>
                  <p className="truncate text-xs text-app-muted">
                    {webSearchBackendDescription(backend, t)}
                  </p>
                </div>
              </div>
              <div className="sm:pl-9.5">
                <WebSearchKeyForm
                  backend={backend}
                  compact
                  decisionId={decisionId}
                  tone="secondary"
                />
              </div>
            </li>
          ))}
        </ul>
      </CardRowDetails>
    </>
  );
}

/** How a settled key request ended, naming the backend whose key was saved. */
function keyResult(
  card: DecisionMessageCard,
  shown: TeamHubWebSearchKeyBackend,
  t: Translate,
): { icon: IconSvgElement; text: string; tone: ReceiptTone } {
  if (card.answer?.decision === "configured") {
    const saved = card.answer.backend ?? shown;
    const backend = webSearchBackendName(saved);
    return {
      icon: Tick02Icon,
      text:
        saved === shown
          ? t(m.searchKeyAdded, { backend })
          : t(m.searchKeyAddedInstead, {
              backend,
              requested: webSearchBackendName(shown),
            }),
      tone: "success",
    };
  }
  if (card.status === "denied")
    return { icon: Cancel01Icon, text: t(m.noKeyAdded), tone: "muted" };
  return { icon: AlertCircleIcon, text: t(m.notCompleted), tone: "danger" };
}
