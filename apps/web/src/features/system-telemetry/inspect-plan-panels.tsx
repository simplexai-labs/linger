import {
  Activity01Icon,
  Alert02Icon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  CheckmarkCircle02Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { motion } from "motion/react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";

import { AutoHeight } from "@/components/ui/auto-height";
import { Icon } from "@/components/ui/icon";
import { SettingsGroup } from "@/components/ui/settings-group";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { systemTelemetryMessages as m } from "./system-telemetry.messages";
import {
  computeWhatIfForecast,
  formatGb,
  formatMs,
  formatTokS,
} from "./telemetry-math";
import type {
  DerivedLiveSlot,
  DerivedTelemetryMetrics,
  SystemTelemetryWaterfallEntry,
  SystemTelemetryWhatIf,
  TelemetryHistoryPoint,
  TelemetryOpticalTarget,
  WhatIfContextOption,
  WhatIfInput,
  WhatIfKvQuant,
} from "./telemetry-types";

export type InspectDisclosureKey = "waterfall" | "deep" | "whatif";

const CONTEXT_OPTIONS: readonly WhatIfContextOption[] = [
  8192, 16384, 32768, 65536, 131072,
];

const KV_QUANT_OPTIONS: readonly WhatIfKvQuant[] = ["FP16", "Q8_0", "Q4_0"];

function nearestContextOption(
  windowTokens: number | undefined,
): WhatIfContextOption {
  if (!windowTokens || windowTokens <= 8192) return 8192;
  if (windowTokens <= 16384) return 16384;
  if (windowTokens <= 32768) return 32768;
  if (windowTokens <= 65536) return 65536;
  return 131072;
}

export interface InspectPlanPanelsProps {
  readonly animated: boolean;
  readonly computerName: string;
  readonly history: readonly TelemetryHistoryPoint[];
  readonly lockedTarget: TelemetryOpticalTarget;
  readonly metrics: DerivedTelemetryMetrics;
  readonly modelsHref: string;
  readonly onClearSpotlight: () => void;
  readonly onTogglePanel: (key: InspectDisclosureKey) => void;
  readonly openPanels: Record<InspectDisclosureKey, boolean>;
  readonly whatIfCoefficients: SystemTelemetryWhatIf | null | undefined;
}

/**
 * Collapsed-by-default progressive disclosures for Inspect & Plan:
 *  1. Recent Pi requests waterfall (auto-filtered when spotlighted)
 *  2. Deep telemetry (dual-track live oscilloscope + live /slots KV rack)
 *  3. What-If capacity sandbox computed locally from snapshot roofline coefficients
 */
export function InspectPlanPanels({
  animated,
  computerName,
  history,
  lockedTarget,
  metrics,
  modelsHref,
  onClearSpotlight,
  onTogglePanel,
  openPanels,
  whatIfCoefficients,
}: InspectPlanPanelsProps) {
  const t = useT();
  const [expandedReqId, setExpandedReqId] = useState<string | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [whatIfInput, setWhatIfInput] = useState<WhatIfInput>({
    concurrency: Math.min(16, Math.max(1, whatIfCoefficients?.slots ?? 4)),
    contextTokens: nearestContextOption(whatIfCoefficients?.window),
    kvQuant: "Q8_0",
  });

  const clientNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const client of metrics.clients) {
      map.set(client.id, client.name);
    }
    return map;
  }, [metrics.clients]);

  const modelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of metrics.models) {
      map.set(model.id, model.name);
      map.set(model.componentId, model.name);
    }
    return map;
  }, [metrics.models]);

  const filteredWaterfall = useMemo(() => {
    if (lockedTarget.kind === "client") {
      return metrics.waterfall.filter(
        (entry) =>
          entry.client_id === lockedTarget.id ||
          entry.client_id === lockedTarget.name,
      );
    }
    if (lockedTarget.kind === "model") {
      return metrics.waterfall.filter(
        (entry) =>
          entry.model_id === lockedTarget.id ||
          entry.model_id === lockedTarget.name,
      );
    }
    return metrics.waterfall;
  }, [lockedTarget, metrics.waterfall]);

  const forecast = useMemo(
    () =>
      whatIfCoefficients
        ? computeWhatIfForecast(whatIfCoefficients, whatIfInput)
        : null,
    [whatIfCoefficients, whatIfInput],
  );

  const inspectedPoint: TelemetryHistoryPoint | undefined =
    hoverIdx !== null && history[hoverIdx]
      ? history[hoverIdx]
      : history[history.length - 1];

  const poolLabel =
    metrics.poolKind === "unified" ? t(m.poolUnified) : t(m.poolVram);

  const verdictLabel = forecast
    ? forecast.verdict === "fits_gpu"
      ? t(m.whatIfVerdictFits)
      : forecast.verdict === "hybrid_offload"
        ? t(m.whatIfVerdictHybrid)
        : t(m.whatIfVerdictOom)
    : "";

  const verdictDetail = forecast
    ? forecast.verdict === "fits_gpu"
      ? t(m.whatIfDetailFits, {
          free: formatGb(Math.max(0, forecast.freeDeltaGb)),
          pool: poolLabel,
        })
      : forecast.verdict === "hybrid_offload"
        ? t(m.whatIfDetailHybrid, {
            offload: formatGb(forecast.offloadToRamGb),
          })
        : t(m.whatIfDetailOom, {
            offload: formatGb(forecast.offloadToRamGb),
            pool: poolLabel,
          })
    : "";

  const projectedSegments = useMemo(() => {
    if (!forecast) return [];
    const freeGb = Math.max(0, forecast.freeDeltaGb);
    return [
      {
        id: "weights",
        label: t(m.whatIfSegmentWeights),
        gb: forecast.weightsGb,
      },
      { id: "kv_cache", label: t(m.whatIfSegmentKv), gb: forecast.kvCacheGb },
      {
        id: "compute_buf",
        label: t(m.whatIfSegmentCompute),
        gb: forecast.computeGb,
      },
      { id: "fixed", label: t(m.whatIfSegmentFixed), gb: forecast.fixedGb },
      { id: "free", label: t(m.whatIfSegmentFree), gb: freeGb },
    ] as const;
  }, [forecast, t]);

  const projectedTotal = forecast
    ? Math.max(
        forecast.poolBudgetGb,
        projectedSegments.reduce((sum, segment) => sum + segment.gb, 0),
        0.1,
      )
    : 1;

  return (
    <SettingsGroup label={t(m.inspectHeading)}>
      {/* 1. Recent Pi Requests Waterfall */}
      <DisclosureSection
        badge={
          lockedTarget.kind !== "none"
            ? t(m.waterfallBadgeFiltered, { name: lockedTarget.name })
            : t(m.waterfallBadgeSummary, {
                count: filteredWaterfall.length,
                ttft: formatMs(metrics.p50TtftMs),
              })
        }
        onToggle={() => onTogglePanel("waterfall")}
        open={openPanels.waterfall}
        title={t(m.waterfallTitle)}
      >
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <span>{t(m.waterfallHint)}</span>
              {lockedTarget.kind !== "none" ? (
                <button
                  aria-label={t(m.clearSpotlight)}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={onClearSpotlight}
                  type="button"
                >
                  <span>{lockedTarget.name}</span>
                  <Icon icon={Cancel01Icon} size={10} />
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-lavender-500" />
                {t(m.waterfallLegendGateway)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-rain-500" />
                {t(m.waterfallLegendPrefill)}
              </span>
              <span className="inline-flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-lichen-500" />
                {t(m.waterfallLegendDecode)}
              </span>
            </div>
          </div>

          {filteredWaterfall.length > 0 ? (
            <div className="divide-y divide-border/80 border-t border-border/80">
              {filteredWaterfall.map((entry) => (
                <PiWaterfallRow
                  clientLabel={
                    clientNames.get(entry.client_id) ?? entry.client_id
                  }
                  entry={entry}
                  expanded={expandedReqId === entry.request_id}
                  key={entry.request_id}
                  modelLabel={modelNames.get(entry.model_id) ?? entry.model_id}
                  onToggle={() =>
                    setExpandedReqId((current) =>
                      current === entry.request_id ? null : entry.request_id,
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <p className="border-t border-border/80 pt-3 text-xs text-muted-foreground">
              {t(m.waterfallEmpty)}
            </p>
          )}
        </div>
      </DisclosureSection>

      {/* 2. Deep Telemetry: Live Oscilloscope + /slots KV Occupancy */}
      <DisclosureSection
        badge={t(m.deepBadge, {
          inFlight: metrics.inFlight,
          kv:
            metrics.kvCacheUsagePct !== null
              ? `${metrics.kvCacheUsagePct}%`
              : "\u2014",
          maxSlots: metrics.maxSlots,
        })}
        onToggle={() => onTogglePanel("deep")}
        open={openPanels.deep}
        title={t(m.deepTitle)}
      >
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1.22fr)_minmax(0,1fr)]">
          <div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">
                {t(m.deepTracesHeading)}
                {hoverIdx !== null && history.length > 0 ? (
                  <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                    T-{history.length - 1 - hoverIdx}
                  </span>
                ) : null}
              </span>
              {inspectedPoint ? (
                <div className="flex flex-wrap items-center gap-3 text-[11px] tabular-nums">
                  <span>
                    <span className="text-muted-foreground">
                      {t(m.deepTraceDecode)}{" "}
                    </span>
                    <strong className="font-medium text-lichen-700">
                      {formatTokS(inspectedPoint.decodeTokS)}
                    </strong>
                  </span>
                  <span>
                    <span className="text-muted-foreground">
                      {t(m.deepTraceTtft)}{" "}
                    </span>
                    <strong className="font-medium text-sun-700">
                      {formatMs(inspectedPoint.ttftMs)}
                    </strong>
                  </span>
                  <span>
                    <span className="text-muted-foreground">
                      {t(m.deepTraceMemBw)}{" "}
                    </span>
                    <strong className="font-medium text-rain-700">
                      {inspectedPoint.memBwGbS.toFixed(0)} GB/s
                    </strong>
                  </span>
                </div>
              ) : null}
            </div>

            <PrecisionDualOscilloscope
              animated={animated}
              ceilingGbS={metrics.bwCeilingGbS ?? 200}
              history={history}
              hoverIdx={hoverIdx}
              onHoverIdx={setHoverIdx}
            />
          </div>

          <div className="lg:border-l lg:border-border lg:pl-5">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium text-foreground">
                {t(m.deepSlotsHeading)}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {t(m.deepPrefixHit, {
                  pct:
                    metrics.prefixHitPct !== null
                      ? `${metrics.prefixHitPct}%`
                      : "\u2014",
                })}
              </span>
            </div>

            {metrics.slots.length > 0 ? (
              <div className="mt-2.5 divide-y divide-border/75 border-t border-border/75">
                {metrics.slots.slice(0, 8).map((slot) => (
                  <LiveSlotRow animated={animated} key={slot.key} slot={slot} />
                ))}
              </div>
            ) : (
              <p className="mt-2.5 border-t border-border/75 pt-3 text-xs text-muted-foreground">
                {t(m.deepSlotsEmpty)}
              </p>
            )}
          </div>
        </div>
      </DisclosureSection>

      {/* 3. What-If Capacity Sandbox */}
      <DisclosureSection
        badge={
          forecast
            ? t(m.whatIfBadge, {
                ctx: whatIfInput.contextTokens / 1024,
                quant: whatIfInput.kvQuant,
                slots: whatIfInput.concurrency,
                verdict: verdictLabel,
              })
            : t(m.whatIfBadgeUnavailable)
        }
        onToggle={() => onTogglePanel("whatif")}
        open={openPanels.whatif}
        title={t(m.whatIfTitle)}
      >
        {whatIfCoefficients && forecast ? (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="text-muted-foreground">
                  {t(m.whatIfHeading, { computer: computerName })}
                </span>
                <button
                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() =>
                    setWhatIfInput({
                      concurrency: Math.min(
                        16,
                        Math.max(
                          1,
                          whatIfCoefficients.slots || metrics.inFlight || 1,
                        ),
                      ),
                      contextTokens: nearestContextOption(
                        whatIfCoefficients.window,
                      ),
                      kvQuant: "Q8_0",
                    })
                  }
                  type="button"
                >
                  <Icon icon={RefreshIcon} size={12} />
                  {t(m.whatIfMatchLive)}
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label
                    className="font-medium text-foreground"
                    htmlFor="telemetry-whatif-concurrency"
                  >
                    {t(m.whatIfConcurrency)}
                  </label>
                  <span className="font-medium tabular-nums text-foreground">
                    {t(m.whatIfSlotCount, { count: whatIfInput.concurrency })}
                  </span>
                </div>
                <input
                  className="mt-1.5 h-1.5 w-full cursor-pointer accent-foreground"
                  id="telemetry-whatif-concurrency"
                  max={16}
                  min={1}
                  onChange={(event) =>
                    setWhatIfInput((previous) => ({
                      ...previous,
                      concurrency: Number(event.target.value),
                    }))
                  }
                  type="range"
                  value={whatIfInput.concurrency}
                />
                <div className="mt-0.5 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                  <span>1</span>
                  <span>4</span>
                  <span>8</span>
                  <span>12</span>
                  <span>16</span>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <span className="block text-xs font-medium text-foreground">
                    {t(m.whatIfContextLength)}
                  </span>
                  <div className="mt-1.5 grid grid-cols-5 gap-0.5 rounded-lg bg-muted p-0.5">
                    {CONTEXT_OPTIONS.map((ctx) => {
                      const active = whatIfInput.contextTokens === ctx;
                      return (
                        <button
                          aria-pressed={active}
                          className={cn(
                            "rounded-md py-1 text-[11px] font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active
                              ? "bg-card text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          key={ctx}
                          onClick={() =>
                            setWhatIfInput((previous) => ({
                              ...previous,
                              contextTokens: ctx,
                            }))
                          }
                          type="button"
                        >
                          {ctx / 1024}K
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <span className="block text-xs font-medium text-foreground">
                    {t(m.whatIfKvQuant)}
                  </span>
                  <div className="mt-1.5 grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
                    {KV_QUANT_OPTIONS.map((quant) => {
                      const active = whatIfInput.kvQuant === quant;
                      return (
                        <button
                          aria-pressed={active}
                          className={cn(
                            "rounded-md py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            active
                              ? "bg-card text-foreground shadow-sm"
                              : "text-muted-foreground hover:text-foreground",
                          )}
                          key={quant}
                          onClick={() =>
                            setWhatIfInput((previous) => ({
                              ...previous,
                              kvQuant: quant,
                            }))
                          }
                          type="button"
                        >
                          {quant}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-between gap-3 lg:border-l lg:border-border lg:pl-5">
              <div>
                <div className="flex items-baseline justify-between text-xs">
                  <span className="font-medium text-foreground">
                    {t(m.whatIfProjectedPool, { pool: poolLabel })}
                  </span>
                  <span className="tabular-nums text-muted-foreground">
                    {forecast.totalRequiredGb.toFixed(1)} /{" "}
                    {forecast.poolBudgetGb.toFixed(1)} GB
                  </span>
                </div>

                <div className="mt-2 flex h-7 w-full overflow-hidden rounded-lg bg-muted">
                  {projectedSegments
                    .filter((segment) => segment.gb > 0.05)
                    .map((segment) => {
                      const pct = Math.min(
                        100,
                        (segment.gb / projectedTotal) * 100,
                      );
                      return (
                        <motion.div
                          animate={{ width: `${pct}%` }}
                          className={cn(
                            "flex h-full items-center justify-center overflow-hidden border-r border-card px-1 text-[10px] font-medium tabular-nums last:border-r-0",
                            segment.id === "free"
                              ? "bg-muted text-muted-foreground"
                              : segment.id === "weights"
                                ? "bg-rain-500/25 text-rain-700"
                                : segment.id === "kv_cache"
                                  ? "bg-lichen-500/28 text-lichen-700"
                                  : segment.id === "compute_buf"
                                    ? "bg-bluebell-500/25 text-bluebell-700"
                                    : "bg-muted-foreground/20 text-foreground",
                          )}
                          key={segment.id}
                          title={`${segment.label}: ${formatGb(segment.gb)}`}
                          transition={{ duration: animated ? 0.35 : 0 }}
                        >
                          {pct > 16 ? (
                            <span className="truncate">
                              {segment.label} {segment.gb.toFixed(1)}G
                            </span>
                          ) : null}
                        </motion.div>
                      );
                    })}
                </div>

                <p className="mt-2.5 flex items-start gap-1.5 text-xs">
                  <Icon
                    className={cn(
                      "mt-0.5 shrink-0",
                      forecast.verdict === "fits_gpu"
                        ? "text-lake-700"
                        : "text-sun-700",
                    )}
                    icon={
                      forecast.verdict === "fits_gpu"
                        ? CheckmarkCircle02Icon
                        : Alert02Icon
                    }
                    size={14}
                  />
                  <span>
                    <strong className="font-medium text-foreground">
                      {verdictLabel}.
                    </strong>{" "}
                    <span className="text-muted-foreground">
                      {verdictDetail}
                    </span>
                  </span>
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <div className="flex flex-wrap items-center gap-4 text-xs tabular-nums">
                  <div>
                    <span className="block text-[10px] text-muted-foreground">
                      {t(m.whatIfEstDecode)}
                    </span>
                    <span className="font-medium text-foreground">
                      {formatTokS(forecast.predictedDecodeTokS)}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-muted-foreground">
                      {t(m.whatIfBwCeiling)}
                    </span>
                    <span className="font-medium text-foreground">
                      {forecast.predictedBwPct !== null
                        ? `${forecast.predictedBwPct}%`
                        : "\u2014"}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-muted-foreground">
                      {t(m.whatIfEstTtft)}
                    </span>
                    <span className="font-medium text-foreground">
                      {formatMs(forecast.predictedTtftMs)}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[10px] text-muted-foreground">
                      {t(m.whatIfOffload)}
                    </span>
                    <span className="font-medium text-foreground">
                      {forecast.offloadToRamGb > 0
                        ? formatGb(forecast.offloadToRamGb)
                        : t(m.whatIfOffloadNone)}
                    </span>
                  </div>
                </div>

                <Link
                  className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  to={modelsHref}
                >
                  <span>{t(m.whatIfApplyInModels)}</span>
                  <Icon icon={ArrowRight01Icon} size={12} />
                </Link>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <p className="max-w-xl leading-relaxed">
              {t(m.whatIfUnavailableBody)}
            </p>
            <Link
              className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              to={modelsHref}
            >
              <span>{t(m.openModels)}</span>
              <Icon icon={ArrowRight01Icon} size={12} />
            </Link>
          </div>
        )}
      </DisclosureSection>
    </SettingsGroup>
  );
}

function DisclosureSection({
  badge,
  children,
  onToggle,
  open,
  title,
}: {
  readonly badge: string;
  readonly children: ReactNode;
  readonly onToggle: () => void;
  readonly open: boolean;
  readonly title: string;
}) {
  return (
    <div className="border-t border-border">
      <button
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Icon
            className="shrink-0 text-muted-foreground"
            icon={Activity01Icon}
            size={14}
          />
          <span className="truncate text-[13px] font-medium text-foreground">
            {title}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 text-xs tabular-nums text-muted-foreground">
          <span className="hidden sm:inline">{badge}</span>
          <Icon
            className={cn(
              "transition-transform duration-150",
              open && "rotate-180",
            )}
            icon={ArrowDown01Icon}
            size={14}
          />
        </span>
      </button>
      <AutoHeight open={open}>
        <div className="border-t border-border/70 px-4 py-3.5">{children}</div>
      </AutoHeight>
    </div>
  );
}

function PiWaterfallRow({
  clientLabel,
  entry,
  expanded,
  modelLabel,
  onToggle,
}: {
  readonly clientLabel: string;
  readonly entry: SystemTelemetryWaterfallEntry;
  readonly expanded: boolean;
  readonly modelLabel: string;
  readonly onToggle: () => void;
}) {
  const t = useT();
  const gatewayMs = entry.gateway_ms ?? 0;
  const ttftMs = entry.ttft_ms ?? 0;
  const decodeMs = entry.decode_ms ?? 0;
  const totalMs = Math.max(1, gatewayMs + ttftMs + decodeMs);
  const gwPct = gatewayMs > 0 ? Math.max(4, (gatewayMs / totalMs) * 100) : 0;
  const prefillPct = ttftMs > 0 ? Math.max(8, (ttftMs / totalMs) * 100) : 0;
  const decodePct = Math.max(0, 100 - gwPct - prefillPct);

  const statusText =
    entry.status === "streaming"
      ? t(m.waterfallStatusStreaming)
      : entry.status === "deferred"
        ? t(m.waterfallStatusDeferred)
        : t(m.waterfallStatusCompleted);

  return (
    <div className="py-2">
      <button
        aria-expanded={expanded}
        className="grid w-full grid-cols-1 items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:grid-cols-[204px_1fr_160px]"
        onClick={onToggle}
        type="button"
      >
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="truncate font-medium text-foreground">
            {clientLabel}
          </span>
          <span className="text-muted-foreground">→</span>
          <span className="truncate text-muted-foreground">{modelLabel}</span>
        </div>

        <div className="flex items-center gap-2.5">
          <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
            {gwPct > 0 ? (
              <span
                className="h-full bg-lavender-500"
                style={{ width: `${gwPct}%` }}
              />
            ) : null}
            {prefillPct > 0 ? (
              <span
                className="h-full border-l border-card bg-rain-500"
                style={{ width: `${prefillPct}%` }}
              />
            ) : null}
            {decodePct > 0 ? (
              <span
                className="h-full border-l border-card bg-lichen-500"
                style={{ width: `${decodePct}%` }}
              />
            ) : null}
          </div>
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatMs(entry.ttft_ms ?? null)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 text-[11px] tabular-nums sm:justify-end">
          <span className="whitespace-nowrap font-medium text-foreground">
            {formatTokS(entry.decode_tok_s ?? null)}
          </span>
          <span
            className={cn(
              "capitalize",
              entry.status === "deferred"
                ? "text-sun-700"
                : entry.status === "streaming"
                  ? "text-rain-700"
                  : "text-muted-foreground",
            )}
          >
            {statusText}
          </span>
          <Icon
            className={cn(
              "text-muted-foreground transition-transform duration-150",
              expanded && "rotate-180",
            )}
            icon={ArrowDown01Icon}
            size={12}
          />
        </div>
      </button>

      {expanded ? (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-app-canvas px-3 py-2 text-[11px] tabular-nums text-muted-foreground sm:grid-cols-5">
          <span>
            {t(m.waterfallDetailGateway)}{" "}
            <strong className="text-foreground">
              {formatMs(entry.gateway_ms ?? null)}
            </strong>
          </span>
          <span>
            {t(m.waterfallDetailPrefill)}{" "}
            <strong className="text-foreground">
              {formatMs(entry.ttft_ms ?? null)}
            </strong>
          </span>
          <span>
            {t(m.waterfallDetailDecode)}{" "}
            <strong className="text-foreground">
              {formatMs(entry.decode_ms ?? null)}
            </strong>
          </span>
          <span>
            {t(m.waterfallDetailTokens)}{" "}
            <strong className="text-foreground">
              {entry.prompt_tokens !== null && entry.prompt_tokens !== undefined
                ? entry.prompt_tokens.toLocaleString()
                : "\u2014"}{" "}
              /{" "}
              {entry.completion_tokens !== null &&
              entry.completion_tokens !== undefined
                ? entry.completion_tokens.toLocaleString()
                : "\u2014"}
            </strong>
          </span>
          <span>
            {t(m.waterfallDetailPrefixHit)}{" "}
            <strong className="text-foreground">
              {entry.cached_prefix_pct !== null &&
              entry.cached_prefix_pct !== undefined
                ? `${Math.round(entry.cached_prefix_pct)}%`
                : "\u2014"}
            </strong>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PrecisionDualOscilloscope({
  animated,
  ceilingGbS,
  history,
  hoverIdx,
  onHoverIdx,
}: {
  readonly animated: boolean;
  readonly ceilingGbS: number;
  readonly history: readonly TelemetryHistoryPoint[];
  readonly hoverIdx: number | null;
  readonly onHoverIdx: (idx: number | null) => void;
}) {
  const t = useT();
  if (history.length === 0) {
    return (
      <div className="mt-2.5 flex h-[168px] items-center justify-center rounded-lg border border-border bg-background text-xs text-muted-foreground">
        {t(m.deepOscilloscopeWaiting)}
      </div>
    );
  }

  const width = 560;
  const trackH = 70;
  const gap = 14;
  const totalH = trackH * 2 + gap + 8;

  const maxDecode = Math.max(20, ...history.map((point) => point.decodeTokS));
  const maxPrefill = Math.max(
    200,
    ...history.map((point) => point.prefillTokS),
  );
  const maxTtft = Math.max(300, ...history.map((point) => point.ttftMs));
  const safeCeiling = Math.max(
    1,
    ceilingGbS,
    ...history.map((point) => point.memBwGbS),
  );

  const xAt = (index: number) =>
    history.length <= 1 ? width : (index / (history.length - 1)) * width;

  const yAt = (value: number, maxVal: number, yTop: number) => {
    const ratio = Math.min(1, Math.max(0, value / Math.max(1, maxVal)));
    return yTop + trackH - ratio * (trackH - 10) - 5;
  };

  const buildPolyline = (
    getter: (point: TelemetryHistoryPoint) => number,
    maxVal: number,
    yTop: number,
  ) =>
    history
      .map(
        (point, index) =>
          `${xAt(index).toFixed(1)},${yAt(getter(point), maxVal, yTop).toFixed(1)}`,
      )
      .join(" ");

  const decodePts = buildPolyline((point) => point.decodeTokS, maxDecode, 4);
  const prefillPts = buildPolyline((point) => point.prefillTokS, maxPrefill, 4);
  const track2Top = 4 + trackH + gap;
  const bwPts = buildPolyline(
    (point) => point.memBwGbS,
    safeCeiling,
    track2Top,
  );
  const ttftPts = buildPolyline((point) => point.ttftMs, maxTtft, track2Top);

  const decodeArea =
    history.length > 1
      ? `${decodePts} ${width},${4 + trackH} 0,${4 + trackH}`
      : "";
  const bwArea =
    history.length > 1
      ? `${bwPts} ${width},${track2Top + trackH} 0,${track2Top + trackH}`
      : "";

  const last = history[history.length - 1]!;
  const lastDecY = yAt(last.decodeTokS, maxDecode, 4);
  const lastTtftY = yAt(last.ttftMs, maxTtft, track2Top);

  return (
    <div className="mt-2.5">
      <svg
        aria-label={t(m.deepOscilloscopeLabel)}
        className="h-[168px] w-full cursor-crosshair select-none"
        onMouseLeave={() => onHoverIdx(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const relX = (event.clientX - rect.left) / Math.max(1, rect.width);
          const idx = Math.min(
            history.length - 1,
            Math.max(0, Math.round(relX * (history.length - 1))),
          );
          onHoverIdx(idx);
        }}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${width} ${totalH}`}
      >
        <defs>
          <pattern
            height="14"
            id="telemetry-osc-micro-grid"
            patternUnits="userSpaceOnUse"
            width="28"
          >
            <path
              d="M 28 0 L 0 0 0 14"
              fill="none"
              stroke="hsl(var(--town-border))"
              strokeOpacity="0.65"
              strokeWidth="0.6"
            />
          </pattern>
        </defs>

        <rect
          fill="hsl(var(--town-background))"
          height={trackH}
          rx="6"
          width={width}
          x="0"
          y="4"
        />
        <rect
          fill="url(#telemetry-osc-micro-grid)"
          height={trackH}
          rx="6"
          width={width}
          x="0"
          y="4"
        />
        {decodeArea ? (
          <polygon
            fill="var(--color-lichen-500)"
            fillOpacity="0.16"
            points={decodeArea}
          />
        ) : null}
        {history.length > 1 ? (
          <>
            <polyline
              fill="none"
              points={prefillPts}
              stroke="var(--color-rain-500)"
              strokeDasharray="4 3"
              strokeWidth="1.35"
            />
            <polyline
              fill="none"
              points={decodePts}
              stroke="var(--color-lichen-500)"
              strokeWidth="2"
            />
          </>
        ) : null}
        <circle
          className={animated ? "animate-pulse" : undefined}
          cx={width - 2}
          cy={lastDecY}
          fill="var(--color-lichen-500)"
          r="3.2"
        />

        <rect
          fill="hsl(var(--town-background))"
          height={trackH}
          rx="6"
          width={width}
          x="0"
          y={track2Top}
        />
        <rect
          fill="url(#telemetry-osc-micro-grid)"
          height={trackH}
          rx="6"
          width={width}
          x="0"
          y={track2Top}
        />
        <line
          stroke="var(--color-sun-500)"
          strokeDasharray="3 4"
          strokeOpacity="0.5"
          x1="0"
          x2={width}
          y1={track2Top + trackH * 0.2}
          y2={track2Top + trackH * 0.2}
        />
        {bwArea ? (
          <polygon
            fill="var(--color-rain-500)"
            fillOpacity="0.15"
            points={bwArea}
          />
        ) : null}
        {history.length > 1 ? (
          <>
            <polyline
              fill="none"
              points={bwPts}
              stroke="var(--color-rain-500)"
              strokeWidth="1.6"
            />
            <polyline
              fill="none"
              points={ttftPts}
              stroke="var(--color-sun-500)"
              strokeWidth="1.9"
            />
          </>
        ) : null}
        <circle
          className={animated ? "animate-pulse" : undefined}
          cx={width - 2}
          cy={lastTtftY}
          fill="var(--color-sun-500)"
          r="3.2"
        />

        {hoverIdx !== null ? (
          <line
            stroke="hsl(var(--town-foreground))"
            strokeDasharray="2 2"
            strokeOpacity="0.55"
            strokeWidth="1"
            x1={xAt(hoverIdx)}
            x2={xAt(hoverIdx)}
            y1="4"
            y2={track2Top + trackH}
          />
        ) : null}
      </svg>
      <div className="mt-1 flex flex-wrap justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{t(m.deepOscilloscopeCaptionLeft)}</span>
        <span>{t(m.deepOscilloscopeCaptionRight)}</span>
      </div>
    </div>
  );
}

function LiveSlotRow({
  animated,
  slot,
}: {
  readonly animated: boolean;
  readonly slot: DerivedLiveSlot;
}) {
  const t = useT();
  const cachedPct = Math.min(100, (slot.cachedTokens / slot.nCtx) * 100);
  const prefillPct = Math.min(
    100 - cachedPct,
    (slot.prefillTokens / slot.nCtx) * 100,
  );
  const decodePct = Math.min(
    100 - cachedPct - prefillPct,
    (slot.decodeTokens / slot.nCtx) * 100,
  );
  const totalUsedTok =
    slot.cachedTokens + slot.prefillTokens + slot.decodeTokens;

  return (
    <div className="grid grid-cols-[44px_1fr_64px] items-center gap-2 py-1.5 text-xs">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            slot.phase === "decoding"
              ? "bg-lichen-500"
              : slot.phase === "prefill"
                ? "bg-rain-500"
                : slot.phase === "queued"
                  ? "bg-sun-500"
                  : "bg-muted-foreground/30",
            slot.active && animated && "animate-pulse",
          )}
        />
        <span className="font-mono text-[11px] text-muted-foreground">
          S{slot.slotIndex}
        </span>
      </div>

      <div className="min-w-0">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] tabular-nums">
          <span className="truncate font-medium text-foreground">
            {slot.modelName}
          </span>
          <span className="shrink-0 text-muted-foreground">
            {Math.round(totalUsedTok / 1000)}K / {Math.round(slot.nCtx / 1000)}K
          </span>
        </div>
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <motion.span
            animate={{ width: `${cachedPct}%` }}
            className="h-full bg-lake-500"
            transition={{ duration: animated ? 0.35 : 0 }}
          />
          <motion.span
            animate={{ width: `${prefillPct}%` }}
            className={cn(
              "h-full bg-rain-500",
              slot.phase === "prefill" &&
                animated &&
                "telemetry-slot-prefill-shimmer",
            )}
            transition={{ duration: animated ? 0.35 : 0 }}
          />
          <motion.span
            animate={{ width: `${decodePct}%` }}
            className={cn(
              "h-full bg-lichen-500",
              slot.phase === "decoding" && animated && "animate-pulse",
            )}
            transition={{ duration: animated ? 0.35 : 0 }}
          />
        </div>
      </div>

      <div className="text-right text-[11px] tabular-nums">
        {slot.active && slot.tokS !== null ? (
          <span className="font-medium text-foreground">
            {t(m.slotRateCompact, { rate: slot.tokS.toFixed(1) })}
          </span>
        ) : (
          <span className="text-muted-foreground">
            {slot.phase === "queued"
              ? t(m.slotPhaseQueued)
              : t(m.slotPhaseReady)}
          </span>
        )}
      </div>
    </div>
  );
}
