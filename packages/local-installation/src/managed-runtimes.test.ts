import { afterEach, expect, it, vi } from "vitest";
import {
  access,
  chmod,
  mkdtemp,
  readlink,
  rm,
  writeFile,
  realpath,
  readdir,
  symlink,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installNativeRuntime,
  inspectRuntime,
  inspectRuntimeDescriptors,
  prepareRuntime,
  runtimeEnvironmentFromDescriptors,
} from "./managed-runtimes.js";
const noDaemon = async () => null;
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const status = (runtime = "claude", ready = false) => ({
  schema: "localmodels.harness-status/v1",
  runtimes: [
    {
      runtime,
      executable: "/upstream/runtime",
      argvPrefix: [],
      installed: true,
      authenticated: ready,
      authMode: ready ? "oauth" : null,
      loginCommand: {
        executable: "/upstream/runtime",
        args: ["upstream-login"],
        env: {},
      },
    },
  ],
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "runtime-delegate-"));
  roots.push(home);
  return { home, signal: new AbortController().signal, onEvent: vi.fn() };
}
it("uses upstream status and OAuth descriptors without provider-specific probes", async () => {
  const options = await fixture();
  const localmodels = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify(status()),
    stderr: "",
  }));
  const value = await inspectRuntime("claude", options, {
    localmodels,
    probeRuntimes: noDaemon,
  });
  expect(value).toMatchObject({
    installed: true,
    ready: false,
    executable: "/upstream/runtime",
    loginCommand:
      process.platform === "win32"
        ? "& '/upstream/runtime' 'upstream-login'"
        : "'/upstream/runtime' 'upstream-login'",
  });
  expect(localmodels.mock.calls[0]?.slice(0, 2)).toEqual([
    options.home,
    [
      "harness",
      "status",
      "--root",
      path.join(options.home, "runtime", "harness"),
      "--runtime",
      "claude",
      "--json",
    ],
  ]);
});
it("approves the exact upstream install plan and delegates apply", async () => {
  const options = await fixture();
  const id = "a".repeat(64);
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "pi",
        }),
      );
    return {
      code: 0,
      stdout: args[1] === "status" ? JSON.stringify(status("pi", true)) : "",
      stderr: "",
    };
  });
  expect(
    await installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).toMatchObject({ state: "ready" });
  expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
    "plan",
    "apply",
    "status",
  ]);
  const apply = localmodels.mock.calls[1]![1];
  expect(apply).toEqual([
    "harness",
    "apply",
    expect.any(String),
    "--approve",
    id,
    "--jsonl",
  ]);
  expect(localmodels.mock.calls[0]![1]).toContain(process.execPath);
});
it("does not fall back to an installer when upstream fails", async () => {
  const options = await fixture();
  const run = vi.fn();
  await expect(
    installNativeRuntime("codex", options, {
      run,
      probeRuntimes: noDaemon,
      localmodels: vi.fn(async () => ({
        code: 1,
        stdout: "secret",
        stderr: "secret",
      })),
    }),
  ).rejects.toMatchObject({ code: "LOCALMODELS_RUNTIME_UNAVAILABLE" });
  expect(run).not.toHaveBeenCalled();
});
it("honors cancellation before upstream installation", async () => {
  const options = await fixture();
  const localmodels = vi.fn();
  await expect(
    installNativeRuntime(
      "pi",
      { ...options, signal: AbortSignal.abort() },
      { localmodels },
    ),
  ).rejects.toThrow();
  expect(localmodels).not.toHaveBeenCalled();
});

