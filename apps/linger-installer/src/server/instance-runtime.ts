import path from "node:path";
import { loadInstance } from "@linger/local-installation/instance";
import { localModelsEnvironment } from "@linger/local-installation/local-models";
import {
  LOCALMODELS_TOOL_ENVIRONMENT,
  localmodelsComputerTool,
  localmodelsToolEnvironment,
} from "@linger/local-installation/localmodels-computer";
import { pinnedToolSource } from "@linger/local-installation/localmodels-tool";
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

/**
 * What an external Computer (the desktop's) needs to find the runtime and
 * the localmodels tool this installer manages: the paths the CLI's Computer
 * gets, without the rest of its environment.
 */
export async function instanceRuntime(
  home: string,
  name: string,
): Promise<components["schemas"]["InstanceRuntime"] | undefined> {
  const value = await loadInstance({ name, home });
  if (!value) return undefined;
  const setupChoice = await readSetupChoice({ name, home });
  const found: Record<string, string | undefined> = {
    ...(await managedRuntimeEnvironment(home, value.root)),
    ...(await localModelsEnvironment(value)),
    ...localmodelsToolEnvironment(
      await localmodelsComputerTool(home, pinnedToolSource()),
    ),
  };
  const environment: Record<string, string> = {};
  for (const key of RUNTIME_ENVIRONMENT) {
    const entry = found[key];
    if (entry && path.isAbsolute(entry)) environment[key] = entry;
  }
  return { ...(setupChoice ? { setupChoice } : {}), environment };
}
