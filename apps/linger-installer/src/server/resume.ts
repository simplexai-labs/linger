import { realpath } from "node:fs/promises";
import path from "node:path";

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

export interface ResumeOptions {
  home: string;
  sourceRepo: string;
  instanceName: string;
  externalComputer?: boolean;
  signal: AbortSignal;
  log: (message: string) => void;
  onRuntimeDescriptors?: (descriptors: RuntimeDescriptor[]) => void;
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
  // A desktop update ships a new source tree, and a changed user.env new
  // keys; running services keep the old ones until they restart.
  const repo = await realpath(options.sourceRepo).catch(() =>
    path.resolve(options.sourceRepo),
  );
  // The instance names the checkout its services last became ready on, so
  // services that still run from an earlier one never count as running.
  const sameCheckout = instance.source.repo === repo;
  if (
    sameCheckout &&
    (await engine.probe(instance, options.signal)).every(
      (check) => check.ready,
    ) &&
    !(await pending(instance))
  ) {
    // A quit stops the local models and the Bifrost gateway a BYOK source
    // runs on, but leaves the services running, so they come back here
    // rather than with the services.
    const onEvent = (event: { message?: string }) => {
      if (event.message) options.log(event.message);
    };
    // A local model stack that did not come back is reported, not a failed
    // resume: the person can still reach the workspace and the Models page
    // to manage local models or choose another AI runtime.
    let localModelsDegraded: LocalModelsDegraded | undefined;
    try {
      const restored = await restore(instance, {
        signal: options.signal,
        onEvent,
      });
      if (restored)
        localModelsDegraded = localModelsDegradedFromOutcome(restored);
    } catch (error) {
      if (options.signal.aborted) throw error;
      localModelsDegraded = localModelsDegradedFromError(error);
    }
    if (localModelsDegraded)
      options.log(
        `${localModelsDegraded.message} (${localModelsDegraded.code}) Linger is opening without local models; open the Models page to manage local models or switch to another AI runtime.\n`,
      );
    // A gateway that did not come back is reported, not a failed resume:
    // the person can still reach the Models page.
    const byokGateway = localModelsDegraded
      ? undefined
      : await restoreByok(path.resolve(instance.root, "../.."), {
          signal: options.signal,
          onEvent,
        });
    return {
      code: 0,
      state: "ready",
      message: "Services are already running.",
      details: {
        origin: instance.origin,
        source: instance.source.repo,
        ...(byokGateway ? { byokGateway } : {}),
        ...(localModelsDegraded ? { localModelsDegraded } : {}),
      },
    };
  }
  const outcome = await engine.run({
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
}
