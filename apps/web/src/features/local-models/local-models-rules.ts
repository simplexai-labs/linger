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

export function poolFreeBytes(pool: LocalModelPool) {
  return Math.max(0, pool.total_bytes - pool.used_bytes);
}

/** What the header adds up: GPU memory when the Computer has GPUs, else its memory. */
export function memorySummary(view: LocalModelsView) {
  const gpus = view.pools.filter((pool) => pool.kind === "gpu");
  const pools = gpus.length ? gpus : view.pools;
  return {
    gpu: gpus.length > 0,
    totalBytes: pools.reduce((sum, pool) => sum + pool.total_bytes, 0),
    usedBytes: pools.reduce((sum, pool) => sum + pool.used_bytes, 0),
  };
}

export interface LoadCheck {
  pool: LocalModelPool;
  needBytes: number;
  freeBytes: number;
  /** Loaded models in the same pool, the ones the user could unload. */
  loaded: ModelEntry[];
}

/** Why a model cannot load now, or `null` when its pool reports room for it. */
export function loadCheck(
  view: LocalModelsView,
  model: LocalModel,
): LoadCheck | null {
  const pool = poolOf(view, model.pool);
  if (!pool || poolFreeBytes(pool) >= model.memory_bytes) return null;
  return {
    freeBytes: poolFreeBytes(pool),
    loaded: modelEntries(view).filter(
      (entry) =>
        entry.status === "loaded" &&
        entry.model.pool === pool.id &&
        entry.model.id !== model.id,
    ),
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
export function contextLabel(tokens: number) {
  return `${Math.round(tokens / 1024)}K tokens`;
}

/** Agent names joined for a sentence. */
export function agentNames(entry: Pick<LocalModelView, "used_by">) {
  return entry.used_by.map((user) => user.name).join(", ");
}
