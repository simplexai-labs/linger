import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { inspectRuntime } from "@linger/local-installation/managed-runtimes";
import { parseInstallerArguments } from "../main.js";
import type { RuntimeLoginManager } from "./runtime-login.js";
import {
  downloadLocalModel,
  libraryModel,
  prepareSetupRuntime,
  presetOwnerAccount,
  runtimeStatus,
  setupRuntime,
  setupRuntimeLogin,
} from "./setup-commands.js";
import { validateInput } from "./validation.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("parses the setup commands without a source checkout and refuses bad values", () => {
  expect(parseInstallerArguments(["--runtime-status"])).toMatchObject({
    runtimeStatus: true,
  });
  expect(
    parseInstallerArguments(["--prepare-runtime", "claude"]),
  ).toMatchObject({ prepareRuntime: "claude" });
  expect(
    parseInstallerArguments(["--runtime-login", "codex", "--device-login"]),
  ).toMatchObject({ runtimeLogin: "codex", deviceLogin: true });
  expect(
    parseInstallerArguments(["--owner-account", "--instance", "desktop"]),
  ).toMatchObject({ ownerAccount: true, instanceName: "desktop" });
  expect(
    parseInstallerArguments(["--download-local-model", "qwen3-8b:Q4_K_M"]),
  ).toMatchObject({ downloadModel: "qwen3-8b:Q4_K_M" });
  for (const args of [
    ["--prepare-runtime", "bash"],
    ["--runtime-login", "pi", "--device-login"],
    ["--owner-account"],
    ["--download-local-model", "--base-dir"],
    ["--download-local-model", "../x:Q4"],
  ])
    expect(() => parseInstallerArguments(args)).toThrow();
  expect(() => setupRuntime("bash")).toThrow("Invalid runtime.");
  expect(() => libraryModel("a b:c")).toThrow("Invalid local model.");
});

it("accepts linked runtimes only beside a subscription choice", () => {
  expect(
    validateInput({
      instance: "desktop",
      setupChoice: "codex",
      linkedRuntimes: ["claude"],
    }),
  ).toMatchObject({ linkedRuntimes: ["claude"] });
  for (const input of [
    { setupChoice: "pi", linkedRuntimes: ["claude"] },
    { linkedRuntimes: ["claude"] },
    { setupChoice: "codex", linkedRuntimes: ["pi"] },
    { setupChoice: "codex", linkedRuntimes: ["claude", "claude"] },
    { setupChoice: "codex", linkedRuntimes: "claude" },
  ])
    expect(() => validateInput({ instance: "desktop", ...input })).toThrow(
      /linked runtimes/i,
    );
});

const state = (installed: boolean, ready: boolean, version?: string) =>
  ({
    installed,
    ready,
    descriptor: version ? { version } : {},
  }) as unknown as Awaited<ReturnType<typeof inspectRuntime>>;

it("reports each runtime's installed and signed-in state; Pi is never signed in", async () => {
  const inspect = vi.fn(async (runtime: string) => {
    if (runtime === "codex") return state(true, true, "0.50.0");
    if (runtime === "claude") return state(true, false);
    return state(true, true);
  }) as unknown as typeof inspectRuntime;
  expect(await runtimeStatus("/home", { inspect })).toEqual({
    runtimes: [
      { runtime: "codex", installed: true, signedIn: true, version: "0.50.0" },
      { runtime: "claude", installed: true, signedIn: false },
      { runtime: "pi", installed: true, signedIn: false },
    ],
  });
  const failing = vi.fn(async (runtime: string) => {
    if (runtime === "claude") throw new Error("probe failed");
    return state(false, false);
  }) as unknown as typeof inspectRuntime;
  expect((await runtimeStatus("/home", { inspect: failing })).runtimes).toEqual(
    [
      { runtime: "codex", installed: false, signedIn: false },
      { runtime: "claude", installed: false, signedIn: false, unknown: true },
      { runtime: "pi", installed: false, signedIn: false },
    ],
  );
});

it("installs a runtime with byte progress and reads its sign-in from the outcome", async () => {
  const lines: Record<string, unknown>[] = [];
  const prepare = vi.fn(
    async (
      _runtime: string,
      options: { onEvent?: (event: object) => void },
    ) => {
      options.onEvent?.({
        kind: "stage",
        progress: { unit: "bytes", completed: 10, total: 100 },
      });
      options.onEvent?.({
        kind: "stage",
        progress: { unit: "bytes", completed: 20, total: 100 },
      });
      options.onEvent?.({ kind: "stage", message: "Applying" });
      options.onEvent?.({
        kind: "stage",
        progress: { unit: "bytes", completed: 100, total: 100 },
      });
      return {
        code: 4,
        state: "action_required",
        message: "Sign in",
        details: { code: "RUNTIME_AUTH_REQUIRED" },
      };
    },
  );
  const outcome = await prepareSetupRuntime("/home", "claude", {
    signal: new AbortController().signal,
    write: (line) => lines.push(line),
    prepare: prepare as never,
  });
  expect(outcome).toEqual({ installed: true, signedIn: false });
  expect(prepare).toHaveBeenCalledWith(
    "claude",
    expect.objectContaining({ home: "/home", reuseInstalled: true }),
  );
  // Throttled: the first and the final byte counts, nothing else.
  expect(lines).toEqual([
    { event: "progress", completed: 10, total: 100 },
    { event: "progress", completed: 100, total: 100 },
  ]);

  const failed = await prepareSetupRuntime("/home", "codex", {
    signal: new AbortController().signal,
    write: () => undefined,
    prepare: (async () => ({
      code: 4,
      state: "action_required",
      message: "Another install is running",
      details: { code: "busy" },
    })) as never,
  });
  expect(failed).toEqual({
    installed: false,
    signedIn: false,
    message: "Another install is running",
  });
});

