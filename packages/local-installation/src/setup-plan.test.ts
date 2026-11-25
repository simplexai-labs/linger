import path from "node:path";
import { expect, it, vi } from "vitest";
import { inspectSetup, type SetupOptions } from "./setup-plan.js";
import { WINDOWS_PRIVATE_PATH_UNSAFE } from "./windows-private.js";

const noDaemon = async () => null;
const inspectWithoutDaemon = (options: SetupOptions) =>
  inspectSetup({ probeRuntimes: noDaemon, ...options });

const upstream = (available = true) => ({
  schema: "localmodels.setup-report/v1",
  facts: {
    platform: "linux",
    arch: "unusual",
    ram: { total_bytes: 7 },
    disk: { free_bytes: 9 },
    gpus: [{ index: 4, name: "upstream GPU", total_bytes: 6, free_bytes: 5 }],
  },
  stack: {
    available,
    reasons: available
      ? []
      : [{ code: "upstream_policy", message: "Upstream rejected this host" }],
    plan: available
      ? {
          llm: {
            model: { id: "upstream-model" },
            placement: { gpus: [{ index: 4 }] },
          },
          budget: {
            download_bytes: 11,
            disk_needed_bytes: 13,
            ram_needed_bytes: 17,
          },
        }
      : null,
  },
  harness: {
    schema: "localmodels.harness-status/v1",
    runtimes: ["codex", "claude", "pi"].map((runtime) => ({
      runtime,
      installed: runtime === "pi",
      authenticated: runtime === "pi",
    })),
  },
  recommendation: available ? "local-models" : "pi",
});
const runner = (value: object = upstream()) =>
  vi.fn(async () => ({ code: 0, stdout: JSON.stringify(value), stderr: "" }));
