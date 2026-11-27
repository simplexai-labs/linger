import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { packDeterministicTarZst } from "../../scripts/build-app-bundles.mjs";
import { BundleStoreModule } from "./bundle-store.js";
import { BundleUpdaterModule } from "./bundle-updater.js";
import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";
import type { AppManifestV3 } from "./update-manifest.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function makeSignedPayload(manifest: AppManifestV3, privateKey: KeyObject) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  const sig = sign(null, bytes, privateKey).toString("base64");
  return { bytes, sig };
}

describe("BundleUpdaterModule", () => {
  it("downloads only changed modules, falls back to mirror on primary failure, and skips cached modules", async () => {
    const home = await makeTempDir("linger-updater-home-");
    const payloadV1 = await makeTempDir("linger-updater-p1-");
    const payloadV2 = await makeTempDir("linger-updater-p2-");
    const out = await makeTempDir("linger-updater-out-");

    await writeFile(path.join(payloadV1, "index.html"), "v1", "utf8");
    await writeFile(path.join(payloadV2, "index.html"), "v2", "utf8");

    const basePack = await packDeterministicTarZst(payloadV1, out, "shared");
    const webV2Pack = await packDeterministicTarZst(payloadV2, out, "web");
    const baseBytes = await readFile(basePack.filePath);
    const webV2Bytes = await readFile(webV2Pack.filePath);

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const config = new ConfigStore(path.join(home, "config.json"), {
      updateFeedUrl: "https://cdn.example.com/linger",
      updateChannel: "stable",
      installId: "stable-test-install",
    });
    const bus = new EventBus();
    const stagedEvents: Array<{ version: string; changed: readonly string[] }> =
      [];
    bus.on("bundle.staged", (v, changed) =>
      stagedEvents.push({ version: v, changed }),
    );

    const fetchedUrls: string[] = [];
    const nodeDepsHash = `sha256:${"a".repeat(64)}`;
    const nodeDepsShortId = `nd-${"a".repeat(16)}`;

    const mkRef = (
      id: string,
      pack: typeof basePack,
      primaryBroken = false,
    ) => ({
      artifactId: `${id}-${pack.sha256.slice(0, 12)}`,
      format: "tar.zst" as const,
      url: primaryBroken
        ? `https://broken.example.com/${id}.tar.zst`
        : `https://cdn.example.com/linger/bundles/${id}/${id}.tar.zst`,
      ...(primaryBroken
        ? {
            mirrors: [
              `https://mirror.example.com/linger/bundles/${id}/${id}.tar.zst`,
            ],
          }
        : {}),
      sha256: pack.sha256,
      size: pack.size,
    });

    const manifestV2: AppManifestV3 = {
      schema: 3,
      channel: "stable",
      releaseId: "r-0.2.15",
      appVersion: "0.2.15",
      publishedAt: "2026-11-24T12:00:00Z",
      rollout: { percent: 100 },
      compat: {
        minShellVersion: "0.2.0",
        minNativeDepsHash: nodeDepsHash,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 892,
        rollbackSafe: true,
      },
      bundles: {
        web: {
          arch: "noarch",
          originAppVersion: "0.2.15",
          inputHash: "1".repeat(64),
          artifact: mkRef("web", webV2Pack, true), // primary fails -> mirror succeeds!
        },
        backend: {
          arch: "per-target",
          originAppVersion: "0.2.14",
          inputHash: "2".repeat(64),
          nativeDepsHash: nodeDepsHash,
          targets: { "darwin-arm64": mkRef("backend", basePack) },
        },
        "node-native-deps": {
          arch: "per-target",
          originAppVersion: "0.2.0",
          inputHash: "3".repeat(64),
          targets: { "darwin-arm64": mkRef("node-native-deps", basePack) },
        },
      },
    };
    const signed = makeSignedPayload(manifestV2, privateKey);

    const mockFetch: typeof fetch = async (input) => {
      const url = input.toString();
      fetchedUrls.push(url);
      if (url.endsWith("/app-manifest.json")) {
        return new Response(new Uint8Array(signed.bytes), { status: 200 });
      }
      if (url.endsWith("/app-manifest.json.sig")) {
        return new Response(signed.sig, { status: 200 });
      }
      if (url.startsWith("https://broken.example.com/")) {
        return new Response("down", { status: 503 });
      }
      if (url.includes("/web/")) {
        return new Response(new Uint8Array(webV2Bytes), { status: 200 });
      }
      return new Response(new Uint8Array(baseBytes), { status: 200 });
    };

    const updater = new BundleUpdaterModule({
      shellVersion: "0.2.0",
      target: "darwin-arm64",
      enabled: true,
      checkDelayMs: 60 * 60_000,
      fetch: mockFetch,
      publicKey: publicPem,
    });

    const host = new ModuleHost(
      [
        {
          name: "Config",
          dependsOn: [],
          start: async () => {},
          stop: async () => {},
        },
        store,
        updater,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();

    // Pre-populate backend + node-native-deps in BundleStore!
    await store.stageNodeDepsArchive(
      nodeDepsShortId,
      basePack.filePath,
      basePack.sha256,
    );
    await store.stageModuleArchive(
      "backend",
      `backend-${basePack.sha256.slice(0, 12)}`,
      basePack.filePath,
      basePack.sha256,
    );

    await updater.check();

    expect(updater.state()).toEqual({
      kind: "staged",
      version: "0.2.15",
      changedModules: ["web"],
    });
    expect(stagedEvents).toEqual([{ version: "0.2.15", changed: ["web"] }]);
    // Mirror was used for web, and ZERO other bundles were downloaded!
    expect(fetchedUrls).toContain("https://broken.example.com/web.tar.zst");
    expect(fetchedUrls).toContain(
      "https://mirror.example.com/linger/bundles/web/web.tar.zst",
    );
    expect(fetchedUrls.some((u) => u.includes("/backend/"))).toBe(false);
    expect(fetchedUrls.some((u) => u.includes("/node-native-deps/"))).toBe(
      false,
    );

    await host.stop("quit");
  });

  it("skips denylisted versions and defers when rollout percent is 0", async () => {
    const home = await makeTempDir("linger-updater-gate-");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const config = new ConfigStore(path.join(home, "config.json"), {
      updateFeedUrl: "https://cdn.example.com/linger",
      installId: "install-abc",
    });

    const dummyRef = {
      artifactId: "x-111111111111",
      format: "tar.zst" as const,
      url: "https://cdn.example.com/x.tar.zst",
      sha256: "a".repeat(64),
      size: 10,
    };
    const manifest: AppManifestV3 = {
      schema: 3,
      channel: "stable",
      releaseId: "r-0.2.20",
      appVersion: "0.2.20",
      publishedAt: "2026-11-24T12:00:00Z",
      rollout: { percent: 0 },
      compat: {
        minShellVersion: "0.2.0",
        minNativeDepsHash: `sha256:${"a".repeat(64)}`,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 892,
        rollbackSafe: true,
      },
      bundles: {
        web: {
          arch: "noarch",
          originAppVersion: "0.2.20",
          inputHash: "1".repeat(64),
          artifact: dummyRef,
        },
        backend: {
          arch: "per-target",
          originAppVersion: "0.2.20",
          inputHash: "2".repeat(64),
          targets: { "darwin-arm64": dummyRef },
        },
        "node-native-deps": {
          arch: "per-target",
          originAppVersion: "0.2.0",
          inputHash: "3".repeat(64),
          targets: { "darwin-arm64": dummyRef },
        },
      },
    };
    const signed = makeSignedPayload(manifest, privateKey);

    const updater = new BundleUpdaterModule({
      shellVersion: "0.2.0",
      target: "darwin-arm64",
      checkDelayMs: 60 * 60_000,
      publicKey: publicPem,
      fetch: async (url) =>
        url.toString().endsWith(".sig")
          ? new Response(signed.sig, { status: 200 })
          : new Response(new Uint8Array(signed.bytes), { status: 200 }),
    });
    const host = new ModuleHost(
      [
        {
          name: "Config",
          dependsOn: [],
          start: async () => {},
          stop: async () => {},
        },
        store,
        updater,
      ],
      { config, log: noopLog, bus: new EventBus() },
    );
    await host.start();

    // Deferred due to rollout.percent = 0
    await updater.check();
    expect(updater.state()).toEqual({ kind: "idle" });

    // Denylisted version is also skipped even when urgent
    await store.addDenylist({
      appVersion: "0.2.20",
      failedAt: new Date().toISOString(),
      stage: "crash-watchdog",
      reason: "bad build",
    });
    expect(await store.isDenylisted("0.2.20")).toBe(true);
    await host.stop("quit");
  });

  it("stays idle with zero fetches or seed imports in Thin Client mode (P1-2)", async () => {
    const home = await makeTempDir("linger-thin-home-");
    const seedDir = await makeTempDir("linger-thin-seed-");
    let fetchCalls = 0;
    const store = new BundleStoreModule({
      home,
      seedDirectory: seedDir,
      target: "darwin-arm64",
      shouldImportSeed: () => false,
    });
    const config = new ConfigStore(path.join(home, "config.json"));
    config.update({
      serverUrl: "https://remote.linger.example",
      updateFeedUrl: "https://cdn.example.com/linger",
    });
    const updater = new BundleUpdaterModule({
      shellVersion: "0.2.0",
      target: "darwin-arm64",
      checkDelayMs: 60 * 60_000,
      isLocalMode: () => false,
      fetch: async () => {
        fetchCalls += 1;
        return new Response("unexpected", { status: 500 });
      },
    });
    const host = new ModuleHost(
      [
        {
          name: "Config",
          dependsOn: [],
          start: async () => {},
          stop: async () => {},
        },
        store,
        updater,
      ],
      { config, log: noopLog, bus: new EventBus() },
    );
    await host.start();
    await updater.check();
    expect(fetchCalls).toBe(0);
    expect(updater.state()).toEqual({ kind: "idle" });
    expect(await store.readCurrent()).toBeUndefined();
    await host.stop("quit");
  });

  it("resets long retry backoff timer back to checkIntervalMs after a manual check() succeeds", async () => {
    const home = await makeTempDir("linger-backoff-home-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const config = new ConfigStore(path.join(home, "config.json"), {
      updateFeedUrl: "https://cdn.example.com/linger",
    });

    let failFetch = true;
    let manifestChecks = 0;
    const updater = new BundleUpdaterModule({
      shellVersion: "0.2.0",
      target: "darwin-arm64",
      enabled: true,
      checkDelayMs: 20,
      retryDelayMs: 60_000,
      checkIntervalMs: 80,
      fetch: async (input) => {
        if (input.toString().endsWith("/app-manifest.json")) {
          manifestChecks += 1;
        }
        if (failFetch) {
          throw new TypeError("fetch failed");
        }
        return new Response("not found", { status: 404 });
      },
    });
    const host = new ModuleHost(
      [
        {
          name: "Config",
          dependsOn: [],
          start: async () => {},
          stop: async () => {},
        },
        store,
        updater,
      ],
      { config, log: noopLog, bus: new EventBus() },
    );
    await host.start();
    try {
      // Initial scheduled check fails and enters 60s retry backoff.
      await vi.waitFor(
        () => {
          expect(manifestChecks).toBeGreaterThanOrEqual(1);
          expect(updater.state().kind).toBe("failed");
        },
        { timeout: 1_000 },
      );
      expect(updater.lastCheckSucceeded()).toBe(false);

      // Manual check succeeds -> must cancel 60s backoff and reschedule at 80ms.
      failFetch = false;
      const beforeManual = manifestChecks;
      await updater.check();
      expect(updater.state()).toEqual({ kind: "idle" });
      expect(updater.lastCheckSucceeded()).toBe(true);
      expect(manifestChecks).toBe(beforeManual + 1);

      // Next scheduled poll fires quickly at ~checkIntervalMs (not 60s).
      await vi.waitFor(
        () => {
          expect(manifestChecks).toBeGreaterThanOrEqual(beforeManual + 2);
        },
        { timeout: 1_500 },
      );
    } finally {
      await host.stop("quit");
    }
  });

  it("does not re-emit bundle.staged on repeated polls for an intact staged release, and re-stages when removed, rolled back, or superseded", async () => {
    const home = await makeTempDir("linger-updater-dedup-home-");
    const payloadV1 = await makeTempDir("linger-updater-dedup-p1-");
    const payloadV2 = await makeTempDir("linger-updater-dedup-p2-");
    const payloadV3 = await makeTempDir("linger-updater-dedup-p3-");
    const out = await makeTempDir("linger-updater-dedup-out-");

    await writeFile(path.join(payloadV1, "index.html"), "v1", "utf8");
    await writeFile(path.join(payloadV2, "index.html"), "v2", "utf8");
    await writeFile(path.join(payloadV3, "index.html"), "v3", "utf8");

    const basePack = await packDeterministicTarZst(payloadV1, out, "shared");
    const backendV2Pack = await packDeterministicTarZst(
      payloadV2,
      out,
      "backend-v2",
    );
    const backendV3Pack = await packDeterministicTarZst(
      payloadV3,
      out,
      "backend-v3",
    );
    const baseBytes = await readFile(basePack.filePath);
    const backendV2Bytes = await readFile(backendV2Pack.filePath);
    const backendV3Bytes = await readFile(backendV3Pack.filePath);

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const nodeDepsHash = `sha256:${"a".repeat(64)}`;
    const nodeDepsShortId = `nd-${"a".repeat(16)}`;

    const mkRef = (id: string, pack: typeof basePack, fileName: string) => ({
      artifactId: `${id}-${pack.sha256.slice(0, 12)}`,
      format: "tar.zst" as const,
      url: `https://cdn.example.com/linger/bundles/${id}/${fileName}.tar.zst`,
      sha256: pack.sha256,
      size: pack.size,
    });

    const makeManifest = (
      appVersion: string,
      backendPack: typeof basePack,
      backendFile: string,
    ): AppManifestV3 => ({
      schema: 3,
      channel: "stable",
      releaseId: `r-${appVersion}`,
      appVersion,
      publishedAt: "2026-11-24T12:00:00Z",
      rollout: { percent: 100 },
      compat: {
        minShellVersion: "0.2.0",
        minNativeDepsHash: nodeDepsHash,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 892,
        rollbackSafe: true,
      },
      bundles: {
        web: {
          arch: "noarch",
          originAppVersion: "0.2.14",
          inputHash: "1".repeat(64),
          artifact: mkRef("web", basePack, "web-base"),
        },
        backend: {
          arch: "per-target",
          originAppVersion: appVersion,
          inputHash: "2".repeat(64),
          nativeDepsHash: nodeDepsHash,
          targets: {
            "darwin-arm64": mkRef("backend", backendPack, backendFile),
          },
        },
        "node-native-deps": {
          arch: "per-target",
          originAppVersion: "0.2.0",
          inputHash: "3".repeat(64),
          targets: {
            "darwin-arm64": mkRef("node-native-deps", basePack, "ndeps-base"),
          },
        },
      },
    });

    const signedV2 = makeSignedPayload(
      makeManifest("0.2.15", backendV2Pack, "backend-v2"),
      privateKey,
    );
    const signedV3 = makeSignedPayload(
      makeManifest("0.2.16", backendV3Pack, "backend-v3"),
      privateKey,
    );
    let activeSigned = signedV2;

    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const config = new ConfigStore(path.join(home, "config.json"), {
      updateFeedUrl: "https://cdn.example.com/linger",
      updateChannel: "stable",
      installId: "dedup-test-install",
    });
    const bus = new EventBus();
    const stagedEvents: Array<{ version: string; changed: readonly string[] }> =
      [];
    bus.on("bundle.staged", (version, changed) =>
      stagedEvents.push({ version, changed }),
    );

    const updater = new BundleUpdaterModule({
      shellVersion: "0.2.0",
      target: "darwin-arm64",
      enabled: true,
      checkDelayMs: 60 * 60_000,
      publicKey: publicPem,
      fetch: async (input) => {
        const url = input.toString();
        if (url.endsWith("/app-manifest.json")) {
          return new Response(new Uint8Array(activeSigned.bytes), {
            status: 200,
          });
        }
        if (url.endsWith("/app-manifest.json.sig")) {
          return new Response(activeSigned.sig, { status: 200 });
        }
        if (url.includes("backend-v2.tar.zst")) {
          return new Response(new Uint8Array(backendV2Bytes), { status: 200 });
        }
        if (url.includes("backend-v3.tar.zst")) {
          return new Response(new Uint8Array(backendV3Bytes), { status: 200 });
        }
        return new Response(new Uint8Array(baseBytes), { status: 200 });
      },
    });

    const host = new ModuleHost(
      [
        {
          name: "Config",
          dependsOn: [],
          start: async () => {},
          stop: async () => {},
        },
        store,
        updater,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      await store.stageNodeDepsArchive(
        nodeDepsShortId,
        basePack.filePath,
        basePack.sha256,
      );
      await store.stageModuleArchive(
        "web",
        `web-${basePack.sha256.slice(0, 12)}`,
        basePack.filePath,
        basePack.sha256,
      );

      // First poll stages 0.2.15 and emits bundle.staged once.
      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.2.15",
        changedModules: ["backend"],
      });
      expect(updater.lastCheckSucceeded()).toBe(true);
      expect(stagedEvents).toEqual([
        { version: "0.2.15", changed: ["backend"] },
      ]);

      // Second poll for the same intact release MUST NOT re-emit bundle.staged.
      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.2.15",
        changedModules: ["backend"],
      });
      expect(updater.lastCheckSucceeded()).toBe(true);
      expect(stagedEvents).toHaveLength(1);

      // Deleting the release descriptor from store causes the next poll to re-stage and emit.
      await rm(path.join(store.releasesDir, "0.2.15"), {
        recursive: true,
        force: true,
      });
      await updater.check();
      expect(stagedEvents).toHaveLength(2);
      expect(stagedEvents[1]?.version).toBe("0.2.15");

      // Rollback + denylist resets state to idle and skips the denylisted version on next poll.
      await store.addDenylist({
        appVersion: "0.2.15",
        failedAt: new Date().toISOString(),
        stage: "healthcheck",
        reason: "simulated failure",
      });
      bus.emit("release.rolled_back", "0.2.15", "0.2.14", "simulated failure");
      expect(updater.state()).toEqual({ kind: "idle" });
      await updater.check();
      expect(updater.state()).toEqual({ kind: "idle" });
      expect(stagedEvents).toHaveLength(2);

      // Switching feed to a newer version 0.2.16 stages it and emits bundle.staged.
      activeSigned = signedV3;
      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.2.16",
        changedModules: ["backend"],
      });
      expect(stagedEvents).toHaveLength(3);
      expect(stagedEvents[2]).toEqual({
        version: "0.2.16",
        changed: ["backend"],
      });

      // Committing 0.2.16 resets updater state back to idle.
      bus.emit("release.committed", "0.2.16");
      expect(updater.state()).toEqual({ kind: "idle" });
    } finally {
      await host.stop("quit");
    }
  });
});
