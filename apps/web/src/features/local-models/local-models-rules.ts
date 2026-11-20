import { formatBytes } from "@/lib/format-bytes";

import {
  architectureCopy,
  capabilityCopy,
  memoryPressureCopy,
} from "./local-models-copy";
import type {
  LocalModel,
  LocalModelPool,
  LocalModelsView,
  LocalModelView,
} from "./local-models-queries";

/**
 * Presentation rules of the Local models page. The Computer decides fit,
 * availability, placement, the recommendation and every memory figure; these
 * rules only order, label and add up what it reported.
 */

/**
 * Every status a model has on one Computer, in list order. The first five
 * are on the Computer (or downloading to it); the last two are not.
 */
export const modelStatuses = [
  "loaded",
  "loading",
  "failed",
  "idle",
  "downloading",
  "available",
  "unavailable",
] as const;

export type ModelStatus = (typeof modelStatuses)[number];

export interface ModelEntry extends LocalModelView {
  status: ModelStatus;
}

export function modelStatus(model: LocalModel): ModelStatus {
  if (model.state !== "absent") return model.state;
  return model.availability.downloadable ? "available" : "unavailable";
}

/**
 * Whether a failed model is a download that stopped rather than a load that
 * failed. The library reports a failed model without a record only for a
 * download job that ended and kept its partial, and gives it one of these
 * download codes; such a model resumes with download and is discarded with
 * cancel, while load and remove are refused. Decided by the structured code,
 * never by the error detail.
 */
export function downloadStopped(model: LocalModel): boolean {
  return (
    model.state === "failed" &&
    (model.error?.code === "DOWNLOAD_FAILED" ||
      model.error?.code === "NETWORK_UNAVAILABLE")
  );
}

/**
 * Whether the Computer currently holds a model record (loaded, loading, idle,
 * or a failed load, excluding absent rows and stopped partial downloads).
 */
export function isModelOnComputer(
  model: LocalModel,
  status: ModelStatus,
): boolean {
  return (
    status !== "available" &&
    status !== "unavailable" &&
    !downloadStopped(model)
  );
}

const fitOrder: Record<LocalModel["fit"], number> = {
  gpu: 0,
  none: 2,
  system: 1,
  unified: 0,
};

/** The library as one list: by status, then the recommended model, then by fit. */
export function modelEntries(view: LocalModelsView): ModelEntry[] {
  return view.models
    .map((item) => ({ ...item, status: modelStatus(item.model) }))
    .sort(
      (a, b) =>
        modelStatuses.indexOf(a.status) - modelStatuses.indexOf(b.status) ||
        Number(b.model.recommended) - Number(a.model.recommended) ||
        fitOrder[a.model.fit] - fitOrder[b.model.fit],
    );
}

/** The pool a model lives in; none when it fits nowhere or the pool is unreported. */
export function poolOf(view: LocalModelsView, poolId: string | undefined) {
  return poolId === undefined
    ? undefined
    : view.pools.find((pool) => pool.id === poolId);
}

function gpuName(view: LocalModelsView, pool: LocalModelPool) {
  return view.computer.host?.gpus.find((gpu) => gpu.index === pool.gpu_index)
    ?.name;
}

/** A pool's full name: "GPU 0 · RTX 4090", "System memory", "Unified memory". */
export function poolLabel(view: LocalModelsView, pool: LocalModelPool) {
  if (pool.kind === "system") return "System memory";
  if (pool.kind === "unified") return "Unified memory";
  const name = gpuName(view, pool);
  return name ? `GPU ${pool.gpu_index} · ${name}` : `GPU ${pool.gpu_index}`;
}

/**
 * A pool's short name for status lines: "GPU 0", "system memory", "memory".
 * Undefined without a pool, so no placement is shown.
 */
export function placeName(view: LocalModelsView, poolId: string | undefined) {
  const pool = poolOf(view, poolId);
  if (!pool) return undefined;
  if (pool.kind === "gpu") return `GPU ${pool.gpu_index}`;
  return pool.kind === "system" ? "system memory" : "memory";
}

