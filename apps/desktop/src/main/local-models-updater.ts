import path from "node:path";

import {
  localmodelsComputerTool,
  localmodelsToolEnvironment,
} from "@linger/local-installation/localmodels-computer";
import {
  inferToolVersions,
  LocalmodelsManifestError,
  type LocalmodelsToolSource,
} from "@linger/local-installation/localmodels-manifest";
import {
  hasDevLocalmodelsTool,
  readPublishedTool,
  resolveEffectiveToolSource,
} from "@linger/local-installation/localmodels-tool";
import {
  activateLocalmodelsUpdate,
  checkLocalmodelsUpdate,
  LocalmodelsUpdateError,
  rollbackLocalmodelsUpdate,
  stageLocalmodelsUpdate,
  type LocalmodelsUpdateCheckResult,
  type StagedLocalmodelsUpdate,
} from "@linger/local-installation/localmodels-update";

import type {
  DesktopLocalModelsEngineInfo,
  DesktopLocalModelsUpdateState,
} from "../shared/api.js";
import type { ComputerDaemonModule } from "./computer-daemon.js";
import type { Module, ModuleContext } from "./modules.js";

const CHECK_DELAY_MS = 90_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

export interface LocalModelsUpdaterOptions {
  readonly home: string;
  readonly desktopVersion: string;
  readonly installerDirectory?: string;
  readonly baseline?: LocalmodelsToolSource;
  readonly target?: string;
  readonly openExternal: (url: string) => Promise<void>;
  readonly publicKey?: string;
  readonly disabled?: boolean;
  readonly checkDelayMs?: number;
  readonly checkIntervalMs?: number;
  readonly fetcher?: typeof fetch;
  readonly resolveEffective?: typeof resolveEffectiveToolSource;
  readonly checkUpdate?: typeof checkLocalmodelsUpdate;
  readonly stageUpdate?: typeof stageLocalmodelsUpdate;
  readonly activateUpdate?: typeof activateLocalmodelsUpdate;
  readonly rollbackUpdate?: typeof rollbackLocalmodelsUpdate;
}

interface PendingAvailable {
  readonly kind: "available";
  readonly verified: Extract<
    LocalmodelsUpdateCheckResult,
    { kind: "available" }
  >["verified"];
  readonly kit: LocalmodelsToolSource;
}

interface AppliedRollback {
  readonly previousRuntimeEnv: Readonly<Record<string, string>> | undefined;
  readonly version: string;
}

/**
 * Checks for signed localmodels kit updates in the background (metadata only)
 * and downloads, smoke-tests, and activates an update only when the person
 * asks for it. Waits for active agent operations and local-model jobs before
 * restarting the daemon, and rolls back automatically if startup fails.
 */
