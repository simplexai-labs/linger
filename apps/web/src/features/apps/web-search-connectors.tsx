import { Globe02Icon } from "@hugeicons/core-free-icons";
import {
  type UseQueryResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubWebSearchBackend,
  TeamHubWebSearchBackendList,
  TeamHubWebSearchKeyBackend,
} from "@/features/teamhub/teamhub-types";
import {
  isWebSearchKeyBackend,
  type ShownWebSearchBackend,
  webSearchQueryKey,
} from "@/features/web-search/web-search-backends";
import { WebSearchKeyForm } from "@/features/web-search/web-search-key-form";
import { WebSearchKeysUnavailable } from "@/features/web-search/web-search-keys-unavailable";
import { webSearchBackendLogo } from "@/features/web-search/web-search-logos";
import { commonMessages } from "@/i18n/common.messages";
import { formatLocale, type Translation } from "@/i18n/language";
import { useT, useTranslation } from "@/i18n/use-translation";
import { formatUpdatedAt } from "@/lib/date-format";
import { cn } from "@/lib/cn";
import {
  webSearchBackendDescription,
  webSearchBackendFreeTier,
  webSearchBackendFreeUse,
} from "@/features/web-search/web-search-backend-text";

import { WEB_SEARCH_FILTER } from "./app-groups";
import { AppLogo } from "./app-logo";
import { connectorMessages as m } from "./connectors.messages";

/**
 * The web search backends as Connectors cards. They need no Composio key:
 * each provider's own key is saved in TeamHub, and the list loads and fails
 * on its own.
 */
export function WebSearchSection({
  backends,
  className,
  heading,
  list,
}: {
  /** The backends to show, narrowed by Connected only. */
  backends: readonly ShownWebSearchBackend[];
  className?: string;
  heading: boolean;
  list: UseQueryResult<TeamHubWebSearchBackendList>;
}) {
  const t = useT();
  const [openID, setOpenID] = useState<string | null>(null);
  const opened = backends.find((backend) => backend.id === openID);
  const headingId = "connector-group-web-search";
  return (
    <section
      aria-label={heading ? undefined : t(WEB_SEARCH_FILTER.label)}
      aria-labelledby={heading ? headingId : undefined}
      className={className}
    >
      {heading ? (
        <h2
          className="mb-2.5 text-[14px] font-medium text-muted-foreground"
          id={headingId}
        >
          {t(WEB_SEARCH_FILTER.label)}
        </h2>
      ) : null}
      {list.isPending ? (
        <p className="py-3 text-sm text-muted-foreground" role="status">
          {t(m.loadingWebSearch)}
        </p>
      ) : list.error ? (
        <div className="flex items-center gap-3 py-3" role="alert">
          <p className="text-sm text-app-danger">{list.error.message}</p>
          <Button onClick={() => void list.refetch()} size="compact">
            {t(commonMessages.retry)}
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {backends.map((backend) => (
            <WebSearchBackendCard
              backend={backend}
              isDefault={list.data.default_search === backend.id}
              key={backend.id}
              onOpen={() => setOpenID(backend.id)}
            />
          ))}
        </div>
      )}
      {opened && list.data ? (
        <WebSearchBackendDialog
          backend={opened}
          list={list.data}
          onClose={() => setOpenID(null)}
        />
      ) : null}
    </section>
  );
}

/**
 * A backend card in the app cards' shape: the provider's own description
 * until it is usable, then a status dot and line, and Connect while a key
 * can still be added.
 */
