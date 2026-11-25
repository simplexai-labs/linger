export const npmRegistry = "https://registry.npmjs.org/";
export const npmMirrorRegistry = "https://registry.npmmirror.com/";

/** Where each registry serves a package tarball without a redirect. */
export function npmTarballUrl(registry: string, name: string, version: string) {
  return registry === npmMirrorRegistry
    ? `https://cdn.npmmirror.com/packages/${name}/${version}/${name}-${version}.tgz`
    : `${registry}${name}/-/${name}-${version}.tgz`;
}

/**
 * Package installs read the registry from this environment. The mirror also
 * serves the prebuilt native modules and Node headers that install scripts
 * would otherwise fetch from GitHub and nodejs.org.
 */
export function npmRegistryEnvironment(registry: string): NodeJS.ProcessEnv {
  return registry === npmMirrorRegistry
    ? {
        pnpm_config_registry: registry,
        npm_config_better_sqlite3_binary_host_mirror:
          "https://registry.npmmirror.com/-/binary/better-sqlite3",
        npm_config_disturl: "https://npmmirror.com/mirrors/node",
      }
    : { pnpm_config_registry: registry };
}

/** A registry the person configured is the only one used. */
export function configuredNpmRegistry() {
  return (
    process.env.pnpm_config_registry ||
    process.env.PNPM_CONFIG_REGISTRY ||
    process.env.npm_config_registry ||
    process.env.NPM_CONFIG_REGISTRY ||
    undefined
  );
}

export interface NpmRegistryProbe {
  registry: string;
  bytes: number;
  elapsedMs: number;
}

// 1 MiB measures real body throughput without waiting the full window on a fast
// host, and avoids tying when both registries finish the full 4.5 MiB tarball.
const PROBE_TARGET_BYTES = 1024 * 1024;
const DECISIVE_RATIO = 2;
const DECISIVE_LOW_RATE_RATIO = 4;
// 160 KiB/s (640 KiB in the 4 s default window) sits below the 256 KiB/s
// timeout ceiling (1 MiB / 4 s) while staying safely above cold-proxy trickles.
const DECISIVE_MIN_BYTES_PER_SECOND = 160 * 1024;
const MAX_PROBE_ROUNDS = 3;

function compareProbe(left: NpmRegistryProbe, right: NpmRegistryProbe): number {
  if (left.bytes > 0 !== right.bytes > 0) return left.bytes > 0 ? -1 : 1;
  if (left.bytes <= 0) return 0;
  return right.bytes - left.bytes || left.elapsedMs - right.elapsedMs;
}

function probeBytesPerSecond(probe: NpmRegistryProbe): number {
  if (probe.bytes <= 0) return 0;
  return (probe.bytes * 1000) / Math.max(probe.elapsedMs, 1);
}

function roundRatio(first: NpmRegistryProbe, second: NpmRegistryProbe): number {
  if (first.bytes <= 0) return 0;
  if (second.bytes <= 0) return Number.POSITIVE_INFINITY;
  return probeBytesPerSecond(first) / probeBytesPerSecond(second);
}

function decisiveFirstRound(
  first: NpmRegistryProbe,
  second: NpmRegistryProbe,
): boolean {
  const ratio = roundRatio(first, second);
  if (second.bytes <= 0) return ratio >= DECISIVE_RATIO;
  return (
    ratio >= DECISIVE_LOW_RATE_RATIO ||
    (ratio >= DECISIVE_RATIO &&
      probeBytesPerSecond(first) >= DECISIVE_MIN_BYTES_PER_SECOND)
  );
}

async function probeOnce(
  signal: AbortSignal,
  fetcher: typeof fetch,
  probeMs: number,
): Promise<{ results: NpmRegistryProbe[]; timedOut: boolean }> {
  signal.throwIfAborted();
  const registries = [npmRegistry, npmMirrorRegistry];
  const round = new AbortController();
  let timedOut = false;
  const onParentAbort = () => round.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    round.abort();
  }, probeMs);
  // A body that ignores the signal still stops counting when the round ends.
  const closed = new Promise<never>((_resolve, reject) =>
    round.signal.addEventListener("abort", () => reject(new Error()), {
      once: true,
    }),
  );
  closed.catch(() => {});
  const startedAt = performance.now();
  try {
    const measured = await Promise.all(
      registries.map(async (registry): Promise<NpmRegistryProbe> => {
        let bytes = 0;
        let elapsedMs = 0;
        try {
          const response = await fetcher(
            npmTarballUrl(registry, "pnpm", "11.7.0"),
            { redirect: "error", signal: round.signal },
          );
          if (!response.ok || !response.body) {
            elapsedMs = performance.now() - startedAt;
            await response.body?.cancel();
            return { registry, bytes: -1, elapsedMs };
          }
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await Promise.race([
                reader.read(),
                closed,
              ]);
              if (done) break;
              bytes = Math.min(bytes + value.byteLength, PROBE_TARGET_BYTES);
              if (bytes >= PROBE_TARGET_BYTES) {
                elapsedMs = performance.now() - startedAt;
                round.abort();
                break;
              }
            }
            if (!elapsedMs) elapsedMs = performance.now() - startedAt;
          } finally {
            await reader.cancel().catch(() => {});
          }
        } catch {
          // The round ending mid-body still measured progress.
          if (!elapsedMs) elapsedMs = performance.now() - startedAt;
        }
        return { registry, bytes, elapsedMs };
      }),
    );
    signal.throwIfAborted();
    return { results: measured.sort(compareProbe), timedOut };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }
}

/**
 * Races the public registry and its China mirror on the same tarball (up to
 * 1 MiB per round, fastest first; -1 when a registry refused). Confirms in a
 * best-of-three sequence unless neither answers or a full-window round already
 * shows a clear margin. region.ts decides the download region from it.
 */
export async function probeNpmRegistries(
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  probeMs = 4_000,
): Promise<NpmRegistryProbe[]> {
  const wins = new Map<string, number>();
  let lastAnswered: NpmRegistryProbe[] = [];
  for (let attempt = 0; attempt < MAX_PROBE_ROUNDS; attempt += 1) {
    const { results, timedOut } = await probeOnce(signal, fetcher, probeMs);
    const [first, second] = results;
    if (!first || first.bytes <= 0) {
      if (attempt === 0) return results;
      continue;
    }
    lastAnswered = results;
    wins.set(first.registry, (wins.get(first.registry) ?? 0) + 1);
    // A full-window probe short-circuits on a 4x margin, when the other host
    // sent nothing, or on a 2x margin at >= 160 KiB/s sustained throughput.
    // Slow cold-start trickles on both hosts still run confirmation rounds.
    if (
      attempt === 0 &&
      timedOut &&
      second &&
      decisiveFirstRound(first, second)
    )
      return results;
    if ((wins.get(first.registry) ?? 0) >= 2) return results;
  }
  return lastAnswered;
}
