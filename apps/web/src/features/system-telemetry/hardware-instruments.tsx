import { Alert02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { motion } from "motion/react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router";

import { Icon } from "@/components/ui/icon";
import { SettingsGroup } from "@/components/ui/settings-group";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { systemTelemetryMessages as m } from "./system-telemetry.messages";
import { formatGb } from "./telemetry-math";
import type {
  DerivedMemorySegment,
  DerivedTelemetryMetrics,
  MemorySegmentCategory,
  SystemTelemetryWatchdogStatus,
} from "./telemetry-types";

function segmentStroke(category: MemorySegmentCategory): string {
  switch (category) {
    case "weights":
      return "var(--color-rain-500)";
    case "kv_cache":
      return "var(--color-lichen-500)";
    case "compute_buf":
      return "var(--color-bluebell-500)";
    case "external_apps":
      return "var(--color-sun-500)";
    case "reserve":
      return "hsl(var(--town-border-hover))";
    case "free":
      return "hsl(var(--town-muted))";
  }
}

function segmentDotClass(category: MemorySegmentCategory): string {
  switch (category) {
    case "weights":
      return "bg-rain-500";
    case "kv_cache":
      return "bg-lichen-500";
    case "compute_buf":
      return "bg-bluebell-500";
    case "external_apps":
      return "bg-sun-500";
    case "reserve":
      return "bg-border-hover";
    case "free":
      return "bg-muted";
  }
}

function watchdogLabel(
  status: SystemTelemetryWatchdogStatus,
  t: ReturnType<typeof useT>,
): string {
  switch (status) {
    case "clean":
      return t(m.watchdogClean);
    case "oom":
      return t(m.watchdogOom);
    case "memory_starved":
      return t(m.watchdogMemoryStarved);
    case "crashed":
      return t(m.watchdogCrashed);
    default:
      return t(m.watchdogUnknown);
  }
}

export interface HardwareInstrumentsProps {
  readonly animated: boolean;
  readonly metrics: DerivedTelemetryMetrics;
  readonly modelsHref: string;
}

/**
 * Single-layer SettingsGroup 4-cell precision instrument strip with graduated
 * 24-tick dials, multi-segment memory pool bar, and memory-pressure guidance
 * linking cleanly to Settings -> Models.
 */
export function HardwareInstruments({
  animated,
  metrics,
  modelsHref,
}: HardwareInstrumentsProps) {
  const t = useT();
  const poolLabel =
    metrics.poolKind === "unified" ? t(m.poolUnified) : t(m.poolVram);
  const bwHot = (metrics.bwCeilingPct ?? 0) >= 80;
  const tempHot = (metrics.tempC ?? 0) >= 85;
  const memoryPressured =
    metrics.pressureLevel === "elevated" ||
    metrics.pressureLevel === "critical";

  const watchdog = watchdogLabel(metrics.watchdogStatus, t);
  const metaText = metrics.gpuLabel
    ? t(m.hardwareMeta, { gpu: metrics.gpuLabel, watchdog })
    : t(m.hardwareMetaNoGpu, { watchdog });

  const memoryFooter =
    metrics.poolKind === "discrete" &&
    metrics.hostRamUsedGb !== null &&
    metrics.hostRamTotalGb !== null
      ? t(m.hostRamFooter, {
          total: formatGb(metrics.hostRamTotalGb),
          used: formatGb(metrics.hostRamUsedGb),
        })
      : metrics.poolTotalGb !== null
        ? t(m.unifiedFooter, { total: formatGb(metrics.poolTotalGb) })
        : "\u2014";

  const unavailableTitle = t(m.unavailableSensorTooltip);

  return (
    <SettingsGroup
      action={
        <Link
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          to={modelsHref}
        >
          <span>{t(m.openModels)}</span>
          <Icon icon={ArrowRight01Icon} size={12} />
        </Link>
      }
      label={t(m.hardwareHeading)}
      meta={metaText}
    >
      <div className="grid grid-cols-1 divide-y divide-border sm:grid-cols-2 lg:grid-cols-4 lg:divide-x lg:divide-y-0">
        <PrecisionMemoryDial
          animated={animated}
          footerText={memoryFooter}
          pct={metrics.poolPct}
          poolLabel={poolLabel}
          pressured={memoryPressured}
          segments={metrics.segments}
          totalGb={metrics.poolTotalGb}
          usedGb={metrics.poolUsedGb}
        />

        <PrecisionArcDial
          animated={animated}
          basis={metrics.effectiveDecodeBwBasis}
          footerLeft={
            metrics.effectiveDecodeBwGbS !== null ? (
              t(m.effDecodeFooter, {
                value: `${metrics.effectiveDecodeBwGbS.toFixed(0)} GB/s`,
              })
            ) : (
              <span data-basis="none" title={unavailableTitle}>
                {"\u2014"}
              </span>
            )
          }
          footerRight={
            metrics.bwCeilingPct !== null ? (
              t(m.bwCeilingRight, { pct: metrics.bwCeilingPct })
            ) : (
              <span data-basis="none" title={unavailableTitle}>
                {"\u2014"}
              </span>
            )
          }
          label={t(m.memoryBandwidthLabel)}
          pct={metrics.bwCeilingPct}
          strokeVar={bwHot ? "var(--color-sun-500)" : "var(--color-rain-500)"}
          sub={
            metrics.activeWeightGb !== null
              ? t(m.memoryBandwidthSub, {
                  gb: metrics.activeWeightGb.toFixed(1),
                })
              : t(m.memoryBandwidthSubDefault)
          }
          unavailableTooltip={unavailableTitle}
          unit="GB/s"
          value={
            metrics.effectiveDecodeBwGbS !== null
              ? metrics.effectiveDecodeBwGbS.toFixed(0)
              : null
          }
          warn={bwHot}
        />

        <PrecisionArcDial
          animated={animated}
          basis={metrics.gpuUtilBasis}
          footerLeft={
            metrics.tempC !== null ? (
              <span
                className={tempHot ? "font-medium text-sun-700" : undefined}
              >
                {t(m.dieTemp, { temp: metrics.tempC })}
              </span>
            ) : (
              <span data-basis="none" title={unavailableTitle}>
                {"\u2014"}
              </span>
            )
          }
          footerRight={
            metrics.powerW !== null ? (
              metrics.powerLimitW !== null ? (
                t(m.powerFraction, {
                  limit: metrics.powerLimitW,
                  used: metrics.powerW,
                })
              ) : (
                t(m.powerOnly, { used: metrics.powerW })
              )
            ) : (
              <span data-basis="none" title={unavailableTitle}>
                {"\u2014"}
              </span>
            )
          }
          label={t(m.gpuComputeLabel)}
          pct={metrics.gpuUtilPct}
          strokeVar={
            tempHot ? "var(--color-sun-500)" : "var(--color-lichen-500)"
          }
          sub={metrics.gpuLabel || t(m.gpuComputeSubDefault)}
          unavailableTooltip={unavailableTitle}
          unit="%"
          value={metrics.gpuUtilPct !== null ? `${metrics.gpuUtilPct}` : null}
          warn={tempHot}
        />

        <PrecisionCpuInstrument
          animated={animated}
          cores={metrics.cpuCores}
          cpuLabel={
            metrics.logicalCores !== null
              ? t(m.cpuCoresLabel, { count: metrics.logicalCores })
              : t(m.cpuLabelDefault)
          }
          cpuPct={metrics.cpuLoadPct}
          diskReadMbS={metrics.diskReadMbS}
          unavailableTooltip={unavailableTitle}
        />
      </div>

      {/* Multi-segment Memory Pool Bar + Quiet Pressure Banner */}
      <div
        className={cn(
          "space-y-2 border-t border-border px-4 py-3 text-xs",
          memoryPressured ? "bg-sun-500/8" : "bg-app-canvas/45",
        )}
      >
        {metrics.poolTotalGb !== null && metrics.segments.length > 0 ? (
          <>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
              {metrics.segments
                .filter(
                  (segment) => segment.category !== "free" && segment.gb > 0.05,
                )
                .map((segment) => (
                  <motion.span
                    animate={{
                      width: `${Math.min(100, (segment.gb / Math.max(0.1, metrics.poolTotalGb ?? 1)) * 100)}%`,
                    }}
                    className="h-full border-r border-card last:border-r-0"
                    key={segment.id}
                    style={{ backgroundColor: segmentStroke(segment.category) }}
                    title={`${segment.label}: ${formatGb(segment.gb)}`}
                    transition={{ duration: animated ? 0.4 : 0 }}
                  />
                ))}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[11px] tabular-nums text-muted-foreground">
                {metrics.segments
                  .filter((segment) => segment.gb > 0.05)
                  .map((segment) => (
                    <span
                      className="inline-flex items-center gap-1.5"
                      key={segment.id}
                    >
                      <span
                        className={cn(
                          "size-1.5 rounded-full",
                          segmentDotClass(segment.category),
                        )}
                      />
                      <span>{segment.label}</span>
                      <span className="font-medium text-foreground">
                        {formatGb(segment.gb)}
                      </span>
                    </span>
                  ))}
              </div>
            </div>
          </>
        ) : null}

        {memoryPressured ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 pt-0.5 text-[11px]"
            role="status"
          >
            <span className="inline-flex min-w-0 items-center gap-1.5 font-medium text-sun-700">
              <Icon className="shrink-0" icon={Alert02Icon} size={13} />
              <span className="truncate">
                {metrics.externalHolders.length > 0
                  ? t(m.pressureBannerHolders, {
                      holders: metrics.externalHolders.slice(0, 4).join(", "),
                    })
                  : t(m.pressureBannerGeneric)}
              </span>
            </span>
            <Link
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-sun-500/40 bg-card px-2.5 py-0.5 font-medium text-foreground transition-colors hover:border-sun-500/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              to={modelsHref}
            >
              <span>{t(m.recheckInModels)}</span>
              <Icon icon={ArrowRight01Icon} size={11} />
            </Link>
          </div>
        ) : null}
      </div>
    </SettingsGroup>
  );
}

