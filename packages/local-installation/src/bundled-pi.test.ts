import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareSemver,
  ensureStableBundledPi,
  findHigherPrecedencePi,
  resolveBundledPi,
  withBundledPiPath,
  type BundledPi,
} from "./bundled-pi.js";
import { runLocalmodels } from "./localmodels-tool.js";
import { REGION_SCHEMA, regionFile } from "./region.js";

const tempRoots: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

async function reopenDirectories(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      await reopenDirectories(path.join(directory, entry.name));
    }
  }
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    tempRoots.splice(0).map(async (dir) => {
      if (process.platform !== "win32") await reopenDirectories(dir);
      await rm(dir, { recursive: true, force: true });
    }),
  );
});

async function stageBundledPiFixture(
  toolsRoot: string,
  nodePath: string,
  platform: NodeJS.Platform,
  version = "1.5.2",
): Promise<{ readonly executable: string; readonly cliEntry: string }> {
  const piEntry = platform === "win32" ? "bin/pi.exe" : "bin/pi";
  const executable = path.join(toolsRoot, ...piEntry.split("/"));
  const cliEntry = path.join(
    toolsRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "bundle",
    "cli.js",
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await mkdir(path.dirname(cliEntry), { recursive: true });
  await mkdir(path.dirname(nodePath), { recursive: true });
  await writeFile(executable, platform === "win32" ? "MZ" : "#!/bin/sh\n", {
    mode: 0o755,
  });
  if (platform !== "win32") await chmod(executable, 0o755);
  await writeFile(cliEntry, "console.log('pi');\n");
  await writeFile(nodePath, "node", { mode: 0o755 });
  await writeFile(
    path.join(toolsRoot, "manifest.json"),
    JSON.stringify({
      schema_version: 1,
      versions: { pi: version },
      pi_entry: piEntry,
    }),
  );
  return { executable, cliEntry };
}

describe("compareSemver", () => {
  it("orders numeric versions and prereleases, and treats unparseable inputs as 0", () => {
    expect(compareSemver("1.6.0", "1.5.2")).toBe(1);
    expect(compareSemver("1.10.0", "1.5.2")).toBe(1);
    expect(compareSemver("1.5.2", "1.5.2")).toBe(0);
    expect(compareSemver("1.2.0", "1.5.2")).toBe(-1);
    expect(compareSemver("1.5.2", "1.5.2-rc.1")).toBe(1);
    expect(compareSemver("1.5.2-rc.2", "1.5.2-rc.1")).toBe(1);
    expect(compareSemver("1.5.2-rc.1", "1.5.2-rc.10")).toBe(-1);
    expect(compareSemver("1.5.2+build.1", "1.5.2")).toBe(0);
    expect(compareSemver("not-a-version", "1.5.2")).toBe(0);
    expect(compareSemver("1.5.2", "not-a-version")).toBe(0);
    expect(compareSemver("1.5.2-", "1.5.2")).toBe(0);
  });
});

describe("resolveBundledPi", () => {
  it("resolves the packaged Desktop layout on POSIX and Windows", async () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      const root = await makeTempDir(`linger-bundled-pi-pkg-${platform}-`);
      const scriptPath = path.join(
        root,
        "resources",
        "app",
        "dist",
        "installer",
        "installer.js",
      );
      const toolsRoot = path.join(root, "resources", "cli", "computer-tools");
      const nodePath = path.join(
        root,
        "resources",
        "runtime",
        "bin",
        platform === "win32" ? "node.exe" : "node",
      );
      const { executable } = await stageBundledPiFixture(
        toolsRoot,
        nodePath,
        platform,
      );

      await expect(resolveBundledPi({ scriptPath, platform })).resolves.toEqual(
        {
          binDir: path.dirname(executable),
          executable,
          version: "1.5.2",
        },
      );
    }
  });

  it("resolves the dev Desktop layout", async () => {
    const root = await makeTempDir("linger-bundled-pi-dev-");
    const scriptPath = path.join(root, "dist", "installer", "installer.js");
    const toolsRoot = path.join(
      root,
      "dist",
      "computer",
      "cli",
      "computer-tools",
    );
    const nodePath = path.join(
      root,
      "dist",
      "computer",
      "runtime",
      "bin",
      "node",
    );
    const { executable } = await stageBundledPiFixture(
      toolsRoot,
      nodePath,
      "linux",
    );

    await expect(
      resolveBundledPi({ scriptPath, platform: "linux" }),
    ).resolves.toEqual({
      binDir: path.dirname(executable),
      executable,
      version: "1.5.2",
    });
  });

  it("returns undefined when manifest, launcher, cli.js, or node is missing or invalid", async () => {
    const makeBase = async () => {
      const root = await makeTempDir("linger-bundled-pi-invalid-");
      const scriptPath = path.join(
        root,
        "resources",
        "app",
        "dist",
        "installer",
        "installer.js",
      );
      const toolsRoot = path.join(root, "resources", "cli", "computer-tools");
      const nodePath = path.join(root, "resources", "runtime", "bin", "node");
      const { executable, cliEntry } = await stageBundledPiFixture(
        toolsRoot,
        nodePath,
        "linux",
      );
      return { scriptPath, toolsRoot, nodePath, executable, cliEntry };
    };

    // Corrupt manifest
    const corrupt = await makeBase();
    await writeFile(path.join(corrupt.toolsRoot, "manifest.json"), "{bad");
    await expect(
      resolveBundledPi({ scriptPath: corrupt.scriptPath, platform: "linux" }),
    ).resolves.toBeUndefined();

    // Missing node
    const noNode = await makeBase();
    await rm(noNode.nodePath);
    await expect(
      resolveBundledPi({ scriptPath: noNode.scriptPath, platform: "linux" }),
    ).resolves.toBeUndefined();

    // Missing cli.js
    const noCli = await makeBase();
    await rm(noCli.cliEntry);
    await expect(
      resolveBundledPi({ scriptPath: noCli.scriptPath, platform: "linux" }),
    ).resolves.toBeUndefined();

    // Wrong pi_entry for platform
    const wrongEntry = await makeBase();
    await expect(
      resolveBundledPi({
        scriptPath: wrongEntry.scriptPath,
        platform: "win32",
      }),
    ).resolves.toBeUndefined();

    if (process.platform !== "win32") {
      // Non-executable launcher on POSIX
      const nonExec = await makeBase();
      await chmod(nonExec.executable, 0o644);
      await expect(
        resolveBundledPi({
          scriptPath: nonExec.scriptPath,
          platform: "linux",
        }),
      ).resolves.toBeUndefined();

      // Symlinked launcher refused
      const linked = await makeBase();
      const target = path.join(linked.toolsRoot, "bin", "real-pi");
      await writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
      await rm(linked.executable);
      await symlink(target, linked.executable);
      await expect(
        resolveBundledPi({ scriptPath: linked.scriptPath, platform: "linux" }),
      ).resolves.toBeUndefined();
    }
  });

  it.skipIf(process.platform === "win32")(
    "resolves symlinked installer.js and standalone Local Computer symlink layouts",
    async () => {
      // Symlinked installer.js in ~/.local/bin -> packaged Desktop resources
      const desktopRoot = await makeTempDir("linger-bundled-pi-symlink-");
      const realInstaller = path.join(
        desktopRoot,
        "resources",
        "app",
        "dist",
        "installer",
        "installer.js",
      );
      await mkdir(path.dirname(realInstaller), { recursive: true });
      await writeFile(realInstaller, "export {};\n");
      const desktopToolsRoot = path.join(
        desktopRoot,
        "resources",
        "cli",
        "computer-tools",
      );
      const desktopNode = path.join(
        desktopRoot,
        "resources",
        "runtime",
        "bin",
        "node",
      );
      const { executable: desktopPi } = await stageBundledPiFixture(
        desktopToolsRoot,
        desktopNode,
        "linux",
      );
      const symlinkedInstaller = path.join(
        desktopRoot,
        "user-home",
        ".local",
        "bin",
        "installer.js",
      );
      await mkdir(path.dirname(symlinkedInstaller), { recursive: true });
      await symlink(realInstaller, symlinkedInstaller);
      await expect(
        resolveBundledPi({ scriptPath: symlinkedInstaller, platform: "linux" }),
      ).resolves.toEqual({
        binDir: path.dirname(desktopPi),
        executable: desktopPi,
        version: "1.5.2",
      });

      // Standalone Local Computer layout:
      // lib-1.0.0/cli/computer-tools -> ../../deps-abc/computer-tools
      // lib-1.0.0/runtime -> ../deps-abc/runtime
      const standaloneRoot = await makeTempDir("linger-bundled-pi-standalone-");
      const depsToolsRoot = path.join(
        standaloneRoot,
        "deps-abc",
        "computer-tools",
      );
      const depsNode = path.join(
        standaloneRoot,
        "deps-abc",
        "runtime",
        "bin",
        "node",
      );
      const { executable: standalonePi } = await stageBundledPiFixture(
        depsToolsRoot,
        depsNode,
        "linux",
      );
      const cliDir = path.join(standaloneRoot, "lib-1.0.0", "cli");
      const daemonDir = path.join(standaloneRoot, "lib-1.0.0", "daemon");
      await mkdir(cliDir, { recursive: true });
      await mkdir(daemonDir, { recursive: true });
      await symlink(
        path.join("..", "..", "deps-abc", "computer-tools"),
        path.join(cliDir, "computer-tools"),
      );
      await symlink(
        path.join("..", "deps-abc", "runtime"),
        path.join(standaloneRoot, "lib-1.0.0", "runtime"),
      );
      const cliScript = path.join(cliDir, "linger-computer");
      const daemonScript = path.join(daemonDir, "linger-computer-daemon");
      await writeFile(cliScript, "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(daemonScript, "#!/bin/sh\n", { mode: 0o755 });

      const userLauncher = path.join(
        standaloneRoot,
        "user-home",
        ".local",
        "bin",
        "linger-computer",
      );
      await mkdir(path.dirname(userLauncher), { recursive: true });
      await symlink(cliScript, userLauncher);

      for (const scriptPath of [cliScript, daemonScript, userLauncher]) {
        await expect(
          resolveBundledPi({ scriptPath, platform: "linux" }),
        ).resolves.toEqual({
          binDir: path.dirname(standalonePi),
          executable: standalonePi,
          version: "1.5.2",
        });
      }
    },
  );
});

