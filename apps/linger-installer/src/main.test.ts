import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { loadPublishedSources } from "./main.js";

const distribution = (value: object) => {
  const file = path.join(
    mkdtempSync(path.join(os.tmpdir(), "installer-distribution-")),
    "distribution.json",
  );
  writeFileSync(file, JSON.stringify(value));
  return file;
};

it("leaves the environment alone without a distribution file", async () => {
  const environment = {};
  await loadPublishedSources(
    path.join(os.tmpdir(), "missing", "distribution.json"),
    environment,
  );
  expect(environment).toEqual({});
});

it("exports the published native sources unless already set", async () => {
  const file = distribution({
    platform: process.platform,
    arch: process.arch,
    nativeSources: [],
  });
  const environment: NodeJS.ProcessEnv = {};
  await loadPublishedSources(file, environment);
  expect(environment).toEqual({ LINGER_NATIVE_DEPENDENCIES_JSON: "[]" });

  const preset = { LINGER_NATIVE_DEPENDENCIES_JSON: "preset" };
  await loadPublishedSources(file, preset);
  expect(preset.LINGER_NATIVE_DEPENDENCIES_JSON).toBe("preset");
});

it("exports the published localmodels tool and sibling bundled archive path unless already set", async () => {
  const tool = {
    url: "https://example.com/localmodels.tgz",
    sha256: "a".repeat(64),
    bytes: 123,
    sourceCommit: "b".repeat(40),
    manifestSha256: "c".repeat(64),
  };
  const file = distribution({
    platform: process.platform,
    arch: process.arch,
    localmodelsTool: tool,
  });
  const environment: NodeJS.ProcessEnv = {};
  await loadPublishedSources(file, environment);
  expect(JSON.parse(environment.LINGER_LOCALMODELS_TOOL_JSON!)).toEqual(tool);
  expect(environment.LINGER_LOCALMODELS_TOOL_ARCHIVE).toBe(
    path.join(path.dirname(file), "bundled-localmodels-kit.tgz"),
  );

  const preset: NodeJS.ProcessEnv = {
    LINGER_LOCALMODELS_TOOL_JSON: "preset-json",
  };
  await loadPublishedSources(file, preset);
  expect(preset).toEqual({ LINGER_LOCALMODELS_TOOL_JSON: "preset-json" });
});

it("exports the published voice tools beside the native sources", async () => {
  const voice = {
    target: "linux-x64",
    file: "native/voice-tools-linux-x64.tar.gz",
    sha256: "b".repeat(64),
    bytes: 100,
    livekitVersion: "1.13.6",
    ffmpegVersion: "8.1.2",
  };
  const file = distribution({
    platform: process.platform,
    arch: process.arch,
    voiceTools: [voice],
  });
  const environment: NodeJS.ProcessEnv = {};
  await loadPublishedSources(file, environment);
  expect(JSON.parse(environment.LINGER_NATIVE_VOICE_TOOLS_JSON!)).toEqual([
    { ...voice, file: path.join(path.dirname(file), voice.file) },
  ]);
});

it("rejects a distribution for another computer", async () => {
  await expect(
    loadPublishedSources(
      distribution({
        platform: "plan9",
        arch: process.arch,
        nativeSources: [],
      }),
      {},
    ),
  ).rejects.toThrow(/does not match/);
});

it("reports the real start failure and points at permissions only for access errors", async () => {
  const { startFailure } = await import("./main.js");
  const busy = Object.assign(
    new Error(
      "An earlier installation is still running. Wait for it to finish or cancel it, then try again.",
    ),
    { code: "INSTALLER_BUSY" },
  );
  expect(startFailure(busy)).toBe(
    "Installer could not start (INSTALLER_BUSY): An earlier installation is still running. Wait for it to finish or cancel it, then try again.",
  );
  expect(startFailure(busy)).not.toContain("permissions");
  const denied = Object.assign(
    new Error("EACCES: permission denied, mkdir '/home/x/installer'"),
    { code: "EACCES" },
  );
  expect(startFailure(denied)).toContain(
    "Check the installation package and home directory permissions.",
  );
});