/**
 * Model and memory sizes always read in GB with at most one decimal, so a
 * small model and an empty pool compare at a glance with the rest: 0.6 GB and
 * 0 GB, not 614.4 MB and 0 B.
 */
export function formatGigabytes(bytes: number) {
  return `${Math.round((bytes / 1024 ** 3) * 10) / 10} GB`;
}

export function poolFreeBytes(pool: LocalModelPool) {
  return Math.max(0, pool.total_bytes - pool.used_bytes);
}

/** Memory held by known models and foundation components in one pool. */
export function poolHolderBytes(pool: LocalModelPool) {
  return pool.holders.reduce((sum, holder) => sum + holder.bytes, 0);
}

/** Memory in the pool used by other apps (games, browsers, video players). */
export function poolOtherBytes(pool: LocalModelPool) {
  return Math.max(0, pool.used_bytes - poolHolderBytes(pool));
}

/** Free memory plus memory currently held by external apps in one pool. */
export function poolReclaimableBytes(pool: LocalModelPool) {
  return poolFreeBytes(pool) + poolOtherBytes(pool);
}

function summarizePools(pools: readonly LocalModelPool[], gpu: boolean) {
  const totalBytes = pools.reduce((sum, pool) => sum + pool.total_bytes, 0);
  const usedBytes = pools.reduce((sum, pool) => sum + pool.used_bytes, 0);
  const otherBytes = pools.reduce((sum, pool) => sum + poolOtherBytes(pool), 0);
  return {
    freeBytes: Math.max(0, totalBytes - usedBytes),
    gpu,
    otherBytes,
    totalBytes,
    usedBytes,
  };
}

/** What the header adds up: GPU memory when the Computer has GPUs, else its memory. */
export function memorySummary(view: LocalModelsView) {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const { freeBytes, gpu, totalBytes, usedBytes } = summarizePools(
    gpus.length ? gpus : view.pools,
    gpus.length > 0,
  );
  return { freeBytes, gpu, totalBytes, usedBytes };
}

export interface MemoryGuidance {
  kind: "blocked_download" | "blocked_load" | "constrained_pool";
  gpu: boolean;
  otherBytes: number;
  freeBytes: number;
  totalBytes: number;
}

function maxHardwareCapacity(view: LocalModelsView) {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  if (gpus.length) {
    return Math.max(
      ...gpus.map((pool) => pool.total_bytes),
      ...(view.computer.host?.gpus.map((gpu) => gpu.total_bytes) ?? [0]),
    );
  }
  const unifiedOrSystem = view.pools.map((pool) => pool.total_bytes);
  return Math.max(
    view.computer.host?.ram_total_bytes ?? 0,
    ...unifiedOrSystem,
    0,
  );
}

/**
 * Whether an unavailable model failed only because external apps currently
 * hold memory on hardware that could otherwise fit it.
 */
export function memoryReclaimable(
  view: LocalModelsView,
  model: LocalModel,
): boolean {
  const reason = model.availability.reason;
  if (
    reason?.code !== "MEMORY_INSUFFICIENT" ||
    reason.need_bytes === undefined
  ) {
    return false;
  }
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const pools = gpus.length ? gpus : view.pools;
  return (
    pools.some((pool) => poolOtherBytes(pool) > 0) &&
    reason.need_bytes <= maxHardwareCapacity(view)
  );
}

/**
 * Whether external apps hold enough GPU or system memory that closing them
 * and rechecking could let a larger model download or load. Pool metrics are
 * scoped per physical memory space so system RAM is never added into GPU VRAM.
 */
