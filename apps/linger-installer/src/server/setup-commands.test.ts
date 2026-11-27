import path from "node:path";
import { expect, it, vi } from "vitest";
import type { inspectRuntime } from "@linger/local-installation/managed-runtimes";
import { parseInstallerArguments } from "../main.js";
import type { RuntimeLoginManager } from "./runtime-login.js";
import {
  checkLocalModel,
  downloadLocalModel,
  libraryModel,
  prepareSetupRuntime,
  runtimeStatus,
  setupRuntime,
  setupRuntimeLogin,
} from "./setup-commands.js";
import { validateInput } from "./validation.js";

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
    parseInstallerArguments(["--runtime-login", "codex", "--browser-login"]),
  ).toMatchObject({ runtimeLogin: "codex", browserLogin: true });
  expect(
    parseInstallerArguments(["--download-local-model", "qwen3-8b:Q4_K_M"]),
  ).toMatchObject({ downloadModel: "qwen3-8b:Q4_K_M" });
  expect(
    parseInstallerArguments(["--check-local-model", "qwen3-8b:Q4_K_M"]),
  ).toMatchObject({ checkModel: "qwen3-8b:Q4_K_M" });
  for (const args of [
    ["--prepare-runtime", "bash"],
    ["--runtime-login", "pi", "--device-login"],
    ["--runtime-login", "claude", "--browser-login"],
    ["--runtime-login", "pi", "--browser-login"],
    ["--runtime-login", "codex", "--device-login", "--browser-login"],
    ["--owner-account"],
    ["--download-local-model", "--base-dir"],
    ["--download-local-model", "../x:Q4"],
    ["--check-local-model", "--llm"],
    ["--check-local-model", "x"],
  ])
    expect(() => parseInstallerArguments(args)).toThrow();
  expect(() => setupRuntime("bash")).toThrow("Invalid runtime.");
  expect(() => libraryModel("a b:c")).toThrow("Invalid local model.");
});

it("prices a picked local model with an offline plan in the install home", async () => {
  const home = path.resolve("/owned");
  const localmodels = vi.fn(async () => ({
    code: 2,
    stdout: JSON.stringify({
      schema: "localmodels.stack-plan-error/v1",
      event: "error",
      code: "MEMORY_INSUFFICIENT",
    }),
    stderr: "",
  }));
  const check = await checkLocalModel(home, "qwen3.6-35b-a3b:UD-Q4_K_M", {
    signal: new AbortController().signal,
    localmodels,
  });
  expect(check).toEqual({
    library: "qwen3.6-35b-a3b:UD-Q4_K_M",
    fits: false,
    code: "MEMORY_INSUFFICIENT",
  });
  const args = (localmodels.mock.calls[0] as unknown as [string, string[]])[1];
  expect(args.slice(0, 6)).toEqual([
    "stack",
    "plan",
    "--llm",
    "qwen3.6-35b-a3b",
    "--quant",
    "UD-Q4_K_M",
  ]);
  expect(args).toContain("--offline");
  expect(args[args.indexOf("--base-dir") + 1]).toBe(
    path.join(home, "runtime", "localmodels", "models"),
  );
});

it("accepts a picked local model only with the local-models choice", () => {
  expect(
    validateInput({
      instance: "desktop",
      setupChoice: "local-models",
      localModel: "inkling-2-mini:UD-Q4_K_M",
    }),
  ).toMatchObject({ localModel: "inkling-2-mini:UD-Q4_K_M" });
  for (const input of [
    { setupChoice: "codex", localModel: "inkling-2-mini:UD-Q4_K_M" },
    { localModel: "inkling-2-mini:UD-Q4_K_M" },
    { setupChoice: "local-models", localModel: "--llm" },
    { setupChoice: "local-models", localModel: 4 },
  ])
    expect(() => validateInput({ instance: "desktop", ...input })).toThrow(
      /local model/i,
    );
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

it("caches runtime descriptor inspection across start and status polls", async () => {
  let inspectCalls = 0;
  const inspectDescriptors = vi.fn(async () => [
    {
      runtime: "codex" as const,
      executable: process.execPath,
      argvPrefix: [],
      installed: true,
      authenticated: false,
      authMode: null,
    },
  ]);
  const inspect = vi.fn(async () => {
    inspectCalls += 1;
    const ready = inspectCalls >= 3;
    return {
      runtime: "codex" as const,
      executable: process.execPath,
      installed: true,
      ready,
      loginCommand: "unused",
      descriptor: {
        runtime: "codex" as const,
        executable: process.execPath,
        argvPrefix: [],
        installed: true,
        authenticated: ready,
        authMode: ready ? "authenticated" : null,
        loginCommand: {
          executable: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
          env: {},
        },
        deviceLoginCommand: {
          executable: process.execPath,
          args: ["-e", "setTimeout(() => {}, 5000)"],
          env: {},
        },
      },
    };
  }) as unknown as typeof inspectRuntime;
  const lines: Record<string, unknown>[] = [];
  await setupRuntimeLogin("/home", "codex", {
    signal: new AbortController().signal,
    write: (line) => lines.push(line),
    method: "device",
    pollMs: 5,
    inspect,
    inspectDescriptors: inspectDescriptors as never,
  });
  expect(inspectDescriptors).toHaveBeenCalledTimes(1);
  expect(inspect).toHaveBeenCalledTimes(3);
  expect(lines.at(-1)).toEqual({ state: "ready" });
});

it("maps TimeoutError and COMMAND_TIMEOUT failures to reason timed_out with clean copy", async () => {
  const timeoutCases: unknown[] = [
    new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    ),
    Object.assign(new Error("probe exceeded deadline"), {
      code: "COMMAND_TIMEOUT",
    }),
  ];
  for (const error of timeoutCases) {
    const lines: Record<string, unknown>[] = [];
    const manager = {
      start: vi.fn(async () => {
        throw error;
      }),
      status: vi.fn(),
      cancel: vi.fn(),
      close: vi.fn(),
    };
    await setupRuntimeLogin("/home", "codex", {
      signal: new AbortController().signal,
      write: (line) => lines.push(line),
      manager: manager as unknown as RuntimeLoginManager,
    });
    expect(lines).toEqual([
      {
        state: "failed",
        reason: "timed_out",
        message: "Sign-in timed out. Retry or sign in later.",
      },
    ]);
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
