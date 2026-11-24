import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  localModelsConfig,
  localmodelsComputerTool,
  localmodelsToolEnvironment,
  localmodelsToolFromEnvironment,
} from "./localmodels-computer.js";
import type { LocalmodelsToolSource } from "./localmodels-tool.js";

const tool = {
  python: "/home/u/.linger/tools/localmodels/abc/python/bin/python3",
  moduleDirectory: "/home/u/.linger/tools/localmodels/abc",
  stateDirectory: "/home/u/.linger/runtime/localmodels/state",
  baseDirectory: "/home/u/.linger/runtime/localmodels/models",
};

it("carries the tool through an external Computer's runtime environment", () => {
  const environment = localmodelsToolEnvironment(tool);
  expect(
    Object.keys(environment).every((key) => key.startsWith("LINGER_")),
  ).toBe(true);
  expect(localmodelsToolFromEnvironment(environment, path.posix)).toEqual(tool);
  expect(localModelsConfig(tool)).toEqual({
    python: tool.python,
    module_directory: tool.moduleDirectory,
    state_directory: tool.stateDirectory,
    base_directory: tool.baseDirectory,
  });
});

it("names no tool unless all four paths are absolute", () => {
  const environment = localmodelsToolEnvironment(tool);
  expect(localmodelsToolEnvironment(undefined)).toEqual({});
  expect(localmodelsToolFromEnvironment(undefined)).toBeUndefined();
  expect(
    localmodelsToolFromEnvironment(
      { ...environment, LINGER_LOCALMODELS_STATE: "state" },
      path.posix,
    ),
  ).toBeUndefined();
  const { LINGER_LOCALMODELS_BASE_DIR: _base, ...partial } = environment;
  expect(localmodelsToolFromEnvironment(partial, path.posix)).toBeUndefined();
});

const ensure = vi.hoisted(() => vi.fn());
vi.mock("./localmodels-tool.js", () => ({
  ensureLocalmodelsTool: ensure,
  localmodelsStateDirectory: (home: string) =>
    path.join(home, "runtime", "localmodels", "state"),
  localmodelsBaseDirectory: (home: string) =>
    path.join(home, "runtime", "localmodels", "models"),
}));

const homes: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  ensure.mockReset();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home() {
  const value = await mkdtemp(path.join(tmpdir(), "localmodels-computer-"));
  homes.push(value);
  return value;
}

it("follows the tool source its caller passes, not the process environment", async () => {
  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", '{"sha256":"ambient"}');
  expect(await localmodelsComputerTool(await home(), undefined)).toBe(
    undefined,
  );
  expect(ensure).not.toHaveBeenCalled();

  vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", "");
  const source = { sha256: "shipped" } as LocalmodelsToolSource;
  const where = await home();
  ensure.mockResolvedValue({
    python: path.join(where, "kit", "python3"),
    moduleDir: path.join(where, "kit"),
  });
  expect(await localmodelsComputerTool(where, source)).toEqual({
    python: path.join(where, "kit", "python3"),
    moduleDirectory: path.join(where, "kit"),
    stateDirectory: path.join(where, "runtime", "localmodels", "state"),
    baseDirectory: path.join(where, "runtime", "localmodels", "models"),
  });
  expect(ensure).toHaveBeenCalledWith(where, {}, { source });
});