export function memoryGuidance(view: LocalModelsView): MemoryGuidance | null {
  if (!view.available || !view.pools.length) return null;
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const nonGpus = view.pools.filter((pool) => pool.kind !== "gpu");
  const groups = [
    ...(gpus.length ? [{ gpu: true, pools: gpus }] : []),
    ...(nonGpus.length ? [{ gpu: false, pools: nonGpus }] : []),
  ];
  if (!groups.length) return null;

  const entries = modelEntries(view);

  for (const group of groups) {
    const stats = summarizePools(group.pools, group.gpu);
    if (stats.otherBytes <= 0) continue;
    const poolIds = new Set(group.pools.map((pool) => pool.id));
    const blockedLoad = entries.some(({ model, status }) => {
      if (status !== "idle" && (status !== "failed" || downloadStopped(model)))
        return false;
      if (model.pool === undefined || !poolIds.has(model.pool)) return false;
      const pool = poolOf(view, model.pool);
      if (!pool || poolOtherBytes(pool) <= 0) return false;
      return (
        model.note?.code === "NO_ROOM_TO_LOAD" ||
        model.error?.code === "LOAD_NO_ROOM" ||
        model.error?.code === "OUT_OF_MEMORY" ||
        loadCheck(view, model) !== null
      );
    });
    if (blockedLoad) {
      return {
        freeBytes: stats.freeBytes,
        gpu: group.gpu,
        kind: "blocked_load",
        otherBytes: stats.otherBytes,
        totalBytes: stats.totalBytes,
      };
    }
  }

  const primary = groups[0]!;
  const primaryStats = summarizePools(primary.pools, primary.gpu);
  if (
    primaryStats.otherBytes > 0 &&
    entries.some(
      (entry) =>
        entry.status === "unavailable" && memoryReclaimable(view, entry.model),
    )
  ) {
    return {
      freeBytes: primaryStats.freeBytes,
      gpu: primary.gpu,
      kind: "blocked_download",
      otherBytes: primaryStats.otherBytes,
      totalBytes: primaryStats.totalBytes,
    };
  }

  const twoGigabytes = 2 * 1024 ** 3;
  for (const group of groups) {
    const stats = summarizePools(group.pools, group.gpu);
    if (stats.otherBytes < twoGigabytes) continue;
    const poolIds = new Set(group.pools.map((pool) => pool.id));
    const constrainedAvailable = entries.some((entry) => {
      if (entry.status !== "available") return false;
      const modelPool = entry.model.pool;
      if (modelPool === undefined || !poolIds.has(modelPool)) return false;
      const pool = poolOf(view, modelPool);
      return (
        pool !== undefined &&
        poolOtherBytes(pool) > 0 &&
        downloadMemoryCheck(view, entry.model) !== null
      );
    });
    if (constrainedAvailable) {
      return {
        freeBytes: stats.freeBytes,
        gpu: group.gpu,
        kind: "constrained_pool",
        otherBytes: stats.otherBytes,
        totalBytes: stats.totalBytes,
      };
    }
  }
  return null;
}

export interface DownloadMemoryCheck {
  freeBytes: number;
  needBytes: number;
  pool: LocalModelPool;
}

/**
 * Why a downloadable model cannot be auto-loaded immediately after download,
 * or `null` when its pool has live room now (or no pool applies).
 */
export function downloadMemoryCheck(
  view: LocalModelsView,
  model: LocalModel,
): DownloadMemoryCheck | null {
  if (model.state !== "absent" || !model.availability.downloadable) return null;
  const pool = poolOf(view, model.pool);
  if (!pool) return null;
  if (model.fits_now === true) return null;
  if (model.fits_now === undefined && poolFreeBytes(pool) >= model.memory_bytes)
    return null;
  return {
    freeBytes: model.load_free_bytes ?? poolFreeBytes(pool),
    needBytes: model.load_need_bytes ?? model.memory_bytes,
    pool,
  };
}

export interface LoadCheck {
  pool: LocalModelPool;
  needBytes: number;
  freeBytes: number;
  /** Loaded models in the same pool, the ones the user could unload. */
  loaded: ModelEntry[];
  /**
   * What else holds the pool that Make room cannot unload: components and
   * models in another state, by holder.
   */
  kept: LocalModelPool["holders"];
}

