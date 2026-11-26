import {
  AiChipIcon,
  ArrowRight01Icon,
  Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Link } from "react-router";

import { Icon } from "@/components/ui/icon";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { systemTelemetryMessages as m } from "./system-telemetry.messages";
import { formatGb, formatMs, formatTokS } from "./telemetry-math";
import type {
  DerivedTelemetryMetrics,
  TelemetryAccentKey,
  TelemetryHistoryPoint,
  TelemetryOpticalTarget,
} from "./telemetry-types";

const STAGE_W = 940;
const STAGE_H = 340;
const HUB_Y = 170;

const ACCENT_CSS_VAR: Record<TelemetryAccentKey, string> = {
  rain: "var(--color-rain-500)",
  lichen: "var(--color-lichen-500)",
  bluebell: "var(--color-bluebell-500)",
  lavender: "var(--color-lavender-500)",
};

const ACCENT_DOT_CLASS: Record<TelemetryAccentKey, string> = {
  rain: "bg-rain-500",
  lichen: "bg-lichen-500",
  bluebell: "bg-bluebell-500",
  lavender: "bg-lavender-500",
};

const MODEL_ACCENT_VAR = [
  "var(--color-rain-500)",
  "var(--color-lichen-500)",
  "var(--color-lavender-500)",
] as const;

function nodeCenterY(index: number, count: number): number {
  if (count <= 1) return HUB_Y;
  const pad = count >= 4 ? 46 : 64;
  const usable = STAGE_H - pad * 2;
  return pad + (index / (count - 1)) * usable;
}

/** Updates local cursor coordinates (--lx, --ly) for the tactile navlamp sheen. */
function handleNavLampMove(event: ReactMouseEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  event.currentTarget.style.setProperty(
    "--lx",
    `${(event.clientX - rect.left).toFixed(0)}px`,
  );
  event.currentTarget.style.setProperty(
    "--ly",
    `${(event.clientY - rect.top).toFixed(0)}px`,
  );
}

export interface PiRoutingStageProps {
  readonly animated: boolean;
  readonly history: readonly TelemetryHistoryPoint[];
  readonly lockedTarget: TelemetryOpticalTarget;
  readonly metrics: DerivedTelemetryMetrics;
  readonly modelsHref: string;
  readonly onClearSpotlight: () => void;
  readonly onToggleSpotlight: (target: TelemetryOpticalTarget) => void;
}

/**
 * Magpie-inspired 3-column optical routing stage visualizing live Pi Agents ->
 * Bifrost Pi Gateway -> Loaded Local Models with layered Bezier tracks and
 * interactive route spotlighting.
 */
