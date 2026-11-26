import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prepareDependencies } from "./dependencies.js";
const noDaemon = async () => null;
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "linger-online-"));
  roots.push(home);
  return {
    home,
    dependency: "codex" as const,
    signal: new AbortController().signal,
    onEvent: vi.fn(),
    platform: "linux" as const,
  };
}
it("cancellation cannot become a successful preparation result", async () => {
  const options = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareDependencies(
      { ...options, signal: controller.signal },
      { run: vi.fn() },
    ),
  ).rejects.toThrow();
});
it.each(["codex", "claude", "pi"] as const)(
  "serializes %s installation with the shared dependency lock",
  async (dependency) => {
    const options = await fixture();
    const { DatabaseSync } = await import("node:sqlite");
    const { mkdir } = await import("node:fs/promises");
    const directory = path.join(options.home, "setup");
    await mkdir(directory);
    const lock = new DatabaseSync(path.join(directory, "dependencies.sqlite"));
    lock.exec("BEGIN EXCLUSIVE");
    const run = vi.fn();
    try {
      expect(
        (await prepareDependencies({ ...options, dependency }, { run })).state,
      ).toBe("busy");
      expect(run).not.toHaveBeenCalled();
    } finally {
      lock.close();
    }
  },
);
it("returns Runtime timeout category and stage through dependency preparation", async () => {
  const options = { ...(await fixture()), dependency: "pi" as const };
  const localmodels = vi.fn(async () => {
    throw Object.assign(new Error("Command timed out"), {
      code: "COMMAND_TIMEOUT",
    });
  });
  const result = await prepareDependencies(options, {
    localmodels,
    probeRuntimes: noDaemon,
  });
  expect(result).toMatchObject({
    state: "failed",
    details: { code: "COMMAND_TIMEOUT", stage: "runtime" },
  });
});
it.each([
  ["plan", "RUNTIME_ACTION_FAILED", "RUNTIME_PLAN_REFUSED"],
  ["apply", "RUNTIME_ACTION_FAILED", "RUNTIME_ACTION_FAILED"],
  ["apply", "RUNTIME_EXTENSIONS_FAILED", "RUNTIME_EXTENSIONS_FAILED"],
])(
  "returns the harness %s failure %s as %s through dependency preparation",
  async (step, upstream, code) => {
    const options = { ...(await fixture()), dependency: "pi" as const };
    const localmodels = vi.fn(async (_home: string, args: string[]) => {
      if (args[1] === "plan" && step !== "plan")
        await writeFile(
          args[args.indexOf("--out") + 1]!,
          JSON.stringify({
            schema: "localmodels.harness-plan/v1",
            id: "a".repeat(64),
            runtime: "pi",
          }),
        );
      const failed = args[1] === step;
      return {
        code: failed ? 1 : 0,
        stdout: failed
          ? JSON.stringify({
              schema: "localmodels.harness-error/v1",
              code: upstream,
              message: "Runtime action failed: upstream cause.",
            })
          : "",
        stderr: "",
      };
    });
    expect(
      await prepareDependencies(options, {
        localmodels,
        probeRuntimes: noDaemon,
      }),
    ).toMatchObject({
      state: "failed",
      details: { code, stage: "runtime" },
    });
  },
);
