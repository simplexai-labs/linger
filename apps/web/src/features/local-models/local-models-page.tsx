import {
  AiChipIcon,
  Alert02Icon,
  ArrowDown01Icon,
  InformationCircleIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import {
  useMutation,
  useMutationState,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import {
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { AutoHeight } from "@/components/ui/auto-height";
import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/features/local-computer/computer-relative-time";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import {
  anotherMeQueryOptions,
  teamHubIdentityQueryOptions,
  tenantAgentAvailabilityQueryKey,
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryKey,
  tenantAgentsQueryOptions,
} from "@/features/rooms/room-queries";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import { RichMessage, useT, useTranslation } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { ComputerPicker, type ComputerPickerOption } from "./computer-picker";
import {
  readLastModelsComputer,
  writeLastModelsComputer,
} from "./last-models-computer";
import {
  type AssignableLocalModelAgent,
  assignableLocalModelAgents,
  buildLocalModelRuntimeUpdate,
  isAgentUsingModel,
  usedByAgentNames,
} from "./local-model-agents";
import { FeaturedModelSpotlight } from "./featured-model-spotlight";
import { AdvancedDialog } from "./local-model-details";
import { ModelRow } from "./local-model-row";
import {
  MakeRoomDialog,
  RemoveModelDialog,
  UnloadModelDialog,
} from "./local-model-dialogs";
import {
  UpdateDriverDialog,
  type DriverUpdateReason,
} from "./local-model-driver-dialog";
import { useDesktopDriverUpdate } from "./desktop-driver-update";
import {
  actionErrorCopy,
  debugBannerCopy,
  hostBlockerCopy,
  libraryUnavailableCopy,
  memoryGuidanceCopy,
  modelSourceReadErrorCopy,
} from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
import {
  actOnLocalComputerModel,
  invalidateOfflineComputer,
  localModelActionMutationKey,
  localModelsQueryKey,
  localModelsQueryOptions,
  localModelsRefreshMutationKey,
  refreshLocalComputerModels,
  type LocalModelAction,
  type LocalModelActionInput,
  type LocalModelsRefreshAccepted,
  type LocalModelsView,
} from "./local-models-queries";
import {
  buildModelGroups,
  downloadStopped,
  formatGigabytes,
  hasReadyLocalModels,
  hostBlocker,
  joinList,
  loadCheck,
  localSwitchTargets,
  memoryGuidance,
  memorySegments,
  memorySummary,
  modelEntries,
  poolFreeBytes,
  poolOf,
  type ModelCardGroup,
  type ModelEntry,
  type ModelStatus,
} from "./local-models-rules";
import { ByokPanel } from "./byok-panel";
import {
  activeSourceLabel,
  ModelSourceTabs,
  SwitchToLocalNotice,
  useModelSourceSwitch,
} from "./model-source-panel";
import {
  type ModelSourceMode,
  modelSourceQueryKey,
  modelSourceQueryOptions,
  type ModelSourceStatus,
  type ModelSourceView,
} from "./model-source-queries";

const offlinePollIntervalMs = 5_000;

function isModelSourceOffline(
  data: ModelSourceView | undefined,
  error: Error | null,
) {
  return (
    data?.online === false ||
    (error instanceof TeamHubError && error.code === "LOCAL_COMPUTER_OFFLINE")
  );
}

type Dialog =
  | { kind: "advanced" }
  | { kind: "makeRoom"; modelId: string }
  | { kind: "remove"; modelId: string }
  | { kind: "unload"; modelId: string }
  | { kind: "updateDriver"; modelId?: string; reason: DriverUpdateReason };

/**
 * The model states each confirmed action applies to, as the row offers it. A
 * stopped download is failed too but offers none of them.
 */
const actionStatuses: Record<"load" | "remove" | "unload", ModelStatus[]> = {
  load: ["idle", "failed"],
  remove: ["loaded", "idle", "failed"],
  unload: ["loaded"],
};

function computersPath(tenantId: string) {
  return `/t/${tenantId}/settings/computers`;
}

type InventoryComputer = TeamHubLocalComputerPage["items"][number];

/**
 * Where one Computer's Agents get their model, chosen by `?computer=`, and
 * its local model library. Without it the desktop app opens its own Computer
 * and a browser the first one.
 */
export function ModelsPage() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const { data: inventory } = useSuspenseQuery(
    localComputersQueryOptions(client, tenantId),
  );
  const desktop = useDesktopComputer();
  const [searchParams, setSearchParams] = useSearchParams();
  const computers = inventory.items;
  const linkedId = searchParams.get("computer");
  const linkedOwned = linkedId
    ? computers.find((item) => item.computer_id === linkedId)
    : undefined;
  const savedId = readLastModelsComputer(tenantId);
  const savedOwned = savedId
    ? computers.find((item) => item.computer_id === savedId)
    : undefined;
  const desktopOwned = desktop?.status?.computerId
    ? computers.find((item) => item.computer_id === desktop.status?.computerId)
    : undefined;
  const defaultComputer =
    computers.find((item) => item.status === "online") ?? computers[0];
  // A linked Computer the viewer does not own may be another member's: the
  // library API, not the owned inventory, decides whether they may read it.
  const sharedId = linkedId && !linkedOwned ? linkedId : undefined;
  const computer = sharedId
    ? undefined
    : (linkedOwned ?? savedOwned ?? desktopOwned ?? defaultComputer);

  useEffect(() => {
    if (linkedOwned) {
      writeLastModelsComputer(tenantId, linkedOwned.computer_id);
    }
  }, [linkedOwned, tenantId]);

  function select(computerId: string) {
    if (computers.some((item) => item.computer_id === computerId)) {
      writeLastModelsComputer(tenantId, computerId);
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("computer", computerId);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-(--app-settings-width) flex-col pb-4">
      {sharedId ? (
        <ComputerModels
          computerId={sharedId}
          defaultComputerName={defaultComputer?.display_name}
          key={sharedId}
          onOpenDefaultComputer={
            defaultComputer
              ? () => select(defaultComputer.computer_id)
              : undefined
          }
          onSelectComputer={select}
          ownedComputers={computers}
          tenantId={tenantId}
        />
      ) : computer ? (
        <ComputerModels
          computer={computer}
          computerId={computer.computer_id}
          displayName={computer.display_name}
          isLocalDesktop={Boolean(
            desktop?.status?.computerId &&
            desktop.status.computerId === computer.computer_id,
          )}
          key={computer.computer_id}
          onSelectComputer={select}
          ownedComputers={computers}
          tenantId={tenantId}
        />
      ) : (
        <>
          <h1 className="text-2xl text-foreground">{t(m.title)}</h1>
          <EmptyState title={t(m.noComputersTitle)}>
            <RichMessage
              message={m.noComputersBody}
              tags={{
                link: (text) => (
                  <ComputersLink tenantId={tenantId}>{text}</ComputersLink>
                ),
              }}
            />
          </EmptyState>
        </>
      )}
    </main>
  );
}

function EmptyState({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section
      aria-label={title}
      className="mt-6 flex flex-col items-center rounded-xl border border-border bg-card px-6 py-12 text-center"
    >
      <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-foreground shadow-outline">
        <Icon icon={AiChipIcon} size={24} />
      </span>
      <h2 className="mt-5 text-lg text-foreground">{title}</h2>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {children}
      </p>
      {action}
    </section>
  );
}

/** The link to Settings › Computers inside a sentence. */
function ComputersLink({
  children,
  tenantId,
}: {
  children: ReactNode;
  tenantId: string;
}) {
  return (
    <Link
      className="font-medium text-app-link underline-offset-2 hover:underline"
      to={computersPath(tenantId)}
    >
      {children}
    </Link>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div
      className="mt-5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground"
      role="status"
    >
      <Icon
        className="mt-0.5 shrink-0 text-muted-foreground"
        icon={InformationCircleIcon}
        size={16}
      />
      <p className="min-w-0 flex-1">{children}</p>
    </div>
  );
}

const memorySegmentColors = [
  "bg-rain-500",
  "bg-lichen-500",
  "bg-sun-500",
] as const;

function MemorySummaryCard({
  canRecheck,
  onDetails,
  onRecheck,
  rechecking,
  summary,
  view,
}: {
  canRecheck: boolean;
  onDetails: () => void;
  onRecheck: () => void;
  rechecking: boolean;
  summary: ReturnType<typeof memorySummary>;
  view: LocalModelsView;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const { componentBytes, models, otherBytes, unaccountedBytes } =
    memorySegments(view);
  const pct = (bytes: number) =>
    `${summary.totalBytes ? Math.min(100, (bytes / summary.totalBytes) * 100) : 0}%`;

  return (
    <div className="mt-5 rounded-xl border border-border bg-card px-4 py-3.5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium tabular-nums text-foreground">
            {t(summary.gpu ? m.gpuMemoryInUse : m.memoryInUse, {
              total: formatGigabytes(summary.totalBytes, t),
              used: formatGigabytes(summary.usedBytes, t),
            })}
          </p>
          <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
            {view.observed_at
              ? t(m.memoryFreeChecked, {
                  free: formatGigabytes(summary.freeBytes, t),
                  time: relativeTime(view.observed_at, translation),
                })
              : t(m.memoryFree, {
                  free: formatGigabytes(summary.freeBytes, t),
                })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canRecheck ? (
            <Button loading={rechecking} onClick={onRecheck} size="compact">
              {rechecking ? null : <Icon icon={RefreshIcon} size={14} />}
              {t(m.recheckMemory)}
            </Button>
          ) : null}
          <Button onClick={onDetails} size="compact">
            {t(m.details)}
          </Button>
        </div>
      </div>
      <div
        aria-hidden
        className="mt-3 flex h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        {models.map((item, index) => (
          <span
            className={cn(
              "h-full border-r-2 border-card transition-[width] duration-200 last:border-r-0 motion-reduce:transition-none",
              memorySegmentColors[index % memorySegmentColors.length],
            )}
            key={item.id}
            style={{ width: pct(item.bytes) }}
            title={`${item.name} · ${formatGigabytes(item.bytes, t)}`}
          />
        ))}
        {componentBytes > 0 ? (
          <span
            className="h-full border-r-2 border-card bg-muted-foreground/45 transition-[width] duration-200 last:border-r-0 motion-reduce:transition-none"
            style={{ width: pct(componentBytes) }}
          />
        ) : null}
        {otherBytes > 0 ? (
          <span
            className="h-full bg-muted-foreground/25 transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: pct(otherBytes) }}
            title={t(m.otherAppsSize, {
              size: formatGigabytes(otherBytes, t),
            })}
          />
        ) : null}
        {unaccountedBytes > 0 ? (
          <span
            className="h-full bg-muted-foreground/15 transition-[width] duration-200 motion-reduce:transition-none"
            style={{ width: pct(unaccountedBytes) }}
            title={t(m.systemAndEngineSize, {
              size: formatGigabytes(unaccountedBytes, t),
            })}
          />
        ) : null}
      </div>
    </div>
  );
}

