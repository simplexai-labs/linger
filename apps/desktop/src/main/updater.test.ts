import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { DesktopConfig } from "./config.js";
import { stubModule, tempDirectory, testHost } from "./test-support.js";
import {
  type SpawnSetup,
  type UpdateState,
  type UpdaterOptions,
  UpdaterModule,
  appBundleOf,
  updateInstallFor,
} from "./updater.js";

const RELEASES = "https://github.com/simplexai-labs/linger/releases";
const PACKAGE = Buffer.from("new app archive");

vi.mock("node:fs/promises", { spy: true });

// Capture unfaked setTimeout so deferred-cleanup helpers wait real wall-clock
// time while tests fake setTimeout and clearTimeout.
const realSetTimeout = globalThis.setTimeout;

const release = (
  version: string,
  {
    body = PACKAGE,
    target = "darwin-arm64",
    file = `Linger-${version}-macos-arm64.app.tar.gz`,
    feed = RELEASES,
  } = {},
) => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest = Buffer.from(
    JSON.stringify({
      schema: 2,
      version,
      packages: {
        [target]: {
          file,
          sha256: createHash("sha256").update(PACKAGE).digest("hex"),
          size: PACKAGE.length,
        },
      },
    }),
  );
  const files: Record<string, Buffer> = {
    [`${feed}/latest/download/manifest.json`]: manifest,
    [`${feed}/latest/download/manifest.json.sig`]: Buffer.from(
      sign(null, manifest, privateKey).toString("base64"),
    ),
    [`${feed}/download/desktop-v${version}/${file}`]: body,
  };
  const requested: string[] = [];
  const fetch = (async (url: URL) => {
    requested.push(url.toString());
    const content = files[url.toString()];
    return content
      ? new Response(new Uint8Array(content))
      : new Response("missing", { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  return {
    fetch,
    files,
    requested,
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

const setup = async (
  feed: ReturnType<typeof release>,
  options: Partial<UpdaterOptions> = {},
  config: Partial<DesktopConfig> = {},
) => {
  const root = tempDirectory();
  const applications = path.join(root, "Applications");
  const bundle = path.join(applications, "Linger.app");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(path.join(bundle, "version"), "0.16.7");
  const downloads = path.join(root, "updates");
  let running = 0;
  let restarts = 0;
  let quits = 0;
  const opened: string[] = [];
  const announced: UpdateState[] = [];
  const runtime = {
    ...stubModule("ComputerDaemon"),
    running: () => running,
  } as unknown as ComputerDaemonModule;
  const updater = new UpdaterModule({
    version: "0.16.7",
    platform: "darwin",
    arch: "arm64",
    install: { kind: "app-bundle", appBundle: bundle },
    downloadDirectory: downloads,
    restart: async () => {
      restarts += 1;
    },
    quit: async () => {
      quits += 1;
    },
    openExternal: async (url) => {
      opened.push(url);
    },
    announce: (state) => announced.push(state),
    fetch: feed.fetch,
    publicKey: feed.publicKey,
    checkDelayMs: 60 * 60_000,
    // The test archive holds the new version marker, not a real tarball.
    extract: async (archive, directory) => {
      const app = path.join(directory, "Linger.app");
      mkdirSync(app);
      writeFileSync(path.join(app, "version"), readFileSync(archive));
    },
    ...options,
  });
  const host = testHost([stubModule("Config"), runtime, updater], config);
  await host.start();
  const setRunning = (n: number) => {
    running = n;
    host.ctx.bus.emit("runtime.activity", n);
  };
  return {
    host,
    updater,
    bundle,
    applications,
    downloads,
    setRunning,
    opened,
    announced,
    restarts: () => restarts,
    quits: () => quits,
  };
};

describe("UpdaterModule", () => {
  it("installs a verified update from the latest release once running tasks finish", async () => {
    const feed = release("0.17.0");
    const {
      updater,
      bundle,
      applications,
      setRunning,
      restarts,
      host,
      announced,
    } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(feed.requested).toEqual([
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      // From the release the signed manifest names, not whatever is latest
      // by the time of the download.
      `${RELEASES}/download/desktop-v0.17.0/Linger-0.17.0-macos-arm64.app.tar.gz`,
    ]);
    expect(announced).toEqual([{ kind: "ready", version: "0.17.0" }]);
    expect(readFileSync(path.join(bundle, "version"), "utf8")).toBe("0.16.7");

    setRunning(1);
    await updater.install();
    expect(updater.state()).toEqual({ kind: "waiting", version: "0.17.0" });
    expect(restarts()).toBe(0);

    setRunning(0);
    await waitFor(() => restarts() === 1);
    expect(readFileSync(path.join(bundle, "version"), "utf8")).toBe(
      PACKAGE.toString(),
    );
    // The replaced bundle stays until the next launch cleans it up.
    expect(readdirSync(applications).sort()).toEqual([
      expect.stringMatching(/^\.Linger-old-/),
      "Linger.app",
    ]);
    await host.stop("update");
    const next = new UpdaterModule({
      version: "0.17.0",
      platform: "darwin",
      arch: "arm64",
      install: { kind: "app-bundle", appBundle: bundle },
      downloadDirectory: tempDirectory(),
      restart: async () => {},
      quit: async () => {},
      openExternal: async () => {},
      checkDelayMs: 60 * 60_000,
      cleanupDelayMs: 0,
    });
    const nextHost = testHost([
      stubModule("Config"),
      stubModule("ComputerDaemon"),
      next,
    ]);
    await nextHost.start();
    await waitFor(() => readdirSync(applications).length === 1);
    expect(readdirSync(applications)).toEqual(["Linger.app"]);
    await nextHost.stop("quit");
  });

  it("refuses a manifest signed by another key", async () => {
    const feed = {
      ...release("0.17.0"),
      publicKey: release("0.17.0").publicKey,
    };
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update signature does not match",
    });
    expect(feed.requested).toHaveLength(2);
  });

  it("refuses a package that does not match its checksum", async () => {
    const feed = release("0.17.0", { body: Buffer.from("new app archivX") });
    const { updater, downloads, applications } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update package does not match its checksum",
    });
    expect(readdirSync(downloads)).toEqual([]);
    expect(readdirSync(applications)).toEqual(["Linger.app"]);
    await updater.install();
    expect(updater.state().kind).toBe("failed");
  });

  it("retries a dropped download soon instead of waiting a full interval", async () => {
    const feed = release("0.17.0");
    let drops = 1;
    const flaky = (async (url: URL) => {
      if (url.pathname.endsWith(".tar.gz") && drops-- > 0)
        throw new TypeError("terminated");
      return feed.fetch(url);
    }) as unknown as typeof globalThis.fetch;
    const { updater, host } = await setup(feed, {
      fetch: flaky,
      checkDelayMs: 1,
      retryDelayMs: 1,
      checkIntervalMs: 60 * 60_000,
    });
    await waitFor(() => updater.state().kind === "ready");
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    await host.stop("quit");
  });

  it("applies exponential backoff capped at checkIntervalMs and deduplicates repeated update.check_failed warnings", async () => {
    vi.useFakeTimers();
    try {
      const feed = release("0.16.7");
      let mode: "offline" | "timeout" | "ok" = "offline";
      const attempts: number[] = [];
      const failingFetch = (async (url: URL) => {
        if (url.pathname.endsWith("/manifest.json")) attempts.push(Date.now());
        if (mode === "offline") throw new TypeError("fetch failed");
        if (mode === "timeout") throw new Error("timed out");
        return feed.fetch(url);
      }) as unknown as typeof globalThis.fetch;

      const root = tempDirectory();
      const warnings: Array<{
        event: string;
        fields?: Record<string, unknown>;
      }> = [];
      const updater = new UpdaterModule({
        version: "0.16.7",
        platform: "darwin",
        arch: "arm64",
        install: { kind: "download" },
        downloadDirectory: path.join(root, "updates"),
        restart: async () => {},
        quit: async () => {},
        openExternal: async () => {},
        fetch: failingFetch,
        publicKey: feed.publicKey,
        checkDelayMs: 60_000,
        retryDelayMs: 5 * 60_000,
        checkIntervalMs: 60 * 60_000,
      });
      const host = testHost([
        stubModule("Config"),
        stubModule("ComputerDaemon"),
        updater,
      ]);
      const warnSpy = vi
        .spyOn(host.ctx.log, "warn")
        .mockImplementation((event, fields) => {
          warnings.push({ event, fields });
        });
      await host.start();

      // 1st failure at +1m -> next retry in 5m.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempts).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toEqual({
        event: "update.check_failed",
        fields: { error: "TypeError: fetch failed", retry_ms: 5 * 60_000 },
      });

      // 2nd failure at +5m -> next retry in 10m; identical error is deduplicated.
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(attempts).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(2);
      expect(warnings).toHaveLength(1);

      // 3rd failure at +10m -> next retry in 20m; still deduplicated.
      await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
      expect(attempts).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(3);
      expect(warnings).toHaveLength(1);

      // 4th failure at +20m with a different error -> logs again with suppressed count; next retry 40m.
      mode = "timeout";
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      expect(attempts).toHaveLength(4);
      expect(warnings).toHaveLength(2);
      expect(warnings[1]).toEqual({
        event: "update.check_failed",
        fields: {
          error: "Error: timed out",
          retry_ms: 40 * 60_000,
          suppressed_failures: 2,
        },
      });

      // 5th failure at +40m -> capped at checkIntervalMs (60m).
      await vi.advanceTimersByTimeAsync(40 * 60_000);
      expect(attempts).toHaveLength(5);
      expect(warnings).toHaveLength(2);

      // 6th check at +60m succeeds -> resets backoff and failure dedup state.
      mode = "ok";
      await vi.advanceTimersByTimeAsync(60 * 60_000 - 1);
      expect(attempts).toHaveLength(5);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toHaveLength(6);
      expect(updater.state()).toEqual({ kind: "idle" });

      // Next scheduled check after recovery runs at checkIntervalMs (60m);
      // if it fails again, it logs and resets backoff to 5m.
      mode = "offline";
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(attempts).toHaveLength(7);
      expect(warnings).toHaveLength(3);
      expect(warnings[2]).toEqual({
        event: "update.check_failed",
        fields: { error: "TypeError: fetch failed", retry_ms: 5 * 60_000 },
      });

      warnSpy.mockRestore();
      await host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reschedule or duplicate timers when stop() or stop()/start() races an in-flight check()", async () => {
    vi.useFakeTimers();
    try {
      const feed = release("0.16.7");
      const gates: Array<() => void> = [];
      let manifestCalls = 0;
      const gatedFetch = (async (url: URL) => {
        if (url.pathname.endsWith("/manifest.json")) {
          manifestCalls += 1;
          await new Promise<void>((resolve) => {
            gates.push(resolve);
          });
          throw new TypeError("fetch failed");
        }
        return feed.fetch(url);
      }) as unknown as typeof globalThis.fetch;

      const root = tempDirectory();
      const updater = new UpdaterModule({
        version: "0.16.7",
        platform: "darwin",
        arch: "arm64",
        install: { kind: "download" },
        downloadDirectory: path.join(root, "updates"),
        restart: async () => {},
        quit: async () => {},
        openExternal: async () => {},
        fetch: gatedFetch,
        publicKey: feed.publicKey,
        checkDelayMs: 1_000,
        retryDelayMs: 5_000,
        checkIntervalMs: 60_000,
      });
      const host = testHost([
        stubModule("Config"),
        stubModule("ComputerDaemon"),
        updater,
      ]);
      await host.start();

      // Trigger first scheduled check and leave it in flight.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manifestCalls).toBe(1);
      expect(gates).toHaveLength(1);

      // Stop while check() is in flight, then settle the check; no retry timer should fire.
      await updater.stop();
      gates.shift()!();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(manifestCalls).toBe(1);

      // Restart, kick off another in-flight check, then stop() + start() before it settles.
      await updater.start(host.ctx);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(manifestCalls).toBe(2);
      expect(gates).toHaveLength(1);

      await updater.stop();
      await updater.start(host.ctx);
      // Settle the stale check from the previous generation: it must not schedule a duplicate timer.
      gates.shift()!();
      await vi.advanceTimersByTimeAsync(999);
      expect(manifestCalls).toBe(2);

      // Only the new generation's single timer fires at +1000ms.
      await vi.advanceTimersByTimeAsync(1);
      expect(manifestCalls).toBe(3);
      gates.shift()!();
      await updater.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("guards backoff against zero retryDelayMs and large consecutive failure counts", async () => {
    vi.useFakeTimers();
    try {
      const feed = release("0.16.7");
      const warnings: Array<Record<string, unknown> | undefined> = [];
      const updater = new UpdaterModule({
        version: "0.16.7",
        platform: "darwin",
        arch: "arm64",
        install: { kind: "download" },
        downloadDirectory: path.join(tempDirectory(), "updates"),
        restart: async () => {},
        quit: async () => {},
        openExternal: async () => {},
        fetch: (async () => {
          throw new TypeError("offline");
        }) as unknown as typeof globalThis.fetch,
        publicKey: feed.publicKey,
        checkDelayMs: 60_000,
        retryDelayMs: 0,
        checkIntervalMs: 60_000,
      });
      const host = testHost([
        stubModule("Config"),
        stubModule("ComputerDaemon"),
        updater,
      ]);
      const warnSpy = vi
        .spyOn(host.ctx.log, "warn")
        .mockImplementation((_event, fields) => {
          warnings.push(fields);
        });
      await host.start();
      await updater.check();
      expect(warnings[0]?.retry_ms).toBe(0);
      expect(Number.isFinite(warnings[0]?.retry_ms)).toBe(true);
      warnSpy.mockRestore();
      await host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays idle when the latest release is not newer", async () => {
    const feed = release("0.16.7");
    const { updater } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(feed.requested).toHaveLength(2);
  });

  it("updates a prerelease to its release", async () => {
    const feed = release("0.16.7");
    const { updater } = await setup(feed, { version: "0.16.7-rc.2" });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.16.7" });
  });

  it("stays idle when the latest release has no manifest", async () => {
    const feed = release("0.17.0");
    delete feed.files[`${RELEASES}/latest/download/manifest.json.sig`];
    const { updater, announced } = await setup(feed);
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(announced).toEqual([]);
  });

  it("reads the feed the config names and refuses one without https", async () => {
    const own = "https://releases.example.com/linger";
    const feed = release("0.17.0", { feed: own });
    const { updater } = await setup(feed, {}, { updateFeedUrl: own });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(feed.requested[0]).toBe(`${own}/latest/download/manifest.json`);

    const plain = await setup(
      release("0.17.0"),
      {},
      { updateFeedUrl: "http://releases.example.com/linger" },
    );
    await plain.updater.check();
    expect(plain.updater.state()).toEqual({
      kind: "failed",
      error: "The update feed must use https",
    });
  });

  it("runs prepareUpdate on the staged app bundle before announcing ready", async () => {
    const feed = release("0.17.0");
    const order: string[] = [];
    const prepared: string[] = [];
    const { updater, applications, announced } = await setup(feed, {
      announce: (state) => {
        order.push(`announce:${state.kind}`);
      },
      prepareUpdate: async (stagedPath, signal) => {
        expect(signal.aborted).toBe(false);
        expect(updater.state()).toEqual({
          kind: "downloading",
          version: "0.17.0",
        });
        expect(announced).toEqual([]);
        prepared.push(stagedPath);
        order.push("prepare");
      },
    });
    await updater.check();
    expect(prepared).toEqual([
      path.join(applications, ".Linger-update-0.17.0", "Linger.app"),
    ]);
    expect(order).toEqual(["prepare", "announce:ready"]);
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
  });

  it("still announces ready when prepareUpdate fails", async () => {
    const feed = release("0.17.0");
    const warnings: Array<{ event: string; fields?: unknown }> = [];
    const { updater, host, announced } = await setup(feed, {
      prepareUpdate: async () => {
        throw new Error("mirror down");
      },
    });
    const spy = vi
      .spyOn(host.ctx.log, "warn")
      .mockImplementation((event, fields) => {
        warnings.push({ event, fields });
      });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(announced).toEqual([{ kind: "ready", version: "0.17.0" }]);
    expect(warnings).toEqual([
      {
        event: "update.prepare_failed",
        fields: { version: "0.17.0", error: "Error: mirror down" },
      },
    ]);
    spy.mockRestore();
  });

  it("aborts an active prepareUpdate on stop() without announcing ready", async () => {
    const feed = release("0.17.0");
    let releasePrepare!: () => void;
    let preparedSignal: AbortSignal | undefined;
    const { updater, announced } = await setup(feed, {
      prepareUpdate: async (_stagedPath, signal) => {
        preparedSignal = signal;
        await new Promise<void>((resolve) => {
          releasePrepare = resolve;
        });
      },
    });
    const checking = updater.check();
    await waitFor(() => preparedSignal !== undefined);
    await updater.stop();
    expect(preparedSignal!.aborted).toBe(true);
    releasePrepare();
    await checking;
    expect(announced).toEqual([]);
    expect(updater.state()).toEqual({
      kind: "downloading",
      version: "0.17.0",
    });
  });
});

describe("UpdaterModule with the Windows setup program", () => {
  const SETUP = "Linger-0.17.0-windows-x64-setup.exe";
  const windows = async (spawn: SpawnSetup) => {
    const feed = release("0.17.0", { target: "win32-x64", file: SETUP });
    return {
      feed,
      ...(await setup(feed, {
        platform: "win32",
        arch: "x64",
        install: { kind: "windows-setup" },
        spawn,
      })),
    };
  };
  const recorder = () => {
    const calls: { file: string; args: readonly string[]; options: object }[] =
      [];
    const spawn: SpawnSetup = (file, args, options) => {
      calls.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };
    return { calls, spawn };
  };

  it("runs the verified setup program silently once tasks finish, then quits", async () => {
    const { calls, spawn } = recorder();
    const { updater, downloads, feed, setRunning, quits, restarts } =
      await windows(spawn);
    await updater.check();
    expect(feed.requested.at(-1)).toBe(
      `${RELEASES}/download/desktop-v0.17.0/${SETUP}`,
    );
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(readdirSync(downloads)).toEqual([SETUP]);

    setRunning(2);
    await updater.install();
    expect(updater.state()).toEqual({ kind: "waiting", version: "0.17.0" });
    expect(calls).toEqual([]);

    setRunning(0);
    await waitFor(() => quits() === 1);
    expect(calls).toEqual([
      {
        file: path.join(downloads, SETUP),
        args: ["/update", "/relaunch"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    expect(restarts()).toBe(0);
  });

  it("does not run a setup program that changed after its download", async () => {
    const { calls, spawn } = recorder();
    const { updater, downloads, quits } = await windows(spawn);
    await updater.check();
    writeFileSync(path.join(downloads, SETUP), "something else");
    await updater.install();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Update package does not match its checksum",
    });
    expect(calls).toEqual([]);
    expect(quits()).toBe(0);
  });

  it("stays when the setup program cannot start", async () => {
    const spawn: SpawnSetup = () => {
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
      return child;
    };
    const { updater, quits } = await windows(spawn);
    await updater.check();
    await updater.install();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Error: spawn EACCES",
    });
    expect(quits()).toBe(0);
  });

  it("does not invoke prepareUpdate for windows-setup updates", async () => {
    const feed = release("0.17.0", { target: "win32-x64", file: SETUP });
    const prepareUpdate = vi.fn(async () => {});
    const { updater } = await setup(feed, {
      platform: "win32",
      arch: "x64",
      install: { kind: "windows-setup" },
      spawn: recorder().spawn,
      prepareUpdate,
    });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    expect(prepareUpdate).not.toHaveBeenCalled();
  });
});

describe("UpdaterModule with Windows archive self-update", () => {
  const SETUP = "Linger-0.17.0-windows-x64-setup.exe";
  const ARCHIVE = "Linger-0.17.0-windows-x64-portable.zip";
  const SETUP_BODY = Buffer.from("windows setup exe");
  const ARCHIVE_BODY = Buffer.from("windows portable zip");
  const HELPER_BODY = Buffer.from("MZ-fake-daemon-helper");

  const windowsRelease = (
    version: string,
    {
      includeArchive = true,
      archiveBody = ARCHIVE_BODY,
      setupBody = SETUP_BODY,
      feed = RELEASES,
    } = {},
  ) => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const packages: Record<
      string,
      { file: string; sha256: string; size: number }
    > = {
      "win32-x64": {
        file: `Linger-${version}-windows-x64-setup.exe`,
        sha256: createHash("sha256").update(setupBody).digest("hex"),
        size: setupBody.length,
      },
    };
    const files: Record<string, Buffer> = {
      [`${feed}/download/desktop-v${version}/Linger-${version}-windows-x64-setup.exe`]:
        setupBody,
    };
    if (includeArchive) {
      const archiveFile = `Linger-${version}-windows-x64-portable.zip`;
      packages["win32-x64-archive"] = {
        file: archiveFile,
        sha256: createHash("sha256").update(archiveBody).digest("hex"),
        size: archiveBody.length,
      };
      files[`${feed}/download/desktop-v${version}/${archiveFile}`] =
        archiveBody;
    }
    const manifest = Buffer.from(
      JSON.stringify({ schema: 2, version, packages }),
    );
    files[`${feed}/latest/download/manifest.json`] = manifest;
    files[`${feed}/latest/download/manifest.json.sig`] = Buffer.from(
      sign(null, manifest, privateKey).toString("base64"),
    );
    const requested: string[] = [];
    const fetch = (async (url: URL) => {
      requested.push(url.toString());
      const content = files[url.toString()];
      return content
        ? new Response(new Uint8Array(content))
        : new Response("missing", { status: 404 });
    }) as unknown as typeof globalThis.fetch;
    return {
      fetch,
      files,
      requested,
      publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
  };

  const validWinExtract = async (_archive: string, directory: string) => {
    const app = path.join(directory, "Linger");
    const computer = path.join(app, "resources", "computer");
    mkdirSync(computer, { recursive: true });
    writeFileSync(path.join(app, "Linger.exe"), "MZ-new-linger");
    writeFileSync(
      path.join(computer, "linger-computer-daemon.exe"),
      HELPER_BODY,
    );
  };

  const recorder = () => {
    const calls: {
      file: string;
      args: readonly string[];
      options: { detached: true; stdio: "ignore"; windowsHide?: boolean };
    }[] = [];
    const spawn: SpawnSetup = (file, args, options) => {
      calls.push({ file, args, options });
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    };
    return { calls, spawn };
  };

  const setupWin = async (
    feed: ReturnType<typeof windowsRelease>,
    options: Partial<UpdaterOptions> = {},
  ) => {
    const root = tempDirectory();
    const programs = path.join(root, "Programs");
    const installDir = path.join(programs, "Linger");
    mkdirSync(installDir, { recursive: true });
    writeFileSync(path.join(installDir, "Linger.exe"), "MZ-old-linger");
    writeFileSync(
      path.join(installDir, "Uninstall Linger.exe"),
      "MZ-uninstaller",
    );
    const result = await setup(feed, {
      platform: "win32",
      arch: "x64",
      install: { kind: "windows-setup", installDir },
      extract: validWinExtract,
      ...options,
    });
    return { ...result, programs, installDir };
  };

  it("downloads, extracts, pre-stages via prepareUpdate, and spawns a detached external helper before quitting", async () => {
    const feed = windowsRelease("0.17.0");
    const { calls, spawn } = recorder();
    const order: string[] = [];
    const preparedPaths: string[] = [];
    const {
      updater,
      programs,
      installDir,
      downloads,
      setRunning,
      quits,
      restarts,
      host,
    } = await setupWin(feed, {
      spawn,
      announce: (state) => {
        order.push(`announce:${state.kind}`);
      },
      prepareUpdate: async (stagedPath, signal) => {
        expect(signal.aborted).toBe(false);
        expect(updater.state()).toEqual({
          kind: "downloading",
          version: "0.17.0",
        });
        preparedPaths.push(stagedPath);
        order.push("prepare");
      },
    });

    await updater.check();
    const expectedStaged = path.join(
      programs,
      ".Linger-update-0.17.0",
      "Linger",
    );
    expect(feed.requested).toEqual([
      `${RELEASES}/latest/download/manifest.json`,
      `${RELEASES}/latest/download/manifest.json.sig`,
      `${RELEASES}/download/desktop-v0.17.0/${ARCHIVE}`,
    ]);
    expect(preparedPaths).toEqual([expectedStaged]);
    expect(order).toEqual(["prepare", "announce:ready"]);
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
    // Downloaded zip was deleted after extraction.
    expect(readdirSync(downloads)).toEqual([]);

    setRunning(1);
    await updater.install();
    expect(updater.state()).toEqual({ kind: "waiting", version: "0.17.0" });
    expect(calls).toEqual([]);

    setRunning(0);
    await waitFor(() => quits() === 1);
    expect(restarts()).toBe(0);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // Helper binary is copied into downloadDirectory, outside both installDir and stagedDir.
    expect(path.dirname(call.file)).toBe(downloads);
    expect(path.basename(call.file)).toMatch(/^update-helper-.*\.exe$/);
    expect(readFileSync(call.file)).toEqual(HELPER_BODY);
    expect(call.args[0]).toBe("apply-windows-update");
    const configPath = call.args[1]!;
    expect(path.dirname(configPath)).toBe(downloads);
    expect(path.basename(configPath)).toMatch(/^update-apply-.*\.json$/);
    expect(call.options).toEqual({
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(config).toEqual({
      parentPid: process.pid,
      installDir,
      stagedDir: expectedStaged,
      version: "0.17.0",
      logPath: path.join(downloads, "update-apply-0.17.0.log"),
    });
    await host.stop("update");
  });

  it("falls back to setup.exe when win32-x64-archive is absent from the manifest", async () => {
    const feed = windowsRelease("0.17.0", { includeArchive: false });
    const { calls, spawn } = recorder();
    const prepareUpdate = vi.fn(async () => {});
    const { updater, downloads, quits, host } = await setupWin(feed, {
      spawn,
      prepareUpdate,
    });

    await updater.check();
    expect(feed.requested.at(-1)).toBe(
      `${RELEASES}/download/desktop-v0.17.0/${SETUP}`,
    );
    expect(prepareUpdate).not.toHaveBeenCalled();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });

    await updater.install();
    expect(quits()).toBe(1);
    expect(calls).toEqual([
      {
        file: path.join(downloads, SETUP),
        args: ["/update", "/relaunch"],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
    await host.stop("update");
  });

  it("falls back to setup.exe when installDir is omitted even if win32-x64-archive exists", async () => {
    const feed = windowsRelease("0.17.0", { includeArchive: true });
    const { calls, spawn } = recorder();
    const prepareUpdate = vi.fn(async () => {});
    const { updater, downloads, quits, host } = await setup(feed, {
      platform: "win32",
      arch: "x64",
      install: { kind: "windows-setup" },
      spawn,
      prepareUpdate,
    });

    await updater.check();
    expect(feed.requested.at(-1)).toBe(
      `${RELEASES}/download/desktop-v0.17.0/${SETUP}`,
    );
    expect(prepareUpdate).not.toHaveBeenCalled();
    await updater.install();
    expect(quits()).toBe(1);
    expect(calls[0]?.file).toBe(path.join(downloads, SETUP));
    await host.stop("update");
  });

  it.each([
    [
      "missing Linger.exe",
      async (_archive: string, directory: string) => {
        const computer = path.join(
          directory,
          "Linger",
          "resources",
          "computer",
        );
        mkdirSync(computer, { recursive: true });
        writeFileSync(
          path.join(computer, "linger-computer-daemon.exe"),
          HELPER_BODY,
        );
      },
      "Update package has no Linger.exe",
    ],
    [
      "missing linger-computer-daemon.exe",
      async (_archive: string, directory: string) => {
        const app = path.join(directory, "Linger");
        mkdirSync(path.join(app, "resources", "computer"), { recursive: true });
        writeFileSync(path.join(app, "Linger.exe"), "MZ-new");
      },
      "Update package has no update helper",
    ],
    [
      "missing helper directory",
      async (_archive: string, directory: string) => {
        const app = path.join(directory, "Linger");
        mkdirSync(app, { recursive: true });
        writeFileSync(path.join(app, "Linger.exe"), "MZ-new");
      },
      "Update package has an invalid helper directory",
    ],
  ])(
    "fails and cleans staged folder and zip when extracted archive has %s",
    async (_label, extract, expectedError) => {
      const feed = windowsRelease("0.17.0");
      const prepareUpdate = vi.fn(async () => {});
      const { updater, programs, downloads, host } = await setupWin(feed, {
        extract,
        prepareUpdate,
      });

      await updater.check();
      expect(updater.state()).toEqual({
        kind: "failed",
        error: expectedError,
      });
      expect(prepareUpdate).not.toHaveBeenCalled();
      expect(readdirSync(programs)).toEqual(["Linger"]);
      expect(readdirSync(downloads)).toEqual([]);
      await host.stop("quit");
    },
  );

  it("cleans .Linger-old-* and .Linger-update-* case-insensitively beside installDir and preserves fallback apply logs on Windows", async () => {
    const feed = windowsRelease("0.16.7");
    const { host, programs, downloads } = await setupWin(feed, {
      cleanupDelayMs: 0,
    });
    await host.stop("quit");

    mkdirSync(path.join(programs, ".linger-old-1111"), { recursive: true });
    mkdirSync(path.join(programs, ".LINGER-UPDATE-0.16.6"), {
      recursive: true,
    });
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "update-helper-old.exe"), "old");
    writeFileSync(path.join(downloads, "update-apply-old.json"), "{}");
    writeFileSync(path.join(downloads, "update-apply-0.16.6.log"), "diag");

    const next = new UpdaterModule({
      version: "0.17.0",
      platform: "win32",
      arch: "x64",
      install: {
        kind: "windows-setup",
        installDir: path.join(programs, "Linger"),
      },
      downloadDirectory: downloads,
      restart: async () => {},
      quit: async () => {},
      openExternal: async () => {},
      checkDelayMs: 60 * 60_000,
      cleanupDelayMs: 0,
    });
    const nextHost = testHost([
      stubModule("Config"),
      stubModule("ComputerDaemon"),
      next,
    ]);
    await nextHost.start();
    await waitFor(
      () =>
        readdirSync(programs).length === 1 &&
        readdirSync(downloads).length === 1,
    );
    expect(readdirSync(programs)).toEqual(["Linger"]);
    expect(readdirSync(downloads)).toEqual(["update-apply-0.16.6.log"]);
    await nextHost.stop("quit");
  });

  it("writes Windows apply helper log into logDirectory when configured so diagnostics retain it across cleanup", async () => {
    const feed = windowsRelease("0.17.0");
    const logDir = path.join(tempDirectory(), "logs");
    const { calls, spawn } = recorder();
    const { updater, downloads, quits, host } = await setupWin(feed, {
      logDirectory: logDir,
      spawn,
    });
    await updater.check();
    await updater.install();
    expect(quits()).toBe(1);
    const configPath = calls[0]!.args[1]!;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      logPath: string;
    };
    expect(config.logPath).toBe(path.join(logDir, "update-apply-0.17.0.log"));
    expect(existsSync(logDir)).toBe(true);
    await host.stop("update");

    // Simulate helper writing log, then verify next-launch cleanup removes
    // downloadDirectory leftovers while keeping logDirectory untouched.
    writeFileSync(config.logPath, "apply failed\n");
    const next = new UpdaterModule({
      version: "0.17.0",
      platform: "win32",
      arch: "x64",
      install: { kind: "windows-setup" },
      downloadDirectory: downloads,
      logDirectory: logDir,
      restart: async () => {},
      quit: async () => {},
      openExternal: async () => {},
      checkDelayMs: 60 * 60_000,
      cleanupDelayMs: 0,
    });
    const nextHost = testHost([
      stubModule("Config"),
      stubModule("ComputerDaemon"),
      next,
    ]);
    await nextHost.start();
    await waitFor(() => readdirSync(downloads).length === 0);
    expect(readFileSync(config.logPath, "utf8")).toBe("apply failed\n");
    await nextHost.stop("quit");
  });

  it("retries spawning the copied Windows update helper on transient Defender EBUSY locks and fails cleanly after exhausting retries", async () => {
    const feed = windowsRelease("0.17.0");
    let attempts = 0;
    const flakySpawn: SpawnSetup = () => {
      attempts += 1;
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => {
        if (attempts <= 2) {
          child.emit(
            "error",
            Object.assign(new Error("spawn EBUSY"), { code: "EBUSY" }),
          );
        } else {
          child.emit("spawn");
        }
      });
      return child;
    };
    const okRun = await setupWin(feed, {
      spawn: flakySpawn,
      spawnRetryDelayMs: 5,
    });
    await okRun.updater.check();
    await okRun.updater.install();
    expect(attempts).toBe(3);
    expect(okRun.quits()).toBe(1);
    await okRun.host.stop("update");

    let exhaustedAttempts = 0;
    const failingSpawn: SpawnSetup = () => {
      exhaustedAttempts += 1;
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() =>
        child.emit(
          "error",
          Object.assign(new Error("spawn EPERM"), { code: "EPERM" }),
        ),
      );
      return child;
    };
    const failRun = await setupWin(windowsRelease("0.17.0"), {
      spawn: failingSpawn,
      spawnRetryDelayMs: 5,
    });
    await failRun.updater.check();
    await failRun.updater.install();
    expect(exhaustedAttempts).toBe(10);
    expect(failRun.quits()).toBe(0);
    expect(failRun.updater.state()).toEqual({
      kind: "failed",
      error: "Error: spawn EPERM",
    });
    expect(readdirSync(failRun.downloads)).toEqual([]);
    await failRun.host.stop("quit");
  });

  it("refuses install without spawning or quitting when staged files or helper directory vanish or become a link before install()", async () => {
    // 1. Staged Linger.exe deleted between check() and install().
    const { calls: calls1, spawn: spawn1 } = recorder();
    const run1 = await setupWin(windowsRelease("0.17.0"), { spawn: spawn1 });
    await run1.updater.check();
    const stagedApp1 = path.join(
      run1.programs,
      ".Linger-update-0.17.0",
      "Linger",
    );
    rmSync(path.join(stagedApp1, "Linger.exe"));
    await run1.updater.install();
    expect(run1.updater.state()).toEqual({
      kind: "failed",
      error: "Update package has no Linger.exe",
    });
    expect(calls1).toEqual([]);
    expect(run1.quits()).toBe(0);
    await run1.host.stop("quit");

    // 2. resources/computer replaced by a directory junction/symlink before install().
    const { calls: calls2, spawn: spawn2 } = recorder();
    const run2 = await setupWin(windowsRelease("0.17.0"), { spawn: spawn2 });
    await run2.updater.check();
    const computerDir = path.join(
      run2.programs,
      ".Linger-update-0.17.0",
      "Linger",
      "resources",
      "computer",
    );
    const outsideDir = path.join(tempDirectory(), "outside-computer");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      path.join(outsideDir, "linger-computer-daemon.exe"),
      HELPER_BODY,
    );
    rmSync(computerDir, { recursive: true, force: true });
    if (process.platform === "win32") {
      execFileSync("cmd.exe", ["/c", "mklink", "/J", computerDir, outsideDir], {
        windowsHide: true,
      });
    } else {
      symlinkSync(outsideDir, computerDir, "dir");
    }
    await run2.updater.install();
    expect(run2.updater.state()).toEqual({
      kind: "failed",
      error: "Update package has an invalid helper directory",
    });
    expect(calls2).toEqual([]);
    expect(run2.quits()).toBe(0);
    await run2.host.stop("quit");
  });

  it("aborts Windows archive prepareUpdate on stop() without announcing ready, and ignores prepareUpdate errors", async () => {
    const feed = windowsRelease("0.17.0");
    let releasePrepare!: () => void;
    let capturedSignal: AbortSignal | undefined;
    const { updater, announced, host } = await setupWin(feed, {
      prepareUpdate: async (_stagedPath, signal) => {
        capturedSignal = signal;
        await new Promise<void>((resolve) => {
          releasePrepare = resolve;
        });
      },
    });
    const checking = updater.check();
    await waitFor(() => capturedSignal !== undefined);
    await updater.stop();
    expect(capturedSignal!.aborted).toBe(true);
    releasePrepare();
    await checking;
    expect(announced).toEqual([]);
    await host.stop("quit");

    const resilient = await setupWin(windowsRelease("0.17.0"), {
      prepareUpdate: async () => {
        throw new Error("offline cache miss");
      },
    });
    await resilient.updater.check();
    expect(resilient.updater.state()).toEqual({
      kind: "ready",
      version: "0.17.0",
    });
    expect(resilient.announced).toEqual([{ kind: "ready", version: "0.17.0" }]);
    await resilient.host.stop("quit");
  });

  it("cleans up copied helper and config without quitting if spawning the Windows update helper fails", async () => {
    const feed = windowsRelease("0.17.0");
    const spawn: SpawnSetup = () => {
      const child = Object.assign(new EventEmitter(), { unref: () => {} });
      queueMicrotask(() => child.emit("error", new Error("spawn EPERM")));
      return child;
    };
    const { updater, downloads, quits, host } = await setupWin(feed, { spawn });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });

    await updater.install();
    expect(updater.state()).toEqual({
      kind: "failed",
      error: "Error: spawn EPERM",
    });
    expect(quits()).toBe(0);
    expect(readdirSync(downloads)).toEqual([]);
    await host.stop("quit");
  });

  it.skipIf(process.platform !== "win32")(
    "extracts a real Windows portable zip using native System32\\tar.exe",
    async () => {
      const sourceRoot = tempDirectory();
      const zipStage = path.join(sourceRoot, "Linger");
      mkdirSync(path.join(zipStage, "resources", "computer"), {
        recursive: true,
      });
      writeFileSync(path.join(zipStage, "Linger.exe"), "MZ-real-zip-linger");
      writeFileSync(
        path.join(
          zipStage,
          "resources",
          "computer",
          "linger-computer-daemon.exe",
        ),
        HELPER_BODY,
      );
      const zipFile = path.join(sourceRoot, "portable.zip");
      const systemRoot =
        process.env.SystemRoot?.trim() ||
        process.env.windir?.trim() ||
        "C:\\Windows";
      execFileSync(
        path.win32.join(systemRoot, "System32", "tar.exe"),
        ["-a", "-cf", zipFile, "-C", sourceRoot, "Linger"],
        { windowsHide: true },
      );
      const zipBytes = readFileSync(zipFile);

      const feed = windowsRelease("0.17.0", { archiveBody: zipBytes });
      const { calls, spawn } = recorder();
      const { updater, programs, downloads, quits, host } = await setupWin(
        feed,
        {
          extract: undefined,
          spawn,
        },
      );

      await updater.check();
      expect(updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
      const stagedExe = path.join(
        programs,
        ".Linger-update-0.17.0",
        "Linger",
        "Linger.exe",
      );
      expect(existsSync(stagedExe)).toBe(true);
      expect(readFileSync(stagedExe, "utf8")).toBe("MZ-real-zip-linger");
      expect(readdirSync(downloads)).toEqual([]);

      await updater.install();
      expect(quits()).toBe(1);
      expect(calls).toHaveLength(1);
      await host.stop("update");

      // Also verify non-ASCII download folder paths trigger the pure-ASCII
      // .archive.zip staging fallback and clean up .archive.zip afterwards.
      const nonAsciiDownloads = path.join(
        tempDirectory(),
        "caf\u00e9-downloads",
      );
      const nonAsciiRun = await setupWin(
        windowsRelease("0.17.0", { archiveBody: zipBytes }),
        {
          downloadDirectory: nonAsciiDownloads,
          extract: undefined,
          spawn,
        },
      );
      await nonAsciiRun.updater.check();
      expect(nonAsciiRun.updater.state()).toEqual({
        kind: "ready",
        version: "0.17.0",
      });
      expect(
        existsSync(
          path.join(
            nonAsciiRun.programs,
            ".Linger-update-0.17.0",
            ".archive.zip",
          ),
        ),
      ).toBe(false);
      await nonAsciiRun.host.stop("quit");
    },
  );
});

