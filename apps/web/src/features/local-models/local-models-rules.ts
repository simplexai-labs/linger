import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";

import type { Translate } from "@/i18n/language";
import { formatBytes } from "@/lib/format-bytes";

import { architectureCopy, capabilityCopy } from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
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
      model.error?.code === "NETWORK_UNAVAILABLE" ||
      model.error?.code === "DISK_INSUFFICIENT")
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

const PREFERRED_POLY_Q4_INKLING_ID = "inkling-2-mini-q4-poly:ud-q4_k_xl";
const PREFERRED_POLY_Q4_INKLING_QUANT = "UD-Q4_K_XL";
const PREFERRED_INKLING_Q4_ID = "inkling-2-mini:ud-q4_k_m";
const PREFERRED_INKLING_Q4_QUANT = "UD-Q4_K_M";
const PREFERRED_POLY_Q3_INKLING_ID = "inkling-2-mini-q3-poly:ud-q3_k_xl";
const PREFERRED_POLY_Q3_INKLING_QUANT = "UD-Q3_K_XL";
const PREFERRED_INKLING_IQ3_ID = "inkling-2-mini-iq3xxs:ud-iq3_xxs";
const PREFERRED_INKLING_IQ3_QUANT = "UD-IQ3_XXS";
const PREFERRED_POLY_Q2_INKLING_ID = "inkling-2-mini-q2-poly:ud-q2_k_xl";
const PREFERRED_POLY_Q2_INKLING_QUANT = "UD-Q2_K_XL";

function preferredInklingRank(model: LocalModel): number {
  const id = model.id.toLowerCase();
  if (
    id === PREFERRED_POLY_Q4_INKLING_ID ||
    (model.engine === "polystrata" &&
      model.quant === PREFERRED_POLY_Q4_INKLING_QUANT)
  ) {
    return 5;
  }
  if (
    id === PREFERRED_INKLING_Q4_ID ||
    model.quant === PREFERRED_INKLING_Q4_QUANT
  ) {
    return 4;
  }
  if (
    id === PREFERRED_POLY_Q3_INKLING_ID ||
    (model.engine === "polystrata" &&
      model.quant === PREFERRED_POLY_Q3_INKLING_QUANT)
  ) {
    return 3;
  }
  if (
    id === PREFERRED_INKLING_IQ3_ID ||
    model.quant === PREFERRED_INKLING_IQ3_QUANT
  ) {
    return 2;
  }
  if (
    id === PREFERRED_POLY_Q2_INKLING_ID ||
    (model.engine === "polystrata" &&
      model.quant === PREFERRED_POLY_Q2_INKLING_QUANT)
  ) {
    return 1;
  }
  return 0;
}

function isActionableUnavailableReason(model: LocalModel): boolean {
  const code = model.availability.reason?.code;
  return (
    code === "DRIVER_UPDATE_REQUIRED" || code === "RUNTIME_DEPENDENCY_MISSING"
  );
}

function memoryShortfallBytes(model: LocalModel): number {
  const reason = model.availability.reason;
  if (
    reason?.code === "MEMORY_INSUFFICIENT" &&
    reason.need_bytes !== undefined &&
    reason.have_bytes !== undefined
  ) {
    return Math.max(0, reason.need_bytes - reason.have_bytes);
  }
  return reason?.need_bytes ?? model.memory_bytes;
}

/**
 * Picks the best Inkling 2 Mini entry from a Computer's library for the
 * featured spotlight: highest status first, then better hardware fit, then
 * Computer recommendation, preferring top variants when ties remain. When all
 * variants are unavailable, actionable driver/runtime upgrades come first
 * (preserving Computer suitability order), followed by the smallest memory
 * shortfall.
 */
