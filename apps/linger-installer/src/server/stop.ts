import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  INSTANCE_BUSY,
  loadInstance,
} from "@linger/local-installation/instance";
import {
  clearLocalModelsStopPending,
  markLocalModelsStopPending,
  withLocalModelsLock,
} from "@linger/local-installation/local-models";
import { stopLocalmodels } from "@linger/local-installation/localmodels-tool";
import { stopNativeSource } from "@linger/local-installation/native-source";

import { privateRead } from "./storage.js";

type Instance = NonNullable<Awaited<ReturnType<typeof loadInstance>>>;

export interface StopOptions {
  // The default home; the desktop records a custom install location in it.
  home: string;
  instanceName: string;
  signal: AbortSignal;
  budgetMs?: number;
  log: (message: string) => void;
  onFailure?: (
    stage: "manager" | "services" | "localmodels",
    error: unknown,
  ) => void;
}

export interface StopOutcome {
  failed: { home: string; message: string }[];
}

export interface StopDependencies {
  load?: typeof loadInstance;
  stopInstance?: (
    instance: Instance,
    signal: AbortSignal,
    options?: { log?: (message: string) => void },
  ) => Promise<void>;
  stopModels?: (
    home: string,
    options: {
      signal: AbortSignal;
      log: (message: string) => void;
      keepController?: boolean;
      budgetMs?: number;
    },
  ) => Promise<void>;
  fetch?: typeof fetch;
}

/**
 * Stops what the desktop's installation runs, for its uninstall: the
 * installation manager it owns (a running job is cancelled), the
 * instance's services, and the local models' controller and stack the
 * localmodels tool started. Nothing is deleted, and stopped services are left as
 * they are. Every home is tried even when one fails.
 */
export async function stopDesktopInstallation(
  options: StopOptions,
  {
    load = loadInstance,
    stopInstance = stopNativeSource,
    stopModels = stopLocalmodels,
    fetch: fetcher = fetch,
  }: StopDependencies = {},
): Promise<StopOutcome> {
  const { failed, attempt } = attempts(
    options.log,
    "the installation",
    options.onFailure,
  );
  const deadline =
    options.budgetMs !== undefined ? Date.now() + options.budgetMs : undefined;
  const remainingBudgetMs = () =>
    deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined;
  for (const home of await installationHomes(options.home)) {
    const stageTimings: [string, string][] = [];
    const runStage = async (
      stage: "manager" | "services" | "localmodels",
      step: () => Promise<void>,
    ) => {
      const startedAt = Date.now();
      let stageFailed = false;
      await attempt(
        home,
        async () => {
          try {
            await step();
          } catch (error) {
            stageFailed = true;
            throw error;
          }
        },
        stage,
      );
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      stageTimings.push([stage, elapsed]);
      options.log(
        stageFailed
          ? `Stop stage ${stage} failed after ${elapsed}s.`
          : `Stop stage ${stage} completed in ${elapsed}s.`,
      );
    };
    // The services stop even when the manager could not: an earlier release's
    // manager has no /api/stop, and a stale session may name another server.
    await runStage("manager", () => stopManager(home, options, fetcher));
    await runStage("services", async () => {
      const instance = await load({ name: options.instanceName, home });
      if (!instance) return;
      options.log(`Stopping the services in ${instance.root}.`);
      await stopInstance(instance, options.signal, { log: options.log });
    });
    // Forward the budget remaining on options.signal so stopLocalmodels scales
    // its per-step reserves within the real outer deadline rather than letting
    // an earlier step hit the outer signal before foundations stop / stack down.
    await runStage("localmodels", async () => {
      const budgetMs = remainingBudgetMs();
      await stopModels(home, {
        signal: options.signal,
        log: options.log,
        ...(budgetMs !== undefined ? { budgetMs } : {}),
      });
      await clearLocalModelsStopPending(home).catch(() => undefined);
    });
    options.log(
      `Stop timings (s): ${stageTimings.map(([stage, elapsed]) => `${stage} ${elapsed}`).join(", ")}.`,
    );
  }
  return { failed };
}

/**
 * Stops the local models a quit leaves nothing to use: the model library's
 * loaded models and the stack with the gateway the localmodels tool started,
 * in every home the desktop installed to. The services and the model
 * controller keep running, as the services do after a quit; the next launch
 * brings the approved stack up again. Each home's stop holds that home's
 * local model lock; a home whose lock another operation holds is skipped.
 * While stopping under the lock, a pending-stop marker is recorded and cleared
 * only on success so a failed or interrupted quit stop is retried on the next
 * launch before resume.
 */
