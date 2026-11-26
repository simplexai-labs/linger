import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { runProcess } from "./process.js";
import { privateDirectory } from "./instance.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";
import {
  installNativeRuntime,
  runtimeFailureCode,
  runtimeVersionFailure,
  type RuntimeDependencies,
} from "./managed-runtimes.js";

export type Dependency = "codex" | "claude" | "pi";
export interface PreparationOptions {
  home: string;
  dependency: Dependency;
  signal: AbortSignal;
  onEvent: (event: InstallerEvent) => void;
  interactive?: boolean;
  /** Desktop installers use the OS agent; passwords never pass through Linger. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * When true for `pi`, binds the verified bundled Pi directly instead of
   * running `localmodels harness plan` and `apply` when no higher-precedence
   * Pi exists.
   */
  skipHarnessWhenBundledPiMatches?: boolean;
}
export async function prepareDependencies(
  options: PreparationOptions,
  dependencies: RuntimeDependencies = {},
): Promise<InstallOutcome> {
  options.signal.throwIfAborted();
  const run = dependencies.run ?? runProcess;
  const stage = "runtime";
  const emit = (state: InstallerEvent["state"], message: string) =>
    options.onEvent({ kind: "stage", stage, state, message });
  await privateDirectory(options.home);
  const directory = path.join(options.home, "setup");
  await privateDirectory(directory);
  const lock = new DatabaseSync(path.join(directory, "dependencies.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    return {
      code: 4,
      state: "busy",
      message:
        "Another dependency installation is running. Retry when it finishes.",
    };
  }
  try {
    emit("running", `Preparing the native ${options.dependency} runtime…`);
    return await installNativeRuntime(options.dependency, options, {
      ...dependencies,
      run,
    });
  } catch (error) {
    options.signal.throwIfAborted();
    const versionFailure = runtimeVersionFailure(error);
    const message =
      versionFailure?.message ??
      (error instanceof Error
        ? error.message
        : "Dependency installation failed. Retry after checking the network.");
    emit("failed", message);
    const code =
      versionFailure?.code ??
      runtimeFailureCode(error) ??
      ((error as { code?: unknown } | null)?.code === "COMMAND_TIMEOUT"
        ? "COMMAND_TIMEOUT"
        : undefined);
    return {
      code: 5,
      state: "failed",
      message,
      ...(code
        ? {
            details: {
              code,
              stage,
            },
          }
        : {}),
    };
  } finally {
    lock.close();
  }
}