it("keeps runtime plans under private Linger state regardless of the system temp directory", async () => {
  const options = await fixture();
  const parent = await realpath(options.home);
  const target = path.join(parent, "temp-target");
  const alias = path.join(parent, "temp-alias");
  await mkdir(target);
  await symlink(
    target,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  for (const key of ["TMPDIR", "TMP", "TEMP"]) vi.stubEnv(key, alias);
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan") {
      const file = args[args.indexOf("--out") + 1]!;
      expect(path.dirname(file)).toBe(await realpath(path.dirname(file)));
      expect(path.dirname(path.dirname(file))).toBe(
        path.join(parent, "setup", "harness-plans"),
      );
      await writeFile(
        file,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id: "a".repeat(64),
          runtime: "pi",
        }),
      );
    }
    return {
      code: 0,
      stdout: args[1] === "status" ? JSON.stringify(status("pi", true)) : "",
      stderr: "",
    };
  });
  await expect(
    installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).resolves.toMatchObject({ state: "ready" });
  expect(await readdir(target)).toEqual([]);
  expect(await readdir(path.join(parent, "setup", "harness-plans"))).toEqual(
    [],
  );
  await expect(
    installNativeRuntime("pi", options, {
      localmodels: async () => ({ code: 1, stdout: "", stderr: "" }),
      probeRuntimes: noDaemon,
    }),
  ).rejects.toMatchObject({ code: "LOCALMODELS_RUNTIME_UNAVAILABLE" });
  expect(await readdir(path.join(parent, "setup", "harness-plans"))).toEqual(
    [],
  );
});
it("uses the upstream-selected profile even when the launcher inherited another profile", () => {
  vi.stubEnv("CODEX_HOME", "/external/inherited");
  const descriptor = {
    ...status("codex", true).runtimes[0]!,
    runtime: "codex" as const,
    environment: { CODEX_HOME: "/selected/profile" },
  };
  expect(runtimeEnvironmentFromDescriptors([descriptor]).CODEX_HOME).toBe(
    "/selected/profile",
  );
});

it("preserves the safe timeout category instead of replacing it with runtime unavailable", async () => {
  const options = await fixture();
  const localmodels = vi.fn(async () => {
    throw Object.assign(new Error("Command timed out"), {
      code: "COMMAND_TIMEOUT",
    });
  });
  await expect(
    installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
  await expect(
    inspectRuntime("pi", options, { localmodels, probeRuntimes: noDaemon }),
  ).rejects.toMatchObject({ code: "COMMAND_TIMEOUT" });
});

it.each([
  "RUNTIME_VERSION_TIMEOUT",
  "RUNTIME_VERSION_EXECUTION_FAILED",
  "RUNTIME_VERSION_MISMATCH",
])(
  "keeps allowlisted upstream Runtime cause %s without native errors",
  async (code) => {
    const options = await fixture();
    const localmodels = vi.fn(async (_home: string, args: string[]) => {
      if (args[1] === "plan")
        await writeFile(
          args[args.indexOf("--out") + 1]!,
          JSON.stringify({
            schema: "localmodels.harness-plan/v1",
            id: "a".repeat(64),
            runtime: "pi",
          }),
        );
      return {
        code: args[1] === "apply" ? 1 : 0,
        stdout:
          args[1] === "apply"
            ? JSON.stringify({
                schema: "localmodels.harness-error/v1",
                code,
                message: "private-token raw native details",
              })
            : "",
        stderr: "private-token",
      };
    });
    const failure = await installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }).catch((error: Error & { code: string }) => error);
    expect(failure).toMatchObject({ code });
    expect((failure as Error).message).not.toContain("private-token");
  },
);

it("names the upstream cause of a failed Harness apply and logs its output", async () => {
  const options = await fixture();
  const events: string[] = [];
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id: "a".repeat(64),
          runtime: "claude",
        }),
      );
    return {
      code: args[1] === "apply" ? 1 : 0,
      stdout:
        args[1] === "apply"
          ? JSON.stringify({
              schema: "localmodels.harness-error/v1",
              code: "HARNESS_DOWNLOAD_FAILED",
              message:
                "Download of claude from downloads.claude.ai failed: timed out.",
            })
          : "",
      stderr: "",
    };
  });
  const failure = await installNativeRuntime(
    "claude",
    { ...options, onEvent: (event) => events.push(event.message) },
    { localmodels, probeRuntimes: noDaemon },
  ).catch((error: Error & { code: string }) => error);
  expect(failure).toMatchObject({
    code: "LOCALMODELS_RUNTIME_UNAVAILABLE",
    message:
      "The localmodels Runtime operation failed: Download of claude from downloads.claude.ai failed: timed out.",
  });
  expect(events.join("\n")).toContain("HARNESS_DOWNLOAD_FAILED");
});

function applyFailing(failures: string[]) {
  return vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id: "a".repeat(64),
          runtime: "pi",
        }),
      );
    const code = args[1] === "apply" ? failures.shift() : undefined;
    return {
      code: code ? 1 : 0,
      stdout: code
        ? JSON.stringify({ schema: "localmodels.harness-error/v1", code })
        : args[1] === "status"
          ? JSON.stringify(status("pi", true))
          : "",
      stderr: "",
    };
  });
}
const applies = (localmodels: ReturnType<typeof applyFailing>) =>
  localmodels.mock.calls.filter(([, args]) => args[1] === "apply");

