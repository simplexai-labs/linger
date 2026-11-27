import { afterEach, expect, test, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { INSTANCE_BUSY } from "@linger/local-installation/instance";
import {
  hasPendingLocalModelsStop,
  markLocalModelsStopPending,
  withLocalModelsLock,
} from "@linger/local-installation/local-models";
import {
  stopLocalmodels,
  type runLocalmodels,
} from "@linger/local-installation/localmodels-tool";

import { parseInstallerArguments } from "../main.js";
import { launchInstaller } from "./launch.js";
import { privateDirectory, privateWrite } from "./storage.js";
import {
  stopDesktopInstallation,
  stopDesktopLocalModels,
  type StopDependencies,
} from "./stop.js";

const clean: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of clean.splice(0).reverse()) await fn();
});

const home = async () => {
  const value = await mkdtemp(path.join(tmpdir(), "installer-stop-"));
  clean.push(() => rm(value, { recursive: true, force: true }));
  return value;
};
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
const options = (value: string) => ({
  home: value,
  instanceName: "desktop",
  signal: AbortSignal.timeout(10_000),
  log: () => {},
});
const instance = (root: string) =>
  ({ name: "desktop", root }) as unknown as NonNullable<
    Awaited<ReturnType<NonNullable<StopDependencies["load"]>>>
  >;

test("the uninstall stop needs only the instance", () => {
  expect(
    parseInstallerArguments(["--instance", "desktop", "--stop"]),
  ).toMatchObject({ stop: true, instanceName: "desktop" });
  expect(() => parseInstallerArguments(["--stop"])).toThrow(/instance/);
});

test("the quit's local model stop needs no instance or source", () => {
  expect(parseInstallerArguments(["--stop-local-models"])).toMatchObject({
    stopLocalModels: true,
  });
});

test("stops the desktop's manager while a job runs, then the instance's services", async () => {
  const value = await home();
  let cancelled = false;
  const manager = await launchInstaller({
    home: value,
    sourceRepo: "/source/one",
    externalComputer: true,
    instanceName: "desktop",
    noOpen: true,
    dependencies: {
      run: async (_input: unknown, signal: AbortSignal) => {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        cancelled = true;
        return { state: "cancelled", code: 130, message: "Cancelled" };
      },
    },
  });
  clean.push(manager.close);
  const session = await fetch(`${manager.origin}/api/session`, {
    method: "POST",
    headers: { Origin: manager.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ token: manager.bootstrapToken }),
  });
  const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
  await fetch(`${manager.origin}/api/jobs`, {
    method: "POST",
    headers: {
      Origin: manager.origin,
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ instance: "desktop" }),
  });
  const stopped: string[] = [];
  const outcome = await stopDesktopInstallation(options(value), {
    load: async ({ home: at }) => instance(path.join(at!, "instances/desktop")),
    stopInstance: async (target) => {
      stopped.push(target.root);
    },
  });
  expect(outcome.failed).toEqual([]);
  await manager.closed;
  expect(cancelled).toBe(true);
  expect(await exists(path.join(value, "installer/session.json"))).toBe(false);
  expect(stopped).toEqual([path.join(value, "instances/desktop")]);
});

test("leaves a manager the person opened for another installation", async () => {
  const value = await home();
  const manager = await launchInstaller({
    home: value,
    sourceRepo: "/source/one",
    instanceName: "default",
    noOpen: true,
  });
  clean.push(manager.close);
  const outcome = await stopDesktopInstallation(options(value), {
    load: async () => undefined,
  });
  expect(outcome.failed).toEqual([]);
  expect(await exists(path.join(value, "installer/session.json"))).toBe(true);
});

