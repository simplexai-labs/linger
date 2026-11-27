import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalReleaseDescriptor } from "@linger/local-installation/release-descriptor";
import { BundleStoreModule } from "./bundle-store.js";
import { ConfigStore } from "./config.js";
import { HealthWatchdogModule } from "./health-watchdog.js";
import { EventBus, ModuleHost } from "./modules.js";
import { ReleaseOrchestratorModule } from "./release-orchestrator.js";
import {
  MAX_ROLLBACK_HISTORY_ENTRIES,
  appendRollbackHistory,
  readRollbackHistory,
  rollbackHistoryPath,
} from "./v2-rollback-history.js";
import { createFailedServiceLogReader } from "./v2-service-logs.js";

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

function makeRelease(
  appVersion: string,
  hashes: Partial<Record<"web" | "backend", string>> = {},
  rollbackSafe = true,
): LocalReleaseDescriptor {
  const h = (mod: "web" | "backend") =>
    (hashes[mod] ?? "1").padEnd(64, "0").slice(0, 64);
  const mk = (mod: "web" | "backend") => ({
    artifactId: `${mod}-${h(mod).slice(0, 12)}`,
    originAppVersion: appVersion,
    sha256: h(mod),
    path: `store/${mod}/${mod}-${h(mod).slice(0, 12)}`,
    source: "store" as const,
  });
  return {
    schema: 1,
    appVersion,
    channel: "stable",
    installedAt: new Date().toISOString(),
    source: "incremental-update",
    compat: {
      minShellVersion: "0.1.11-v2test.0",
      minNativeDepsHash: `sha256:${"a".repeat(64)}`,
      runnerGatewayProtocol: 1,
      dbSchemaEpoch: 1,
      rollbackSafe,
    },
    infra: {
      node: "bundled",
      postgres: "bundled",
      voiceTools: "bundled",
      nodeDeps: "infra/node-deps/nd-aaaaaaaaaaaaaaaa",
    },
    modules: {
      web: mk("web"),
      backend: mk("backend"),
    },
  };
}

