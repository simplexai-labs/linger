import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import {
  orderByRegion,
  sourceRegion,
  type MirrorEcosystem,
  type Region,
} from "@linger/service-kit";
import { downloadVerified, type DownloadTiming } from "./download.js";
import {
  canonicalMirrorHost,
  MIRROR_ECOSYSTEMS,
  networkFingerprint,
  parseEcosystemRecord,
  probeEcosystem,
  type EcosystemRecord,
} from "./mirror-probe.js";
import {
  npmMirrorRegistry,
  npmRegistry,
  probeNpmRegistries,
} from "./npm-registry.js";
import { atomicPrivate, privateDirectory } from "./private-files.js";

export type { EcosystemRecord, MirrorEcosystem, Region };
export { MIRROR_ECOSYSTEMS, networkFingerprint, probeEcosystem };

// The record localmodels and the Computer Daemon share: see docs/network-download-optimization.md.
export const REGION_SCHEMA = "simplex.region/v1";
export const REGION_STALE_MS = 6 * 60 * 60_000;
const PYPI_DECISIVE_RATIO = 1.5;

export interface RegionRecord {
  schema: typeof REGION_SCHEMA;
  region: Region;
  /** ISO 8601 UTC. */
  resolved_at: string;
  method: "env" | "probe" | "fallback";
  network_fingerprint?: string;
  ecosystems?: Partial<Record<MirrorEcosystem, EcosystemRecord>>;
}

/** Where a home keeps its resolved download region and mirror profile. */
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

function parseEcosystems(
  value: unknown,
): Partial<Record<MirrorEcosystem, EcosystemRecord>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const found: Partial<Record<MirrorEcosystem, EcosystemRecord>> = {};
  for (const name of Object.keys(MIRROR_ECOSYSTEMS) as MirrorEcosystem[]) {
    const parsed = parseEcosystemRecord(
      (value as Record<string, unknown>)[name],
      name,
    );
    if (parsed) found[name] = parsed;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

const MAX_REGION_FILE_BYTES = 64 * 1024;

async function readRecord(file: string): Promise<RegionRecord | undefined> {
  let value: Partial<RegionRecord>;
  try {
    const info = await lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.size > MAX_REGION_FILE_BYTES
    )
      return undefined;
    value = JSON.parse(await readFile(file, "utf8")) as Partial<RegionRecord>;
  } catch {
    return undefined;
  }
  if (
    value?.schema !== REGION_SCHEMA ||
    (value.region !== "cn" && value.region !== "global") ||
    (value.method !== "env" &&
      value.method !== "probe" &&
      value.method !== "fallback") ||
    typeof value.resolved_at !== "string"
  )
    return undefined;
  const ecosystems = parseEcosystems(value.ecosystems);
  const fingerprint =
    typeof value.network_fingerprint === "string" &&
    value.network_fingerprint.length > 0
      ? value.network_fingerprint
      : undefined;
  return {
    schema: REGION_SCHEMA,
    region: value.region,
    resolved_at: value.resolved_at,
    method: value.method,
    ...(fingerprint ? { network_fingerprint: fingerprint } : {}),
    ...(ecosystems ? { ecosystems } : {}),
  };
}

function fresh(
  record: RegionRecord,
  now: number,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const age = now - Date.parse(record.resolved_at);
  if (!(age >= 0 && age <= REGION_STALE_MS)) return false;
  if (
    record.network_fingerprint &&
    record.network_fingerprint !== networkFingerprint(environment)
  )
    return false;
  return true;
}