export function featuredInklingEntry(
  entries: readonly ModelEntry[],
): ModelEntry | undefined {
  const matching = entries.filter((entry) =>
    isInkling2MiniModelId(entry.model.id),
  );
  if (matching.length <= 1) return matching[0];
  return [...matching].sort((a, b) => {
    const statusDiff =
      modelStatuses.indexOf(a.status) - modelStatuses.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    if (a.status === "unavailable" && b.status === "unavailable") {
      const aActionable = isActionableUnavailableReason(a.model);
      const bActionable = isActionableUnavailableReason(b.model);
      if (aActionable !== bActionable) return aActionable ? -1 : 1;
      if (aActionable && bActionable) return 0;
      const shortfallDiff =
        memoryShortfallBytes(a.model) - memoryShortfallBytes(b.model);
      if (shortfallDiff !== 0) return shortfallDiff;
      const aNeed =
        a.model.availability.reason?.need_bytes ?? a.model.memory_bytes;
      const bNeed =
        b.model.availability.reason?.need_bytes ?? b.model.memory_bytes;
      if (aNeed !== bNeed) return aNeed - bNeed;
    }
    return (
      fitOrder[a.model.fit] - fitOrder[b.model.fit] ||
      Number(b.model.recommended) - Number(a.model.recommended) ||
      preferredInklingRank(b.model) - preferredInklingRank(a.model)
    );
  })[0];
}

/**
 * Whether a model is active on the Computer (installed, loading, downloading,
 * or failed), as opposed to absent from disk (`available` or `unavailable`).
 */
export function isActiveOnComputer(status: ModelStatus): boolean {
  return status !== "available" && status !== "unavailable";
}

const FEATURED_INKLING_GROUP_KEY = "featured:inkling-2-mini";

/**
 * Stable grouping key uniting sibling quantizations or engines of the same
 * logical model. Derived strictly from structured fields (`id` for the featured
 * Inkling 2 Mini family, else validated `source_url`, else full `id`).
 */
export function modelGroupKey(model: LocalModel): string {
  if (isInkling2MiniModelId(model.id)) return FEATURED_INKLING_GROUP_KEY;
  const sourceUrl = safeModelSourceUrl(model.source_url);
  if (sourceUrl) return `source:${sourceUrl.toLowerCase()}`;
  return `id:${model.id.toLowerCase()}`;
}

/**
 * Clean model title for a grouped multi-version card: removes the structured
 * trailing `(<quant>)` suffix appended by localmodels when a separate version
 * picker shows the selected quantization.
 */
export function modelBaseName(model: LocalModel): string {
  const name = model.name.trim();
  if (model.quant) {
    const suffix = ` (${model.quant})`;
    if (
      name.length > suffix.length &&
      name.toLowerCase().endsWith(suffix.toLowerCase())
    ) {
      return name.slice(0, -suffix.length).trimEnd();
    }
  }
  if (
    isInkling2MiniModelId(model.id) &&
    name.startsWith("Inkling 2 Mini (") &&
    name.endsWith(")")
  ) {
    return "Inkling 2 Mini";
  }
  return model.name;
}

export interface ModelCardGroup {
  /** Stable key for React rendering, expand state, and variant selection. */
  key: string;
  /** Best-fit variant for this Computer, shown by default. */
  defaultEntry: ModelEntry;
  /** All selectable variants in descending suitability order. */
  variants: ModelEntry[];
}

export interface LibrarySections {
  spotlight?: ModelCardGroup;
  spotlightPosition: "top" | "afterAvailable";
  onComputer: ModelCardGroup[];
  available: ModelCardGroup[];
  unavailable: ModelCardGroup[];
  /** Show per-row engine pills when multiple engines or an accelerated engine exist. */
  showEngineBadge: boolean;
  /** True when every unavailable model failed solely for insufficient memory. */
  unavailableAllMemory: boolean;
}

/**
 * Groups ordered entries into logical model cards and page sections:
 * Spotlight (Inkling 2 Mini), On this computer, Available to download, and
 * Unavailable. Extra active variants of the same model stay visible as their
 * own cards in On this computer so nothing installed or downloading is hidden.
 */
