import type { Module, ModuleContext } from "./modules.js";

export interface HealthProbe {
  readonly name: string;
  readonly check: () => Promise<boolean>;
}

export interface HealthGateOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
}

export interface HealthGateResult {
  readonly ok: boolean;
  readonly failedProbes: readonly string[];
  readonly elapsedMs: number;
}

export interface CrashObservationOptions {
  readonly appVersion: string;
  readonly windowMs?: number;
  readonly maxCrashes?: number;
  readonly onRollback: (
    reason: string,
    crashedServices?: readonly string[],
  ) => Promise<void>;
}

const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const DEFAULT_GATE_INTERVAL_MS = 500;
const DEFAULT_OBSERVATION_WINDOW_MS = 120_000;
const DEFAULT_MAX_CRASHES = 2;

/**
 * Two-stage health guard for V2 incremental updates:
 *   1. Switch-time 60s probe gate (Web /healthz, TeamHub /healthz + identity,
 *      Node Services /readyz, ComputerDaemon status).
 *   2. Post-commit 2-minute crash observation window: >= 2 crashes trigger an
 *      automatic rollback to `previous.json` and denylist the faulty version.
 */
export class HealthWatchdogModule implements Module {
  readonly name = "HealthWatchdog";
  readonly dependsOn = ["Config"];
  #ctx: ModuleContext | undefined;
  #observation:
    | {
        readonly appVersion: string;
        readonly maxCrashes: number;
        readonly onRollback: (
          reason: string,
          crashedServices?: readonly string[],
        ) => Promise<void>;
        readonly crashedServices: Set<string>;
        crashes: number;
        triggered: boolean;
        timer: NodeJS.Timeout;
      }
    | undefined;

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
  }

  async stop(): Promise<void> {
    this.stopObservation();
  }

  async waitForHealthy(
    probes: readonly HealthProbe[],
    options: HealthGateOptions = {},
  ): Promise<HealthGateResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? DEFAULT_GATE_INTERVAL_MS;
    const startedAt = Date.now();
    let lastFailed: string[] = probes.map((p) => p.name);

    while (Date.now() - startedAt <= timeoutMs) {
      const results = await Promise.all(
        probes.map(async (probe) => {
          try {
            return { name: probe.name, ok: await probe.check() };
          } catch {
            return { name: probe.name, ok: false };
          }
        }),
      );
      lastFailed = results.filter((r) => !r.ok).map((r) => r.name);
      if (lastFailed.length === 0) {
        return {
          ok: true,
          failedProbes: [],
          elapsedMs: Date.now() - startedAt,
        };
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) break;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(intervalMs, remaining)),
      );
    }

    return {
      ok: false,
      failedProbes: lastFailed,
      elapsedMs: Date.now() - startedAt,
    };
  }

  startObservation(options: CrashObservationOptions): void {
    this.stopObservation();
    const windowMs = options.windowMs ?? DEFAULT_OBSERVATION_WINDOW_MS;
    const maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
    const timer = setTimeout(() => {
      this.#ctx?.log.info("health_watchdog.observation_passed", {
        appVersion: options.appVersion,
      });
      this.#observation = undefined;
    }, windowMs);
    timer.unref?.();

    this.#observation = {
      appVersion: options.appVersion,
      maxCrashes,
      onRollback: options.onRollback,
      crashedServices: new Set(),
      crashes: 0,
      triggered: false,
      timer,
    };
  }

  stopObservation(): void {
    if (!this.#observation) return;
    clearTimeout(this.#observation.timer);
    this.#observation = undefined;
  }

  isObserving(appVersion?: string): boolean {
    if (!this.#observation) return false;
    return appVersion ? this.#observation.appVersion === appVersion : true;
  }

  async recordCrash(serviceName: string, reason: string): Promise<boolean> {
    const obs = this.#observation;
    if (!obs || obs.triggered) return false;
    obs.crashes += 1;
    obs.crashedServices.add(serviceName);
    this.#ctx?.log.warn("health_watchdog.crash_recorded", {
      appVersion: obs.appVersion,
      service: serviceName,
      crashes: obs.crashes,
      maxCrashes: obs.maxCrashes,
      reason,
    });
    if (obs.crashes < obs.maxCrashes) return false;

    obs.triggered = true;
    clearTimeout(obs.timer);
    this.#observation = undefined;
    await obs.onRollback(
      `${serviceName} crashed ${obs.crashes} times within observation window: ${reason}`,
      [...obs.crashedServices],
    );
    return true;
  }
}
