import type {
  DerivedLiveSlot,
  DerivedMemorySegment,
  DerivedModelNode,
  DerivedPiClientNode,
  DerivedProvenanceItem,
  DerivedTelemetryMetrics,
  MemorySegmentCategory,
  SystemTelemetryComponent,
  SystemTelemetryFigure,
  SystemTelemetryPoolKind,
  SystemTelemetrySegment,
  SystemTelemetrySlotPhase,
  SystemTelemetrySnapshot,
  SystemTelemetryView,
  SystemTelemetryWhatIf,
  TelemetryAccentKey,
  TelemetryBasis,
  TelemetryHistoryPoint,
  WhatIfForecast,
  WhatIfInput,
  WhatIfKvQuant,
  WhatIfVerdict,
} from "./telemetry-types";

/** Maximum rolling 1 Hz samples retained for the oscilloscope and sparkline. */
export const TELEMETRY_HISTORY_CAPACITY = 60;

const BYTES_PER_GIB = 1024 ** 3;
const BYTES_PER_GB = 1_000_000_000;

const CLIENT_ACCENTS: readonly TelemetryAccentKey[] = [
  "rain",
  "lichen",
  "bluebell",
  "lavender",
];

const DEFAULT_KV_DTYPE_FACTORS: Record<WhatIfKvQuant, number> = {
  FP16: 1,
  Q8_0: 0.55,
  Q4_0: 0.32,
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function figureValue(
  figure: SystemTelemetryFigure | null | undefined,
): number | null {
  if (!figure || figure.basis === "none") return null;
  return isFiniteNumber(figure.value) ? figure.value : null;
}

export function figureBasis(
  figure: SystemTelemetryFigure | null | undefined,
): TelemetryBasis {
  if (!figure) return "none";
  if (figure.basis === "none" || !isFiniteNumber(figure.value)) return "none";
  return figure.basis;
}

export function bytesToGb(bytes: number): number {
  return bytes / BYTES_PER_GIB;
}

export function formatGb(gb: number): string {
  if (gb >= 100) return `${gb.toFixed(0)} GB`;
  return `${gb.toFixed(1)} GB`;
}

export function formatMs(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "\u2014";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function formatTokS(tokS: number | null): string {
  if (tokS === null || !Number.isFinite(tokS)) return "\u2014";
  return `${tokS.toFixed(1)} tok/s`;
}

function classifySegmentCategory(
  segment: SystemTelemetrySegment,
): MemorySegmentCategory {
  const kind = segment.kind.toLowerCase();
  if (kind.includes("kv")) return "kv_cache";
  if (kind.includes("compute") || kind.includes("scratch")) {
    return "compute_buf";
  }
  if (
    kind.includes("external") ||
    kind.includes("foreign") ||
    kind.includes("other_app") ||
    kind === "other"
  ) {
    return "external_apps";
  }
  if (kind.includes("free") || kind.includes("headroom")) return "free";
  if (
    kind.includes("reserve") ||
    kind.includes("system") ||
    kind.includes("overhead")
  ) {
    return "reserve";
  }
  return "weights";
}

function detectPoolKind(
  snapshot: SystemTelemetrySnapshot,
): SystemTelemetryPoolKind {
  if (snapshot.what_if?.pool_kind) {
    return snapshot.what_if.pool_kind;
  }
  const gpu = snapshot.gpus?.[0];
  const ram = snapshot.ram;
  const hostSystem = snapshot.host?.system?.toLowerCase() ?? "";
  const gpuName = gpu?.name?.toLowerCase() ?? "";
  if (hostSystem.includes("darwin") || hostSystem.includes("macos")) {
    return "unified";
  }
  if (gpuName.includes("apple") && gpuName.includes("gpu")) {
    return "unified";
  }
  if (
    gpu &&
    ram &&
    ram.total_bytes > 0 &&
    gpu.total_bytes >= ram.total_bytes * 0.65 &&
    !gpuName.includes("nvidia") &&
    !gpuName.includes("rtx") &&
    !gpuName.includes("geforce")
  ) {
    return "unified";
  }
  return "discrete";
}

function inferSlotPhase(
  slot: NonNullable<SystemTelemetryComponent["live_slots"]>[number],
): SystemTelemetrySlotPhase {
  if (slot.phase) return slot.phase;
  if (!slot.busy) return "idle";
  const decoded = slot.decoded ?? slot.n_decoded ?? 0;
  if (decoded > 0) return "decoding";
  return "prefill";
}

function computeAggregateRates(snapshot: SystemTelemetrySnapshot): {
  decodeTokS: number | null;
  prefillTokS: number | null;
} {
  const components = snapshot.components ?? [];
  let decodeSum = 0;
  let hasDecode = false;
  let prefillSum = 0;
  let hasPrefill = false;

  for (const component of components) {
    const decode =
      figureValue(component.perf?.decode_tok_s) ??
      (isFiniteNumber(component.perf?.counters?.predicted_tokens_seconds)
        ? component.perf.counters.predicted_tokens_seconds
        : null);
    if (decode !== null) {
      decodeSum += decode;
      hasDecode = true;
    }

    const prefill =
      figureValue(component.perf?.prefill_tok_s) ??
      (isFiniteNumber(component.perf?.counters?.prompt_tokens_seconds)
        ? component.perf.counters.prompt_tokens_seconds
        : null);
    if (prefill !== null) {
      prefillSum += prefill;
      hasPrefill = true;
    }
  }

  // Fallback to streaming waterfall rows when component counters have no active rate.
  if (!hasDecode && snapshot.waterfall && snapshot.waterfall.length > 0) {
    let waterfallDecode = 0;
    let found = false;
    for (const entry of snapshot.waterfall) {
      if (entry.status === "streaming" && isFiniteNumber(entry.decode_tok_s)) {
        waterfallDecode += entry.decode_tok_s;
        found = true;
      }
    }
    if (found) {
      decodeSum = waterfallDecode;
      hasDecode = true;
    }
  }

  return {
    decodeTokS: hasDecode ? decodeSum : null,
    prefillTokS: hasPrefill ? prefillSum : null,
  };
}

/**
 * Appends a live snapshot observation to the bounded 60-tick history ring
 * buffer. Duplicate revisions are ignored so rerenders never skew the timeline.
 */
export function appendHistoryPoint(
  history: readonly TelemetryHistoryPoint[],
  view: SystemTelemetryView,
  capacity = TELEMETRY_HISTORY_CAPACITY,
): TelemetryHistoryPoint[] {
  const previous = history.at(-1);
  if (previous && previous.revision === view.revision) {
    return [...history];
  }

  const snapshot = view.snapshot;
  const { decodeTokS, prefillTokS } = computeAggregateRates(snapshot);
  const effectiveBw = figureValue(snapshot.effective_decode_bw_gb_s);
  const ceilingBw =
    figureValue(snapshot.memory_bw_ceiling_gb_s) ??
    snapshot.gpus?.[0]?.bandwidth_gb_s ??
    snapshot.what_if?.memory_bw_ceiling_gb_s ??
    null;
  const memCtrlPct = snapshot.gpu_load?.[0]?.mem_ctrl_util_pct ?? null;
  const memBwGbS =
    effectiveBw ??
    (memCtrlPct !== null && ceilingBw !== null
      ? (memCtrlPct / 100) * ceilingBw
      : 0);
  const ttftMs =
    figureValue(snapshot.p50_ttft_ms) ??
    figureValue(snapshot.gateway?.p50_ttft_ms) ??
    0;

  const parsedObservedAt = Date.parse(view.observed_at);
  const point: TelemetryHistoryPoint = {
    revision: view.revision,
    observedAtMs: Number.isFinite(parsedObservedAt)
      ? parsedObservedAt
      : Date.now(),
    decodeTokS: decodeTokS ?? 0,
    prefillTokS: prefillTokS ?? 0,
    ttftMs,
    memBwGbS,
    effectiveDecodeBwGbS: effectiveBw ?? 0,
  };

  const next = [...history, point];
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

/**
 * Projects a raw localmodels.stack-view/v1.1 snapshot into display-ready
 * metrics without inventing values for unavailable sensors.
 */
export function deriveSnapshotMetrics(
  snapshot: SystemTelemetrySnapshot,
): DerivedTelemetryMetrics {
  const poolKind = detectPoolKind(snapshot);
  const primaryGpu = snapshot.gpus?.[0];
  const primaryGpuLoad =
    snapshot.gpu_load?.find((load) => load.index === primaryGpu?.index) ??
    snapshot.gpu_load?.[0];
  const ram = snapshot.ram;

  const totalBytes =
    primaryGpu?.total_bytes ??
    primaryGpuLoad?.vram_total_bytes ??
    ram?.total_bytes ??
    null;
  const usedBytes =
    primaryGpu?.used_bytes ??
    primaryGpuLoad?.vram_used_bytes ??
    (ram ? Math.max(0, ram.total_bytes - ram.available_bytes) : null);

  const poolTotalGb =
    totalBytes !== null && totalBytes > 0 ? bytesToGb(totalBytes) : null;
  const poolUsedGb = usedBytes !== null ? bytesToGb(usedBytes) : null;
  const poolFreeGb =
    poolTotalGb !== null && poolUsedGb !== null
      ? Math.max(0, poolTotalGb - poolUsedGb)
      : null;
  const poolPct =
    poolTotalGb !== null && poolTotalGb > 0 && poolUsedGb !== null
      ? Math.min(100, Math.max(0, Math.round((poolUsedGb / poolTotalGb) * 100)))
      : null;

  const hostRamTotalGb =
    ram && ram.total_bytes > 0 ? bytesToGb(ram.total_bytes) : null;
  const hostRamUsedGb =
    ram && ram.total_bytes > 0
      ? bytesToGb(Math.max(0, ram.total_bytes - ram.available_bytes))
      : null;

  const rawSegments = primaryGpu?.segments ?? ram?.segments ?? [];
  const derivedSegments: DerivedMemorySegment[] = [];
  for (let index = 0; index < rawSegments.length; index += 1) {
    const segment = rawSegments[index]!;
    if (segment.bytes <= 0) continue;
    derivedSegments.push({
      id: `${segment.kind}-${index}`,
      category: classifySegmentCategory(segment),
      label: segment.label || segment.kind,
      bytes: segment.bytes,
      gb: bytesToGb(segment.bytes),
      basis: segment.basis,
    });
  }

  // Ensure a free headroom segment exists when pool total exceeds summed segments.
  if (
    poolTotalGb !== null &&
    poolFreeGb !== null &&
    poolFreeGb > 0.05 &&
    !derivedSegments.some((segment) => segment.category === "free")
  ) {
    derivedSegments.push({
      id: "free-headroom",
      category: "free",
      label: "Free",
      bytes: Math.round(poolFreeGb * BYTES_PER_GIB),
      gb: poolFreeGb,
      basis: "live",
    });
  }

  const externalHolders = primaryGpu?.holders ?? [];
  const externalBytesGb = derivedSegments
    .filter((segment) => segment.category === "external_apps")
    .reduce((sum, segment) => sum + segment.gb, 0);

  const { decodeTokS, prefillTokS } = computeAggregateRates(snapshot);
  const effectiveDecodeBwGbS = figureValue(snapshot.effective_decode_bw_gb_s);
  const effectiveDecodeBwBasis = figureBasis(snapshot.effective_decode_bw_gb_s);
  const bwCeilingGbS =
    figureValue(snapshot.memory_bw_ceiling_gb_s) ??
    primaryGpu?.bandwidth_gb_s ??
    snapshot.what_if?.memory_bw_ceiling_gb_s ??
    null;

  const memCtrlUtilPct = isFiniteNumber(primaryGpuLoad?.mem_ctrl_util_pct)
    ? Math.round(primaryGpuLoad.mem_ctrl_util_pct)
    : null;
  const bwCeilingPct =
    effectiveDecodeBwGbS !== null && bwCeilingGbS !== null && bwCeilingGbS > 0
      ? Math.min(100, Math.round((effectiveDecodeBwGbS / bwCeilingGbS) * 100))
      : memCtrlUtilPct;

  const activeWeightGb =
    isFiniteNumber(snapshot.what_if?.active_weight_bytes) &&
    snapshot.what_if.active_weight_bytes > 0
      ? snapshot.what_if.active_weight_bytes / BYTES_PER_GB
      : null;

  const gpuLoadBasis: TelemetryBasis = primaryGpuLoad?.basis ?? "none";
  const gpuUtilPct =
    gpuLoadBasis !== "none" && isFiniteNumber(primaryGpuLoad?.util_pct)
      ? Math.round(primaryGpuLoad.util_pct)
      : null;
  const tempC =
    gpuLoadBasis !== "none" && isFiniteNumber(primaryGpuLoad?.temp_c)
      ? Math.round(primaryGpuLoad.temp_c)
      : null;
  const powerW =
    gpuLoadBasis !== "none" && isFiniteNumber(primaryGpuLoad?.power_w)
      ? Math.round(primaryGpuLoad.power_w)
      : null;
  const powerLimitW = isFiniteNumber(primaryGpuLoad?.power_limit_w)
    ? Math.round(primaryGpuLoad.power_limit_w)
    : null;

  const cpuOverall = figureValue(snapshot.sensors?.cpu.overall_pct);
  const cpuBasis = figureBasis(snapshot.sensors?.cpu.overall_pct);
  const cpuCores = (snapshot.sensors?.cpu.per_core ?? []).map((entry) => ({
    core: entry.core,
    pct: Math.min(100, Math.max(0, Math.round(entry.util_pct))),
  }));
  const logicalCores = snapshot.sensors?.cpu.logical_cores ?? null;

  const diskReadMbS = figureValue(snapshot.sensors?.disk.read_mb_s);
  const diskReadBasis = figureBasis(snapshot.sensors?.disk.read_mb_s);

  const components = snapshot.components ?? [];
  const models: DerivedModelNode[] = components.map((component) => {
    const liveSlots = component.live_slots ?? [];
    const activeSlotCount =
      liveSlots.length > 0
        ? liveSlots.filter((slot) => slot.busy).length
        : Math.round(component.perf?.counters?.processing ?? 0);
    const maxSlots = Math.max(
      1,
      component.slots ?? (liveSlots.length > 0 ? liveSlots.length : 1),
    );
    const memoryBytes =
      (component.vram_bytes ?? 0) + (component.ram_bytes ?? 0);
    const state = component.state ?? "loaded";
    const normalizedState = state.toLowerCase();
    return {
      id: component.model || component.id,
      componentId: component.id,
      name: component.title || component.model || component.id,
      quant: component.quant ?? "",
      device: component.device ?? "",
      state,
      memoryGb: bytesToGb(memoryBytes),
      maxSlots,
      activeSlots: Math.min(maxSlots, activeSlotCount),
      decodeTokS: figureValue(component.perf?.decode_tok_s),
      loading:
        normalizedState === "loading" ||
        normalizedState === "starting" ||
        normalizedState.includes("loading"),
    };
  });

  const slots: DerivedLiveSlot[] = [];
  for (const component of components) {
    const modelName = component.title || component.model || component.id;
    for (const slot of component.live_slots ?? []) {
      const nCtx = Math.max(1, slot.n_ctx ?? component.window ?? 4096);
      const cachedTokens = slot.cached ?? slot.cached_prefix_tokens ?? 0;
      const promptTotal =
        slot.prompt_done ?? slot.prompt_tokens ?? slot.n_prompt ?? 0;
      const prefillTokens = Math.max(0, promptTotal - cachedTokens);
      const decodeTokens = slot.decoded ?? slot.n_decoded ?? 0;
      slots.push({
        key: `${component.id}-${slot.id}`,
        slotIndex: slot.id,
        modelName,
        active: slot.busy,
        phase: inferSlotPhase(slot),
        nCtx,
        cachedTokens,
        prefillTokens,
        decodeTokens,
        tokS: isFiniteNumber(slot.tok_s) ? slot.tok_s : null,
        ttftMs: isFiniteNumber(slot.ttft_ms) ? slot.ttft_ms : null,
      });
    }
  }

  const clientLanes =
    snapshot.gateway?.client_lanes ?? snapshot.client_lanes ?? {};
  const waterfall = snapshot.waterfall ?? [];

  const clientMap = new Map<
    string,
    { id: string; name: string; targetModelId: string }
  >();
  for (const client of snapshot.clients ?? []) {
    clientMap.set(client.id, {
      id: client.id,
      name: client.name || client.id,
      targetModelId: client.model || models[0]?.id || "",
    });
  }
  const waterfallByClient = new Map<string, typeof waterfall>();
  for (const entry of waterfall) {
    const existing = waterfallByClient.get(entry.client_id);
    if (existing) existing.push(entry);
    else waterfallByClient.set(entry.client_id, [entry]);
  }
  for (const laneClientId of Object.keys(clientLanes)) {
    if (!clientMap.has(laneClientId)) {
      const recentEntry = waterfallByClient.get(laneClientId)?.[0];
      clientMap.set(laneClientId, {
        id: laneClientId,
        name: laneClientId,
        targetModelId: recentEntry?.model_id ?? models[0]?.id ?? "",
      });
    }
  }
  for (const entry of waterfall) {
    if (!clientMap.has(entry.client_id)) {
      clientMap.set(entry.client_id, {
        id: entry.client_id,
        name: entry.client_id,
        targetModelId: entry.model_id || models[0]?.id || "",
      });
    }
  }

  const clients: DerivedPiClientNode[] = [...clientMap.values()].map(
    (entry, index) => {
      const matchingWaterfall = waterfall.filter(
        (item) => item.client_id === entry.id || item.client_id === entry.name,
      );
      const streamingCount = matchingWaterfall.filter(
        (item) => item.status === "streaming",
      ).length;
      const laneCount = clientLanes[entry.id] ?? clientLanes[entry.name] ?? 0;
      const activeStreams = Math.max(laneCount, streamingCount);
      const rateSamples = matchingWaterfall
        .map((item) => item.decode_tok_s)
        .filter((rate): rate is number => isFiniteNumber(rate) && rate > 0);
      const recentTokS =
        rateSamples.length > 0
          ? rateSamples.reduce((sum, rate) => sum + rate, 0) /
            rateSamples.length
          : null;
      return {
        id: entry.id,
        name: entry.name,
        targetModelId: entry.targetModelId,
        accent: CLIENT_ACCENTS[index % CLIENT_ACCENTS.length]!,
        activeStreams,
        recentRequests: matchingWaterfall.length,
        recentTokS,
      };
    },
  );

  const totalModelSlots = models.reduce(
    (sum, model) => sum + model.maxSlots,
    0,
  );
  const activeModelSlots = models.reduce(
    (sum, model) => sum + model.activeSlots,
    0,
  );
  const inFlight =
    snapshot.in_flight ?? snapshot.gateway?.in_flight ?? activeModelSlots;
  const maxSlots = Math.max(totalModelSlots, inFlight, 1);

  const deferredFromSnapshot = figureValue(snapshot.requests_deferred);
  const deferredFromComponents = components.reduce<number | null>(
    (sum, component) => {
      const value = component.perf?.counters?.requests_deferred;
      if (!isFiniteNumber(value)) return sum;
      return (sum ?? 0) + value;
    },
    null,
  );
  const deferredCount = deferredFromSnapshot ?? deferredFromComponents;

  const p50TtftMs =
    figureValue(snapshot.p50_ttft_ms) ??
    figureValue(snapshot.gateway?.p50_ttft_ms);
  const prefixHitPct = figureValue(snapshot.prefix_hit_pct);
  const kvRatio =
    figureValue(snapshot.kv_cache_usage_ratio) ??
    components.reduce<number | null>((maxRatio, component) => {
      const ratio = component.perf?.counters?.kv_cache_usage_ratio;
      if (!isFiniteNumber(ratio)) return maxRatio;
      return maxRatio === null ? ratio : Math.max(maxRatio, ratio);
    }, null);
  const kvCacheUsagePct =
    kvRatio !== null ? Math.min(100, Math.round(kvRatio * 100)) : null;

  const pressureLevel =
    snapshot.sensors?.memory_pressure.level ??
    (poolPct !== null && poolPct >= 92
      ? "critical"
      : poolPct !== null && poolPct >= 82
        ? "elevated"
        : "nominal");
  const watchdogStatus = snapshot.sensors?.watchdog.status ?? "unknown";
  const bottleneck =
    snapshot.bottleneck ?? (inFlight === 0 ? "idle" : "balanced");

  const provenance: DerivedProvenanceItem[] = [
    {
      id: "memory_pool",
      basis: primaryGpu ? "live" : ram ? "live" : "none",
      detail: primaryGpu?.name,
    },
    {
      id: "decode_bw",
      basis: effectiveDecodeBwBasis,
      detail: snapshot.effective_decode_bw_gb_s?.note,
    },
    {
      id: "gpu_compute",
      basis: gpuUtilPct !== null ? gpuLoadBasis : "none",
      detail: primaryGpuLoad?.source,
    },
    {
      id: "thermals_power",
      basis: tempC !== null || powerW !== null ? gpuLoadBasis : "none",
      detail: primaryGpuLoad?.source,
    },
    {
      id: "gateway_slots",
      basis:
        snapshot.p50_ttft_ms?.basis ??
        snapshot.gateway?.p50_ttft_ms?.basis ??
        (slots.length > 0 ? "live" : "none"),
      detail: snapshot.gateway?.addr,
    },
    {
      id: "cpu_disk",
      basis: cpuBasis !== "none" ? cpuBasis : diskReadBasis,
      detail: snapshot.sensors?.collector,
    },
    {
      id: "what_if",
      basis: snapshot.what_if ? "estimate" : "none",
    },
  ];

  return {
    poolKind,
    gpuLabel: primaryGpu?.name ?? snapshot.host?.tier ?? "",
    poolTotalGb,
    poolUsedGb,
    poolFreeGb,
    poolPct,
    hostRamTotalGb,
    hostRamUsedGb,
    segments: derivedSegments,
    externalHolders,
    externalBytesGb,
    decodeTokS,
    prefillTokS,
    effectiveDecodeBwGbS,
    effectiveDecodeBwBasis,
    bwCeilingGbS,
    bwCeilingPct,
    activeWeightGb,
    gpuUtilPct,
    gpuUtilBasis: gpuUtilPct !== null ? gpuLoadBasis : "none",
    memCtrlUtilPct,
    tempC,
    tempBasis: tempC !== null ? gpuLoadBasis : "none",
    powerW,
    powerLimitW,
    powerBasis: powerW !== null ? gpuLoadBasis : "none",
    cpuLoadPct: cpuOverall !== null ? Math.round(cpuOverall) : null,
    cpuBasis,
    cpuCores,
    logicalCores,
    diskReadMbS: diskReadMbS !== null ? Math.round(diskReadMbS) : null,
    diskReadBasis,
    inFlight,
    maxSlots,
    deferredCount: deferredCount !== null ? Math.round(deferredCount) : null,
    p50TtftMs,
    prefixHitPct: prefixHitPct !== null ? Math.round(prefixHitPct) : null,
    kvCacheUsagePct,
    pressureLevel,
    watchdogStatus,
    bottleneck,
    gatewayAddr: snapshot.gateway?.addr ?? null,
    clients,
    models,
    slots,
    waterfall,
    collectorSummary: snapshot.sensors?.collector ?? null,
    hostSystem: snapshot.host?.system ?? null,
    provenance,
  };
}

/**
 * Computes a local What-If memory & roofline decode forecast strictly from the
 * snapshot's authoritative `what_if` coefficients with zero network round trips.
 */
export function computeWhatIfForecast(
  whatIf: SystemTelemetryWhatIf,
  input: WhatIfInput,
): WhatIfForecast {
  const poolKind: SystemTelemetryPoolKind = whatIf.pool_kind ?? "discrete";
  const dtypeFactor =
    whatIf.kv_dtype_factors?.[input.kvQuant] ??
    DEFAULT_KV_DTYPE_FACTORS[input.kvQuant];

  const totalTokens = Math.max(1, input.concurrency) * input.contextTokens;
  const kvBytes = totalTokens * whatIf.kv_bytes_per_token * dtypeFactor;
  const computeBytes = input.contextTokens * whatIf.compute_bytes_per_token;

  const weightsBytes = whatIf.weights_bytes ?? 0;
  const fixedNonWeightBytes = Math.max(0, whatIf.fixed_bytes - weightsBytes);
  const totalRequiredBytes =
    weightsBytes + fixedNonWeightBytes + kvBytes + computeBytes;
  const poolBudgetBytes = Math.max(1, whatIf.fixed_bytes + whatIf.room_bytes);

  const weightsGb = bytesToGb(weightsBytes);
  const kvCacheGb = bytesToGb(kvBytes);
  const computeGb = bytesToGb(computeBytes);
  const fixedGb = bytesToGb(fixedNonWeightBytes);
  const totalRequiredGb = bytesToGb(totalRequiredBytes);
  const poolBudgetGb = bytesToGb(poolBudgetBytes);
  const freeDeltaGb = poolBudgetGb - totalRequiredGb;

  const offloadToRamGb = freeDeltaGb < 0 ? Math.abs(freeDeltaGb) : 0;
  const hostRamAvailableGb = isFiniteNumber(whatIf.host_ram_available_bytes)
    ? bytesToGb(whatIf.host_ram_available_bytes)
    : 0;

  let verdict: WhatIfVerdict = "fits_gpu";
  if (offloadToRamGb > 0) {
    const canOffload =
      poolKind === "discrete" &&
      hostRamAvailableGb >= offloadToRamGb &&
      offloadToRamGb <= poolBudgetGb * 0.5;
    verdict = canOffload ? "hybrid_offload" : "oom_risk";
  }

  const ceilingBw = whatIf.memory_bw_ceiling_gb_s ?? null;
  const activeWeightBytes = whatIf.active_weight_bytes ?? weightsBytes;
  let predictedDecodeTokS: number | null = null;
  let predictedBwPct: number | null = null;
  let predictedTtftMs: number | null = null;

  if (ceilingBw !== null && ceilingBw > 0 && activeWeightBytes > 0) {
    const activeWeightGb = activeWeightBytes / BYTES_PER_GB;
    const pcieBw = whatIf.pcie_bandwidth_gb_s ?? 16;
    const effectiveBw =
      offloadToRamGb > 0 && totalRequiredGb > 0
        ? ceilingBw * Math.max(0.25, 1 - offloadToRamGb / totalRequiredGb) +
          pcieBw * (offloadToRamGb / totalRequiredGb)
        : ceilingBw * 0.78;
    const batchEfficiency = 1 / (1 + 0.08 * Math.max(0, input.concurrency - 1));
    predictedDecodeTokS = Math.max(
      0.5,
      (effectiveBw / Math.max(0.5, activeWeightGb)) * batchEfficiency,
    );
    const neededBw = predictedDecodeTokS * activeWeightGb;
    predictedBwPct = Math.min(100, Math.round((neededBw / ceilingBw) * 100));
    predictedTtftMs = Math.round(
      90 +
        (input.contextTokens / 1024) * 3.2 +
        Math.max(0, input.concurrency - 1) * 18 +
        offloadToRamGb * 45,
    );
  }

  return {
    weightsGb,
    kvCacheGb,
    computeGb,
    fixedGb,
    totalRequiredGb,
    poolBudgetGb,
    freeDeltaGb,
    offloadToRamGb,
    predictedDecodeTokS,
    predictedBwPct,
    predictedTtftMs,
    verdict,
    poolKind,
  };
}
