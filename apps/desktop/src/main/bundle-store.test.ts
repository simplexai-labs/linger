import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalReleaseDescriptor } from "@linger/local-installation/release-descriptor";
import { packDeterministicTarZst } from "../../scripts/build-app-bundles.mjs";
import { BundleStoreModule } from "./bundle-store.js";
import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";

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

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

async function startStore(home: string, seedDirectory?: string) {
  const store = new BundleStoreModule({
    home,
    seedDirectory,
    target: "darwin-arm64",
  });
  const config = new ConfigStore(path.join(home, "desktop-config.json"));
  const host = new ModuleHost(
    [
      {
        name: "Config",
        dependsOn: [],
        start: async () => {},
        stop: async () => {},
      },
      store,
    ],
    { config, log: noopLog, bus: new EventBus() },
  );
  await host.start();
  return { store, host };
}

function makeDescriptor(
  appVersion: string,
  artifactSuffix: string,
  nodeDepsId = "nd-aaaaaaaaaaaaaaaa",
): LocalReleaseDescriptor {
  const mk = (mod: string) => ({
    artifactId: `${mod}-${artifactSuffix}`,
    originAppVersion: appVersion,
    sha256: artifactSuffix.padEnd(64, "0").slice(0, 64),
    path: `store/${mod}/${mod}-${artifactSuffix}`,
  });
  return {
    schema: 1,
    appVersion,
    channel: "stable",
    installedAt: new Date().toISOString(),
    source: "incremental-update",
    compat: {
      minShellVersion: "0.2.0",
      minNativeDepsHash: `sha256:${"a".repeat(64)}`,
      runnerGatewayProtocol: 1,
      dbSchemaEpoch: 892,
      rollbackSafe: true,
    },
    infra: {
      node: "infra/node/v26",
      postgres: "infra/postgres/pg17",
      voiceTools: "infra/voice-tools/lk1",
      nodeDeps: `infra/node-deps/${nodeDepsId}`,
    },
    modules: {
      web: mk("web"),
      backend: mk("backend"),
    },
  };
}

