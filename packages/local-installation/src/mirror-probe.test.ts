import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestUrlText } from "@linger/service-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  MIRROR_ECOSYSTEMS,
  networkFingerprint,
  parseEcosystemRecord,
  probeEcosystem,
  probeMirrorCandidates,
} from "./mirror-probe.js";
import {
  downloadInRegion,
  readRegionProfile,
  recordRegionFallback,
  REGION_SCHEMA,
  REGION_STALE_MS,
  regionFile,
  resolveRegion,
  type RegionRecord,
} from "./region.js";

const roots: string[] = [];

beforeEach(() => {
  vi.stubEnv("SIMPLEX_REGION", "");
  vi.stubEnv("HTTP_PROXY", "");
  vi.stubEnv("HTTPS_PROXY", "");
  vi.stubEnv("ALL_PROXY", "");
  vi.stubEnv("NO_PROXY", "");
  vi.stubEnv("http_proxy", "");
  vi.stubEnv("https_proxy", "");
  vi.stubEnv("all_proxy", "");
  vi.stubEnv("no_proxy", "");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function tempHome(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "linger-mirrors-"));
  roots.push(directory);
  return directory;
}

function delayedFetcher(
  bytesByHost: Record<string, { bytes: number; delayMs?: number } | null>,
): typeof fetch {
  const fetcher: typeof fetch = async (input) => {
    const host = new URL(requestUrlText(input)).host;
    const spec = bytesByHost[host];
    if (!spec) return new Response(null, { status: 503 });
    if (spec.delayMs)
      await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
    return new Response(new Uint8Array(spec.bytes), { status: 200 });
  };
  return vi.fn(fetcher);
}

it("covers all expected language and model ecosystems", () => {
  expect(Object.keys(MIRROR_ECOSYSTEMS).sort()).toEqual([
    "go",
    "homebrew",
    "model_hub",
    "node",
    "npm",
    "pypi",
    "rust",
  ]);
  const pypiHosts = MIRROR_ECOSYSTEMS.pypi.map((c) => new URL(c.baseUrl).host);
  expect(pypiHosts).toContain("pypi.org");
  expect(pypiHosts).toContain("pypi.tuna.tsinghua.edu.cn");
  expect(pypiHosts).toContain("mirrors.aliyun.com");
  expect(pypiHosts).toContain("pypi.mirrors.ustc.edu.cn");
  expect(pypiHosts).toContain("mirrors.cloud.tencent.com");
});

it("computes deterministic proxy fingerprints matching Python and Go without leaking URLs", () => {
  expect(networkFingerprint({})).toBe("direct");
  const expected =
    "proxy:" +
    createHash("sha256")
      .update("https_proxy=http://127.0.0.1:7890", "utf8")
      .digest("hex")
      .slice(0, 16);
  expect(networkFingerprint({ HTTPS_PROXY: "http://127.0.0.1:7890" })).toBe(
    expected,
  );
  expect(networkFingerprint({ https_proxy: "http://127.0.0.1:7890" })).toBe(
    expected,
  );
  expect(expected).not.toContain("7890");
});

it("ranks PyPI mirrors by real measured throughput and lets Tsinghua beat Aliyun and official PyPI", async () => {
  const fetcher = delayedFetcher({
    "pypi.org": { bytes: 4 * 1024, delayMs: 80 },
    "pypi.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 10 },
    "mirrors.aliyun.com": { bytes: 16 * 1024, delayMs: 40 },
    "pypi.mirrors.ustc.edu.cn": null,
    "mirrors.cloud.tencent.com": null,
  });
  const result = await probeEcosystem("pypi", { fetcher, timeoutMs: 2_000 });
  expect(result).toBeDefined();
  expect(result!.record.name).toBe("pypi-tsinghua");
  expect(result!.record.region).toBe("cn");
  expect(result!.record.url).toBe("https://pypi.tuna.tsinghua.edu.cn/simple/");
  expect(result!.record.candidates[0]).toBe(
    "https://pypi.tuna.tsinghua.edu.cn/simple/",
  );
  expect(result!.record.candidates[1]).toBe(
    "https://mirrors.aliyun.com/pypi/simple/",
  );
});