test("an uninstall with nothing running or installed stops nothing", async () => {
  const value = await home();
  // The session of a manager that ended without removing it.
  await privateDirectory(path.join(value, "installer"));
  await privateWrite(path.join(value, "installer/session.json"), {
    origin: "http://127.0.0.1:9",
    controlToken: "x".repeat(43),
    externalComputer: true,
    instanceName: "desktop",
  });
  const stopInstance = vi.fn(async () => {});
  const outcome = await stopDesktopInstallation(options(value), {
    load: async () => undefined,
    stopInstance,
    fetch: (async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNREFUSED" },
      });
    }) as typeof fetch,
  });
  expect(outcome.failed).toEqual([]);
  expect(stopInstance).not.toHaveBeenCalled();
});

test("stops the services even when the manager refuses to stop", async () => {
  const value = await home();
  // An earlier release's manager, or another server on a stale session's port.
  await privateDirectory(path.join(value, "installer"));
  await privateWrite(path.join(value, "installer/session.json"), {
    origin: "http://127.0.0.1:9",
    controlToken: "x".repeat(43),
    externalComputer: true,
    instanceName: "desktop",
  });
  const stopped: string[] = [];
  const outcome = await stopDesktopInstallation(options(value), {
    load: async ({ home: at }) => instance(path.join(at!, "instances/desktop")),
    stopInstance: async (target) => {
      stopped.push(target.root);
    },
    fetch: (async () => new Response("", { status: 404 })) as typeof fetch,
  });
  expect(stopped).toEqual([path.join(value, "instances/desktop")]);
  expect(outcome.failed).toEqual([
    { home: value, message: "The installation manager refused (404)." },
  ]);
});

test("also stops the installation in the location chosen under Customize, even when another fails", async () => {
  const value = await home();
  const custom = await home();
  await mkdir(path.join(value, "desktop"), { recursive: true });
  await writeFile(
    path.join(value, "desktop/local-server.json"),
    JSON.stringify({
      home: custom,
      repo: "/r",
      origin: "http://localhost:3000",
    }),
  );
  const stopped: string[] = [];
  const outcome = await stopDesktopInstallation(options(value), {
    load: async ({ home: at }) => instance(at!),
    stopInstance: async (target) => {
      if (target.root === value)
        throw new Error("Native postgres still has live descendants");
      stopped.push(target.root);
    },
  });
  expect(stopped).toEqual([custom]);
  expect(outcome.failed).toEqual([
    { home: value, message: "Native postgres still has live descendants" },
  ]);
});

test("gives up on a stop that does not finish in time", async () => {
  const value = await home();
  const controller = new AbortController();
  const outcome = await stopDesktopInstallation(
    { ...options(value), signal: controller.signal },
    {
      load: async ({ home: at }) => instance(at!),
      stopInstance: (_target, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
          controller.abort(new Error("The stop timed out"));
        }),
    },
  );
  expect(outcome.failed).toEqual([
    { home: value, message: "The stop timed out" },
  ]);
});

test("stops the local models in every home, even where the services did not stop", async () => {
  const value = await home();
  const custom = await home();
  await mkdir(path.join(value, "desktop"), { recursive: true });
  await writeFile(
    path.join(value, "desktop/local-server.json"),
    JSON.stringify({ home: custom }),
  );
  const models: string[] = [];
  const outcome = await stopDesktopInstallation(options(value), {
    load: async ({ home: at }) => instance(at!),
    stopInstance: async (target) => {
      if (target.root === value) throw new Error("services still running");
    },
    stopModels: async (at) => {
      models.push(at);
      if (at === custom)
        throw new Error("localmodels stack down: gateway still running");
    },
  });
  expect(models).toEqual([value, custom]);
  expect(outcome.failed).toEqual([
    { home: value, message: "services still running" },
    { home: custom, message: "localmodels stack down: gateway still running" },
  ]);
});