/** Why a model cannot load now, or `null` when its pool reports room for it. */
export function loadCheck(
  view: LocalModelsView,
  model: LocalModel,
): LoadCheck | null {
  const pool = poolOf(view, model.pool);
  if (!pool || model.fits_now === true) return null;
  if (model.fits_now === undefined && poolFreeBytes(pool) >= model.memory_bytes)
    return null;
  const loaded = modelEntries(view).filter(
    (entry) =>
      entry.status === "loaded" &&
      entry.model.pool === pool.id &&
      entry.model.id !== model.id,
  );
  return {
    freeBytes: model.load_free_bytes ?? poolFreeBytes(pool),
    kept: pool.holders.filter(
      (holder) => !loaded.some((entry) => entry.model.id === holder.id),
    ),
    loaded,
    needBytes: model.load_need_bytes ?? model.memory_bytes,
    pool,
  };
}

export interface MemoryBreakdownRow {
  label: string;
  tone?: "default" | "warning" | "danger";
  value: string;
}

export interface MemoryBreakdown {
  note?: string;
  rows: MemoryBreakdownRow[];
  title: string;
}

/** Structured breakdown for a single memory pool hover card and Details view. */
export function poolMemoryBreakdown(
  view: LocalModelsView,
  pool: LocalModelPool,
): MemoryBreakdown {
  const host = view.computer.host;
  const holdersBytes = pool.holders.reduce(
    (sum, holder) => sum + holder.bytes,
    0,
  );
  const freeBytes = poolFreeBytes(pool);
  const rows: MemoryBreakdownRow[] = [];

  if (pool.kind === "unified") {
    if (host) {
      rows.push({
        label: "Physical memory",
        value: formatGigabytes(host.ram_total_bytes),
      });
    }
    if (holdersBytes > 0) {
      rows.push({
        label: "Loaded models",
        value: formatGigabytes(holdersBytes),
      });
    }
    const appsBytes =
      host?.ram_available_bytes !== undefined
        ? Math.max(
            0,
            host.ram_total_bytes - host.ram_available_bytes - holdersBytes,
          )
        : Math.max(0, pool.used_bytes - holdersBytes);
    rows.push({
      label: "Used by macOS & apps",
      value: formatGigabytes(appsBytes),
    });
    if (host?.ram_available_bytes !== undefined) {
      rows.push({
        label: "Reclaimable & free",
        value: formatGigabytes(host.ram_available_bytes),
      });
    }
    if (pool.reserve_bytes !== undefined && pool.reserve_bytes > 0) {
      rows.push({
        label: "Reserved for macOS & Linger",
        value: formatGigabytes(pool.reserve_bytes),
      });
    }
    rows.push({
      label: "Available for models",
      value: formatGigabytes(freeBytes),
    });
    if (host?.metal_working_set_bytes !== undefined) {
      rows.push({
        label: "Per-model Metal GPU cap",
        value: formatGigabytes(host.metal_working_set_bytes),
      });
    }
    if (host?.memory_pressure && host.memory_pressure !== "normal") {
      rows.push({
        label: "Memory pressure",
        tone: host.memory_pressure === "critical" ? "danger" : "warning",
        value: memoryPressureCopy(host.memory_pressure),
      });
    }
    const note =
      host?.memory_pressure === "critical"
        ? "Memory pressure is critical. Close apps and click Recheck memory before loading a model."
        : host?.memory_pressure === "warn"
          ? "Memory pressure is elevated. macOS holds back an extra safety buffer so loading models does not freeze apps."
          : "macOS includes purgeable and file-cached memory in reclaimable headroom; model loading also keeps a macOS safety reserve.";
    return { note, rows, title: "Unified memory breakdown" };
  }

  const otherBytes = Math.max(0, pool.used_bytes - holdersBytes);
  if (pool.kind === "system" && host) {
    rows.push({
      label: "Physical memory",
      value: formatGigabytes(host.ram_total_bytes),
    });
  }
  rows.push({
    label: pool.kind === "gpu" ? "Total VRAM" : "Model budget",
    value: formatGigabytes(pool.total_bytes),
  });
  if (holdersBytes > 0) {
    rows.push({
      label: "Loaded models",
      value: formatGigabytes(holdersBytes),
    });
  }
  if (otherBytes > 0) {
    rows.push({
      label: "Other processes",
      value: formatGigabytes(otherBytes),
    });
  }
  if (pool.reserve_bytes !== undefined && pool.reserve_bytes > 0) {
    rows.push({
      label:
        pool.kind === "gpu"
          ? "Driver & safety reserve"
          : "Reserved for OS & apps",
      value: formatGigabytes(pool.reserve_bytes),
    });
  }
  rows.push({
    label: "Free for models",
    value: formatGigabytes(freeBytes),
  });
  return { rows, title: poolLabel(view, pool) };
}

