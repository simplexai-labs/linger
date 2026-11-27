import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestUrlText } from "@linger/service-kit";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cachedRegion,
  downloadInRegion,
  forcedRegion,
  formatRegionDownloadEvent,
  recordRegionFallback,
  REGION_SCHEMA,
  regionFile,
  resolveRegion,
  type RegionDownloadEvent,
  type RegionRecord,
  type RegionResolutionInfo,
} from "./region.js";

const roots: string[] = [];
beforeEach(() => vi.stubEnv("SIMPLEX_REGION", ""));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
// Each test has its own home, so the per-process resolution never carries over.
async function home() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "linger-region-"));
  roots.push(directory);
  return directory;
}
const read = async (directory: string) =>
  JSON.parse(await readFile(regionFile(directory), "utf8")) as RegionRecord;
async function saved(
  directory: string,
  record: Partial<RegionRecord> & Pick<RegionRecord, "region">,
) {
  await mkdir(path.dirname(regionFile(directory)), { recursive: true });
  await writeFile(
    regionFile(directory),
    JSON.stringify({
      schema: REGION_SCHEMA,
      resolved_at: new Date().toISOString(),
      method: "probe",
      ...record,
    }),
  );
}
// A probe where the China mirror delivers `mirror` bytes and npmjs `global`.
function probe(mirror: number, global: number) {
  return vi.fn(async (input: string | URL | Request) => {
    const host = new URL(requestUrlText(input)).host;
    const bytes = host === "cdn.npmmirror.com" ? mirror : global;
    return bytes < 0
      ? new Response(null, { status: 503 })
      : new Response(new Uint8Array(bytes));
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}
const hour = 60 * 60_000;

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("takes SIMPLEX_REGION over a saved region and records it", async () => {
  const directory = await home();
  await saved(directory, { region: "global" });
  vi.stubEnv("SIMPLEX_REGION", "cn");
  const fetcher = probe(10, 1);
  expect(await resolveRegion(directory, { fetcher })).toBe("cn");
  expect(fetcher).not.toHaveBeenCalled();
  expect(await read(directory)).toMatchObject({
    schema: "simplex.region/v1",
    region: "cn",
    method: "env",
  });
});

it("treats auto and unset as not forced and refuses anything else", () => {
  expect(forcedRegion({})).toBeUndefined();
  expect(forcedRegion({ SIMPLEX_REGION: "auto" })).toBeUndefined();
  expect(forcedRegion({ SIMPLEX_REGION: "global" })).toBe("global");
  expect(() => forcedRegion({ SIMPLEX_REGION: "china" })).toThrow(
    /auto, global or cn/,
  );
});

it("reuses a region saved within 24 hours without probing", async () => {
  const directory = await home();
  await saved(directory, {
    region: "cn",
    method: "fallback",
    resolved_at: new Date(Date.now() - 20 * hour).toISOString(),
  });
  const fetcher = probe(1, 10);
  expect(await resolveRegion(directory, { fetcher })).toBe("cn");
  expect(fetcher).not.toHaveBeenCalled();
});

it("probes again once the saved region is stale or unreadable", async () => {
  for (const contents of [
    {
      region: "global",
      resolved_at: new Date(Date.now() - 25 * hour).toISOString(),
    },
    { region: "mars" },
  ] as const) {
    const directory = await home();
    await saved(directory, contents as Pick<RegionRecord, "region">);
    const fetcher = probe(4096, 16);
    expect(await resolveRegion(directory, { fetcher })).toBe("cn");
    expect(fetcher).toHaveBeenCalled();
    const record = await read(directory);
    expect(record).toMatchObject({ region: "cn", method: "probe" });
    expect(Date.now() - Date.parse(record.resolved_at)).toBeLessThan(60_000);
  }
});

it("resolves once per process and home", async () => {
  const directory = await home();
  const fetcher = probe(16, 4096);
  const [first, second] = await Promise.all([
    resolveRegion(directory, { fetcher }),
    resolveRegion(directory, { fetcher }),
  ]);
  expect([first, second]).toEqual(["global", "global"]);
  const callsAfterFirstResolution = fetcher.mock.calls.length;
  expect(callsAfterFirstResolution).toBeGreaterThan(0);
  expect(await resolveRegion(directory, { fetcher })).toBe("global");
  expect(fetcher).toHaveBeenCalledTimes(callsAfterFirstResolution);
  expect(await read(directory)).toMatchObject({
    region: "global",
    method: "probe",
  });
});

it.each([0, 1])(
  "cancelling shared region caller %i does not cancel the other caller",
  async (cancelled) => {
    const directory = await home();
    const reference = probe(4096, 16);
    await resolveRegion(await home(), { fetcher: reference });
    const expectedRequests = reference.mock.calls.length;
    const controllers = [new AbortController(), new AbortController()];
    const started = gate();
    const release = gate();
    let requests = 0;
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (++requests === 2) started.resolve();
      await release.promise;
      return probe(4096, 16)(input);
    }) as unknown as typeof fetch;
    const pending = controllers.map((controller) =>
      resolveRegion(directory, { signal: controller.signal, fetcher }),
    );
    const settled = Promise.allSettled(pending);
    await started.promise;
    const reason = new Error("cancelled this setup only");
    controllers[cancelled]!.abort(reason);
    release.resolve();
    const results = await settled;
    expect(results[cancelled]).toEqual({ status: "rejected", reason });
    expect(results[1 - cancelled]).toEqual({
      status: "fulfilled",
      value: "cn",
    });
    expect(requests).toBe(expectedRequests);
    expect(await resolveRegion(directory, { fetcher })).toBe("cn");
    expect(requests).toBe(expectedRequests);
  },
);