export async function stopDesktopLocalModels(
  options: Pick<StopOptions, "home" | "signal" | "log" | "budgetMs">,
  { stopModels = stopLocalmodels }: Pick<StopDependencies, "stopModels"> = {},
): Promise<StopOutcome> {
  const { failed, attempt } = attempts(options.log, "the local models");
  const deadline =
    options.budgetMs !== undefined ? Date.now() + options.budgetMs : undefined;
  const remainingBudgetMs = () =>
    deadline !== undefined ? Math.max(1, deadline - Date.now()) : undefined;
  for (const home of await installationHomes(options.home))
    await attempt(home, async () => {
      const stop = () => {
        const budgetMs = remainingBudgetMs();
        return stopModels(home, {
          signal: options.signal,
          log: options.log,
          keepController: true,
          ...(budgetMs !== undefined ? { budgetMs } : {}),
        });
      };
      // Nothing ran localmodels in a home without its folder, and the lock
      // would create one there.
      if (!(await exists(path.join(home, "runtime", "localmodels"))))
        return stop();
      // The next launch's restore waits on this lock, so it never checks a
      // stack this stop is about to take down.
      try {
        await withLocalModelsLock(home, async () => {
          await markLocalModelsStopPending(home).catch(() => undefined);
          await stop();
          await clearLocalModelsStopPending(home).catch(() => undefined);
        });
      } catch (error) {
        if ((error as { code?: unknown }).code !== INSTANCE_BUSY) throw error;
        // A deployment holds the stack; stopping it now would break that
        // apply, and the next launch restores the stack's approved state.
        options.log(
          `Left the local models in ${home} running: another local model operation holds them.`,
        );
      }
    });
  return { failed };
}

// Runs each step and records the ones that failed, so every home is tried.
function attempts(
  log: (message: string) => void,
  target = "the installation",
  onFailure?: StopOptions["onFailure"],
) {
  const failed: StopOutcome["failed"] = [];
  const attempt = async (
    home: string,
    step: () => Promise<void>,
    stage: "manager" | "services" | "localmodels" = "localmodels",
  ) => {
    try {
      await step();
    } catch (error) {
      onFailure?.(stage, error);
      const message = error instanceof Error ? error.message : String(error);
      log(`Could not stop ${target} in ${home}: ${message}`);
      failed.push({ home, message });
    }
  };
  return { failed, attempt };
}

// The default home and the install location the desktop chose under
// Customize (desktop/local-server.json).
async function installationHomes(home: string): Promise<string[]> {
  try {
    const record = JSON.parse(
      await readFile(path.join(home, "desktop", "local-server.json"), "utf8"),
    ) as { home?: unknown };
    if (
      typeof record.home === "string" &&
      path.isAbsolute(record.home) &&
      path.resolve(record.home) !== path.resolve(home)
    )
      return [home, path.resolve(record.home)];
  } catch {
    // No record: nothing was installed elsewhere.
  }
  return [home];
}

// Only a manager the desktop started for this instance; one the person
// opened for another installation keeps running.
async function stopManager(
  home: string,
  options: StopOptions,
  fetcher: typeof fetch,
): Promise<void> {
  const file = path.join(home, "installer", "session.json");
  if (!(await exists(file))) return;
  const session = (await privateRead(file)) as {
    origin?: unknown;
    controlToken?: unknown;
    externalComputer?: unknown;
    instanceName?: unknown;
  };
  if (
    session.externalComputer !== true ||
    session.instanceName !== options.instanceName ||
    typeof session.origin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(session.origin) ||
    typeof session.controlToken !== "string"
  )
    return;
  options.log("Stopping the installation manager.");
  try {
    const response = await fetcher(`${session.origin}/api/stop`, {
      method: "POST",
      headers: { Origin: session.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: session.controlToken }),
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok)
      throw new Error(`The installation manager refused (${response.status}).`);
  } catch (error) {
    options.signal.throwIfAborted();
    // Nothing listens: the session is left from a manager that ended.
    if (connectionRefused(error)) return;
    throw error;
  }
  // It removes its session once its job is cancelled and its files closed.
  while (await exists(file)) {
    options.signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

function connectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  return cause?.code === "ECONNREFUSED";
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}