test("a quit stops only the local models, in every home, and keeps their controller", async () => {
  const value = await home();
  const custom = await home();
  await mkdir(path.join(value, "desktop"), { recursive: true });
  await writeFile(
    path.join(value, "desktop/local-server.json"),
    JSON.stringify({ home: custom }),
  );
  const failure =
    "Cannot stop local models: the installed tool kit could not be verified. Start Linger to repair the kit, then try again.";
  const models: { home: string; keepController?: boolean }[] = [];
  const log: string[] = [];
  const outcome = await stopDesktopLocalModels(
    { ...options(value), log: (message) => log.push(message) },
    {
      stopModels: async (at, { keepController }) => {
        models.push({ home: at, keepController });
        if (at === value) throw new Error(failure);
      },
    },
  );
  expect(models).toEqual([
    { home: value, keepController: true },
    { home: custom, keepController: true },
  ]);
  expect(outcome.failed).toEqual([
    {
      home: value,
      message: failure,
    },
  ]);
  expect(log).toEqual([
    `Could not stop the local models in ${value}: ${failure}`,
  ]);
});

test("a quit holds each home's local model lock while it stops the models", async () => {
  const value = await home();
  await mkdir(path.join(value, "runtime/localmodels"), { recursive: true });
  let held: unknown;
  const outcome = await stopDesktopLocalModels(options(value), {
    stopModels: async (at) => {
      // A restore checking the stack now finds the lock taken.
      held = await withLocalModelsLock(at, async () => "free").catch(
        (error: { code?: unknown }) => error.code,
      );
    },
  });
  expect(held).toBe(INSTANCE_BUSY);
  expect(outcome.failed).toEqual([]);
});

test("a quit while a deployment holds the lock leaves that home's models running", async () => {
  const value = await home();
  await mkdir(path.join(value, "runtime/localmodels"), { recursive: true });
  const stopModels = vi.fn(async () => {});
  const log: string[] = [];
  const outcome = await withLocalModelsLock(value, () =>
    stopDesktopLocalModels(
      { ...options(value), log: (message) => log.push(message) },
      { stopModels },
    ),
  );
  expect(stopModels).not.toHaveBeenCalled();
  expect(outcome.failed).toEqual([]);
  expect(log.join("\n")).toContain("another local model operation holds them");
});

test("passes options.log to stopInstance and logs durations for manager, services, and localmodels stages", async () => {
  const value = await home();
  const logs: string[] = [];
  const receivedLog = vi.fn();
  const outcome = await stopDesktopInstallation(
    { ...options(value), log: (message) => logs.push(message) },
    {
      load: async ({ home: at }) =>
        instance(path.join(at!, "instances/desktop")),
      stopInstance: async (_target, _signal, stopOptions) => {
        stopOptions?.log?.("Stopped native web in 0.1s.");
        receivedLog(stopOptions?.log);
      },
      stopModels: async () => {
        throw new Error("localmodels stack down: timeout");
      },
    },
  );
  expect(receivedLog).toHaveBeenCalledWith(expect.any(Function));
  expect(outcome.failed).toEqual([
    { home: value, message: "localmodels stack down: timeout" },
  ]);
  expect(logs).toContain("Stopped native web in 0.1s.");
  expect(logs).toContainEqual(
    expect.stringMatching(/^Stop stage manager completed in [\d.]+s\.$/),
  );
  expect(logs).toContainEqual(
    expect.stringMatching(/^Stop stage services completed in [\d.]+s\.$/),
  );
  expect(logs).toContainEqual(
    expect.stringMatching(/^Stop stage localmodels failed after [\d.]+s\.$/),
  );
  expect(logs.at(-1)).toMatch(
    /^Stop timings \(s\): manager [\d.]+, services [\d.]+, localmodels [\d.]+\.$/,
  );
});

test("a quit records a stop-pending marker while stopping and keeps it when the stop fails", async () => {
  const value = await home();
  await mkdir(path.join(value, "runtime/localmodels"), { recursive: true });
  let pendingDuringStop = false;
  const okOutcome = await stopDesktopLocalModels(
    { ...options(value), budgetMs: 135_000 },
    {
      stopModels: async (at, opts) => {
        pendingDuringStop = await hasPendingLocalModelsStop(at);
        expect(opts.budgetMs).toBeGreaterThan(0);
        expect(opts.budgetMs).toBeLessThanOrEqual(135_000);
      },
    },
  );
  expect(okOutcome.failed).toEqual([]);
  expect(pendingDuringStop).toBe(true);
  expect(await hasPendingLocalModelsStop(value)).toBe(false);

  const failedOutcome = await stopDesktopLocalModels(options(value), {
    stopModels: async () => {
      throw new Error("localmodels stack down: Command timed out");
    },
  });
  expect(failedOutcome.failed).toHaveLength(1);
  expect(await hasPendingLocalModelsStop(value)).toBe(true);
});