describe("ensureStableBundledPi", () => {
  it("is a no-op on win32", async () => {
    const home = await makeTempDir("linger-stable-pi-win-");
    const bundledPi: BundledPi = {
      binDir: "C:\\Program Files\\Linger\\resources\\cli\\computer-tools\\bin",
      executable:
        "C:\\Program Files\\Linger\\resources\\cli\\computer-tools\\bin\\pi.exe",
      version: "1.5.2",
    };
    await expect(
      ensureStableBundledPi(home, bundledPi, { platform: "win32" }),
    ).resolves.toBe(bundledPi);
  });

  it.skipIf(process.platform === "win32")(
    "creates a private POSIX symlink, no-ops when unchanged, and updates atomically after app relocation",
    async () => {
      const root = await makeTempDir("linger-stable-pi-posix-");
      const home = path.join(root, "home");
      const firstBin = path.join(root, "downloads", "Linger.app", "bin");
      const secondBin = path.join(root, "applications", "Linger.app", "bin");
      await mkdir(firstBin, { recursive: true });
      await mkdir(secondBin, { recursive: true });
      const firstExe = path.join(firstBin, "pi");
      const secondExe = path.join(secondBin, "pi");
      await writeFile(firstExe, "#!/bin/sh\n", { mode: 0o755 });
      await writeFile(secondExe, "#!/bin/sh\n", { mode: 0o755 });

      const stableBin = path.join(home, "runtime", "bundled-pi", "bin");
      const stableLink = path.join(stableBin, "pi");

      const first = await ensureStableBundledPi(home, {
        binDir: firstBin,
        executable: firstExe,
        version: "1.5.2",
      });
      expect(first).toEqual({
        binDir: stableBin,
        executable: stableLink,
        version: "1.5.2",
      });
      expect(await readlink(stableLink)).toBe(firstExe);
      expect((await lstat(stableBin)).mode & 0o777).toBe(0o700);
      const firstInfo = await lstat(stableLink);

      // Calling again with the same target performs no writes (same symlink inode).
      const repeated = await ensureStableBundledPi(home, {
        binDir: firstBin,
        executable: firstExe,
        version: "1.5.2",
      });
      expect(repeated).toEqual(first);
      const repeatedInfo = await lstat(stableLink);
      expect(repeatedInfo.ino).toBe(firstInfo.ino);

      // Moving the app to a new path updates the stable symlink atomically.
      const relocated = await ensureStableBundledPi(home, {
        binDir: secondBin,
        executable: secondExe,
        version: "1.5.2",
      });
      expect(relocated).toEqual({
        binDir: stableBin,
        executable: stableLink,
        version: "1.5.2",
      });
      expect(await readlink(stableLink)).toBe(secondExe);
    },
  );
});

