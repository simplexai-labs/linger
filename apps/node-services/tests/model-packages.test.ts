import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { JsonLogger } from "@linger/service-kit/node";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { HttpHost } from "../src/http-host.js";

// A runtime's package directory, holding the models.json the build writes.
const runtime = vi.hoisted(() => ({ packageRoot: "" }));
vi.mock("../src/paths.js", async (actual) => {
  const paths = await actual<typeof import("../src/paths.js")>();
  return {
    ...paths,
    get packageRoot() {
      return runtime.packageRoot;
    },
  };
});

// An npm tarball of `files` inside its package/ folder.
function tarball(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(name, 0);
    header.write("0000644\0", 100);
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.fill(" ", 148, 156);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}

const integrity = (body: Buffer) =>
  `sha512-${createHash("sha512").update(body).digest("base64")}`;

const root = mkdtempSync(path.join(os.tmpdir(), "model-packages-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const turn = tarball({
  "package/package.json": '{"name":"@livekit/local-inference-darwin-arm64"}',
  "package/models/turn.onnx": "turn data",
});
const vad = tarball({ "package/index.node": "binding" });
let home: string;
let environment: NodeJS.ProcessEnv;

beforeEach(async () => {
  home = path.join(root, `home-${Math.random().toString(36).slice(2)}`);
  environment = { AGENT_HOME: home };
  runtime.packageRoot = path.join(home, "runtime");
  await mkdir(runtime.packageRoot, { recursive: true });
  writeFileSync(
    path.join(runtime.packageRoot, "models.json"),
    JSON.stringify({
      packages: {
        "@livekit/local-inference-darwin-arm64": {
          group: "voice",
          version: "0.2.7",
          integrity: integrity(turn),
          tarballs: [
            "https://registry.example/turn-0.2.7.tgz",
            "https://mirror.example/turn-0.2.7.tgz",
          ],
        },
        "@livekit/local-inference-linux-x64-gnu": {
          group: "voice",
          version: "0.2.7",
          integrity: integrity(vad),
          tarballs: ["https://registry.example/vad-0.2.7.tgz"],
        },
      },
    }),
  );
  vi.resetModules();
});

/** Marks both listed voice packages installed, as a finished download does. */
async function markVoiceInstalled(packagesRoot: string): Promise<void> {
  for (const [name, body] of [
    ["@livekit/local-inference-darwin-arm64", turn],
    ["@livekit/local-inference-linux-x64-gnu", vad],
  ] as const) {
    const directory = path.join(packagesRoot, name);
    await mkdir(directory, { recursive: true });
    writeFileSync(
      path.join(directory, ".simplex-model-package.json"),
      JSON.stringify({ integrity: integrity(body) }),
    );
  }
}

// The module reads models.json once, so every test loads it afresh.
const load = () => import("../src/model-packages.js");

