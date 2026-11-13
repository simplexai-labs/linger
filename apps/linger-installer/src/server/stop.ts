import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { loadInstance } from "@linger/local-installation/instance";
import { stopLocalmodels } from "@linger/local-installation/localmodels-tool";
import { stopNativeSource } from "@linger/local-installation/native-source";

import { privateRead } from "./storage.js";

type Instance = NonNullable<Awaited<ReturnType<typeof loadInstance>>>;

export interface StopOptions {
  // The default home; the desktop records a custom install location in it.
  home: string;
  instanceName: string;
  signal: AbortSignal;
  log: (message: string) => void;
}

export interface StopOutcome {
  failed: { home: string; message: string }[];
}

export interface StopDependencies {
  load?: typeof loadInstance;
  stopInstance?: (instance: Instance, signal: AbortSignal) => Promise<void>;
  stopModels?: (
    home: string,
    options: { signal: AbortSignal; log: (message: string) => void },
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
  const failed: StopOutcome["failed"] = [];
  const attempt = async (home: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log(`Could not stop the installation in ${home}: ${message}`);
      failed.push({ home, message });
    }
  };
  for (const home of await installationHomes(options.home)) {
    // The services stop even when the manager could not: an earlier release's
    // manager has no /api/stop, and a stale session may name another server.
    await attempt(home, () => stopManager(home, options, fetcher));
    await attempt(home, async () => {
      const instance = await load({ name: options.instanceName, home });
      if (!instance) return;
      options.log(`Stopping the services in ${instance.root}.`);
      await stopInstance(instance, options.signal);
    });
    await attempt(home, () =>
      stopModels(home, { signal: options.signal, log: options.log }),
    );
  }
  return { failed };
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