// A folder the ACL program refused, as windowsPrivatePath throws it.
const refused = () =>
  Object.assign(
    new Error(
      "Windows private path validation failed: D:\\Apps\\Linger is inside a folder.",
    ),
    {
      code: "WINDOWS_PRIVATE_PATH_UNSAFE",
      reason: "UNSAFE_PARENT_ACCESS",
      path: "D:\\Apps\\Linger",
    },
  );

it("tells the desktop client by code why a refused folder stopped the start", async () => {
  const { startFailureLine } = await import("./main.js");
  expect(startFailureLine(refused())).toBe(
    '{"startFailure":{"code":"WINDOWS_PRIVATE_PATH_UNSAFE","reason":"UNSAFE_PARENT_ACCESS"}}\n',
  );
  expect(
    startFailureLine(
      Object.assign(new Error("busy"), { code: "INSTALLER_BUSY" }),
    ),
  ).toBeUndefined();
});

it("keeps every line of a start failure", async () => {
  const { startFailure } = await import("./main.js");
  expect(
    startFailure(new Error("Could not start these instances:\nalpha: why\n")),
  ).toBe(
    "Installer could not start: Could not start these instances:\nalpha: why",
  );
});

it("names a leftover instance it could not convert and why", async () => {
  const { legacySkippedWarning } = await import("./main.js");
  expect(
    legacySkippedWarning({
      instance: "default",
      reason: "Its Computer is running 2 task(s).",
    }),
  ).toBe(
    'Linger could not convert the instance "default" from the earlier Simplex app and left it as it was; it tries again at the next start. Its Computer is running 2 task(s).',
  );
});

it("saves keys in the instance's user.env without echoing their values", async () => {
  const { parseInstallerArguments, saveUserKeys } = await import("./main.js");
  expect(() => parseInstallerArguments(["--user-keys"])).toThrow(
    "Keys need an instance.",
  );
  const home = mkdtempSync(path.join(os.tmpdir(), "installer-keys-"));
  const options = parseInstallerArguments([
    "--home",
    home,
    "--instance",
    "desktop",
    "--user-keys",
  ]);
  expect(options.userKeys).toBe(true);
  expect(
    await saveUserKeys(
      options,
      JSON.stringify({
        COMPOSIO_API_KEY: "composio-1",
        SONIOX_API_KEY: "soniox-1",
        XAI_API_KEY: "xai-1",
      }),
    ),
  ).toEqual({ saved: ["COMPOSIO_API_KEY", "SONIOX_API_KEY", "XAI_API_KEY"] });
  expect(
    await saveUserKeys(options, JSON.stringify({ XAI_API_KEY: "" })),
  ).toEqual({ saved: ["COMPOSIO_API_KEY", "SONIOX_API_KEY"] });
  const failed = await saveUserKeys(
    options,
    JSON.stringify({ XAI_API_KEY: "bad value" }),
  );
  expect(failed).toEqual({ error: "XAI_API_KEY is not a valid key" });
  expect(await saveUserKeys(options, "not json")).toEqual({
    error: "Invalid keys",
  });
});

it("migrates without a source checkout", async () => {
  const { parseInstallerArguments } = await import("./main.js");
  const home = path.join(os.tmpdir(), "linger-migrate-home");
  expect(parseInstallerArguments(["--home", home, "--migrate"])).toMatchObject({
    home,
    migrate: true,
  });
});

it("inspects a separate target without changing the tool home", async () => {
  const { parseInstallerArguments } = await import("./main.js");
  expect(
    parseInstallerArguments([
      "--home",
      "cache",
      "--inspect",
      "--inspect-target",
      "candidate",
    ]),
  ).toMatchObject({
    home: path.resolve("cache"),
    inspect: true,
    inspectTarget: path.resolve("candidate"),
  });
  expect(() =>
    parseInstallerArguments(["--inspect", "--inspect-target"]),
  ).toThrow("Installer option is missing a value.");
  expect(() =>
    parseInstallerArguments([
      "--source-repo",
      "checkout",
      "--inspect-target",
      "candidate",
    ]),
  ).toThrow("An inspection target requires --inspect.");
});

