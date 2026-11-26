import { createHash } from "node:crypto";
import type { MirrorEcosystem, Region } from "@linger/service-kit";

export interface MirrorCandidate {
  readonly name: string;
  readonly side: Region;
  readonly baseUrl: string;
  readonly probeUrl: string;
  readonly probeBytes: number;
}

export interface MeasuredCandidate {
  readonly candidate: MirrorCandidate;
  readonly bytesPerSecond: number;
  readonly bytesRead: number;
  readonly elapsedMs: number;
}

export interface EcosystemRecord {
  region: Region;
  name: string;
  url: string;
  bytes_per_second: number;
  candidates: string[];
  /** ISO 8601 UTC. */
  measured_at: string;
  method: "env" | "probe" | "fallback";
}

export interface EcosystemProbeResult {
  readonly record: EcosystemRecord;
  readonly bestGlobalBps: number;
  readonly bestCnBps: number;
}

const DEFAULT_PROBE_BYTES = 128 * 1024;
const DEFAULT_PROBE_TIMEOUT_MS = 4_000;
const PROXY_ENV_NAMES = new Set([
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);
const HOST_ALIASES: Readonly<Record<string, string>> = {
  "pypi.mirrors.ustc.edu.cn": "mirrors.ustc.edu.cn",
};

export const MIRROR_ECOSYSTEMS: Readonly<
  Record<MirrorEcosystem, readonly MirrorCandidate[]>
> = {
  pypi: [
    {
      name: "pypi-official",
      side: "global",
      baseUrl: "https://pypi.org/simple/",
      probeUrl: "https://pypi.org/simple/pip/",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "pypi-tsinghua",
      side: "cn",
      baseUrl: "https://pypi.tuna.tsinghua.edu.cn/simple/",
      probeUrl: "https://pypi.tuna.tsinghua.edu.cn/simple/pip/",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "pypi-aliyun",
      side: "cn",
      baseUrl: "https://mirrors.aliyun.com/pypi/simple/",
      probeUrl: "https://mirrors.aliyun.com/pypi/simple/pip/",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "pypi-ustc",
      side: "cn",
      baseUrl: "https://pypi.mirrors.ustc.edu.cn/simple/",
      probeUrl: "https://pypi.mirrors.ustc.edu.cn/simple/pip/",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "pypi-tencent",
      side: "cn",
      baseUrl: "https://mirrors.cloud.tencent.com/pypi/simple/",
      probeUrl: "https://mirrors.cloud.tencent.com/pypi/simple/pip/",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
  ],
  npm: [
    {
      name: "npm-official",
      side: "global",
      baseUrl: "https://registry.npmjs.org",
      probeUrl: "https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz",
      probeBytes: 64 * 1024,
    },
    {
      name: "npm-npmmirror",
      side: "cn",
      baseUrl: "https://registry.npmmirror.com",
      probeUrl: "https://registry.npmmirror.com/pnpm/-/pnpm-11.7.0.tgz",
      probeBytes: 64 * 1024,
    },
  ],
  node: [
    {
      name: "node-official",
      side: "global",
      baseUrl: "https://nodejs.org/dist/",
      probeUrl: "https://nodejs.org/dist/index.json",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "node-npmmirror",
      side: "cn",
      baseUrl: "https://cdn.npmmirror.com/binaries/node/",
      probeUrl: "https://cdn.npmmirror.com/binaries/node/index.json",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "node-tsinghua",
      side: "cn",
      baseUrl: "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/",
      probeUrl:
        "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/index.json",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
  ],
  model_hub: [
    {
      name: "huggingface",
      side: "global",
      baseUrl: "https://huggingface.co",
      probeUrl: "https://huggingface.co/api/models/Qwen/Qwen2.5-0.5B",
      probeBytes: 64 * 1024,
    },
    {
      name: "hf-mirror",
      side: "cn",
      baseUrl: "https://hf-mirror.com",
      probeUrl: "https://hf-mirror.com/api/models/Qwen/Qwen2.5-0.5B",
      probeBytes: 64 * 1024,
    },
    {
      name: "modelscope",
      side: "cn",
      baseUrl: "https://modelscope.cn",
      probeUrl: "https://modelscope.cn/api/v1/models/Qwen/Qwen2.5-0.5B",
      probeBytes: 64 * 1024,
    },
  ],
  go: [
    {
      name: "go-official",
      side: "global",
      baseUrl: "https://proxy.golang.org",
      probeUrl: "https://proxy.golang.org/golang.org/x/text/@v/list",
      probeBytes: 16 * 1024,
    },
    {
      name: "goproxy-cn",
      side: "cn",
      baseUrl: "https://goproxy.cn",
      probeUrl: "https://goproxy.cn/golang.org/x/text/@v/list",
      probeBytes: 16 * 1024,
    },
    {
      name: "goproxy-io",
      side: "cn",
      baseUrl: "https://goproxy.io",
      probeUrl: "https://goproxy.io/golang.org/x/text/@v/list",
      probeBytes: 16 * 1024,
    },
  ],
  rust: [
    {
      name: "rust-official",
      side: "global",
      baseUrl: "https://static.rust-lang.org",
      probeUrl: "https://static.rust-lang.org/dist/channel-rust-stable.toml",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "rust-tsinghua",
      side: "cn",
      baseUrl: "https://mirrors.tuna.tsinghua.edu.cn/rustup",
      probeUrl:
        "https://mirrors.tuna.tsinghua.edu.cn/rustup/dist/channel-rust-stable.toml",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "rust-ustc",
      side: "cn",
      baseUrl: "https://mirrors.ustc.edu.cn/rust-static",
      probeUrl:
        "https://mirrors.ustc.edu.cn/rust-static/dist/channel-rust-stable.toml",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
  ],
  homebrew: [
    {
      name: "homebrew-official",
      side: "global",
      baseUrl: "https://formulae.brew.sh/api",
      probeUrl: "https://formulae.brew.sh/api/formula.json",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "homebrew-tsinghua",
      side: "cn",
      baseUrl: "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api",
      probeUrl:
        "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api/formula.json",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
    {
      name: "homebrew-ustc",
      side: "cn",
      baseUrl: "https://mirrors.ustc.edu.cn/homebrew-bottles/api",
      probeUrl: "https://mirrors.ustc.edu.cn/homebrew-bottles/api/formula.json",
      probeBytes: DEFAULT_PROBE_BYTES,
    },
  ],
};

const allowedSet = (ecosystem: MirrorEcosystem): ReadonlySet<string> =>
  new Set(
    MIRROR_ECOSYSTEMS[ecosystem].map((item) =>
      item.baseUrl.replace(/\/$/u, ""),
    ),
  );

const ALLOWED_BY_ECOSYSTEM: Readonly<
  Record<MirrorEcosystem, ReadonlySet<string>>
> = {
  pypi: allowedSet("pypi"),
  npm: allowedSet("npm"),
  node: allowedSet("node"),
  model_hub: allowedSet("model_hub"),
  go: allowedSet("go"),
  rust: allowedSet("rust"),
  homebrew: allowedSet("homebrew"),
};

const ALLOWED_ALL_URLS: ReadonlySet<string> = new Set(
  Object.values(ALLOWED_BY_ECOSYSTEM).flatMap((set) => [...set]),
);

/** Normalizes mirror host aliases (such as USTC PyPI index vs packages hosts). */
export function canonicalMirrorHost(urlOrHost: string): string {
  let host = urlOrHost;
  if (urlOrHost.includes("://")) {
    try {
      host = new URL(urlOrHost).hostname;
    } catch {
      host = "";
    }
  }
  const low = host.toLowerCase();
  return HOST_ALIASES[low] ?? low;
}

/** True only for clean, credential-free HTTPS URLs in the built-in mirror catalog. */
export function isAllowedMirrorUrl(
  url: unknown,
  ecosystem?: MirrorEcosystem,
): url is string {
  if (typeof url !== "string" || !url || url !== url.trim()) return false;
  if (/[\s,|]/u.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    return false;
  const normalized = url.replace(/\/$/u, "");
  const allowed = ecosystem
    ? ALLOWED_BY_ECOSYSTEM[ecosystem]
    : ALLOWED_ALL_URLS;
  return allowed.has(normalized);
}

/**
 * Opaque SHA-256 fingerprint of active proxy environment variables, or
 * `direct` when none are set. Matches the Python and Go implementations so
 * every component shares one `region.json` without false invalidations and
 * never stores raw proxy URLs or credentials.
 */
export function networkFingerprint(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const entries = new Set<string>();
  for (const [key, value] of Object.entries(environment)) {
    const low = key.toLowerCase();
    if (!PROXY_ENV_NAMES.has(low)) continue;
    const raw = value?.trim();
    if (raw) entries.add(`${low}=${raw}`);
  }
  if (entries.size === 0) return "direct";
  const canonical = [...entries].sort().join("\n");
  const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
  return `proxy:${digest.slice(0, 16)}`;
}

/** Validates one ecosystem record decoded from `region.json`. */
export function parseEcosystemRecord(
  value: unknown,
  ecosystem?: MirrorEcosystem,
): EcosystemRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Partial<EcosystemRecord>;
  if (
    (raw.region !== "cn" && raw.region !== "global") ||
    typeof raw.name !== "string" ||
    !raw.name ||
    !isAllowedMirrorUrl(raw.url, ecosystem) ||
    typeof raw.bytes_per_second !== "number" ||
    !Number.isFinite(raw.bytes_per_second) ||
    raw.bytes_per_second < 0 ||
    !Array.isArray(raw.candidates) ||
    !raw.candidates.every((item) => isAllowedMirrorUrl(item, ecosystem)) ||
    typeof raw.measured_at !== "string" ||
    !raw.measured_at ||
    (raw.method !== "env" &&
      raw.method !== "probe" &&
      raw.method !== "fallback")
  )
    return undefined;
  return {
    region: raw.region,
    name: raw.name,
    url: raw.url,
    bytes_per_second: Math.floor(raw.bytes_per_second),
    candidates: [...raw.candidates],
    measured_at: raw.measured_at,
    method: raw.method,
  };
}

/** Concurrently measures bounded throughput for `candidates`, fastest first. */
export async function probeMirrorCandidates(
  candidates: readonly MirrorCandidate[],
  options: {
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<MeasuredCandidate[]> {
  if (candidates.length === 0) return [];
  const parentSignal = options.signal;
  parentSignal?.throwIfAborted();
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const closed = new Promise<never>((_resolve, reject) =>
    controller.signal.addEventListener("abort", () => reject(new Error()), {
      once: true,
    }),
  );
  closed.catch(() => {});

  try {
    const measured = await Promise.all(
      candidates.map(
        async (
          candidate,
          index,
        ): Promise<[MeasuredCandidate | undefined, number]> => {
          const startedAt = performance.now();
          let bytesRead = 0;
          try {
            const fetchPromise = Promise.resolve().then(() =>
              fetcher(candidate.probeUrl, {
                headers: {
                  range: `bytes=0-${Math.max(0, candidate.probeBytes - 1)}`,
                },
                signal: controller.signal,
              }),
            );
            fetchPromise.then(
              (late) => {
                if (controller.signal.aborted)
                  void late.body?.cancel().catch(() => {});
              },
              () => {},
            );
            const response = await Promise.race([fetchPromise, closed]);
            if (!response.ok || !response.body) {
              void response.body?.cancel().catch(() => {});
              return [undefined, index];
            }
            const reader = response.body.getReader();
            try {
              for (;;) {
                const { done, value } = await Promise.race([
                  reader.read(),
                  closed,
                ]);
                if (done) break;
                bytesRead = Math.min(
                  bytesRead + value.byteLength,
                  candidate.probeBytes,
                );
                if (bytesRead >= candidate.probeBytes) break;
              }
            } finally {
              void reader.cancel().catch(() => {});
            }
          } catch {
            // Keep bytes read before timeout; discard if nothing arrived.
          }
          if (bytesRead <= 0) return [undefined, index];
          const elapsedMs = Math.max(1, performance.now() - startedAt);
          return [
            {
              candidate,
              bytesRead,
              elapsedMs,
              bytesPerSecond: (bytesRead * 1000) / elapsedMs,
            },
            index,
          ];
        },
      ),
    );
    parentSignal?.throwIfAborted();
    return measured
      .filter(
        (entry): entry is [MeasuredCandidate, number] => entry[0] !== undefined,
      )
      .sort(
        ([left, leftIdx], [right, rightIdx]) =>
          right.bytesPerSecond - left.bytesPerSecond || leftIdx - rightIdx,
      )
      .map(([entry]) => entry);
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

/** Speed-probes one ecosystem and returns its winning record plus per-side peaks. */
export async function probeEcosystem(
  ecosystem: MirrorEcosystem,
  options: {
    side?: Region;
    signal?: AbortSignal;
    fetcher?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<EcosystemProbeResult | undefined> {
  const pool = options.side
    ? MIRROR_ECOSYSTEMS[ecosystem].filter((item) => item.side === options.side)
    : MIRROR_ECOSYSTEMS[ecosystem];
  const ranked = await probeMirrorCandidates(pool, options);
  const winner = ranked[0];
  if (!winner) return undefined;
  let bestGlobalBps = 0;
  let bestCnBps = 0;
  for (const entry of ranked) {
    if (entry.candidate.side === "cn")
      bestCnBps = Math.max(bestCnBps, entry.bytesPerSecond);
    else bestGlobalBps = Math.max(bestGlobalBps, entry.bytesPerSecond);
  }
  return {
    record: {
      region: winner.candidate.side,
      name: winner.candidate.name,
      url: winner.candidate.baseUrl,
      bytes_per_second: Math.floor(winner.bytesPerSecond),
      candidates: ranked.map((entry) => entry.candidate.baseUrl),
      measured_at: new Date().toISOString(),
      method: "probe",
    },
    bestGlobalBps,
    bestCnBps,
  };
}