describe("model packages", () => {
  it("lists packages by group and resolves them only once installed", async () => {
    const models = await load();
    expect(models.modelPackageNames("voice")).toEqual([
      "@livekit/local-inference-darwin-arm64",
      "@livekit/local-inference-linux-x64-gnu",
    ]);
    expect(models.modelPackageDirectory("officeparser", environment)).toBe(
      undefined,
    );
    expect(() =>
      models.modelPackageDirectory(
        "@livekit/local-inference-darwin-arm64",
        environment,
      ),
    ).toThrow(
      "Model package @livekit/local-inference-darwin-arm64 is not installed",
    );
  });

  it("downloads from the next registry when one serves another tarball", async () => {
    const models = await load();
    const fetch = vi.fn(async (url: string) =>
      url.startsWith("https://registry.")
        ? new Response(new Uint8Array(vad))
        : new Response(new Uint8Array(turn)),
    );
    await models.installModelPackages(
      ["@livekit/local-inference-darwin-arm64"],
      environment,
      {
        fetch: fetch as typeof globalThis.fetch,
      },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    const directory = models.modelPackageDirectory(
      "@livekit/local-inference-darwin-arm64",
      environment,
    )!;
    expect(directory).toBe(
      path.join(
        home,
        "models",
        "node_modules",
        "@livekit",
        "local-inference-darwin-arm64",
      ),
    );
    expect(readFileSync(path.join(directory, "models/turn.onnx"), "utf8")).toBe(
      "turn data",
    );
    expect(
      models.modelPackagesInstalled(
        ["@livekit/local-inference-darwin-arm64"],
        environment,
      ),
    ).toBe(true);
  });

  it("tries the registry of its download region first", async () => {
    writeFileSync(
      path.join(runtime.packageRoot, "models.json"),
      JSON.stringify({
        packages: {
          "@livekit/local-inference-darwin-arm64": {
            group: "voice",
            version: "0.2.7",
            integrity: integrity(turn),
            tarballs: [
              "https://registry.npmjs.org/turn-0.2.7.tgz",
              "https://registry.npmmirror.com/turn-0.2.7.tgz",
            ],
          },
        },
      }),
    );
    const models = await load();
    const fetch = vi.fn(
      async (_url: string) => new Response(new Uint8Array(turn)),
    );
    await models.installModelPackages(
      ["@livekit/local-inference-darwin-arm64"],
      environment,
      { fetch: fetch as typeof globalThis.fetch, region: "cn" },
    );
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.npmmirror.com/turn-0.2.7.tgz",
    ]);
  });

  it("shares one download between callers and waits a minute after a failure", async () => {
    const models = await load();
    let release!: () => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(new Response(new Uint8Array(turn)));
        }),
    );
    const options = { fetch: fetch as unknown as typeof globalThis.fetch };
    const first = models.installModelPackages(
      ["@livekit/local-inference-darwin-arm64"],
      environment,
      options,
    );
    const second = models.installModelPackages(
      ["@livekit/local-inference-darwin-arm64"],
      environment,
      options,
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();

    const offline = vi.fn(async () => {
      throw new Error("offline");
    });
    const voice = ["@livekit/local-inference-linux-x64-gnu"];
    const failing = {
      fetch: offline as unknown as typeof globalThis.fetch,
    };
    await expect(
      models.installModelPackages(voice, environment, failing),
    ).rejects.toThrow(
      "Could not download model package @livekit/local-inference-linux-x64-gnu (registry.example: offline)",
    );
    await expect(
      models.installModelPackages(voice, environment, failing),
    ).rejects.toThrow("Could not download");
    expect(offline).toHaveBeenCalledOnce();
    // Nothing is left behind for the next attempt to trip over.
    expect(
      existsSync(
        path.join(
          home,
          "models/node_modules/@livekit/local-inference-linux-x64-gnu",
        ),
      ),
    ).toBe(false);
    expect(models.modelPackagesInstalled(voice, environment)).toBe(false);
  });

  it("keeps a package's files inside its folder", async () => {
    const { unpackTarball } = await load();
    expect(unpackTarball(gunzipSync(turn)).map(([file]) => file)).toEqual([
      "package.json",
      "models/turn.onnx",
    ]);
    expect(() =>
      unpackTarball(gunzipSync(tarball({ "package/../escape": "x" }))),
    ).toThrow("Unsafe path in model package: package/../escape");
  });

  it("removes downloaded packages the runtime no longer lists", async () => {
    const models = await load();
    const packagesRoot = models.modelPackagesRoot(environment);
    for (const name of [
      "@tesseract.js-data/eng",
      "@livekit/local-inference-linux-x64-gnu",
      "@livekit/local-inference-darwin-arm64.partial-1",
      "retired-model",
    ])
      await mkdir(path.join(packagesRoot, name), { recursive: true });
    expect((await models.pruneModelPackages(environment)).sort()).toEqual([
      "@tesseract.js-data/eng",
      "retired-model",
    ]);
    expect(existsSync(path.join(packagesRoot, "@tesseract.js-data"))).toBe(
      false,
    );
    expect(
      existsSync(
        path.join(packagesRoot, "@livekit/local-inference-linux-x64-gnu"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          packagesRoot,
          "@livekit/local-inference-darwin-arm64.partial-1",
        ),
      ),
    ).toBe(true);
  });

  it("installs nothing when the runtime lists no packages", async () => {
    await rm(path.join(runtime.packageRoot, "models.json"));
    const models = await load();
    expect(models.modelPackageNames("voice")).toEqual([]);
    expect(models.modelPackagesInstalled([], environment)).toBe(true);
    await models.installModelPackages([], environment, {
      fetch: () => {
        throw new Error("no download");
      },
    });
  });
});