test("a full uninstall stop clears any lingering stop-pending marker on success", async () => {
  const value = await home();
  await markLocalModelsStopPending(value);
  const outcome = await stopDesktopInstallation(
    { ...options(value), budgetMs: 120_000 },
    {
      load: async () => undefined,
      stopModels: async (_at, opts) => {
        expect(opts.budgetMs).toBeGreaterThan(0);
        expect(opts.budgetMs).toBeLessThanOrEqual(120_000);
      },
    },
  );
  expect(outcome.failed).toEqual([]);
  expect(await hasPendingLocalModelsStop(value)).toBe(false);
});

test("after a slow services stage, uninstall scales localmodels reserves within the outer signal deadline so foundations stop and stack down still run", async () => {
  const value = await home();
  const runUninstall = async (hangLibraryStatus: boolean) => {
    let now = 0;
    const outerDeadline = 120_000;
    const outerController = new AbortController();
    const advance = (ms: number) => {
      now += ms;
      if (now >= outerDeadline && !outerController.signal.aborted)
        outerController.abort(new Error("outer stop deadline reached"));
    };
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const commands: [string, number | undefined][] = [];
    const run = vi.fn<typeof runLocalmodels>(async (_home, args, opts) => {
      const key = args.slice(0, 2).join(" ");
      commands.push([key, opts?.timeoutMs]);
      if (key === "library status") {
        if (hangLibraryStatus) {
          advance(opts?.timeoutMs ?? 0);
          opts?.signal?.throwIfAborted();
          throw Object.assign(new Error("Command timed out"), {
            code: "COMMAND_TIMEOUT",
          });
        }
        advance(2_000);
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: "localmodels.library-status/v1",
            models: [{ id: "qwen3-8b:Q4_K_M", state: "loaded" }],
          }),
          stderr: "",
        };
      }
      advance(2_000);
      opts?.signal?.throwIfAborted();
      return { code: 0, stdout: "{}", stderr: "" };
    });
    try {
      const outcome = await stopDesktopInstallation(
        {
          ...options(value),
          signal: outerController.signal,
          budgetMs: outerDeadline,
        },
        {
          load: async ({ home: at }) =>
            instance(path.join(at!, "instances/desktop")),
          stopInstance: async () => {
            // Simulate stopping native services taking 80 s of the 120 s budget.
            advance(80_000);
          },
          stopModels: (at, opts) =>
            stopLocalmodels(at, opts, {
              run,
              installed: async () => true,
              now: () => now,
            }),
        },
      );
      return { outcome, commands, aborted: outerController.signal.aborted };
    } finally {
      nowSpy.mockRestore();
    }
  };

  // Case 1: slow services (80 s) + healthy localmodels -> every step runs and
  // succeeds within the remaining 40 s without skipping anything.
  const healthy = await runUninstall(false);
  expect(healthy.outcome.failed).toEqual([]);
  expect(healthy.aborted).toBe(false);
  expect(healthy.commands).toEqual([
    ["library status", 20_000],
    ["library unload", 18_000],
    ["foundations stop", 21_000],
    ["stack down", 34_000],
  ]);

  // Case 2: slow services (80 s) + hanging library status -> status times out
  // at its scaled 20 s cap before the 120 s outer signal fires, so foundations
  // stop and stack down still run with their protected tails.
  const hung = await runUninstall(true);
  expect(hung.aborted).toBe(false);
  expect(hung.outcome.failed).toEqual([
    { home: value, message: "localmodels library status: Command timed out" },
  ]);
  expect(hung.commands).toEqual([
    ["library status", 20_000],
    ["foundations stop", 5_000],
    ["stack down", 18_000],
  ]);
});