describe("withBundledPiPath", () => {
  // Real Windows temp directories contain a drive colon ("C:\"), which collides
  // with the Linux PATH delimiter ":". Windows PATH behavior is tested below.
  it.skipIf(process.platform === "win32")(
    "orders user PATH > ~/.local/bin > newer harness Pi > bundled Pi and excludes older or equal harness copies",
    async () => {
      const root = await makeTempDir("linger-bundled-pi-path-posix-");
      const home = path.join(root, "linger-home");
      const userHome = path.join(root, "user-home");
      const userBin = path.join(root, "user-bin");
      const localBin = path.join(userHome, ".local", "bin");
      const bundledBin = path.join(
        root,
        "resources",
        "cli",
        "computer-tools",
        "bin",
      );
      const piTools = path.join(home, "runtime", "harness", "tools", "pi");

      await mkdir(userBin, { recursive: true });
      await mkdir(localBin, { recursive: true });
      await mkdir(bundledBin, { recursive: true });

      for (const ver of ["1.2.0", "1.5.2", "1.6.0", "1.10.0", "invalid"]) {
        const dir = path.join(piTools, ver);
        await mkdir(dir, { recursive: true });
        const bin = path.join(dir, "pi");
        await writeFile(bin, "#!/bin/sh\n", { mode: 0o755 });
        if (process.platform !== "win32") await chmod(bin, 0o755);
      }

      const bundledPi: BundledPi = {
        binDir: bundledBin,
        executable: path.join(bundledBin, "pi"),
        version: "1.5.2",
      };

      const result = await withBundledPiPath(
        {
          HOME: userHome,
          PATH: `${userBin}:${localBin}`,
        },
        { home, bundledPi, platform: "linux" },
      );

      expect(result.SIMPLEX_PI_PATH).toBeUndefined();
      expect(result.PATH?.split(":")).toEqual([
        userBin,
        localBin,
        path.join(piTools, "1.10.0"),
        path.join(piTools, "1.6.0"),
        bundledBin,
      ]);
    },
  );

  it("preserves Windows Path casing without duplicate keys and includes %APPDATA%\\npm before harness and bundled Pi", async () => {
    const root = await makeTempDir("linger-bundled-pi-path-win-");
    const home = path.join(root, "linger-home");
    const userHome = path.join(root, "user-home");
    const localBin = path.join(userHome, ".local", "bin");
    const appData = path.join(userHome, "AppData", "Roaming");
    const npmBin = path.join(appData, "npm");
    const userBin = path.join(root, "UserBin");
    const bundledBin = path.join(
      root,
      "resources",
      "cli",
      "computer-tools",
      "bin",
    );
    const piTools = path.join(home, "runtime", "harness", "tools", "pi");

    await mkdir(localBin, { recursive: true });
    await mkdir(npmBin, { recursive: true });
    await mkdir(userBin, { recursive: true });
    await mkdir(bundledBin, { recursive: true });

    for (const ver of ["1.2.0", "1.5.2", "1.6.0"]) {
      const dir = path.join(piTools, ver);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "pi.exe"), "MZ");
    }

    const bundledPi: BundledPi = {
      binDir: bundledBin,
      executable: path.join(bundledBin, "pi.exe"),
      version: "1.5.2",
    };

    const result = await withBundledPiPath(
      {
        USERPROFILE: userHome,
        AppData: appData,
        Path: `${userBin};${userBin.toLowerCase()}`,
      },
      { home, bundledPi, platform: "win32" },
    );

    const pathKeys = Object.keys(result).filter(
      (key) => key.toUpperCase() === "PATH",
    );
    expect(pathKeys).toEqual(["Path"]);
    expect(result.Path?.split(";")).toEqual([
      userBin,
      localBin,
      npmBin,
      path.join(piTools, "1.6.0"),
      bundledBin,
    ]);
  });
});