it("delegates all hardware policy, runtime detection, estimates and recommendation upstream", async () => {
  const localmodels = runner();
  const home = path.resolve("/owned");
  const report = await inspectWithoutDaemon({
    home,
    localmodels,
  });
  expect(localmodels).toHaveBeenCalledWith(
    home,
    [
      "setup",
      "inspect",
      "--root",
      path.join(home, "runtime", "harness"),
      "--model-base-dir",
      path.join(home, "runtime", "localmodels", "models"),
      "--decision",
      "none",
      "--offline",
      "--defer-services",
      "--share-gpu",
      "--lang",
      "en",
      "--json",
    ],
    expect.objectContaining({ timeoutMs: 120000 }),
  );
  expect(report.hardware.totalMemoryBytes).toBe(7);
  expect(report.localModels).toMatchObject({
    eligible: true,
    state: "ready",
    selectedGpuIndex: 4,
    estimate: {
      model: "upstream-model",
      downloadBytes: 11,
      diskBytes: 13,
      memoryBytes: 17,
      durationSeconds: null,
    },
  });
  expect(report.localModels).not.toHaveProperty("minimum");
  expect(report.runtimes[2]).toMatchObject({
    installed: true,
    auth: "authenticated",
    estimate: {
      downloadBytes: null,
      diskBytes: null,
      memoryBytes: null,
      durationSeconds: null,
    },
  });
  expect(report.recommendation).toBe("local-models");
});
it("preserves upstream rejection and never substitutes downstream eligibility", async () => {
  const localmodels = runner(upstream(false));
  const report = await inspectWithoutDaemon({ localmodels });
  expect(report.localModels.state).toBe("unavailable");
  expect(report.localModels.reasons).toEqual([
    { code: "upstream_policy", message: "Upstream rejected this host" },
  ]);
  expect(report.recommendation).toBe("pi");
  expect(report.localModels.estimate.downloadBytes).toBeNull();
});
it("recommends the next runtime while the local plan waits for free memory (tool without stack.state)", async () => {
  const freeMemory = (installed: boolean) => {
    const value = upstream();
    return {
      ...value,
      stack: {
        ...value.stack,
        basis: "capacity",
        reasons: [
          {
            code: "free-memory-required",
            message: "Close other programs before installing.",
          },
        ],
      },
      harness: {
        ...value.harness,
        runtimes: value.harness.runtimes.map((row) => ({
          ...row,
          installed: installed && row.installed,
        })),
      },
    };
  };
  const report = await inspectWithoutDaemon({
    localmodels: runner(freeMemory(true)),
  });
  expect(report.localModels).toMatchObject({
    eligible: false,
    state: "blocked-now",
    basis: "capacity",
    reasons: [
      {
        code: "free-memory-required",
        message: "Close other programs before installing.",
      },
    ],
    estimate: { model: "upstream-model" },
  });
  expect(report.localModels).not.toHaveProperty("memory");
  expect(report.recommendation).toBe("pi");
  const bare = await inspectWithoutDaemon({
    localmodels: runner(freeMemory(false)),
  });
  expect(bare.recommendation).toBe("codex");
  // The reason code alone holds the plan too.
  const { basis: _, ...stack } = freeMemory(true).stack;
  const coded = await inspectWithoutDaemon({
    localmodels: runner({ ...freeMemory(true), stack }),
  });
  expect(coded.localModels).toMatchObject({
    state: "blocked-now",
    basis: "capacity",
  });
  expect(coded.recommendation).toBe("pi");
  const ready = await inspectWithoutDaemon({ localmodels: runner() });
  expect(ready.localModels).not.toHaveProperty("basis");
});
it("reads the tool's blocked-now state, memory and recommendation", async () => {
  const value = upstream();
  const blocked = {
    ...value,
    stack: {
      ...value.stack,
      available: false,
      state: "blocked-now",
      hardwareCapable: true,
      basis: "capacity",
      reasons: [
        {
          code: "free-memory-required",
          message: "Close other programs before installing.",
        },
      ],
      memory: {
        ramAvailableBytes: 2899102924,
        ramRequiredBytes: 13689304433,
        vramFreeBytes: 3,
        vramRequiredBytes: 8,
      },
    },
    recommendation: "codex",
  };
  const report = await inspectWithoutDaemon({ localmodels: runner(blocked) });
  expect(report.localModels).toMatchObject({
    eligible: false,
    state: "blocked-now",
    hardwareCapable: true,
    basis: "capacity",
    memory: {
      ramAvailableBytes: 2899102924,
      ramRequiredBytes: 13689304433,
      vramFreeBytes: 3,
      vramRequiredBytes: 8,
    },
    estimate: { model: "upstream-model" },
  });
  // The tool's non-local pick stands, even with Pi installed.
  expect(report.recommendation).toBe("codex");
  // The tool's state wins over the older marks; null fields stay out.
  const ready = await inspectWithoutDaemon({
    localmodels: runner({
      ...value,
      stack: {
        ...value.stack,
        state: "ready",
        hardwareCapable: true,
        basis: null,
        memory: null,
      },
    }),
  });
  expect(ready.localModels).toMatchObject({
    eligible: true,
    state: "ready",
    hardwareCapable: true,
  });
  expect(ready.localModels).not.toHaveProperty("basis");
  expect(ready.localModels).not.toHaveProperty("memory");
  const small = await inspectWithoutDaemon({
    localmodels: runner({
      ...upstream(false),
      stack: {
        ...upstream(false).stack,
        state: "unavailable",
        hardwareCapable: false,
      },
    }),
  });
  expect(small.localModels).toMatchObject({
    eligible: false,
    state: "unavailable",
    hardwareCapable: false,
  });
});
it("passes on the memory counts each reason carries", async () => {
  const value = upstream();
  const report = await inspectWithoutDaemon({
    localmodels: runner({
      ...value,
      stack: {
        ...value.stack,
        available: false,
        state: "blocked-now",
        basis: "capacity",
        reasons: [
          {
            code: "gpu-memory-required",
            message: "Other programs are using GPU 1's memory.",
            gpuIndex: 1,
            freeBytes: 3,
            requiredBytes: 8,
          },
          {
            code: "free-memory-required",
            message: "Other programs are using memory they need.",
            freeBytes: 5,
            requiredBytes: 13,
          },
          // A count outside the contract is left out, not shown.
          { code: "free-memory-required", message: "", freeBytes: -1 },
        ],
      },
      recommendation: "codex",
    }),
  });
  expect(report.localModels.reasons).toEqual([
    {
      code: "gpu-memory-required",
      message: "Other programs are using GPU 1's memory.",
      gpuIndex: 1,
      freeBytes: 3,
      requiredBytes: 8,
    },
    {
      code: "free-memory-required",
      message: "Other programs are using memory they need.",
      freeBytes: 5,
      requiredBytes: 13,
    },
    { code: "free-memory-required", message: "" },
  ]);
});
it("passes on validated CUDA driver versions and drops malformed values", async () => {
  const value = upstream(false);
  const report = await inspectWithoutDaemon({
    localmodels: runner({
      ...value,
      stack: {
        ...value.stack,
        available: false,
        state: "blocked-now",
        hardwareCapable: true,
        reasons: [
          {
            code: "cuda-driver-update-required",
            message: "Driver supports CUDA 12.1; requires CUDA >= 12.4.",
            detectedCudaVersion: "12.1",
            requiredCudaVersion: "12.4",
            driverVersion: "535.98",
          },
          {
            code: "cuda-driver-version-unknown",
            message: "Could not detect driver CUDA version.",
            detectedCudaVersion: "CUDA 12.1",
            requiredCudaVersion: "12.4",
            driverVersion: "[N/A]",
          },
        ],
      },
      recommendation: "codex",
    }),
  });
  expect(report.localModels).toMatchObject({
    eligible: false,
    state: "blocked-now",
    hardwareCapable: true,
    reasons: [
      {
        code: "cuda-driver-update-required",
        message: "Driver supports CUDA 12.1; requires CUDA >= 12.4.",
        detectedCudaVersion: "12.1",
        requiredCudaVersion: "12.4",
        driverVersion: "535.98",
      },
      {
        code: "cuda-driver-version-unknown",
        message: "Could not detect driver CUDA version.",
        requiredCudaVersion: "12.4",
      },
    ],
  });
});
it("fails explicitly and redacts tool output when upstream is unavailable or malformed", async () => {
  for (const response of [
    { code: 1, stdout: "private token", stderr: "secret" },
    { code: 0, stdout: "{}", stderr: "" },
  ]) {
    await expect(
      inspectWithoutDaemon({ localmodels: vi.fn(async () => response) }),
    ).rejects.toMatchObject({ code: "LOCALMODELS_SETUP_UNAVAILABLE" });
  }
});
it("names the upstream cause and logs its redacted output when the check fails", async () => {
  const onEvent = vi.fn();
  await expect(
    inspectWithoutDaemon({
      onEvent,
      localmodels: vi.fn(async () => ({
        code: 1,
        stdout: "",
        // A long traceback ends with its cause.
        stderr: [
          "Traceback (most recent call last):",
          ...Array.from({ length: 40 }, (_, i) => `  File "frame${i}.py"`),
          "sk-abcdefghijklmnopqrstuvwxyz",
          "error: Unsupported or changed Codex provider configuration",
        ].join("\n"),
      })),
    }),
  ).rejects.toMatchObject({
    code: "LOCALMODELS_SETUP_UNAVAILABLE",
    message: expect.stringContaining(
      "Unsupported or changed Codex provider configuration",
    ),
  });
  const messages = onEvent.mock.calls.map(([event]) => event.message);
  // The cause leads, ahead of the long output the desktop may cut off.
  expect(messages[0]).toMatch(
    /^localmodels setup inspect failed: .*Unsupported or changed Codex provider configuration$/,
  );
  const logged = messages.join("\n");
  expect(logged).toContain("localmodels setup inspect exited with code 1");
  expect(logged).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
});
it("honors cancellation before invoking upstream", async () => {
  const localmodels = runner();
  await expect(
    inspectWithoutDaemon({ signal: AbortSignal.abort(), localmodels }),
  ).rejects.toThrow();
  expect(localmodels).not.toHaveBeenCalled();
});