function WebSearchBackendCard({
  backend,
  isDefault,
  onOpen,
}: {
  backend: ShownWebSearchBackend;
  isDefault: boolean;
  onOpen: () => void;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const state = connectionState(backend, translation);
  const line = state?.label ?? webSearchBackendDescription(backend, t);
  const canConnect =
    isWebSearchKeyBackend(backend) &&
    (backend.key_state === "none" || state?.tone === "danger");
  return (
    <article className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 transition-colors duration-150 hover:bg-accent/40 motion-reduce:transition-none">
      <button
        aria-label={backend.name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        type="button"
      >
        <BackendLogoTile backend={backend} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate text-sm font-medium text-foreground">
              {backend.name}
            </span>
            {isDefault ? (
              <span className="shrink-0 text-xs text-muted-foreground">
                {t(m.defaultBackend)}
              </span>
            ) : null}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {state ? (
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  state.tone === "danger"
                    ? "bg-[var(--app-status-danger-text)]"
                    : "bg-[var(--app-status-success-text)]",
                )}
              />
            ) : null}
            <span className="truncate" title={line}>
              {line}
            </span>
          </span>
        </span>
      </button>
      {canConnect ? (
        <Button
          aria-label={t(m.connectApp, { app: backend.name })}
          className="px-2.5"
          onClick={onOpen}
          size="compact"
          tone="secondary"
        >
          {t(m.connect)}
        </Button>
      ) : null}
    </article>
  );
}

