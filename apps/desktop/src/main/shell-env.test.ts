import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  loginShellEnvironment,
  runtimeSearchPath,
  withLoginShell,
  type RunShell,
} from "./shell-env.js";

const framed = (variables: Record<string, string>): string =>
  `banner\n__LINGER_ENV__${Object.entries(variables)
    .map(([key, value]) => `${key}=${value}\0`)
    .join("")}__LINGER_ENV__`;

describe.skipIf(process.platform === "win32")("loginShellEnvironment", () => {
  it("reads the interactive login shell's variables past its banner", async () => {
    const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
    const run: RunShell = async (_shell, args, options) => {
      calls.push({ args, env: options.env });
      return args[0] === "-ilc"
        ? {
            code: 0,
            stdout: framed({
              PATH: "/opt/homebrew/bin:/usr/bin",
              HTTPS_PROXY: "http://proxy:8080",
            }),
          }
        : { code: 0, stdout: framed({ PATH: "/usr/bin" }) };
    };
    const env = await loginShellEnvironment(
      {
        SHELL: "/bin/zsh",
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
        SECRET: "x",
      },
      run,
    );
    expect(env).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy:8080",
    });
    expect(calls.map((call) => call.args[0]).sort()).toEqual(["-ilc", "-lc"]);
    // The shell starts like a new terminal window, without the app's variables.
    expect(calls[0]!.env).toEqual({
      HOME: "/Users/me",
      SHELL: "/bin/zsh",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    });
  });

  it("falls back to the non-interactive shell and gives up on failure", async () => {
    const fallback: RunShell = async (_shell, args) =>
      args[0] === "-ilc"
        ? { code: -1, stdout: "" }
        : { code: 0, stdout: framed({ PATH: "/usr/local/bin:/usr/bin" }) };
    expect(
      await loginShellEnvironment({ SHELL: "/bin/zsh" }, fallback),
    ).toEqual({
      PATH: "/usr/local/bin:/usr/bin",
    });
    const failing: RunShell = async () => {
      throw new Error("spawn failed");
    };
    expect(
      await loginShellEnvironment({ SHELL: "/bin/zsh" }, failing),
    ).toBeUndefined();
    expect(
      await loginShellEnvironment({ SHELL: "zsh" }, fallback),
    ).toBeUndefined();
  });

  it("stabilizes fnm_multishells entries, keeps stable symlinks, and cleans probe symlinks", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "linger-shell-env-"));
    try {
      const nodeBin = path.join(
        root,
        "fnm",
        "node-versions",
        "v22.0.0",
        "installation",
        "bin",
      );
      await fsp.mkdir(nodeBin, { recursive: true });
      const installationDir = path.dirname(nodeBin);

      const stableRealBin = path.join(
        root,
        "homebrew",
        "Cellar",
        "tool",
        "bin",
      );
      await fsp.mkdir(stableRealBin, { recursive: true });
      const stableOptDir = path.join(root, "opt", "homebrew", "opt");
      await fsp.mkdir(stableOptDir, { recursive: true });
      const stableOptBin = path.join(stableOptDir, "tool-bin");
      await fsp.symlink(stableRealBin, stableOptBin);

      const multishellsDir = path.join(root, "state", "fnm_multishells");
      await fsp.mkdir(multishellsDir, { recursive: true });
      const interactiveLink = path.join(multishellsDir, "101_1");
      const loginLink = path.join(multishellsDir, "102_2");
      const parentLink = path.join(multishellsDir, "99_0");
      await fsp.symlink(
        path.relative(multishellsDir, installationDir),
        interactiveLink,
      );
      await fsp.symlink(installationDir, loginLink);
      await fsp.symlink(installationDir, parentLink);
      const danglingEntry = path.join(multishellsDir, "missing", "bin");

      const run: RunShell = async (_shell, args) => {
        if (args[0] === "-ilc") {
          return {
            code: 0,
            stdout: framed({
              FNM_MULTISHELL_PATH: interactiveLink,
              PATH: [
                path.join(interactiveLink, "bin"),
                stableOptBin,
                danglingEntry,
                "/usr/bin",
                stableOptBin,
              ].join(path.delimiter),
              HTTPS_PROXY: "http://proxy:8080",
            }),
          };
        }
        return {
          code: 0,
          stdout: framed({
            FNM_MULTISHELL_PATH: loginLink,
            PATH: [path.join(loginLink, "bin"), "/usr/bin"].join(
              path.delimiter,
            ),
          }),
        };
      };

      const env = await loginShellEnvironment(
        {
          SHELL: "/bin/zsh",
          HOME: root,
          FNM_MULTISHELL_PATH: parentLink,
        },
        run,
      );
      expect(env).toEqual({
        PATH: [nodeBin, stableOptBin, danglingEntry, "/usr/bin"].join(
          path.delimiter,
        ),
        HTTPS_PROXY: "http://proxy:8080",
      });
      expect(env?.FNM_MULTISHELL_PATH).toBeUndefined();
      await expect(fsp.lstat(interactiveLink)).rejects.toThrow();
      await expect(fsp.lstat(loginLink)).rejects.toThrow();
      expect((await fsp.lstat(parentLink)).isSymbolicLink()).toBe(true);
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("normalizes trailing slashes and preserves relative-only PATH when stabilization yields none", async () => {
    const trailingSlashEnv = await loginShellEnvironment(
      { SHELL: "/bin/zsh" },
      async (_shell, args) =>
        args[0] === "-ilc"
          ? {
              code: 0,
              stdout: framed({ PATH: "/usr/bin/:/usr/bin:/bin/" }),
            }
          : { code: -1, stdout: "" },
    );
    expect(trailingSlashEnv).toEqual({ PATH: "/usr/bin:/bin" });

    const relativeOnlyEnv = await loginShellEnvironment(
      { SHELL: "/bin/zsh" },
      async (_shell, args) =>
        args[0] === "-ilc"
          ? { code: 0, stdout: framed({ PATH: "relative/bin" }) }
          : { code: -1, stdout: "" },
    );
    expect(relativeOnlyEnv).toEqual({ PATH: "relative/bin" });
  });

  it("returns as soon as -ilc succeeds without waiting on -lc and still cleans up -lc probe symlinks", async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), "linger-shell-fast-"),
    );
    try {
      const nodeBin = path.join(
        root,
        "fnm",
        "node-versions",
        "v22.0.0",
        "installation",
        "bin",
      );
      await fsp.mkdir(nodeBin, { recursive: true });
      const installationDir = path.dirname(nodeBin);
      const multishellsDir = path.join(root, "state", "fnm_multishells");
      await fsp.mkdir(multishellsDir, { recursive: true });
      const interactiveLink = path.join(multishellsDir, "201_1");
      const loginLink = path.join(multishellsDir, "202_2");
      await fsp.symlink(installationDir, interactiveLink);
      await fsp.symlink(installationDir, loginLink);

      let resolveLogin!: (value: {
        readonly code: number;
        readonly stdout: string;
      }) => void;
      const loginPending = new Promise<{
        readonly code: number;
        readonly stdout: string;
      }>((resolve) => {
        resolveLogin = resolve;
      });

      const run: RunShell = async (_shell, args) => {
        if (args[0] === "-ilc") {
          return {
            code: 0,
            stdout: framed({
              FNM_MULTISHELL_PATH: interactiveLink,
              PATH: [path.join(interactiveLink, "bin"), "/usr/bin"].join(
                path.delimiter,
              ),
            }),
          };
        }
        return loginPending;
      };

      const env = await loginShellEnvironment(
        { SHELL: "/bin/zsh", HOME: root },
        run,
      );
      expect(env).toEqual({
        PATH: [nodeBin, "/usr/bin"].join(path.delimiter),
      });
      await expect(fsp.lstat(interactiveLink)).rejects.toThrow();
      // `-lc` has not finished yet, so its probe symlink still exists until it settles.
      expect((await fsp.lstat(loginLink)).isSymbolicLink()).toBe(true);

      resolveLogin({
        code: 0,
        stdout: framed({
          FNM_MULTISHELL_PATH: loginLink,
          PATH: [path.join(loginLink, "bin"), "/usr/bin"].join(path.delimiter),
        }),
      });
      await vi.waitFor(async () => {
        await expect(fsp.lstat(loginLink)).rejects.toThrow();
      });
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an early-settling -lc probe symlink intact until -ilc fails and -lc PATH is stabilized", async () => {
    const root = await fsp.mkdtemp(
      path.join(os.tmpdir(), "linger-shell-fall-"),
    );
    try {
      const nodeBin = path.join(
        root,
        "fnm",
        "node-versions",
        "v22.0.0",
        "installation",
        "bin",
      );
      await fsp.mkdir(nodeBin, { recursive: true });
      const installationDir = path.dirname(nodeBin);
      const multishellsDir = path.join(root, "state", "fnm_multishells");
      await fsp.mkdir(multishellsDir, { recursive: true });
      const loginLink = path.join(multishellsDir, "302_2");
      await fsp.symlink(installationDir, loginLink);

      let resolveInteractive!: (value: {
        readonly code: number;
        readonly stdout: string;
      }) => void;
      const interactivePending = new Promise<{
        readonly code: number;
        readonly stdout: string;
      }>((resolve) => {
        resolveInteractive = resolve;
      });
      let markLoginReturned!: () => void;
      const loginReturned = new Promise<void>((resolve) => {
        markLoginReturned = resolve;
      });

      const run: RunShell = async (_shell, args) => {
        if (args[0] === "-ilc") return interactivePending;
        markLoginReturned();
        return {
          code: 0,
          stdout: framed({
            FNM_MULTISHELL_PATH: loginLink,
            PATH: [path.join(loginLink, "bin"), "/usr/bin"].join(
              path.delimiter,
            ),
          }),
        };
      };

      const pending = loginShellEnvironment(
        { SHELL: "/bin/zsh", HOME: root },
        run,
      );
      await loginReturned;
      // Give `-lc`'s `.then` a turn to run while `-ilc` is still pending.
      await Promise.resolve();
      expect((await fsp.lstat(loginLink)).isSymbolicLink()).toBe(true);

      resolveInteractive({ code: -1, stdout: "" });
      const env = await pending;
      expect(env).toEqual({
        PATH: [nodeBin, "/usr/bin"].join(path.delimiter),
      });
      await expect(fsp.lstat(loginLink)).rejects.toThrow();
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === "win32")("withLoginShell", () => {
  it("puts the terminal PATH first and keeps the common install directories", () => {
    expect(
      runtimeSearchPath("/usr/bin:/bin", undefined, "/Users/me").split(
        path.delimiter,
      ),
    ).toEqual([
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/Users/me/.local/bin",
      "/Users/me/.npm-global/bin",
      "/Users/me/.volta/bin",
      "/Users/me/.bun/bin",
      "/Users/me/.claude/local",
    ]);
    const env = withLoginShell(
      { PATH: "/usr/bin:/bin", HOME: "/Users/me", HTTPS_PROXY: "http://app:1" },
      {
        PATH: "/Users/me/.npm-global/bin:/usr/bin",
        HTTPS_PROXY: "http://shell:2",
        ANTHROPIC_BASE_URL: "https://llm.example",
        SHLVL: "2",
      },
      "/Users/me",
    );
    expect(env.PATH!.split(path.delimiter).slice(0, 4)).toEqual([
      "/Users/me/.npm-global/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
    ]);
    // What the app already has wins; shell bookkeeping stays out.
    expect(env.HTTPS_PROXY).toBe("http://app:1");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://llm.example");
    expect(env.SHLVL).toBeUndefined();
  });
  it("drops a parent Claude Code session and its host-managed provider", () => {
    const env = withLoginShell(
      {
        CLAUDECODE: "1",
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
        CLAUDE_CODE_HOST_AUTH_ENV_VAR: "ANTHROPIC_AUTH_TOKEN",
        CLAUDE_CODE_SESSION_ID: "session-1",
        CLAUDE_AGENT_SDK_VERSION: "1.0.0",
        ANTHROPIC_BASE_URL: "https://host-gateway.example",
        ANTHROPIC_AUTH_TOKEN: "host-token",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "host-model",
        CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
        HOME: "/Users/me",
        PATH: "/usr/bin:/bin",
      },
      {
        PATH: "/usr/bin",
        ANTHROPIC_BASE_URL: "https://user.example",
        ANTHROPIC_AUTH_TOKEN: "user-token",
      },
      "/Users/me",
    );
    expect(
      Object.keys(env).filter((key) =>
        /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_AGENT_SDK_)/.test(key),
      ),
    ).toEqual([]);
    expect(env.ANTHROPIC_BASE_URL).toBe("https://user.example");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("user-token");
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe("/Users/me/.claude-work");
    expect(env.HOME).toBe("/Users/me");
  });

  it("keeps the user's own provider settings from an ordinary terminal", () => {
    const env = withLoginShell(
      {
        PATH: "/usr/bin:/bin",
        ANTHROPIC_BASE_URL: "https://app.example",
        ANTHROPIC_API_KEY: "app-key",
      },
      { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "https://shell.example" },
      "/Users/me",
    );
    expect(env.ANTHROPIC_BASE_URL).toBe("https://app.example");
    expect(env.ANTHROPIC_API_KEY).toBe("app-key");
  });

  it("leaves a Dock launch environment unchanged", () => {
    const app = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: "/Users/me",
      USER: "me",
    };
    const login = {
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
      ANTHROPIC_BASE_URL: "https://llm.example",
      HTTPS_PROXY: "http://proxy:1",
    };
    expect(withLoginShell(app, login, "/Users/me")).toEqual({
      ...app,
      ANTHROPIC_BASE_URL: "https://llm.example",
      HTTPS_PROXY: "http://proxy:1",
      PATH: runtimeSearchPath(app.PATH, login.PATH, "/Users/me"),
    });
  });

  it("drops FNM_MULTISHELL_PATH and stabilizes inherited fnm_multishells PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "linger-with-login-"));
    try {
      const nodeBin = path.join(root, "fnm", "v24", "installation", "bin");
      fs.mkdirSync(nodeBin, { recursive: true });
      const multishellsDir = path.join(root, "fnm_multishells");
      fs.mkdirSync(multishellsDir, { recursive: true });
      const parentLink = path.join(multishellsDir, "555_1");
      fs.symlinkSync(path.dirname(nodeBin), parentLink);

      const env = withLoginShell(
        {
          HOME: root,
          PATH: [path.join(parentLink, "bin"), "/usr/bin"].join(path.delimiter),
        },
        {
          PATH: [nodeBin, "/usr/bin"].join(path.delimiter),
          FNM_MULTISHELL_PATH: parentLink,
        },
        root,
      );
      expect(env.FNM_MULTISHELL_PATH).toBeUndefined();
      expect(env.PATH!.split(path.delimiter).slice(0, 2)).toEqual([
        nodeBin,
        "/usr/bin",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("withLoginShell Windows single PATH key", () => {
  it("preserves Path without emitting duplicate Path and PATH keys on Windows", () => {
    const winEnv = withLoginShell(
      { Path: "C:\\Windows\\System32;C:\\Tools", FOO: "1" },
      { PATH: "C:\\Extra" },
      "C:\\Users\\lx",
      { platform: "win32" },
    );
    expect(Object.keys(winEnv).filter((key) => /^path$/i.test(key))).toEqual([
      "Path",
    ]);
    expect(winEnv.Path).toBe("C:\\Extra;C:\\Windows\\System32;C:\\Tools");
    expect(winEnv.PATH).toBeUndefined();
    expect(winEnv.FOO).toBe("1");

    const collapser = withLoginShell(
      {
        PATH: "C:\\Program Files\\nodejs",
        Path: "C:\\Windows\\System32",
        FOO: "1",
      },
      undefined,
      "C:\\Users\\lx",
      { platform: "win32" },
    );
    expect(Object.keys(collapser).filter((key) => /^path$/i.test(key))).toEqual(
      ["PATH"],
    );
    expect(collapser.PATH).toBe(
      "C:\\Program Files\\nodejs;C:\\Windows\\System32",
    );
  });

  it("collapses case-variant Path into PATH on POSIX without duplicate keys", () => {
    const posixEnv = withLoginShell(
      { Path: "/custom/bin", FOO: "1" },
      undefined,
      "/Users/me",
      { platform: "darwin" },
    );
    expect(Object.keys(posixEnv).filter((key) => /^path$/i.test(key))).toEqual([
      "PATH",
    ]);
    expect(posixEnv.PATH?.split(":")).toContain("/custom/bin");
    expect(posixEnv.FOO).toBe("1");
  });
});
