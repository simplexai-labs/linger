import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalReleaseDescriptor } from "@linger/local-installation/release-descriptor";
import { BundleStoreModule } from "./bundle-store.js";
import { ConfigStore } from "./config.js";
import { HealthWatchdogModule } from "./health-watchdog.js";
import { EventBus, ModuleHost } from "./modules.js";
import {
  ReleaseOrchestratorModule,
  diffReleaseModules,
  type ReleaseProgressUpdate,
} from "./release-orchestrator.js";
import { createV2DatabaseBackupHooks } from "./v2-db-backup.js";

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

function makeRelease(
  appVersion: string,
  hashes: Partial<Record<keyof LocalReleaseDescriptor["modules"], string>> = {},
  rollbackSafe = true,
): LocalReleaseDescriptor {
  const h = (mod: keyof LocalReleaseDescriptor["modules"]) =>
    (hashes[mod] ?? "1").padEnd(64, "0").slice(0, 64);
  const mk = (mod: keyof LocalReleaseDescriptor["modules"]) => ({
    artifactId: `${mod}-${h(mod).slice(0, 12)}`,
    originAppVersion: appVersion,
    sha256: h(mod),
    path: `store/${mod}/${mod}-${h(mod).slice(0, 12)}`,
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
      rollbackSafe,
    },
    infra: {
      node: "infra/node/v26",
      postgres: "infra/postgres/pg17",
      voiceTools: "infra/voice-tools/lk1",
      nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
    },
    modules: {
      web: mk("web"),
      backend: mk("backend"),
    },
  };
}

