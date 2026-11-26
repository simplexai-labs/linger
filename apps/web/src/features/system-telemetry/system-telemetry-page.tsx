import {
  Activity01Icon,
  Alert02Icon,
  Cancel01Icon,
  InformationCircleIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import {
  ComputerPicker,
  type ComputerPickerOption,
} from "@/features/local-models/computer-picker";
import {
  readLastModelsComputer,
  writeLastModelsComputer,
} from "@/features/local-models/last-models-computer";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import type { EventSourceFactory } from "@/features/teamhub/event-stream";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { HardwareInstruments } from "./hardware-instruments";
import {
  InspectPlanPanels,
  type InspectDisclosureKey,
} from "./inspect-plan-panels";
import { PiRoutingStage } from "./pi-routing-stage";
import { systemTelemetryMessages as m } from "./system-telemetry.messages";
import { deriveSnapshotMetrics, formatGb, formatTokS } from "./telemetry-math";
import type {
  DerivedTelemetryMetrics,
  SystemTelemetryBottleneck,
  TelemetryBasis,
  TelemetryOpticalTarget,
} from "./telemetry-types";
import { useSystemTelemetry } from "./use-system-telemetry";

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (event: MediaQueryListEvent) => {
      setReduced(event.matches);
    };
    mediaQuery.addEventListener("change", onChange);
    return () => {
      mediaQuery.removeEventListener("change", onChange);
    };
  }, []);

  return reduced;
}

function bottleneckText(
  bottleneck: SystemTelemetryBottleneck,
  t: ReturnType<typeof useT>,
): string {
  switch (bottleneck) {
    case "memory_bw_bound":
      return t(m.bottleneckMemoryBw);
    case "compute_bound":
      return t(m.bottleneckCompute);
    case "io_bound":
      return t(m.bottleneckIo);
    case "idle":
      return t(m.bottleneckIdle);
    default:
      return t(m.bottleneckBalanced);
  }
}

function basisLabel(basis: TelemetryBasis, t: ReturnType<typeof useT>): string {
  switch (basis) {
    case "live":
      return t(m.basisLive);
    case "measured":
      return t(m.basisMeasured);
    case "estimate":
      return t(m.basisEstimate);
    case "demo":
      return t(m.basisDemo);
    default:
      return t(m.basisNone);
  }
}

function provenanceMetricLabel(id: string, t: ReturnType<typeof useT>): string {
  switch (id) {
    case "memory_pool":
      return t(m.provenanceMetricMemory);
    case "decode_bw":
      return t(m.provenanceMetricDecodeBw);
    case "gpu_compute":
      return t(m.provenanceMetricGpuCompute);
    case "thermals_power":
      return t(m.provenanceMetricThermals);
    case "gateway_slots":
      return t(m.provenanceMetricGateway);
    case "cpu_disk":
      return t(m.provenanceMetricCpuDisk);
    default:
      return t(m.provenanceMetricWhatIf);
  }
}

function buildStatusSummary(
  metrics: DerivedTelemetryMetrics,
  t: ReturnType<typeof useT>,
): string {
  const poolLabel =
    metrics.poolKind === "unified" ? t(m.poolUnified) : t(m.poolVram);

  if (metrics.models.length === 0 && metrics.inFlight === 0) {
    return t(m.summaryIdleNoModels);
  }
  if (metrics.pressureLevel === "critical" && metrics.poolPct !== null) {
    return t(m.summaryPressure, {
      pct: metrics.poolPct,
      pool: poolLabel,
    });
  }
  if (metrics.inFlight === 0) {
    return t(m.summaryIdle, {
      count: metrics.models.length,
      free:
        metrics.poolFreeGb !== null ? formatGb(metrics.poolFreeGb) : "\u2014",
      models: metrics.models.length,
      pool: poolLabel,
    });
  }
  if (metrics.bwCeilingPct !== null && metrics.bwCeilingGbS !== null) {
    return t(m.summaryServingWithCeiling, {
      bottleneck: bottleneckText(metrics.bottleneck, t),
      ceiling: Math.round(metrics.bwCeilingGbS),
      count: metrics.inFlight,
      pct: metrics.bwCeilingPct,
      streams: metrics.inFlight,
      tokS: formatTokS(metrics.decodeTokS),
    });
  }
  return t(m.summaryServing, {
    bottleneck: bottleneckText(metrics.bottleneck, t),
    count: metrics.inFlight,
    streams: metrics.inFlight,
    tokS: formatTokS(metrics.decodeTokS),
  });
}

export interface SystemTelemetryPageProps {
  /** Optional EventSource factory override for unit tests. */
  readonly eventSourceFactory?: EventSourceFactory;
}

