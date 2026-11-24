import { afterEach, expect, it, vi } from "vitest";
import { parseInstallerArguments } from "../main.js";
import { coreAdapter } from "./core.js";
import {
  installNativeSource,
  checkNativeSourceEnvironment,
} from "@linger/local-installation/native-source";
import * as handoff from "./instance-runtime.js";
import { validateInput } from "./validation.js";
vi.mock("@linger/local-installation/native-source", () => ({
  installNativeSource: vi.fn(async () => ({
    code: 0,
    state: "ready",
    message: "native ready",
  })),
  checkNativeSourceEnvironment: vi.fn(async () => ({
    releaseAvailable: true,
    platform: "linux",
    arch: "x64",
    checks: [
      {
        id: "source-native",
        title: "Native source",
        state: "ready",
        detail: "Ready",
      },
    ],
  })),
  probeNativeSourceServices: vi.fn(),
  stopNativeSource: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());
it("selects source only from trusted process options and rejects browser path injection", () => {
  expect(
    parseInstallerArguments(["--source-repo", "/checkout"]).sourceRepo,
  ).toBe("/checkout");
  expect(
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--instance",
      "source-dev",
    ]).instanceName,
  ).toBe("source-dev");
  expect(() =>
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--instance",
      "../escape",
    ]),
  ).toThrow();
  expect(() => parseInstallerArguments(["--source-repo"])).toThrow();
  expect(() => parseInstallerArguments([])).toThrow(/source checkout/);
  expect(() =>
    validateInput({ instance: "default", sourceRepo: "/other" }),
  ).toThrow();
});
it("routes browser installs and environment checks to the native source core", async () => {
  const adapter = coreAdapter("/private-home", "/checkout");
  const signal = new AbortController().signal;
  const emit = vi.fn();
  await adapter.run({ instance: "source", setupChoice: "pi" }, signal, emit);
  expect(installNativeSource).toHaveBeenCalledWith(
    expect.objectContaining({
      repo: "/checkout",
      name: "source",
      home: "/private-home",
      setupChoice: "pi",
      signal,
      onEvent: emit,
    }),
  );
  expect((await adapter.environment()).checks[0]?.id).toBe("source-native");
  expect(checkNativeSourceEnvironment).toHaveBeenCalledWith(
    expect.objectContaining({ repo: "/checkout" }),
  );
  expect((await adapter.config("source")).releaseAvailable).toBe(true);
});
it("hands the selected install descriptor to the desktop job", async () => {
  const descriptor = {
    runtime: "pi" as const,
    executable: "/managed/pi",
    installed: true,
    authenticated: true,
    authMode: "api_key",
    argvPrefix: [],
    environment: {},
    loginCommand: null,
  };
  const runtime = {
    setupChoice: "pi" as const,
    environment: { LINGER_PI_PATH: "/managed/pi" },
  };
  const assemble = vi
    .spyOn(handoff, "instanceRuntime")
    .mockResolvedValue(runtime);
  try {
    vi.mocked(installNativeSource).mockImplementationOnce(async (options) => {
      options.onRuntimeDescriptors?.([descriptor]);
      return { code: 0, state: "ready", message: "Ready" };
    });
    const publish = vi.fn();
    await coreAdapter("/home", "/checkout", true).run(
      { instance: "desktop", setupChoice: "pi" },
      new AbortController().signal,
      vi.fn(),
      publish,
    );
    expect(assemble).toHaveBeenCalledWith("/home", "desktop", {
      runtimeDescriptors: [descriptor],
      onTimings: expect.any(Function),
    });
    expect(publish).toHaveBeenCalledWith(runtime);
  } finally {
    assemble.mockRestore();
  }
});
it("leaves the desktop on the live lookup when no handoff can be made", async () => {
  const descriptor = (runtime: "pi" | "claude") => ({
    runtime,
    executable: `/managed/${runtime}`,
    installed: true,
    authenticated: true,
    authMode: "api_key",
    argvPrefix: [],
    environment: {},
    loginCommand: null,
  });
  const stderr = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(() => true);
  const assemble = vi.spyOn(handoff, "instanceRuntime");
  try {
    const cases = [
      // BYOK local models install the claude runtime under another choice.
      {
        setupChoice: "local-models" as const,
        descriptor: descriptor("claude"),
        outcome: { code: 0, state: "ready", message: "Ready" },
      },
      {
        setupChoice: "pi" as const,
        descriptor: descriptor("pi"),
        outcome: { code: 1, state: "failed", message: "Failed" },
      },
      {
        setupChoice: "pi" as const,
        descriptor: descriptor("pi"),
        outcome: { code: 0, state: "ready", message: "Ready" },
        rejects: true,
      },
    ];
    for (const item of cases) {
      assemble.mockReset();
      if (item.rejects)
        assemble.mockRejectedValueOnce(new Error("argvPrefix unsupported"));
      vi.mocked(installNativeSource).mockImplementationOnce(async (options) => {
        options.onRuntimeDescriptors?.([item.descriptor]);
        return item.outcome;
      });
      const publish = vi.fn();
      await coreAdapter("/home", "/checkout", true).run(
        { instance: "desktop", setupChoice: item.setupChoice },
        new AbortController().signal,
        vi.fn(),
        publish,
      );
      expect(publish).not.toHaveBeenCalled();
      expect(assemble).toHaveBeenCalledTimes(item.rejects ? 1 : 0);
    }
    const failures = stderr.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.includes("installer.runtime_handoff_failed"))
      .map((line) => JSON.parse(line) as unknown);
    expect(failures).toEqual([
      {
        event: "installer.runtime_handoff_failed",
        instance: "desktop",
        message: "argvPrefix unsupported",
      },
    ]);
  } finally {
    assemble.mockRestore();
    stderr.mockRestore();
  }
});
it("rejects the retired Docker and release preparations", () => {
  for (const preparation of ["docker", "release"])
    expect(() => validateInput({ instance: "default", preparation })).toThrow(
      "Invalid dependency",
    );
  expect(() =>
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--source-engine",
      "native",
    ]),
  ).toThrow();
});
it("resumes only a named source instance", () => {
  const source = ["--source-repo", "/checkout"];
  expect(
    parseInstallerArguments([...source, "--instance", "desktop", "--resume"]),
  ).toMatchObject({ resume: true, instanceName: "desktop" });
  expect(() => parseInstallerArguments([...source, "--resume"])).toThrow();
});
it("hands the Computer to the desktop client on request", () => {
  expect(
    parseInstallerArguments([
      "--source-repo",
      "/checkout",
      "--external-computer",
    ]),
  ).toMatchObject({ externalComputer: true });
});