it("retries a Windows Runtime version execution failure once", async () => {
  const options = { ...(await fixture()), platform: "win32" as const };
  const localmodels = applyFailing(["RUNTIME_VERSION_EXECUTION_FAILED"]);
  expect(
    await installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).toMatchObject({ state: "ready" });
  expect(applies(localmodels)).toHaveLength(2);
  expect(applies(localmodels)[1]![1]).toEqual(applies(localmodels)[0]![1]);
  expect(options.onEvent).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "log", stage: "runtime" }),
  );
});

it("surfaces the second Windows Runtime version execution failure", async () => {
  const options = { ...(await fixture()), platform: "win32" as const };
  const localmodels = applyFailing([
    "RUNTIME_VERSION_EXECUTION_FAILED",
    "RUNTIME_VERSION_EXECUTION_FAILED",
  ]);
  await expect(
    installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).rejects.toMatchObject({ code: "RUNTIME_VERSION_EXECUTION_FAILED" });
  expect(applies(localmodels)).toHaveLength(2);
});

it.each([
  ["linux", "RUNTIME_VERSION_EXECUTION_FAILED"],
  ["win32", "RUNTIME_VERSION_MISMATCH"],
] as const)("does not retry on %s for %s", async (platform, code) => {
  const options = { ...(await fixture()), platform };
  const localmodels = applyFailing([code]);
  await expect(
    installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).rejects.toMatchObject({ code });
  expect(applies(localmodels)).toHaveLength(1);
});

it("does not retry once the install is cancelled during the wait", async () => {
  const controller = new AbortController();
  const options = {
    ...(await fixture()),
    signal: controller.signal,
    platform: "win32" as const,
    onEvent: vi.fn(() => controller.abort()),
  };
  const localmodels = applyFailing(["RUNTIME_VERSION_EXECUTION_FAILED"]);
  await expect(
    installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).rejects.toThrow();
  expect(applies(localmodels)).toHaveLength(1);
});

// A harness command that fails at `step` with one harness-error/v1 line.
function harnessFailing(step: "plan" | "apply", code: string, message = "") {
  return vi.fn(async (_home: string, args: string[]) => {
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
            code,
            message,
          })
        : "",
      stderr: "",
    };
  });
}

it("reports a plan the harness refused, such as a Windows runtime root too long for Pi", async () => {
  const options = await fixture();
  const localmodels = harnessFailing(
    "plan",
    "RUNTIME_ACTION_FAILED",
    "Runtime action failed: The runtime root is 120 characters; Pi's dependency tree fits below a root of at most 90 on Windows unless long paths are enabled. Inspect the plan and retry.",
  );
  const failure = await installNativeRuntime("pi", options, {
    localmodels,
    probeRuntimes: noDaemon,
  }).catch((error: Error & { code: string }) => error);
  expect(failure).toMatchObject({ code: "RUNTIME_PLAN_REFUSED" });
  expect((failure as Error).message).toContain(
    "The runtime root is 120 characters",
  );
  expect(localmodels.mock.calls.some(([, args]) => args[1] === "apply")).toBe(
    false,
  );
});

it.each(["RUNTIME_ACTION_FAILED", "RUNTIME_EXTENSIONS_FAILED"])(
  "keeps the harness apply failure %s as its code",
  async (code) => {
    const options = await fixture();
    const failure = await installNativeRuntime("pi", options, {
      probeRuntimes: noDaemon,
      localmodels: harnessFailing(
        "apply",
        code,
        "Runtime action failed: pi is still not usable after apply. Inspect the plan and retry.",
      ),
    }).catch((error: Error & { code: string }) => error);
    expect(failure).toMatchObject({ code });
  },
);

it("reuses the harness-status/v1 line emitted by harness apply without a redundant status call", async () => {
  const options = await fixture();
  const id = "b".repeat(64);
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "pi",
        }),
      );
    return {
      code: 0,
      stdout:
        args[1] === "apply"
          ? [
              JSON.stringify({
                kind: "stage",
                stage: "install",
                state: "succeeded",
              }),
              JSON.stringify(status("pi", false)),
            ].join("\n") + "\n"
          : "",
      stderr: "",
    };
  });
  expect(
    await installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).toMatchObject({
    code: 0,
    state: "ready",
    details: { executable: "/upstream/runtime" },
  });
  expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
    "plan",
    "apply",
  ]);
});