/** 24 graduated micro-ticks around a 240-degree precision dial. */
function DialTicks({
  cx,
  cy,
  outerR,
}: {
  readonly cx: number;
  readonly cy: number;
  readonly outerR: number;
}) {
  const ticks = useMemo(
    () =>
      Array.from({ length: 25 }, (_, i) => {
        const deg = 150 + (i / 24) * 240;
        const rad = (deg * Math.PI) / 180;
        const major = i % 6 === 0;
        const r1 = outerR - (major ? 4.5 : 2.6);
        const r2 = outerR;
        return {
          i,
          major,
          x1: cx + r1 * Math.cos(rad),
          y1: cy + r1 * Math.sin(rad),
          x2: cx + r2 * Math.cos(rad),
          y2: cy + r2 * Math.sin(rad),
        };
      }),
    [cx, cy, outerR],
  );

  return (
    <g aria-hidden="true">
      {ticks.map((tick) => (
        <line
          key={tick.i}
          stroke="hsl(var(--town-muted-foreground))"
          strokeLinecap="round"
          strokeOpacity={tick.major ? 0.55 : 0.25}
          strokeWidth={tick.major ? 1.2 : 0.8}
          x1={tick.x1}
          x2={tick.x2}
          y1={tick.y1}
          y2={tick.y2}
        />
      ))}
    </g>
  );
}

