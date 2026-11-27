import { readFile } from "node:fs/promises";
import path from "node:path";
import { orderByRegion, sourceRegion, type Region } from "@linger/service-kit";
import {
  downloadVerified,
  type DownloadDiagnosticEvent,
  type DownloadTiming,
} from "./download.js";
import { npmMirrorRegistry, probeNpmRegistries } from "./npm-registry.js";
import { atomicPrivate, privateDirectory } from "./private-files.js";

export type { Region };

export type RegionResolutionMethod =
  | "env"
  | "cache"
  | "probe"
  | "default"
  | "fallback";

export interface RegionProbeRate {
  registry: string;
  host: string;
  bytes: number;
  elapsedMs: number;
  bytesPerSecond: number;
}

export interface RegionResolutionInfo {
  region: Region;
  method: RegionResolutionMethod;
  ms: number;
  probes?: RegionProbeRate[];
}

export interface RegionResolvedEvent extends RegionResolutionInfo {
  kind: "region_resolved";
}

export interface RegionFallbackEvent {
  kind: "region_fallback";
  fromRegion: Region;
  toRegion: Region;
  host: string;
}

export type RegionDownloadEvent =
  | RegionResolvedEvent
  | DownloadDiagnosticEvent
  | RegionFallbackEvent;

/** Concise single-line summary of how the download region was chosen. */
export function formatRegionResolution(info: RegionResolutionInfo): string {
  const detail = info.probes?.length
    ? `; ${info.probes
        .map((probe) =>
          probe.bytes < 0
            ? `${probe.host} refused`
            : `${probe.host} ${Math.round(probe.bytesPerSecond / 1024)} KB/s`,
        )
        .join(", ")}`
    : "";
  return `Download region: ${info.region} (${info.method}, ${info.ms}ms${detail}).`;
}

/** Concise hostname-only log line for a region or mirror download event. */
export function formatRegionDownloadEvent(event: RegionDownloadEvent): string {
  if (event.kind === "region_resolved") return formatRegionResolution(event);
  if (event.kind === "slow_switch")
    return `Download slow on ${event.fromHost} (${Math.round(event.bytesPerSecond / 1024)} KB/s); switching to ${event.toHost}.`;
  if (event.kind === "host_switch")
    return `Download failed on ${event.fromHost} (${event.reason}); switching to ${event.toHost}.`;
  return `Download region fallback: ${event.fromRegion} -> ${event.toRegion} (${event.host}).`;
}

// The record localmodels shares: see scripts/installs/README.md.
export const REGION_SCHEMA = "simplex.region/v1";
const STALE_MS = 24 * 60 * 60_000;
export interface RegionRecord {
  schema: typeof REGION_SCHEMA;
  region: Region;
  /** ISO 8601 UTC. */
  resolved_at: string;
  method: "env" | "probe" | "fallback";
}

/** Where a home keeps its resolved download region. */
export function regionFile(home: string): string {
  return path.join(path.resolve(home), "runtime", "region.json");
}

/** SIMPLEX_REGION when it names a region; undefined for `auto` or unset. */
export function forcedRegion(
  environment: NodeJS.ProcessEnv = process.env,
): Region | undefined {
  const value = environment.SIMPLEX_REGION?.trim() || "auto";
  if (value === "auto") return undefined;
  if (value === "cn" || value === "global") return value;
  throw new Error("SIMPLEX_REGION must be auto, global or cn.");
}

async function readRecord(file: string): Promise<RegionRecord | undefined> {
  let value: Partial<RegionRecord>;
  try {
    value = JSON.parse(await readFile(file, "utf8")) as Partial<RegionRecord>;
  } catch {
    return undefined;
  }
  return value?.schema === REGION_SCHEMA &&
    (value.region === "cn" || value.region === "global") &&
    (value.method === "env" ||
      value.method === "probe" ||
      value.method === "fallback") &&
    typeof value.resolved_at === "string"
    ? (value as RegionRecord)
    : undefined;
}

function fresh(record: RegionRecord, now: number): boolean {
  const age = now - Date.parse(record.resolved_at);
  return age >= 0 && age < STALE_MS;
}

// The record only saves a later probe; a home that cannot hold it still
// downloads.
async function save(
  file: string,
  region: Region,
  method: RegionRecord["method"],
) {
  const record: RegionRecord = {
    schema: REGION_SCHEMA,
    region,
    resolved_at: new Date().toISOString(),
    method,
  };
  try {
    await privateDirectory(path.dirname(file));
    await atomicPrivate(file, `${JSON.stringify(record)}\n`);
  } catch {
    // Best effort, as above.
  }
}

// One resolution per home and process, so concurrent downloads share a probe.
interface Resolution {
  promise: Promise<RegionResolutionInfo>;
  settled?: RegionResolutionInfo;
  controller: AbortController | undefined;
  waiters: number;
}
const resolutions = new Map<string, Resolution>();

/**
 * Returns the download region for `home` only when already known without
 * probing npm registries: `SIMPLEX_REGION` when forced, a settled in-process
 * resolution, or a fresh `<home>/runtime/region.json` record. Returns
 * `undefined` when a network probe would be needed.
 */
export async function cachedRegion(
  home: string,
  options: {
    signal?: AbortSignal;
    onResolved?: (info: RegionResolutionInfo) => void;
  } = {},
): Promise<Region | undefined> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const file = regionFile(home);
  const forced = forcedRegion();
  if (forced) {
    const saved = await readRecord(file);
    signal?.throwIfAborted();
    if (
      saved?.region !== forced ||
      saved.method !== "env" ||
      !fresh(saved, Date.now())
    )
      await save(file, forced, "env");
    signal?.throwIfAborted();
    options.onResolved?.({ region: forced, method: "env", ms: elapsed() });
    return forced;
  }
  const settled = resolutions.get(file)?.settled;
  if (settled) {
    options.onResolved?.(settled);
    return settled.region;
  }
  const saved = await readRecord(file);
  signal?.throwIfAborted();
  if (saved && fresh(saved, Date.now())) {
    options.onResolved?.({
      region: saved.region,
      method: "cache",
      ms: elapsed(),
    });
    return saved.region;
  }
  return undefined;
}