describe("ReleaseOrchestratorModule & HealthWatchdogModule", () => {
  it("classifies web-only diff as zero-downtime hot reload and backend diff as atomic drain restart", () => {
    const v1 = makeRelease("0.2.14");
    const v2Web = makeRelease("0.2.15", { web: "2" });
    const v2Backend = makeRelease("0.2.15", { backend: "2" });

    expect(diffReleaseModules(v1, v2Web)).toMatchObject({
      scope: "web",
      action: "reload-page",
      requiresDrain: false,
      changedModules: ["web"],
    });
    expect(diffReleaseModules(v1, v2Backend)).toMatchObject({
      scope: "backend",
      action: "restart-services",
      requiresDrain: true,
      changedModules: ["backend"],
    });
  });

  it("drains active tasks before backend restart, rolls back on failed health probe + restores DB backup, and auto-rolls back on post-commit crashes", async () => {
    const home = await makeTempDir("linger-orch-home-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    let activeOps = 1;
    let probeHealthy = false;
    const restarted: string[] = [];
    const backups: string[] = [];
    const restored: string[] = [];
    const rolledBackEvents: string[] = [];
    bus.on("release.rolled_back", (from, to) =>
      rolledBackEvents.push(`${from}->${to}`),
    );

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => activeOps,
      backupDatabase: async (ver) => {
        const file = `instances/desktop/backups/pre-${ver}.dump`;
        backups.push(file);
        return file;
      },
      restoreDatabase: async (file) => {
        restored.push(file);
      },
      restartServices: async (rel) => {
        restarted.push(rel.appVersion);
      },
      buildHealthProbes: () => [
        { name: "teamhub-healthz", check: async () => probeHealthy },
      ],
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
      observationWindowMs: 5_000,
      observationMaxCrashes: 2,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();

    // Seed 0.2.14 as current healthy release
    await store.writeReleaseDescriptor(makeRelease("0.2.14"));
    await store.beginPending({
      appVersion: "0.2.14",
      releaseFile: "releases/0.2.14/release.json",
      updatedAt: new Date().toISOString(),
    });
    await store.commitPending();

    // Stage 0.2.15 (non-rollbackSafe backend change) while activeOps=1
    await store.writeReleaseDescriptor(
      makeRelease("0.2.15", { backend: "2" }, false),
    );
    await orch.onBundleStaged("0.2.15");
    expect(orch.state().kind).toBe("ready");

    // Attempt apply while busy -> enters waiting!
    expect(await orch.applyStaged()).toBe(false);
    expect(orch.state().kind).toBe("waiting");

    // Drain completes, probe fails -> backs up DB, fails healthcheck, restores DB, rolls back to 0.2.14 & denylists 0.2.15!
    activeOps = 0;
    expect(await orch.applyStaged()).toBe(false);
    expect(backups).toEqual(["instances/desktop/backups/pre-0.2.15.dump"]);
    expect(restored).toEqual(["instances/desktop/backups/pre-0.2.15.dump"]);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.isDenylisted("0.2.15")).toBe(true);
    expect(rolledBackEvents).toContain("0.2.15->0.2.14");

    // Stage 0.2.16 (healthy at gate), commit succeeds, then 2 crashes in observation window trigger automatic rollback!
    probeHealthy = true;
    await store.writeReleaseDescriptor(makeRelease("0.2.16", { backend: "3" }));
    await orch.onBundleStaged("0.2.16");
    expect(await orch.applyStaged()).toBe(true);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.16");
    expect(watchdog.isObserving("0.2.16")).toBe(true);

    // 1st crash does not rollback yet; 2nd crash triggers automatic rollback to 0.2.14!
    expect(await watchdog.recordCrash("node-services", "OOM")).toBe(false);
    expect(await watchdog.recordCrash("node-services", "OOM")).toBe(true);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.14");
    expect(await store.isDenylisted("0.2.16")).toBe(true);
    expect(rolledBackEvents).toContain("0.2.16->0.2.14");
    // Post-commit crash rollback must NEVER call restoreDatabase
    expect(restored).toEqual(["instances/desktop/backups/pre-0.2.15.dump"]);

    // Stage 0.2.17 (non-rollbackSafe, healthy at gate so it commits with a backup file),
    // then crashes post-commit: MUST NEVER call restoreDatabase (data-loss guard) and
    // must flag manualRecoveryRequired while preserving the backup path.
    await store.writeReleaseDescriptor(
      makeRelease("0.2.17", { backend: "4" }, false),
    );
    await orch.onBundleStaged("0.2.17");
    expect(await orch.applyStaged()).toBe(true);
    expect(backups).toContain("instances/desktop/backups/pre-0.2.17.dump");
    expect((await store.readCurrent())?.appVersion).toBe("0.2.17");
    const restoresBeforeWatchdog = restored.length;

    expect(await watchdog.recordCrash("teamhub", "panic")).toBe(false);
    expect(await watchdog.recordCrash("teamhub", "panic")).toBe(true);
    expect(restored.length).toBe(restoresBeforeWatchdog);
    expect(await store.isDenylisted("0.2.17")).toBe(true);
    expect((await store.readCurrent())?.appVersion).toBe("0.2.17");
    expect(orch.rollbackNotice()).toMatchObject({
      fromVersion: "0.2.17",
      toVersion: "0.2.17",
      manualRecoveryRequired: true,
      dbBackupFile: "instances/desktop/backups/pre-0.2.17.dump",
    });

    await host.stop("quit");
  });

  it("runs unified stop-and-swap with progress updates for web-only, backend-only, and rollback paths", async () => {
    const home = await makeTempDir("linger-orch-progress-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    const progressEvents: ReleaseProgressUpdate[] = [];
    const switchedCalls: Array<{
      version: string;
      changed: readonly string[];
    }> = [];
    const completedVersions: string[] = [];
    const rolledBackComplete: string[] = [];
    let probeHealthy = true;

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      restartServices: async (release, changed) => {
        switchedCalls.push({ version: release.appVersion, changed });
      },
      buildHealthProbes: () => [
        { name: "service-healthz", check: async () => probeHealthy },
      ],
      onProgress: (p) => progressEvents.push(p),
      onComplete: (rel) => {
        completedVersions.push(rel.appVersion);
      },
      onRollbackComplete: (notice) => {
        rolledBackComplete.push(`${notice.fromVersion}->${notice.toVersion}`);
      },
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      // Seed baseline 0.1.10-v2test.0
      await store.writeReleaseDescriptor(makeRelease("0.1.10-v2test.0"));
      await store.beginPending({
        appVersion: "0.1.10-v2test.0",
        releaseFile: "releases/0.1.10-v2test.0/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      // 1. Web-only update goes through unified stop-and-swap + full progress sequence
      await store.writeReleaseDescriptor(
        makeRelease("0.1.10-v2test.1", { web: "2" }),
      );
      await orch.onBundleStaged("0.1.10-v2test.1");
      expect(await orch.applyStaged()).toBe(true);
      expect(switchedCalls).toEqual([
        { version: "0.1.10-v2test.1", changed: ["web"] },
      ]);
      expect(progressEvents.map((e) => [e.stage, e.percent, e.tone])).toEqual([
        ["preparing", 10, "normal"],
        ["stopping", 25, "normal"],
        ["switching", 45, "normal"],
        ["verifying", 75, "normal"],
        ["complete", 100, "normal"],
      ]);
      expect(completedVersions).toEqual(["0.1.10-v2test.1"]);

      // 2. Backend-only update succeeds with identical progress pipeline
      progressEvents.length = 0;
      await store.writeReleaseDescriptor(
        makeRelease("0.1.10-v2test.2", { web: "2", backend: "2" }),
      );
      await orch.onBundleStaged("0.1.10-v2test.2");
      expect(await orch.applyStaged()).toBe(true);
      expect(switchedCalls.at(-1)).toEqual({
        version: "0.1.10-v2test.2",
        changed: ["backend"],
      });
      expect(progressEvents.map((e) => [e.stage, e.percent, e.tone])).toEqual([
        ["preparing", 10, "normal"],
        ["stopping", 25, "normal"],
        ["switching", 45, "normal"],
        ["verifying", 75, "normal"],
        ["complete", 100, "normal"],
      ]);

      // 3. Faulty backend update fails health gate -> emits rollback tone progress, restores 0.1.10-v2test.2, denylists .3
      progressEvents.length = 0;
      probeHealthy = false;
      await store.writeReleaseDescriptor(
        makeRelease("0.1.10-v2test.3", { web: "2", backend: "3" }),
      );
      await orch.onBundleStaged("0.1.10-v2test.3");
      expect(await orch.applyStaged()).toBe(false);
      expect(progressEvents.map((e) => [e.stage, e.tone])).toEqual([
        ["preparing", "normal"],
        ["stopping", "normal"],
        ["switching", "normal"],
        ["verifying", "normal"],
        ["rolling_back", "rollback"],
        ["rolled_back", "rollback"],
      ]);
      expect((await store.readCurrent())?.appVersion).toBe("0.1.10-v2test.2");
      expect(await store.isDenylisted("0.1.10-v2test.3")).toBe(true);
      expect(rolledBackComplete).toEqual(["0.1.10-v2test.3->0.1.10-v2test.2"]);
    } finally {
      await host.stop("quit");
    }
  });

  it("restores Shell baseline services and verifies baseline probes when first upgrade fails (previousRelease === undefined)", async () => {
    const home = await makeTempDir("linger-orch-baseline-rollback-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    const events: string[] = [];
    const baselineRestored: string[][] = [];
    const probeReleases: Array<string | undefined> = [];
    let baselineRestoredFlag = false;
    const progressStages: Array<[string, string]> = [];
    const notices: Array<{ fromVersion: string; toVersion: string }> = [];

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      restartServices: async (release, changed) => {
        events.push(`restart:${release.appVersion}:${changed.join(",")}`);
      },
      restoreBaselineServices: async (changed) => {
        events.push(`restoreBaseline:${changed.join(",")}`);
        baselineRestored.push([...changed]);
        baselineRestoredFlag = true;
      },
      buildHealthProbes: (release) => {
        probeReleases.push(release?.appVersion);
        return [
          {
            name: release ? "v2-node-services" : "baseline-node-services",
            check: async () => (release ? false : baselineRestoredFlag),
          },
        ];
      },
      onProgress: (p) => {
        progressStages.push([p.stage, p.tone]);
        events.push(`progress:${p.stage}`);
      },
      onRollbackComplete: (notice) => {
        notices.push({
          fromVersion: notice.fromVersion,
          toVersion: notice.toVersion,
        });
        events.push(`rollbackComplete:${notice.toVersion}`);
      },
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      // No state/current.json exists yet (upgrading from Shell baseline for the first time).
      expect(await store.currentRelease()).toBeUndefined();

      await store.writeReleaseDescriptor(makeRelease("0.1.10-v2test.0"));
      await orch.onBundleStaged("0.1.10-v2test.0");
      expect(await orch.applyStaged()).toBe(false);

      expect(await store.readCurrent()).toBeUndefined();
      expect(await store.readPending()).toBeUndefined();
      expect(await store.isDenylisted("0.1.10-v2test.0")).toBe(true);
      expect(baselineRestored).toEqual([["web", "backend"]]);
      expect(probeReleases).toEqual(["0.1.10-v2test.0", undefined]);
      expect(notices).toEqual([
        { fromVersion: "0.1.10-v2test.0", toVersion: "baseline" },
      ]);
      expect(progressStages).toEqual([
        ["preparing", "normal"],
        ["stopping", "normal"],
        ["switching", "normal"],
        ["verifying", "normal"],
        ["rolling_back", "rollback"],
        ["rolled_back", "rollback"],
      ]);
      expect(events.indexOf("restoreBaseline:web,backend")).toBeLessThan(
        events.indexOf("progress:rolled_back"),
      );
      expect(events.indexOf("progress:rolled_back")).toBeLessThan(
        events.indexOf("rollbackComplete:baseline"),
      );
    } finally {
      await host.stop("quit");
    }
  });

  it("preserves waiting state on duplicate/newer staged polls and auto-applies when runtime.activity reaches 0", async () => {
    const home = await makeTempDir("linger-orch-waiting-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    let activeOps = 1;
    const restarted: string[] = [];
    const committed: string[] = [];
    bus.on("release.committed", (v) => committed.push(v));

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => activeOps,
      restartServices: async (rel) => {
        restarted.push(rel.appVersion);
      },
      buildHealthProbes: () => [{ name: "healthz", check: async () => true }],
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      // Seed baseline 0.1.11-v2test.0
      await store.writeReleaseDescriptor(makeRelease("0.1.11-v2test.0"));
      await store.beginPending({
        appVersion: "0.1.11-v2test.0",
        releaseFile: "releases/0.1.11-v2test.0/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      // (a) Re-staging same version while waiting preserves waiting and auto-applies at activity 0.
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.2", { backend: "2" }),
      );
      await orch.onBundleStaged("0.1.11-v2test.2");
      expect(orch.state().kind).toBe("ready");

      expect(await orch.applyStaged()).toBe(false);
      expect(orch.state()).toMatchObject({
        kind: "waiting",
        version: "0.1.11-v2test.2",
      });

      await orch.onBundleStaged("0.1.11-v2test.2");
      expect(orch.state()).toMatchObject({
        kind: "waiting",
        version: "0.1.11-v2test.2",
      });

      activeOps = 0;
      bus.emit("runtime.activity", 0);
      await vi.waitFor(() => {
        expect(committed).toEqual(["0.1.11-v2test.2"]);
      });
      expect(orch.state()).toEqual({ kind: "idle" });
      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.2");

      // (b) Staging a newer version while waiting keeps waiting with updated version/diff and auto-applies the newer version when idle.
      activeOps = 1;
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.3", { backend: "3" }),
      );
      await orch.onBundleStaged("0.1.11-v2test.3");
      expect(await orch.applyStaged()).toBe(false);
      expect(orch.state()).toMatchObject({
        kind: "waiting",
        version: "0.1.11-v2test.3",
        diff: { changedModules: ["backend"], scope: "backend" },
      });

      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.4", { web: "2", backend: "4" }),
      );
      await orch.onBundleStaged("0.1.11-v2test.4");
      expect(orch.state()).toMatchObject({
        kind: "waiting",
        version: "0.1.11-v2test.4",
        diff: { changedModules: ["web", "backend"], scope: "backend" },
      });

      activeOps = 0;
      bus.emit("runtime.activity", 0);
      await vi.waitFor(() => {
        expect(committed).toEqual(["0.1.11-v2test.2", "0.1.11-v2test.4"]);
      });
      expect(restarted).toEqual(["0.1.11-v2test.2", "0.1.11-v2test.4"]);
      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.4");
    } finally {
      await host.stop("quit");
    }
  });

  it("does not clobber applying state on synchronous or async-raced onBundleStaged calls", async () => {
    const home = await makeTempDir("linger-orch-applying-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    let releaseVoiceCheck!: () => void;
    let enteredVoiceCheck!: () => void;
    const voiceCheckEntered = new Promise<void>((resolve) => {
      enteredVoiceCheck = resolve;
    });
    const voiceCheckGate = new Promise<void>((resolve) => {
      releaseVoiceCheck = resolve;
    });

    let releaseRestart!: () => void;
    let enteredRestart!: () => void;
    const restartEntered = new Promise<void>((resolve) => {
      enteredRestart = resolve;
    });
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      isVoiceIdle: async () => {
        enteredVoiceCheck();
        await voiceCheckGate;
        return true;
      },
      restartServices: async () => {
        enteredRestart();
        await restartGate;
      },
      buildHealthProbes: () => [{ name: "healthz", check: async () => true }],
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      await store.writeReleaseDescriptor(makeRelease("0.1.11-v2test.0"));
      await store.beginPending({
        appVersion: "0.1.11-v2test.0",
        releaseFile: "releases/0.1.11-v2test.0/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.2", { backend: "2" }),
      );
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.3", { backend: "3" }),
      );
      await orch.onBundleStaged("0.1.11-v2test.2");

      // Delay store.readRelease for the raced 0.1.11-v2test.3 staging call so it starts
      // while state is still "ready" and completes AFTER applyStaged enters "applying".
      const origReadRelease = store.readRelease.bind(store);
      let releaseRacedRead!: () => void;
      const racedReadGate = new Promise<void>((resolve) => {
        releaseRacedRead = resolve;
      });
      let enteredRacedRead!: () => void;
      const racedReadEntered = new Promise<void>((resolve) => {
        enteredRacedRead = resolve;
      });
      vi.spyOn(store, "readRelease").mockImplementation(async (version) => {
        if (version === "0.1.11-v2test.3") {
          enteredRacedRead();
          await racedReadGate;
        }
        return origReadRelease(version);
      });

      const applyPromise = orch.applyStaged();
      await voiceCheckEntered;

      // Start an async-raced onBundleStaged before applying begins.
      const racedStagePromise = orch.onBundleStaged("0.1.11-v2test.3");
      await racedReadEntered;

      // Let applyStaged transition into "applying" and pause inside restartServices.
      releaseVoiceCheck();
      await restartEntered;
      expect(orch.state()).toMatchObject({
        kind: "applying",
        version: "0.1.11-v2test.2",
      });

      // Synchronous onBundleStaged while applying must be ignored immediately.
      await orch.onBundleStaged("0.1.11-v2test.2");
      expect(orch.state()).toMatchObject({
        kind: "applying",
        version: "0.1.11-v2test.2",
      });

      // Resolving the async-raced onBundleStaged must also NOT clobber "applying".
      releaseRacedRead();
      await racedStagePromise;
      expect(orch.state()).toMatchObject({
        kind: "applying",
        version: "0.1.11-v2test.2",
      });

      // Finish applying -> commits 0.1.11-v2test.2 cleanly and returns to idle (not clobbered by .3).
      releaseRestart();
      expect(await applyPromise).toBe(true);
      expect(orch.state()).toEqual({ kind: "idle" });
      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.2");
      expect(await orch.applyStaged()).toBe(false);
    } finally {
      await host.stop("quit");
    }
  });

  it("invokes dynamic pg_dump and pg_restore via local instance config during rollbackSafe:false rollback when TEAMHUB_DATABASE_URL is unset", async () => {
    const home = await makeTempDir("linger-orch-dynamic-db-");
    const instanceDir = path.join(home, "instances", "desktop");
    await mkdir(instanceDir, { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(instanceDir, "instance.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "desktop",
        mode: "source-native",
        root: instanceDir,
        port: 3000,
        source: {
          repo: path.join(home, "source"),
          ports: {
            web: 3000,
            teamhub: 8080,
            nodeServices: 8081,
            document: 8082,
            postgres: 54777,
          },
        },
      }),
      "utf8",
    );
    await writeFile(
      path.join(instanceDir, "services.env"),
      "LINGER_POSTGRES_PASSWORD=orch-local-db-secret\n",
      "utf8",
    );

    const pgRoot = path.join(
      home,
      "tools",
      "native",
      "components",
      "c".repeat(64),
    );
    await mkdir(path.join(pgRoot, "bin"), { recursive: true });
    await mkdir(path.join(pgRoot, "lib"), { recursive: true });
    const exe = process.platform === "win32" ? ".exe" : "";
    await writeFile(path.join(pgRoot, "bin", `pg_dump${exe}`), "", "utf8");
    await writeFile(path.join(pgRoot, "bin", `pg_restore${exe}`), "", "utf8");

    const invokedTools: Array<{
      file: string;
      args: readonly string[];
      password: string | undefined;
    }> = [];
    const dbHooks = createV2DatabaseBackupHooks({
      getHome: () => home,
      log: noopLog,
      env: {},
      exec: async (file, args, opts) => {
        invokedTools.push({
          file,
          args,
          password: opts.env.PGPASSWORD,
        });
        const fileIdx = args.indexOf("--file");
        if (fileIdx >= 0 && args[fileIdx + 1]) {
          await writeFile(args[fileIdx + 1]!, "PGDMP", "utf8");
        }
        return { stdout: "", stderr: "" };
      },
    });

    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();
    const restarted: string[] = [];

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      backupDatabase: dbHooks.backupDatabase,
      restoreDatabase: dbHooks.restoreDatabase,
      restartServices: async (rel) => {
        restarted.push(rel.appVersion);
      },
      buildHealthProbes: (rel) => [
        {
          name: "teamhub-healthz",
          check: async () => rel?.appVersion === "0.1.11-v2test.2",
        },
      ],
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.2", { backend: "2" }),
      );
      await store.beginPending({
        appVersion: "0.1.11-v2test.2",
        releaseFile: "releases/0.1.11-v2test.2/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.3", { backend: "3" }, false),
      );
      await orch.onBundleStaged("0.1.11-v2test.3");
      expect(await orch.applyStaged()).toBe(false);

      expect(invokedTools).toHaveLength(2);
      expect(invokedTools[0]?.file).toBe(
        path.join(pgRoot, "bin", `pg_dump${exe}`),
      );
      expect(invokedTools[0]?.password).toBe("orch-local-db-secret");
      expect(invokedTools[0]?.args.join(" ")).not.toContain(
        "orch-local-db-secret",
      );
      expect(invokedTools[1]?.file).toBe(
        path.join(pgRoot, "bin", `pg_restore${exe}`),
      );
      expect(invokedTools[1]?.password).toBe("orch-local-db-secret");
      expect(invokedTools[1]?.args.join(" ")).toContain(
        "pre-0.1.11-v2test.3.dump",
      );
      expect((await store.readCurrent())?.appVersion).toBe("0.1.11-v2test.2");
      expect(await store.isDenylisted("0.1.11-v2test.3")).toBe(true);
      expect(restarted).toEqual(["0.1.11-v2test.3", "0.1.11-v2test.2"]);
    } finally {
      await host.stop("quit");
    }
  });

  it("aborts cleanly without rolling back or restarting services when pre-flight backupDatabase fails, and skips restore when backupDatabase returns undefined", async () => {
    const home = await makeTempDir("linger-orch-preflight-");
    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();

    let backupMode: "throw" | "undefined" = "throw";
    const restarted: string[] = [];
    const restored: string[] = [];
    const aborts: Array<{ version: string; reason: string }> = [];

    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      backupDatabase: async () => {
        if (backupMode === "throw") {
          throw new Error("pg_dump exited 1");
        }
        return undefined;
      },
      restoreDatabase: async (file) => {
        restored.push(file);
      },
      restartServices: async (rel) => {
        restarted.push(rel.appVersion);
      },
      buildHealthProbes: () => [
        { name: "teamhub-healthz", check: async () => false },
      ],
      onAbort: (version, reason) => {
        aborts.push({ version, reason });
      },
      completePauseMs: 0,
      rollbackPauseMs: 0,
      healthGateTimeoutMs: 60,
      healthGateIntervalMs: 15,
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
        watchdog,
        orch,
      ],
      { config, log: noopLog, bus },
    );
    await host.start();
    try {
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.2", { backend: "2" }),
      );
      await store.beginPending({
        appVersion: "0.1.11-v2test.2",
        releaseFile: "releases/0.1.11-v2test.2/release.json",
        updatedAt: new Date().toISOString(),
      });
      await store.commitPending();

      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.3", { backend: "3" }, false),
      );
      await orch.onBundleStaged("0.1.11-v2test.3");

      // Pre-flight pg_dump failure aborts before beginPending: no restart, no restore, no denylist, state returns to ready.
      expect(await orch.applyStaged()).toBe(false);
      expect(restarted).toEqual([]);
      expect(restored).toEqual([]);
      expect(await store.readPending()).toBeUndefined();
      expect(await store.isDenylisted("0.1.11-v2test.3")).toBe(false);
      expect(orch.state()).toMatchObject({
        kind: "ready",
        version: "0.1.11-v2test.3",
      });
      expect(aborts).toEqual([
        { version: "0.1.11-v2test.3", reason: "pg_dump exited 1" },
      ]);

      // Thin Client skip (backupDatabase returns undefined) proceeds without setting dbBackupFile or calling restoreDatabase.
      backupMode = "undefined";
      expect(await orch.applyStaged()).toBe(false);
      expect(restarted).toEqual(["0.1.11-v2test.3", "0.1.11-v2test.2"]);
      expect(restored).toEqual([]);
      expect(await store.isDenylisted("0.1.11-v2test.3")).toBe(true);
    } finally {
      await host.stop("quit");
    }
  });
});