it("refuses an aborted caller even when the region is already cached", async () => {
  const directory = await home();
  expect(await resolveRegion(directory, { fetcher: probe(10, 1) })).toBe("cn");
  const reason = new Error("cancelled before reading the cached region");
  await expect(
    resolveRegion(directory, { signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason);
});

it("stops an unneeded shared probe and lets the next caller try again", async () => {
  const directory = await home();
  const controllers = [new AbortController(), new AbortController()];
  const started = gate();
  const signals: AbortSignal[] = [];
  const fetcher = vi.fn(
    async (_input: string | URL | Request, init?: RequestInit) => {
      const signal = init!.signal!;
      signals.push(signal);
      if (signals.length === 2) started.resolve();
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
  ) as unknown as typeof fetch;
  const pending = controllers.map((controller) =>
    resolveRegion(directory, { signal: controller.signal, fetcher }),
  );
  const settled = Promise.allSettled(pending);
  await started.promise;
  controllers.forEach((controller) => controller.abort());
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true,
  );
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  const retry = probe(4096, 16);
  expect(await resolveRegion(directory, { fetcher: retry })).toBe("cn");
  expect(retry).toHaveBeenCalled();
});

it("stays global without saving when neither registry answers", async () => {
  const directory = await home();
  expect(await resolveRegion(directory, { fetcher: probe(-1, -1) })).toBe(
    "global",
  );
  await expect(readFile(regionFile(directory))).rejects.toThrow();
});

const body = Buffer.from("verified bytes");
const digest = createHash("sha256").update(body).digest("hex");
const timing = { attempts: 1, retryDelayMs: 0, idleTimeoutMs: 5_000 };
const sources = {
  url: "https://nodejs.org/dist/v1/node.tgz",
  mirrors: ["https://cdn.npmmirror.com/binaries/node/v1/node.tgz"],
};
// Serves the file except from `failing` hosts; records the hosts asked.
function server(failing: string[] = []) {
  const hosts: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const host = new URL(requestUrlText(input)).host;
    hosts.push(host);
    return failing.includes(host)
      ? new Response(null, { status: 404 })
      : new Response(body);
  }) as typeof fetch;
  return { hosts, fetcher };
}
const download = async (
  directory: string,
  fetcher: typeof fetch,
  options: { url: string; mirrors?: string[] } = sources,
) =>
  downloadInRegion(
    directory,
    {
      ...options,
      output: path.join(directory, `download-${Math.random()}`),
      algorithm: "sha256",
      digest,
      maxBytes: 1024,
      signal: new AbortController().signal,
    },
    fetcher,
    timing,
  );

it("tries the region's source first and keeps the others", async () => {
  for (const [region, first] of [
    ["cn", "cdn.npmmirror.com"],
    ["global", "nodejs.org"],
  ] as const) {
    const directory = await home();
    await saved(directory, { region });
    const { hosts, fetcher } = server();
    expect(await download(directory, fetcher)).toContain(first);
    expect(hosts).toEqual([first]);
  }
});

it("does not resolve a region for a download offered by one region only", async () => {
  const directory = await home();
  const { hosts, fetcher } = server();
  await download(directory, fetcher, {
    url: "https://cdn.example/a.tgz",
    mirrors: ["https://mirror.example/a.tgz"],
  });
  expect(hosts).toEqual(["cdn.example"]);
  await expect(readFile(regionFile(directory))).rejects.toThrow();
});