function PrecisionArcDial({
  animated,
  basis,
  footerLeft,
  footerRight,
  label,
  pct,
  strokeVar,
  sub,
  unavailableTooltip,
  unit,
  value,
  warn,
}: {
  readonly animated: boolean;
  readonly basis: string;
  readonly footerLeft: ReactNode;
  readonly footerRight: ReactNode;
  readonly label: string;
  readonly pct: number | null;
  readonly strokeVar: string;
  readonly sub: string;
  readonly unavailableTooltip: string;
  readonly unit: string;
  readonly value: string | null;
  readonly warn: boolean;
}) {
  const clamped = pct !== null ? Math.min(100, Math.max(0, pct)) : 0;
  const r = 34;
  const cx = 50;
  const cy = 50;
  const sweepDeg = 240;
  const circumference = 2 * Math.PI * r;
  const arcLen = (sweepDeg / 360) * circumference;
  const filledLen = (clamped / 100) * arcLen;

  const tipAngleRad = ((150 + (clamped / 100) * sweepDeg) * Math.PI) / 180;
  const tipX = cx + r * Math.cos(tipAngleRad);
  const tipY = cy + r * Math.sin(tipAngleRad);

  return (
    <div
      className={cn(
        "flex flex-col justify-between p-4 transition-colors",
        warn && "bg-sun-500/6",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">
          {label}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums",
            warn ? "font-semibold text-sun-700" : "text-muted-foreground",
          )}
        >
          {footerRight}
        </span>
      </div>

      <div className="my-1 flex flex-col items-center">
        <div
          className="relative size-[100px]"
          data-basis={value === null ? "none" : basis}
          title={value === null ? unavailableTooltip : undefined}
        >
          <svg aria-hidden="true" className="size-full" viewBox="0 0 100 100">
            <DialTicks cx={cx} cy={cy} outerR={46} />
            <circle
              cx={cx}
              cy={cy}
              fill="none"
              r={r}
              stroke="hsl(var(--town-muted))"
              strokeDasharray={`${arcLen} ${circumference}`}
              strokeLinecap="round"
              strokeWidth="5.5"
              transform={`rotate(150 ${cx} ${cy})`}
            />
            {pct !== null ? (
              <motion.circle
                animate={{
                  strokeDasharray: `${filledLen} ${circumference}`,
                }}
                cx={cx}
                cy={cy}
                fill="none"
                r={r}
                stroke={strokeVar}
                strokeLinecap="round"
                strokeWidth="5.5"
                transform={`rotate(150 ${cx} ${cy})`}
                transition={{ duration: animated ? 0.45 : 0, ease: "easeOut" }}
              />
            ) : null}
            {pct !== null && clamped > 2 ? (
              <circle
                cx={tipX}
                cy={tipY}
                fill="hsl(var(--town-card))"
                r="3.4"
                stroke={strokeVar}
                strokeWidth="2.2"
              />
            ) : null}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
            <span className="text-lg font-semibold leading-none tabular-nums text-foreground">
              {value ?? "\u2014"}
            </span>
            {value !== null ? (
              <span className="mt-0.5 text-[10px] text-muted-foreground">
                {unit}
              </span>
            ) : null}
          </div>
        </div>
        <span className="max-w-full truncate text-[10px] text-muted-foreground">
          {sub}
        </span>
      </div>

      <p className="truncate text-center text-[11px] tabular-nums text-muted-foreground">
        {footerLeft}
      </p>
    </div>
  );
}