export function buildModelGroups(
  entries: readonly ModelEntry[],
): LibrarySections {
  const engines = new Set(
    entries.map((entry) => entry.model.engine).filter(Boolean),
  );
  const showEngineBadge =
    engines.size > 1 || engines.has("polystrata") || engines.has("strata");

  const grouped = new Map<string, ModelEntry[]>();
  for (const entry of entries) {
    const key = modelGroupKey(entry.model);
    const list = grouped.get(key);
    if (list) list.push(entry);
    else grouped.set(key, [entry]);
  }

  let spotlight: ModelCardGroup | undefined;
  const onComputer: ModelCardGroup[] = [];
  const available: ModelCardGroup[] = [];
  const unavailable: ModelCardGroup[] = [];

  for (const [key, members] of grouped.entries()) {
    const best =
      key === FEATURED_INKLING_GROUP_KEY
        ? (featuredInklingEntry(members) ?? members[0]!)
        : members[0]!;
    const ordered = [best, ...members.filter((item) => item !== best)];
    const extraActive = ordered
      .slice(1)
      .filter((item) => isActiveOnComputer(item.status));
    const extraSet = new Set(extraActive);
    const primaryVariants = extraActive.length
      ? ordered.filter((item) => !extraSet.has(item))
      : ordered;
    const primaryGroup: ModelCardGroup = {
      defaultEntry: best,
      key,
      variants: primaryVariants,
    };

    if (key === FEATURED_INKLING_GROUP_KEY) {
      spotlight = primaryGroup;
    } else if (isActiveOnComputer(best.status)) {
      onComputer.push(primaryGroup);
    } else if (best.status === "available") {
      available.push(primaryGroup);
    } else {
      unavailable.push(primaryGroup);
    }

    for (const extra of extraActive) {
      onComputer.push({
        defaultEntry: extra,
        key: `active:${extra.model.id}`,
        variants: [extra],
      });
    }
  }

  const spotlightPosition =
    spotlight &&
    spotlight.defaultEntry.status === "unavailable" &&
    (onComputer.length > 0 || available.length > 0)
      ? "afterAvailable"
      : "top";

  const unavailableAllMemory =
    unavailable.length > 0 &&
    unavailable.every(
      (group) =>
        group.defaultEntry.model.availability.reason?.code ===
        "MEMORY_INSUFFICIENT",
    );

  return {
    available,
    onComputer,
    showEngineBadge,
    spotlight,
    spotlightPosition,
    unavailable,
    unavailableAllMemory,
  };
}

/** Whether at least one model on this Computer is already usable without a driver update. */
export function hasReadyLocalModels(entries: readonly ModelEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.status === "loaded" ||
      entry.status === "loading" ||
      entry.status === "idle" ||
      entry.status === "downloading" ||
      entry.status === "available",
  );
}