it("falls back to the other region and records it for later downloads", async () => {
  const directory = await home();
  await saved(directory, { region: "cn" });
  const first = server(["cdn.npmmirror.com"]);
  expect(await download(directory, first.fetcher)).toContain("nodejs.org");
  expect(first.hosts).toEqual(["cdn.npmmirror.com", "nodejs.org"]);
  expect(await read(directory)).toMatchObject({
    region: "global",
    method: "fallback",
  });
  // The same process now starts from the region that worked.
  const second = server();
  await download(directory, second.fetcher);
  expect(second.hosts).toEqual(["nodejs.org"]);
  expect(await resolveRegion(directory)).toBe("global");
});

it("keeps a forced region when a download falls back", async () => {
  const directory = await home();
  vi.stubEnv("SIMPLEX_REGION", "cn");
  const { fetcher } = server(["cdn.npmmirror.com"]);
  expect(await download(directory, fetcher)).toContain("nodejs.org");
  expect(await read(directory)).toMatchObject({ region: "cn", method: "env" });
  await recordRegionFallback(directory, "global");
  expect(await resolveRegion(directory)).toBe("cn");
});

it("switches to a faster mirror on a slow transfer and records the fallback region", async () => {
  const directory = await home();
  await saved(directory, { region: "global" });
  const payload = Buffer.alloc(64 * 1024, 0x62);
  const payloadDigest = createHash("sha256").update(payload).digest("hex");
  const hosts: string[] = [];
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(requestUrlText(input));
    hosts.push(url.host);
    const range = new Headers(init?.headers).get("range");
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
    const slice = payload.subarray(start);
    const headers: Record<string, string> = {
      "content-length": String(slice.length),
      ...(start > 0
        ? {
            "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
          }
        : {}),
    };
    if (url.host === "nodejs.org") {
      // Dribbles 2 KiB every 40 ms (~50 KB/s), far below the slow threshold.
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (let offset = 0; offset < slice.length; offset += 2048) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              try {
                controller.enqueue(slice.subarray(offset, offset + 2048));
              } catch {
                return;
              }
            }
            try {
              controller.close();
            } catch {
              // Cancelled when switching to the mirror.
            }
          },
        }),
        { status: start > 0 ? 206 : 200, headers },
      );
    }
    return new Response(slice, { status: start > 0 ? 206 : 200, headers });
  }) as typeof fetch;

  const served = await downloadInRegion(
    directory,
    {
      ...sources,
      output: path.join(directory, "node.tgz"),
      algorithm: "sha256",
      digest: payloadDigest,
      maxBytes: payload.length,
      signal: new AbortController().signal,
    },
    fetcher,
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 5_000,
      slowCheckAfterMs: 100,
      minBytesPerSecond: 200_000,
      minRemainingMs: 300,
    },
  );
  expect(served).toContain("cdn.npmmirror.com");
  expect(hosts).toEqual(["nodejs.org", "cdn.npmmirror.com"]);
  expect(await read(directory)).toMatchObject({
    region: "cn",
    method: "fallback",
  });
  expect(await resolveRegion(directory)).toBe("cn");
});

it("keeps the saved region when a slow primary is still faster than the mirror", async () => {
  const directory = await home();
  await saved(directory, { region: "cn" });
  const payload = Buffer.alloc(64 * 1024, 0x63);
  const payloadDigest = createHash("sha256").update(payload).digest("hex");
  const hosts: string[] = [];
  const throttled = (
    slice: Uint8Array,
    chunkBytes: number,
    intervalMs: number,
  ) =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        for (let offset = 0; offset < slice.length; offset += chunkBytes) {
          await new Promise((resolve) => setTimeout(resolve, intervalMs));
          try {
            controller.enqueue(slice.subarray(offset, offset + chunkBytes));
          } catch {
            return;
          }
        }
        try {
          controller.close();
        } catch {
          // Cancelled when comparing mirrors.
        }
      },
    });
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(requestUrlText(input));
    hosts.push(url.host);
    const range = new Headers(init?.headers).get("range");
    const start = range ? Number(/^bytes=(\d+)-$/.exec(range)?.[1] ?? 0) : 0;
    const slice = payload.subarray(start);
    const headers: Record<string, string> = {
      "content-length": String(slice.length),
      ...(start > 0
        ? {
            "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
          }
        : {}),
    };
    // Mirror (nodejs.org) is slightly slower than primary (cdn.npmmirror.com).
    const chunkBytes = url.host === "cdn.npmmirror.com" ? 4096 : 2048;
    return new Response(throttled(slice, chunkBytes, 30), {
      status: start > 0 ? 206 : 200,
      headers,
    });
  }) as typeof fetch;

  const served = await downloadInRegion(
    directory,
    {
      ...sources,
      output: path.join(directory, "node.tgz"),
      algorithm: "sha256",
      digest: payloadDigest,
      maxBytes: payload.length,
      signal: new AbortController().signal,
    },
    fetcher,
    {
      attempts: 2,
      retryDelayMs: 0,
      idleTimeoutMs: 5_000,
      slowCheckAfterMs: 100,
      minBytesPerSecond: 300_000,
      minRemainingMs: 250,
    },
  );
  expect(served).toContain("cdn.npmmirror.com");
  expect(hosts).toEqual([
    "cdn.npmmirror.com",
    "nodejs.org",
    "cdn.npmmirror.com",
  ]);
  expect(await read(directory)).toMatchObject({
    region: "cn",
    method: "probe",
  });
});

