import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { runLocalmodels } from "./localmodels-tool.js";
import { afterEach, expect, it, vi } from "vitest";
import {
  checkRuntimeModel,
  configureManagedCodex,
  managedRuntimeEnvironment,
  readManagedModel,
} from "./managed-codex.js";
const home = path.resolve("/owned");
const instance = path.join(home, "instances", "default");
const tempRoots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("delegates Responses probing and Codex model profile construction upstream via stdin", async () => {
  const localmodels = vi.fn<typeof runLocalmodels>(async () => ({
    code: 0,
    stdout: '{"saved":true}',
    stderr: "",
  }));
  await configureManagedCodex(
    instance,
    {
      baseUrl: "https://gateway.example/v1",
      model: "owner-model",
      apiKey: "private-key",
    },
    new AbortController().signal,
    { localmodels },
  );
  expect(localmodels).toHaveBeenCalledWith(
    home,
    [
      "harness",
      "auth",
      "--root",
      path.join(home, "runtime", "harness"),
      "--runtime",
      "codex",
      "--config-stdin",
      "--json",
    ],
    expect.objectContaining({
      input: JSON.stringify({
        provider: "openai-compatible",
        apiKey: "private-key",
        baseUrl: "https://gateway.example/v1",
        modelId: "owner-model",
        wireApi: "responses",
      }),
    }),
  );
  expect(JSON.stringify(localmodels.mock.calls[0]![1])).not.toContain(
    "private-key",
  );
});
it("does not return upstream errors or credentials when configuration fails", async () => {
  await expect(
    configureManagedCodex(
      instance,
      {
        baseUrl: "https://gateway.example/v1",
        model: "owner-model",
        apiKey: "private-key",
      },
      new AbortController().signal,
      {
        localmodels: vi.fn<typeof runLocalmodels>(async () => ({
          code: 1,
          stdout: "private-key",
          stderr: "secret",
        })),
      },
    ),
  ).rejects.toThrow("Runtime model configuration failed");
});

it("delegates read-only model checks without saving a profile", async () => {
  const localmodels = vi.fn<typeof runLocalmodels>(async () => ({
    code: 0,
    stdout: '{"verified":true}',
    stderr: "",
  }));
  await checkRuntimeModel(
    {
      baseUrl: "https://gateway.example/v1",
      model: "owner-model",
      apiKey: "private-key",
    },
    new AbortController().signal,
    { home, localmodels },
  );
  expect(localmodels.mock.calls[0]![1]).toContain("--check");
});

it("managedRuntimeEnvironment and readManagedModel read descriptors without invoking local-daemon", async () => {
  const scratch = await mkdtemp(path.join(tmpdir(), "managed-codex-nodaemon-"));
  tempRoots.push(scratch);
  const instanceRoot = path.join(scratch, "instances", "default");
  await mkdir(instanceRoot, { recursive: true });
  await writeFile(
    path.join(instanceRoot, "setup-choice.json"),
    JSON.stringify({ choice: "codex" }),
    { mode: 0o600 },
  );

  const marker = path.join(scratch, "daemon-probed");
  const fakeDaemon = path.join(
    scratch,
    process.platform === "win32"
      ? "linger-computer-daemon.cmd"
      : "linger-computer-daemon",
  );
  await writeFile(
    fakeDaemon,
    process.platform === "win32"
      ? `@echo probed > "${marker}"\r\n@exit /b 1\r\n`
      : `#!/bin/sh\necho probed > ${JSON.stringify(marker)}\nexit 1\n`,
    { mode: 0o700 },
  );
  vi.stubEnv("LINGER_COMPUTER_DAEMON", fakeDaemon);

  const localmodels = vi.fn<typeof runLocalmodels>(async () => ({
    code: 0,
    stdout: JSON.stringify({
      schema: "localmodels.harness-status/v1",
      runtimes: [
        {
          runtime: "codex",
          executable: "/managed/codex",
          argvPrefix: [],
          installed: true,
          authenticated: false,
          authMode: null,
          environment: { CODEX_HOME: "/managed/codex-home" },
          modelConfig: {
            baseUrl: "https://gateway.example/v1",
            model: "owner-model",
            keySaved: true,
          },
          loginCommand: null,
        },
      ],
    }),
    stderr: "",
  }));

  const env = await managedRuntimeEnvironment(scratch, instanceRoot, {
    localmodels,
  });
  expect(env).toEqual({
    CODEX_HOME: "/managed/codex-home",
    LINGER_CODEX_PATH: "/managed/codex",
  });

  const model = await readManagedModel(instanceRoot, { localmodels });
  expect(model).toEqual({
    baseUrl: "https://gateway.example/v1",
    model: "owner-model",
    keySaved: true,
  });
  await expect(access(marker)).rejects.toThrow();
});