/** The library as one list: by status, then recommended, then featured, then by fit. */
export function modelEntries(view: LocalModelsView): ModelEntry[] {
  return view.models
    .map((item) => ({ ...item, status: modelStatus(item.model) }))
    .sort(
      (a, b) =>
        modelStatuses.indexOf(a.status) - modelStatuses.indexOf(b.status) ||
        Number(b.model.recommended) - Number(a.model.recommended) ||
        Number(isInkling2MiniModelId(b.model.id)) -
          Number(isInkling2MiniModelId(a.model.id)) ||
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
export function poolLabel(
  view: LocalModelsView,
  pool: LocalModelPool,
  t: Translate,
) {
  if (pool.kind === "system") return t(m.poolSystem);
  if (pool.kind === "unified") return t(m.poolUnified);
  const name = gpuName(view, pool);
  return name
    ? t(m.gpuIndexNamed, { index: gpuIndex(pool), name })
    : t(m.gpuIndex, { index: gpuIndex(pool) });
}

/** A GPU's number as the Computer reports it, never grouped like a count. */
function gpuIndex(pool: LocalModelPool) {
  return String(pool.gpu_index);
}

/**
 * A pool's short name for status lines: "GPU 0", "system memory", "memory".
 * Undefined without a pool, so no placement is shown.
 */
export function placeName(
  view: LocalModelsView,
  poolId: string | undefined,
  t: Translate,
) {
  const pool = poolOf(view, poolId);
  if (!pool) return undefined;
  if (pool.kind === "gpu") return t(m.gpuIndex, { index: gpuIndex(pool) });
  return t(pool.kind === "system" ? m.placeSystem : m.placeMemory);
}

/** The same short name where it stands alone: "GPU 0", "System memory", "Memory". */
export function placeTitle(
  view: LocalModelsView,
  poolId: string | undefined,
  t: Translate,
) {
  const pool = poolOf(view, poolId);
  if (!pool) return undefined;
  if (pool.kind === "gpu") return t(m.gpuIndex, { index: gpuIndex(pool) });
  return t(pool.kind === "system" ? m.poolSystem : m.placeMemoryTitle);
}

/**
 * Model and memory sizes always read in GB with at most one decimal, so a
 * small model and an empty pool compare at a glance with the rest: 0.6 GB and
 * 0 GB, not 614.4 MB and 0 B.
 */
export function formatGigabytes(bytes: number, t: Translate) {
  return t(m.gigabytes, { value: Math.round((bytes / 1024 ** 3) * 10) / 10 });
}

export function poolFreeBytes(pool: LocalModelPool) {
  return Math.max(0, pool.total_bytes - pool.used_bytes);
}

/** Memory held by known models and foundation components in one pool. */
export function poolHolderBytes(pool: LocalModelPool) {
  return pool.holders.reduce((sum, holder) => sum + holder.bytes, 0);
}

function poolResidualBytes(pool: LocalModelPool) {
  return Math.max(0, pool.used_bytes - poolHolderBytes(pool));
}

/**
 * Memory in the pool held by other apps (games, browsers, video players)
 * that the user could close. When localmodels lists those apps, only they
 * count; an older localmodels lists none, so the whole residual counts.
 */
export function poolOtherBytes(pool: LocalModelPool) {
  const residual = poolResidualBytes(pool);
  if (pool.external_holders === undefined) return residual;
  const listed = pool.external_holders.reduce(
    (sum, holder) => sum + holder.bytes,
    0,
  );
  return Math.min(residual, listed);
}

/**
 * Used memory that no holder or listed app accounts for, such as an engine
 * holding more than its catalog estimate or the driver and desktop. Closing
 * other apps does not free it.
 */
export function poolUnaccountedBytes(pool: LocalModelPool) {
  return poolResidualBytes(pool) - poolOtherBytes(pool);
}

/** Free memory plus memory currently held by external apps in one pool. */
export function poolReclaimableBytes(pool: LocalModelPool) {
  return poolFreeBytes(pool) + poolOtherBytes(pool);
}

function summarizePools(pools: readonly LocalModelPool[], gpu: boolean) {
  const totalBytes = pools.reduce((sum, pool) => sum + pool.total_bytes, 0);
  const usedBytes = pools.reduce((sum, pool) => sum + pool.used_bytes, 0);
  const otherBytes = pools.reduce((sum, pool) => sum + poolOtherBytes(pool), 0);
  const unaccountedBytes = pools.reduce(
    (sum, pool) => sum + poolUnaccountedBytes(pool),
    0,
  );
  return {
    freeBytes: Math.max(0, totalBytes - usedBytes),
    gpu,
    otherBytes,
    totalBytes,
    unaccountedBytes,
    usedBytes,
  };
}

function summaryPools(view: LocalModelsView) {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  return {
    gpu: gpus.length > 0,
    pools: gpus.length ? gpus : view.pools,
  };
}

/** What the header adds up: GPU memory when the Computer has GPUs, else its memory. */
export function memorySummary(view: LocalModelsView) {
  const { gpu, pools } = summaryPools(view);
  const { freeBytes, totalBytes, usedBytes } = summarizePools(pools, gpu);
  return { freeBytes, gpu, totalBytes, usedBytes };
}

export interface MemorySegment {
  bytes: number;
  id: string;
  name: string;
}

export interface MemorySegments {
  componentBytes: number;
  models: MemorySegment[];
  otherBytes: number;
  unaccountedBytes: number;
}

/** Breakdown of models, components, other apps, and unaccounted use across the same pools `memorySummary` adds up. */
export function memorySegments(view: LocalModelsView): MemorySegments {
  const { gpu, pools } = summaryPools(view);
  const { otherBytes, unaccountedBytes } = summarizePools(pools, gpu);
  const modelTotals = new Map<string, MemorySegment>();
  let componentBytes = 0;
  for (const pool of pools) {
    for (const holder of pool.holders) {
      if (holder.bytes <= 0) continue;
      if (holder.kind === "model") {
        const prev = modelTotals.get(holder.id);
        modelTotals.set(holder.id, {
          bytes: (prev?.bytes ?? 0) + holder.bytes,
          id: holder.id,
          name: holder.name,
        });
      } else {
        componentBytes += holder.bytes;
      }
    }
  }
  return {
    componentBytes,
    models: [...modelTotals.values()],
    otherBytes,
    unaccountedBytes,
  };
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
  if (reason.memory_kind === "ram") {
    const systemPools = view.pools.filter((pool) => pool.kind === "system");
    const ramCapacity = Math.max(
      view.computer.host?.ram_total_bytes ?? 0,
      ...systemPools.map((pool) => pool.total_bytes),
      0,
    );
    return (
      systemPools.some((pool) => poolOtherBytes(pool) > 0) &&
      reason.need_bytes <= ramCapacity
    );
  }
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const pools = gpus.length ? gpus : view.pools;
  return (
    pools.some((pool) => poolOtherBytes(pool) > 0) &&
    reason.need_bytes <= maxHardwareCapacity(view)
  );
}

export type HostBlockerReason = NonNullable<
  LocalModel["availability"]["reason"]
> & {
  code:
    | "DRIVER_UPDATE_REQUIRED"
    | "RUNTIME_DEPENDENCY_MISSING"
    | "GPU_UNSUPPORTED";
};

const hostBlockerPriority = [
  "DRIVER_UPDATE_REQUIRED",
  "RUNTIME_DEPENDENCY_MISSING",
  "GPU_UNSUPPORTED",
] as const;

/**
 * Host-wide blocker explaining why no local model can be downloaded on this
 * Computer right now (outdated NVIDIA driver, missing runtime library, or
 * unsupported GPU). Null once any model is downloadable or active.
 */
export function hostBlocker(view: LocalModelsView): HostBlockerReason | null {
  if (!view.available || !view.models.length) return null;
  const hasDownloadableOrActive = view.models.some(({ model }) => {
    const status = modelStatus(model);
    return (
      status === "available" ||
      status === "loaded" ||
      status === "loading" ||
      status === "downloading"
    );
  });
  if (hasDownloadableOrActive) return null;
  for (const code of hostBlockerPriority) {
    const match = view.models.find(
      ({ model }) => model.availability.reason?.code === code,
    )?.model.availability.reason;
    if (match && match.code === code) {
      return match as HostBlockerReason;
    }
  }
  return null;
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

  for (const group of groups) {
    const stats = summarizePools(group.pools, group.gpu);
    if (stats.otherBytes <= 0) continue;
    const blockedDownload = entries.some((entry) => {
      if (entry.status !== "unavailable") return false;
      const reason = entry.model.availability.reason;
      const isRamMiss = reason?.memory_kind === "ram";
      if (group.gpu && isRamMiss) return false;
      if (!group.gpu && gpus.length > 0 && !isRamMiss) return false;
      return memoryReclaimable(view, entry.model);
    });
    if (blockedDownload) {
      return {
        freeBytes: stats.freeBytes,
        gpu: group.gpu,
        kind: "blocked_download",
        otherBytes: stats.otherBytes,
        totalBytes: stats.totalBytes,
      };
    }
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
        entry.model.memory_bytes > poolFreeBytes(pool)
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
  if (!pool || poolFreeBytes(pool) >= model.memory_bytes) return null;
  const loaded = modelEntries(view).filter(
    (entry) =>
      entry.status === "loaded" &&
      entry.model.pool === pool.id &&
      entry.model.id !== model.id,
  );
  return {
    freeBytes: poolFreeBytes(pool),
    kept: pool.holders.filter(
      (holder) => !loaded.some((entry) => entry.model.id === holder.id),
    ),
    loaded,
    needBytes: model.memory_bytes,
    pool,
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
export function contextLabel(tokens: number, t: Translate) {
  if (tokens < 1024) return t(m.contextTokens, { tokens });
  return t(m.contextKiloTokens, { thousands: Math.round(tokens / 1024) });
}

/** Names in one line, separated the way the language lists them. */
export function joinList(items: readonly string[], t: Translate) {
  return items.join(t(m.listSeparator));
}

/** Compact Agent count chip for a model on the Computer, or undefined when unused. */
export function usedByBadge(
  entry: Pick<ModelEntry, "model" | "status" | "used_by">,
  t: Translate,
  names?: readonly string[],
): string | undefined {
  const count = names ? names.length : entry.used_by.length;
  if (!isModelOnComputer(entry.model, entry.status) || !count) {
    return undefined;
  }
  return t(m.agentCount, { count });
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
export function parametersLabel(model: LocalModel, t: Translate) {
  const scale = [
    model.parameters,
    model.active_parameters
      ? t(m.activeParameters, { parameters: model.active_parameters })
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const architecture = model.architecture
    ? architectureCopy(model.architecture, t)
    : undefined;
  if (scale && architecture)
    return t(m.parametersWithArchitecture, { architecture, scale });
  return scale || architecture;
}

/** Compact context badge for collapsed model rows: "128K", or undefined below 1K. */
export function compactContextLabel(tokens: number, t: Translate) {
  if (tokens < 1024) return undefined;
  return t(m.contextCompact, { thousands: Math.round(tokens / 1024) });
}

function allModelBadges(model: LocalModel, t: Translate): string[] {
  const badges: string[] = [];
  if (model.active_parameters) {
    badges.push(t(m.activeParameters, { parameters: model.active_parameters }));
  } else if (model.parameters) {
    badges.push(model.parameters);
  }
  for (const capability of modelCapabilities(model)) {
    badges.push(capabilityCopy(capability, t));
  }
  const context = compactContextLabel(model.context_tokens, t);
  if (context) {
    badges.push(context);
  }
  return badges;
}

const visibleBadgeCount = 3;

export interface CollapsedRowBadges {
  badges: string[];
  overflowTitle?: string;
}

/** Concise badges and any `+N` overflow tooltip for the collapsed row, built once from structured fields. */
export function collapsedRowBadges(
  model: LocalModel,
  t: Translate,
): CollapsedRowBadges {
  const badges = allModelBadges(model, t);
  if (badges.length <= visibleBadgeCount) {
    return { badges };
  }
  return {
    badges: [
      ...badges.slice(0, visibleBadgeCount),
      `+${badges.length - visibleBadgeCount}`,
    ],
    overflowTitle: joinList(badges.slice(visibleBadgeCount), t),
  };
}

function formatRemainingTime(seconds: number, t: Translate) {
  if (seconds < 60) return t(m.secondsLeft, { seconds });
  const totalMinutes = Math.ceil(seconds / 60);
  if (totalMinutes < 60) return t(m.minutesLeft, { minutes: totalMinutes });
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0
    ? t(m.hoursMinutesLeft, { hours, minutes })
    : t(m.hoursLeft, { hours });
}

/** Live download progress summary: "checking file", or "25% · 50 MB/s · 5m left". */
export function downloadStatusDetail(model: LocalModel, t: Translate) {
  const download = model.download;
  if (download?.step === "verify") return t(m.checkingFile);
  const parts = [t(m.percent, { percent: downloadPercent(model) })];
  if (download?.bytes_per_second && download.bytes_per_second > 0) {
    parts.push(
      t(m.perSecond, { size: formatBytes(download.bytes_per_second) }),
    );
    const remaining = download.total_bytes - download.done_bytes;
    if (remaining > 0) {
      parts.push(
        formatRemainingTime(
          Math.ceil(remaining / download.bytes_per_second),
          t,
        ),
      );
    }
  }
  return parts.join(" · ");
}

/** Measured generation and prompt-processing throughput for model details. */
export function speedLabel(model: LocalModel, t: Translate) {
  const parts: string[] = [];
  if (model.tokens_per_second && model.tokens_per_second > 0) {
    parts.push(
      t(m.tokensPerSecond, { speed: Math.round(model.tokens_per_second) }),
    );
  }
  if (model.prompt_tokens_per_second && model.prompt_tokens_per_second > 0) {
    parts.push(
      t(m.promptTokensPerSecond, {
        speed: Math.round(model.prompt_tokens_per_second),
      }),
    );
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
