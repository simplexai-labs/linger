import path from "node:path";
import { privateDirectory } from "./instance.js";
import {
  ensureLocalmodelsTool,
  localmodelsBaseDirectory,
  localmodelsStateDirectory,
  type LocalmodelsToolSource,
} from "./localmodels-tool.js";

/**
 * Where a Computer's Daemon finds the localmodels tool to run the model
 * library: the config's `local_models` section (computerconfig.LocalModels).
 * The Daemon runs `<python> -P -s -m localmodels library ...` with
 * PYTHONPATH and its working directory at moduleDirectory,
 * LOCALMODELS_STATE at stateDirectory and --base-dir baseDirectory, the
 * same state and models every installer call uses.
 */
export interface LocalmodelsComputerTool {
  python: string;
  moduleDirectory: string;
  stateDirectory: string;
  baseDirectory: string;
}

/**
 * The verified tool of `source`, the tool the caller's distribution ships,
 * or undefined when it ships none: such a Computer reports
 * TOOL_NOT_INSTALLED.
 */
export async function localmodelsComputerTool(
  home: string,
  source: LocalmodelsToolSource | undefined,
  options: { signal?: AbortSignal } = {},
): Promise<LocalmodelsComputerTool | undefined> {
  if (!source) return undefined;
  const tool = await ensureLocalmodelsTool(home, options, { source });
  const stateDirectory = localmodelsStateDirectory(home);
  const baseDirectory = localmodelsBaseDirectory(home);
  await privateDirectory(stateDirectory);
  await privateDirectory(baseDirectory);
  return {
    python: tool.python,
    moduleDirectory: tool.moduleDir,
    stateDirectory,
    baseDirectory,
  };
}

// How the installer's InstanceRuntime environment names the tool for an
// external Computer such as the Desktop's.
const ENVIRONMENT = {
  python: "LINGER_LOCALMODELS_PYTHON",
  moduleDirectory: "LINGER_LOCALMODELS_MODULE_DIR",
  stateDirectory: "LINGER_LOCALMODELS_STATE",
  baseDirectory: "LINGER_LOCALMODELS_BASE_DIR",
} as const satisfies Record<keyof LocalmodelsComputerTool, string>;

export const LOCALMODELS_TOOL_ENVIRONMENT: readonly string[] =
  Object.values(ENVIRONMENT);

export function localmodelsToolEnvironment(
  tool: LocalmodelsComputerTool | undefined,
): Record<string, string> {
  if (!tool) return {};
  return Object.fromEntries(
    Object.entries(ENVIRONMENT).map(([key, name]) => [
      name,
      tool[key as keyof LocalmodelsComputerTool],
    ]),
  );
}

/** The tool an environment names, when it names all four absolute paths. */
export function localmodelsToolFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> | undefined,
  platformPath: typeof path = path,
): LocalmodelsComputerTool | undefined {
  const entries = Object.entries(ENVIRONMENT).map(
    ([key, name]) => [key, environment?.[name]] as const,
  );
  if (
    !entries.every(
      ([, value]) =>
        typeof value === "string" && platformPath.isAbsolute(value),
    )
  )
    return undefined;
  return Object.fromEntries(entries) as unknown as LocalmodelsComputerTool;
}

/** The Computer config's `local_models` section. */
export function localModelsConfig(tool: LocalmodelsComputerTool) {
  return {
    python: tool.python,
    module_directory: tool.moduleDirectory,
    state_directory: tool.stateDirectory,
    base_directory: tool.baseDirectory,
  };
}

/** The `linger-computer login` options that write the same section. */
export function localModelsLoginArguments(
  tool: LocalmodelsComputerTool | undefined,
): string[] {
  if (!tool) return [];
  return [
    "--localmodels-python",
    tool.python,
    "--localmodels-module-dir",
    tool.moduleDirectory,
    "--localmodels-state",
    tool.stateDirectory,
    "--localmodels-base-dir",
    tool.baseDirectory,
  ];
}
