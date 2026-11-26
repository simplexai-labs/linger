import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import {
  configuredNpmRegistry,
  npmRegistryEnvironment,
  npmTarballUrl,
  probeNpmRegistries,
} from "./npm-registry.js";

afterEach(() => vi.unstubAllEnvs());

const slow = (bytes: number) =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
      },
    }),
  );

const timed = (totalBytes: number, durationMs: number, chunks = 4) =>
  new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const chunkSize = Math.ceil(totalBytes / chunks);
        let sent = 0;
        const stepMs = durationMs / chunks;
        for (let i = 0; i < chunks && sent < totalBytes; i += 1) {
          await delay(stepMs);
          const size = Math.min(chunkSize, totalBytes - sent);
          sent += size;
          try {
            controller.enqueue(new Uint8Array(size));
          } catch {
            return;
          }
        }
        try {
          controller.close();
        } catch {
          // Reader already cancelled when the round ended early.
        }
      },
    }),
  );

it("puts the registry that delivers more of the probe first", async () => {
  const requested: string[] = [];
  const order = await probeNpmRegistries(
    new AbortController().signal,
    async (url, init) => {
      requested.push((url as URL | string).toString());
      expect(init?.redirect).toBe("error");
      return (url as URL | string).toString().includes("npmmirror")
        ? slow(4096)
        : slow(16);
    },
    50,
  );
  expect(order).toMatchObject([
    { registry: "https://registry.npmmirror.com/", bytes: 4096 },
    { registry: "https://registry.npmjs.org/", bytes: 16 },
  ]);
  expect(requested.sort()).toEqual([
    "https://cdn.npmmirror.com/packages/pnpm/11.7.0/pnpm-11.7.0.tgz",
    "https://registry.npmjs.org/pnpm/-/pnpm-11.7.0.tgz",
  ]);
});

it("prefers the faster registry when both finish the full tarball within the probe window", async () => {
  const order = await probeNpmRegistries(
    new AbortController().signal,
    async (url) =>
      (url as URL | string).toString().includes("npmmirror")
        ? timed(32 * 1024, 15)
        : timed(32 * 1024, 140),
    400,
  );
  expect(order[0]?.registry).toBe("https://registry.npmmirror.com/");
  expect(order[1]?.registry).toBe("https://registry.npmjs.org/");
});

it("stops a probe round early once one registry delivers the probe target", async () => {
  const target = 1024 * 1024;
  const startedAt = Date.now();
  const order = await probeNpmRegistries(
    new AbortController().signal,
    async (url) => {
      if ((url as URL | string).toString().includes("npmmirror"))
        return new Response(new Uint8Array(target * 2));
      return new Response(
        new ReadableStream({ pull: () => new Promise(() => {}) }),
      );
    },
    4_000,
  );
  expect(order[0]?.registry).toBe("https://registry.npmmirror.com/");
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

it("recovers from a single-round hiccup through best-of-three confirmation", async () => {
  let mirrorCalls = 0;
  const order = await probeNpmRegistries(
    new AbortController().signal,
    async (url) => {
      if ((url as URL | string).toString().includes("npmmirror")) {
        mirrorCalls += 1;
        return mirrorCalls === 1 ? timed(32 * 1024, 160) : timed(32 * 1024, 15);
      }
      return timed(32 * 1024, 90);
    },
    400,
  );
  expect(mirrorCalls).toBe(3);
  expect(order[0]?.registry).toBe("https://registry.npmmirror.com/");
});

it("confirms across rounds when a slow cold-start first round has only a modest lead under the default 4s window", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    let npmCalls = 0;
    let mirrorCalls = 0;
    const probe = probeNpmRegistries(
      new AbortController().signal,
      async (url) => {
        if ((url as URL | string).toString().includes("npmmirror")) {
          mirrorCalls += 1;
          // ~110 KiB/s across the default 4_000 ms window (below 160 KiB/s).
          return slow(440 * 1024);
        }
        npmCalls += 1;
        // Cold-start round 0 gets ~50 KiB/s (ratio 2.2, below 4x and 160 KiB/s);
        // warmed rounds deliver the full 1 MiB target immediately.
        return npmCalls === 1
          ? slow(200 * 1024)
          : new Response(new Uint8Array(1024 * 1024));
      },
    );
    await vi.advanceTimersByTimeAsync(4_000);
    const order = await probe;
    expect(npmCalls).toBe(3);
    expect(mirrorCalls).toBe(3);
    expect(order[0]?.registry).toBe("https://registry.npmjs.org/");
  } finally {
    vi.useRealTimers();
  }
});

it("short-circuits in round 0 under the default 4s window on a sustained >= 160 KiB/s 2x lead", async () => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  try {
    let npmCalls = 0;
    let mirrorCalls = 0;
    const probe = probeNpmRegistries(
      new AbortController().signal,
      async (url) => {
        if ((url as URL | string).toString().includes("npmmirror")) {
          mirrorCalls += 1;
          // 80 KiB/s across the 4_000 ms window.
          return slow(320 * 1024);
        }
        npmCalls += 1;
        // 200 KiB/s across the 4_000 ms window (ratio 2.5 >= 2 and >= 160 KiB/s).
        return slow(800 * 1024);
      },
    );
    await vi.advanceTimersByTimeAsync(4_000);
    const order = await probe;
    expect(npmCalls).toBe(1);
    expect(mirrorCalls).toBe(1);
    expect(order[0]?.registry).toBe("https://registry.npmjs.org/");
  } finally {
    vi.useRealTimers();
  }
});

it("measures nothing when neither registry answers", async () => {
  expect(
    await probeNpmRegistries(
      new AbortController().signal,
      async () => {
        throw new TypeError("fetch failed");
      },
      50,
    ),
  ).toMatchObject([
    { registry: "https://registry.npmjs.org/", bytes: 0 },
    { registry: "https://registry.npmmirror.com/", bytes: 0 },
  ]);
});

it("respects a configured registry and points native downloads at the mirror", () => {
  for (const name of [
    "pnpm_config_registry",
    "PNPM_CONFIG_REGISTRY",
    "npm_config_registry",
    "NPM_CONFIG_REGISTRY",
  ])
    vi.stubEnv(name, "");
  expect(configuredNpmRegistry()).toBeUndefined();
  vi.stubEnv("npm_config_registry", "https://r.test/");
  expect(configuredNpmRegistry()).toBe("https://r.test/");
  expect(npmTarballUrl("https://registry.npmjs.org/", "npm", "1.0.0")).toBe(
    "https://registry.npmjs.org/npm/-/npm-1.0.0.tgz",
  );
  expect(npmRegistryEnvironment("https://registry.npmjs.org/")).toEqual({
    pnpm_config_registry: "https://registry.npmjs.org/",
  });
  expect(
    npmRegistryEnvironment("https://registry.npmmirror.com/"),
  ).toMatchObject({
    pnpm_config_registry: "https://registry.npmmirror.com/",
    npm_config_better_sqlite3_binary_host_mirror:
      "https://registry.npmmirror.com/-/binary/better-sqlite3",
  });
});
