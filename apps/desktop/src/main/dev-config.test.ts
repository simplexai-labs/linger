import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  classifyWatchEvent,
  parseDevArgs,
  resolveDevSession,
  resolveLocalmodelsPython,
} from "../../scripts/dev-config.mjs";

describe("parseDevArgs", () => {
  it("parses server, localmodels, debug, profile, and forwarded Electron args", () => {
    const parsed = parseDevArgs([
      "--server",
      "http://127.0.0.1:3000/rooms",
      "--localmodels",
      "../llm-inference-lab",
      "--debug",
      "simulate:download_ms=1000,vram_gb=24",
      "--profile",
      "hmr-test",
      "--reset",
      "--skip-daemon",
      "--no-watch",
      "--",
      "--ozone-platform=headless",
      "--disable-gpu",
    ]);
    expect(parsed).toEqual({
      help: false,
      server: "http://127.0.0.1:3000",
      quickInstall: false,
      checkout: undefined,
      localmodels: "../llm-inference-lab",
      localmodelsPython: undefined,
      debug: "simulate:download_ms=1000,vram_gb=24",
      profile: "hmr-test",
      reset: true,
      skipDaemon: true,
      withComputerTools: false,
      watch: false,
      dryRun: false,
      electronArgs: ["--ozone-platform=headless", "--disable-gpu"],
    });
  });

  it("handles pnpm's leading -- separator before dev options and forwarded Electron args", () => {
    const parsed = parseDevArgs([
      "--",
      "--server",
      "http://127.0.0.1:3000",
      "--dry-run",
      "--",
      "--disable-gpu",
    ]);
    expect(parsed.server).toBe("http://127.0.0.1:3000");
    expect(parsed.dryRun).toBe(true);
    expect(parsed.electronArgs).toEqual(["--disable-gpu"]);

    const electronOnly = parseDevArgs(["--", "--ozone-platform=headless"]);
    expect(electronOnly.electronArgs).toEqual(["--ozone-platform=headless"]);
  });

  it("rejects conflicting or invalid options", () => {
    expect(() =>
      parseDevArgs(["--server", "http://127.0.0.1:3000", "--quick-install"]),
    ).toThrow(/cannot be combined/i);
    expect(() => parseDevArgs(["--server", "ftp://127.0.0.1"])).toThrow(
      /http or https/i,
    );
    expect(() => parseDevArgs(["--profile", "../escape"])).toThrow(
      /Invalid --profile/i,
    );
    expect(() => parseDevArgs(["--unknown"])).toThrow(/Unknown option/i);
  });
});

describe("resolveLocalmodelsPython", () => {
  it("prefers the checkout .venv Python on POSIX and Windows", () => {
    const posixVenv = path.join("/src/lab", ".venv", "bin", "python");
    expect(
      resolveLocalmodelsPython("/src/lab", undefined, {
        platform: "linux",
        exists: (target) => target === posixVenv,
        findOnPath: () => "/usr/bin/python3",
      }),
    ).toBe(posixVenv);

    const winVenv = path.join("/src/lab", ".venv", "Scripts", "python.exe");
    expect(
      resolveLocalmodelsPython("/src/lab", undefined, {
        platform: "win32",
        exists: (target) => target === winVenv,
        findOnPath: () => "C:\\Python\\python.exe",
      }),
    ).toBe(winVenv);
  });

  it("falls back to PATH python3 when no .venv exists", () => {
    expect(
      resolveLocalmodelsPython("/src/lab", undefined, {
        platform: "darwin",
        exists: () => false,
        findOnPath: (name) =>
          name === "python3" ? "/opt/homebrew/bin/python3" : undefined,
      }),
    ).toBe("/opt/homebrew/bin/python3");
  });
});

describe("resolveDevSession", () => {
  it("isolates userData and home under .linger-runtime/desktop-dev/<profile> and wires localmodels", () => {
    const repoRoot = "/work/linger";
    const labDir = "/work/llm-inference-lab";
    const labPython = path.join(labDir, ".venv", "bin", "python");
    const session = resolveDevSession(
      parseDevArgs([
        "--server",
        "http://127.0.0.1:3000",
        "--localmodels",
        labDir,
        "--debug",
        "tiny",
      ]),
      {
        repoRoot,
        env: { PATH: "/usr/bin" },
        platform: "linux",
        arch: "x64",
        exists: (target) =>
          target === path.join(labDir, "localmodels") || target === labPython,
      },
    );

    expect(session.mode).toBe("server");
    expect(session.userData).toBe(
      path.join(repoRoot, ".linger-runtime", "desktop-dev", "dev", "user-data"),
    );
    expect(session.home).toBe(
      path.join(repoRoot, ".linger-runtime", "desktop-dev", "dev", "home"),
    );
    expect(session.electronEnv.LINGER_SERVER_URL).toBe("http://127.0.0.1:3000");
    expect(session.electronEnv.LINGER_LOCALMODELS_DEV_PYTHON).toBe(labPython);
    expect(session.electronEnv.LINGER_LOCALMODELS_DEV_MODULE_DIR).toBe(labDir);
    expect(session.electronEnv.LOCALMODELS_DEBUG).toBe("tiny");
    expect(session.electronEnv.LINGER_CHECKOUT).toBeUndefined();
  });

  it("sets LINGER_CHECKOUT to repoRoot and clears ambient LINGER_SERVER_URL in --quick-install mode", () => {
    const repoRoot = "/work/linger";
    const session = resolveDevSession(parseDevArgs(["--quick-install"]), {
      repoRoot,
      env: { LINGER_SERVER_URL: "http://127.0.0.1:3000" },
      platform: "darwin",
      arch: "arm64",
      exists: () => true,
    });
    expect(session.mode).toBe("quick-install");
    expect(session.serverUrl).toBeNull();
    expect(session.checkout).toBe(repoRoot);
    expect(session.electronEnv.LINGER_SERVER_URL).toBeUndefined();
    expect(session.electronEnv.LINGER_CHECKOUT).toBe(repoRoot);
  });
});

describe("classifyWatchEvent", () => {
  it("matches production sources and ignores tests, dist outputs, and editor swap files", () => {
    expect(classifyWatchEvent("installer", "server/jobs.ts")).toBe("installer");
    expect(classifyWatchEvent("installer", "server/jobs.test.ts")).toBeNull();
    expect(classifyWatchEvent("installer", "dist/installer.js")).toBeNull();
    expect(classifyWatchEvent("installer", ".#jobs.ts")).toBeNull();

    expect(classifyWatchEvent("daemon", "internal/localmodels/tool.go")).toBe(
      "daemon",
    );
    expect(
      classifyWatchEvent("daemon", "internal/localmodels/tool_test.go"),
    ).toBeNull();
    expect(classifyWatchEvent("daemon", "go.mod")).toBe("daemon");

    expect(classifyWatchEvent("teamhub-cli", "cli.ts")).toBe("teamhub-cli");
    expect(classifyWatchEvent("teamhub-cli", "cli.test.ts")).toBeNull();
  });
});