it("fails closed when harness apply emits installed: false in its final status line", async () => {
  const options = await fixture();
  const id = "c".repeat(64);
  const uninstalled = status("pi", false);
  uninstalled.runtimes[0]!.installed = false;
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan")
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "pi",
        }),
      );
    return {
      code: 0,
      stdout: args[1] === "apply" ? JSON.stringify(uninstalled) : "",
      stderr: "",
    };
  });
  await expect(
    installNativeRuntime("pi", options, {
      localmodels,
      probeRuntimes: noDaemon,
    }),
  ).rejects.toMatchObject({ code: "LOCALMODELS_RUNTIME_UNAVAILABLE" });
  expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
    "plan",
    "apply",
  ]);
});

it.each([
  [true, "ready", 0],
  [false, "action_required", 4],
] as const)(
  "reuses the apply status descriptor in prepareRuntime (authenticated=%s) without calling harness status",
  async (authenticated, expectedState, expectedCode) => {
    const options = await fixture();
    const id = "d".repeat(64);
    const localmodels = vi.fn(async (_home: string, args: string[]) => {
      if (args[1] === "plan")
        await writeFile(
          args[args.indexOf("--out") + 1]!,
          JSON.stringify({
            schema: "localmodels.harness-plan/v1",
            id,
            runtime: "pi",
          }),
        );
      return {
        code: 0,
        stdout:
          args[1] === "apply"
            ? `${JSON.stringify({ kind: "stage", stage: "install", state: "succeeded" })}\n${JSON.stringify(status("pi", authenticated))}\n`
            : "",
        stderr: "",
      };
    });
    const descriptors: unknown[] = [];
    const outcome = await prepareRuntime(
      "pi",
      {
        ...options,
        onDescriptor: (descriptor) => descriptors.push(descriptor),
      },
      { localmodels, probeRuntimes: noDaemon },
    );
    expect(outcome).toMatchObject({
      code: expectedCode,
      state: expectedState,
    });
    expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
      "plan",
      "apply",
    ]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ runtime: "pi", installed: true });
  },
);

it.each([
  { authenticated: true, expectedState: "ready", expectedCode: 0 },
  {
    authenticated: false,
    expectedState: "action_required",
    expectedCode: 4,
  },
])(
  "prepareRuntime with reuseInstalled skips plan and apply when already installed (authenticated=$authenticated)",
  async ({ authenticated, expectedState, expectedCode }) => {
    const options = await fixture();
    const localmodels = vi.fn(async (_home: string, args: string[]) => ({
      code: 0,
      stdout:
        args[1] === "status" ? JSON.stringify(status("pi", authenticated)) : "",
      stderr: "",
    }));
    const descriptors: unknown[] = [];
    const outcome = await prepareRuntime(
      "pi",
      {
        ...options,
        reuseInstalled: true,
        onDescriptor: (descriptor) => descriptors.push(descriptor),
      },
      { localmodels, probeRuntimes: noDaemon },
    );
    expect(outcome).toMatchObject({
      code: expectedCode,
      state: expectedState,
    });
    expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
      "status",
    ]);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ runtime: "pi", installed: true });
  },
);

it("prepareRuntime with reuseInstalled falls back to plan and apply when not installed", async () => {
  const options = await fixture();
  const id = "c".repeat(64);
  let statusCalls = 0;
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "status") {
      statusCalls += 1;
      const body = status("pi", true);
      if (statusCalls === 1) {
        body.runtimes[0]!.installed = false;
        body.runtimes[0]!.authenticated = false;
      }
      return { code: 0, stdout: JSON.stringify(body), stderr: "" };
    }
    if (args[1] === "plan") {
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "pi",
        }),
      );
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const descriptors: unknown[] = [];
  const outcome = await prepareRuntime(
    "pi",
    {
      ...options,
      reuseInstalled: true,
      onDescriptor: (descriptor) => descriptors.push(descriptor),
    },
    { localmodels, probeRuntimes: noDaemon },
  );
  expect(outcome.state).toBe("ready");
  expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
    "status",
    "plan",
    "apply",
    "status",
  ]);
  expect(descriptors).toHaveLength(1);
  expect(descriptors[0]).toMatchObject({ runtime: "pi", installed: true });
});