it("inspects with GPU sharing unless sharing was explicitly declined", async () => {
  const localmodels = vi.fn<
    (
      home: string,
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>
  >(async () => ({
    code: 0,
    stdout: JSON.stringify(upstream()),
    stderr: "",
  }));
  await inspectWithoutDaemon({ localmodels, shareGpu: false });
  expect(localmodels.mock.calls[0]?.[1]).not.toContain("--share-gpu");
  await inspectWithoutDaemon({ localmodels, shareGpu: true });
  expect(localmodels.mock.calls[1]?.[1]).toContain("--share-gpu");
  await inspectWithoutDaemon({ localmodels });
  expect(localmodels.mock.calls[2]?.[1]).toContain("--share-gpu");
});

it("checks the installation target while keeping tool state in the existing home", async () => {
  const home = path.resolve("cached-home");
  const targetHome = path.resolve("candidate");
  const localmodels = runner();
  await inspectWithoutDaemon({ home, targetHome, localmodels });
  expect(localmodels).toHaveBeenCalledWith(
    home,
    expect.arrayContaining([
      "--root",
      path.join(targetHome, "runtime", "harness"),
      "--model-base-dir",
      path.join(targetHome, "runtime", "localmodels", "models"),
    ]),
    expect.anything(),
  );
});

it("preserves WINDOWS_PRIVATE_PATH_UNSAFE refusals instead of wrapping them as LOCALMODELS_SETUP_UNAVAILABLE", async () => {
  const refusalError = Object.assign(
    new Error(
      "Windows private path validation failed: C:\\Shared\\Linger is inside a folder other accounts on this computer can rename or replace. Use a current-user owned local directory without links or shared access.",
    ),
    {
      code: WINDOWS_PRIVATE_PATH_UNSAFE,
      reason: "UNSAFE_PARENT_ACCESS",
      path: "C:\\Shared\\Linger",
    },
  );
  await expect(
    inspectWithoutDaemon({
      localmodels: vi.fn(async () => {
        throw refusalError;
      }),
    }),
  ).rejects.toBe(refusalError);
});

it("preserves upstream stack.upgrade guidance when freeing memory unlocks a stronger model", async () => {
  const base = upstream();
  const report = await inspectWithoutDaemon({
    localmodels: runner({
      ...base,
      facts: {
        ...base.facts,
        platform: "darwin",
        arch: "arm64",
        ram: { total_bytes: 24 * 1024 ** 3 },
        gpus: [],
      },
      stack: {
        ...base.stack,
        available: true,
        state: "ready",
        hardwareCapable: true,
        plan: {
          llm: {
            model: { id: "spark-x2.6-4b-q4km" },
            placement: { gpus: [] },
          },
          budget: {
            download_bytes: 2_800_000_000,
            disk_needed_bytes: 3_100_000_000,
            ram_needed_bytes: 5_000_000_000,
          },
        },
        upgrade: {
          plan: {
            llm: {
              model: { id: "inkling-2-mini-iq3xxs" },
              placement: { gpus: [] },
            },
            budget: {
              download_bytes: 11_800_000_000,
              disk_needed_bytes: 12_500_000_000,
              ram_needed_bytes: 14_900_000_000,
            },
          },
          summary: {
            llm: "inkling-2-mini-iq3xxs",
            llmName: "Inkling 2 Mini (IQ3_XXS)",
            downloadBytes: 11_800_000_000,
            diskBytes: 12_500_000_000,
            memoryBytes: 14_900_000_000,
          },
          reasons: [
            {
              code: "free-memory-required",
              message:
                "Close other apps to free RAM for Inkling 2 Mini (IQ3_XXS).",
              freeBytes: 12_000_000_000,
              requiredBytes: 14_900_000_000,
            },
            {
              code: "gpu-memory-required",
              message: "Invalid count should be stripped.",
              gpuIndex: 0,
              freeBytes: -5,
              requiredBytes: 10,
            },
          ],
          gpuApps: [
            { name: "chrome.exe", pids: [101, -1, 202], bytes: 1_500_000_000 },
            { name: "", pids: [303], bytes: 100 },
            { name: "bad.exe", pids: [404], bytes: -1 },
          ],
        },
      },
    }),
  });
  expect(report.localModels.estimate.model).toBe("spark-x2.6-4b-q4km");
  expect(report.localModels.upgrade).toEqual({
    modelName: "Inkling 2 Mini (IQ3_XXS)",
    selectedGpuIndex: null,
    estimate: {
      model: "inkling-2-mini-iq3xxs",
      downloadBytes: 11_800_000_000,
      diskBytes: 12_500_000_000,
      memoryBytes: 14_900_000_000,
      durationSeconds: null,
      assumption: "Resource plan supplied by localmodels; duration is unknown.",
    },
    reasons: [
      {
        code: "free-memory-required",
        message: "Close other apps to free RAM for Inkling 2 Mini (IQ3_XXS).",
        freeBytes: 12_000_000_000,
        requiredBytes: 14_900_000_000,
      },
      {
        code: "gpu-memory-required",
        message: "Invalid count should be stripped.",
        gpuIndex: 0,
        requiredBytes: 10,
      },
    ],
    gpuApps: [{ name: "chrome.exe", pids: [101, 202], bytes: 1_500_000_000 }],
  });
});

it("drops malformed or incomplete stack.upgrade hints without failing inspection", async () => {
  const base = upstream();
  for (const badUpgrade of [
    null,
    {},
    { summary: { llm: "inkling-2-mini-iq3xxs" }, reasons: [] },
    {
      summary: { llm: "" },
      reasons: [{ code: "free-memory-required", message: "Close apps." }],
    },
  ]) {
    const report = await inspectWithoutDaemon({
      localmodels: runner({
        ...base,
        stack: {
          ...base.stack,
          upgrade: badUpgrade,
        },
      }),
    });
    expect(report.localModels).not.toHaveProperty("upgrade");
  }
});

it("uses local-daemon as single source of truth even when localmodels omits harness runtime data", async () => {
  const base = upstream(false);
  const localmodels = runner({
    schema: base.schema,
    facts: base.facts,
    stack: base.stack,
  });
  const probeRuntimes = vi.fn(async () => [
    {
      type: "codex" as const,
      status: "authentication_required" as const,
      installed: true,
      authenticated: false,
      version: "codex-cli 0.171.0",
      requiredVersion: "0.166.0",
      executable: "/Applications/Codex.app/Contents/Resources/codex",
    },
    {
      type: "claude" as const,
      status: "ready" as const,
      installed: true,
      authenticated: true,
      version: "2.1.310 (Claude Code)",
      requiredVersion: "2.1.282",
      executable: "/Users/me/.local/bin/claude",
    },
    {
      type: "pi" as const,
      status: "not_installed" as const,
      installed: false,
      authenticated: false,
      requiredVersion: "1.2.0",
    },
  ]);

  const report = await inspectSetup({ localmodels, probeRuntimes });
  expect(report.recommendation).toBe("claude");
  expect(report.runtimes.find((r) => r.choice === "claude")).toMatchObject({
    installed: true,
    auth: "authenticated",
    status: "ready",
    version: "2.1.310 (Claude Code)",
    requiredVersion: "2.1.282",
  });
  expect(report.runtimes.find((r) => r.choice === "codex")).toMatchObject({
    installed: true,
    auth: "unauthenticated",
    status: "authentication_required",
  });
});

it("prefers daemon-verified CC Switch Codex as ready and surfaces incompatible local Claude", async () => {
  const base = upstream(false);
  const localmodels = runner({
    ...base,
    harness: {
      schema: "localmodels.harness-status/v1",
      runtimes: [
        { runtime: "codex", installed: true, authenticated: false },
        { runtime: "claude", installed: true, authenticated: true },
        { runtime: "pi", installed: false, authenticated: false },
      ],
    },
    recommendation: "claude",
  });
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
    {
      type: "claude" as const,
      status: "incompatible" as const,
      installed: true,
      authenticated: false,
      version: "2.1.100 (Claude Code)",
      requiredVersion: "2.1.282",
      executable: "/usr/local/bin/claude",
    },
    {
      type: "pi" as const,
      status: "not_installed" as const,
      installed: false,
      authenticated: false,
      requiredVersion: "1.2.0",
    },
  ]);

  const report = await inspectSetup({ localmodels, probeRuntimes });
  expect(report.recommendation).toBe("codex");
  expect(report.runtimes.find((r) => r.choice === "codex")).toMatchObject({
    installed: true,
    auth: "authenticated",
    status: "ready",
  });
  expect(report.runtimes.find((r) => r.choice === "claude")).toMatchObject({
    installed: true,
    auth: "unauthenticated",
    status: "incompatible",
    version: "2.1.100 (Claude Code)",
    requiredVersion: "2.1.282",
  });
});

it("keeps local-models as the recommendation when local models are ready even with ready daemon runtimes", async () => {
  const localmodels = runner(upstream(true));
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
    {
      type: "codex" as const,
      status: "ready" as const,
      installed: true,
      authenticated: true,
      version: "codex-cli 0.171.0",
      requiredVersion: "0.166.0",
      executable: "/opt/homebrew/bin/codex",
    },
    {
      type: "pi" as const,
      status: "not_installed" as const,
      installed: false,
      authenticated: false,
      requiredVersion: "1.2.0",
    },
  ]);

  const report = await inspectSetup({ localmodels, probeRuntimes });
  expect(report.localModels).toMatchObject({ eligible: true, state: "ready" });
  expect(report.recommendation).toBe("local-models");
});