it("reports region resolution method, duration, and probe rates via onResolved", async () => {
  // env
  const envHome = await home();
  vi.stubEnv("SIMPLEX_REGION", "cn");
  let envInfo: RegionResolutionInfo | undefined;
  expect(
    await resolveRegion(envHome, {
      onResolved: (info) => {
        envInfo = info;
      },
    }),
  ).toBe("cn");
  expect(envInfo).toMatchObject({ region: "cn", method: "env" });
  expect(envInfo?.ms).toBeGreaterThanOrEqual(0);
  vi.stubEnv("SIMPLEX_REGION", "");

  // cache
  const cacheHome = await home();
  await saved(cacheHome, { region: "cn", method: "probe" });
  let cacheInfo: RegionResolutionInfo | undefined;
  expect(
    await resolveRegion(cacheHome, {
      onResolved: (info) => {
        cacheInfo = info;
      },
    }),
  ).toBe("cn");
  expect(cacheInfo).toMatchObject({ region: "cn", method: "cache" });

  // probe
  const probeHome = await home();
  let probeInfo: RegionResolutionInfo | undefined;
  expect(
    await resolveRegion(probeHome, {
      fetcher: probe(4096, 16),
      onResolved: (info) => {
        probeInfo = info;
      },
    }),
  ).toBe("cn");
  expect(probeInfo).toMatchObject({ region: "cn", method: "probe" });
  expect(probeInfo?.probes).toHaveLength(2);
  expect(probeInfo?.probes?.[0]).toMatchObject({
    host: "registry.npmmirror.com",
    bytes: 4096,
  });
  expect(probeInfo?.probes?.[0]?.bytesPerSecond).toBeGreaterThan(0);

  // fallback
  await recordRegionFallback(probeHome, "global");
  let fallbackInfo: RegionResolutionInfo | undefined;
  expect(
    await resolveRegion(probeHome, {
      onResolved: (info) => {
        fallbackInfo = info;
      },
    }),
  ).toBe("global");
  expect(fallbackInfo).toMatchObject({ region: "global", method: "fallback" });

  // default when neither registry answers
  const defaultHome = await home();
  let defaultInfo: RegionResolutionInfo | undefined;
  expect(
    await resolveRegion(defaultHome, {
      fetcher: probe(-1, -1),
      onResolved: (info) => {
        defaultInfo = info;
      },
    }),
  ).toBe("global");
  expect(defaultInfo).toMatchObject({ region: "global", method: "default" });
  expect(defaultInfo?.probes).toHaveLength(2);
});

it("emits region resolution, mirror switch, and region fallback events from downloadInRegion", async () => {
  const directory = await home();
  await saved(directory, { region: "cn" });
  const events: RegionDownloadEvent[] = [];
  const { fetcher } = server(["cdn.npmmirror.com"]);
  await downloadInRegion(
    directory,
    {
      ...sources,
      output: path.join(directory, "node.tgz"),
      algorithm: "sha256",
      digest,
      maxBytes: 1024,
      signal: new AbortController().signal,
      onEvent: (event) => events.push(event),
    },
    fetcher,
    timing,
  );
  expect(events.map((event) => event.kind)).toEqual([
    "region_resolved",
    "host_switch",
    "region_fallback",
  ]);
  expect(events[0]).toMatchObject({
    kind: "region_resolved",
    region: "cn",
    method: "cache",
  });
  expect(events[1]).toEqual({
    kind: "host_switch",
    fromHost: "cdn.npmmirror.com",
    toHost: "nodejs.org",
    reason: "HTTP 404",
    completed: 0,
  });
  expect(events[2]).toEqual({
    kind: "region_fallback",
    fromRegion: "cn",
    toRegion: "global",
    host: "nodejs.org",
  });
  expect(events.map(formatRegionDownloadEvent)).toEqual([
    expect.stringMatching(/^Download region: cn \(cache, \d+ms\)\.$/),
    "Download failed on cdn.npmmirror.com (HTTP 404); switching to nodejs.org.",
    "Download region fallback: cn -> global (nodejs.org).",
  ]);
});