it("prevents Cloudflare Anycast npm wins from falsely locking a China host to global when PyPI strongly favors China", async () => {
  const directory = await tempHome();
  const fetcher = delayedFetcher({
    // npmjs responds faster than npmmirror (Anycast edge).
    "registry.npmjs.org": { bytes: 64 * 1024, delayMs: 5 },
    "cdn.npmmirror.com": { bytes: 16 * 1024, delayMs: 30 },
    // PyPI shows a decisive China advantage (Tsinghua >> official PyPI).
    "pypi.org": { bytes: 2 * 1024, delayMs: 60 },
    "pypi.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 5 },
    "mirrors.aliyun.com": { bytes: 16 * 1024, delayMs: 30 },
  });
  expect(await resolveRegion(directory, { fetcher })).toBe("cn");
  const saved = JSON.parse(
    await readFile(regionFile(directory), "utf8"),
  ) as RegionRecord;
  expect(saved.region).toBe("cn");
  expect(saved.network_fingerprint).toBe("direct");
  expect(saved.ecosystems?.pypi?.name).toBe("pypi-tsinghua");
  expect(saved.ecosystems?.npm?.region).toBe("global");
});

it("invalidates cached region.json immediately when proxy environment changes", async () => {
  const directory = await tempHome();
  await mkdir(path.dirname(regionFile(directory)), { recursive: true });
  await writeFile(
    regionFile(directory),
    JSON.stringify({
      schema: REGION_SCHEMA,
      region: "cn",
      resolved_at: new Date().toISOString(),
      method: "probe",
      network_fingerprint: "direct",
    }),
  );
  expect(await readRegionProfile(directory, {})).toBeDefined();
  expect(
    await readRegionProfile(directory, {
      HTTPS_PROXY: "http://127.0.0.1:7890",
    }),
  ).toBeUndefined();
});

it("probes all language and model ecosystems during resolveRegion and ranks downloads accordingly", async () => {
  const directory = await tempHome();
  const multiFetcher = delayedFetcher({
    "cdn.npmmirror.com": { bytes: 16 * 1024, delayMs: 35 },
    "registry.npmjs.org": { bytes: 4 * 1024, delayMs: 60 },
    "pypi.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 5 },
    "pypi.org": { bytes: 4 * 1024, delayMs: 60 },
    "nodejs.org": { bytes: 4 * 1024, delayMs: 60 },
    "mirrors.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 5 },
    "goproxy.io": { bytes: 16 * 1024, delayMs: 5 },
    "goproxy.cn": { bytes: 8 * 1024, delayMs: 40 },
    "mirrors.ustc.edu.cn": { bytes: 32 * 1024, delayMs: 25 },
    "hf-mirror.com": { bytes: 64 * 1024, delayMs: 5 },
    "huggingface.co": { bytes: 4 * 1024, delayMs: 60 },
  });
  expect(await resolveRegion(directory, { fetcher: multiFetcher })).toBe("cn");
  const saved = JSON.parse(
    await readFile(regionFile(directory), "utf8"),
  ) as RegionRecord;
  expect(saved.ecosystems?.npm?.region).toBe("cn");
  expect(saved.ecosystems?.pypi?.name).toBe("pypi-tsinghua");
  expect(saved.ecosystems?.node?.name).toBe("node-tsinghua");
  expect(saved.ecosystems?.go?.name).toBe("goproxy-io");
  expect(saved.ecosystems?.rust?.name).toBe("rust-tsinghua");
  expect(saved.ecosystems?.model_hub?.name).toBe("hf-mirror");
  if (process.platform === "darwin")
    expect(saved.ecosystems?.homebrew?.name).toBe("homebrew-tsinghua");

  // downloadInRegion picks Tsinghua ahead of npmmirror because resolveRegion ranked node.candidates #1.
  const payload = Buffer.from("node archive bytes");
  const digest = createHash("sha256").update(payload).digest("hex");
  const requestedHosts: string[] = [];
  const dlFetcher = (async (input: string | URL | Request) => {
    requestedHosts.push(new URL(requestUrlText(input)).host);
    return new Response(payload);
  }) as typeof fetch;

  const served = await downloadInRegion(
    directory,
    {
      url: "https://nodejs.org/dist/v26.5.0/node-v26.5.0-linux-x64.tar.gz",
      mirrors: [
        "https://cdn.npmmirror.com/binaries/node/v26.5.0/node-v26.5.0-linux-x64.tar.gz",
        "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v26.5.0/node-v26.5.0-linux-x64.tar.gz",
      ],
      output: path.join(directory, "node.tgz"),
      algorithm: "sha256",
      digest,
      maxBytes: payload.length,
      signal: new AbortController().signal,
    },
    dlFetcher,
    { attempts: 1, retryDelayMs: 0, idleTimeoutMs: 5_000 },
  );
  expect(served).toContain("mirrors.tuna.tsinghua.edu.cn");
  expect(requestedHosts).toEqual(["mirrors.tuna.tsinghua.edu.cn"]);
});