/**
 * Settings › System: production live telemetry page visualizing local Pi Agent
 * optical routing, hardware/bandwidth precision dials, request waterfall,
 * dual-track oscilloscope, /slots KV rack, and What-If capacity sandbox.
 */
export function SystemTelemetryPage({
  eventSourceFactory,
}: SystemTelemetryPageProps = {}) {
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
  const selectedComputer =
    linkedOwned ?? savedOwned ?? desktopOwned ?? defaultComputer;

  useEffect(() => {
    if (linkedOwned) {
      writeLastModelsComputer(tenantId, linkedOwned.computer_id);
    }
  }, [linkedOwned, tenantId]);

  function selectComputer(computerId: string) {
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

  const pickerOptions: ComputerPickerOption[] = useMemo(
    () =>
      computers.map((item) => ({
        computerId: item.computer_id,
        displayName: item.display_name,
        online: item.status === "online",
      })),
    [computers],
  );

  const computersHref = `/t/${encodeURIComponent(tenantId)}/settings/computers`;

  if (!selectedComputer) {
    return (
      <main className="mx-auto flex min-h-0 w-full max-w-[980px] flex-col pb-8">
        <header className="px-1.5">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">
            {t(m.title)}
          </h1>
        </header>
        <section
          aria-label={t(m.noComputersTitle)}
          className="mt-6 flex flex-col items-center rounded-xl border border-border bg-card px-6 py-12 text-center"
        >
          <span className="flex size-14 items-center justify-center rounded-2xl bg-muted text-foreground shadow-outline">
            <Icon icon={Activity01Icon} size={24} />
          </span>
          <h2 className="mt-5 text-lg text-foreground">
            {t(m.noComputersTitle)}
          </h2>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            <RichMessage
              message={m.noComputersBody}
              tags={{
                link: (text) => (
                  <Link
                    className="font-medium text-app-link underline-offset-2 hover:underline"
                    to={computersHref}
                  >
                    {text}
                  </Link>
                ),
              }}
            />
          </p>
        </section>
      </main>
    );
  }

  return (
    <ComputerSystemTelemetry
      computerId={selectedComputer.computer_id}
      computerName={selectedComputer.display_name}
      computerOnline={selectedComputer.status === "online"}
      computersHref={computersHref}
      eventSourceFactory={eventSourceFactory}
      onSelectComputer={selectComputer}
      pickerOptions={pickerOptions}
      tenantId={tenantId}
    />
  );
}

function ComputerSystemTelemetry({
  computerId,
  computerName,
  computerOnline,
  computersHref,
  eventSourceFactory,
  onSelectComputer,
  pickerOptions,
  tenantId,
}: {
  readonly computerId: string;
  readonly computerName: string;
  readonly computerOnline: boolean;
  readonly computersHref: string;
  readonly eventSourceFactory?: EventSourceFactory;
  readonly onSelectComputer: (computerId: string) => void;
  readonly pickerOptions: readonly ComputerPickerOption[];
  readonly tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const reducedMotion = usePrefersReducedMotion();

  const [paused, setPaused] = useState(false);
  const [provenanceOpen, setProvenanceOpen] = useState(false);
  const [lockedTarget, setLockedTarget] = useState<TelemetryOpticalTarget>({
    kind: "none",
  });
  const [openPanels, setOpenPanels] = useState<
    Record<InspectDisclosureKey, boolean>
  >({
    waterfall: false,
    deep: false,
    whatif: false,
  });

  const provenanceRef = useRef<HTMLDivElement>(null);

  const telemetry = useSystemTelemetry({
    client,
    computerId,
    computerOnline,
    eventSourceFactory,
    paused,
    tenantId,
  });

  const metrics = useMemo(
    () =>
      telemetry.view ? deriveSnapshotMetrics(telemetry.view.snapshot) : null,
    [telemetry.view],
  );

  useEffect(() => {
    if (!provenanceOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (provenanceRef.current && !provenanceRef.current.contains(target)) {
        setProvenanceOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setProvenanceOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [provenanceOpen]);

  const modelsHref = `/t/${encodeURIComponent(tenantId)}/settings/models?computer=${encodeURIComponent(computerId)}`;
  const animated =
    !reducedMotion &&
    telemetry.phase === "live" &&
    !paused &&
    !telemetry.hiddenPaused;

  function handleSelectComputer(nextId: string) {
    setLockedTarget({ kind: "none" });
    setProvenanceOpen(false);
    onSelectComputer(nextId);
  }

  function handleToggleSpotlight(next: TelemetryOpticalTarget) {
    setLockedTarget((current) => {
      const same =
        current.kind === next.kind &&
        current.kind !== "none" &&
        next.kind !== "none" &&
        current.id === next.id;
      if (same) return { kind: "none" };
      setOpenPanels((previous) => ({ ...previous, waterfall: true }));
      return next;
    });
  }

  function handleTogglePanel(key: InspectDisclosureKey) {
    setOpenPanels((previous) => ({ ...previous, [key]: !previous[key] }));
  }

  const badgeLabel =
    telemetry.phase === "live"
      ? t(m.liveBadge)
      : telemetry.phase === "paused"
        ? t(m.pausedBadge)
        : telemetry.phase === "offline"
          ? t(m.offlineBadge)
          : telemetry.phase === "unsupported"
            ? t(m.unsupportedBadge)
            : telemetry.phase === "loading"
              ? t(m.connectingBadge)
              : t(m.errorBadge);

  const badgeDotClass =
    telemetry.phase === "live"
      ? metrics?.pressureLevel === "critical"
        ? "bg-sun-500"
        : "bg-lake-500"
      : telemetry.phase === "unsupported" || telemetry.phase === "error"
        ? "bg-sun-500"
        : "bg-muted-foreground/50";

  const statusSummary =
    telemetry.phase === "offline"
      ? t(m.summaryOffline, { computer: computerName })
      : telemetry.phase === "unsupported"
        ? t(m.summaryUnsupported, { computer: computerName })
        : telemetry.phase === "loading" && !metrics
          ? t(m.summaryLoading, { computer: computerName })
          : metrics
            ? buildStatusSummary(metrics, t)
            : t(m.errorBody);

  const showDimmedSnapshot =
    Boolean(metrics) &&
    (telemetry.phase === "offline" || telemetry.phase === "error");

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-[980px] flex-col gap-5 pb-12">
      {/* 1. Native Settings Header + Quiet Single Provenance Indicator */}
      <header className="px-1.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="text-2xl font-medium tracking-tight text-foreground">
              {t(m.title)}
            </h1>

            <div className="relative" ref={provenanceRef}>
              <button
                aria-expanded={provenanceOpen}
                aria-haspopup="dialog"
                className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-muted-foreground shadow-outline transition-colors hover:border-border-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => setProvenanceOpen((open) => !open)}
                title={t(m.provenanceButtonTitle)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    badgeDotClass,
                    animated && "animate-pulse",
                  )}
                />
                <span className="tabular-nums">{badgeLabel}</span>
              </button>

              {provenanceOpen ? (
                <div
                  aria-label={t(m.provenanceTitle)}
                  className="absolute left-0 z-40 mt-2 w-[320px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-popover p-3.5 shadow-xl sm:w-[400px]"
                  role="dialog"
                >
                  <div className="flex items-center justify-between gap-2 pb-2">
                    <span className="text-xs font-semibold text-foreground">
                      {metrics?.hostSystem
                        ? t(m.provenanceTitleWithOs, { os: metrics.hostSystem })
                        : t(m.provenanceTitle)}
                    </span>
                    <button
                      aria-label={t(m.provenanceClose)}
                      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      data-voice-close=""
                      onClick={() => setProvenanceOpen(false)}
                      type="button"
                    >
                      <Icon icon={Cancel01Icon} size={13} />
                    </button>
                  </div>
                  <p className="mb-2.5 text-[11px] leading-relaxed text-muted-foreground">
                    {metrics?.collectorSummary
                      ? t(m.provenanceSummary, {
                          collector: metrics.collectorSummary,
                        })
                      : t(m.provenanceSummaryDefault)}
                  </p>
                  {metrics ? (
                    <div className="divide-y divide-border/70 border-t border-border text-[11px]">
                      {metrics.provenance.map((row) => (
                        <div
                          className="flex items-start justify-between gap-3 py-1.5"
                          key={row.id}
                        >
                          <div className="min-w-0">
                            <p className="font-medium text-foreground">
                              {provenanceMetricLabel(row.id, t)}
                            </p>
                            {row.detail ? (
                              <p className="truncate text-muted-foreground">
                                {row.detail}
                              </p>
                            ) : null}
                          </div>
                          <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                            {basisLabel(row.basis, t)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {telemetry.phase === "live" || telemetry.phase === "paused" ? (
              <Button
                aria-pressed={paused}
                onClick={() => setPaused((value) => !value)}
                size="compact"
              >
                <Icon icon={paused ? PlayIcon : PauseIcon} size={14} />
                <span>{paused ? t(m.resumeStream) : t(m.pauseStream)}</span>
              </Button>
            ) : null}

            {pickerOptions.length > 0 ? (
              <ComputerPicker
                onSelect={handleSelectComputer}
                options={pickerOptions}
                value={computerId}
              />
            ) : null}
          </div>
        </div>

        <p className="mt-1.5 text-sm text-muted-foreground">{statusSummary}</p>
      </header>

      {/* 2. Degraded / Offline / Unsupported / Forbidden / Error Banners */}
      {telemetry.phase === "offline" ? (
        <section
          className="mx-1.5 flex items-start gap-2.5 rounded-xl border border-border bg-muted/60 px-4 py-3 text-sm text-muted-foreground"
          role="status"
        >
          <Icon
            className="mt-0.5 shrink-0 text-muted-foreground"
            icon={InformationCircleIcon}
            size={16}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-medium text-foreground">
              {t(m.offlineBannerTitle, { computer: computerName })}
            </p>
            <p className="text-xs leading-relaxed">
              <RichMessage
                message={m.offlineBannerBody}
                tags={{
                  link: (text) => (
                    <Link
                      className="font-medium text-app-link underline-offset-2 hover:underline"
                      to={computersHref}
                    >
                      {text}
                    </Link>
                  ),
                }}
              />
            </p>
            {showDimmedSnapshot ? (
              <p className="text-xs text-muted-foreground">
                {t(m.offlinePreservedNote)}
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      {telemetry.phase === "unsupported" ? (
        <section
          aria-label={t(m.unsupportedTitle)}
          className="mx-1.5 flex flex-col items-center rounded-xl border border-border bg-card px-6 py-10 text-center"
          role="status"
        >
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted text-foreground shadow-outline">
            <Icon icon={Alert02Icon} size={22} />
          </span>
          <h2 className="mt-4 text-base font-medium text-foreground">
            {t(m.unsupportedTitle)}
          </h2>
          <p className="mt-1.5 max-w-lg text-sm leading-relaxed text-muted-foreground">
            <RichMessage
              message={m.unsupportedBody}
              tags={{
                link: (text) => (
                  <Link
                    className="font-medium text-app-link underline-offset-2 hover:underline"
                    to={computersHref}
                  >
                    {text}
                  </Link>
                ),
                models: (text) => (
                  <Link
                    className="font-medium text-app-link underline-offset-2 hover:underline"
                    to={modelsHref}
                  >
                    {text}
                  </Link>
                ),
              }}
              values={{ computer: computerName }}
            />
          </p>
        </section>
      ) : null}

      {telemetry.phase === "forbidden" ? (
        <section
          aria-label={t(m.forbiddenTitle)}
          className="mx-1.5 flex flex-col items-center rounded-xl border border-border bg-card px-6 py-10 text-center"
          role="alert"
        >
          <h2 className="text-base font-medium text-foreground">
            {t(m.forbiddenTitle)}
          </h2>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            {t(m.forbiddenBody, { computer: computerName })}
          </p>
        </section>
      ) : null}

      {telemetry.phase === "error" ? (
        <section
          className="mx-1.5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-sm"
          role="alert"
        >
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              {t(m.errorTitle, { computer: computerName })}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {telemetry.errorMessage ?? t(m.errorBody)}
            </p>
          </div>
          <Button onClick={telemetry.retry} size="compact">
            <Icon icon={RefreshIcon} size={14} />
            <span>{t(m.retry)}</span>
          </Button>
        </section>
      ) : null}

      {/* 3. Loading Skeleton (first paint before first snapshot) */}
      {telemetry.phase === "loading" && !metrics ? (
        <div
          aria-busy="true"
          aria-label={t(m.loadingRegion)}
          className="space-y-4 px-1.5"
          role="status"
        >
          <Skeleton className="h-[380px] w-full rounded-2xl" />
          <Skeleton className="h-[220px] w-full rounded-xl" />
          <Skeleton className="h-[136px] w-full rounded-xl" />
        </div>
      ) : null}

      {/* 4. Live / Paused / Dimmed-Offline Telemetry Workspace */}
      {metrics &&
      telemetry.phase !== "unsupported" &&
      telemetry.phase !== "forbidden" ? (
        <div
          className={cn(
            "flex flex-col gap-5 transition-opacity duration-200",
            showDimmedSnapshot && "opacity-60",
          )}
          data-telemetry-dimmed={showDimmedSnapshot ? "true" : undefined}
        >
          <PiRoutingStage
            animated={animated}
            history={telemetry.history}
            lockedTarget={lockedTarget}
            metrics={metrics}
            modelsHref={modelsHref}
            onClearSpotlight={() => setLockedTarget({ kind: "none" })}
            onToggleSpotlight={handleToggleSpotlight}
          />

          <HardwareInstruments
            animated={animated}
            metrics={metrics}
            modelsHref={modelsHref}
          />

          <InspectPlanPanels
            animated={animated}
            computerName={computerName}
            history={telemetry.history}
            lockedTarget={lockedTarget}
            metrics={metrics}
            modelsHref={modelsHref}
            onClearSpotlight={() => setLockedTarget({ kind: "none" })}
            onTogglePanel={handleTogglePanel}
            openPanels={openPanels}
            whatIfCoefficients={telemetry.view?.snapshot.what_if}
          />
        </div>
      ) : null}
    </main>
  );
}