/** Breakdown shown when hovering or clicking the header memory summary. */
export function headerMemoryBreakdown(
  view: LocalModelsView,
): MemoryBreakdown | undefined {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const pools = gpus.length ? gpus : view.pools;
  if (!pools.length) return undefined;
  if (pools.length === 1) return poolMemoryBreakdown(view, pools[0]!);
  return {
    rows: pools.map((pool) => ({
      label: poolLabel(view, pool),
      value: `${formatGigabytes(poolFreeBytes(pool))} free of ${formatGigabytes(pool.total_bytes)}`,
    })),
    title: "GPU memory breakdown",
  };
}

function freedBytes(entries: ModelEntry[]) {
  return entries.reduce((sum, entry) => sum + entry.model.memory_bytes, 0);
}

/**
 * The models Make room preselects: the fewest that free enough memory, and
 * among those the fewest an Agent uses. Empty when unloading all of them is
 * still not enough.
 */
export function makeRoomSelection(check: LoadCheck): string[] {
  const deficit = check.needBytes - check.freeBytes;
  const largestFirst = (a: ModelEntry, b: ModelEntry) =>
    b.model.memory_bytes - a.model.memory_bytes;
  const unused = check.loaded
    .filter((entry) => entry.used_by.length === 0)
    .sort(largestFirst);
  const used = check.loaded
    .filter((entry) => entry.used_by.length > 0)
    .sort(largestFirst);
  // For a count and a number of used models, the largest of each group free
  // the most, so checking those picks is exhaustive.
  for (let count = 1; count <= check.loaded.length; count += 1) {
    for (let usedCount = 0; usedCount <= count; usedCount += 1) {
      const pick = [
        ...unused.slice(0, count - usedCount),
        ...used.slice(0, usedCount),
      ];
      if (pick.length === count && freedBytes(pick) >= deficit)
        return pick.map((entry) => entry.model.id);
    }
  }
  return [];
}

/** Whether unloading the selected models makes room. */
export function makesRoom(check: LoadCheck, selectedIds: ReadonlySet<string>) {
  const freed = freedBytes(
    check.loaded.filter((entry) => selectedIds.has(entry.model.id)),
  );
  return check.freeBytes + freed >= check.needBytes;
}

/** Whole-percent download progress. */
export function downloadPercent(model: LocalModel) {
  const download = model.download;
  if (!download?.total_bytes) return 0;
  return Math.min(
    100,
    Math.floor((download.done_bytes / download.total_bytes) * 100),
  );
}

/** Context length in thousands of tokens, as model cards write it: 128K. */
export function contextLabel(tokens: number) {
  if (tokens < 1024) return `${tokens} tokens`;
  return `${Math.round(tokens / 1024)}K tokens`;
}

/** Agent names joined for a sentence. */
export function agentNames(entry: Pick<LocalModelView, "used_by">) {
  return entry.used_by.map((user) => user.name).join(", ");
}

/** Compact Agent count chip for a model on the Computer, or undefined when unused. */
export function usedByBadge(
  entry: Pick<ModelEntry, "model" | "status" | "used_by">,
  names?: readonly string[],
): string | undefined {
  const count = names ? names.length : entry.used_by.length;
  if (!isModelOnComputer(entry.model, entry.status) || !count) {
    return undefined;
  }
  return count === 1 ? "1 Agent" : `${count} Agents`;
}

export type LocalModelCapability = NonNullable<
  LocalModel["capabilities"]
>[number];

export const capabilityOrder: readonly LocalModelCapability[] = [
  "vision",
  "tool_use",
  "reasoning",
  "coding",
  "multilingual",
];