it("rejects untrusted URLs and symlinked region.json and normalizes mixed-case proxy keys", async () => {
  expect(
    parseEcosystemRecord(
      {
        region: "cn",
        name: "evil",
        url: "https://evil.attacker.example/simple/",
        bytes_per_second: 1_000_000,
        candidates: ["https://evil.attacker.example/simple/"],
        measured_at: new Date().toISOString(),
        method: "probe",
      },
      "pypi",
    ),
  ).toBeUndefined();

  expect(networkFingerprint({ Http_Proxy: "http://127.0.0.1:7890" })).toBe(
    networkFingerprint({ HTTP_PROXY: "http://127.0.0.1:7890" }),
  );

  // npm probe URLs target equal-sized package tarballs rather than asymmetric /-/ping.
  const npmProbePaths = MIRROR_ECOSYSTEMS.npm.map(
    (item) => new URL(item.probeUrl).pathname,
  );
  expect(npmProbePaths[0]).toBe(npmProbePaths[1]);
  expect(npmProbePaths[0]).not.toBe("/-/ping");

  // Symlinked region.json is ignored.
  const home = await tempHome();
  const realFile = path.join(home, "outside.json");
  await writeFile(
    realFile,
    JSON.stringify({
      schema: REGION_SCHEMA,
      region: "cn",
      resolved_at: new Date().toISOString(),
      method: "probe",
      network_fingerprint: "direct",
    }),
  );
  await mkdir(path.dirname(regionFile(home)), { recursive: true });
  await symlink(realFile, regionFile(home));
  expect(await readRegionProfile(home)).toBeUndefined();
});

it("invalidates resolveRegion cache on proxy change, TTL expiry, forced region, and offline recovery", async () => {
  const home = await tempHome();
  const cnFetcher = delayedFetcher({
    "cdn.npmmirror.com": { bytes: 64 * 1024, delayMs: 5 },
    "registry.npmjs.org": { bytes: 4 * 1024, delayMs: 25 },
    "pypi.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 5 },
    "pypi.org": { bytes: 4 * 1024, delayMs: 25 },
  });
  expect(await resolveRegion(home, { fetcher: cnFetcher })).toBe("cn");

  // Proxy change triggers re-probe instead of reusing stale in-process cache.
  vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:7890");
  const globalFetcher = delayedFetcher({
    "registry.npmjs.org": { bytes: 64 * 1024, delayMs: 5 },
    "cdn.npmmirror.com": { bytes: 4 * 1024, delayMs: 25 },
    "pypi.org": { bytes: 64 * 1024, delayMs: 5 },
    "pypi.tuna.tsinghua.edu.cn": { bytes: 4 * 1024, delayMs: 25 },
    "nodejs.org": { bytes: 64 * 1024, delayMs: 5 },
  });
  expect(await resolveRegion(home, { fetcher: globalFetcher })).toBe("global");

  // Offline run does not poison subsequent online resolution.
  vi.stubEnv("HTTPS_PROXY", "");
  const offlineHome = await tempHome();
  expect(
    await resolveRegion(offlineHome, { fetcher: delayedFetcher({}) }),
  ).toBe("global");
  expect(await resolveRegion(offlineHome, { fetcher: cnFetcher })).toBe("cn");

  // Aged region.json beyond 6h forces re-probe.
  const stalePath = regionFile(offlineHome);
  const aged = JSON.parse(await readFile(stalePath, "utf8")) as RegionRecord;
  aged.resolved_at = new Date(
    Date.now() - REGION_STALE_MS - 60_000,
  ).toISOString();
  await writeFile(stalePath, JSON.stringify(aged));
  expect(await resolveRegion(offlineHome, { fetcher: globalFetcher })).toBe(
    "global",
  );

  // Forced SIMPLEX_REGION overrides cached resolution and drops opposite-side ecosystems.
  vi.stubEnv("SIMPLEX_REGION", "cn");
  expect(await resolveRegion(offlineHome, { fetcher: globalFetcher })).toBe(
    "cn",
  );
  const switched = JSON.parse(
    await readFile(stalePath, "utf8"),
  ) as RegionRecord;
  expect(switched.ecosystems).toBeUndefined();

  // recordRegionFallback drops opposite-side ecosystems cleanly.
  vi.stubEnv("SIMPLEX_REGION", "");
  const fbHome = await tempHome();
  expect(await resolveRegion(fbHome, { fetcher: globalFetcher })).toBe(
    "global",
  );
  await recordRegionFallback(fbHome, "cn");
  const afterFb = JSON.parse(
    await readFile(regionFile(fbHome), "utf8"),
  ) as RegionRecord;
  expect(afterFb.region).toBe("cn");
  expect(afterFb.ecosystems).toBeUndefined();
});