it("does not migrate legacy installations during inspection", async () => {
  const migrate = vi.fn().mockResolvedValue([]);
  const inspect = vi.fn().mockResolvedValue({ recommendation: "codex" });
  vi.doMock("@linger/local-installation/legacy-migration", () => ({
    migrateLegacyInstallation: migrate,
  }));
  vi.doMock("@linger/local-installation/setup-plan", () => ({
    inspectSetup: inspect,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "cache",
      "--inspect",
      "--inspect-target",
      "candidate",
    ];
    vi.resetModules();
    await import("./main.js");
    expect(migrate).not.toHaveBeenCalled();
    expect(inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        home: path.resolve("cache"),
        targetHome: path.resolve("candidate"),
      }),
    );
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({ recommendation: "codex" })}\n`,
      expect.any(Function),
    );
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
    vi.doUnmock("@linger/local-installation/legacy-migration");
    vi.doUnmock("@linger/local-installation/setup-plan");
    vi.resetModules();
  }
});

it("tells the desktop client by code why a refused folder kept the keys unsaved", async () => {
  vi.resetModules();
  vi.doMock("@linger/local-installation/user-environment", () => ({
    updateUserKeys: () => Promise.reject(refused()),
  }));
  try {
    const { saveUserKeys } = await import("./main.js");
    expect(
      await saveUserKeys(
        { home: path.join(os.tmpdir(), "linger-refused"), instanceName: "d" },
        JSON.stringify({ XAI_API_KEY: "xai-1" }),
      ),
    ).toEqual({
      error: refused().message,
      refusal: {
        code: "WINDOWS_PRIVATE_PATH_UNSAFE",
        reason: "UNSAFE_PARENT_ACCESS",
      },
    });
  } finally {
    vi.doUnmock("@linger/local-installation/user-environment");
    vi.resetModules();
  }
});

it("surfaces a Windows private path refusal on stdout and stderr during --inspect", async () => {
  const inspect = vi.fn().mockRejectedValue(refused());
  vi.doMock("@linger/local-installation/setup-plan", () => ({
    inspectSetup: inspect,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "refused-home",
      "--inspect",
    ];
    vi.resetModules();
    await import("./main.js");
    expect(stderr).toHaveBeenCalledWith(
      `The check failed (WINDOWS_PRIVATE_PATH_UNSAFE): ${refused().message}\n`,
    );
    expect(stdout).toHaveBeenCalledWith(
      `${JSON.stringify({
        error: refused().message,
        refusal: {
          code: "WINDOWS_PRIVATE_PATH_UNSAFE",
          reason: "UNSAFE_PARENT_ACCESS",
        },
      })}\n`,
      expect.any(Function),
    );
    const done = stdout.mock.calls.at(-1)?.[1] as unknown;
    expect(typeof done).toBe("function");
    if (typeof done === "function") done();
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/setup-plan");
    vi.resetModules();
  }
});

it("writes null on stdout when --inspect fails without a Windows private path refusal", async () => {
  const inspect = vi.fn().mockRejectedValue(
    Object.assign(new Error("The localmodels setup report is unavailable."), {
      code: "LOCALMODELS_SETUP_UNAVAILABLE",
    }),
  );
  vi.doMock("@linger/local-installation/setup-plan", () => ({
    inspectSetup: inspect,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "unavailable-home",
      "--inspect",
    ];
    vi.resetModules();
    await import("./main.js");
    expect(stderr).toHaveBeenCalledWith(
      "The check failed: The localmodels setup report is unavailable.\n",
    );
    expect(stdout).toHaveBeenCalledWith("null\n", expect.any(Function));
    const done = stdout.mock.calls.at(-1)?.[1] as unknown;
    expect(typeof done).toBe("function");
    if (typeof done === "function") done();
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/setup-plan");
    vi.resetModules();
  }
});

it("includes resumeTimings in the --resume stdout JSON line alongside runtime fields", async () => {
  const migrate = vi.fn().mockResolvedValue([]);
  const resumeTimings = {
    path: "warm" as const,
    probeMs: 12,
    restoreLocalModelsMs: 5,
    restoreByokGatewayMs: 3,
    totalMs: 25,
  };
  const runtimeLookupTimings = {
    config: 1,
    runtime: 2,
    localModels: 3,
    tool: 4,
    total: 10,
  };
  const runtime = { environment: {} };
  vi.doMock("@linger/local-installation/legacy-migration", () => ({
    migrateLegacyInstallation: migrate,
  }));
  vi.doMock("./server/resume.js", () => ({
    resumeSourceInstance: vi.fn(
      async (opts: { onTimings?: (t: typeof resumeTimings) => void }) => {
        opts.onTimings?.(resumeTimings);
        return {
          code: 0,
          state: "ready",
          message: "Services are already running.",
        };
      },
    ),
  }));
  vi.doMock("./server/instance-runtime.js", () => ({
    instanceRuntime: vi.fn(
      async (
        _home: string,
        _name: string,
        opts?: { onTimings?: (t: typeof runtimeLookupTimings) => void },
      ) => {
        opts?.onTimings?.(runtimeLookupTimings);
        return runtime;
      },
    ),
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "resume-home",
      "--source-repo",
      "resume-repo",
      "--instance",
      "desktop",
      "--external-computer",
      "--resume",
    ];
    vi.resetModules();
    await import("./main.js");
    const line = stdout.mock.calls.at(-1)?.[0];
    expect(typeof line).toBe("string");
    expect(JSON.parse(String(line))).toEqual({
      code: 0,
      state: "ready",
      message: "Services are already running.",
      runtime,
      runtimeLookupTimings,
      resumeTimings,
    });
    const done = stdout.mock.calls.at(-1)?.[1] as unknown;
    if (typeof done === "function") done();
    expect(exit).toHaveBeenCalledWith(0);
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/legacy-migration");
    vi.doUnmock("./server/resume.js");
    vi.doUnmock("./server/instance-runtime.js");
    vi.resetModules();
  }
});

it("aborts --inspect gracefully on SIGTERM and removes the listener", async () => {
  let inspectSignal: AbortSignal | undefined;
  let inspectStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    inspectStarted = resolve;
  });
  const inspect = vi.fn(
    (opts: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        inspectSignal = opts.signal;
        inspectStarted();
        opts.signal.addEventListener(
          "abort",
          () => reject(new Error("Inspection aborted")),
          { once: true },
        );
      }),
  );
  vi.doMock("@linger/local-installation/setup-plan", () => ({
    inspectSetup: inspect,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const once = vi.spyOn(process, "once");
  const off = vi.spyOn(process, "off");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "sigterm-home",
      "--inspect",
    ];
    vi.resetModules();
    const running = import("./main.js");
    await started;
    const registered = once.mock.calls.find(
      ([event]) => event === "SIGTERM",
    )?.[1];
    expect(typeof registered).toBe("function");
    expect(inspectSignal?.aborted).toBe(false);
    process.emit("SIGTERM");
    await running;
    expect(inspectSignal?.aborted).toBe(true);
    expect(off).toHaveBeenCalledWith("SIGTERM", registered);
    expect(stdout).toHaveBeenCalledWith("null\n", expect.any(Function));
    const done = stdout.mock.calls.at(-1)?.[1] as unknown;
    if (typeof done === "function") done();
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
    once.mockRestore();
    off.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/setup-plan");
    vi.resetModules();
  }
});

it("parses --prepare-voice-tools without a source checkout and requires an instance", async () => {
  const { parseInstallerArguments } = await import("./main.js");
  const home = path.join(os.tmpdir(), "linger-voice-home");
  expect(
    parseInstallerArguments([
      "--prepare-voice-tools",
      "--home",
      home,
      "--instance",
      "native-test",
    ]),
  ).toMatchObject({
    home: path.resolve(home),
    instanceName: "native-test",
    prepareVoiceTools: true,
  });
  expect(() =>
    parseInstallerArguments(["--prepare-voice-tools", "--home", home]),
  ).toThrow("Voice tools preparation needs an instance.");
});

it("wires explicit launchVoiceToolsBackground from import.meta.url when serving", async () => {
  const migrate = vi.fn().mockResolvedValue([]);
  const voiceLauncher = vi.fn(() => ({ commit: vi.fn(), abort: vi.fn() }));
  const createVoiceToolsBackgroundLauncher = vi
    .fn()
    .mockReturnValue(voiceLauncher);
  const launchInstaller = vi.fn().mockResolvedValue({
    origin: "http://127.0.0.1:41234",
    close: vi.fn(),
    closed: Promise.resolve(),
  });
  vi.doMock("@linger/local-installation/legacy-migration", () => ({
    migrateLegacyInstallation: migrate,
  }));
  vi.doMock("@linger/local-installation/native-source", () => ({
    createVoiceToolsBackgroundLauncher,
  }));
  vi.doMock("./server/launch.js", () => ({
    launchInstaller,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const once = vi
    .spyOn(process, "once")
    .mockImplementation((() => process) as never);
  const mainPath = fileURLToPath(new URL("./main.ts", import.meta.url));
  try {
    process.argv = [
      process.execPath,
      mainPath,
      "--home",
      "serve-home",
      "--source-repo",
      "serve-repo",
      "--no-open",
    ];
    vi.resetModules();
    await import("./main.js");
    expect(createVoiceToolsBackgroundLauncher).toHaveBeenCalledWith(mainPath);
    expect(launchInstaller).toHaveBeenCalledWith(
      expect.objectContaining({
        home: path.resolve("serve-home"),
        sourceRepo: path.resolve("serve-repo"),
        launchVoiceToolsBackground: voiceLauncher,
      }),
    );
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    once.mockRestore();
    vi.doUnmock("@linger/local-installation/legacy-migration");
    vi.doUnmock("@linger/local-installation/native-source");
    vi.doUnmock("./server/launch.js");
    vi.resetModules();
  }
});

it("runs --prepare-voice-tools without legacy migration and exits 0 even on error", async () => {
  const migrate = vi.fn().mockResolvedValue([]);
  const prepareVoiceToolsAndStartLiveKit = vi
    .fn()
    .mockRejectedValue(new Error("archive missing"));
  vi.doMock("@linger/local-installation/legacy-migration", () => ({
    migrateLegacyInstallation: migrate,
  }));
  vi.doMock("@linger/local-installation/native-source", () => ({
    prepareVoiceToolsAndStartLiveKit,
  }));
  const argv = process.argv;
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--prepare-voice-tools",
      "--home",
      "voice-home",
      "--instance",
      "native-test",
    ];
    vi.resetModules();
    await import("./main.js");
    expect(migrate).not.toHaveBeenCalled();
    expect(prepareVoiceToolsAndStartLiveKit).toHaveBeenCalledWith(
      expect.objectContaining({
        home: path.resolve("voice-home"),
        instanceName: "native-test",
        waitForGoOnStdin: true,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(stderr).toHaveBeenCalledWith(
      "Background voice tools preparation failed: archive missing\n",
    );
    expect(exit).toHaveBeenCalledWith(0);
  } finally {
    process.argv = argv;
    stderr.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/legacy-migration");
    vi.doUnmock("@linger/local-installation/native-source");
    vi.resetModules();
  }
});

it("parses --prefetch-bifrost without requiring --source-repo", async () => {
  const { parseInstallerArguments } = await import("./main.js");
  const home = path.join(os.tmpdir(), "linger-prefetch-home");
  expect(
    parseInstallerArguments([
      "--home",
      home,
      "--prefetch-bifrost",
      "--abort-on-stdin-close",
    ]),
  ).toMatchObject({
    home: path.resolve(home),
    prefetchBifrost: true,
    abortOnStdinClose: true,
  });
  expect(() =>
    parseInstallerArguments([
      "--source-repo",
      "checkout",
      "--abort-on-stdin-close",
    ]),
  ).toThrow("--abort-on-stdin-close requires --prefetch-bifrost.");
});

it("runs --prefetch-bifrost without legacy migration and aborts cleanly on SIGTERM", async () => {
  const migrate = vi.fn().mockResolvedValue([]);
  let prefetchSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const prefetch = vi.fn(
    (_home: string, opts?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        prefetchSignal = opts?.signal;
        started();
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Interrupted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.doMock("@linger/local-installation/legacy-migration", () => ({
    migrateLegacyInstallation: migrate,
  }));
  vi.doMock("@linger/local-installation/localmodels-tool", () => ({
    readPublishedTool: vi.fn().mockResolvedValue(undefined),
    bundledToolArchivePath: vi.fn(),
    prefetchLocalmodelsBifrost: prefetch,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const once = vi.spyOn(process, "once");
  const off = vi.spyOn(process, "off");
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "prefetch-home",
      "--prefetch-bifrost",
    ];
    vi.resetModules();
    const running = import("./main.js");
    await ready;
    expect(migrate).not.toHaveBeenCalled();
    expect(prefetch).toHaveBeenCalledWith(
      path.resolve("prefetch-home"),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const registered = once.mock.calls.find(
      ([event]) => event === "SIGTERM",
    )?.[1];
    expect(typeof registered).toBe("function");
    process.emit("SIGTERM");
    await running;
    expect(prefetchSignal?.aborted).toBe(true);
    expect(off).toHaveBeenCalledWith("SIGTERM", registered);
    const line = stdout.mock.calls.at(-1)?.[0];
    expect(JSON.parse(String(line))).toEqual({
      ok: false,
      message: "Interrupted",
    });
    const done = stdout.mock.calls.at(-1)?.[1] as unknown;
    if (typeof done === "function") done();
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    process.argv = argv;
    stdout.mockRestore();
    stderr.mockRestore();
    once.mockRestore();
    off.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/legacy-migration");
    vi.doUnmock("@linger/local-installation/localmodels-tool");
    vi.resetModules();
  }
});

it("aborts --prefetch-bifrost --abort-on-stdin-close on stdin EOF and cleans up listeners", async () => {
  const { EventEmitter } = await import("node:events");
  const fakeStdin = Object.assign(new EventEmitter(), {
    readableEnded: false,
    destroyed: false,
    resume: vi.fn(),
    pause: vi.fn(),
  });
  const originalStdin = Object.getOwnPropertyDescriptor(process, "stdin");
  Object.defineProperty(process, "stdin", {
    value: fakeStdin,
    configurable: true,
  });
  let prefetchSignal: AbortSignal | undefined;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const prefetch = vi.fn(
    (_home: string, opts?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        prefetchSignal = opts?.signal;
        started();
        opts?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Interrupted", "AbortError")),
          { once: true },
        );
      }),
  );
  vi.doMock("@linger/local-installation/localmodels-tool", () => ({
    readPublishedTool: vi.fn().mockResolvedValue(undefined),
    bundledToolArchivePath: vi.fn(),
    prefetchLocalmodelsBifrost: prefetch,
  }));
  const argv = process.argv;
  const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL("./main.ts", import.meta.url)),
      "--home",
      "stdin-eof-home",
      "--prefetch-bifrost",
      "--abort-on-stdin-close",
    ];
    vi.resetModules();
    const running = import("./main.js");
    await ready;
    expect(fakeStdin.resume).toHaveBeenCalledOnce();
    expect(prefetchSignal?.aborted).toBe(false);
    fakeStdin.emit("end");
    await running;
    expect(prefetchSignal?.aborted).toBe(true);
    expect(fakeStdin.pause).toHaveBeenCalledOnce();
    expect(fakeStdin.listenerCount("end")).toBe(0);
    expect(fakeStdin.listenerCount("close")).toBe(0);
    const done = stdout.mock.calls.at(-1)?.[1] as unknown;
    if (typeof done === "function") done();
    expect(exit).toHaveBeenCalledWith(1);
  } finally {
    if (originalStdin) Object.defineProperty(process, "stdin", originalStdin);
    process.argv = argv;
    stdout.mockRestore();
    exit.mockRestore();
    vi.doUnmock("@linger/local-installation/localmodels-tool");
    vi.resetModules();
  }
});