it("delegates Codex auth verification to local-daemon so CC Switch Codex is ready without prompting codex auth", async () => {
  const options = await fixture();
  const localmodels = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify(status("codex", false)),
    stderr: "",
  }));
  const probeRuntimes = vi.fn(async () => [
    {
      type: "codex" as const,
      status: "ready" as const,
      installed: true,
      authenticated: true,
      version: "codex-cli 0.171.0",
      requiredVersion: "0.166.0",
      executable: "/opt/homebrew/bin/codex",
    },
  ]);

  const outcome = await prepareRuntime(
    "codex",
    { ...options, reuseInstalled: true },
    { localmodels, probeRuntimes },
  );
  expect(outcome).toMatchObject({ code: 0, state: "ready" });
  expect(probeRuntimes).toHaveBeenCalledTimes(1);
});

it("falls back directly to local-daemon observations when localmodels harness status is unavailable", async () => {
  const options = await fixture();
  const localmodels = vi.fn(async () => ({
    code: 1,
    stdout: "",
    stderr: "harness status removed",
  }));
  const probeRuntimes = vi.fn(async () => [
    {
      type: "claude" as const,
      status: "ready" as const,
      installed: true,
      authenticated: true,
      version: "2.1.310 (Claude Code)",
      requiredVersion: "2.1.282",
      executable: "/Users/me/.local/bin/claude",
    },
  ]);

  const inspection = await inspectRuntime("claude", options, {
    localmodels,
    probeRuntimes,
  });
  expect(inspection).toMatchObject({
    runtime: "claude",
    installed: true,
    ready: true,
    executable: "/Users/me/.local/bin/claude",
  });
  expect(inspection.descriptor.status).toBe("ready");
});

it("refuses to reuse an incompatible local runtime and passes managed harness paths to local-daemon", async () => {
  const options = await fixture();
  const id = "e".repeat(64);
  const managedClaude = path.join(
    options.home,
    "runtime",
    "harness",
    "tools",
    "claude",
    "2.1.310",
    "claude",
  );
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "status") {
      return {
        code: 0,
        stdout: JSON.stringify(status("claude", true)),
        stderr: "",
      };
    }
    if (args[1] === "plan") {
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "claude",
        }),
      );
    }
    if (args[1] === "apply") {
      const applied = status("claude", true);
      applied.runtimes[0]!.executable = managedClaude;
      return {
        code: 0,
        stdout: JSON.stringify(applied),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  let calls = 0;
  const probeRuntimes = vi.fn(async () => {
    calls += 1;
    if (calls === 1) {
      return [
        {
          type: "claude" as const,
          status: "incompatible" as const,
          installed: true,
          authenticated: false,
          version: "2.1.100 (Claude Code)",
          requiredVersion: "2.1.282",
          executable: "/usr/local/bin/claude",
        },
      ];
    }
    return [
      {
        type: "claude" as const,
        status: "ready" as const,
        installed: true,
        authenticated: true,
        version: "2.1.310 (Claude Code)",
        requiredVersion: "2.1.282",
        executable: managedClaude,
      },
    ];
  });

  const outcome = await prepareRuntime(
    "claude",
    { ...options, reuseInstalled: true },
    { localmodels, probeRuntimes },
  );
  expect(outcome.state).toBe("ready");
  expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
    "status",
    "plan",
    "apply",
  ]);
  // Second probe verifies the newly installed managed harness binary via configuredPaths
  // without a redundant third probe in prepareRuntime.
  expect(probeRuntimes).toHaveBeenCalledTimes(2);
  expect(probeRuntimes).toHaveBeenLastCalledWith(
    expect.objectContaining({
      configuredPaths: { claude: managedClaude },
    }),
  );
});

it("inspectRuntimeDescriptors reads localmodels descriptors without invoking local-daemon", async () => {
  const options = await fixture();
  const marker = path.join(options.home, "daemon-probed");
  const fakeDaemon = path.join(
    options.home,
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

  const localmodels = vi.fn(async () => ({
    code: 0,
    stdout: JSON.stringify(status("codex", false)),
    stderr: "",
  }));

  const rows = await inspectRuntimeDescriptors(
    options.home,
    { runtime: "codex" },
    { localmodels },
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ runtime: "codex", installed: true });
  await expect(access(marker)).rejects.toThrow();
});

