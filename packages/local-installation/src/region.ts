import { readFile } from "node:fs/promises";
import path from "node:path";
import { orderByRegion, sourceRegion, type Region } from "@linger/service-kit";
import { downloadVerified, type DownloadTiming } from "./download.js";
import { npmMirrorRegistry, probeNpmRegistries } from "./npm-registry.js";
import { atomicPrivate, privateDirectory } from "./private-files.js";

export type { Region };

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

/**
 * Returns the cached download region saved in `<home>/runtime/region.json`
 * without performing any network probe.
 */
export async function readCachedRegion(
  home: string,
): Promise<Region | undefined> {
  return (await readRecord(regionFile(home)))?.region;
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
  promise: Promise<Region>;
  controller: AbortController | undefined;
  waiters: number;
}
const resolutions = new Map<string, Resolution>();

async function resolve(
  file: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<Region> {
  const forced = forcedRegion();
  const saved = await readRecord(file);
  if (forced) {
    if (
      saved?.region !== forced ||
      saved.method !== "env" ||
      !fresh(saved, Date.now())
    )
      await save(file, forced, "env");
    return forced;
  }
  if (saved && fresh(saved, Date.now())) return saved.region;
  const [best] = await probeNpmRegistries(signal, fetcher);
  // Neither registry answered: global for now, probed again next run.
  if (!best || best.bytes <= 0) return "global";
  const region = best.registry === npmMirrorRegistry ? "cn" : "global";
  await save(file, region, "probe");
  return region;
}

/**
 * The download region of `home`: SIMPLEX_REGION when it names one, else a
 * region.json resolved within the last 24 hours, else the npm registry probe
 * (cn when the China mirror wins). Resolved once per process.
 */
export async function resolveRegion(
  home: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
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
      () => {
        resolution.controller = undefined;
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
    if (!signal) return await pending.promise;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([pending.promise, aborted]);
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
  const current = await resolutions.get(file)?.promise.catch(() => undefined);
  if (current === region) return;
  resolutions.set(file, {
    promise: Promise.resolve(region),
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
  options: Parameters<typeof downloadVerified>[0],
  fetcher: typeof fetch = fetch,
  timing?: DownloadTiming,
): Promise<string> {
  const sources = [options.url, ...(options.mirrors ?? [])];
  if (new Set(sources.map(sourceRegion)).size < 2)
    return downloadVerified(options, fetcher, timing);
  const region = await resolveRegion(home, {
    signal: options.signal,
    fetcher,
  });
  const [url, ...mirrors] = orderByRegion(region, sources);
  const served = await downloadVerified(
    { ...options, url: url!, mirrors },
    fetcher,
    timing,
  );
  const servedRegion = sourceRegion(served);
  if (servedRegion !== region) await recordRegionFallback(home, servedRegion);
  return served;
}