describe("features that need model packages", () => {
  it("start the Voice workers once the voice packages install, with them on NODE_PATH", async () => {
    const { startVoiceService } = await import("../src/voice/service.js");
    const models = await load();
    let installed!: () => void;
    const installModels = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          installed = () => {
            void markVoiceInstalled(models.modelPackagesRoot(environment)).then(
              resolve,
            );
          };
        }),
    );
    const spawnWorker = vi.fn(
      (_worker: string) =>
        Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
        }) as unknown as ChildProcess,
    );
    const service = await startVoiceService({
      logger: { log: vi.fn() } as unknown as JsonLogger,
      http: {
        mount: () => () => {},
        mountUpgrade: () => () => {},
      } as unknown as HttpHost,
      environment: {
        ...environment,
        LINGER_SECRET_SEED: "model-packages-test-seed-0123456789abcdef",
      },
      fetch: async () => Response.json({ xai_api_key: "test" }),
      spawnWorker,
      installModels,
    });
    await vi.waitFor(() => expect(installModels).toHaveBeenCalledOnce());
    // The Bridge loads no model and starts at once.
    expect(spawnWorker.mock.calls.map(([worker]) => worker)).not.toContain(
      "live",
    );
    installed();
    await vi.waitFor(() =>
      expect(spawnWorker).toHaveBeenCalledWith(
        "live",
        expect.objectContaining({
          env: expect.objectContaining({
            NODE_PATH: expect.stringContaining(
              models.modelPackagesRoot(environment),
            ),
          }),
        }),
      ),
    );
    const stopping = service.stop();
    for (const result of spawnWorker.mock.results)
      (result.value as EventEmitter).emit("exit", 0, null);
    await stopping;
  });

  it("download the voice packages at startup before any key exists", async () => {
    const { startVoiceService } = await import("../src/voice/service.js");
    const installModels = vi.fn(async () => undefined);
    const spawnWorker = vi.fn(
      (_worker: string) =>
        Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
        }) as unknown as ChildProcess,
    );
    const service = await startVoiceService({
      logger: { log: vi.fn() } as unknown as JsonLogger,
      http: {
        mount: () => () => {},
        mountUpgrade: () => () => {},
      } as unknown as HttpHost,
      environment: {
        ...environment,
        LINGER_SECRET_SEED: "model-packages-test-seed-0123456789abcdef",
      },
      fetch: async () => Response.json({}),
      spawnWorker,
      installModels,
    });
    await service.reconcile();
    expect(installModels).toHaveBeenCalledOnce();
    expect(spawnWorker.mock.calls.map(([worker]) => worker)).not.toContain(
      "live",
    );
    const stopping = service.stop();
    for (const result of spawnWorker.mock.results)
      (result.value as EventEmitter).emit("exit", 0, null);
    await stopping;
  });

  it("download the voice packages from the installer's region first", async () => {
    writeFileSync(
      path.join(runtime.packageRoot, "models.json"),
      JSON.stringify({
        packages: {
          "@livekit/local-inference-linux-x64-gnu": {
            group: "voice",
            version: "0.2.7",
            integrity: integrity(vad),
            tarballs: [
              "https://registry.npmjs.org/vad-0.2.7.tgz",
              "https://registry.npmmirror.com/vad-0.2.7.tgz",
            ],
          },
        },
      }),
    );
    const { startVoiceService } = await import("../src/voice/service.js");
    const download = vi.fn(
      async (_url: string) => new Response(new Uint8Array(vad)),
    );
    vi.stubGlobal("fetch", download);
    const spawnWorker = vi.fn(
      () =>
        Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
        }) as unknown as ChildProcess,
    );
    try {
      const service = await startVoiceService({
        logger: { log: vi.fn() } as unknown as JsonLogger,
        http: {
          mount: () => () => {},
          mountUpgrade: () => () => {},
        } as unknown as HttpHost,
        environment: {
          ...environment,
          SIMPLEX_REGION: "cn",
          LINGER_SECRET_SEED: "model-packages-test-seed-0123456789abcdef",
        },
        fetch: async () => Response.json({}),
        spawnWorker,
      });
      await vi.waitFor(() =>
        expect(download.mock.calls.map(([url]) => url)).toEqual([
          "https://registry.npmmirror.com/vad-0.2.7.tgz",
        ]),
      );
      const stopping = service.stop();
      for (const result of spawnWorker.mock.results)
        (result.value as EventEmitter).emit("exit", 0, null);
      await stopping;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("log a failed background download and retry it when a key arrives", async () => {
    const { startVoiceService } = await import("../src/voice/service.js");
    const models = await load();
    const installModels = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(() =>
        markVoiceInstalled(models.modelPackagesRoot(environment)),
      );
    const log = vi.fn();
    let keys: Record<string, string> = {};
    const spawnWorker = vi.fn(
      () =>
        Object.assign(new EventEmitter(), {
          kill: vi.fn(() => true),
        }) as unknown as ChildProcess,
    );
    const service = await startVoiceService({
      logger: { log } as unknown as JsonLogger,
      http: {
        mount: () => () => {},
        mountUpgrade: () => () => {},
      } as unknown as HttpHost,
      environment: {
        ...environment,
        LINGER_SECRET_SEED: "model-packages-test-seed-0123456789abcdef",
      },
      fetch: async () => Response.json(keys),
      spawnWorker,
      installModels,
    });
    await vi.waitFor(() =>
      expect(log).toHaveBeenCalledWith(
        "warn",
        "voice.model_install_failed",
        expect.anything(),
      ),
    );
    keys = { xai_api_key: "test" };
    await service.reconcile();
    await vi.waitFor(() =>
      expect(spawnWorker).toHaveBeenCalledWith("live", expect.anything()),
    );
    expect(installModels).toHaveBeenCalledTimes(2);
    const stopping = service.stop();
    for (const result of spawnWorker.mock.results)
      (result.value as EventEmitter).emit("exit", 0, null);
    await stopping;
  });
});