function PrecisionMemoryDial({
  animated,
  footerText,
  pct,
  poolLabel,
  pressured,
  segments,
  totalGb,
  usedGb,
}: {
  readonly animated: boolean;
  readonly footerText: string;
  readonly pct: number | null;
  readonly poolLabel: string;
  readonly pressured: boolean;
  readonly segments: readonly DerivedMemorySegment[];
  readonly totalGb: number | null;
  readonly usedGb: number | null;
}) {
  const t = useT();
  const r = 34;
  const cx = 50;
  const cy = 50;
  const circumference = 2 * Math.PI * r;

  const arcs = useMemo(() => {
    if (!totalGb || totalGb <= 0) return [];
    let offset = 0;
    return segments
      .filter((segment) => segment.category !== "free" && segment.gb > 0)
      .map((segment) => {
        const len = (segment.gb / totalGb) * circumference;
        const entry = { segment, len, offset };
        offset += len;
        return entry;
      });
  }, [circumference, segments, totalGb]);

  const freeGb =
    totalGb !== null && usedGb !== null ? Math.max(0, totalGb - usedGb) : null;

  return (
    <div
      className={cn(
        "flex flex-col justify-between p-4 transition-colors",
        pressured && "bg-sun-500/6",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">
          {poolLabel}
        </span>
        <span
          className={cn(
            "shrink-0 text-[11px] tabular-nums",
            pressured ? "font-semibold text-sun-700" : "text-muted-foreground",
          )}
        >
          {freeGb !== null
            ? t(m.poolFree, { free: formatGb(freeGb) })
            : "\u2014"}
        </span>
      </div>

      <div className="my-1 flex flex-col items-center">
        <div className="relative size-[100px]">
          <svg aria-hidden="true" className="size-full" viewBox="0 0 100 100">
            <DialTicks cx={cx} cy={cy} outerR={46} />
            <g transform={`rotate(-90 ${cx} ${cy})`}>
              <circle
                cx={cx}
                cy={cy}
                fill="none"
                r={r}
                stroke="hsl(var(--town-muted))"
                strokeWidth="5.5"
              />
              {arcs.map(({ segment, len, offset }) => (
                <motion.circle
                  animate={{
                    strokeDasharray: `${Math.max(0, len - 1.4)} ${circumference}`,
                    strokeDashoffset: -offset,
                  }}
                  cx={cx}
                  cy={cy}
                  fill="none"
                  key={segment.id}
                  r={r}
                  stroke={segmentStroke(segment.category)}
                  strokeWidth="5.5"
                  transition={{ duration: animated ? 0.45 : 0 }}
                />
              ))}
            </g>
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-lg font-semibold leading-none tabular-nums text-foreground">
              {pct !== null ? `${pct}%` : "\u2014"}
            </span>
            {usedGb !== null && totalGb !== null ? (
              <span className="mt-0.5 text-[10px] tabular-nums text-muted-foreground">
                {usedGb.toFixed(0)}/{totalGb.toFixed(0)}G
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <p className="truncate text-center text-[11px] tabular-nums text-muted-foreground">
        {footerText}
      </p>
    </div>
  );
}

function PrecisionCpuInstrument({
  animated,
  cores,
  cpuLabel,
  cpuPct,
  diskReadMbS,
  unavailableTooltip,
}: {
  readonly animated: boolean;
  readonly cores: readonly { readonly core: number; readonly pct: number }[];
  readonly cpuLabel: string;
  readonly cpuPct: number | null;
  readonly diskReadMbS: number | null;
  readonly unavailableTooltip: string;
}) {
  const t = useT();
  const visibleCores = cores.slice(0, 32);

  return (
    <div className="flex flex-col justify-between p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground">
          {t(m.cpuDiskLabel)}
        </span>
        <span
          className="shrink-0 text-xs font-semibold tabular-nums text-foreground"
          data-basis={cpuPct === null ? "none" : "live"}
          title={cpuPct === null ? unavailableTooltip : undefined}
        >
          {cpuPct !== null ? `${cpuPct}%` : "\u2014"}
        </span>
      </div>

      <div className="my-2 flex flex-col justify-end">
        <div className="flex h-[68px] w-full items-end gap-[3px]">
          {visibleCores.length > 0 ? (
            visibleCores.map((core) => (
              <div
                className="flex h-full flex-1 flex-col justify-end rounded-[2px] bg-muted/85"
                key={core.core}
                title={`CPU ${core.core}: ${core.pct}%`}
              >
                <motion.span
                  animate={{ height: `${core.pct}%` }}
                  className="w-full rounded-[2px] bg-bluebell-500"
                  transition={{ duration: animated ? 0.35 : 0 }}
                />
              </div>
            ))
          ) : (
            <div className="flex h-full w-full items-center justify-center rounded-md bg-muted/50 text-xs text-muted-foreground">
              <span data-basis="none" title={unavailableTooltip}>
                {"\u2014"}
              </span>
            </div>
          )}
        </div>
        <span className="mt-1.5 truncate text-center text-[10px] text-muted-foreground">
          {cpuLabel}
        </span>
      </div>

      <p className="truncate text-center text-[11px] tabular-nums text-muted-foreground">
        {t(m.modelDiskRead)}{" "}
        <strong
          className="font-medium text-foreground"
          data-basis={diskReadMbS === null ? "none" : "live"}
          title={diskReadMbS === null ? unavailableTooltip : undefined}
        >
          {diskReadMbS !== null
            ? t(m.diskReadValue, { mbS: diskReadMbS.toLocaleString() })
            : "\u2014"}
        </strong>
      </p>
    </div>
  );
}
