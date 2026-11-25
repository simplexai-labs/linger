import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { DesktopBarTitle } from "@/app/desktop-frame";
import { type MouseEvent, type ReactNode, useState } from "react";
import { useSearchParams } from "react-router";

import { ActionMenu } from "@/components/ui/action-menu";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { cn } from "@/lib/cn";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalAppKey,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";
import { webSearchBackendDescription } from "@/features/web-search/web-search-backend-text";
import {
  connectedWebSearchBackends,
  isWebSearchKeyBackend,
  shownWebSearchBackends,
  webSearchBackendsQueryOptions,
} from "@/features/web-search/web-search-backends";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { AppLogo } from "./app-logo";
import {
  ANOTHER_ME_ONLY_APPS,
  appSummary,
  groupCatalogApps,
  WEB_SEARCH_FILTER,
} from "./app-groups";
import {
  AppManageDialog,
  DisconnectConnectionDialog,
} from "./app-manage-dialog";
import {
  activeExternalConnections,
  externalConnectionNeedsAttention,
  openPendingExternalConnection,
  externalConnectionUnconfirmed,
} from "./connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionsQueryOptions,
} from "./connected-apps-queries";
import { ConnectAppStatus, useConnectAppFlow } from "./connect-app-flow";
import { connectorMessages as m } from "./connectors.messages";
import { WebSearchSection } from "./web-search-connectors";

const APP_GRID_CLASS = "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3";

function stopCardClick(event: MouseEvent) {
  event.stopPropagation();
}