async function resolve(
  file: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<RegionResolutionInfo> {
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, Math.round(performance.now() - startedAt));
  const forced = forcedRegion();
  const saved = await readRecord(file);
  if (forced) {
    if (
      saved?.region !== forced ||
      saved.method !== "env" ||
      !fresh(saved, Date.now())
    )
      await save(file, forced, "env");
    return { region: forced, method: "env", ms: elapsed() };
  }
  if (saved && fresh(saved, Date.now()))
    return { region: saved.region, method: "cache", ms: elapsed() };
  const results = await probeNpmRegistries(signal, fetcher);
  const probes: RegionProbeRate[] = results.map((entry) => ({
    registry: entry.registry,
    host: new URL(entry.registry).hostname,
    bytes: entry.bytes,
    elapsedMs: Math.max(0, Math.round(entry.elapsedMs)),
    bytesPerSecond:
      entry.bytes > 0
        ? Math.round((entry.bytes * 1000) / Math.max(entry.elapsedMs, 1))
        : 0,
  }));
  const [best] = results;
  // Neither registry answered: global for now, probed again next run.
  if (!best || best.bytes <= 0)
    return { region: "global", method: "default", ms: elapsed(), probes };
  const region = best.registry === npmMirrorRegistry ? "cn" : "global";
  await save(file, region, "probe");
  return { region, method: "probe", ms: elapsed(), probes };
}

/**
 * The download region of `home`: SIMPLEX_REGION when it names one, else a
 * region.json resolved within the last 24 hours, else the npm registry probe
 * (cn when the China mirror wins). Resolved once per process.
 */
export async function resolveRegion(
  home: string,
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    onResolved?: (info: RegionResolutionInfo) => void;
  } = {},
): Promise<Region> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const file = regionFile(home);
  let pending = resolutions.get(file);
  if (!pending) {
    const controller = new AbortController();
    const resolution: Resolution = {
      promise: resolve(file, controller.signal, options.fetcher ?? fetch),
      controller,
      waiters: 0,
    };
    resolutions.set(file, resolution);
    resolution.promise.then(
      (info) => {
        resolution.controller = undefined;
        resolution.settled = info;
      },
      () => {
        resolution.controller = undefined;
        if (resolutions.get(file) === resolution) resolutions.delete(file);
      },
    );
    pending = resolution;
  }
  pending.waiters++;
  let onAbort: (() => void) | undefined;
  try {
    const info = signal
      ? await Promise.race([
          pending.promise,
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ])
      : await pending.promise;
    options.onResolved?.(info);
    return info.region;
  } finally {
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    pending.waiters--;
    // A cancelled setup leaves the shared probe running for other setups.
    if (pending.waiters === 0 && pending.controller) {
      if (resolutions.get(file) === pending) resolutions.delete(file);
      pending.controller.abort();
    }
  }
}

/**
 * Records that a download fell back to `region` because the preferred one
 * failed: this process and the next runs prefer it. A region forced through
 * SIMPLEX_REGION stays forced.
 */
export async function recordRegionFallback(
  home: string,
  region: Region,
): Promise<void> {
  if (forcedRegion()) return;
  const file = regionFile(home);
  const current = (await resolutions.get(file)?.promise.catch(() => undefined))
    ?.region;
  if (current === region) return;
  const info: RegionResolutionInfo = { region, method: "fallback", ms: 0 };
  resolutions.set(file, {
    promise: Promise.resolve(info),
    settled: info,
    controller: undefined,
    waiters: 0,
  });
  await save(file, region, "fallback");
}

/**
 * downloadVerified with the sources in the home's region first. Only a
 * download offered by both regions resolves the region, so one served from
 * a single region never probes. When the other region served it, that
 * becomes the home's region.
 */
export async function downloadInRegion(
  home: string,
  options: Parameters<typeof downloadVerified>[0] & {
    onEvent?: (event: RegionDownloadEvent) => void;
  },
  fetcher: typeof fetch = fetch,
  timing?: DownloadTiming,
): Promise<string> {
  const sources = [options.url, ...(options.mirrors ?? [])];
  const onDiagnostic =
    options.onDiagnostic || options.onEvent
      ? (event: DownloadDiagnosticEvent) => {
          options.onDiagnostic?.(event);
          options.onEvent?.(event);
        }
      : undefined;
  if (new Set(sources.map(sourceRegion)).size < 2)
    return downloadVerified(
      { ...options, ...(onDiagnostic ? { onDiagnostic } : {}) },
      fetcher,
      timing,
    );
  const region = await resolveRegion(home, {
    signal: options.signal,
    fetcher,
    onResolved: (info) =>
      options.onEvent?.({ kind: "region_resolved", ...info }),
  });
  const [url, ...mirrors] = orderByRegion(region, sources);
  const served = await downloadVerified(
    {
      ...options,
      url: url!,
      mirrors,
      ...(onDiagnostic ? { onDiagnostic } : {}),
    },
    fetcher,
    timing,
  );
  const servedRegion = sourceRegion(served);
  if (servedRegion !== region) {
    await recordRegionFallback(home, servedRegion);
    options.onEvent?.({
      kind: "region_fallback",
      fromRegion: region,
      toRegion: servedRegion,
      host: new URL(served).hostname,
    });
  }
  return served;
}
