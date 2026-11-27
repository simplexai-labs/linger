import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { Instance } from "@linger/local-installation/instance";
import type { RuntimeDescriptor } from "@linger/local-installation/managed-runtimes";

vi.mock("@linger/local-installation/instance", () => ({
  loadInstance: vi.fn(),
}));
vi.mock("@linger/local-installation/setup-selection", () => ({
  readSetupChoice: vi.fn(),
}));
vi.mock("@linger/local-installation/byok-source", () => ({
  readByokEnvironment: vi.fn(),
}));
vi.mock("@linger/local-installation/local-models", () => ({
  localModelsEnvironment: vi.fn(),
}));
vi.mock("@linger/local-installation/managed-codex", () => ({
  managedRuntimeEnvironment: vi.fn(),
}));
vi.mock("@linger/local-installation/localmodels-computer", () => ({
  LOCALMODELS_TOOL_ENVIRONMENT: ["LINGER_LOCALMODELS_PYTHON"],
  localmodelsComputerTool: vi.fn(),
  localmodelsToolEnvironment: vi.fn(() => ({})),
}));
vi.mock("@linger/local-installation/localmodels-tool", () => ({
  pinnedToolSource: vi.fn(() => undefined),
}));

import { loadInstance } from "@linger/local-installation/instance";
import { readSetupChoice } from "@linger/local-installation/setup-selection";
import { readByokEnvironment } from "@linger/local-installation/byok-source";
import { localModelsEnvironment } from "@linger/local-installation/local-models";
import { managedRuntimeEnvironment } from "@linger/local-installation/managed-codex";
import { localmodelsComputerTool } from "@linger/local-installation/localmodels-computer";
import {
  formatRuntimeLookupTimings,
  RUNTIME_LOOKUP_TIMINGS_EVENT,
  instanceRuntime,
  type RuntimeLookupTimings,
} from "./instance-runtime.js";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadInstance).mockResolvedValue({
    name: "local",
    root: "/home/instances/local",
  } as Instance);
  vi.mocked(readSetupChoice).mockResolvedValue("pi");
  vi.mocked(readByokEnvironment).mockResolvedValue(undefined);
  vi.mocked(localModelsEnvironment).mockResolvedValue({});
  vi.mocked(managedRuntimeEnvironment).mockResolvedValue({
    LINGER_PI_PATH: "/probed/pi",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("reuses inspected runtime descriptors without re-probing managedRuntimeEnvironment", async () => {
  const descriptor: RuntimeDescriptor = {
    runtime: "pi",
    executable: "/reused/pi",
    argvPrefix: [],
    installed: true,
    authenticated: true,
    authMode: "api_key",
    loginCommand: null,
    environment: { PI_CODING_AGENT_DIR: "/home/runtime/pi" },
  };
  const result = await instanceRuntime("/home", "local", {
    runtimeDescriptors: [descriptor],
  });
  expect(result).toEqual({
    setupChoice: "pi",
    environment: {
      LINGER_PI_PATH: "/reused/pi",
      PI_CODING_AGENT_DIR: "/home/runtime/pi",
    },
  });
  expect(managedRuntimeEnvironment).not.toHaveBeenCalled();
});

test("falls back to managedRuntimeEnvironment when no descriptors are supplied", async () => {
  const result = await instanceRuntime("/home", "local");
  expect(result).toEqual({
    setupChoice: "pi",
    environment: { LINGER_PI_PATH: "/probed/pi" },
  });
  expect(managedRuntimeEnvironment).toHaveBeenCalledWith(
    "/home",
    "/home/instances/local",
  );
});

test("reports separate stage timings for a runtime lookup", async () => {
  const timings: RuntimeLookupTimings[] = [];
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);

  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };
  const choice = deferred<"pi">();
  const byok = deferred<undefined>();
  const runtime = deferred<{ LINGER_PI_PATH: string }>();
  const localModels = deferred<Record<string, string>>();
  const tool = deferred<undefined>();

  vi.mocked(loadInstance).mockImplementationOnce(async () => {
    clock += 4;
    return { name: "local", root: "/home/instances/local" } as Instance;
  });
  vi.mocked(readSetupChoice).mockImplementationOnce(() => choice.promise);
  vi.mocked(readByokEnvironment).mockImplementationOnce(() => byok.promise);
  vi.mocked(managedRuntimeEnvironment).mockImplementationOnce(
    () => runtime.promise,
  );
  vi.mocked(localModelsEnvironment).mockImplementationOnce(
    () => localModels.promise,
  );
  vi.mocked(localmodelsComputerTool).mockImplementationOnce(
    () => tool.promise as never,
  );

  const pending = instanceRuntime("/home", "local", {
    onTimings: (value) => timings.push(value),
  });
  await vi.waitFor(() => {
    expect(readSetupChoice).toHaveBeenCalledTimes(1);
    expect(readByokEnvironment).toHaveBeenCalledTimes(1);
    expect(managedRuntimeEnvironment).toHaveBeenCalledTimes(1);
    expect(localModelsEnvironment).toHaveBeenCalledTimes(1);
    expect(localmodelsComputerTool).toHaveBeenCalledTimes(1);
  });

  // All 5 lookups started concurrently at clock = 4; settle them at staggered
  // timestamps so per-stage durations exceed wall-clock total.
  clock = 6;
  choice.resolve("pi");
  byok.resolve(undefined);
  await Promise.resolve();
  clock = 9;
  localModels.resolve({});
  await Promise.resolve();
  clock = 11;
  runtime.resolve({ LINGER_PI_PATH: "/probed/pi" });
  await Promise.resolve();
  clock = 13;
  tool.resolve(undefined);

  await pending;

  expect(timings).toEqual([
    { config: 8, runtime: 7, localModels: 5, tool: 9, total: 13 },
  ]);
});