export function ConnectedAppsPage() {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedApp = searchParams.get("app");
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery(externalConnectionsQueryOptions(client));
  const webSearch = useQuery(webSearchBackendsQueryOptions(client));
  // "all" shows every group; otherwise one group's id.
  const [filter, setFilter] = useState("all");
  const [connectedOnly, setConnectedOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const normalizedQuery = searchQuery.trim().toLowerCase();
  // TeamHub lists only Connections that are not revoked.
  const visibleConnections = connections.data?.connections ?? [];
  const allApps = apps.data?.apps ?? [];
  const groups = groupCatalogApps(allApps);
  const catalogApps = groups.flatMap((entry) => entry.apps);
  // Apps outside the groups are not offered, but an account already connected
  // to one stays reachable here so it can be managed or disconnected, unless
  // it is shared only with AnotherMe.
  const connectedApps = [
    ...catalogApps,
    ...allApps.filter((app) => !catalogApps.includes(app)),
  ].filter(
    (app) =>
      !ANOTHER_ME_ONLY_APPS.has(app.key) &&
      activeExternalConnections(
        visibleConnections.filter(
          (connection) => connection.provider === app.key,
        ),
      ).length > 0,
  );
  const filters = [
    { id: "all", label: t(m.filterAll) },
    ...groups.map(({ group }) => ({ id: group.id, label: t(group.title) })),
    { id: WEB_SEARCH_FILTER.id, label: t(WEB_SEARCH_FILTER.label) },
  ];
  function matchesApp(app: TeamHubExternalApp, groupTitle?: string) {
    if (!normalizedQuery) return true;
    const haystack = [
      app.display_name,
      app.key,
      appSummary(app, t),
      groupTitle ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(normalizedQuery);
  }
  const visibleGroups = groups
    .map((entry) => ({
      ...entry,
      apps: entry.apps.filter((app) => matchesApp(app, t(entry.group.title))),
    }))
    .filter((entry) => entry.apps.length > 0);
  const groupEntry = groups.find((entry) => entry.group.id === filter);
  const groupApps = groupEntry?.apps.filter((app) =>
    matchesApp(app, t(groupEntry.group.title)),
  );
  // Connected only narrows whichever view is open; with All it is one grid.
  const filteredApps = connectedOnly
    ? (groupApps ?? connectedApps).filter(
        (app) => connectedApps.includes(app) && matchesApp(app),
      )
    : groupApps;
  const allSearchBackends = webSearch.data?.backends ?? [];
  // Connected only excludes key-based providers that have no saved key (such as
  // You.com's Connect prompt) while keeping keyless built-in defaults and saved keys.
  const connectedBackends = connectedWebSearchBackends(
    allSearchBackends,
  ).filter(
    (backend) =>
      backend.key_state !== "none" || !isWebSearchKeyBackend(backend),
  );
  const baseSearchBackends = connectedOnly
    ? connectedBackends
    : shownWebSearchBackends(allSearchBackends);
  const searchBackends = normalizedQuery
    ? baseSearchBackends.filter((backend) =>
        [
          backend.name,
          backend.id,
          webSearchBackendDescription(backend, t),
          t(WEB_SEARCH_FILTER.label),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : baseSearchBackends;
  const searchFilter = filter === WEB_SEARCH_FILTER.id;
  const showSearch =
    (filter === "all" &&
      (webSearch.isPending ||
        Boolean(webSearch.error) ||
        searchBackends.length > 0)) ||
    searchFilter;
  const hasVisibleApps = filteredApps
    ? filteredApps.length > 0
    : visibleGroups.length > 0;
  const noSearchMatches =
    Boolean(normalizedQuery) &&
    !hasVisibleApps &&
    (!showSearch || (!webSearch.isPending && searchBackends.length === 0));
  const showApps =
    !searchFilter &&
    !noSearchMatches &&
    (!showSearch || !filteredApps || filteredApps.length > 0);

  function renderApp(app: TeamHubExternalApp) {
    return (
      <CatalogAppCard
        app={app}
        connections={visibleConnections.filter(
          (connection) => connection.provider === app.key,
        )}
        key={app.key}
        selected={requestedApp === app.key}
        onOpen={() => openApp(app.key)}
      />
    );
  }

  // Groups decide only what the grid offers; the dialog opens for any app
  // TeamHub lists, so links like Agent Info's `?app=googledrive` still work.
  const selectedApp = apps.data?.apps.find((app) => app.key === requestedApp);

  function openApp(appKey: TeamHubExternalAppKey) {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("app", appKey);
        return next;
      },
      { replace: true },
    );
  }

  function closeApp() {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("app");
        return next;
      },
      { replace: true },
    );
  }

  return (
    <main className="workspace-scrollbar min-h-0 flex-1 overflow-y-auto bg-background [scrollbar-gutter:stable]">
      <div className="workspace-file-browser">
        <div className="mb-4 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 sm:flex sm:flex-row sm:items-center">
          <DesktopBarTitle>
            <h1 className="text-2xl text-foreground">{t(m.title)}</h1>
          </DesktopBarTitle>
          {!apps.isPending &&
          !connections.isPending &&
          !apps.error &&
          !connections.error ? (
            <>
              <div className="ui-field-frame order-3 col-span-2 min-w-0 sm:order-2 sm:ml-auto sm:w-56">
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 flex w-9 items-center justify-center text-muted-foreground"
                >
                  <Icon icon={Search01Icon} size={15} />
                </span>
                <input
                  aria-label={t(m.searchConnectors)}
                  className="ui-field-control h-9 w-full pl-9 pr-8 text-sm text-foreground placeholder:text-app-placeholder"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder={t(m.searchConnectorsPlaceholder)}
                  type="search"
                  value={searchQuery}
                />
                {searchQuery ? (
                  <button
                    aria-label={t(m.clearConnectorSearch)}
                    className="absolute inset-y-0 right-1 my-auto grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => setSearchQuery("")}
                    type="button"
                  >
                    <Icon icon={Cancel01Icon} size={14} />
                  </button>
                ) : null}
              </div>
              <Button
                aria-pressed={connectedOnly}
                className="order-2 shrink-0 justify-self-end sm:order-3"
                onClick={() => setConnectedOnly((value) => !value)}
                size="large"
                tone={connectedOnly ? "primary" : "secondary"}
              >
                {t(m.connectedOnly)}
              </Button>
            </>
          ) : null}
        </div>
        {apps.isPending || connections.isPending ? (
          <PageMessage busy>{t(m.loadingConnectors)}</PageMessage>
        ) : apps.error || connections.error ? (
          <div className="py-10 text-center" role="alert">
            <p className="text-sm text-app-danger">
              {apps.error?.message ??
                connections.error?.message ??
                t(m.connectorsUnavailable)}
            </p>
            <Button
              className="mt-3"
              onClick={() =>
                void Promise.all([apps.refetch(), connections.refetch()])
              }
              size="compact"
            >
              {t(commonMessages.retry)}
            </Button>
          </div>
        ) : (
          <>
            {/* Full-width scrollable category tabs with a subtle right-edge fade
                hint so all 8 categories stay reachable on mobile viewports. */}
            <div className="relative min-w-0">
              <UnderlineTabs
                className="w-full min-w-0 pr-8"
                items={filters}
                label={t(m.connectorCategories)}
                onChange={setFilter}
                value={filter}
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-0 right-0 bottom-5 w-8 bg-gradient-to-l from-background to-transparent"
              />
            </div>
            {noSearchMatches ? (
              <div
                className="flex flex-col items-center gap-3 py-12 text-center"
                role="status"
              >
                <p className="text-sm text-muted-foreground">
                  {t(m.noMatchingConnectors, { query: searchQuery.trim() })}
                </p>
                <Button
                  onClick={() => setSearchQuery("")}
                  size="compact"
                  tone="secondary"
                >
                  {t(m.clearSearch)}
                </Button>
              </div>
            ) : !showApps ? null : filteredApps ? (
              filteredApps.length ? (
                <section
                  aria-label={t(m.applicationConnections)}
                  className={APP_GRID_CLASS}
                >
                  {filteredApps.map(renderApp)}
                </section>
              ) : (
                <PageMessage>{t(m.noConnectedApps)}</PageMessage>
              )
            ) : (
              <div aria-label={t(m.applicationConnections)} role="region">
                {visibleGroups.map(({ group, apps: groupApps }) => (
                  <section
                    aria-labelledby={`connector-group-${group.id}`}
                    className="mb-7 last:mb-0"
                    key={group.id}
                  >
                    <h2
                      className="mb-2.5 text-[14px] font-medium text-muted-foreground"
                      id={`connector-group-${group.id}`}
                    >
                      {t(group.title)}
                    </h2>
                    <div className={APP_GRID_CLASS}>
                      {groupApps.map(renderApp)}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {showSearch && !noSearchMatches ? (
              <WebSearchSection
                backends={searchBackends}
                className={showApps ? "mt-7" : undefined}
                heading={!searchFilter}
                list={webSearch}
              />
            ) : null}
          </>
        )}
      </div>

      {selectedApp ? (
        <AppManageDialog
          app={selectedApp}
          connections={visibleConnections.filter(
            (connection) => connection.provider === selectedApp.key,
          )}
          onClose={closeApp}
        />
      ) : null}
    </main>
  );
}

function CatalogAppCard({
  app,
  connections,
  selected,
  onOpen,
}: {
  app: TeamHubExternalApp;
  connections: TeamHubExternalConnection[];
  selected: boolean;
  onOpen: () => void;
}) {
  const t = useT();
  const [disconnecting, setDisconnecting] =
    useState<TeamHubExternalConnection | null>(null);
  const connectFlow = useConnectAppFlow();
  const createConnection = connectFlow.connection;
  const active = activeExternalConnections(connections);
  const pending = openPendingExternalConnection(connections, app.key);
  const canConnect = app.availability === "available";
  const canStart = connectFlow.canStart(app);
  const needsReconnecting = connections.filter(
    externalConnectionNeedsAttention,
  ).length;
  const connectedLabel = !active.length
    ? null
    : active.length === 1
      ? needsReconnecting
        ? t(m.connectedNeedsReconnecting, { count: needsReconnecting })
        : t(m.connected)
      : needsReconnecting
        ? t(m.accountsNeedReconnecting, {
            accounts: active.length,
            count: needsReconnecting,
          })
        : t(m.accountCount, { count: active.length });
  const authorizing =
    createConnection.isPending || Boolean(createConnection.blockedConnectUrl);
  const unconfirmed = connections.some(externalConnectionUnconfirmed);
  const summary =
    connectFlow.configured && app.availability === "unavailable"
      ? t(m.unavailable)
      : authorizing
        ? t(m.authorizing)
        : unconfirmed
          ? t(m.couldNotConfirm)
          : appSummary(app, t);

  return (
    <article
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border bg-card px-4 py-3 transition-colors duration-150 motion-reduce:transition-none",
        selected
          ? "border-border-hover bg-muted"
          : "border-border hover:bg-accent/40",
      )}
    >
      <button
        aria-label={app.display_name}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onOpen}
        type="button"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-card text-foreground shadow-outline">
          <AppLogo name={app.display_name} url={app.logo_url} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">
            {app.display_name}
          </span>
          <span className="mt-0.5 flex min-w-0 items-start gap-1.5 text-xs text-muted-foreground">
            {connectedLabel ? (
              <span
                aria-hidden
                className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--app-status-success-text)]"
              />
            ) : null}
            <span
              className={cn(
                "line-clamp-2 min-w-0",
                !connectedLabel && authorizing && "town-shimmer-text",
              )}
              title={connectedLabel ?? summary}
            >
              {connectedLabel ?? summary}
            </span>
          </span>
        </span>
      </button>
      {canStart && active.length === 0 ? (
        <Button
          aria-label={t(m.connectApp, { app: app.display_name })}
          className="px-2.5"
          disabled={createConnection.isPending}
          onClick={(event) => {
            stopCardClick(event);
            connectFlow.start(app, pending);
          }}
          size="compact"
          tone="secondary"
        >
          {t(m.connect)}
        </Button>
      ) : null}
      {canConnect && active.length === 1 ? (
        // Disconnecting is destructive, so it sits in a menu, not beside Connect.
        <ActionMenu
          items={[
            { label: t(m.manage), onSelect: onOpen },
            {
              danger: true,
              label: t(m.disconnect),
              onSelect: () => setDisconnecting(active[0] ?? null),
            },
          ]}
          label={t(m.actionsFor, { app: app.display_name })}
        />
      ) : null}
      <ConnectAppStatus className="basis-full" flow={connectFlow} />
      {disconnecting ? (
        <DisconnectConnectionDialog
          connection={disconnecting}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
    </article>
  );
}

function PageMessage({
  busy,
  children,
}: {
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <p
      aria-busy={busy}
      className="flex items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground"
      role="status"
    >
      {busy ? <Spinner size={16} /> : null}
      {children}
    </p>
  );
}
