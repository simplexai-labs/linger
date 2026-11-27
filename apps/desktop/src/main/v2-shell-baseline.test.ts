import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { packDeterministicTarZst } from "../../scripts/build-app-bundles.mjs";
import {
  buildShellSeedManifest,
  resolveDbSchemaEpoch,
  writeShellSeedManifest,
} from "../../scripts/build-shell-seed-manifest.mjs";
import { planBundleBuilds } from "../../scripts/compute-bundle-inputs.mjs";
import { BundleStoreModule } from "./bundle-store.js";
import { BundleUpdaterModule } from "./bundle-updater.js";
import { ConfigStore } from "./config.js";
import { HealthWatchdogModule } from "./health-watchdog.js";
import { EventBus, ModuleHost } from "./modules.js";
import { ReleaseOrchestratorModule } from "./release-orchestrator.js";
import type { AppManifestV3 } from "./update-manifest.js";
import { resolveColdStartDaemonLaunch } from "./v2-runtime-helpers.js";

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

describe("Zero-bloat shell-baseline seed & hybrid Shell+Store lifecycle", () => {
  it("generates a lightweight (<2 KB) shell-baseline seed-manifest matching compute-bundle-inputs and falls back cleanly without .git", async () => {
    const outDir = await makeTempDir("linger-shell-seed-out-");
    const outFile = path.join(outDir, "seed-manifest.json");
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");

    const written = await writeShellSeedManifest({
      repoRoot,
      outFile,
      appVersion: "0.1.11-v2test.0",
    });
    expect(written.bytes).toBeLessThan(2048);
    expect(written.manifest.schema).toBe(1);
    expect(written.manifest.mode).toBe("shell-baseline");
    expect(written.manifest.appVersion).toBe("0.1.11-v2test.0");
    expect(written.manifest.infra.node).toBe("bundled");
    expect(written.manifest.bundles.web.artifactId).toBe("shell-baseline");
    expect(written.manifest.bundles.backend.artifactId).toBe("shell-baseline");

    const plan = planBundleBuilds(repoRoot, { ref: "HEAD" });
    expect(written.manifest.bundles.web.inputHash).toBe(
      plan.bundles.web?.inputHash,
    );
    expect(written.manifest.bundles.backend.inputHash).toBe(
      plan.bundles.backend?.inputHash,
    );
    expect(written.manifest.compat.minNativeDepsHash).toBe(plan.nativeDepsHash);
    const derivedEpoch = resolveDbSchemaEpoch(repoRoot);
    expect(derivedEpoch).toBeGreaterThanOrEqual(896);
    expect(written.manifest.compat.dbSchemaEpoch).toBe(derivedEpoch);
    expect(written.manifest.infra.nodeDeps).toBe(
      `infra/node-deps/${plan.nativeDepsShortId}`,
    );

    // Works cleanly on a source tree with no .git directory (fs fallback) and
    // falls back to 0 when apps/teamhub/migrations is absent.
    const fakeRepo = await makeTempDir("linger-nogit-repo-");
    await mkdir(path.join(fakeRepo, "apps/web"), { recursive: true });
    await writeFile(
      path.join(fakeRepo, "apps/web/index.html"),
      "<html></html>",
      "utf8",
    );
    await writeFile(path.join(fakeRepo, ".node-version"), "26.6.0\n", "utf8");
    expect(resolveDbSchemaEpoch(fakeRepo)).toBe(0);
    const noGitManifest = buildShellSeedManifest({
      repoRoot: fakeRepo,
      appVersion: "0.2.0",
      ref: "HEAD",
    });
    expect(noGitManifest.mode).toBe("shell-baseline");
    expect(noGitManifest.compat.dbSchemaEpoch).toBe(0);
    expect(noGitManifest.bundles.web.inputHash).toMatch(/^[0-9a-f]{64}$/);

    // Derives highest numeric migration prefix when apps/teamhub/migrations exists.
    await mkdir(path.join(fakeRepo, "apps/teamhub/migrations"), {
      recursive: true,
    });
    await writeFile(
      path.join(fakeRepo, "apps/teamhub/migrations/00105_init.sql"),
      "",
      "utf8",
    );
    await writeFile(
      path.join(fakeRepo, "apps/teamhub/migrations/00912_latest.sql"),
      "",
      "utf8",
    );
    await writeFile(
      path.join(fakeRepo, "apps/teamhub/migrations/embed.go"),
      "",
      "utf8",
    );
    expect(resolveDbSchemaEpoch(fakeRepo)).toBe(912);
    expect(
      buildShellSeedManifest({
        repoRoot: fakeRepo,
        appVersion: "0.2.0",
        ref: "HEAD",
      }).compat.dbSchemaEpoch,
    ).toBe(912);
  }, 15_000);

  it("seeds lazily post-setup, upgrades seed only on newer Shell, performs 0B backend pure-Web first update, cold-starts hybrid daemon from Shell, and rolls back to hybrid Shell backend", async () => {
    const home = await makeTempDir("linger-hybrid-home-");
    const seedDir = await makeTempDir("linger-hybrid-seed-");
    const payloadWeb = await makeTempDir("linger-hybrid-web-");
    const payloadBackend = await makeTempDir("linger-hybrid-backend-");
    const payloadNodeDeps = await makeTempDir("linger-hybrid-ndeps-");
    const packOut = await makeTempDir("linger-hybrid-out-");

    await writeFile(path.join(payloadWeb, "index.html"), "web-v1", "utf8");
    await writeFile(path.join(payloadBackend, "teamhub"), "backend-v2", "utf8");
    await writeFile(path.join(payloadNodeDeps, "marker.txt"), "ndeps", "utf8");

    const webV1Pack = await packDeterministicTarZst(payloadWeb, packOut, "web");
    const backendV2Pack = await packDeterministicTarZst(
      payloadBackend,
      packOut,
      "backend",
    );
    const nodeDepsPack = await packDeterministicTarZst(
      payloadNodeDeps,
      packOut,
      "node-native-deps",
    );
    const webV1Bytes = await readFile(webV1Pack.filePath);
    const backendV2Bytes = await readFile(backendV2Pack.filePath);
    const nodeDepsBytes = await readFile(nodeDepsPack.filePath);

    const webSeedHash = "1".repeat(64);
    const backendSeedHash = "2".repeat(64);
    const nativeDepsHash = `sha256:${"a".repeat(64)}`;
    const nativeDepsShortId = `nd-${"a".repeat(16)}`;

    const writeSeed = async (appVersion: string) => {
      await writeFile(
        path.join(seedDir, "seed-manifest.json"),
        JSON.stringify({
          schema: 1,
          mode: "shell-baseline",
          appVersion,
          channel: "stable",
          compat: {
            minShellVersion: appVersion,
            minNativeDepsHash: nativeDepsHash,
            runnerGatewayProtocol: 1,
            dbSchemaEpoch: 1,
            rollbackSafe: true,
          },
          infra: {
            node: "bundled",
            postgres: "bundled",
            voiceTools: "bundled",
            nodeDeps: `infra/node-deps/${nativeDepsShortId}`,
          },
          bundles: {
            web: { artifactId: "shell-baseline", inputHash: webSeedHash },
            backend: {
              artifactId: "shell-baseline",
              inputHash: backendSeedHash,
            },
            "node-native-deps": {
              artifactId: "shell-baseline",
              inputHash: nativeDepsHash,
            },
          },
        }),
        "utf8",
      );
    };
    await writeSeed("0.1.11-v2test.0");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const publicPem = publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const mkRef = (id: string, pack: typeof webV1Pack) => ({
      artifactId: `${id}-${pack.sha256.slice(0, 12)}`,
      format: "tar.zst" as const,
      url: `https://cdn.example.com/linger/bundles/${id}/${pack.fileName}`,
      sha256: pack.sha256,
      size: pack.size,
    });

    // Step 1: pure-Web update (backend inputHash matches Shell baseline, minNativeDepsHash matches).
    const webOnlyManifest: AppManifestV3 = {
      schema: 3,
      channel: "stable",
      releaseId: "r-0.1.11-v2test.1",
      appVersion: "0.1.11-v2test.1",
      publishedAt: "2026-11-27T06:00:00Z",
      rollout: { percent: 100 },
      compat: {
        minShellVersion: "0.1.11-v2test.0",
        minNativeDepsHash: nativeDepsHash,
        runnerGatewayProtocol: 1,
        dbSchemaEpoch: 1,
        rollbackSafe: true,
      },
      bundles: {
        web: {
          arch: "noarch",
          originAppVersion: "0.1.11-v2test.1",
          inputHash: "9".repeat(64),
          artifact: mkRef("web", webV1Pack),
        },
        backend: {
          arch: "per-target",
          originAppVersion: "0.1.11-v2test.0",
          inputHash: backendSeedHash,
          nativeDepsHash,
          targets: { "darwin-arm64": mkRef("backend", backendV2Pack) },
        },
        "node-native-deps": {
          arch: "per-target",
          originAppVersion: "0.1.11-v2test.0",
          inputHash: "3".repeat(64),
          targets: { "darwin-arm64": mkRef("node-native-deps", nodeDepsPack) },
        },
      },
    };

    // Step 2: backend update (backend inputHash mutated -> downloads backend + node-native-deps).
    const backendManifest: AppManifestV3 = {
      ...webOnlyManifest,
      releaseId: "r-0.1.11-v2test.2",
      appVersion: "0.1.11-v2test.2",
      bundles: {
        ...webOnlyManifest.bundles,
        backend: {
          arch: "per-target",
          originAppVersion: "0.1.11-v2test.2",
          inputHash: "8".repeat(64),
          nativeDepsHash,
          targets: { "darwin-arm64": mkRef("backend", backendV2Pack) },
        },
      },
    };

    const signedWeb = makeSignedPayload(webOnlyManifest, privateKey);
    const signedBackend = makeSignedPayload(backendManifest, privateKey);
    let activeSigned = signedWeb;

    // Start before Setup Wizard finishes -> shouldImportSeed / isLocalMode are false.
    let localReady = false;
    const fetchedUrls: string[] = [];
    const restarted: Array<{
      version: string;
      backendSource?: string;
      webSource?: string;
      changed: readonly string[];
    }> = [];
    let probeHealthy = true;

    const store = new BundleStoreModule({
      home,
      seedDirectory: seedDir,
      target: "darwin-arm64",
      shouldImportSeed: () => localReady,
    });
    const updater = new BundleUpdaterModule({
      shellVersion: "0.1.11-v2test.0",
      target: "darwin-arm64",
      enabled: true,
      isLocalMode: () => localReady,
      checkDelayMs: 60 * 60_000,
      publicKey: publicPem,
      fetch: async (input) => {
        const url = input.toString();
        fetchedUrls.push(url);
        if (url.endsWith("/app-manifest.json")) {
          return new Response(new Uint8Array(activeSigned.bytes), {
            status: 200,
          });
        }
        if (url.endsWith("/app-manifest.json.sig")) {
          return new Response(activeSigned.sig, { status: 200 });
        }
        if (url.includes("/bundles/web/")) {
          return new Response(new Uint8Array(webV1Bytes), { status: 200 });
        }
        if (url.includes("/bundles/backend/")) {
          return new Response(new Uint8Array(backendV2Bytes), { status: 200 });
        }
        return new Response(new Uint8Array(nodeDepsBytes), { status: 200 });
      },
    });
    const watchdog = new HealthWatchdogModule();
    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      restartServices: async (release, changed) => {
        restarted.push({
          version: release.appVersion,
          backendSource: release.modules.backend.source,
          webSource: release.modules.web.source,
          changed,
        });
      },
      buildHealthProbes: (release) => [
        {
          name: "teamhub-healthz",
          check: async () =>
            probeHealthy || release?.appVersion === "0.1.11-v2test.1",
        },
      ],
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
    });
    const config = new ConfigStore(path.join(home, "config.json"), {
      updateFeedUrl: "https://cdn.example.com/linger",
      installId: "hybrid-test-install",
    });
    const bus = new EventBus();
    const host = new ModuleHost(
      [
        {
          name: "Config",
          dependsOn: [],
          start: async () => {},
          stop: async () => {},
        },
        store,
        watchdog,
        updater,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      // Before Setup Wizard completes: NOT seeded yet.
      expect(await store.readCurrent()).toBeUndefined();

      // Setup Wizard completes -> first updater.check() triggers ensureSeeded() AND downloads ONLY web (0B backend, 0B node-native-deps).
      localReady = true;
      await updater.check();

      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.0");
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.1.11-v2test.1",
        changedModules: ["web"],
      });
      expect(fetchedUrls.filter((u) => u.includes("/bundles/"))).toHaveLength(
        1,
      );
      expect(fetchedUrls.some((u) => u.includes("/bundles/web/"))).toBe(true);
      expect(fetchedUrls.some((u) => u.includes("/bundles/backend/"))).toBe(
        false,
      );
      expect(
        fetchedUrls.some((u) => u.includes("/bundles/node-native-deps/")),
      ).toBe(false);

      // Orchestrator classifies the first pure-Web update as scope="web", reload-page, requiresDrain=false!
      await orch.onBundleStaged("0.1.11-v2test.1");
      expect(orch.state()).toMatchObject({
        kind: "ready",
        version: "0.1.11-v2test.1",
        diff: {
          changedModules: ["web"],
          scope: "web",
          action: "reload-page",
          requiresDrain: false,
        },
      });
      expect(await orch.applyStaged()).toBe(true);
      const hybridCurrent = await store.currentRelease();
      expect(hybridCurrent?.appVersion).toBe("0.1.11-v2test.1");
      expect(hybridCurrent?.modules.web.source).toBe("store");
      expect(hybridCurrent?.modules.backend.source).toBe("shell");

      // Cold-start daemon resolver boots Shell daemon when backend.source === "shell".
      const coldStart = await resolveColdStartDaemonLaunch({
        home,
        shellDaemonPath:
          "/Applications/Linger.app/Contents/Resources/computer/linger-computer-daemon",
        shellTeamhubCliDirectory:
          "/Applications/Linger.app/Contents/Resources/app/dist/teamhub-cli",
        env: {},
      });
      expect(coldStart.source).toBe("shell");
      expect(coldStart.daemonPath).toBe(
        "/Applications/Linger.app/Contents/Resources/computer/linger-computer-daemon",
      );

      // ensureSeeded with older/equal seed must NOT overwrite 0.1.11-v2test.1.
      expect(await store.ensureSeeded()).toBe(false);
      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.1");

      // Backend update 0.1.11-v2test.2 downloads backend + node-native-deps, fails health probe, and rolls back to hybrid 0.1.11-v2test.1 (restoring Shell backend while keeping web in store).
      fetchedUrls.length = 0;
      activeSigned = signedBackend;
      probeHealthy = false;
      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.1.11-v2test.2",
        changedModules: ["node-native-deps", "backend"],
      });
      await orch.onBundleStaged("0.1.11-v2test.2");
      expect(await orch.applyStaged()).toBe(false);

      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.1");
      expect(restarted.at(-1)).toEqual({
        version: "0.1.11-v2test.1",
        backendSource: "shell",
        webSource: "store",
        changed: ["backend"],
      });

      // Shell upgrade (seed 0.2.0 > current 0.1.11-v2test.1) re-seeds cleanly.
      await writeSeed("0.2.0");
      expect(await store.ensureSeeded()).toBe(true);
      expect((await store.readCurrent())?.appVersion).toBe("0.2.0");
    } finally {
      await host.stop("quit");
    }
  });
});
