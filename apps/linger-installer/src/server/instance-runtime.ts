import path from "node:path";
import { performance } from "node:perf_hooks";
import { loadInstance } from "@linger/local-installation/instance";
import { localModelsEnvironment } from "@linger/local-installation/local-models";
import { readByokEnvironment } from "@linger/local-installation/byok-source";
import {
  LOCALMODELS_TOOL_ENVIRONMENT,
  localmodelsComputerTool,
  localmodelsToolEnvironment,
} from "@linger/local-installation/localmodels-computer";
import { pinnedToolSource } from "@linger/local-installation/localmodels-tool";
import {
  runtimeEnvironmentFromDescriptors,
  type RuntimeDescriptor,
} from "@linger/local-installation/managed-runtimes";
import { managedRuntimeEnvironment } from "@linger/local-installation/managed-codex";
import { readSetupChoice } from "@linger/local-installation/setup-selection";
import type { components } from "@linger/wire-contracts/linger-installer/types";

const RUNTIME_ENVIRONMENT = [
  "LINGER_CODEX_PATH",
  "LINGER_CLAUDE_PATH",
  "LINGER_PI_PATH",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  ...LOCALMODELS_TOOL_ENVIRONMENT,
];

/** Milliseconds spent in each step of a runtime lookup for the desktop. */
export interface RuntimeLookupTimings {
  config: number;
  runtime: number;
  localModels: number;
  tool: number;
  total: number;
}

type TimingStage = Exclude<keyof RuntimeLookupTimings, "total">;

/**
 * What an external Computer (the desktop's) needs to find the runtime and
 * the localmodels tool this installer manages: the paths the CLI's Computer
 * gets, without the rest of its environment.
 */
export async function instanceRuntime(
  home: string,
  name: string,
  options: {
    runtimeDescriptors?: RuntimeDescriptor[];
    onTimings?: (timings: RuntimeLookupTimings) => void;
  } = {},
): Promise<components["schemas"]["InstanceRuntime"] | undefined> {
  const started = performance.now();
  const timings: RuntimeLookupTimings = {
    config: 0,
    runtime: 0,
    localModels: 0,
    tool: 0,
    total: 0,
  };
  const timed = async <T>(stage: TimingStage, run: () => T | Promise<T>) => {
    const at = performance.now();
    try {
      return await run();
    } finally {
      timings[stage] += Math.round(performance.now() - at);
    }
  };
  try {
    const value = await timed("config", () => loadInstance({ name, home }));
    if (!value) return undefined;
    const [
      setupChoiceResult,
      byokResult,
      managedEnvResult,
      modelsEnvResult,
      toolResult,
    ] = await Promise.allSettled([
      timed("config", () => readSetupChoice({ name, home })),
      timed("config", () => readByokEnvironment(home)),
      timed("runtime", () =>
        options.runtimeDescriptors !== undefined
          ? runtimeEnvironmentFromDescriptors(options.runtimeDescriptors)
          : managedRuntimeEnvironment(home, value.root),
      ),
      timed("localModels", () => localModelsEnvironment(value)),
      timed("tool", () => localmodelsComputerTool(home, pinnedToolSource())),
    ]);
    if (setupChoiceResult.status === "rejected") throw setupChoiceResult.reason;
    if (byokResult.status === "rejected") throw byokResult.reason;
    if (managedEnvResult.status === "rejected") throw managedEnvResult.reason;
    if (modelsEnvResult.status === "rejected") throw modelsEnvResult.reason;
    if (toolResult.status === "rejected") throw toolResult.reason;
    const setupChoice = setupChoiceResult.value;
    const byok = byokResult.value;
    const managedEnv = managedEnvResult.value;
    const modelsEnv = modelsEnvResult.value;
    const tool = toolResult.value;
    const found: Record<string, string | undefined> = {
      ...managedEnv,
      ...modelsEnv,
      ...(byok?.mode === "byok" ? byok.environment : {}),
      ...localmodelsToolEnvironment(tool),
    };
    const environment: Record<string, string> = {};
    for (const key of RUNTIME_ENVIRONMENT) {
      const entry = found[key];
      if (entry && path.isAbsolute(entry)) environment[key] = entry;
    }
    return { ...(setupChoice ? { setupChoice } : {}), environment };
  } finally {
    timings.total = Math.round(performance.now() - started);
    options.onTimings?.({ ...timings });
  }
}

// The desktop keys on this event name and the timings shape, not on prose.
export const RUNTIME_LOOKUP_TIMINGS_EVENT = "installer.runtime_lookup_timings";

export function formatRuntimeLookupTimings(
  name: string,
  timings: RuntimeLookupTimings,
): string {
  return `${JSON.stringify({
    event: RUNTIME_LOOKUP_TIMINGS_EVENT,
    instance: name,
    timings,
  })}\n`;
}