function WebSearchBackendDialog({
  backend,
  list,
  onClose,
}: {
  backend: ShownWebSearchBackend;
  list: TeamHubWebSearchBackendList;
  onClose: () => void;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const usage = usageLine(backend, translation);
  return (
    <ModalDialog
      className="app-key-dialog"
      closeOnBackdrop
      description={webSearchBackendDescription(backend, t)}
      onClose={onClose}
      size="md"
      title={backend.name}
    >
      <div className="space-y-5 px-5 py-5 text-sm text-app-body">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <Fact label={t(m.factDoes)}>
            {backend.commands.includes("open")
              ? t(m.searchesAndReads)
              : t(m.searches)}
          </Fact>
          {backend.free_tier ? (
            <Fact label={t(m.factFreeTier)}>
              {webSearchBackendFreeTier(backend, t) ?? ""}
            </Fact>
          ) : null}
          {backend.tier_text ? (
            <Fact label={t(m.factFreeUse)}>
              {webSearchBackendFreeUse(backend, t) ?? ""}
            </Fact>
          ) : null}
          {usage ? <Fact label={t(m.factUsage)}>{usage}</Fact> : null}
        </dl>
        {isWebSearchKeyBackend(backend) ? (
          <KeySection backend={backend} canSave={list.can_save_keys} />
        ) : null}
        <DefaultSection backend={backend} list={list} />
      </div>
    </ModalDialog>
  );
}

function KeySection({
  backend,
  canSave,
}: {
  backend: TeamHubWebSearchBackend & { id: TeamHubWebSearchKeyBackend };
  canSave: boolean;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const saved = backend.key_state !== "none";
  const remove = useMutation({
    mutationFn: () =>
      teamHubDone(
        client.api.DELETE("/v0/web-search/backends/{backend}/key", {
          params: { path: { backend: backend.id } },
        }),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: webSearchQueryKey }),
  });
  return (
    <section aria-label={t(m.apiKey)} className="space-y-3">
      {saved ? <p>{savedKeyText(backend, t)}</p> : null}
      {canSave ? (
        <WebSearchKeyForm
          backend={backend}
          submitLabel={saved ? t(m.replaceKey) : t(m.saveKey)}
        />
      ) : (
        <WebSearchKeysUnavailable />
      )}
      {saved ? (
        <div className="space-y-1.5">
          <Button
            data-voice-risk="never"
            loading={remove.isPending}
            onClick={() => remove.mutate()}
            tone="danger"
          >
            {t(m.removeKey)}
          </Button>
          {remove.error ? (
            <p className="text-xs text-app-danger" role="alert">
              {remove.error.message}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DefaultSection({
  backend,
  list,
}: {
  backend: ShownWebSearchBackend;
  list: TeamHubWebSearchBackendList;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const chosen = list.chosen_default_search === backend.id;
  const change = useMutation({
    mutationFn: (makeDefault: boolean) =>
      teamHubData(
        makeDefault
          ? client.api.PUT("/v0/web-search/default", {
              body: { backend: backend.id },
            })
          : client.api.DELETE("/v0/web-search/default"),
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: webSearchQueryKey }),
  });
  const text = t(
    chosen
      ? m.defaultChosen
      : list.default_search === backend.id
        ? m.defaultFirstReady
        : backend.status === "ready"
          ? m.defaultOffer
          : m.defaultNeedsKey,
    { backend: backend.name },
  );
  return (
    <section aria-label={t(m.defaultSearchBackend)} className="space-y-2">
      <p className="text-muted-foreground">{text}</p>
      {chosen ? (
        <Button
          loading={change.isPending}
          onClick={() => change.mutate(false)}
          tone="secondary"
        >
          {t(m.clearDefault)}
        </Button>
      ) : backend.status === "ready" ? (
        <Button
          loading={change.isPending}
          onClick={() => change.mutate(true)}
          tone="secondary"
        >
          {t(m.makeDefault)}
        </Button>
      ) : null}
      {change.error ? (
        <p className="text-xs text-app-danger" role="alert">
          {change.error.message}
        </p>
      ) : null}
    </section>
  );
}

function Fact({ children, label }: { children: string; label: string }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </>
  );
}

function BackendLogoTile({ backend }: { backend: TeamHubWebSearchBackend }) {
  const logo = webSearchBackendLogo(backend.id);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-lg bg-card has-[img]:bg-(--app-logo-tile) shadow-outline",
        logo ? "text-foreground" : "text-muted-foreground",
      )}
    >
      {logo ? (
        <AppLogo name={backend.name} url={logo} />
      ) : (
        <Icon icon={Globe02Icon} size={20} />
      )}
    </span>
  );
}

/**
 * The status line of a backend that has a key or a free tier; null for one
 * that still needs a key, whose card shows its description.
 */
function connectionState(
  backend: TeamHubWebSearchBackend,
  translation: Translation,
): { label: string; tone: "danger" | "success" } | null {
  const { t } = translation;
  if (backend.key_state === "rejected" || backend.status === "key_rejected")
    return { label: t(m.searchKeyRejected), tone: "danger" };
  if (backend.key_state !== "none") {
    const usage = usageLine(backend, translation);
    return {
      label: usage ? t(m.connectedWithUsage, { usage }) : t(m.connected),
      tone: "success",
    };
  }
  if (backend.tier === "free")
    return { label: t(m.freeLimited), tone: "success" };
  return null;
}

function savedKeyText(
  backend: TeamHubWebSearchBackend,
  t: Translation["t"],
): string {
  if (backend.key_state === "rejected")
    return t(m.savedKeyRefused, { backend: backend.name });
  if (backend.key_state === "unverified")
    return t(m.savedKeyUnverified, { backend: backend.name });
  return t(m.keySaved);
}

/**
 * What is left on the account, from the live quota; null when the provider
 * reported no numbers worth a line. Amounts are in USD whatever the language.
 */
function usageLine(
  backend: TeamHubWebSearchBackend,
  translation: Translation,
): string | null {
  const { t } = translation;
  const quota = backend.quota;
  if (!quota) return null;
  if (quota.from === "unavailable") {
    switch (quota.reason) {
      case "not_observed":
        return t(m.usageAfterFirstSearch);
      case "provider_unavailable":
        return t(m.usageUnavailable);
      default:
        return null;
    }
  }
  if (quota.remaining === undefined) return null;
  const format = new Intl.NumberFormat(
    formatLocale(translation.language),
    quota.unit === "usd" ? { currency: "USD", style: "currency" } : {},
  );
  const amount = `${format.format(quota.remaining)}${
    quota.limit === undefined ? "" : ` / ${format.format(quota.limit)}`
  }`;
  const left = t(
    quota.unit === "credits"
      ? m.usageCreditsLeft
      : quota.unit === "requests"
        ? m.usageRequestsLeft
        : m.usageLeft,
    { amount },
  );
  return quota.from === "last_response" && quota.observed_at
    ? t(m.usageAsOf, {
        left,
        when: formatUpdatedAt(quota.observed_at, undefined, translation),
      })
    : left;
}
