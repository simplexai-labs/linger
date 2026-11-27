import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  delay,
  readTeamHubHealthUrl,
  waitForTeamHubHealth,
} from "../src/teamhub-health.js";

export { waitForTeamHubHealth };

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const hostEntryPoint = path.join(packageRoot, "src/main.ts");
const featureCatalogGenerator = path.join(
  packageRoot,
  "scripts/generate-feature-catalog.ts",
);

type NodeServicesChild = Pick<ChildProcess, "kill" | "off" | "once">;

/**
 * `pnpm dev` runs Node Services through this supervisor: it waits for TeamHub,
 * which the Agent Service needs at startup, and restarts the process after a
 * crash instead of letting `concurrently` stop the whole stack. It does not
 * watch files, so an edit never interrupts a running Wiki generation.
 */
export interface NodeServicesDevSupervisorOptions {
  signal: AbortSignal;
  spawnNodeServices?: () => NodeServicesChild;
  waitForTeamHub?: (signal: AbortSignal) => Promise<void>;
  /**
   * Whether to wait for TeamHub before the very first spawn. Defaults to true
   * for development (`tsx`); compiled native runs set false so `dist/main.js`
   * starts booting non-TeamHub roles immediately and waits just-in-time via
   * `--wait-teamhub`.
   */
  waitBeforeFirstSpawn?: boolean;
  waitBeforeRestart?: (signal: AbortSignal) => Promise<void>;
  /**
   * Regenerates the static agent-features manifest before each (re)start so
   * restarts after adding or removing a feature directory always spawn the
   * Agent Service against the current catalog.
   */
  refreshFeatureCatalog?: (signal: AbortSignal) => Promise<void>;
}

export async function superviseNodeServicesDevelopment(
  options: NodeServicesDevSupervisorOptions,
): Promise<void> {
  const spawnNodeServices =
    options.spawnNodeServices ?? defaultSpawnNodeServices;
  const waitForTeamHub =
    options.waitForTeamHub ??
    ((signal) => waitForTeamHubHealth(readTeamHubHealthUrl(), signal));
  const waitBeforeFirstSpawn = options.waitBeforeFirstSpawn ?? true;
  const waitBeforeRestart =
    options.waitBeforeRestart ?? ((signal) => delay(500, signal));
  const refreshFeatureCatalog =
    options.refreshFeatureCatalog ?? generateFeatureCatalog;

  let attempt = 0;
  while (!options.signal.aborted) {
    if (attempt > 0 || waitBeforeFirstSpawn) {
      await waitForTeamHub(options.signal);
      if (options.signal.aborted) return;
    }
    attempt += 1;

    await refreshFeatureCatalog(options.signal);
    if (options.signal.aborted) return;

    const result = await waitForChildExit(spawnNodeServices(), options.signal);
    if (options.signal.aborted) return;

    const reason = result.error
      ? result.error.message
      : `exit code ${String(result.code)}${result.signal ? ` (${result.signal})` : ""}`;
    console.error(
      `[node-services] Node Services stopped with ${reason}; restarting.`,
    );
    await waitBeforeRestart(options.signal);
  }
}

function defaultSpawnNodeServices(): NodeServicesChild {
  return spawn(process.execPath, ["--import", "tsx", hostEntryPoint], {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

// Runs as its own process, like Node Services, so this supervisor keeps only
// built-in and zero-dependency imports. Its notes go to stderr; stdout belongs
// to Node Services. The desktop's offline runtime ships main.ts compiled beside
// this file, with its feature catalog built in
// (apps/desktop/scripts/build-native-runtime.mjs). It stays in this process's
// directory, the checkout, against which the bundle resolves relative settings.
function spawnCompiledNodeServices(): NodeServicesChild {
  return spawn(
    process.execPath,
    [
      "--conditions=linger-production",
      path.join(packageRoot, "dist/main.js"),
      "--wait-teamhub",
    ],
    { stdio: "inherit", windowsHide: true },
  );
}

async function generateFeatureCatalog(signal: AbortSignal): Promise<void> {
  const result = await waitForChildExit(
    spawn(process.execPath, ["--import", "tsx", featureCatalogGenerator], {
      cwd: packageRoot,
      stdio: ["ignore", 2, 2],
    }),
    signal,
  );
  if (signal.aborted) return;
  if (result.error) throw result.error;
  if (result.code !== 0) {
    throw new Error(
      `agent-features catalog generation exited with code ${String(result.code)}`,
    );
  }
}

function waitForChildExit(
  child: NodeServicesChild,
  signal: AbortSignal,
): Promise<{
  code: number | null;
  error?: Error;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    const finish = (result: {
      code: number | null;
      error?: Error;
      signal: NodeJS.Signals | null;
    }): void => {
      child.off("error", onError);
      child.off("exit", onExit);
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onError = (error: Error): void => {
      finish({ code: null, error, signal: null });
    };
    const onExit = (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      finish({ code, signal: exitSignal });
    };
    const onAbort = (): void => {
      child.kill("SIGTERM");
    };

    child.once("error", onError);
    child.once("exit", onExit);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const compiled = process.argv.includes("--compiled");
  await superviseNodeServicesDevelopment({
    signal: controller.signal,
    ...(compiled && {
      spawnNodeServices: spawnCompiledNodeServices,
      refreshFeatureCatalog: async () => {},
      waitBeforeFirstSpawn: false,
      waitForTeamHub: (signal) =>
        waitForTeamHubHealth(readTeamHubHealthUrl(), signal, {
          retryDelayMs: 200,
        }),
    }),
  });
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