describe("UpdaterModule for a download", () => {
  it("links a newer release without downloading it", async () => {
    const feed = release("0.17.0", {
      target: "linux-x64",
      file: "Linger-0.17.0-linux-x64.tar.gz",
    });
    const { updater, opened, announced, downloads } = await setup(feed, {
      platform: "linux",
      arch: "x64",
      install: { kind: "download" },
    });
    await updater.check();
    const available = {
      kind: "available",
      version: "0.17.0",
      url: `${RELEASES}/tag/desktop-v0.17.0`,
    };
    expect(updater.state()).toEqual(available);
    expect(feed.requested).toHaveLength(2);
    expect(() => readdirSync(downloads)).toThrow();

    await updater.check();
    expect(announced).toEqual([available]);
    await updater.install();
    expect(opened).toEqual([available.url]);
    expect(updater.state()).toEqual(available);
  });

  it("stays idle when the release has nothing for this platform", async () => {
    const feed = release("0.17.0");
    const { updater } = await setup(feed, {
      platform: "linux",
      arch: "x64",
      install: { kind: "download" },
    });
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });
  });
});

describe("UpdaterModule deferred startup cleanup", () => {
  const flushIo = async (): Promise<void> => {
    for (let i = 0; i < 6; i++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
  };

  const waitForIo = async (condition: () => boolean): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for deferred cleanup");
      }
      await new Promise<void>((resolve) => realSetTimeout(resolve, 10));
    }
  };

  const seedLeftovers = (applications: string, downloads: string) => {
    const oldBundle = path.join(applications, ".Linger-old-12345");
    const staleStage = path.join(applications, ".Linger-update-0.16.0");
    mkdirSync(oldBundle, { recursive: true });
    writeFileSync(path.join(oldBundle, "marker"), "old");
    mkdirSync(staleStage, { recursive: true });
    writeFileSync(path.join(staleStage, "marker"), "stale");
    mkdirSync(downloads, { recursive: true });
    writeFileSync(path.join(downloads, "Linger-0.16.0-stale.tar.gz"), "stale");
  };

  const createDeferred = (
    feed: ReturnType<typeof release>,
    options: Partial<UpdaterOptions> = {},
  ) => {
    const root = tempDirectory();
    const applications = path.join(root, "Applications");
    const bundle = path.join(applications, "Linger.app");
    mkdirSync(bundle, { recursive: true });
    writeFileSync(path.join(bundle, "version"), "0.16.7");
    const downloads = path.join(root, "updates");
    let restarts = 0;
    let quits = 0;
    const runtime = {
      ...stubModule("ComputerDaemon"),
      running: () => 0,
    } as unknown as ComputerDaemonModule;
    const updater = new UpdaterModule({
      version: "0.16.7",
      platform: "darwin",
      arch: "arm64",
      install: { kind: "app-bundle", appBundle: bundle },
      downloadDirectory: downloads,
      restart: async () => {
        restarts += 1;
      },
      quit: async () => {
        quits += 1;
      },
      openExternal: async () => {},
      fetch: feed.fetch,
      publicKey: feed.publicKey,
      checkDelayMs: 60 * 60_000,
      extract: async (archive, directory) => {
        const app = path.join(directory, "Linger.app");
        mkdirSync(app);
        writeFileSync(path.join(app, "version"), readFileSync(archive));
      },
      ...options,
    });
    const host = testHost([stubModule("Config"), runtime, updater]);
    return {
      host,
      updater,
      bundle,
      applications,
      downloads,
      restarts: () => restarts,
      quits: () => quits,
    };
  };

  it("defers startup cleanup until the default 60s fallback when no local-server.busy event arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const feed = release("0.16.7");
      const { host, applications, downloads } = createDeferred(feed);
      seedLeftovers(applications, downloads);

      await host.start();
      await flushIo();
      expect(readdirSync(applications).sort()).toEqual([
        ".Linger-old-12345",
        ".Linger-update-0.16.0",
        "Linger.app",
      ]);
      expect(readdirSync(downloads)).toEqual(["Linger-0.16.0-stale.tar.gz"]);

      await vi.advanceTimersByTimeAsync(59_999);
      await flushIo();
      expect(readdirSync(applications).sort()).toEqual([
        ".Linger-old-12345",
        ".Linger-update-0.16.0",
        "Linger.app",
      ]);
      expect(readdirSync(downloads)).toEqual(["Linger-0.16.0-stale.tar.gz"]);

      await vi.advanceTimersByTimeAsync(1);
      await waitForIo(
        () =>
          readdirSync(applications).length === 1 &&
          readdirSync(downloads).length === 0,
      );
      expect(readdirSync(applications)).toEqual(["Linger.app"]);
      expect(readdirSync(downloads)).toEqual([]);
      await host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pauses cleanup while local-server.busy is true and runs after the 5s post-busy settle delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const feed = release("0.16.7");
      const { host, applications, downloads } = createDeferred(feed);
      seedLeftovers(applications, downloads);

      await host.start();
      host.ctx.bus.emit("local-server.busy", true);

      // Even well past the 60s fallback, cleanup stays paused while busy.
      await vi.advanceTimersByTimeAsync(120_000);
      await flushIo();
      expect(readdirSync(applications).sort()).toEqual([
        ".Linger-old-12345",
        ".Linger-update-0.16.0",
        "Linger.app",
      ]);
      expect(readdirSync(downloads)).toEqual(["Linger-0.16.0-stale.tar.gz"]);

      // Transition to idle arms the 5s settle timer; another busy(true) pauses it again.
      host.ctx.bus.emit("local-server.busy", false);
      await vi.advanceTimersByTimeAsync(4_999);
      await flushIo();
      expect(readdirSync(applications)).toHaveLength(3);

      host.ctx.bus.emit("local-server.busy", true);
      await vi.advanceTimersByTimeAsync(10_000);
      await flushIo();
      expect(readdirSync(applications)).toHaveLength(3);

      host.ctx.bus.emit("local-server.busy", false);
      await vi.advanceTimersByTimeAsync(5_000);
      await waitForIo(
        () =>
          readdirSync(applications).length === 1 &&
          readdirSync(downloads).length === 0,
      );
      expect(readdirSync(applications)).toEqual(["Linger.app"]);
      expect(readdirSync(downloads)).toEqual([]);
      await host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles local-server.busy(false) without a preceding true and caps settle delay at cleanupDelayMs", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const feed = release("0.16.7");
      const { host, applications, downloads } = createDeferred(feed);
      seedLeftovers(applications, downloads);

      await host.start();
      await vi.advanceTimersByTimeAsync(2_000);
      host.ctx.bus.emit("local-server.busy", false);

      await vi.advanceTimersByTimeAsync(4_999);
      await flushIo();
      expect(readdirSync(applications)).toHaveLength(3);

      await vi.advanceTimersByTimeAsync(1);
      await waitForIo(
        () =>
          readdirSync(applications).length === 1 &&
          readdirSync(downloads).length === 0,
      );
      expect(readdirSync(applications)).toEqual(["Linger.app"]);
      await host.stop("quit");

      // When cleanupDelayMs < 5_000, the post-busy settle delay is capped at cleanupDelayMs.
      const short = createDeferred(feed, { cleanupDelayMs: 1_000 });
      seedLeftovers(short.applications, short.downloads);
      await short.host.start();
      short.host.ctx.bus.emit("local-server.busy", true);
      await vi.advanceTimersByTimeAsync(5_000);
      short.host.ctx.bus.emit("local-server.busy", false);
      await vi.advanceTimersByTimeAsync(999);
      await flushIo();
      expect(readdirSync(short.applications)).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      await waitForIo(() => readdirSync(short.applications).length === 1);
      expect(readdirSync(short.applications)).toEqual(["Linger.app"]);
      await short.host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending cleanup and unsubscribes local-server.busy on stop()", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const feed = release("0.16.7");
      const { host, applications, downloads } = createDeferred(feed);
      seedLeftovers(applications, downloads);

      await host.start();
      await host.stop("quit");
      host.ctx.bus.emit("local-server.busy", false);
      await vi.advanceTimersByTimeAsync(120_000);
      await flushIo();
      expect(readdirSync(applications).sort()).toEqual([
        ".Linger-old-12345",
        ".Linger-update-0.16.0",
        "Linger.app",
      ]);
      expect(readdirSync(downloads)).toEqual(["Linger-0.16.0-stale.tar.gz"]);

      // Even with cleanupDelayMs: 0, synchronous stop() cancels before cleanup runs.
      const zero = createDeferred(feed, { cleanupDelayMs: 0 });
      seedLeftovers(zero.applications, zero.downloads);
      await zero.host.start();
      await zero.host.stop("quit");
      await vi.advanceTimersByTimeAsync(1_000);
      await flushIo();
      expect(readdirSync(zero.applications)).toHaveLength(3);
      expect(readdirSync(zero.downloads)).toEqual([
        "Linger-0.16.0-stale.tar.gz",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flushes cleanup before downloading in check() and preserves newly staged macOS and Windows updates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // macOS app-bundle path
      const macFeed = release("0.17.0");
      let macCleanedBeforeDownload = false;
      const mac = createDeferred(macFeed, {
        fetch: (async (url: URL) => {
          if (url.pathname.endsWith(".tar.gz")) {
            macCleanedBeforeDownload =
              readdirSync(mac.applications).length === 1 &&
              readdirSync(mac.downloads).length === 0;
          }
          return macFeed.fetch(url);
        }) as unknown as typeof globalThis.fetch,
      });
      seedLeftovers(mac.applications, mac.downloads);

      await mac.host.start();
      await mac.updater.check();
      expect(macCleanedBeforeDownload).toBe(true);
      expect(mac.updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
      expect(readdirSync(mac.applications).sort()).toEqual([
        ".Linger-update-0.17.0",
        "Linger.app",
      ]);

      // Neither local-server.busy(false) nor fallback timer deletes the active staged bundle.
      mac.host.ctx.bus.emit("local-server.busy", false);
      await vi.advanceTimersByTimeAsync(120_000);
      await flushIo();
      expect(readdirSync(mac.applications).sort()).toEqual([
        ".Linger-update-0.17.0",
        "Linger.app",
      ]);
      await mac.updater.install();
      expect(mac.restarts()).toBe(1);
      await mac.host.stop("quit");

      // Windows setup path
      const setupExe = "Linger-0.17.0-windows-x64-setup.exe";
      const winFeed = release("0.17.0", {
        target: "win32-x64",
        file: setupExe,
      });
      const spawned: string[] = [];
      const spawn: SpawnSetup = (file) => {
        spawned.push(file);
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        queueMicrotask(() => child.emit("spawn"));
        return child;
      };
      let winCleanedBeforeDownload = false;
      const win = createDeferred(winFeed, {
        platform: "win32",
        arch: "x64",
        install: { kind: "windows-setup" },
        spawn,
        fetch: (async (url: URL) => {
          if (url.pathname.endsWith(".exe")) {
            winCleanedBeforeDownload = readdirSync(win.downloads).length === 0;
          }
          return winFeed.fetch(url);
        }) as unknown as typeof globalThis.fetch,
      });
      mkdirSync(win.downloads, { recursive: true });
      writeFileSync(
        path.join(win.downloads, "Linger-0.16.0-windows-x64-setup.exe"),
        "stale setup",
      );

      await win.host.start();
      await win.updater.check();
      expect(winCleanedBeforeDownload).toBe(true);
      expect(win.updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
      expect(readdirSync(win.downloads)).toEqual([setupExe]);

      win.host.ctx.bus.emit("local-server.busy", false);
      await vi.advanceTimersByTimeAsync(120_000);
      await flushIo();
      expect(readdirSync(win.downloads)).toEqual([setupExe]);
      await win.updater.install();
      expect(spawned).toEqual([path.join(win.downloads, setupExe)]);
      expect(win.quits()).toBe(1);
      await win.host.stop("quit");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces a concurrent check() onto an in-flight timer cleanup before downloading", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { rm: realRm } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let releaseCleanup: (() => void) | undefined;
    let staleRmCalls = 0;
    let rmSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const setupExe = "Linger-0.17.0-windows-x64-setup.exe";
      const winFeed = release("0.17.0", {
        target: "win32-x64",
        file: setupExe,
      });
      const spawned: string[] = [];
      const spawn: SpawnSetup = (file) => {
        spawned.push(file);
        const child = Object.assign(new EventEmitter(), { unref: () => {} });
        queueMicrotask(() => child.emit("spawn"));
        return child;
      };
      let downloadStarted = false;
      let cleanedBeforeDownload = false;
      const win = createDeferred(winFeed, {
        platform: "win32",
        arch: "x64",
        install: { kind: "windows-setup" },
        spawn,
        fetch: (async (url: URL) => {
          if (url.pathname.endsWith(".exe")) {
            downloadStarted = true;
            cleanedBeforeDownload = readdirSync(win.downloads).length === 0;
          }
          return winFeed.fetch(url);
        }) as unknown as typeof globalThis.fetch,
      });
      mkdirSync(win.downloads, { recursive: true });
      const staleFile = path.join(
        win.downloads,
        "Linger-0.16.0-windows-x64-setup.exe",
      );
      writeFileSync(staleFile, "stale setup");

      rmSpy = vi
        .spyOn(fsPromises, "rm")
        .mockImplementation(async (target, options) => {
          if (String(target) === staleFile) {
            staleRmCalls += 1;
            await new Promise<void>((resolve) => {
              releaseCleanup = resolve;
            });
          }
          return realRm(target, options);
        });

      await win.host.start();
      // Fire the fallback cleanup timer and pause inside #cleanup's rm().
      await vi.advanceTimersByTimeAsync(60_000);
      await waitForIo(() => releaseCleanup !== undefined);
      expect(staleRmCalls).toBe(1);

      // Start check() while #cleanup is in flight: it must coalesce onto the
      // existing cleanup task and wait before downloading.
      const checking = win.updater.check();
      await flushIo();
      expect(win.updater.state()).toEqual({
        kind: "downloading",
        version: "0.17.0",
      });
      expect(downloadStarted).toBe(false);
      expect(staleRmCalls).toBe(1);

      releaseCleanup!();
      await checking;
      expect(downloadStarted).toBe(true);
      expect(cleanedBeforeDownload).toBe(true);
      expect(staleRmCalls).toBe(1);
      expect(win.updater.state()).toEqual({ kind: "ready", version: "0.17.0" });
      expect(readdirSync(win.downloads)).toEqual([setupExe]);

      await win.updater.install();
      expect(spawned).toEqual([path.join(win.downloads, setupExe)]);
      expect(win.quits()).toBe(1);
      await win.host.stop("quit");
    } finally {
      releaseCleanup?.();
      rmSpy?.mockRestore();
      vi.useRealTimers();
    }
  });

  it("exits check() without emitting downloading if stop() races manifest fetch", async () => {
    const feed = release("0.17.0");
    let releaseManifest: (() => void) | undefined;
    let downloadRequested = false;
    const { host, updater, applications, downloads } = createDeferred(feed, {
      fetch: (async (url: URL) => {
        if (url.pathname.endsWith("/manifest.json")) {
          await new Promise<void>((resolve) => {
            releaseManifest = resolve;
          });
        }
        if (url.pathname.endsWith(".tar.gz")) downloadRequested = true;
        return feed.fetch(url);
      }) as unknown as typeof globalThis.fetch,
    });
    seedLeftovers(applications, downloads);
    const states: string[] = [];
    host.ctx.bus.on("update.changed", (state) => states.push(state));

    await host.start();
    const checking = updater.check();
    await waitFor(() => releaseManifest !== undefined);
    expect(states).toEqual(["checking"]);

    await updater.stop();
    releaseManifest!();
    await checking;

    expect(states).toEqual(["checking"]);
    expect(updater.state()).toEqual({ kind: "checking" });
    expect(downloadRequested).toBe(false);
    expect(readdirSync(applications).sort()).toEqual([
      ".Linger-old-12345",
      ".Linger-update-0.16.0",
      "Linger.app",
    ]);
    expect(readdirSync(downloads)).toEqual(["Linger-0.16.0-stale.tar.gz"]);
  });

  it("exits check() without downloading if stop() races in-flight cleanup", async () => {
    const { rm: realRm } =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    let releaseCleanup: (() => void) | undefined;
    let downloadRequested = false;
    let rmSpy: ReturnType<typeof vi.spyOn> | undefined;
    try {
      const feed = release("0.17.0");
      const { host, updater, applications, downloads } = createDeferred(feed, {
        fetch: (async (url: URL) => {
          if (url.pathname.endsWith(".tar.gz")) downloadRequested = true;
          return feed.fetch(url);
        }) as unknown as typeof globalThis.fetch,
      });
      seedLeftovers(applications, downloads);
      const staleDownload = path.join(downloads, "Linger-0.16.0-stale.tar.gz");
      rmSpy = vi
        .spyOn(fsPromises, "rm")
        .mockImplementation(async (target, options) => {
          if (String(target) === staleDownload) {
            await new Promise<void>((resolve) => {
              releaseCleanup = resolve;
            });
          }
          return realRm(target, options);
        });

      await host.start();
      const checking = updater.check();
      await waitFor(() => releaseCleanup !== undefined);

      await updater.stop();
      releaseCleanup!();
      await checking;

      expect(downloadRequested).toBe(false);
      expect(updater.state()).toEqual({
        kind: "downloading",
        version: "0.17.0",
      });
    } finally {
      releaseCleanup?.();
      rmSpy?.mockRestore();
    }
  });
});