/** Reads the home's fresh cached region profile without probing the network. */
export async function readRegionProfile(
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<RegionRecord | undefined> {
  const saved = await readRecord(regionFile(home));
  return saved && fresh(saved, Date.now(), environment) ? saved : undefined;
}

const saveQueues = new Map<string, Promise<void>>();

function serializeSave(file: string, fn: () => Promise<void>): Promise<void> {
  const previous = saveQueues.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const tracked = next.finally(() => {
    if (saveQueues.get(file) === tracked) saveQueues.delete(file);
  });
  saveQueues.set(file, tracked);
  return tracked;
}

// The record only saves a later probe; a home that cannot hold it still
// downloads.
async function save(
  file: string,
  region: Region,
  method: RegionRecord["method"],
  ecosystems?: Partial<Record<MirrorEcosystem, EcosystemRecord>>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  let wrote = false;
  await serializeSave(file, async () => {
    const merged: Partial<Record<MirrorEcosystem, EcosystemRecord>> = {};
    if (!ecosystems) {
      const existing = await readRecord(file);
      if (
        existing &&
        fresh(existing, Date.now(), environment) &&
        existing.ecosystems
      ) {
        for (const [key, rec] of Object.entries(existing.ecosystems) as [
          MirrorEcosystem,
          EcosystemRecord,
        ][]) {
          if (rec.region === region) merged[key] = rec;
        }
      }
    } else {
      Object.assign(merged, ecosystems);
    }
    const record: RegionRecord = {
      schema: REGION_SCHEMA,
      region,
      resolved_at: new Date().toISOString(),
      method,
      network_fingerprint: networkFingerprint(environment),
      ...(Object.keys(merged).length > 0 ? { ecosystems: merged } : {}),
    };
    try {
      await privateDirectory(path.dirname(file));
      await atomicPrivate(file, `${JSON.stringify(record)}\n`);
      wrote = true;
    } catch {
      // Best effort, as above.
    }
  });
  return wrote;
}

// One in-flight/cached resolution per home and process, invalidated when the
// proxy fingerprint, forced SIMPLEX_REGION, 6h TTL, or on-disk profile changes.
interface Resolution {
  promise: Promise<{ region: Region; answered: boolean; persisted: boolean }>;
  controller: AbortController | undefined;
  waiters: number;
  settledAt: number | undefined;
  answered: boolean;
  persisted: boolean;
  fingerprint: string;
  forced: Region | undefined;
}
const resolutions = new Map<string, Resolution>();

function decisiveEcosystemSide(
  result: Awaited<ReturnType<typeof probeEcosystem>>,
): Region | undefined {
  if (!result) return undefined;
  const { bestCnBps, bestGlobalBps, record } = result;
  if (bestCnBps > 0 && bestGlobalBps > 0) {
    const ratio =
      Math.max(bestCnBps, bestGlobalBps) / Math.min(bestCnBps, bestGlobalBps);
    if (ratio < PYPI_DECISIVE_RATIO) return undefined;
  }
  return record.region;
}

async function resolve(
  file: string,
  signal: AbortSignal,
  fetcher: typeof fetch,
): Promise<{ region: Region; answered: boolean; persisted: boolean }> {
  const forced = forcedRegion();
  const saved = await readRecord(file);
  if (forced) {
    let persisted = Boolean(saved && fresh(saved, Date.now()));
    if (
      saved?.region !== forced ||
      saved.method !== "env" ||
      !fresh(saved, Date.now())
    )
      persisted = await save(file, forced, "env");
    return { region: forced, answered: true, persisted };
  }
  if (saved && fresh(saved, Date.now()))
    return { region: saved.region, answered: true, persisted: true };
  const extraEcosystems: readonly MirrorEcosystem[] =
    process.platform === "darwin"
      ? ["node", "go", "rust", "model_hub", "homebrew"]
      : ["node", "go", "rust", "model_hub"];
  const [npmResults, pypiProbe, ...extraProbes] = await Promise.all([
    probeNpmRegistries(signal, fetcher),
    probeEcosystem("pypi", { signal, fetcher }),
    ...extraEcosystems.map((ecosystem) =>
      probeEcosystem(ecosystem, { signal, fetcher }),
    ),
  ]);
  const [npmBest] = npmResults;
  const npmSide: Region | undefined =
    npmBest && npmBest.bytes > 0
      ? npmBest.registry === npmMirrorRegistry
        ? "cn"
        : "global"
      : undefined;
  const pypiDecisive = decisiveEcosystemSide(pypiProbe);
  // Require a decisive ratio to override a conflicting npm result, but accept
  // any reachable PyPI probe when npm is unreachable.
  const pypiSide = npmSide ? pypiDecisive : pypiProbe?.record.region;

  // Neither primary probe answered: stay global without saving so the next run probes again.
  if (!npmSide && !pypiSide)
    return { region: "global", answered: false, persisted: false };

  // Heavy PyPI downloads show an order-of-magnitude gap between China and global;
  // when PyPI decisively favors China, prevent an Anycast npm edge from locking
  // the host to global.
  const region: Region =
    pypiSide === "cn" && npmSide === "global"
      ? "cn"
      : (npmSide ?? pypiSide ?? "global");

  const ecosystems: Partial<Record<MirrorEcosystem, EcosystemRecord>> = {};
  if (npmSide && npmBest) {
    const chosen = npmSide === "cn" ? npmMirrorRegistry : npmRegistry;
    const other = npmSide === "cn" ? npmRegistry : npmMirrorRegistry;
    ecosystems.npm = {
      region: npmSide,
      name: npmSide === "cn" ? "npm-npmmirror" : "npm-official",
      url: chosen.replace(/\/$/u, ""),
      bytes_per_second: Math.floor(
        (npmBest.bytes * 1000) / Math.max(1, npmBest.elapsedMs),
      ),
      candidates: [chosen.replace(/\/$/u, ""), other.replace(/\/$/u, "")],
      measured_at: new Date().toISOString(),
      method: "probe",
    };
  }
  if (pypiProbe) ecosystems.pypi = pypiProbe.record;
  for (let i = 0; i < extraEcosystems.length; i++) {
    const probeResult = extraProbes[i];
    if (probeResult) ecosystems[extraEcosystems[i]!] = probeResult.record;
  }

  const persisted = await save(file, region, "probe", ecosystems);
  return { region, answered: true, persisted };
}

/**
 * The download region of `home`: SIMPLEX_REGION when it names one, else a
 * region.json resolved within the last 6 hours with matching proxy state, else
 * a concurrent multi-ecosystem speed probe (cn when China mirrors win).
 */
export async function resolveRegion(
  home: string,
  options: { signal?: AbortSignal; fetcher?: typeof fetch } = {},
): Promise<Region> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const file = regionFile(home);
  const currentForced = forcedRegion();
  const currentFingerprint = networkFingerprint();
  let pending = resolutions.get(file);
  if (pending) {
    const stillValidContext =
      pending.forced === currentForced &&
      pending.fingerprint === currentFingerprint;
    if (!stillValidContext) {
      if (pending.controller === undefined) resolutions.delete(file);
      pending = undefined;
    } else if (pending.controller === undefined) {
      const expired =
        !pending.answered ||
        pending.settledAt === undefined ||
        Date.now() - pending.settledAt > REGION_STALE_MS;
      const diskInvalidated =
        !expired && pending.persisted && !(await readRegionProfile(home));
      if (expired || diskInvalidated) {
        if (resolutions.get(file) === pending) resolutions.delete(file);
        pending = undefined;
      }
    }
  }
  if (!pending) {
    const controller = new AbortController();
    const resolution: Resolution = {
      promise: resolve(file, controller.signal, options.fetcher ?? fetch),
      controller,
      waiters: 0,
      settledAt: undefined,
      answered: false,
      persisted: false,
      fingerprint: currentFingerprint,
      forced: currentForced,
    };
    resolutions.set(file, resolution);
    resolution.promise.then(
      (outcome) => {
        resolution.controller = undefined;
        resolution.settledAt = Date.now();
        resolution.answered = outcome.answered;
        resolution.persisted = outcome.persisted;
        if (!outcome.answered && resolutions.get(file) === resolution)
          resolutions.delete(file);
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
    const result = !signal
      ? await pending.promise
      : await Promise.race([
          pending.promise,
          new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(signal.reason);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        ]);
    return result.region;
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
  const persisted = await save(file, region, "fallback");
  resolutions.set(file, {
    promise: Promise.resolve({ region, answered: true, persisted }),
    controller: undefined,
    waiters: 0,
    settledAt: Date.now(),
    answered: true,
    persisted,
    fingerprint: networkFingerprint(),
    forced: undefined,
  });
}

function ecosystemForUrl(source: string): MirrorEcosystem | undefined {
  if (source.startsWith("https://nodejs.org/dist/")) return "node";
  if (source.startsWith("https://files.pythonhosted.org/packages/"))
    return "pypi";
  return undefined;
}

function orderWithEcosystemRanking(
  region: Region,
  sources: readonly string[],
  rankedCandidates: readonly string[] | undefined,
): string[] {
  const ordered = orderByRegion(region, sources);
  if (!rankedCandidates || rankedCandidates.length === 0) return ordered;
  const rankedHosts = rankedCandidates
    .map((candidate) => canonicalMirrorHost(candidate))
    .filter(Boolean);
  if (rankedHosts.length === 0) return ordered;
  const preferred = ordered.filter((item) => sourceRegion(item) === region);
  const rest = ordered.filter((item) => sourceRegion(item) !== region);
  preferred.sort((left, right) => {
    const leftRank = rankedHosts.indexOf(canonicalMirrorHost(left));
    const rightRank = rankedHosts.indexOf(canonicalMirrorHost(right));
    return (
      (leftRank === -1 ? rankedHosts.length : leftRank) -
      (rightRank === -1 ? rankedHosts.length : rightRank)
    );
  });
  return [...preferred, ...rest];
}

/**
 * downloadVerified with the sources in the home's region first (and any cached
 * per-ecosystem speed ranking applied within that region). Only a download
 * offered by both regions resolves the region, so one served from a single
 * region never probes. When the other region served it, that becomes the home's
 * region.
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
  const profile = await readRegionProfile(home);
  const ecosystem = ecosystemForUrl(options.url);
  const [url, ...mirrors] = orderWithEcosystemRanking(
    region,
    sources,
    ecosystem ? profile?.ecosystems?.[ecosystem]?.candidates : undefined,
  );
  const served = await downloadVerified(
    { ...options, url: url!, mirrors },
    fetcher,
    timing,
  );
  const servedRegion = sourceRegion(served);
  if (servedRegion !== region) await recordRegionFallback(home, servedRegion);
  return served;
}