describe("v2-rollback-history", () => {
  it("writes 0o700/0o600 private rollback-history.jsonl, caps at 50 entries, and redacts secrets", async () => {
    const home = await makeTempDir("linger-rbhist-cap-");

    for (let i = 1; i <= 55; i += 1) {
      await appendRollbackHistory(home, {
        timestamp: `2026-11-27T06:00:${String(i % 60).padStart(2, "0")}Z`,
        failedVersion: `0.2.${i}`,
        restoredVersion: `0.2.${i - 1}`,
        stage: "healthcheck",
        changedModules: ["backend"],
        failedServices: ["teamhub"],
        reason: `probe failed postgres://simplexai:pw_${i}@127.0.0.1:5432/simplexai`,
        serviceLogTails: {
          teamhub: `OPENAI_API_KEY=sk-proj-secret${i}1234567890 crashed`,
        },
        rollbackSafe: true,
        dbRestored: false,
        manualRecoveryRequired: false,
        denylisted: true,
      });
    }

    const records = await readRollbackHistory(home);
    expect(records).toHaveLength(MAX_ROLLBACK_HISTORY_ENTRIES);
    expect(records[0]?.failedVersion).toBe("0.2.6");
    expect(records.at(-1)?.failedVersion).toBe("0.2.55");
    expect(records.at(-1)?.reason).not.toContain("pw_55");
    expect(records.at(-1)?.serviceLogTails?.teamhub).not.toContain(
      "sk-proj-secret551234567890",
    );

    if (process.platform !== "win32") {
      const dirMode = (await stat(path.join(home, "state"))).mode & 0o777;
      const fileMode = (await stat(rollbackHistoryPath(home))).mode & 0o777;
      expect(dirMode).toBe(0o700);
      expect(fileMode).toBe(0o600);
    }
  });

  it("persists structured rollback records with failedServices, serviceLogTails, and dbRestored for both healthcheck and crash-watchdog rollbacks", async () => {
    const home = await makeTempDir("linger-rbhist-orch-");
    const logsDir = path.join(home, "instances", "desktop", "native", "logs");
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      path.join(logsDir, "teamhub.log"),
      "[V2-TEST-FAULTY-0.1.11-v2test.3] exit 42 TEAMHUB_LOCAL_IDENTITY_KEY=secret_id_key_123\n",
      "utf8",
    );
    await writeFile(
      path.join(logsDir, "node-services.log"),
      "FATAL OOM in node-services Bearer tok_secret_987654321\n",
      "utf8",
    );

    const store = new BundleStoreModule({ home, target: "darwin-arm64" });
    const watchdog = new HealthWatchdogModule();
    const config = new ConfigStore(path.join(home, "config.json"));
    const bus = new EventBus();
    const logged: Array<{
      level: string;
      event: string;
      fields: Record<string, unknown>;
    }> = [];
    const testLog = {
      info: (event: string, fields: Record<string, unknown>) =>
        logged.push({ level: "info", event, fields }),
      warn: (event: string, fields: Record<string, unknown>) =>
        logged.push({ level: "warn", event, fields }),
      error: (event: string, fields: Record<string, unknown>) =>
        logged.push({ level: "error", event, fields }),
    };

    let healthyVersion = "0.1.11-v2test.2";
    const orch = new ReleaseOrchestratorModule({
      activeOperations: () => 0,
      backupDatabase: async (v) => `instances/desktop/backups/pre-${v}.dump`,
      restoreDatabase: async () => {},
      restartServices: async () => {},
      buildHealthProbes: (rel) => [
        {
          name: "teamhub-healthz",
          check: async () => rel?.appVersion === healthyVersion,
        },
      ],
      readFailedServiceLogs: createFailedServiceLogReader({
        getHome: () => home,
      }),
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
      { config, log: testLog, bus },
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

      // 1. Pre-commit healthcheck rollback with rollbackSafe:false -> dbRestored=true + teamhub tail
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.3", { backend: "3" }, false),
      );
      await orch.onBundleStaged("0.1.11-v2test.3");
      expect(await orch.applyStaged()).toBe(false);

      // 2. Post-commit crash-watchdog rollback -> node-services tail captured, dbRestored=false
      healthyVersion = "0.1.11-v2test.4";
      await store.writeReleaseDescriptor(
        makeRelease("0.1.11-v2test.4", { backend: "4" }, true),
      );
      await orch.onBundleStaged("0.1.11-v2test.4");
      expect(await orch.applyStaged()).toBe(true);
      await watchdog.recordCrash("node-services", "OOM");
      await watchdog.recordCrash("node-services", "OOM");

      const history = await readRollbackHistory(home);
      expect(history).toHaveLength(2);
      expect(history[0]).toMatchObject({
        failedVersion: "0.1.11-v2test.3",
        restoredVersion: "0.1.11-v2test.2",
        stage: "healthcheck",
        failedServices: ["teamhub"],
        rollbackSafe: false,
        dbBackupFile: "instances/desktop/backups/pre-0.1.11-v2test.3.dump",
        dbRestored: true,
        manualRecoveryRequired: false,
        denylisted: true,
      });
      expect(history[0]?.serviceLogTails?.teamhub).toContain(
        "[V2-TEST-FAULTY-0.1.11-v2test.3]",
      );
      expect(history[0]?.serviceLogTails?.teamhub).not.toContain(
        "secret_id_key_123",
      );

      expect(history[1]).toMatchObject({
        failedVersion: "0.1.11-v2test.4",
        restoredVersion: "0.1.11-v2test.2",
        stage: "crash-watchdog",
        failedServices: ["node-services"],
        rollbackSafe: true,
        dbRestored: false,
        manualRecoveryRequired: false,
        denylisted: true,
      });
      expect(history[1]?.serviceLogTails?.["node-services"]).toContain(
        "FATAL OOM in node-services",
      );
      expect(history[1]?.serviceLogTails?.["node-services"]).not.toContain(
        "tok_secret_987654321",
      );

      const rolledBackLogs = logged.filter(
        (l) => l.event === "release_orchestrator.rolled_back",
      );
      expect(rolledBackLogs).toHaveLength(2);
      expect(rolledBackLogs[0]?.fields.failedServices).toEqual(["teamhub"]);
      expect(rolledBackLogs[0]?.fields.dbRestored).toBe(true);
      expect(rolledBackLogs[1]?.fields.failedServices).toEqual([
        "node-services",
      ]);
      expect(rolledBackLogs[1]?.fields.dbRestored).toBe(false);
    } finally {
      await host.stop("quit");
    }
  });
});
