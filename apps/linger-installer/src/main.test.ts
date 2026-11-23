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