function loginManager(states: Record<string, unknown>[]) {
  const calls: unknown[][] = [];
  let index = 0;
  const manager = {
    start: vi.fn(async (...args: unknown[]) => {
      calls.push(args);
      return { state: "waiting", url: "https://vendor.example/login" };
    }),
    status: vi.fn(async () => states[Math.min(index++, states.length - 1)]),
    cancel: vi.fn(),
    close: vi.fn(),
  };
  return { manager, calls };
}

it("streams sign-in snapshots until signed in, passing codes through", async () => {
  const { manager } = loginManager([
    { state: "waiting", url: "https://vendor.example/login" },
    { state: "ready" },
  ]);
  const lines: Record<string, unknown>[] = [];
  async function* codes() {
    yield "  ABCD-1234 ";
  }
  await setupRuntimeLogin("/home", "codex", {
    signal: new AbortController().signal,
    write: (line) => lines.push(line),
    codes: codes(),
    method: "device",
    pollMs: 1,
    manager: manager as unknown as RuntimeLoginManager,
  });
  expect(manager.start).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({ runtime: "codex", home: "/home" }),
    undefined,
    "device",
  );
  expect(manager.start).toHaveBeenCalledWith(
    expect.objectContaining({ runtime: "codex" }),
    "ABCD-1234",
  );
  // Unchanged snapshots are sent once.
  expect(lines).toEqual([
    { state: "waiting", url: "https://vendor.example/login" },
    { state: "ready" },
  ]);
  expect(manager.cancel).not.toHaveBeenCalled();
  expect(manager.close).toHaveBeenCalled();
});

it("cancels the vendor sign-in when stopped", async () => {
  const { manager } = loginManager([{ state: "waiting" }]);
  const controller = new AbortController();
  const done = setupRuntimeLogin("/home", "claude", {
    signal: controller.signal,
    write: () => undefined,
    pollMs: 5,
    manager: manager as unknown as RuntimeLoginManager,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort();
  await done;
  expect(manager.cancel).toHaveBeenCalledWith("setup");
  expect(manager.close).toHaveBeenCalled();
});

it("presets the owner sign-in from stdin and never echoes the password", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "owner-account-"));
  roots.push(home);
  const password = "chosen password 9";
  const written = await presetOwnerAccount(
    home,
    "desktop",
    JSON.stringify({ email: "me@example.com", password }),
  );
  expect(written).toEqual({ written: true });
  const file = path.join(home, "instances", "desktop", "local-account.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({
    email: "me@example.com",
    password,
  });
  for (const input of [
    "not json",
    JSON.stringify({ email: "me@example.com" }),
    JSON.stringify({ email: "bad", password }),
  ]) {
    const outcome = await presetOwnerAccount(home, "other", input);
    expect(outcome).toHaveProperty("error");
    expect(JSON.stringify(outcome)).not.toContain(password);
  }
});

it("downloads the planned model into the library with throttled progress", async () => {
  const lines: Record<string, unknown>[] = [];
  const event = (value: object) =>
    `${JSON.stringify({ schema: "localmodels.library-event/v1", ...value })}\n`;
  const localmodels = vi.fn(
    async (
      _home: string,
      _args: string[],
      options: { onOutput?: (chunk: string) => void },
    ) => {
      options.onOutput?.(
        event({
          event: "progress",
          phase: "download",
          done: 5,
          total: 50,
          bytes_per_second: 7.4,
        }) +
          event({ event: "progress", phase: "download", done: 6, total: 50 }),
      );
      // A line split across chunks.
      const last = event({
        event: "progress",
        phase: "verify",
        done: 50,
        total: 50,
      });
      options.onOutput?.(last.slice(0, 20));
      options.onOutput?.(last.slice(20) + "not json\n");
      options.onOutput?.(event({ event: "result", ok: true }));
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  const home = path.resolve("/models-home");
  expect(
    await downloadLocalModel(home, "qwen3-8b:Q4_K_M", {
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
      localmodels: localmodels as never,
    }),
  ).toEqual({ state: "done" });
  expect(localmodels.mock.calls[0]![1]).toEqual([
    "library",
    "download",
    "qwen3-8b:Q4_K_M",
    "--base-dir",
    path.join(home, "runtime", "localmodels", "models"),
    "--jsonl",
  ]);
  expect(lines).toEqual([
    {
      event: "progress",
      phase: "download",
      completed: 5,
      total: 50,
      bytesPerSecond: 7,
    },
    { event: "progress", phase: "verify", completed: 50, total: 50 },
  ]);
});

it("retries a busy model library and reports a failed download", async () => {
  let calls = 0;
  const busyThenFail = vi.fn(
    async (
      _home: string,
      _args: string[],
      options: { onOutput?: (chunk: string) => void },
    ) => {
      calls++;
      if (calls === 1) return { code: 2, stdout: "", stderr: "" };
      options.onOutput?.(
        `${JSON.stringify({
          schema: "localmodels.library-event/v1",
          event: "error",
          code: "disk_full",
          detail: "Not enough disk space",
        })}\n`,
      );
      return { code: 1, stdout: "", stderr: "" };
    },
  );
  expect(
    await downloadLocalModel("/home", "qwen3-8b:Q4_K_M", {
      signal: new AbortController().signal,
      write: () => undefined,
      localmodels: busyThenFail as never,
      retryMs: 1,
    }),
  ).toEqual({
    state: "failed",
    code: "disk_full",
    message: "Not enough disk space",
  });
  expect(calls).toBe(2);
});