export class LocalModelsUpdaterModule implements Module {
  readonly name = "LocalModelsUpdater";
  readonly dependsOn = ["Config", "ComputerDaemon"];
  readonly #options: LocalModelsUpdaterOptions;
  #ctx: ModuleContext | undefined;
  #baseline: LocalmodelsToolSource | undefined;
  #engine: Omit<DesktopLocalModelsEngineInfo, "autoCheck"> | undefined;
  #state: DesktopLocalModelsUpdateState | null = null;
  #pending: PendingAvailable | undefined;
  #staged: StagedLocalmodelsUpdate | undefined;
  #justApplied: AppliedRollback | undefined;
  #checking: Promise<void> | undefined;
  #installing: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #generation = 0;
  #abort: AbortController | undefined;
  #waitCleanup: (() => void) | undefined;
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: LocalModelsUpdaterOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#options.disabled || hasDevLocalmodelsTool()) return;
    this.#baseline = await this.#loadBaseline();
    if (!this.#baseline) return;
    await this.#refreshCurrentEngine();
    if (!this.#engine) return;
    this.#setState({
      kind: "idle",
      ...this.#info(),
    });
    this.#unsubscribe.push(
      ctx.bus.on("runtime.state", (state) => {
        if (state === "ready" && this.#justApplied) {
          ctx.log.info("local_models_updater.confirmed_ready", {
            version: this.#justApplied.version,
          });
          this.#justApplied = undefined;
        }
      }),
      ctx.bus.on("computer.failed", (reason) => {
        if (reason && this.#justApplied) void this.#rollbackAfterFailure();
      }),
    );
    if (ctx.config.get().localModelsAutoCheck)
      this.#schedule(this.#options.checkDelayMs ?? CHECK_DELAY_MS);
  }

  async stop(): Promise<void> {
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#abort?.abort();
    this.#abort = undefined;
    this.#clearWait();
    for (const off of this.#unsubscribe.splice(0)) off();
  }

  state(): DesktopLocalModelsUpdateState | null {
    return this.#state;
  }

  check(manual = true): Promise<void> {
    if (!this.#ctx || !this.#baseline || !this.#engine)
      return Promise.resolve();
    const kind = this.#state?.kind;
    if (
      kind === "downloading" ||
      kind === "verifying" ||
      kind === "waiting" ||
      kind === "applying"
    )
      return Promise.resolve();
    if (
      !manual &&
      (!this.#ctx.config.get().localModelsAutoCheck ||
        kind === "available" ||
        kind === "requires_app_update")
    )
      return Promise.resolve();
    if (this.#checking) return this.#checking;
    this.#checking = this.#runCheck(manual).finally(
      () => (this.#checking = undefined),
    );
    return this.#checking;
  }

  install(): Promise<void> {
    if (!this.#ctx || !this.#baseline || !this.#engine)
      return Promise.resolve();
    if (this.#installing) return this.#installing;
    if (!this.#pending) return Promise.resolve();
    this.#installing = this.#runInstall(this.#pending).finally(
      () => (this.#installing = undefined),
    );
    return this.#installing;
  }

  setAutoCheck(enabled: boolean): void {
    const ctx = this.#ctx;
    if (!ctx) return;
    ctx.config.update({ localModelsAutoCheck: enabled });
    clearTimeout(this.#timer);
    this.#timer = undefined;
    if (enabled && this.#baseline && this.#engine)
      this.#schedule(this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS);
    if (this.#state) this.#setState({ ...this.#state, autoCheck: enabled });
  }

  async openNotes(): Promise<void> {
    const url = this.#pending?.verified.manifest.notesUrl;
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:") return;
    await this.#options.openExternal(parsed.toString());
  }

  async #loadBaseline(): Promise<LocalmodelsToolSource | undefined> {
    if (this.#options.baseline) return this.#options.baseline;
    if (!this.#options.installerDirectory) return undefined;
    try {
      return await readPublishedTool(
        path.join(this.#options.installerDirectory, "distribution.json"),
      );
    } catch (error) {
      this.#ctx?.log.warn("local_models_updater.baseline_unreadable", {
        error: String(error),
      });
      return undefined;
    }
  }

  async #refreshCurrentEngine(): Promise<void> {
    if (!this.#baseline) return;
    const resolve =
      this.#options.resolveEffective ?? resolveEffectiveToolSource;
    const effective = await resolve(this.#options.home, this.#baseline, {
      ...(this.#options.target ? { target: this.#options.target } : {}),
      desktopVersion: this.#options.desktopVersion,
      ...(this.#options.publicKey
        ? { publicKey: this.#options.publicKey }
        : {}),
    });
    if (!effective) return;
    const fallbackVersion =
      inferToolVersions(effective.source).version ?? "unknown";
    this.#engine = {
      currentVersion: effective.version ?? fallbackVersion,
      source: effective.origin,
      sourceCommit: effective.source.sourceCommit,
    };
  }

  #info(): DesktopLocalModelsEngineInfo {
    return {
      ...this.#engine!,
      autoCheck: this.#ctx?.config.get().localModelsAutoCheck ?? true,
    };
  }

  #schedule(delayMs: number): void {
    clearTimeout(this.#timer);
    const generation = this.#generation;
    this.#timer = setTimeout(() => {
      if (this.#generation !== generation) return;
      void this.check(false).finally(() => {
        if (
          this.#generation === generation &&
          this.#ctx?.config.get().localModelsAutoCheck
        )
          this.#schedule(this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS);
      });
    }, delayMs);
    this.#timer.unref?.();
  }

  async #runCheck(manual: boolean): Promise<void> {
    const ctx = this.#ctx!;
    const baseline = this.#baseline!;
    if (manual) this.#setState({ kind: "checking", ...this.#info() });
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const feedUrl = ctx.config.get().localModelsFeedUrl;
      if (feedUrl && new URL(feedUrl).protocol !== "https:")
        throw new LocalmodelsUpdateError(
          "The local models update feed must use https.",
        );
      const checker = this.#options.checkUpdate ?? checkLocalmodelsUpdate;
      const result = await checker({
        home: this.#options.home,
        baseline,
        desktopVersion: this.#options.desktopVersion,
        ...(this.#options.target ? { target: this.#options.target } : {}),
        ...(feedUrl ? { feedUrl } : {}),
        ...(this.#options.publicKey
          ? { publicKey: this.#options.publicKey }
          : {}),
        ...(this.#options.fetcher ? { fetcher: this.#options.fetcher } : {}),
        signal: abort.signal,
      });
      await this.#refreshCurrentEngine();
      if (result.kind === "up_to_date") {
        this.#pending = undefined;
        this.#setState({
          kind: "idle",
          ...this.#info(),
          checkedAt: new Date().toISOString(),
        });
        return;
      }
      if (result.kind === "requires_app_update") {
        this.#pending = undefined;
        this.#setState({
          kind: "requires_app_update",
          ...this.#info(),
          version: result.manifest.version,
          minLingerVersion: result.minLingerVersion,
        });
        return;
      }
      this.#pending = result;
      ctx.log.info("local_models_updater.available", {
        version: result.verified.manifest.version,
        bytes: result.kit.bytes,
      });
      this.#setState({
        kind: "available",
        ...this.#info(),
        version: result.verified.manifest.version,
        ...(result.verified.manifest.summary
          ? { summary: result.verified.manifest.summary }
          : {}),
        hasNotes: Boolean(result.verified.manifest.notesUrl),
        bytes: result.kit.bytes,
      });
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = this.#errorMessage(error);
      ctx.log.warn("local_models_updater.check_failed", {
        manual,
        error: message,
      });
      if (manual)
        this.#setState({ kind: "failed", ...this.#info(), error: message });
      else if (this.#state?.kind === "checking")
        this.#setState({ kind: "idle", ...this.#info() });
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
    }
  }

  async #runInstall(pending: PendingAvailable): Promise<void> {
    const ctx = this.#ctx!;
    const version = pending.verified.manifest.version;
    const abort = new AbortController();
    this.#abort = abort;
    this.#setState({
      kind: "downloading",
      ...this.#info(),
      version,
      completed: 0,
      total: pending.kit.bytes,
    });
    try {
      const stage = this.#options.stageUpdate ?? stageLocalmodelsUpdate;
      const staged = await stage({
        home: this.#options.home,
        verified: pending.verified,
        kit: pending.kit,
        signal: abort.signal,
        ...(this.#options.fetcher ? { fetcher: this.#options.fetcher } : {}),
        onPhase: (phase) => {
          if (phase === "verifying")
            this.#setState({ kind: "verifying", ...this.#info(), version });
        },
        onProgress: (completed, total) => {
          if (this.#state?.kind !== "downloading") return;
          this.#setState({
            kind: "downloading",
            ...this.#info(),
            version,
            completed,
            ...(total !== undefined ? { total } : {}),
          });
        },
      });
      this.#staged = staged;
      if (this.#isDaemonBusy()) {
        this.#setState({ kind: "waiting", ...this.#info(), version });
        this.#waitUntilIdle();
        return;
      }
      await this.#applyStaged();
    } catch (error) {
      if (abort.signal.aborted) return;
      const message = this.#errorMessage(error);
      ctx.log.warn("local_models_updater.install_failed", {
        version,
        error: message,
      });
      this.#setState({ kind: "failed", ...this.#info(), error: message });
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
    }
  }

  #isDaemonBusy(): boolean {
    const daemon = this.#ctx?.get<ComputerDaemonModule>("ComputerDaemon");
    if (!daemon) return false;
    return daemon.running() > 0 || daemon.localModelsBusy() > 0;
  }

  #waitUntilIdle(): void {
    this.#clearWait();
    const ctx = this.#ctx!;
    const tryApply = (): void => {
      if (this.#isDaemonBusy()) return;
      this.#clearWait();
      void this.#applyStaged();
    };
    const offRuntime = ctx.bus.on("runtime.activity", tryApply);
    const offModels = ctx.bus.on("local-models.activity", tryApply);
    this.#waitCleanup = () => {
      offRuntime();
      offModels();
    };
  }

  #clearWait(): void {
    this.#waitCleanup?.();
    this.#waitCleanup = undefined;
  }

  async #applyStaged(): Promise<void> {
    const ctx = this.#ctx;
    const staged = this.#staged;
    if (!ctx || !staged) return;
    this.#staged = undefined;
    const version = staged.verified.manifest.version;
    this.#setState({ kind: "applying", ...this.#info(), version });
    try {
      const activate =
        this.#options.activateUpdate ?? activateLocalmodelsUpdate;
      const tool = await activate(this.#options.home, staged, {
        ...(this.#baseline ? { baseline: this.#baseline } : {}),
      });
      const previousRuntimeEnv = ctx.config.get().runtimeEnvironment;
      const nextRuntimeEnv: Record<string, string> = {
        ...(previousRuntimeEnv ?? {}),
        ...localmodelsToolEnvironment(tool),
      };
      this.#justApplied = { previousRuntimeEnv, version };
      ctx.config.update({ runtimeEnvironment: nextRuntimeEnv });
      this.#engine = {
        currentVersion: version,
        source: "updated",
        sourceCommit: staged.verified.manifest.sourceCommit,
      };
      this.#pending = undefined;
      ctx.log.info("local_models_updater.applied", {
        version,
        source_commit: staged.verified.manifest.sourceCommit,
      });
      ctx.bus.emit("computer.runtime");
      this.#setState({
        kind: "idle",
        ...this.#info(),
        checkedAt: new Date().toISOString(),
      });
    } catch (error) {
      const message = this.#errorMessage(error);
      ctx.log.warn("local_models_updater.apply_failed", {
        version,
        error: message,
      });
      this.#setState({ kind: "failed", ...this.#info(), error: message });
    }
  }

  async #rollbackAfterFailure(): Promise<void> {
    const ctx = this.#ctx;
    const applied = this.#justApplied;
    if (!ctx || !applied) return;
    this.#justApplied = undefined;
    ctx.log.warn("local_models_updater.rolling_back", {
      version: applied.version,
    });
    const rollback = this.#options.rollbackUpdate ?? rollbackLocalmodelsUpdate;
    await rollback(this.#options.home).catch(() => undefined);
    let restoredEnv = applied.previousRuntimeEnv;
    if (this.#baseline && !this.#options.rollbackUpdate) {
      const baselineTool = await localmodelsComputerTool(
        this.#options.home,
        this.#baseline,
      ).catch(() => undefined);
      if (baselineTool) {
        restoredEnv = {
          ...(applied.previousRuntimeEnv ?? {}),
          ...localmodelsToolEnvironment(baselineTool),
        };
      }
    }
    ctx.config.update({
      ...(restoredEnv !== undefined
        ? { runtimeEnvironment: { ...restoredEnv } }
        : {}),
    });
    await this.#refreshCurrentEngine();
    ctx.bus.emit("computer.runtime");
    if (this.#engine)
      this.#setState({
        kind: "failed",
        ...this.#info(),
        error: "Model engine update failed to start and was rolled back.",
      });
  }

  #errorMessage(error: unknown): string {
    if (
      error instanceof LocalmodelsUpdateError ||
      error instanceof LocalmodelsManifestError ||
      error instanceof Error
    )
      return error.message;
    return String(error);
  }

  #setState(state: DesktopLocalModelsUpdateState): void {
    this.#state = state;
    this.#ctx?.bus.emit("local-models.update.changed", state.kind);
  }
}
