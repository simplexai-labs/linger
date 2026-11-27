import { realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { loadInstance } from "@linger/local-installation/instance";
import {
  localModelsDegradedFromError,
  localModelsDegradedFromOutcome,
  restoreByokSource,
  restoreLocalModels,
  type LocalModelsDegraded,
} from "@linger/local-installation/local-models";
import { userEnvironmentPending } from "@linger/local-installation/user-environment";
import type { InstallOutcome } from "@linger/local-installation/events";
import type { RuntimeDescriptor } from "@linger/local-installation/managed-runtimes";
import {
  installNativeSource,
  probeNativeSourceServices,
} from "@linger/local-installation/native-source";

export interface ResumeTimings {
  path: "warm" | "cold";
  probeMs: number;
  restoreLocalModelsMs?: number;
  restoreByokGatewayMs?: number;
  coldStartMs?: number;
  totalMs: number;
}

export interface ResumeOptions {
  home: string;
  sourceRepo: string;
  instanceName: string;
  externalComputer?: boolean;
  signal: AbortSignal;
  log: (message: string) => void;
  onRuntimeDescriptors?: (descriptors: RuntimeDescriptor[]) => void;
  onTimings?: (timings: ResumeTimings) => void;
}

type Instance = NonNullable<Awaited<ReturnType<typeof loadInstance>>>;

export interface ResumeEngine {
  run: (
    options: Parameters<typeof installNativeSource>[0],
  ) => Promise<InstallOutcome>;
  probe: (
    instance: Instance,
    signal: AbortSignal,
  ) => Promise<{ ready: boolean }[]>;
}

// How an installed instance starts again: its native processes.
const ENGINES: Partial<Record<Instance["mode"], ResumeEngine>> = {
  "source-native": {
    run: installNativeSource,
    probe: probeNativeSourceServices,
  },
};

/**
 * Starts the services of an installed source instance again, for example
 * after a reboot. It reuses the Harness and accounts saved by the first
 * install and asks for nothing; the services outlive this process.
 */
export async function resumeSourceInstance(
  options: ResumeOptions,
  {
    load = loadInstance,
    engines = ENGINES,
    pending = userEnvironmentPending,
    restore = restoreLocalModels,
    restoreByok = restoreByokSource,
  } = {},
): Promise<InstallOutcome> {
  const startedAt = performance.now();
  const instance = await load({
    name: options.instanceName,
    home: options.home,
  });
  const engine = instance && engines[instance.mode];
  if (!instance?.source || !engine)
    return {
      code: 4,
      state: "action_required",
      message: `No source instance named ${options.instanceName}.`,
    };
  const timings: ResumeTimings = {
    path: "cold",
    probeMs: 0,
    totalMs: 0,
  };
  try {
    // A desktop update ships a new source tree, and a changed user.env new
    // keys; running services keep the old ones until they restart.
    const repo = await realpath(options.sourceRepo).catch(() =>
      path.resolve(options.sourceRepo),
    );
    // The instance names the checkout its services last became ready on, so
    // services that still run from an earlier one never count as running.
    const sameCheckout = instance.source.repo === repo;
    let warm = false;
    if (sameCheckout) {
      const probeStartedAt = performance.now();
      try {
        warm =
          (await engine.probe(instance, options.signal)).every(
            (check) => check.ready,
          ) && !(await pending(instance));
      } finally {
        timings.probeMs = Math.max(
          0,
          Math.round(performance.now() - probeStartedAt),
        );
      }
    }
    if (warm) {
      timings.path = "warm";
      // A quit stops the local models and the Bifrost gateway a BYOK source
      // runs on, but leaves the services running, so they come back here
      // rather than with the services.
      const onEvent = (event: { message?: string }) => {
        if (event.message) options.log(event.message);
      };
      // Mount a saved BYOK gateway first because `source apply --mode byok`
      // unloads local models before registering BYOK on Bifrost; restoring any
      // previously loaded library models afterwards keeps both active, and a
      // failure in one never blocks restoring the other.
      let byokGateway: Awaited<ReturnType<typeof restoreByok>> | undefined;
      const byokStartedAt = performance.now();
      try {
        byokGateway = await restoreByok(path.resolve(instance.root, "../.."), {
          signal: options.signal,
          onEvent,
        });
      } finally {
        timings.restoreByokGatewayMs = Math.max(
          0,
          Math.round(performance.now() - byokStartedAt),
        );
      }
      // A local model stack or library model that did not come back is reported,
      // not a failed resume: the person can still reach the workspace and the
      // Models page to manage local models or choose another AI runtime.
      let localModelsDegraded: LocalModelsDegraded | undefined;
      let localModelsRestored = false;
      const restoredLocalModels = new Set<string>();
      const restoreStartedAt = performance.now();
      try {
        const restored = await restore(instance, {
          signal: options.signal,
          onEvent,
          onRestored: (models) => {
            localModelsRestored = true;
            for (const id of models) restoredLocalModels.add(id);
          },
        });
        if (restored)
          localModelsDegraded = localModelsDegradedFromOutcome(restored);
      } catch (error) {
        if (options.signal.aborted) throw error;
        localModelsDegraded = localModelsDegradedFromError(error);
      } finally {
        timings.restoreLocalModelsMs = Math.max(
          0,
          Math.round(performance.now() - restoreStartedAt),
        );
      }
      if (localModelsDegraded)
        options.log(
          `${localModelsDegraded.message} (${localModelsDegraded.code}) Linger is opening without local models; open the Models page to manage local models or switch to another AI runtime.\n`,
        );
      return {
        code: 0,
        state: "ready",
        message: "Services are already running.",
        details: {
          origin: instance.origin,
          source: instance.source.repo,
          ...(byokGateway ? { byokGateway } : {}),
          ...(localModelsDegraded ? { localModelsDegraded } : {}),
          ...(localModelsRestored ? { localModelsRestored: true } : {}),
          ...(restoredLocalModels.size
            ? { restoredLocalModels: [...restoredLocalModels] }
            : {}),
        },
      };
    }
    const coldStartedAt = performance.now();
    let outcome: InstallOutcome;
    try {
      outcome = await engine.run({
        name: instance.name,
        home: options.home,
        repo: options.sourceRepo,
        externalComputer: options.externalComputer,
        // A different checkout may pin newer runtimes, so only a resume on the
        // same one may reuse the installed runtime as is.
        ...(sameCheckout ? { resume: true } : {}),
        // An app update onto a new checkout may find a local model stack it
        // cannot bring back as saved (for example, one an earlier release
        // stopped); the person still reaches the workspace and the Models page.
        degradeLocalModels: true,
        onRuntimeDescriptors: options.onRuntimeDescriptors,
        signal: options.signal,
        onEvent: (event) => {
          if (event.message) options.log(event.message);
        },
      });
    } finally {
      timings.coldStartMs = Math.max(
        0,
        Math.round(performance.now() - coldStartedAt),
      );
    }
    if (outcome.code !== 0) return outcome;
    // The instance names a checkout only once its services serve from it, and
    // the origin they serve at: the run moves the web port off one another
    // program took.
    const serving = await load({
      name: options.instanceName,
      home: options.home,
    });
    return {
      ...outcome,
      details: {
        ...(outcome.details as object | undefined),
        origin: serving?.origin,
        source: serving?.source?.repo,
      },
    };
  } finally {
    timings.totalMs = Math.max(0, Math.round(performance.now() - startedAt));
    options.onTimings?.(timings);
    const parts = [`probe ${timings.probeMs}`];
    if (timings.restoreLocalModelsMs !== undefined)
      parts.push(`restoreLocalModels ${timings.restoreLocalModelsMs}`);
    if (timings.restoreByokGatewayMs !== undefined)
      parts.push(`restoreByokGateway ${timings.restoreByokGatewayMs}`);
    if (timings.coldStartMs !== undefined)
      parts.push(`coldStart ${timings.coldStartMs}`);
    parts.push(`total ${timings.totalMs}`);
    options.log(`Resume timings (${timings.path}, ms): ${parts.join(", ")}.\n`);
  }
}