describe("findHigherPrecedencePi", () => {
  async function writeExec(file: string, executable = true) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "#!/bin/sh\n", { mode: executable ? 0o755 : 0o644 });
    if (process.platform !== "win32") {
      await chmod(file, executable ? 0o755 : 0o644);
    }
  }

  // Real Windows temp directories contain a drive colon ("C:\"), which collides
  // with the Linux PATH delimiter ":". Windows precedence is tested below.
  it.skipIf(process.platform === "win32")(
    "returns SIMPLEX_PI_PATH (valid or invalid), non-bundled LINGER_PI_PATH, user PATH Pi, ~/.local/bin/pi, and strictly newer harness Pi",
    async () => {
      const root = await makeTempDir("linger-higher-pi-");
      const home = path.join(root, "linger-home");
      const userHome = path.join(root, "user-home");
      const userBin = path.join(root, "user-bin");
      const localBin = path.join(userHome, ".local", "bin");
      const bundledBin = path.join(root, "bundled", "bin");
      const stableBin = path.join(home, "runtime", "bundled-pi", "bin");
      const piTools = path.join(home, "runtime", "harness", "tools", "pi");

      await mkdir(userBin, { recursive: true });
      await mkdir(localBin, { recursive: true });
      await writeExec(path.join(bundledBin, "pi"));
      await writeExec(path.join(stableBin, "pi"));
      await writeExec(path.join(piTools, "1.2.0", "pi"));
      await writeExec(path.join(piTools, "1.5.2", "pi"));

      const bundledPi: BundledPi = {
        binDir: bundledBin,
        executable: path.join(bundledBin, "pi"),
        version: "1.5.2",
      };
      const baseOpts = { home, bundledPi, platform: "linux" as const };

      // Bundled Pi and stable link in PATH/LINGER_PI_PATH, plus <= 1.5.2 harness copies, do not outrank bundled Pi.
      await expect(
        findHigherPrecedencePi(
          {
            HOME: userHome,
            PATH: `${bundledBin}:${stableBin}:${userBin}`,
            LINGER_PI_PATH: path.join(stableBin, "pi"),
          },
          baseOpts,
        ),
      ).resolves.toBeUndefined();
      await expect(
        findHigherPrecedencePi(
          {
            HOME: userHome,
            PATH: userBin,
            LINGER_PI_PATH: path.join(bundledBin, "pi"),
          },
          baseOpts,
        ),
      ).resolves.toBeUndefined();

      // SIMPLEX_PI_PATH always outranks bundled Pi even when pointing to a missing path.
      await expect(
        findHigherPrecedencePi(
          {
            HOME: userHome,
            PATH: "",
            SIMPLEX_PI_PATH: "/nonexistent/custom/pi",
          },
          baseOpts,
        ),
      ).resolves.toBe("/nonexistent/custom/pi");
      const validCustomPi = path.join(root, "custom", "pi");
      await writeExec(validCustomPi);
      await expect(
        findHigherPrecedencePi(
          {
            HOME: userHome,
            PATH: "",
            SIMPLEX_PI_PATH: validCustomPi,
          },
          baseOpts,
        ),
      ).resolves.toBe(validCustomPi);

      // Non-bundled LINGER_PI_PATH outranks bundled Pi.
      await expect(
        findHigherPrecedencePi(
          {
            HOME: userHome,
            PATH: "",
            LINGER_PI_PATH: validCustomPi,
          },
          baseOpts,
        ),
      ).resolves.toBe(validCustomPi);

      // Strictly newer harness Pi outranks bundled Pi.
      await writeExec(path.join(piTools, "1.7.0", "pi"));
      await expect(
        findHigherPrecedencePi({ HOME: userHome, PATH: userBin }, baseOpts),
      ).resolves.toBe(path.join(piTools, "1.7.0", "pi"));

      // ~/.local/bin/pi outranks harness Pi.
      await writeExec(path.join(localBin, "pi"));
      await expect(
        findHigherPrecedencePi({ HOME: userHome, PATH: userBin }, baseOpts),
      ).resolves.toBe(path.join(localBin, "pi"));

      // Non-executable pi in userBin is ignored on POSIX.
      if (process.platform !== "win32") {
        await writeExec(path.join(userBin, "pi"), false);
        await expect(
          findHigherPrecedencePi({ HOME: userHome, PATH: userBin }, baseOpts),
        ).resolves.toBe(path.join(localBin, "pi"));
      }

      // Executable user PATH Pi outranks ~/.local/bin/pi.
      await writeExec(path.join(userBin, "pi"), true);
      await expect(
        findHigherPrecedencePi({ HOME: userHome, PATH: userBin }, baseOpts),
      ).resolves.toBe(path.join(userBin, "pi"));
    },
  );

  it("checks Windows case-insensitive env vars and .cmd/.exe shims", async () => {
    const root = await makeTempDir("linger-higher-pi-win-");
    const home = path.join(root, "linger-home");
    const userHome = path.join(root, "user-home");
    const appData = path.join(userHome, "AppData", "Roaming");
    const npmBin = path.join(appData, "npm");
    const bundledBin = path.join(root, "bundled", "bin");
    await mkdir(npmBin, { recursive: true });
    await mkdir(bundledBin, { recursive: true });

    const bundledPi: BundledPi = {
      binDir: bundledBin,
      executable: path.join(bundledBin, "pi.exe"),
      version: "1.5.2",
    };
    const opts = { home, bundledPi, platform: "win32" as const };

    await expect(
      findHigherPrecedencePi(
        {
          USERPROFILE: userHome,
          AppData: appData,
          Path: bundledBin,
          simplex_pi_path: "C:\\bad\\pi.exe",
        },
        opts,
      ),
    ).resolves.toBe("C:\\bad\\pi.exe");

    await writeFile(path.join(npmBin, "pi.cmd"), "@echo off\r\n");
    await expect(
      findHigherPrecedencePi(
        {
          USERPROFILE: userHome,
          AppData: appData,
          Path: bundledBin,
        },
        opts,
      ),
    ).resolves.toBe(path.join(npmBin, "pi.cmd"));
  });
});