it("cachedRegion returns undefined on a cold home without probing or poisoning resolveRegion", async () => {
  const directory = await home();
  const fetcher = probe(4096, 16);
  vi.stubGlobal("fetch", fetcher);
  const onResolved = vi.fn();
  try {
    expect(await cachedRegion(directory, { onResolved })).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
    await expect(readFile(regionFile(directory))).rejects.toThrow();

    // A later resolveRegion still probes normally because cachedRegion added no entry.
    expect(await resolveRegion(directory, { fetcher })).toBe("cn");
    expect(fetcher).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});

it("cachedRegion returns forced SIMPLEX_REGION, persists it, and validates invalid values", async () => {
  const directory = await home();
  await saved(directory, { region: "global", method: "probe" });
  vi.stubEnv("SIMPLEX_REGION", "cn");
  let info: RegionResolutionInfo | undefined;
  expect(
    await cachedRegion(directory, {
      onResolved: (value) => {
        info = value;
      },
    }),
  ).toBe("cn");
  expect(info).toMatchObject({ region: "cn", method: "env" });
  expect(info?.ms).toBeGreaterThanOrEqual(0);
  expect(await read(directory)).toMatchObject({ region: "cn", method: "env" });

  vi.stubEnv("SIMPLEX_REGION", "mars");
  await expect(cachedRegion(directory)).rejects.toThrow(/auto, global or cn/);
});

it("cachedRegion returns a settled in-process resolution or fallback without touching disk", async () => {
  const directory = await home();
  expect(await resolveRegion(directory, { fetcher: probe(4096, 16) })).toBe(
    "cn",
  );
  await rm(regionFile(directory));
  let settledInfo: RegionResolutionInfo | undefined;
  expect(
    await cachedRegion(directory, {
      onResolved: (value) => {
        settledInfo = value;
      },
    }),
  ).toBe("cn");
  expect(settledInfo).toMatchObject({ region: "cn", method: "probe" });

  await recordRegionFallback(directory, "global");
  let fallbackInfo: RegionResolutionInfo | undefined;
  expect(
    await cachedRegion(directory, {
      onResolved: (value) => {
        fallbackInfo = value;
      },
    }),
  ).toBe("global");
  expect(fallbackInfo).toMatchObject({ region: "global", method: "fallback" });
});

it("cachedRegion returns undefined immediately while a resolveRegion probe is still in flight", async () => {
  const directory = await home();
  const started = gate();
  const release = gate();
  let requests = 0;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    if (++requests === 2) started.resolve();
    await release.promise;
    return probe(4096, 16)(input);
  }) as unknown as typeof fetch;
  const pending = resolveRegion(directory, { fetcher });
  await started.promise;

  // Does not block or disturb the in-flight probe.
  expect(await cachedRegion(directory)).toBeUndefined();

  release.resolve();
  expect(await pending).toBe("cn");
  expect(await cachedRegion(directory)).toBe("cn");
});

it("cachedRegion returns fresh disk cache and returns undefined for stale or invalid records", async () => {
  const freshHome = await home();
  await saved(freshHome, {
    region: "cn",
    resolved_at: new Date(Date.now() - 2 * hour).toISOString(),
  });
  let cacheInfo: RegionResolutionInfo | undefined;
  expect(
    await cachedRegion(freshHome, {
      onResolved: (value) => {
        cacheInfo = value;
      },
    }),
  ).toBe("cn");
  expect(cacheInfo).toMatchObject({ region: "cn", method: "cache" });

  for (const record of [
    {
      region: "cn",
      resolved_at: new Date(Date.now() - 25 * hour).toISOString(),
    },
    { region: "mars" },
  ]) {
    const staleHome = await home();
    await saved(staleHome, record as Pick<RegionRecord, "region">);
    expect(await cachedRegion(staleHome)).toBeUndefined();
  }
});

it("cachedRegion refuses an aborted caller even when cached or forced", async () => {
  const directory = await home();
  await saved(directory, { region: "cn" });
  const reason = new Error("cancelled before cachedRegion");
  await expect(
    cachedRegion(directory, { signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason);

  vi.stubEnv("SIMPLEX_REGION", "cn");
  await expect(
    cachedRegion(directory, { signal: AbortSignal.abort(reason) }),
  ).rejects.toBe(reason);
});
