import { setTimeout as delay } from "node:timers/promises";

import type {
  BundleModuleId,
  LocalReleaseDescriptor,
} from "@linger/local-installation/release-descriptor";

import type { UpdateActionKind, UpdateScope } from "../shared/api.js";
import type { BundleStoreModule } from "./bundle-store.js";
import type { HealthProbe, HealthWatchdogModule } from "./health-watchdog.js";
import type { Module, ModuleContext } from "./modules.js";

export interface ReleaseDiff {
  readonly changedModules: readonly BundleModuleId[];
  readonly nodeDepsChanged: boolean;
  readonly scope: UpdateScope;
  readonly action: UpdateActionKind;
  readonly requiresDrain: boolean;
}

export interface RollbackNotice {
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reason: string;
  readonly manualRecoveryRequired?: boolean;
  readonly dbBackupFile?: string;
}

export type ReleaseProgressStage =
  | "preparing"
  | "stopping"
  | "switching"
  | "verifying"
  | "complete"
  | "rolling_back"
  | "rolled_back";

export interface ReleaseProgressUpdate {
  readonly stage: ReleaseProgressStage;
  readonly percent: number;
  readonly tone: "normal" | "rollback";
  readonly version: string;
  readonly targetVersion?: string;
}

export interface ReleaseOrchestratorHooks {
  readonly activeOperations: () => number;
  readonly isVoiceIdle?: () => Promise<boolean>;
  readonly backupDatabase?: (appVersion: string) => Promise<string>;
  readonly restoreDatabase?: (backupFile: string) => Promise<void>;
  readonly restartServices: (
    release: LocalReleaseDescriptor,
    changed: readonly BundleModuleId[],
  ) => Promise<void>;
  readonly restoreBaselineServices?: (
    changed: readonly BundleModuleId[],
  ) => Promise<void>;
  readonly buildHealthProbes: (
    release: LocalReleaseDescriptor | undefined,
    changed: readonly BundleModuleId[],
  ) => readonly HealthProbe[];
  readonly onProgress?: (progress: ReleaseProgressUpdate) => void;
  readonly onComplete?: (
    release: LocalReleaseDescriptor,
  ) => Promise<void> | void;
  readonly onRollbackComplete?: (
    notice: RollbackNotice,
  ) => Promise<void> | void;
  readonly completePauseMs?: number;
  readonly rollbackPauseMs?: number;
  readonly healthGateTimeoutMs?: number;
  readonly healthGateIntervalMs?: number;
  readonly observationWindowMs?: number;
  readonly observationMaxCrashes?: number;
}

export type OrchestratorState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "ready";
      readonly version: string;
      readonly diff: ReleaseDiff;
    }
  | {
      readonly kind: "waiting";
      readonly version: string;
      readonly diff: ReleaseDiff;
    }
  | {
      readonly kind: "applying";
      readonly version: string;
      readonly diff: ReleaseDiff;
    }
  | {
      readonly kind: "rolled_back";
      readonly notice: RollbackNotice;
    };

const ALL_MODULES: readonly BundleModuleId[] = ["web", "backend"];

/**
 * Computes the minimal set of changed modules between two 2+1 release descriptors
 * and derives one of two clean update paths:
 *   - web-only (with unchanged nodeDeps): 0-downtime static-host hot reload (`scope: "web"`)
 *   - backend or nodeDeps changed: atomic backend drain + rolling restart/rollback (`scope: "backend"`)
 */
export function diffReleaseModules(
  current: LocalReleaseDescriptor | undefined,
  next: LocalReleaseDescriptor,
): ReleaseDiff {
  const changed: BundleModuleId[] = [];
  for (const mod of ALL_MODULES) {
    if (!current || current.modules[mod].sha256 !== next.modules[mod].sha256) {
      changed.push(mod);
    }
  }
  const nodeDepsChanged =
    !current || current.infra.nodeDeps !== next.infra.nodeDeps;

  const onlyWeb =
    !nodeDepsChanged && changed.length === 1 && changed[0] === "web";

  if (onlyWeb) {
    return {
      changedModules: changed,
      nodeDepsChanged,
      scope: "web",
      action: "reload-page",
      requiresDrain: false,
    };
  }
  return {
    changedModules: changed,
    nodeDepsChanged,
    scope: "backend",
    action: "restart-services",
    requiresDrain: true,
  };
}