describe("runLocalmodels bundled Pi PATH integration", () => {
  it("appends bundled Pi binDir at the tail of PATH when spawning localmodels", async () => {
    const home = await makeTempDir("linger-bundled-pi-run-");
    await mkdir(path.dirname(regionFile(home)), { recursive: true });
    await writeFile(
      regionFile(home),
      JSON.stringify({
        schema: REGION_SCHEMA,
        region: "global",
        resolved_at: new Date().toISOString(),
        method: "probe",
      }),
    );
    const hash = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const manifest = {
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: "a".repeat(40),
      python: "python/python",
      moduleDir: "modules",
      assets: {
        "python/python": hash("python"),
        "modules/localmodels/__init__.py": hash("package"),
      },
    };
    const body = JSON.stringify(manifest);
    const source = {
      url: "https://example.com/tool.tgz",
      sha256: "b".repeat(64),
      bytes: 100,
      manifestSha256: hash(body),
      sourceCommit: "a".repeat(40),
    };
    const directory = path.join(home, "tools", "localmodels", source.sha256);
    await mkdir(path.join(directory, "python"), { recursive: true });
    await mkdir(path.join(directory, "modules", "localmodels"), {
      recursive: true,
    });
    await writeFile(path.join(directory, "tool.json"), body, { mode: 0o600 });
    await writeFile(path.join(directory, "python", "python"), "python", {
      mode: 0o700,
    });
    await writeFile(
      path.join(directory, "modules", "localmodels", "__init__.py"),
      "package",
    );
    vi.stubEnv("LINGER_LOCALMODELS_TOOL_JSON", JSON.stringify(source));

    const bundledBin = path.join(home, "bundled-pi-bin");
    const bundledPi: BundledPi = {
      binDir: bundledBin,
      executable: path.join(
        bundledBin,
        process.platform === "win32" ? "pi.exe" : "pi",
      ),
      version: "1.5.2",
    };

    const run = vi.fn(async () => ({ code: 0, stdout: "{}", stderr: "" }));
    await runLocalmodels(
      home,
      ["harness", "apply", "plan", "--jsonl"],
      { bundledPi },
      { run },
    );

    expect(run).toHaveBeenCalledTimes(1);
    const passedEnv = (
      run.mock.calls[0] as unknown as [
        string,
        string[],
        { env: NodeJS.ProcessEnv },
      ]
    )[2].env;
    const pathKey = Object.keys(passedEnv).find(
      (key) => key.toUpperCase() === "PATH",
    );
    expect(pathKey).toBeDefined();
    const entries = passedEnv[pathKey!]!.split(path.delimiter);
    if (process.platform === "win32") {
      expect(entries.at(-1)).toBe(bundledBin);
    } else {
      const stableBin = path.join(home, "runtime", "bundled-pi", "bin");
      expect(entries.at(-1)).toBe(stableBin);
      expect(await readlink(path.join(stableBin, "pi"))).toBe(
        bundledPi.executable,
      );
    }
    expect(passedEnv.SIMPLEX_PI_PATH).toBeUndefined();
  });
});
