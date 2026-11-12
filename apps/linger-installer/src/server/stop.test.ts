import { afterEach, expect, test, vi } from "vitest";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { parseInstallerArguments } from "../main.js";
import { launchInstaller } from "./launch.js";
import { privateDirectory, privateWrite } from "./storage.js";
import { stopDesktopInstallation, type StopDependencies } from "./stop.js";

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