/**
 * Coordinates safe V2 bundle transitions:
 *   - Drains active ComputerDaemon tasks & voice recordings before backend restarts
 *   - Applies 0-downtime hot swaps for `web`-only updates
 *   - Protects non-rollbackSafe DB migrations with pre-migration `pg_dump`
 *   - Enforces HealthWatchdog 60s probe gate + 2-min crash rollback & denylist
 */
export class ReleaseOrchestratorModule implements Module {
  readonly name = "ReleaseOrchestrator";
  readonly dependsOn = ["Config", "BundleStore", "HealthWatchdog"];
  readonly #hooks: ReleaseOrchestratorHooks;
  #ctx: ModuleContext | undefined;
  #state: OrchestratorState = { kind: "idle" };
  #stagedVersion: string | undefined;
  #stagingPromise: Promise<void> | undefined;
  #rollbackNotice: RollbackNotice | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(hooks: ReleaseOrchestratorHooks) {
    this.#hooks = hooks;
  }

  state(): OrchestratorState {
    return this.#state;
  }

  rollbackNotice(): RollbackNotice | undefined {
    return this.#rollbackNotice;
  }

  dismissRollbackNotice(): void {
    this.#rollbackNotice = undefined;
    if (this.#state.kind === "rolled_back") {
      this.#setState({ kind: "idle" });
    }
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#unsubscribe.push(
      ctx.bus.on("bundle.staged", (appVersion) => {
        void this.onBundleStaged(appVersion);
      }),
      ctx.bus.on("runtime.activity", (running) => {
        if (running === 0 && this.#state.kind === "waiting") {
          void this.applyStaged();
        }
      }),
    );
  }

  async stop(): Promise<void> {
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  async onBundleStaged(appVersion: string): Promise<void> {
    this.#stagedVersion = appVersion;
    const task = (async () => {
      const store = this.#ctx!.get<BundleStoreModule>("BundleStore");
      const next = await store.readRelease(appVersion);
      if (!next) return;
      const current = await store.currentRelease();
      const diff = diffReleaseModules(current, next);
      this.#stagedVersion = appVersion;
      this.#setState({ kind: "ready", version: appVersion, diff });
    })();
    this.#stagingPromise = task.finally(() => {
      if (this.#stagingPromise === task) this.#stagingPromise = undefined;
    });
    await this.#stagingPromise;
  }

  async applyStaged(): Promise<boolean> {
    if (this.#stagingPromise) await this.#stagingPromise;
    const version = this.#stagedVersion;
    if (!version) return false;
    return this.#applyVersion(version);
  }

  async #applyVersion(version: string): Promise<boolean> {
    const ctx = this.#ctx!;
    const store = ctx.get<BundleStoreModule>("BundleStore");
    const watchdog = ctx.get<HealthWatchdogModule>("HealthWatchdog");
    const next = await store.readRelease(version);
    if (!next) return false;
    const current = await store.currentRelease();
    const diff = diffReleaseModules(current, next);

    if (diff.requiresDrain) {
      const busy =
        this.#hooks.activeOperations() > 0 ||
        (this.#hooks.isVoiceIdle ? !(await this.#hooks.isVoiceIdle()) : false);
      if (busy) {
        this.#setState({ kind: "waiting", version, diff });
        return false;
      }
    }

    this.#setState({ kind: "applying", version, diff });
    ctx.bus.emit("release.switching", version);
    this.#hooks.onProgress?.({
      stage: "preparing",
      percent: 10,
      tone: "normal",
      version,
    });

    let dbBackupFile: string | undefined;
    try {
      if (
        !next.compat.rollbackSafe &&
        diff.scope === "backend" &&
        this.#hooks.backupDatabase
      ) {
        dbBackupFile = await this.#hooks.backupDatabase(version);
      }

      await store.beginPending({
        appVersion: version,
        releaseFile: `releases/${version}/release.json`,
        updatedAt: new Date().toISOString(),
        ...(dbBackupFile ? { dbBackupFile } : {}),
      });

      this.#hooks.onProgress?.({
        stage: "stopping",
        percent: 25,
        tone: "normal",
        version,
      });
      this.#hooks.onProgress?.({
        stage: "switching",
        percent: 45,
        tone: "normal",
        version,
      });
      await this.#hooks.restartServices(next, diff.changedModules);

      this.#hooks.onProgress?.({
        stage: "verifying",
        percent: 75,
        tone: "normal",
        version,
      });
      const probes = this.#hooks.buildHealthProbes(next, diff.changedModules);
      const health = await watchdog.waitForHealthy(probes, {
        timeoutMs: this.#hooks.healthGateTimeoutMs,
        intervalMs: this.#hooks.healthGateIntervalMs,
      });
      if (!health.ok) {
        throw new Error(
          `Health probes failed: ${health.failedProbes.join(", ")}`,
        );
      }

      await store.commitPending();
      this.#stagedVersion = undefined;
      this.#setState({ kind: "idle" });
      ctx.log.info("release_orchestrator.committed", {
        appVersion: version,
        changedModules: diff.changedModules,
      });
      ctx.bus.emit("release.committed", version);

      this.#hooks.onProgress?.({
        stage: "complete",
        percent: 100,
        tone: "normal",
        version,
      });
      const completePauseMs = this.#hooks.completePauseMs ?? 350;
      if (completePauseMs > 0) await delay(completePauseMs);
      await this.#hooks.onComplete?.(next);

      // Post-commit 2-minute crash observation window for backend restarts.
      if (
        diff.requiresDrain &&
        (current || this.#hooks.restoreBaselineServices)
      ) {
        watchdog.startObservation({
          appVersion: version,
          windowMs: this.#hooks.observationWindowMs,
          maxCrashes: this.#hooks.observationMaxCrashes,
          onRollback: async (reason) => {
            await this.#performRollback(
              version,
              current,
              diff.changedModules,
              "crash-watchdog",
              reason,
              dbBackupFile,
              next.compat.rollbackSafe,
            );
          },
        });
      }

      // Async GC in background after a healthy commit.
      void store.gc().catch(() => undefined);
      return true;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.#performRollback(
        version,
        current,
        diff.changedModules,
        "healthcheck",
        reason,
        dbBackupFile,
        next.compat.rollbackSafe,
      );
      return false;
    }
  }

  async #performRollback(
    failedVersion: string,
    previousRelease: LocalReleaseDescriptor | undefined,
    changedModules: readonly BundleModuleId[],
    stage: "migrate" | "healthcheck" | "crash-watchdog",
    reason: string,
    dbBackupFile?: string,
    rollbackSafe = true,
  ): Promise<void> {
    const ctx = this.#ctx!;
    const store = ctx.get<BundleStoreModule>("BundleStore");
    const isPreCommit = stage === "migrate" || stage === "healthcheck";

    // P0-1 safety invariant: NEVER run automated pg_restore after commit
    // (`crash-watchdog`), because live user writes may have occurred after the
    // release was committed. If the committed migration was also irreversible
    // (`rollbackSafe === false`), halt automatic rollback rather than running
    // older incompatible binaries against the migrated schema, and preserve
    // `dbBackupFile` for explicit manual recovery.
    if (!isPreCommit && !rollbackSafe) {
      ctx.log.error("release_orchestrator.manual_recovery_required", {
        failedVersion,
        previousVersion: previousRelease?.appVersion,
        stage,
        reason,
        dbBackupFile,
      });
      await store.addDenylist({
        appVersion: failedVersion,
        failedAt: new Date().toISOString(),
        stage,
        reason,
      });
      this.#stagedVersion = undefined;
      const notice: RollbackNotice = {
        fromVersion: failedVersion,
        toVersion: failedVersion,
        reason: `${reason} (non-rollbackSafe schema already committed; automatic DB restore suppressed to prevent data loss)`,
        manualRecoveryRequired: true,
        ...(dbBackupFile ? { dbBackupFile } : {}),
      };
      this.#rollbackNotice = notice;
      this.#setState({ kind: "rolled_back", notice });
      ctx.bus.emit(
        "release.rolled_back",
        notice.fromVersion,
        notice.toVersion,
        notice.reason,
      );
      return;
    }

    ctx.log.warn("release_orchestrator.rolling_back", {
      failedVersion,
      previousVersion: previousRelease?.appVersion,
      stage,
      reason,
    });
    this.#hooks.onProgress?.({
      stage: "rolling_back",
      percent: 55,
      tone: "rollback",
      version: failedVersion,
      targetVersion: previousRelease?.appVersion,
    });
    if (isPreCommit && dbBackupFile && this.#hooks.restoreDatabase) {
      await this.#hooks.restoreDatabase(dbBackupFile).catch((err) => {
        ctx.log.warn("release_orchestrator.db_restore_failed", {
          error: String(err),
        });
      });
    }
    const restoredPtr = await store.rollbackToPrevious(
      failedVersion,
      stage,
      reason,
    );
    if (previousRelease) {
      await this.#hooks
        .restartServices(previousRelease, changedModules)
        .catch(() => undefined);
      const watchdog = ctx.get<HealthWatchdogModule>("HealthWatchdog");
      const restoreProbes = this.#hooks.buildHealthProbes(
        previousRelease,
        changedModules,
      );
      if (restoreProbes.length > 0) {
        await watchdog
          .waitForHealthy(restoreProbes, {
            timeoutMs: this.#hooks.healthGateTimeoutMs,
            intervalMs: this.#hooks.healthGateIntervalMs,
          })
          .catch(() => undefined);
      }
    } else if (this.#hooks.restoreBaselineServices) {
      await this.#hooks.restoreBaselineServices(changedModules).catch((err) => {
        ctx.log.warn("release_orchestrator.baseline_restore_failed", {
          failedVersion,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      const watchdog = ctx.get<HealthWatchdogModule>("HealthWatchdog");
      const restoreProbes = this.#hooks.buildHealthProbes(
        undefined,
        changedModules,
      );
      if (restoreProbes.length > 0) {
        await watchdog
          .waitForHealthy(restoreProbes, {
            timeoutMs: this.#hooks.healthGateTimeoutMs,
            intervalMs: this.#hooks.healthGateIntervalMs,
          })
          .catch(() => undefined);
      }
    }
    this.#stagedVersion = undefined;
    const notice: RollbackNotice = {
      fromVersion: failedVersion,
      toVersion:
        restoredPtr?.appVersion ??
        previousRelease?.appVersion ??
        (this.#hooks.restoreBaselineServices ? "baseline" : "previous"),
      reason,
    };
    this.#rollbackNotice = notice;
    this.#setState({ kind: "rolled_back", notice });
    ctx.bus.emit(
      "release.rolled_back",
      notice.fromVersion,
      notice.toVersion,
      notice.reason,
    );
    this.#hooks.onProgress?.({
      stage: "rolled_back",
      percent: 100,
      tone: "rollback",
      version: failedVersion,
      targetVersion: notice.toVersion,
    });
    const rollbackPauseMs = this.#hooks.rollbackPauseMs ?? 900;
    if (rollbackPauseMs > 0) await delay(rollbackPauseMs);
    await this.#hooks.onRollbackComplete?.(notice);
  }

  #setState(state: OrchestratorState): void {
    this.#state = state;
    this.#ctx?.bus.emit("update.changed", state.kind);
  }
}