test("runs independent runtime lookups concurrently after loading the instance", async () => {
  const entered = new Set<string>();
  let releaseAll!: () => void;
  const allEntered = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  const barrier = async (name: string) => {
    entered.add(name);
    if (entered.size === 5) releaseAll();
    await allEntered;
  };
  vi.mocked(readSetupChoice).mockImplementationOnce(async () => {
    await barrier("setupChoice");
    return "pi";
  });
  vi.mocked(readByokEnvironment).mockImplementationOnce(async () => {
    await barrier("byok");
    return undefined;
  });
  vi.mocked(managedRuntimeEnvironment).mockImplementationOnce(async () => {
    await barrier("runtime");
    return { LINGER_PI_PATH: "/probed/pi" };
  });
  vi.mocked(localModelsEnvironment).mockImplementationOnce(async () => {
    await barrier("localModels");
    return {};
  });
  vi.mocked(localmodelsComputerTool).mockImplementationOnce(async () => {
    await barrier("tool");
    return undefined as never;
  });

  const result = await instanceRuntime("/home", "local");
  expect(entered).toEqual(
    new Set(["setupChoice", "byok", "runtime", "localModels", "tool"]),
  );
  expect(result).toEqual({
    setupChoice: "pi",
    environment: { LINGER_PI_PATH: "/probed/pi" },
  });
});

test("drains sibling lookups before rejecting and reports settled timings", async () => {
  const timings: RuntimeLookupTimings[] = [];
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);

  const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
  const choice = deferred<"pi">();
  const byok = deferred<undefined>();
  const runtime = deferred<{ LINGER_PI_PATH: string }>();
  const localModels = deferred<Record<string, string>>();
  const tool = deferred<undefined>();

  vi.mocked(loadInstance).mockImplementationOnce(async () => {
    clock += 2;
    return { name: "local", root: "/home/instances/local" } as Instance;
  });
  vi.mocked(readSetupChoice).mockImplementationOnce(() => choice.promise);
  vi.mocked(readByokEnvironment).mockImplementationOnce(() => byok.promise);
  vi.mocked(managedRuntimeEnvironment).mockImplementationOnce(
    () => runtime.promise,
  );
  vi.mocked(localModelsEnvironment).mockImplementationOnce(
    () => localModels.promise,
  );
  vi.mocked(localmodelsComputerTool).mockImplementationOnce(
    () => tool.promise as never,
  );

  let settled = false;
  const outcome = instanceRuntime("/home", "local", {
    onTimings: (value) => timings.push(value),
  }).then(
    (value) => {
      settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      settled = true;
      return { ok: false as const, error };
    },
  );

  await vi.waitFor(() => {
    expect(readSetupChoice).toHaveBeenCalledTimes(1);
    expect(readByokEnvironment).toHaveBeenCalledTimes(1);
    expect(managedRuntimeEnvironment).toHaveBeenCalledTimes(1);
    expect(localModelsEnvironment).toHaveBeenCalledTimes(1);
    expect(localmodelsComputerTool).toHaveBeenCalledTimes(1);
  });

  const firstFailure = new Error("setup choice unreadable");
  clock = 5;
  choice.reject(firstFailure);
  await Promise.resolve();
  await Promise.resolve();

  // Sibling lookups are still pending, so instanceRuntime has neither rejected
  // nor emitted timings yet.
  expect(settled).toBe(false);
  expect(timings).toEqual([]);

  clock = 6;
  byok.resolve(undefined);
  await Promise.resolve();
  clock = 8;
  localModels.resolve({});
  await Promise.resolve();
  clock = 10;
  runtime.resolve({ LINGER_PI_PATH: "/probed/pi" });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(timings).toEqual([]);

  clock = 12;
  tool.reject(new Error("tool probe failed"));

  const result = await outcome;
  expect(settled).toBe(true);
  expect(result).toEqual({ ok: false, error: firstFailure });
  expect(timings).toEqual([
    { config: 9, runtime: 8, localModels: 6, tool: 10, total: 12 },
  ]);
});

test("formats runtime lookup timings as one JSON line", () => {
  const timings = { config: 1, runtime: 2, localModels: 3, tool: 4, total: 10 };
  const line = formatRuntimeLookupTimings("desk\ntop", timings);
  expect(line.endsWith("\n")).toBe(true);
  expect(line.slice(0, -1)).not.toContain("\n");
  expect(JSON.parse(line)).toEqual({
    event: RUNTIME_LOOKUP_TIMINGS_EVENT,
    instance: "desk\ntop",
    timings,
  });
});