describe("BundleStoreModule", () => {
  it("stages .tar.zst archives with SHA-256 verification and supports atomic pointer promotion + rollback", async () => {
    const home = await makeTempDir("linger-store-home-");
    const src = await makeTempDir("linger-store-src-");
    const out = await makeTempDir("linger-store-out-");

    await writeFile(path.join(src, "index.html"), "<h1>Linger V2</h1>", "utf8");
    const packed = await packDeterministicTarZst(src, out, "web");

    const { store } = await startStore(home);
    const extracted = await store.stageModuleArchive(
      "web",
      packed.artifactId,
      packed.filePath,
      packed.sha256,
    );
    expect(await readFile(path.join(extracted, "index.html"), "utf8")).toBe(
      "<h1>Linger V2</h1>",
    );
    expect(
      await store.hasVerifiedModule("web", packed.artifactId, packed.sha256),
    ).toBe(true);

    // Rejects wrong sha256
    await expect(
      store.stageModuleArchive(
        "web",
        "web-bad",
        packed.filePath,
        "f".repeat(64),
      ),
    ).rejects.toThrow("digest mismatch");

    // Promote 0.2.14 -> 0.2.15 -> rollback to 0.2.14 + denylist 0.2.15
    await store.writeReleaseDescriptor(
      makeDescriptor("0.2.14", "111111111111"),
    );
    await store.beginPending({
      appVersion: "0.2.14",
      releaseFile: "releases/0.2.14/release.json",
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");

    await store.writeReleaseDescriptor(
      makeDescriptor("0.2.15", "222222222222"),
    );
    await store.beginPending({
      appVersion: "0.2.15",
      releaseFile: "releases/0.2.15/release.json",
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();
    expect((await store.readCurrent())?.appVersion).toBe("0.2.15");
    expect((await store.readPrevious())?.appVersion).toBe("0.2.14");

    const restored = await store.rollbackToPrevious(
      "0.2.15",
      "crash-watchdog",
      "crashed twice",
    );
    expect(restored?.appVersion).toBe("0.2.14");
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.isDenylisted("0.2.15")).toBe(true);

    // Pre-commit failure of 0.2.16 must keep current at 0.2.14 (never double-downgrade to previous)
    await store.writeReleaseDescriptor(
      makeDescriptor("0.2.16", "333333333333"),
    );
    await store.beginPending({
      appVersion: "0.2.16",
      releaseFile: "releases/0.2.16/release.json",
      updatedAt: new Date().toISOString(),
    });
    const preCommitRolled = await store.rollbackToPrevious(
      "0.2.16",
      "healthcheck",
      "probe failed before commit",
    );
    expect(preCommitRolled?.appVersion).toBe("0.2.14");
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.readPending()).toBeUndefined();
    expect(await store.isDenylisted("0.2.16")).toBe(true);
  });

  it("imports offline seed on cold start and prunes unreferenced old modules in GC while protecting current + previous", async () => {
    const home = await makeTempDir("linger-seed-home-");
    const seedDir = await makeTempDir("linger-seed-dir-");
    const payloadDir = await makeTempDir("linger-seed-payload-");
    await writeFile(path.join(payloadDir, "hello.txt"), "seed-ok", "utf8");

    const bundleNames = ["web", "backend", "node-native-deps"] as const;
    const bundles: Record<string, unknown> = {};
    for (const name of bundleNames) {
      const packed = await packDeterministicTarZst(payloadDir, seedDir, name);
      bundles[name] = {
        artifactId: packed.artifactId,
        file: packed.fileName,
        sha256: packed.sha256,
        bytes: packed.size,
      };
    }
    await writeFile(
      path.join(seedDir, "seed-manifest.json"),
      JSON.stringify({
        schema: 1,
        appVersion: "0.2.0",
        channel: "stable",
        target: "darwin-arm64",
        compat: {
          minShellVersion: "0.2.0",
          minNativeDepsHash: `sha256:${"a".repeat(64)}`,
          runnerGatewayProtocol: 1,
          dbSchemaEpoch: 892,
          rollbackSafe: true,
        },
        infra: {
          node: "infra/node/v26",
          postgres: "infra/postgres/pg17",
          voiceTools: "infra/voice-tools/lk1",
          nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
        },
        bundles,
      }),
    );

    const { store } = await startStore(home, seedDir);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.0");
    expect(
      existsSync(
        path.join(home, "infra/node-deps/nd-aaaaaaaaaaaaaaaa/verified.json"),
      ),
    ).toBe(true);

    // Create an unreferenced old release + old store module + old node-deps
    const staleRelDir = path.join(home, "releases/0.1.9");
    const staleModDir = path.join(home, "store/web/web-deadbeef0000");
    const staleDepsDir = path.join(home, "infra/node-deps/nd-deadbeef00000000");
    await mkdir(staleRelDir, { recursive: true });
    await mkdir(staleModDir, { recursive: true });
    await mkdir(staleDepsDir, { recursive: true });
    const oldTime = new Date(Date.now() - 48 * 60 * 60_000);
    await utimes(staleRelDir, oldTime, oldTime);
    await utimes(staleModDir, oldTime, oldTime);
    await utimes(staleDepsDir, oldTime, oldTime);

    const gc = await store.gc();
    expect(gc.removedReleases).toContain("0.1.9");
    expect(gc.removedModules).toContain("web/web-deadbeef0000");
    expect(gc.removedNodeDeps).toContain("nd-deadbeef00000000");
    // Current release 0.2.0 remains intact!
    expect(existsSync(path.join(home, "releases/0.2.0/release.json"))).toBe(
      true,
    );
  });

  it("cleans up corrupted pending.json on startup and rejects tar.zst path traversal entries", async () => {
    const home = await makeTempDir("linger-corrupt-home-");
    await mkdir(path.join(home, "state"), { recursive: true });
    await writeFile(
      path.join(home, "state/pending.json"),
      "{truncated-corrupt-json",
      "utf8",
    );

    const { store } = await startStore(home);
    expect(existsSync(path.join(home, "state/pending.json"))).toBe(false);

    // Build a minimal POSIX ustar archive containing a `../escape.txt` entry
    const header = Buffer.alloc(512, 0);
    const name = "../escape.txt";
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100, "utf8");
    header.write("0000000\0", 108, "utf8");
    header.write("0000000\0", 116, "utf8");
    header.write("00000000005\0", 124, "utf8");
    header.write("00000000000\0", 136, "utf8");
    header.fill(0x20, 148, 156);
    header.write("0", 156, "utf8");
    header.write("ustar\0", 257, "utf8");
    header.write("00", 263, "utf8");
    let checksum = 0;
    for (let i = 0; i < 512; i++) checksum += header[i]!;
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, "utf8");
    const body = Buffer.alloc(512, 0);
    body.write("pwned", 0, "utf8");
    const trailer = Buffer.alloc(1024, 0);
    const rawTar = Buffer.concat([header, body, trailer]);
    const zstBytes = zstdCompressSync(rawTar);
    const archivePath = path.join(home, "evil.tar.zst");
    await writeFile(archivePath, zstBytes);
    const sha = createHash("sha256").update(zstBytes).digest("hex");

    await expect(
      store.stageModuleArchive("web", "web-evil00000000", archivePath, sha),
    ).rejects.toThrow("Unsafe tar archive entry rejected");
  });

  it("resolves the active V2 backend daemon binary when present and tracks release transitions", async () => {
    const home = await makeTempDir("linger-daemon-home-");
    const { store } = await startStore(home);

    // No active V2 release yet -> fall back to Shell-bundled daemon.
    expect(await store.currentDaemonExecutable("darwin")).toBeUndefined();

    // Active release without a computer-daemon binary -> still falls back.
    const v1 = makeDescriptor("0.2.14", "111111111111");
    await store.writeReleaseDescriptor(v1);
    await store.beginPending({
      appVersion: v1.appVersion,
      releaseFile: `releases/${v1.appVersion}/release.json`,
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();
    expect(await store.currentDaemonExecutable("darwin")).toBeUndefined();

    // Once the backend bundle carries computer-daemon/linger-computer-daemon, it wins.
    const v1Daemon = path.join(
      home,
      v1.modules.backend.path,
      "computer-daemon",
      "linger-computer-daemon",
    );
    await mkdir(path.dirname(v1Daemon), { recursive: true });
    await writeFile(v1Daemon, "#!/bin/sh\n", "utf8");
    expect(await store.currentDaemonExecutable("darwin")).toBe(v1Daemon);
    expect(await store.currentDaemonExecutable("win32")).toBeUndefined();

    // Upgrading to v2 immediately points probes to the v2 backend daemon.
    const v2 = makeDescriptor("0.2.15", "222222222222");
    const v2DaemonWin = path.join(
      home,
      v2.modules.backend.path,
      "computer-daemon",
      "linger-computer-daemon.exe",
    );
    await mkdir(path.dirname(v2DaemonWin), { recursive: true });
    await writeFile(v2DaemonWin, "MZ", "utf8");
    await store.writeReleaseDescriptor(v2);
    await store.beginPending({
      appVersion: v2.appVersion,
      releaseFile: `releases/${v2.appVersion}/release.json`,
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();
    expect(await store.currentDaemonExecutable("win32")).toBe(v2DaemonWin);
    expect(await store.currentDaemonExecutable("darwin")).toBeUndefined();

    // Rolling back restores v1's daemon path.
    await store.rollbackToPrevious("0.2.15", "healthcheck", "failed");
    expect(await store.currentDaemonExecutable("darwin")).toBe(v1Daemon);
  });

  it("manages upgrade-write-fence lifecycle and clears stale fence on startup crash recovery", async () => {
    const home = await makeTempDir("linger-fence-home-");
    const { store, host } = await startStore(home);
    try {
      expect(existsSync(store.upgradeWriteFencePath)).toBe(false);
      const fencePath = await store.enableUpgradeWriteFence("0.1.11-v2test.4");
      expect(fencePath).toBe(path.join(home, "state", "upgrade-write-fence"));
      expect(existsSync(fencePath)).toBe(true);
      await store.clearUpgradeWriteFence();
      expect(existsSync(fencePath)).toBe(false);

      // Leave a stale fence behind as if the previous process crashed mid-switch.
      await store.enableUpgradeWriteFence("0.1.11-v2test.4");
      expect(existsSync(fencePath)).toBe(true);
    } finally {
      await host.stop("quit");
    }

    const restarted = await startStore(home);
    try {
      expect(existsSync(restarted.store.upgradeWriteFencePath)).toBe(false);
    } finally {
      await restarted.host.stop("quit");
    }
  });
});