it("handles single ranked winner, hanging fetchers, and PyPI-only fallback", async () => {
  const home = await tempHome();
  // resolveRegion saves single surviving China mirror for node and go alongside PyPI.
  const fetcher = delayedFetcher({
    "pypi.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 5 },
    "mirrors.tuna.tsinghua.edu.cn": { bytes: 64 * 1024, delayMs: 5 },
    "goproxy.cn": { bytes: 16 * 1024, delayMs: 20 },
  });
  expect(await resolveRegion(home, { fetcher })).toBe("cn");
  const saved = JSON.parse(
    await readFile(regionFile(home), "utf8"),
  ) as RegionRecord;
  expect(saved.ecosystems?.node?.candidates).toEqual([
    "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/",
  ]);
  expect(saved.ecosystems?.go?.url).toBe("https://goproxy.cn");

  // Single surviving node mirror (Tsinghua) is tried before dead npmmirror.
  const payload = Buffer.from("node archive");
  const digest = createHash("sha256").update(payload).digest("hex");
  const hosts: string[] = [];
  await downloadInRegion(
    home,
    {
      url: "https://nodejs.org/dist/v26.5.0/node.tar.gz",
      mirrors: [
        "https://cdn.npmmirror.com/binaries/node/v26.5.0/node.tar.gz",
        "https://mirrors.tuna.tsinghua.edu.cn/nodejs-release/v26.5.0/node.tar.gz",
      ],
      output: path.join(home, "node.tgz"),
      algorithm: "sha256",
      digest,
      maxBytes: payload.length,
      signal: new AbortController().signal,
    },
    async (input: string | URL | Request) => {
      const host = new URL(requestUrlText(input)).host;
      hosts.push(host);
      return new Response(payload);
    },
    { attempts: 1, retryDelayMs: 0, idleTimeoutMs: 5_000 },
  );
  expect(hosts).toEqual(["mirrors.tuna.tsinghua.edu.cn"]);

  // probeMirrorCandidates settles promptly even if fetcher ignores AbortSignal.
  const hangingFetcher: typeof fetch = () => new Promise<Response>(() => {});
  const started = Date.now();
  expect(
    await probeMirrorCandidates(MIRROR_ECOSYSTEMS.npm, {
      fetcher: hangingFetcher,
      timeoutMs: 40,
    }),
  ).toEqual([]);
  expect(Date.now() - started).toBeLessThan(1_000);

  // When npm is down, a modest PyPI China win still resolves to cn and persists.
  const pypiOnlyHome = await tempHome();
  const pypiOnlyFetcher = delayedFetcher({
    "pypi.tuna.tsinghua.edu.cn": { bytes: 25 * 1024, delayMs: 10 },
    "pypi.org": { bytes: 20 * 1024, delayMs: 10 },
  });
  expect(await resolveRegion(pypiOnlyHome, { fetcher: pypiOnlyFetcher })).toBe(
    "cn",
  );
  expect(await readRegionProfile(pypiOnlyHome)).toBeDefined();
});