it("passes includeBundled and stable bundled Pi executable in configuredPaths during daemon reconciliation", async () => {
  const options = await fixture();
  const id = "f".repeat(64);
  const stableBundledPi = path.join(
    options.home,
    "runtime",
    "bundled-pi",
    "bin",
    "pi",
  );
  const localmodels = vi.fn(async (_home: string, args: string[]) => {
    if (args[1] === "plan") {
      await writeFile(
        args[args.indexOf("--out") + 1]!,
        JSON.stringify({
          schema: "localmodels.harness-plan/v1",
          id,
          runtime: "pi",
        }),
      );
      return { code: 0, stdout: "", stderr: "" };
    }
    const row = status("pi", false);
    row.runtimes[0]!.executable = stableBundledPi;
    if (args[1] === "status") {
      (
        row.runtimes[0] as { environment?: Record<string, string> }
      ).environment = {
        PI_CODING_AGENT_DIR: path.join(options.home, "runtime", "pi-home"),
      };
    }
    return { code: 0, stdout: JSON.stringify(row), stderr: "" };
  });
  const probeRuntimes = vi.fn(async () => [
    {
      type: "pi" as const,
      status: "authentication_required" as const,
      installed: true,
      authenticated: false,
      version: "1.5.2",
      requiredVersion: "1.2.0",
      executable: stableBundledPi,
    },
  ]);

  const installed = await installNativeRuntime("pi", options, {
    localmodels,
    probeRuntimes,
  });
  expect(installed).toMatchObject({
    code: 0,
    state: "ready",
    details: { executable: stableBundledPi },
  });
  expect(probeRuntimes).toHaveBeenNthCalledWith(
    1,
    expect.objectContaining({
      runtimes: ["pi"],
      includeBundled: true,
      configuredPaths: { pi: stableBundledPi },
    }),
  );

  const inspected = await inspectRuntime("pi", options, {
    localmodels,
    probeRuntimes,
  });
  expect(inspected).toMatchObject({
    runtime: "pi",
    installed: true,
    executable: stableBundledPi,
  });
  expect(probeRuntimes).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      runtimes: ["pi"],
      includeBundled: true,
      configuredPaths: { pi: stableBundledPi },
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: path.join(options.home, "runtime", "pi-home"),
      }),
    }),
  );

  // Fallback path when localmodels fails must also pass includeBundled: true.
  await inspectRuntime("pi", options, {
    localmodels: vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "unavailable",
    })),
    probeRuntimes,
  });
  expect(probeRuntimes).toHaveBeenNthCalledWith(
    3,
    expect.objectContaining({
      runtimes: ["pi"],
      includeBundled: true,
    }),
  );
});

it("fast-binds verified bundled Pi when skipHarnessWhenBundledPiMatches is enabled and no higher-precedence Pi exists", async () => {
  const options = await fixture();
  const bundledBin = path.join(options.home, "bundled-tools", "bin");
  const bundledExe = path.join(
    bundledBin,
    process.platform === "win32" ? "pi.exe" : "pi",
  );
  await mkdir(bundledBin, { recursive: true });
  await writeFile(bundledExe, "#!/bin/sh\n", { mode: 0o755 });
  const isolatedHome = path.join(options.home, "user-home");
  await mkdir(isolatedHome, { recursive: true });

  const localmodels = vi.fn();
  const probeRuntimes = vi.fn();
  const run = vi.fn(async () => ({
    code: 0,
    stdout: "1.5.2\n",
    stderr: "",
  }));
  const events: string[] = [];

  const outcome = await installNativeRuntime(
    "pi",
    {
      ...options,
      env: {
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        PATH: "",
        SIMPLEX_PI_PATH: "",
        LINGER_PI_PATH: "",
      },
      skipHarnessWhenBundledPiMatches: true,
      onEvent: (event) => events.push(event.message),
    },
    {
      localmodels,
      probeRuntimes,
      run,
      resolveBundledPi: async () => ({
        binDir: bundledBin,
        executable: bundledExe,
        version: "1.5.2",
      }),
    },
  );

  expect(localmodels).not.toHaveBeenCalled();
  expect(probeRuntimes).not.toHaveBeenCalled();
  const expectedExecutable =
    process.platform === "win32"
      ? bundledExe
      : path.join(
          path.resolve(options.home),
          "runtime",
          "bundled-pi",
          "bin",
          "pi",
        );
  expect(run).toHaveBeenCalledWith(
    expectedExecutable,
    ["--version"],
    expect.objectContaining({ timeoutMs: 15_000 }),
  );
  if (process.platform !== "win32") {
    expect(await readlink(expectedExecutable)).toBe(path.resolve(bundledExe));
  }
  expect(outcome).toEqual({
    code: 0,
    state: "ready",
    message: "pi is installed. Authentication will be checked separately.",
    details: {
      executable: expectedExecutable,
      descriptor: {
        runtime: "pi",
        executable: expectedExecutable,
        argvPrefix: [],
        installed: true,
        authenticated: false,
        authMode: null,
        status: "authentication_required",
        version: "1.5.2",
        loginCommand: null,
      },
    },
  });
  expect(events.join("")).toContain(
    "Reusing verified bundled Pi 1.5.2 directly (skipped harness plan/apply).",
  );
});

