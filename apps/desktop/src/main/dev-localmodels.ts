import path from "node:path";

import {
  localmodelsToolEnvironment,
  localmodelsToolFromEnvironment,
  type LocalmodelsComputerTool,
} from "@linger/local-installation/localmodels-computer";
import {
  configuredDevTool,
  localmodelsBaseDirectory,
  localmodelsStateDirectory,
} from "@linger/local-installation/localmodels-tool";
import { privateDirectory } from "@linger/local-installation/private-files";

/**
 * Reads optional development overrides pointing the Desktop Computer daemon at
 * a local llm-inference-lab checkout instead of the pinned kit archive, using
 * the installer's standard state and models layout under `home`.
 */
export function readDevLocalmodelsOverride(
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  platformPath: typeof path = path,
): LocalmodelsComputerTool | undefined {
  const tool = configuredDevTool(env, platformPath);
  if (!tool) return undefined;
  return {
    python: tool.python,
    moduleDirectory: tool.moduleDir,
    stateDirectory: localmodelsStateDirectory(home, platformPath),
    baseDirectory: localmodelsBaseDirectory(home, platformPath),
  };
}

/**
 * Applies the localmodels checkout override on top of the daemon environment,
 * preserving any existing state/base directories from a custom install home or
 * falling back to the resolved override directories when running against
 * `pnpm dev`.
 */
export function applyDevLocalmodelsEnvironment(
  env: Readonly<Record<string, string>>,
  override: LocalmodelsComputerTool | undefined,
  platformPath: typeof path = path,
): Record<string, string> {
  if (!override) return { ...env };
  const existing = localmodelsToolFromEnvironment(env, platformPath);
  const tool: LocalmodelsComputerTool = {
    python: override.python,
    moduleDirectory: override.moduleDirectory,
    stateDirectory: existing?.stateDirectory ?? override.stateDirectory,
    baseDirectory: existing?.baseDirectory ?? override.baseDirectory,
  };
  return {
    ...env,
    ...localmodelsToolEnvironment(tool),
  };
}

/** Ensures private state and model directories exist before launching the daemon. */
export async function ensureDevLocalmodelsDirectories(
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const tool = localmodelsToolFromEnvironment(env);
  if (!tool) return;
  await privateDirectory(tool.stateDirectory);
  await privateDirectory(tool.baseDirectory);
}
