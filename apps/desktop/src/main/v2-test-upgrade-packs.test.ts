import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildV2TestUpgradePacks,
  deriveStepVersions,
  verifyV2TestUpgradeKit,
} from "../../scripts/build-v2-test-upgrade-packs.mjs";
import { createTestFeedServer } from "../../scripts/serve-v2-test-feed.mjs";
import { BundleStoreModule } from "./bundle-store.js";
import { BundleUpdaterModule } from "./bundle-updater.js";
import { ConfigStore } from "./config.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  compareVersions,
  evaluateShellCompatibility,
  resolveArtifactUrl,
  type AppManifestV3,
} from "./update-manifest.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  delete process.env.LINGER_UPDATE_FEED_URL;
  delete process.env.LINGER_UPDATE_CHANNEL;
  delete process.env.LINGER_ALLOW_LOOPBACK_TEST_FEED;
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

describe("V2 (2+1) signed test upgrade packs & portable feed server", () => {
  it("derives deterministic SemVer-monotonic 5-step versions within 0.1.11-v2test.0..4 above 0.1.10 and 0.1.11-mobile.1", () => {
    const v2test = deriveStepVersions("0.1.11-v2test.0");
    expect(v2test).toEqual({
      "step-00-baseline": "0.1.11-v2test.0",
      "step-01-web": "0.1.11-v2test.1",
      "step-02-backend": "0.1.11-v2test.2",
      "step-03-rollback-faulty": "0.1.11-v2test.3",
      "step-04-fence-node-faulty": "0.1.11-v2test.4",
    });

    expect(compareVersions("0.1.11-v2test.0", "0.1.10")).toBeGreaterThan(0);
    expect(
      compareVersions("0.1.11-v2test.0", "0.1.11-mobile.1"),
    ).toBeGreaterThan(0);

    const ordered = Object.values(v2test);
    for (let i = 1; i < ordered.length; i += 1) {
      expect(compareVersions(ordered[i]!, ordered[i - 1]!)).toBeGreaterThan(0);
    }
  });

  it("resolves portable relative bundle paths against any feed URL while keeping https URLs intact", () => {
    expect(
      resolveArtifactUrl(
        "http://127.0.0.1:8787",
        "bundles/web/web-1234567890ab.tar.zst",
      ).toString(),
    ).toBe("http://127.0.0.1:8787/bundles/web/web-1234567890ab.tar.zst");
    expect(
      resolveArtifactUrl(
        "https://192.168.1.50:8443/feed/",
        "bundles/backend/backend-darwin-arm64-abcdef123456.tar.zst",
      ).toString(),
    ).toBe(
      "https://192.168.1.50:8443/feed/bundles/backend/backend-darwin-arm64-abcdef123456.tar.zst",
    );
    expect(
      resolveArtifactUrl(
        "http://127.0.0.1:8787",
        "https://cdn.example.com/bundles/web/web-1234567890ab.tar.zst",
      ).toString(),
    ).toBe("https://cdn.example.com/bundles/web/web-1234567890ab.tar.zst");
  });

  it("builds all 5 signed 2+1 steps, verifies exact 1/3 diffs, and serves incremental updates over live HTTP feed", async () => {
    const kitDir = await makeTempDir("linger-v2-kit-");
    const home = await makeTempDir("linger-v2-home-");
    const tinyWeb = await makeTempDir("linger-v2-web-");
    const tinyInstaller = await makeTempDir("linger-v2-inst-");
    const tinyNativeDeps = await makeTempDir("linger-v2-ndeps-");
    await writeFile(
      path.join(tinyWeb, "index.html"),
      "<!doctype html><html><body>Linger Base Web</body></html>",
      "utf8",
    );
    await writeFile(
      path.join(tinyInstaller, "installer.js"),
      "export const v = 'base';\n",
      "utf8",
    );
    for (const target of ["darwin-arm64", "win32-x64", "linux-x64"]) {
      const pdfDir = path.join(
        tinyNativeDeps,
        target,
        "node_modules",
        "pdfjs-dist",
      );
      await mkdir(pdfDir, { recursive: true });
      await writeFile(
        path.join(pdfDir, "package.json"),
        JSON.stringify({ name: "pdfjs-dist", version: "4.0.0" }),
        "utf8",
      );
      await writeFile(
        path.join(tinyNativeDeps, target, "models.json"),
        JSON.stringify({ packages: {} }),
        "utf8",
      );
    }

    const built = await buildV2TestUpgradePacks({
      outDir: kitDir,
      baseVersion: "0.1.11-v2test.0",
      baseUrl: "relative",
      ephemeralTestKey: true,
      macosSigned: true,
      windowsSigned: true,
      webDistDir: tinyWeb,
      installerDistDir: tinyInstaller,
      nodeNativeDepsDir: tinyNativeDeps,
    });

    expect(built.verification.ok).toBe(true);
    expect(built.verification.stepCount).toBe(5);
    expect(built.verification.steps.every((s) => s.signatureVerified)).toBe(
      true,
    );

    // Every step's minShellVersion MUST be satisfied by the 0.1.11-v2test.0 test shell!
    for (const step of built.index.steps) {
      const manifest = JSON.parse(
        await readFile(
          path.join(kitDir, "steps", step.id, "app-manifest.json"),
          "utf8",
        ),
      ) as AppManifestV3;
      expect(manifest.compat.minShellVersion).toBe("0.1.11-v2test.0");
      expect(evaluateShellCompatibility(manifest, "0.1.11-v2test.0")).toEqual({
        status: "compatible",
      });
    }

    const publicKeyPem = await readFile(
      path.join(kitDir, "test-public-key.pem"),
      "utf8",
    );
    const reVerified = await verifyV2TestUpgradeKit(kitDir, {
      publicKeyPem,
      requireSignatures: true,
    });
    expect(reVerified.ok).toBe(true);

    const server = await createTestFeedServer({
      rootDir: kitDir,
      initialStep: "00",
      host: "127.0.0.1",
      port: 0,
      quiet: true,
    });

    try {
      const store = new BundleStoreModule({ home, target: "darwin-arm64" });
      const config = new ConfigStore(path.join(home, "config.json"), {
        installId: "real-device-test-install",
      });
      const bus = new EventBus();
      const updater = new BundleUpdaterModule({
        shellVersion: "0.1.11-v2test.0",
        target: "darwin-arm64",
        enabled: true,
        checkDelayMs: 60 * 60_000,
        publicKey: publicKeyPem,
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

      // 1. Without LINGER_ALLOW_LOOPBACK_TEST_FEED=1, http://127.0.0.1 MUST be refused!
      process.env.LINGER_UPDATE_FEED_URL = server.feedUrl;
      await updater.check();
      expect(updater.state().kind).toBe("failed");

      // 2. Enable loopback test feed flag -> step-00-baseline downloads all 3 bundles (web + backend + node-native-deps)
      process.env.LINGER_ALLOW_LOOPBACK_TEST_FEED = "1";
      await updater.check();
      expect(updater.state()).toEqual({
        kind: "staged",
        version: "0.1.11-v2test.0",
        changedModules: ["node-native-deps", "web", "backend"],
      });
      await store.beginPending({
        appVersion: "0.1.11-v2test.0",
        releaseFile: "releases/0.1.11-v2test.0/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      // 3. Switch live through step-01 (web), step-02 (backend), step-03 (faulty teamhub),
      //    and step-04 (real teamhub + crashing node-services):
      //    each step MUST download strictly 1/3 bundle (0B for the other 2)!
      for (const [stepNum, expectedVersion, expectedMod] of [
        ["01", "0.1.11-v2test.1", "web"],
        ["02", "0.1.11-v2test.2", "backend"],
        ["03", "0.1.11-v2test.3", "backend"],
        ["04", "0.1.11-v2test.4", "backend"],
      ] as const) {
        const sw = await fetch(
          `${server.feedUrl}/__test/switch?step=${stepNum}`,
          { method: "POST" },
        );
        expect(sw.ok).toBe(true);
        await fetch(`${server.feedUrl}/__test/reset-log`, { method: "POST" });
        await updater.check();
        expect(updater.state()).toEqual({
          kind: "staged",
          version: expectedVersion,
          changedModules: [expectedMod],
        });
        const dl = server
          .getDownloadHistory()
          .filter((h) => h.path.startsWith("/bundles/"));
        expect(dl).toHaveLength(1);
        expect(dl[0]?.path).toContain(`/bundles/${expectedMod}/`);

        await store.beginPending({
          appVersion: expectedVersion,
          releaseFile: `releases/${expectedVersion}/release.json`,
          updatedAt: new Date().toISOString(),
        });
        await store.commitPending();
      }

      // Confirm step-03 and step-04 descriptors carry rollbackSafe: false
      const step3Desc = await store.readRelease("0.1.11-v2test.3");
      expect(step3Desc?.compat.rollbackSafe).toBe(false);
      const step4Desc = await store.readRelease("0.1.11-v2test.4");
      expect(step4Desc?.compat.rollbackSafe).toBe(false);
      expect(step4Desc?.compat.dbSchemaEpoch).toBe(
        step3Desc?.compat.dbSchemaEpoch,
      );

      // Verify step-04 extracted backend ships the crashing node-services stub
      // (exit 43) paired with the non-faulty teamhub payload.
      const step4BackendDir = path.join(home, step4Desc!.modules.backend.path);
      const step4Supervisor = await readFile(
        path.join(step4BackendDir, "node-services", "dist", "supervisor.js"),
        "utf8",
      );
      expect(step4Supervisor).toContain(
        "[V2-TEST-FAULTY-NODE-SERVICES-0.1.11-v2test.4]",
      );
      expect(step4Supervisor).toContain("process.exit(43)");
      const step4Meta = JSON.parse(
        await readFile(
          path.join(step4BackendDir, "v2-service-version.json"),
          "utf8",
        ),
      ) as { faulty: boolean; faultyNodeServices: boolean };
      expect(step4Meta.faulty).toBe(false);
      expect(step4Meta.faultyNodeServices).toBe(true);

      await host.stop("quit");
    } finally {
      await server.close();
    }
  }, 60_000);
});