/** Ordered capabilities of a model, uniting `capabilities` with legacy `vision`. */
export function modelCapabilities(model: LocalModel): LocalModelCapability[] {
  const present = new Set<LocalModelCapability>(model.capabilities ?? []);
  if (model.vision) present.add("vision");
  return capabilityOrder.filter((capability) => present.has(capability));
}

/** Parameter scale and activation topology for details: "30B · 3B active (MoE)". */
export function parametersLabel(model: LocalModel) {
  const scale = [
    model.parameters,
    model.active_parameters ? `${model.active_parameters} active` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const arch = model.architecture
    ? architectureCopy(model.architecture)
    : undefined;
  if (scale && arch) return `${scale} (${arch})`;
  return scale || arch;
}

function allModelBadges(model: LocalModel): string[] {
  const badges: string[] = [];
  if (model.active_parameters) {
    badges.push(`${model.active_parameters} active`);
  } else if (model.parameters) {
    badges.push(model.parameters);
  }
  for (const capability of modelCapabilities(model)) {
    badges.push(capabilityCopy(capability));
  }
  return badges;
}

const visibleBadgeCount = 3;

export interface CollapsedRowBadges {
  badges: string[];
  overflowTitle?: string;
}

/** Concise badges and any `+N` overflow tooltip for the collapsed row, built once from structured fields. */
export function collapsedRowBadges(model: LocalModel): CollapsedRowBadges {
  const badges = allModelBadges(model);
  if (badges.length <= visibleBadgeCount) {
    return { badges };
  }
  return {
    badges: [
      ...badges.slice(0, visibleBadgeCount),
      `+${badges.length - visibleBadgeCount}`,
    ],
    overflowTitle: badges.slice(visibleBadgeCount).join(", "),
  };
}

function formatRemainingTime(seconds: number) {
  if (seconds < 60) return `${seconds}s left`;
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m left`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

/** Live download progress summary: "checking file", or "25% · 50 MB/s · 5m left". */
export function downloadStatusDetail(model: LocalModel) {
  const download = model.download;
  if (download?.step === "verify") return "checking file";
  const parts = [`${downloadPercent(model)}%`];
  if (download?.bytes_per_second && download.bytes_per_second > 0) {
    parts.push(`${formatBytes(download.bytes_per_second)}/s`);
    const remaining = download.total_bytes - download.done_bytes;
    if (remaining > 0) {
      parts.push(
        formatRemainingTime(Math.ceil(remaining / download.bytes_per_second)),
      );
    }
  }
  return parts.join(" · ");
}

/** Measured generation and prompt-processing throughput for model details. */
export function speedLabel(model: LocalModel) {
  const parts: string[] = [];
  if (model.tokens_per_second && model.tokens_per_second > 0) {
    parts.push(`${Math.round(model.tokens_per_second)} tokens/s`);
  }
  if (model.prompt_tokens_per_second && model.prompt_tokens_per_second > 0) {
    parts.push(`${Math.round(model.prompt_tokens_per_second)} prompt tokens/s`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

/** Returns `url` only when it parses as an `https:` URL. */
export function safeModelSourceUrl(url: string | undefined) {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** Compact display label for a validated `https:` model card URL. */
export function modelSourceLabel(url: string) {
  const parsed = new URL(url);
  return `${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Candidate local models on disk ordered loaded-first, recommended, then largest. */
export function localSwitchTargets(view: LocalModelsView): LocalModel[] {
  return view.models
    .map((item) => item.model)
    .filter((model) => model.state === "loaded" || model.state === "idle")
    .sort((left, right) => {
      if (left.state !== right.state) {
        return left.state === "loaded" ? -1 : 1;
      }
      if (left.recommended !== right.recommended) {
        return left.recommended ? -1 : 1;
      }
      return right.memory_bytes - left.memory_bytes;
    });
}

/**
 * The model a switch to Local model runs by default: a loaded one, else one
 * on disk. None when the Computer has no model downloaded yet.
 */
export function localSwitchTarget(view: LocalModelsView) {
  return localSwitchTargets(view)[0];
}