describe("updateInstallFor", () => {
  it("swaps the macOS bundle, runs the Windows setup and links elsewhere", () => {
    const none = () => false;
    expect(
      updateInstallFor(
        "darwin",
        "/Applications/Linger.app/Contents/MacOS/Linger",
        none,
      ),
    ).toEqual({
      kind: "app-bundle",
      appBundle: path.resolve("/Applications/Linger.app"),
    });
    const installed = "C:\\Users\\a\\AppData\\Local\\Programs\\Linger";
    expect(
      updateInstallFor(
        "win32",
        `${installed}\\Linger.exe`,
        (file) => file === `${installed}\\Uninstall Linger.exe`,
      ),
    ).toEqual({ kind: "windows-setup", installDir: installed });
    // The portable folder has no uninstaller.
    expect(updateInstallFor("win32", "D:\\Linger\\Linger.exe", none)).toEqual({
      kind: "download",
    });
    expect(updateInstallFor("linux", "/opt/linger/linger", none)).toEqual({
      kind: "download",
    });
  });
});

describe("appBundleOf", () => {
  it("finds the app bundle around the executable", () => {
    expect(appBundleOf("/Applications/Linger.app/Contents/MacOS/Linger")).toBe(
      path.resolve("/Applications/Linger.app"),
    );
    expect(appBundleOf("/usr/lib/electron/electron")).toBeUndefined();
  });
});

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};