function ModelsLoadingSkeleton({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="mt-5 space-y-3" role="status">
      <span className="sr-only">{label}</span>
      <div className="rounded-xl border border-border bg-card px-4 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-2">
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-3 w-36" />
          </div>
          <div className="flex gap-2">
            <Skeleton className="h-7 w-28 rounded-full" />
            <Skeleton className="h-7 w-16 rounded-full" />
          </div>
        </div>
        <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
      </div>
      <div className="space-y-2">
        {[0, 1, 2].map((index) => (
          <div
            className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
            key={index}
          >
            <Skeleton className="size-10 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-52" />
            </div>
            <Skeleton className="h-7 w-20 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

function ComputerModels({
  computer,
  computerId,
  defaultComputerName,
  displayName,
  isLocalDesktop = false,
  onOpenDefaultComputer,
  onSelectComputer,
  ownedComputers,
  tenantId,
}: {
  computer?: InventoryComputer;
  computerId: string;
  defaultComputerName?: string;
  /** Absent for a Computer outside the viewer's own inventory. */
  displayName?: string;
  isLocalDesktop?: boolean;
  onOpenDefaultComputer?: () => void;
  onSelectComputer: (computerId: string) => void;
  ownedComputers: readonly InventoryComputer[];
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  // Only the owner switches sources, and only their own Computers carry a
  // display name here.
  const hasOwnedSource = displayName !== undefined;
  const source = useQuery({
    ...modelSourceQueryOptions(client, tenantId, computerId),
    enabled: hasOwnedSource,
    refetchInterval: (state) =>
      isModelSourceOffline(state.state.data, state.state.error)
        ? offlinePollIntervalMs
        : false,
  });
  const sourceOffline = isModelSourceOffline(source.data, source.error);
  const query = useQuery({
    ...localModelsQueryOptions(client, tenantId, computerId),
    refetchInterval: (state) =>
      state.state.data?.computer.status === "offline" || sourceOffline
        ? offlinePollIntervalMs
        : false,
  });
  const view = query.data;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const summary = view?.available ? memorySummary(view) : undefined;
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const reportedOffline = view
    ? view.computer.status === "offline"
    : computer?.status === "offline";
  const offline = reportedOffline || sourceOffline;
  const [wasOffline, setWasOffline] = useState(offline);
  if (wasOffline !== offline) {
    setWasOffline(offline);
    if (!offline) {
      setRefreshError(null);
    }
  }
  const previousInventoryStatusRef = useRef(computer?.status);
  useEffect(() => {
    const nextStatus = computer?.status;
    if (
      previousInventoryStatusRef.current !== undefined &&
      nextStatus !== undefined &&
      previousInventoryStatusRef.current !== nextStatus
    ) {
      void queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      });
      if (hasOwnedSource) {
        void queryClient.invalidateQueries({
          queryKey: modelSourceQueryKey(tenantId, computerId),
        });
      }
    }
    previousInventoryStatusRef.current = nextStatus;
  }, [computer?.status, computerId, hasOwnedSource, queryClient, tenantId]);
  const onlineRefetchTriggeredRef = useRef(false);
  useEffect(() => {
    if (
      hasOwnedSource &&
      !reportedOffline &&
      sourceOffline &&
      !source.isFetching &&
      !onlineRefetchTriggeredRef.current
    ) {
      onlineRefetchTriggeredRef.current = true;
      void queryClient.invalidateQueries({
        queryKey: modelSourceQueryKey(tenantId, computerId),
      });
      return;
    }
    if ((!sourceOffline && source.data?.online) || reportedOffline) {
      onlineRefetchTriggeredRef.current = false;
    }
  }, [
    computerId,
    hasOwnedSource,
    queryClient,
    reportedOffline,
    source.data?.online,
    source.isFetching,
    sourceOffline,
    tenantId,
  ]);
  const status = source.data?.status;
  const [tab, setTab] = useState<ModelSourceMode | null>(null);
  // A Computer on a subscription opens on Local model, which offers the way
  // off it; the Subscription tab is not offered.
  const shownTab = tab ?? (status?.mode === "byok" ? "byok" : "local");
  const computerName =
    displayName ?? view?.computer.display_name ?? t(m.thisComputer);
  const { feedback, switcher } = useModelSourceSwitch({
    computerId,
    computerName,
    tenantId,
  });
  const switching = switcher.pending !== undefined;
  const switchTargets = view?.available ? localSwitchTargets(view) : [];
  const refresh = useMutation<
    LocalModelsRefreshAccepted,
    Error,
    { automatic?: boolean; reconnected?: boolean } | undefined
  >({
    mutationFn: () => refreshLocalComputerModels(client, tenantId, computerId),
    mutationKey: localModelsRefreshMutationKey(tenantId, computerId),
    onError: (error, options) => {
      const code =
        error instanceof TeamHubError ? error.code : "REFRESH_FAILED";
      if (!options?.automatic) {
        setRefreshError(code);
      }
      if (code === "LOCAL_COMPUTER_OFFLINE") {
        return invalidateOfflineComputer(queryClient, tenantId, computerId);
      }
      return undefined;
    },
    onMutate: () => setRefreshError(null),
    onSettled: (_data, error) => {
      if (
        error instanceof TeamHubError &&
        error.code === "LOCAL_COMPUTER_OFFLINE"
      ) {
        return undefined;
      }
      return queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      });
    },
    onSuccess: (_data, options) => {
      if (options?.reconnected && hasOwnedSource) {
        void queryClient.invalidateQueries({
          queryKey: modelSourceQueryKey(tenantId, computerId),
        });
      }
    },
  });
  const { mutate: triggerRefresh } = refresh;
  function recheckMemory() {
    if (refresh.isPending) return;
    triggerRefresh(undefined);
  }
  const canRecheck = Boolean(
    view?.available && view.viewer_is_owner && !offline,
  );
  const autoRefreshRef = useRef({
    computerId,
    didMountRefresh: false,
    wasOffline: false,
  });
  useEffect(() => {
    if (autoRefreshRef.current.computerId !== computerId) {
      autoRefreshRef.current = {
        computerId,
        didMountRefresh: false,
        wasOffline: false,
      };
    }
    if (offline) {
      autoRefreshRef.current.wasOffline = true;
      return;
    }
    if (!canRecheck) return;
    if (
      autoRefreshRef.current.didMountRefresh &&
      !autoRefreshRef.current.wasOffline
    ) {
      return;
    }
    const reconnected = autoRefreshRef.current.wasOffline;
    autoRefreshRef.current.didMountRefresh = true;
    autoRefreshRef.current.wasOffline = false;
    triggerRefresh({ automatic: true, reconnected });
  }, [canRecheck, computerId, offline, triggerRefresh]);
  const blocker = view?.available ? hostBlocker(view) : null;
  const guidance = view?.available && !blocker ? memoryGuidance(view) : null;
  const queryErrorCode =
    query.error instanceof TeamHubError ? query.error.code : undefined;
  const showComputerPicker =
    displayName !== undefined
      ? ownedComputers.length > 1
      : Boolean(view && ownedComputers.length > 0);
  const computerPickerOptions: ComputerPickerOption[] = [
    ...(displayName === undefined && view
      ? [
          {
            computerId,
            displayName: view.computer.display_name,
            online: view.computer.status === "online",
          },
        ]
      : []),
    ...ownedComputers.map((item) => ({
      computerId: item.computer_id,
      displayName: item.display_name,
      online: item.status === "online",
    })),
  ];
  const computerPicker = showComputerPicker ? (
    <ComputerPicker
      onSelect={onSelectComputer}
      options={computerPickerOptions}
      value={computerId}
    />
  ) : null;

  function changeTab(next: ModelSourceMode) {
    setTab(next);
    setRefreshError(null);
    switcher.clearFeedback();
  }

  const hasMemorySummary = Boolean(view?.available && summary?.totalBytes);
  const showHeaderUtilities =
    Boolean(view?.available) &&
    !(shownTab === "local" && hasMemorySummary) &&
    shownTab !== "byok";

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 sm:gap-4">
        <div className="min-w-48 flex-1">
          <h1 className="text-2xl text-foreground">{t(m.title)}</h1>
          {status ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t(m.agentsUse, {
                computer: computerName,
                source: activeSourceLabel(status, t),
              })}
            </p>
          ) : null}
        </div>
        {computerPicker || showHeaderUtilities ? (
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            {computerPicker}
            {showHeaderUtilities && canRecheck ? (
              <Button
                loading={refresh.isPending}
                onClick={recheckMemory}
                size="compact"
              >
                {refresh.isPending ? null : (
                  <Icon icon={RefreshIcon} size={14} />
                )}
                {t(m.recheckMemory)}
              </Button>
            ) : null}
            {showHeaderUtilities ? (
              <Button
                onClick={() => setDialog({ kind: "advanced" })}
                size="compact"
              >
                {t(m.details)}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      {status ? (
        <ModelSourceTabs
          active={status.mode}
          onChange={changeTab}
          value={shownTab}
        />
      ) : null}
      {source.isError && !switcher.failure && !offline ? (
        <div className="mt-4">
          <FormFeedback tone="danger">
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {modelSourceReadErrorCopy(
                  source.error instanceof TeamHubError
                    ? source.error.code
                    : undefined,
                  t,
                )}
              </span>
              <button
                className="font-medium underline underline-offset-2 disabled:opacity-50"
                disabled={source.isFetching}
                onClick={() => void source.refetch()}
                type="button"
              >
                {t(source.isFetching ? m.retrying : commonMessages.retry)}
              </button>
            </span>
          </FormFeedback>
        </div>
      ) : null}
      {switcher.failure ? (
        <div className="mt-4">
          <FormFeedback tone="danger">{switcher.failure}</FormFeedback>
        </div>
      ) : null}
      {refreshError ? (
        <div className="mt-4">
          <FormFeedback tone="danger">
            {actionErrorCopy(refreshError, t)}
          </FormFeedback>
        </div>
      ) : null}
      {switching ? (
        <p className="mt-4 text-sm text-muted-foreground" role="status">
          {t(m.switchingComputer, { computer: computerName })}
        </p>
      ) : null}
      {feedback}
      {status && shownTab === "byok" ? (
        <>
          {offline && view ? (
            <Notice>
              <OfflineMessage
                lastSeenAt={view.computer.last_seen_at}
                messages={[m.offlineByok, m.offlineByokLastSeen]}
                name={view.computer.display_name}
                tenantId={tenantId}
              />
            </Notice>
          ) : null}
          <ByokPanel
            computerId={computerId}
            disabled={switching || offline}
            key={`${status.mode}:${switcher.saveRevision}`}
            status={status}
            switcher={switcher}
            tenantId={tenantId}
          />
        </>
      ) : view ? (
        <>
          {view.available && summary?.totalBytes ? (
            <MemorySummaryCard
              canRecheck={canRecheck}
              onDetails={() => setDialog({ kind: "advanced" })}
              onRecheck={recheckMemory}
              rechecking={refresh.isPending}
              summary={summary}
              view={view}
            />
          ) : null}
          {status && status.mode !== "local" ? (
            <SwitchToLocalNotice
              disabled={switching || offline}
              models={switchTargets}
              switcher={switcher}
            />
          ) : null}
          <Library
            blocker={blocker}
            computer={computer}
            dialog={dialog}
            guidance={guidance}
            isLocalDesktop={isLocalDesktop}
            offline={offline}
            onRefresh={recheckMemory}
            onSwitchToByok={status ? () => changeTab("byok") : undefined}
            onUseForAgents={(modelId) =>
              switcher.request({ local_model_id: modelId, mode: "local" })
            }
            rechecking={refresh.isPending}
            setDialog={setDialog}
            status={status}
            switchingModelId={
              switcher.pending?.mode === "local"
                ? switcher.pending.local_model_id
                : undefined
            }
            switching={switching}
            tenantId={tenantId}
            view={view}
          />
        </>
      ) : query.isError ? (
        <EmptyState
          action={
            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
              {onOpenDefaultComputer ? (
                <Button
                  onClick={onOpenDefaultComputer}
                  size="compact"
                  tone="primary"
                >
                  {defaultComputerName
                    ? t(m.openComputer, { name: defaultComputerName })
                    : t(m.openMyComputers)}
                </Button>
              ) : null}
              <Button onClick={() => void query.refetch()} size="compact">
                {t(commonMessages.tryAgain)}
              </Button>
            </div>
          }
          title={
            displayName === undefined
              ? t(m.loadFailedTitleThisComputer)
              : t(m.loadFailedTitle, { name: displayName })
          }
        >
          {actionErrorCopy(queryErrorCode, t)}
        </EmptyState>
      ) : (
        <ModelsLoadingSkeleton label={t(m.loadingModels)} />
      )}
    </>
  );
}

/**
 * A Computer is offline, with when it was last seen once known. `messages`
 * holds the sentence without and with that time.
 */
function OfflineMessage({
  lastSeenAt,
  messages,
  name,
  tenantId,
}: {
  lastSeenAt: string | null | undefined;
  messages:
    | readonly [typeof m.offlineByok, typeof m.offlineByokLastSeen]
    | readonly [typeof m.offlineLibrary, typeof m.offlineLibraryLastSeen]
    | readonly [typeof m.offlineReadOnly, typeof m.offlineReadOnlyLastSeen];
  name: string;
  tenantId: string;
}) {
  const translation = useTranslation();
  const tags = {
    link: (text: ReactNode) => (
      <ComputersLink tenantId={tenantId}>{text}</ComputersLink>
    ),
    strong: (text: ReactNode) => (
      <span className="text-foreground">{text}</span>
    ),
  };
  return lastSeenAt ? (
    <RichMessage
      message={messages[1]}
      tags={tags}
      values={{ name, time: relativeTime(lastSeenAt, translation) }}
    />
  ) : (
    <RichMessage message={messages[0]} tags={tags} values={{ name }} />
  );
}

function Library({
  blocker,
  computer,
  dialog,
  guidance,
  isLocalDesktop = false,
  offline: computerOffline,
  onRefresh,
  onSwitchToByok,
  onUseForAgents,
  rechecking,
  setDialog,
  status,
  switching,
  switchingModelId,
  tenantId,
  view,
}: {
  blocker: ReturnType<typeof hostBlocker>;
  computer?: InventoryComputer;
  dialog: Dialog | null;
  guidance: ReturnType<typeof memoryGuidance>;
  isLocalDesktop?: boolean;
  offline: boolean;
  onRefresh: () => void;
  onSwitchToByok?: () => void;
  onUseForAgents: (modelId: string) => void;
  rechecking: boolean;
  setDialog: (dialog: Dialog | null) => void;
  status: ModelSourceStatus | undefined;
  switching: boolean;
  switchingModelId: string | undefined;
  tenantId: string;
  view: LocalModelsView;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const computerId = view.computer.computer_id;
  const name = view.computer.display_name;
  const offline = computerOffline || view.computer.status === "offline";
  const readOnly = !view.viewer_is_owner;
  const canManageAgents = !readOnly;
  const piReady =
    !computer ||
    computer.runtimes.some(
      (runtime) => runtime.type === "pi" && runtime.status === "ready",
    );
  const canSwitchAgents =
    !offline &&
    canManageAgents &&
    piReady &&
    (!status?.mode || status.mode === "local");
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedVariants, setSelectedVariants] = useState<
    Record<string, string>
  >({});
  const [unavailableOpen, setUnavailableOpen] = useState(false);
  const unavailablePanelId = useId();
  const [failure, setFailure] = useState<{
    code?: string;
    modelId: string;
  } | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<{
    agentIds: string[];
    modelId: string;
  } | null>(null);
  const completedSwitchKeyRef = useRef<string | null>(null);
  // An action the Computer accepted, shown on its row until a snapshot moves
  // the model on: a different status, error, or a newer snapshot.
  const [accepted, setAccepted] = useState<
    Record<
      string,
      {
        action: LocalModelAction;
        errorCode?: string;
        from?: ModelStatus;
        observedAt?: string;
      }
    >
  >({});
  const identityQuery = useQuery({
    ...teamHubIdentityQueryOptions(client),
    enabled: canManageAgents,
  });
  const anotherMeQuery = useQuery({
    ...anotherMeQueryOptions(client, tenantId),
    enabled: canManageAgents,
  });
  const agentsQuery = useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    enabled: canManageAgents,
  });
  const availabilityQuery = useQuery({
    ...tenantAgentAvailabilityQueryOptions(client, tenantId),
    enabled: canManageAgents,
  });
  const currentActorId = identityQuery.data?.actors.find(
    (candidate) => candidate.tenant_id === tenantId,
  )?.id;
  const assignableAgents = useMemo(
    () =>
      canManageAgents
        ? assignableLocalModelAgents({
            agents: agentsQuery.data?.items,
            anotherMeActorId: anotherMeQuery.data?.agent_actor_id,
            availability: availabilityQuery.data?.items,
            computer,
            computerId,
            currentActorId,
          })
        : [],
    [
      agentsQuery.data?.items,
      anotherMeQuery.data?.agent_actor_id,
      availabilityQuery.data?.items,
      canManageAgents,
      computer,
      computerId,
      currentActorId,
    ],
  );
  const anotherMeChatHref = anotherMeQuery.data?.room_id
    ? `/t/${encodeURIComponent(tenantId)}/rooms/${encodeURIComponent(anotherMeQuery.data.room_id)}/chat`
    : undefined;
  const entries = useMemo(
    () => (view.available ? modelEntries(view) : []),
    [view],
  );
  const sections = useMemo(() => buildModelGroups(entries), [entries]);
  const hasUsableModels =
    sections.onComputer.length > 0 ||
    sections.available.length > 0 ||
    Boolean(
      sections.spotlight &&
      sections.spotlight.defaultEntry.status !== "unavailable",
    );
  const showUnavailable = !hasUsableModels || unavailableOpen;
  const find = (modelId: string) =>
    entries.find((entry) => entry.model.id === modelId);
  const mutationKey = localModelActionMutationKey(tenantId, computerId);
  const action = useMutation({
    mutationFn: (input: LocalModelActionInput) =>
      actOnLocalComputerModel(client, tenantId, computerId, input),
    mutationKey,
    onError: (error, input) => {
      setFailure({
        code: error instanceof TeamHubError ? error.code : undefined,
        modelId: input.modelId,
      });
      setPendingSwitch((current) =>
        current?.modelId === input.modelId ? null : current,
      );
    },
    onMutate: (input) => {
      setFailure(null);
      const current = find(input.modelId);
      return {
        errorCode: current?.model.error?.code,
        from: current?.status,
        observedAt: view.observed_at,
      };
    },
    onSuccess: (_result, input, started) =>
      setAccepted((current) => ({
        ...current,
        [input.modelId]: {
          action: input.action,
          errorCode: started?.errorCode,
          from: started?.from,
          observedAt: started?.observedAt,
        },
      })),
    // The Computer answers at once; a fresh read shows what it started even
    // before its next snapshot hint.
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: localModelsQueryKey(tenantId, computerId),
      }),
  });
  const assignMutation = useMutation({
    mutationFn: ({
      agent,
      piModel,
    }: {
      agent: AssignableLocalModelAgent;
      piModel: string;
      preserveError?: boolean;
    }) =>
      teamHubData(
        client.api.PATCH("/v0/tenants/{tenantId}/agents/{agentId}", {
          body: {
            expected_configuration_revision: agent.configurationRevision,
            runtime: buildLocalModelRuntimeUpdate(
              agent,
              piModel,
              computerId,
              computer,
            ),
          },
          params: { path: { agentId: agent.actorId, tenantId } },
        }),
      ),
    onError: (error, variables) => {
      if (!variables.preserveError) {
        setAssignError(
          error instanceof Error ? error.message : translate(m.assignFailed),
        );
      }
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentAvailabilityQueryKey(tenantId),
        }),
      ]);
    },
    onMutate: (variables) => {
      if (!variables.preserveError) {
        setAssignError(null);
      }
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(
        tenantAgentsQueryKey(tenantId),
        (current: { items: TeamHubTenantAgent[] } | undefined) =>
          current
            ? {
                ...current,
                items: current.items.map((item) =>
                  item.actor.id === updated.actor.id
                    ? { ...item, ...updated }
                    : item,
                ),
              }
            : current,
      );
      queryClient.setQueryData(
        localModelsQueryKey(tenantId, computerId),
        (current: LocalModelsView | undefined) => {
          if (!current?.available) return current;
          const placement =
            updated.runtime.placement?.type === "local"
              ? updated.runtime.placement
              : undefined;
          const onThisComputerPi =
            placement?.computer_id === computerId &&
            placement.runtime_type === "pi";
          return {
            ...current,
            models: current.models.map((item) => {
              const without = item.used_by.filter(
                (user) => user.agent_id !== updated.agent_management_id,
              );
              const matches =
                onThisComputerPi &&
                Boolean(item.model.pi_model) &&
                item.model.pi_model === updated.runtime.model;
              return {
                ...item,
                used_by: matches
                  ? [
                      ...without,
                      {
                        agent_id: updated.agent_management_id,
                        name: updated.actor.display_name,
                      },
                    ]
                  : without,
              };
            }),
          };
        },
      );
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: localModelsQueryKey(tenantId, computerId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentAvailabilityQueryKey(tenantId),
        }),
      ]);
    },
  });
  const { mutateAsync: applyAgentAssignment } = assignMutation;
  const assigningAgentId = assignMutation.isPending
    ? assignMutation.variables?.agent.actorId
    : undefined;
  const sending = useMutationState({
    filters: { mutationKey, status: "pending" },
    select: (mutation) =>
      mutation.state.variables as LocalModelActionInput | undefined,
  });
  // The action each row shows as under way: one being sent, or one accepted
  // that no snapshot reflects yet. Offline snapshots stay as last reported.
  const requests = new Map<string, LocalModelAction>();
  if (!offline) {
    for (const [modelId, request] of Object.entries(accepted)) {
      const current = find(modelId);
      if (
        request.observedAt === view.observed_at &&
        request.from === current?.status &&
        request.errorCode === current?.model.error?.code
      )
        requests.set(modelId, request.action);
    }
  }
  for (const input of sending) {
    if (input) requests.set(input.modelId, input.action);
  }
  // A download the Computer accepted is a job it can cancel before the
  // first progress reaches a snapshot; every other request holds the row.
  const busy = (modelId: string) =>
    requests.has(modelId) &&
    (requests.get(modelId) !== "download" ||
      sending.some((input) => input?.modelId === modelId));
  const pendingLoadInFlight = pendingSwitch
    ? requests.get(pendingSwitch.modelId) === "load"
    : false;
  useEffect(() => {
    if (!pendingSwitch) return;
    const target = entries.find(
      (entry) => entry.model.id === pendingSwitch.modelId,
    );
    if (
      !target ||
      (!pendingLoadInFlight &&
        (target.status === "failed" ||
          target.status === "available" ||
          target.status === "unavailable"))
    ) {
      setPendingSwitch(null);
      return;
    }
    if (target.status !== "loaded" || !target.model.pi_model) return;
    const key = `${pendingSwitch.modelId}:${view.observed_at ?? ""}:${pendingSwitch.agentIds.join(",")}`;
    if (completedSwitchKeyRef.current === key) return;
    completedSwitchKeyRef.current = key;
    const piModel = target.model.pi_model;
    const matching = assignableAgents.filter(
      (agent) =>
        pendingSwitch.agentIds.includes(agent.actorId) &&
        !isAgentUsingModel(target, agent, computerId),
    );
    const busySkipped = matching.filter((agent) => agent.busy);
    const targets = matching.filter((agent) => !agent.busy);
    setPendingSwitch(null);
    const busyMessage = busySkipped.length
      ? translate(m.assignBusy, {
          agents: joinList(
            busySkipped.map((agent) => agent.name),
            translate,
          ),
          model: target.model.name,
        })
      : null;
    if (busyMessage) {
      setAssignError(busyMessage);
    }
    if (!targets.length) return;
    void Promise.allSettled(
      targets.map((agent) =>
        applyAgentAssignment({ agent, piModel, preserveError: true }),
      ),
    ).then((results) => {
      const failedNames = targets
        .filter((_, index) => results[index]?.status === "rejected")
        .map((agent) => agent.name);
      const failureMessage = failedNames.length
        ? translate(m.assignFailedNamed, {
            agents: joinList(failedNames, translate),
            model: target.model.name,
          })
        : null;
      const combined =
        busyMessage && failureMessage
          ? translate(m.sentences, {
              first: busyMessage,
              second: failureMessage,
            })
          : (busyMessage ?? failureMessage);
      if (combined) setAssignError(combined);
    });
  }, [
    applyAgentAssignment,
    assignableAgents,
    computerId,
    entries,
    pendingLoadInFlight,
    pendingSwitch,
    view.observed_at,
  ]);
  // A dialog stays open across snapshots, so its confirm checks the model
  // and Computer as they are now, the way the row's buttons do.
  const confirmable = (
    entry: ModelEntry,
    action: "load" | "remove" | "unload",
  ) =>
    !offline &&
    !readOnly &&
    !requests.has(entry.model.id) &&
    !downloadStopped(entry.model) &&
    actionStatuses[action].includes(entry.status);
  const dialogEntry =
    dialog && "modelId" in dialog && dialog.modelId
      ? find(dialog.modelId)
      : undefined;
  const dialogPool = dialogEntry
    ? poolOf(view, dialogEntry.model.pool)
    : undefined;
  const makeRoom =
    dialog?.kind === "makeRoom" && dialogEntry
      ? (loadCheck(view, dialogEntry.model) ??
        (dialogPool
          ? {
              freeBytes: poolFreeBytes(dialogPool),
              kept: [],
              loaded: [],
              needBytes: dialogEntry.model.memory_bytes,
              pool: dialogPool,
            }
          : null))
      : null;
  const failedEntry = failure ? find(failure.modelId) : undefined;
  const debugCopy =
    view.available && view.debug ? debugBannerCopy(view.debug, t) : undefined;
  const blockerCopy =
    view.available && blocker ? hostBlockerCopy(blocker, t) : undefined;
  const guidanceCopy =
    !offline && view.available && guidance
      ? memoryGuidanceCopy(guidance, t)
      : undefined;

  function act(input: LocalModelActionInput) {
    setDialog(null);
    if (
      (input.action === "cancel" ||
        input.action === "remove" ||
        input.action === "unload") &&
      pendingSwitch?.modelId === input.modelId
    ) {
      setPendingSwitch(null);
    }
    action.mutate(input);
  }

  function load(entry: ModelEntry) {
    if (loadCheck(view, entry.model))
      setDialog({ kind: "makeRoom", modelId: entry.model.id });
    else act({ action: "load", modelId: entry.model.id });
  }

  function unload(entry: ModelEntry) {
    if (usedByAgentNames(entry, assignableAgents, computerId).length)
      setDialog({ kind: "unload", modelId: entry.model.id });
    else act({ action: "unload", modelId: entry.model.id });
  }

  const unavailable = view.available
    ? undefined
    : libraryUnavailableCopy(view.reason?.code, name, t);
  const canRetryUnavailable =
    !offline && !readOnly && view.reason?.code === "TOOL_FAILED";
  const pendingSwitchTarget = pendingSwitch
    ? find(pendingSwitch.modelId)
    : undefined;
  const pendingSwitchNames: string[] = [];
  if (pendingSwitch) {
    const pendingIds = new Set(pendingSwitch.agentIds);
    for (const agent of assignableAgents) {
      if (pendingIds.has(agent.actorId)) pendingSwitchNames.push(agent.name);
    }
  }

  const canUseModelForAgents = (entry: ModelEntry) =>
    !offline &&
    !readOnly &&
    status?.mode === "local" &&
    entry.status === "loaded" &&
    entry.model.pi_model !== status.runtime_model &&
    entry.model.id !== status.runtime_model;

  const hasReadyModels = hasReadyLocalModels(entries);
  const desktopDriver = useDesktopDriverUpdate(
    isLocalDesktop && !offline && !readOnly,
  );
  const driverInstallState = desktopDriver?.installState;
  const [driverBannerDismissed, setDriverBannerDismissed] = useState(false);
  const resumedDriverVersionRef = useRef<string | null>(null);
  const onRefreshRef = useRef(onRefresh);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (
      !isLocalDesktop ||
      offline ||
      readOnly ||
      driverInstallState?.phase !== "completed"
    ) {
      return;
    }
    if (resumedDriverVersionRef.current === driverInstallState.version) return;
    resumedDriverVersionRef.current = driverInstallState.version;
    onRefreshRef.current();
  }, [driverInstallState, isLocalDesktop, offline, readOnly]);

  const resumeModelEntry =
    driverInstallState?.phase === "completed" &&
    driverInstallState.resumeModelId
      ? find(driverInstallState.resumeModelId)
      : undefined;
  const resumeModelDownloadable = Boolean(
    resumeModelEntry &&
    resumeModelEntry.model.state === "absent" &&
    resumeModelEntry.model.availability.downloadable,
  );
  const showDriverResumeBanner =
    !driverBannerDismissed &&
    (driverInstallState?.phase === "completed" ||
      driverInstallState?.phase === "reboot_required");

  function dismissDriverBanner() {
    setDriverBannerDismissed(true);
    void desktopDriver?.api.clearInstallState?.().catch(() => undefined);
  }

  const renderModelGroup = (group: ModelCardGroup, inSpotlight = false) => {
    const selectedId = selectedVariants[group.key];
    const entry =
      (selectedId
        ? group.variants.find((variant) => variant.model.id === selectedId)
        : undefined) ?? group.defaultEntry;
    const modelId = entry.model.id;
    const canUseForAgents = canUseModelForAgents(entry);
    const driverReason =
      entry.status === "unavailable" &&
      entry.model.availability.reason?.code === "DRIVER_UPDATE_REQUIRED"
        ? entry.model.availability.reason
        : undefined;
    return (
      <ModelRow
        anotherMeChatHref={anotherMeChatHref}
        assignableAgents={assignableAgents}
        assigningAgentId={assigningAgentId}
        computer={computer}
        disabled={offline || readOnly || switching || busy(modelId)}
        entry={entry}
        expanded={expandedKey === group.key}
        hasReadyAlternatives={hasReadyModels}
        inSpotlight={inSpotlight}
        key={group.key}
        onAssignAgent={
          entry.model.pi_model && canSwitchAgents
            ? (agent) =>
                assignMutation.mutate({
                  agent,
                  piModel: entry.model.pi_model!,
                })
            : undefined
        }
        onCancel={() => act({ action: "cancel", modelId })}
        onDownload={() => act({ action: "download", modelId })}
        onLoad={() => load(entry)}
        onRecheck={!offline && !readOnly ? onRefresh : undefined}
        onRemove={() => setDialog({ kind: "remove", modelId })}
        onSelectVariant={
          group.variants.length > 1
            ? (nextModelId) =>
                setSelectedVariants((current) => ({
                  ...current,
                  [group.key]: nextModelId,
                }))
            : undefined
        }
        onToggle={() =>
          setExpandedKey((current) =>
            current === group.key ? null : group.key,
          )
        }
        onUnload={() => unload(entry)}
        onUpdateDriver={
          driverReason
            ? () =>
                setDialog({
                  kind: "updateDriver",
                  modelId,
                  reason: driverReason,
                })
            : undefined
        }
        onUseForAgents={
          canUseForAgents ? () => onUseForAgents(modelId) : undefined
        }
        rechecking={rechecking}
        requested={requests.get(modelId)}
        showEngineBadge={sections.showEngineBadge}
        switchingForAgents={switchingModelId === modelId}
        variants={group.variants}
        view={view}
      />
    );
  };

  const spotlightNode = (
    <FeaturedModelSpotlight>
      {sections.spotlight ? renderModelGroup(sections.spotlight, true) : null}
    </FeaturedModelSpotlight>
  );
  const unavailableLabel = t(
    sections.unavailableAllMemory
      ? m.sectionNeedsMoreMemory
      : m.sectionUnavailable,
    { count: sections.unavailable.length },
  );

  return (
    <>
      {offline ? (
        <Notice>
          <OfflineMessage
            lastSeenAt={view.computer.last_seen_at}
            messages={
              readOnly
                ? [m.offlineReadOnly, m.offlineReadOnlyLastSeen]
                : [m.offlineLibrary, m.offlineLibraryLastSeen]
            }
            name={name}
            tenantId={tenantId}
          />
        </Notice>
      ) : null}
      {readOnly ? <Notice>{t(m.readOnlyNotice, { name })}</Notice> : null}

      {unavailable ? (
        <EmptyState
          action={
            canRetryUnavailable ? (
              <Button
                className="mt-6"
                loading={rechecking}
                onClick={onRefresh}
                size="compact"
              >
                {t(commonMessages.tryAgain)}
              </Button>
            ) : undefined
          }
          title={unavailable.title}
        >
          {unavailable.body}
        </EmptyState>
      ) : (
        <>
          {failure ? (
            <div className="mt-6">
              <FormFeedback tone="danger">
                {failedEntry
                  ? t(m.modelFailure, {
                      name: failedEntry.model.name,
                      reason: actionErrorCopy(failure.code, t),
                    })
                  : actionErrorCopy(failure.code, t)}
              </FormFeedback>
            </div>
          ) : null}
          {assignError ? (
            <div className="mt-6">
              <FormFeedback tone="danger">{assignError}</FormFeedback>
            </div>
          ) : null}
          {pendingSwitchTarget && pendingSwitchNames.length ? (
            <div className="mt-6">
              <FormFeedback tone="info">
                {t(m.willSwitch, {
                  agents: joinList(pendingSwitchNames, t),
                  model: pendingSwitchTarget.model.name,
                })}
              </FormFeedback>
            </div>
          ) : null}
          {showDriverResumeBanner && driverInstallState ? (
            <aside
              aria-label={t(m.driverResumeBannerRegion)}
              className={cn(
                "mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center",
                driverInstallState.phase === "completed"
                  ? "border-[var(--app-status-success-border)] bg-[var(--app-status-success-surface)]"
                  : "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)]",
              )}
            >
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-sm font-medium",
                    driverInstallState.phase === "completed"
                      ? "text-app-success"
                      : "text-app-warning",
                  )}
                >
                  {driverInstallState.phase === "completed"
                    ? t(m.driverResumeReadyTitle, {
                        version: driverInstallState.version,
                      })
                    : t(m.driverResumeRebootTitle)}
                </p>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {driverInstallState.phase === "completed"
                    ? resumeModelEntry && resumeModelDownloadable
                      ? t(m.driverResumeReadyModelBody, {
                          model: resumeModelEntry.model.name,
                        })
                      : t(m.driverResumeReadyBody)
                    : t(m.driverResumeRebootBody, {
                        version: driverInstallState.version,
                      })}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {driverInstallState.phase === "completed" &&
                resumeModelEntry &&
                resumeModelDownloadable ? (
                  <Button
                    onClick={() => {
                      dismissDriverBanner();
                      act({
                        action: "download",
                        modelId: resumeModelEntry.model.id,
                      });
                    }}
                    size="compact"
                    tone="primary"
                  >
                    {t(m.driverResumeDownloadModel, {
                      model: resumeModelEntry.model.name,
                    })}
                  </Button>
                ) : null}
                <Button
                  data-voice-close
                  onClick={dismissDriverBanner}
                  size="compact"
                  tone="secondary"
                >
                  {t(m.driverResumeDismiss)}
                </Button>
              </div>
            </aside>
          ) : null}
          {debugCopy ? (
            <aside
              aria-label={t(m.debugBannerRegion)}
              className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] px-4 py-3.5 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <Icon
                  className="mt-0.5 shrink-0 text-app-warning"
                  icon={Alert02Icon}
                  size={16}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-app-warning">
                    {debugCopy.title}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {debugCopy.body}
                  </p>
                </div>
              </div>
            </aside>
          ) : null}
          {blocker && blockerCopy ? (
            <aside
              aria-label={t(m.hostBlockerRegion)}
              className={cn(
                "mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border px-4 py-3.5 sm:flex-row sm:items-center",
                blocker.code === "GPU_UNSUPPORTED"
                  ? "border-border bg-muted/60"
                  : "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)]",
              )}
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <Icon
                  className={cn(
                    "mt-0.5 shrink-0",
                    blocker.code === "GPU_UNSUPPORTED"
                      ? "text-muted-foreground"
                      : "text-app-warning",
                  )}
                  icon={
                    blocker.code === "GPU_UNSUPPORTED"
                      ? InformationCircleIcon
                      : Alert02Icon
                  }
                  size={16}
                />
                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "text-sm font-medium",
                      blocker.code === "GPU_UNSUPPORTED"
                        ? "text-foreground"
                        : "text-app-warning",
                    )}
                  >
                    {blockerCopy.title}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {blockerCopy.body}
                  </p>
                </div>
              </div>
              {blocker.code === "GPU_UNSUPPORTED" ? (
                onSwitchToByok && !readOnly ? (
                  <Button
                    className="shrink-0"
                    onClick={onSwitchToByok}
                    size="compact"
                    tone="primary"
                  >
                    {t(m.switchToByok)}
                  </Button>
                ) : null
              ) : blocker.code === "DRIVER_UPDATE_REQUIRED" ? (
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  <Button
                    onClick={() =>
                      setDialog({
                        kind: "updateDriver",
                        reason: blocker,
                      })
                    }
                    size="compact"
                    tone="primary"
                  >
                    {t(m.updateDriverAction)}
                  </Button>
                  {!offline && !readOnly ? (
                    <Button
                      loading={rechecking}
                      onClick={onRefresh}
                      size="compact"
                      tone="secondary"
                    >
                      {t(m.recheckMemory)}
                    </Button>
                  ) : null}
                </div>
              ) : !offline && !readOnly ? (
                <Button
                  className="shrink-0"
                  loading={rechecking}
                  onClick={onRefresh}
                  size="compact"
                >
                  {t(m.recheckMemory)}
                </Button>
              ) : null}
            </aside>
          ) : null}
          {guidanceCopy ? (
            <aside
              aria-label={t(m.memoryGuidance)}
              className="mt-5 flex flex-col items-start justify-between gap-3 rounded-xl border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] px-4 py-3.5 sm:flex-row sm:items-center"
            >
              <div className="flex min-w-0 flex-1 items-start gap-2.5">
                <Icon
                  className="mt-0.5 shrink-0 text-app-warning"
                  icon={Alert02Icon}
                  size={16}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-app-warning">
                    {guidanceCopy.title}
                  </p>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {guidanceCopy.body}
                  </p>
                </div>
              </div>
              {readOnly ? null : (
                <Button
                  className="shrink-0"
                  loading={rechecking}
                  onClick={onRefresh}
                  size="compact"
                >
                  {t(m.recheckMemory)}
                </Button>
              )}
            </aside>
          ) : null}
          {entries.length === 0 ? (
            <>
              <div className="mt-5">
                <FeaturedModelSpotlight />
              </div>
              <EmptyState title={t(m.noModelsTitle)}>
                {t(m.noModelsBody, { name })}
              </EmptyState>
            </>
          ) : (
            <section aria-label={t(m.title)} className="mt-5 grid gap-4">
              {sections.spotlightPosition === "top" ? spotlightNode : null}
              {sections.onComputer.length > 0 ? (
                <div className="grid gap-2.5">
                  <h2 className="text-xs font-medium text-muted-foreground">
                    {t(m.sectionOnComputer)}
                  </h2>
                  {sections.onComputer.map((group) => renderModelGroup(group))}
                </div>
              ) : null}
              {sections.available.length > 0 ? (
                <div className="grid gap-2.5">
                  <h2 className="text-xs font-medium text-muted-foreground">
                    {t(m.sectionAvailable)}
                  </h2>
                  {sections.available.map((group) => renderModelGroup(group))}
                </div>
              ) : null}
              {sections.spotlightPosition === "afterAvailable"
                ? spotlightNode
                : null}
              {sections.unavailable.length > 0 ? (
                <div className="grid gap-2.5">
                  {hasUsableModels ? (
                    <button
                      aria-controls={unavailablePanelId}
                      aria-expanded={showUnavailable}
                      className="flex items-center gap-1.5 self-start rounded-md py-1 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                      onClick={() => setUnavailableOpen((current) => !current)}
                      type="button"
                    >
                      <Icon
                        className={cn(
                          "shrink-0 transition-transform duration-200 motion-reduce:transition-none",
                          !showUnavailable && "-rotate-90",
                        )}
                        icon={ArrowDown01Icon}
                        size={14}
                      />
                      <span>{unavailableLabel}</span>
                    </button>
                  ) : (
                    <h2 className="text-xs font-medium text-muted-foreground">
                      {unavailableLabel}
                    </h2>
                  )}
                  {showUnavailable ? (
                    <AutoHeight appear={hasUsableModels}>
                      <div className="grid gap-2.5" id={unavailablePanelId}>
                        {sections.unavailable.map((group) =>
                          renderModelGroup(group),
                        )}
                      </div>
                    </AutoHeight>
                  ) : null}
                </div>
              ) : null}
            </section>
          )}
        </>
      )}

      {dialog?.kind === "advanced" ? (
        <AdvancedDialog onClose={() => setDialog(null)} view={view} />
      ) : null}
      {dialog?.kind === "updateDriver" ? (
        <UpdateDriverDialog
          isLocalDesktop={isLocalDesktop}
          model={dialogEntry?.model}
          offline={offline}
          onClose={() => setDialog(null)}
          onRecheck={!offline && !readOnly ? onRefresh : undefined}
          reason={dialog.reason}
          rechecking={rechecking}
          view={view}
        />
      ) : null}
      {dialogEntry && makeRoom ? (
        <MakeRoomDialog
          assignableAgents={canSwitchAgents ? assignableAgents : []}
          check={makeRoom}
          disabled={!confirmable(dialogEntry, "load")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={(unloadFirst, switchAgentIds) => {
            completedSwitchKeyRef.current = null;
            setPendingSwitch(
              canSwitchAgents && switchAgentIds.length
                ? { agentIds: switchAgentIds, modelId: dialogEntry.model.id }
                : null,
            );
            act({
              action: "load",
              modelId: dialogEntry.model.id,
              unloadFirst,
            });
          }}
          onRecheck={!offline && !readOnly ? onRefresh : undefined}
          rechecking={rechecking}
          view={view}
        />
      ) : null}
      {dialogEntry && dialog?.kind === "unload" ? (
        <UnloadModelDialog
          assignableAgents={assignableAgents}
          disabled={!confirmable(dialogEntry, "unload")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act({ action: "unload", modelId: dialogEntry.model.id })
          }
          view={view}
        />
      ) : null}
      {dialogEntry && dialog?.kind === "remove" ? (
        <RemoveModelDialog
          assignableAgents={assignableAgents}
          disabled={!confirmable(dialogEntry, "remove")}
          entry={dialogEntry}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            act({ action: "remove", modelId: dialogEntry.model.id })
          }
          view={view}
        />
      ) : null}
    </>
  );
}