export function PiRoutingStage({
  animated,
  history,
  lockedTarget,
  metrics,
  modelsHref,
  onClearSpotlight,
  onToggleSpotlight,
}: PiRoutingStageProps) {
  const t = useT();
  const [hoveredTarget, setHoveredTarget] = useState<TelemetryOpticalTarget>({
    kind: "none",
  });

  const spotlight: TelemetryOpticalTarget =
    hoveredTarget.kind !== "none" ? hoveredTarget : lockedTarget;

  const visibleClients = metrics.clients.slice(0, 4);
  const visibleModels = metrics.models.slice(0, 3);

  const isClientLit = (clientId: string, targetModelId: string): boolean => {
    if (spotlight.kind === "none") return true;
    if (spotlight.kind === "client") return spotlight.id === clientId;
    return targetModelId === spotlight.id;
  };

  const isModelLit = (modelId: string): boolean => {
    if (spotlight.kind === "none") return true;
    if (spotlight.kind === "model") return spotlight.id === modelId;
    return spotlight.targetModelId === modelId;
  };

  const decodePacketDur = useMemo(() => {
    const rate = metrics.decodeTokS ?? 0;
    if (rate <= 0) return 2.4;
    return Math.max(0.62, Math.min(2.1, 68 / Math.max(14, rate)));
  }, [metrics.decodeTokS]);

  const sparkPath = useMemo(() => {
    const points = history.slice(-28);
    if (points.length < 2) return "";
    const maxVal = Math.max(20, ...points.map((point) => point.decodeTokS));
    return points
      .map((point, index) => {
        const x = (index / Math.max(1, points.length - 1)) * 72;
        const y = 18 - (point.decodeTokS / maxVal) * 14;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [history]);

  const activeClientCount = metrics.clients.filter(
    (client) => client.activeStreams > 0,
  ).length;
  const bwHot = (metrics.bwCeilingPct ?? 0) >= 80;

  return (
    <section
      aria-label={t(m.routingRegion)}
      className="px-1.5"
      data-telemetry-stage=""
    >
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2 px-1.5 pb-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xs font-medium text-muted-foreground">
            {t(m.routingHeading)}
          </h2>
          <span className="text-xs tabular-nums text-muted-foreground/80">
            {t(m.routingMeta, {
              agents: activeClientCount,
              inFlight: metrics.inFlight,
              maxSlots: metrics.maxSlots,
            })}
          </span>
          {lockedTarget.kind !== "none" ? (
            <button
              aria-label={t(m.clearSpotlight)}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-px text-[11px] font-medium text-foreground shadow-outline transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onClearSpotlight}
              type="button"
            >
              <span>{t(m.spotlightLabel, { name: lockedTarget.name })}</span>
              <Icon icon={Cancel01Icon} size={10} />
            </button>
          ) : null}
        </div>

        <div className="hidden items-center gap-4 text-[11px] text-muted-foreground sm:flex">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-rain-500 shadow-[0_0_6px_var(--color-rain-500)]" />
            {t(m.legendPrompt)}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-full border-2 border-lichen-500 bg-card shadow-[0_0_6px_var(--color-lichen-500)]" />
            {t(m.legendDecode)}
          </span>
          <span className="inline-flex items-center gap-1.5 tabular-nums text-foreground">
            {sparkPath ? (
              <svg aria-hidden="true" className="h-4 w-14" viewBox="0 0 72 20">
                <polyline
                  fill="none"
                  points={sparkPath}
                  stroke="var(--color-lichen-500)"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                />
              </svg>
            ) : null}
            <strong className="font-medium">
              {formatTokS(metrics.decodeTokS)}
            </strong>
          </span>
        </div>
      </div>

      {/* Blueprint Micro-Dot Optical Stage */}
      <div className="telemetry-stage relative overflow-hidden rounded-2xl border border-border p-4 sm:p-5">
        <div className="mb-3 hidden grid-cols-[248px_1fr_256px] items-center text-[10px] font-medium uppercase tracking-widest text-muted-foreground/85 lg:grid">
          <span className="pl-1">{t(m.columnPiAgents)}</span>
          <span className="text-center">
            {metrics.gatewayAddr
              ? t(m.columnGateway, { addr: metrics.gatewayAddr })
              : t(m.columnGatewayDefault)}
          </span>
          <span className="pr-1 text-right">{t(m.columnModels)}</span>
        </div>

        <div className="relative min-h-[340px]">
          {/* Layered SVG Optical Bezier Tracks */}
          <svg
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 hidden h-full w-full lg:block"
            preserveAspectRatio="none"
            viewBox={`0 0 ${STAGE_W} ${STAGE_H}`}
          >
            <defs>
              <filter
                height="220%"
                id="telemetry-bead-glow"
                width="220%"
                x="-60%"
                y="-60%"
              >
                <feGaussianBlur result="blur" stdDeviation="2.6" />
                <feMerge>
                  <feMergeNode in="blur" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Left Optical Tracks: Pi Agents -> Bifrost Pi Hub */}
            {visibleClients.map((client, idx) => {
              const y = nodeCenterY(idx, visibleClients.length);
              const d = `M 248 ${y} C 318 ${y}, 334 ${HUB_Y}, 372 ${HUB_Y}`;
              const revD = `M 372 ${HUB_Y} C 334 ${HUB_Y}, 318 ${y}, 248 ${y}`;
              const active = client.activeStreams > 0;
              const lit = isClientLit(client.id, client.targetModelId);
              const accent = ACCENT_CSS_VAR[client.accent];
              const dimmed = spotlight.kind !== "none" && !lit;

              return (
                <g
                  key={client.id}
                  opacity={dimmed ? 0.22 : 1}
                  style={{ transition: "opacity 200ms ease" }}
                >
                  {active ? (
                    <path
                      d={d}
                      fill="none"
                      stroke={accent}
                      strokeLinecap="round"
                      strokeOpacity={
                        spotlight.kind !== "none" && lit ? 0.28 : 0.14
                      }
                      strokeWidth={spotlight.kind !== "none" && lit ? 8 : 6}
                    />
                  ) : null}

                  <path
                    className={
                      active && animated
                        ? "telemetry-rtflow-carrier"
                        : undefined
                    }
                    d={d}
                    fill="none"
                    stroke={active ? accent : "hsl(var(--town-border-hover))"}
                    strokeOpacity={active ? 0.85 : 0.55}
                    strokeWidth={
                      active
                        ? spotlight.kind !== "none" && lit
                          ? 2.4
                          : 1.9
                        : 1.1
                    }
                  />

                  {active && animated ? (
                    <>
                      <circle
                        data-telemetry-packet="outbound"
                        fill={accent}
                        filter="url(#telemetry-bead-glow)"
                        r="4"
                      >
                        <animateMotion
                          begin={`-${(idx * 0.24).toFixed(2)}s`}
                          dur={`${(decodePacketDur * 1.08).toFixed(2)}s`}
                          path={d}
                          repeatCount="indefinite"
                        />
                      </circle>
                      <circle
                        data-telemetry-packet="return"
                        fill="hsl(var(--town-card))"
                        filter="url(#telemetry-bead-glow)"
                        r="4"
                        stroke="var(--color-lichen-500)"
                        strokeWidth="2.1"
                      >
                        <animateMotion
                          begin={`-${(idx * 0.31 + 0.18).toFixed(2)}s`}
                          dur={`${decodePacketDur.toFixed(2)}s`}
                          path={revD}
                          repeatCount="indefinite"
                        />
                      </circle>
                    </>
                  ) : null}
                </g>
              );
            })}

            {/* Right Optical Tracks: Bifrost Pi Hub -> Loaded Local Models */}
            {visibleModels.map((model, idx) => {
              const y = nodeCenterY(idx, visibleModels.length);
              const d = `M 568 ${HUB_Y} C 612 ${HUB_Y}, 626 ${y}, 684 ${y}`;
              const revD = `M 684 ${y} C 626 ${y}, 612 ${HUB_Y}, 568 ${HUB_Y}`;
              const active = model.activeSlots > 0 || model.loading;
              const lit = isModelLit(model.id);
              const dimmed = spotlight.kind !== "none" && !lit;
              const stroke = model.loading
                ? "var(--color-sun-500)"
                : (MODEL_ACCENT_VAR[idx] ?? "var(--color-lichen-500)");

              return (
                <g
                  key={model.componentId}
                  opacity={dimmed ? 0.22 : 1}
                  style={{ transition: "opacity 200ms ease" }}
                >
                  {active ? (
                    <path
                      d={d}
                      fill="none"
                      stroke={stroke}
                      strokeLinecap="round"
                      strokeOpacity={
                        spotlight.kind !== "none" && lit ? 0.28 : 0.14
                      }
                      strokeWidth={spotlight.kind !== "none" && lit ? 8 : 6}
                    />
                  ) : null}

                  <path
                    className={
                      active && animated
                        ? "telemetry-rtflow-carrier"
                        : undefined
                    }
                    d={d}
                    fill="none"
                    stroke={active ? stroke : "hsl(var(--town-border-hover))"}
                    strokeOpacity={active ? 0.88 : 0.55}
                    strokeWidth={
                      active
                        ? spotlight.kind !== "none" && lit
                          ? 2.4
                          : 2
                        : 1.1
                    }
                  />

                  {active && animated ? (
                    <>
                      <circle
                        data-telemetry-packet="outbound"
                        fill={stroke}
                        filter="url(#telemetry-bead-glow)"
                        r="4.2"
                      >
                        <animateMotion
                          begin={`-${(idx * 0.2).toFixed(2)}s`}
                          dur={`${(decodePacketDur * 1.02).toFixed(2)}s`}
                          path={d}
                          repeatCount="indefinite"
                        />
                      </circle>
                      {model.activeSlots > 0 ? (
                        <circle
                          data-telemetry-packet="return"
                          fill="hsl(var(--town-card))"
                          filter="url(#telemetry-bead-glow)"
                          r="4.2"
                          stroke="var(--color-lichen-500)"
                          strokeWidth="2.1"
                        >
                          <animateMotion
                            begin={`-${(idx * 0.26 + 0.3).toFixed(2)}s`}
                            dur={`${decodePacketDur.toFixed(2)}s`}
                            path={revD}
                            repeatCount="indefinite"
                          />
                        </circle>
                      ) : null}
                    </>
                  ) : null}
                </g>
              );
            })}
          </svg>

          {/* 3-Column Tactile Instrument Nodes */}
          <div className="relative z-10 grid min-h-[340px] grid-cols-1 items-center gap-4 lg:grid-cols-[248px_1fr_256px]">
            {/* Left Column: Pi Agents */}
            <div className="flex flex-col gap-2.5">
              {visibleClients.length > 0 ? (
                visibleClients.map((client) => {
                  const active = client.activeStreams > 0;
                  const lit = isClientLit(client.id, client.targetModelId);
                  const dimmed = spotlight.kind !== "none" && !lit;
                  const locked =
                    lockedTarget.kind === "client" &&
                    lockedTarget.id === client.id;
                  const accentVar = ACCENT_CSS_VAR[client.accent];

                  return (
                    <button
                      aria-pressed={locked}
                      className={cn(
                        "telemetry-node flex h-[74px] w-full items-center justify-between gap-2.5 rounded-xl border bg-card px-3 text-left shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        locked
                          ? "border-foreground/55 ring-1 ring-foreground/20"
                          : active
                            ? "border-border-hover hover:border-foreground/35"
                            : "border-border/85",
                        dimmed && "opacity-30",
                      )}
                      data-telemetry-client={client.id}
                      key={client.id}
                      onClick={() =>
                        onToggleSpotlight({
                          kind: "client",
                          id: client.id,
                          name: client.name,
                          targetModelId: client.targetModelId,
                        })
                      }
                      onMouseEnter={() =>
                        setHoveredTarget({
                          kind: "client",
                          id: client.id,
                          name: client.name,
                          targetModelId: client.targetModelId,
                        })
                      }
                      onMouseLeave={() => setHoveredTarget({ kind: "none" })}
                      onMouseMove={handleNavLampMove}
                      type="button"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span
                          aria-hidden="true"
                          className={cn(
                            "size-2.5 shrink-0 rounded-full",
                            active
                              ? ACCENT_DOT_CLASS[client.accent]
                              : "bg-muted-foreground/30",
                            active && animated && "animate-pulse",
                          )}
                          style={
                            active
                              ? { boxShadow: `0 0 8px ${accentVar}` }
                              : undefined
                          }
                        />
                        <div className="min-w-0">
                          <p className="truncate text-[13px] font-medium leading-tight text-foreground">
                            {client.name}
                          </p>
                          <p className="mt-0.5 truncate text-[10.5px] text-muted-foreground">
                            {t(m.clientRuntimeLabel)}
                          </p>
                          <p className="mt-0.5 truncate text-[11px] tabular-nums text-muted-foreground">
                            {active
                              ? client.recentTokS !== null
                                ? t(m.clientStreamsWithRate, {
                                    count: client.activeStreams,
                                    rate: formatTokS(client.recentTokS),
                                  })
                                : t(m.clientStreams, {
                                    count: client.activeStreams,
                                  })
                              : t(m.clientStandby)}
                          </p>
                        </div>
                      </div>

                      <div className="flex shrink-0 flex-col items-end gap-1.5">
                        <div
                          aria-hidden="true"
                          className="flex h-3.5 items-end gap-[2px]"
                        >
                          {active ? (
                            <>
                              <span
                                className={cn(
                                  "h-full w-[2.5px] rounded-full",
                                  animated && "telemetry-eq-bar-1",
                                )}
                                style={{ backgroundColor: accentVar }}
                              />
                              <span
                                className={cn(
                                  "h-full w-[2.5px] rounded-full",
                                  animated && "telemetry-eq-bar-2",
                                )}
                                style={{ backgroundColor: accentVar }}
                              />
                              <span
                                className={cn(
                                  "h-full w-[2.5px] rounded-full",
                                  animated && "telemetry-eq-bar-3",
                                )}
                                style={{ backgroundColor: accentVar }}
                              />
                            </>
                          ) : (
                            <span className="h-[3px] w-3 rounded-full bg-muted" />
                          )}
                        </div>
                        {client.recentRequests > 0 ? (
                          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                            {t(m.clientRecentReqs, {
                              count: client.recentRequests,
                            })}
                          </span>
                        ) : null}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-card/75 px-3.5 py-4 text-left">
                  <p className="text-xs font-medium text-foreground">
                    {t(m.noActivePiClients)}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t(m.noActivePiClientsHint)}
                  </p>
                </div>
              )}
            </div>

            {/* Center Hub: Bifrost Gateway · Pi */}
            <div className="flex items-center justify-center py-2">
              <div className="relative w-full max-w-[196px]">
                {animated && metrics.inFlight > 0 ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "telemetry-hub-pulse-ring pointer-events-none absolute -inset-1.5 rounded-2xl border",
                      bwHot ? "border-sun-500/45" : "border-rain-500/35",
                    )}
                  />
                ) : null}

                <div
                  className={cn(
                    "telemetry-node relative rounded-2xl border bg-card p-3.5 shadow-md",
                    bwHot ? "border-sun-500/55" : "border-border-hover",
                  )}
                  onMouseMove={handleNavLampMove}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-foreground">
                      <span className="flex size-5 items-center justify-center rounded-md bg-foreground text-primary-foreground">
                        <Icon icon={AiChipIcon} size={12} />
                      </span>
                      {t(m.gatewayName)}
                    </span>
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2 rounded-full",
                        metrics.inFlight > 0
                          ? "bg-lake-500"
                          : "bg-muted-foreground/35",
                      )}
                    />
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                    {metrics.gatewayAddr ?? t(m.gatewayLocalAddress)}
                  </p>

                  <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/80 pt-2.5 text-xs tabular-nums">
                    <div>
                      <span className="block text-[10px] text-muted-foreground">
                        {t(m.gatewayInFlight)}
                      </span>
                      <span className="text-sm font-semibold text-foreground">
                        {metrics.inFlight}
                        <span className="text-[11px] font-normal text-muted-foreground">
                          /{metrics.maxSlots}
                        </span>
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-muted-foreground">
                        {t(m.gatewayP50Ttft)}
                      </span>
                      <span className="text-sm font-semibold text-foreground">
                        {formatMs(metrics.p50TtftMs)}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-muted-foreground">
                        {t(m.gatewayPrefixHit)}
                      </span>
                      <span className="font-medium text-lake-700">
                        {metrics.prefixHitPct !== null
                          ? `${metrics.prefixHitPct}%`
                          : "\u2014"}
                      </span>
                    </div>
                    <div>
                      <span className="block text-[10px] text-muted-foreground">
                        {t(m.gatewayDeferred)}
                      </span>
                      <span
                        className={cn(
                          "font-medium",
                          (metrics.deferredCount ?? 0) > 0
                            ? "text-sun-700"
                            : "text-muted-foreground",
                        )}
                      >
                        {metrics.deferredCount !== null
                          ? metrics.deferredCount
                          : "\u2014"}
                      </span>
                    </div>
                  </div>

                  <div className="mt-3 border-t border-border/80 pt-2.5">
                    <div className="flex items-baseline justify-between text-[10.5px] tabular-nums">
                      <span className="text-muted-foreground">
                        {t(m.gatewayMemBus)}
                      </span>
                      <span
                        className={cn(
                          "font-semibold",
                          bwHot ? "text-sun-700" : "text-foreground",
                        )}
                      >
                        {metrics.effectiveDecodeBwGbS !== null
                          ? `${metrics.effectiveDecodeBwGbS.toFixed(0)} GB/s`
                          : "\u2014"}
                      </span>
                    </div>
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn(
                          "h-full rounded-full",
                          animated &&
                            "transition-[width] duration-300 ease-out motion-reduce:transition-none",
                          bwHot ? "bg-sun-500" : "bg-rain-500",
                        )}
                        style={{
                          width: `${Math.min(100, Math.max(0, metrics.bwCeilingPct ?? 0))}%`,
                        }}
                      />
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] tabular-nums text-muted-foreground">
                      <span>
                        {metrics.bwCeilingPct !== null
                          ? t(m.gatewayCeilingPct, {
                              pct: metrics.bwCeilingPct,
                            })
                          : "\u2014"}
                      </span>
                      <span>
                        {metrics.bwCeilingGbS !== null
                          ? t(m.gatewayCeilingMax, {
                              gbS: Math.round(metrics.bwCeilingGbS),
                            })
                          : "\u2014"}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Loaded Local Models */}
            <div className="flex flex-col gap-3">
              {visibleModels.length > 0 ? (
                visibleModels.map((model, idx) => {
                  const active = model.activeSlots > 0;
                  const lit = isModelLit(model.id);
                  const dimmed = spotlight.kind !== "none" && !lit;
                  const locked =
                    lockedTarget.kind === "model" &&
                    lockedTarget.id === model.id;
                  const modelAccent =
                    MODEL_ACCENT_VAR[idx] ?? "var(--color-lichen-500)";

                  return (
                    <button
                      aria-pressed={locked}
                      className={cn(
                        "telemetry-node w-full rounded-xl border bg-card px-3.5 py-3 text-left shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        model.loading
                          ? "border-sun-500/50"
                          : locked
                            ? "border-foreground/55 ring-1 ring-foreground/20"
                            : active
                              ? "border-border-hover hover:border-foreground/35"
                              : "border-border/85",
                        dimmed && "opacity-30",
                      )}
                      data-telemetry-model={model.id}
                      key={model.componentId}
                      onClick={() =>
                        onToggleSpotlight({
                          kind: "model",
                          id: model.id,
                          name: model.name,
                        })
                      }
                      onMouseEnter={() =>
                        setHoveredTarget({
                          kind: "model",
                          id: model.id,
                          name: model.name,
                        })
                      }
                      onMouseLeave={() => setHoveredTarget({ kind: "none" })}
                      onMouseMove={handleNavLampMove}
                      type="button"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="inline-flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="size-2 shrink-0 rounded-full"
                            style={{
                              backgroundColor: active
                                ? modelAccent
                                : "hsl(var(--town-border-hover))",
                              boxShadow: active
                                ? `0 0 7px ${modelAccent}`
                                : undefined,
                            }}
                          />
                          <span className="truncate text-[13px] font-semibold text-foreground">
                            {model.name}
                          </span>
                        </span>
                        <span
                          className={cn(
                            "shrink-0 text-xs font-semibold tabular-nums",
                            model.loading
                              ? "text-sun-700"
                              : active
                                ? "text-foreground"
                                : "text-muted-foreground",
                          )}
                        >
                          {model.loading
                            ? t(m.modelLoading)
                            : active && model.decodeTokS !== null
                              ? formatTokS(model.decodeTokS)
                              : t(m.modelWarm)}
                        </span>
                      </div>

                      <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] tabular-nums text-muted-foreground">
                        <span className="truncate">
                          {[model.quant, model.device]
                            .filter(Boolean)
                            .join(" · ") || model.state}
                        </span>
                        <span className="shrink-0">
                          {model.memoryGb > 0
                            ? formatGb(model.memoryGb)
                            : "\u2014"}
                        </span>
                      </div>

                      <div className="mt-2.5 flex items-center gap-1">
                        {Array.from(
                          { length: Math.min(12, model.maxSlots) },
                          (_, sIdx) => {
                            const on = sIdx < model.activeSlots;
                            return (
                              <span
                                className="h-1.5 flex-1 rounded-full transition-colors duration-200"
                                key={sIdx}
                                style={{
                                  backgroundColor: on
                                    ? modelAccent
                                    : "hsl(var(--town-muted))",
                                }}
                              />
                            );
                          },
                        )}
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-xl border border-dashed border-border bg-card/75 px-3.5 py-4 text-left">
                  <p className="text-xs font-medium text-foreground">
                    {t(m.noLoadedModelsTitle)}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                    {t(m.noLoadedModelsHint)}
                  </p>
                  <Link
                    className="mt-2.5 inline-flex items-center gap-1 text-xs font-medium text-app-link underline-offset-2 hover:underline"
                    to={modelsHref}
                  >
                    <span>{t(m.openModels)}</span>
                    <Icon icon={ArrowRight01Icon} size={12} />
                  </Link>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