it.each([
  "valid_simplex_pi_path",
  "invalid_simplex_pi_path",
  "user_path_pi",
  "newer_harness_pi",
  "version_mismatch",
  "version_exit_nonzero",
] as const)(
  "falls back to harness plan and apply when bundled Pi fast-bind cannot apply (%s)",
  async (scenario) => {
    const options = await fixture();
    const bundledBin = path.join(options.home, "bundled-tools", "bin");
    const bundledExe = path.join(
      bundledBin,
      process.platform === "win32" ? "pi.exe" : "pi",
    );
    await mkdir(bundledBin, { recursive: true });
    await writeFile(bundledExe, "#!/bin/sh\n", { mode: 0o755 });
    const isolatedHome = path.join(options.home, "user-home");
    const userBin = path.join(options.home, "user-bin");
    await mkdir(isolatedHome, { recursive: true });
    await mkdir(userBin, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
      PATH: userBin,
      SIMPLEX_PI_PATH: "",
      LINGER_PI_PATH: "",
    };
    const piName = process.platform === "win32" ? "pi.exe" : "pi";
    if (scenario === "valid_simplex_pi_path") {
      const customPi = path.join(options.home, "custom", piName);
      await mkdir(path.dirname(customPi), { recursive: true });
      await writeFile(customPi, "#!/bin/sh\n", { mode: 0o755 });
      env.SIMPLEX_PI_PATH = customPi;
    } else if (scenario === "invalid_simplex_pi_path") {
      env.SIMPLEX_PI_PATH = path.join(options.home, "missing", piName);
    } else if (scenario === "user_path_pi") {
      const userPi = path.join(userBin, piName);
      await writeFile(userPi, "#!/bin/sh\n", { mode: 0o755 });
      if (process.platform !== "win32") await chmod(userPi, 0o755);
    } else if (scenario === "newer_harness_pi") {
      const newerPi = path.join(
        options.home,
        "runtime",
        "harness",
        "tools",
        "pi",
        "1.7.0",
        piName,
      );
      await mkdir(path.dirname(newerPi), { recursive: true });
      await writeFile(newerPi, "#!/bin/sh\n", { mode: 0o755 });
      if (process.platform !== "win32") await chmod(newerPi, 0o755);
    }

    const id = "e".repeat(64);
    const localmodels = vi.fn(async (_home: string, args: string[]) => {
      if (args[1] === "plan") {
        await writeFile(
          args[args.indexOf("--out") + 1]!,
          JSON.stringify({
            schema: "localmodels.harness-plan/v1",
            id,
            runtime: "pi",
          }),
        );
      }
      return {
        code: 0,
        stdout: args[1] === "apply" ? JSON.stringify(status("pi", false)) : "",
        stderr: "",
      };
    });
    const run = vi.fn(async () =>
      scenario === "version_mismatch"
        ? { code: 0, stdout: "1.5.20\n", stderr: "" }
        : { code: 1, stdout: "", stderr: "broken" },
    );

    const outcome = await installNativeRuntime(
      "pi",
      {
        ...options,
        env,
        skipHarnessWhenBundledPiMatches: true,
      },
      {
        localmodels,
        probeRuntimes: noDaemon,
        run,
        resolveBundledPi: async () => ({
          binDir: bundledBin,
          executable: bundledExe,
          version: "1.5.2",
        }),
      },
    );

    expect(outcome.code).toBe(0);
    expect(localmodels.mock.calls.map(([, args]) => args[1])).toEqual([
      "plan",
      "apply",
    ]);
  },
);
