// Builds the Go Local Computer daemon that the app runs as its child, into
// dist/computer/<platform>-<arch>/ (Node's names). It reports the Computer
// release of apps/computer, which the Runner Gateway checks.
//
//   node scripts/build-daemon.mjs [--target darwin-arm64 ...] [--all]
//
// Without a target it builds for this machine.
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("../", import.meta.url));
const localDaemon = path.join(desktop, "../computer/local-daemon");
const windowShareSource = path.join(
  desktop,
  "packaging/mac/linger-window-share.swift",
);

// Node platform-arch -> Go GOOS/GOARCH.
export const DAEMON_TARGETS = {
  "darwin-arm64": {
    goos: "darwin",
    goarch: "arm64",
    swiftTarget: "arm64-apple-macos14.0",
  },
  "darwin-x64": {
    goos: "darwin",
    goarch: "amd64",
    swiftTarget: "x86_64-apple-macos14.0",
  },
  "linux-x64": { goos: "linux", goarch: "amd64" },
  "linux-arm64": { goos: "linux", goarch: "arm64" },
  "win32-x64": { goos: "windows", goarch: "amd64" },
};
// The targets CI compiles; packaging builds the one it ships.
const ALL_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];

export const daemonFileName = (target) =>
  target.startsWith("win32-")
    ? "linger-computer-daemon.exe"
    : "linger-computer-daemon";

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(" ")} failed (${code})`)),
    );
  });
}

export const buildDaemon = async (targets) => {
  const { version } = JSON.parse(
    await readFile(path.join(desktop, "../computer/package.json"), "utf8"),
  );
  await rm(path.join(desktop, "dist/computer"), {
    recursive: true,
    force: true,
  });
  await Promise.all(
    targets.map(async (target) => {
      const go = DAEMON_TARGETS[target];
      if (!go) throw new Error(`Unknown daemon target ${target}`);
      const output = path.join(
        desktop,
        "dist/computer",
        target,
        daemonFileName(target),
      );
      await run(
        "go",
        [
          "build",
          "-trimpath",
          "-ldflags",
          `-s -w -X github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/transport.ReleaseVersion=${version}`,
          "-o",
          output,
          "./cmd/linger-computer-daemon",
        ],
        {
          cwd: localDaemon,
          env: {
            ...process.env,
            CGO_ENABLED: "0",
            GOOS: go.goos,
            GOARCH: go.goarch,
          },
        },
      ).catch((error) => {
        if (error?.code === "ENOENT") throw error;
        throw new Error(`Go build of the daemon for ${target} failed`);
      });
      await stageWindowShareHelper(target, go);
    }),
  );
};

async function stageWindowShareHelper(target, go) {
  if (go.goos !== "darwin") return;
  const outputDir = path.join(desktop, "dist/computer", target);
  const output = path.join(outputDir, "linger-window-share");
  const prebuilt = process.env.LINGER_MACOS_WINDOW_SHARE_BIN?.trim();
  if (prebuilt) {
    await mkdir(outputDir, { recursive: true });
    await copyFile(prebuilt, output);
    await chmod(output, 0o755);
    return;
  }
  if (process.platform !== "darwin" || !go.swiftTarget) return;
  await mkdir(outputDir, { recursive: true });
  await run("swiftc", [
    "-O",
    "-target",
    go.swiftTarget,
    windowShareSource,
    "-o",
    output,
  ]);
  await chmod(output, 0o755);
}

export async function buildTeamhubLauncher(target, outputPath) {
  const go = DAEMON_TARGETS[target];
  if (!go) throw new Error(`Unknown daemon target ${target}`);
  const resolvedOutput = path.resolve(outputPath);
  await run(
    "go",
    [
      "build",
      "-trimpath",
      "-buildvcs=false",
      "-ldflags",
      "-s -w",
      "-o",
      resolvedOutput,
      "./cmd/linger-teamhub-launcher",
    ],
    {
      cwd: localDaemon,
      env: {
        ...process.env,
        CGO_ENABLED: "0",
        GOOS: go.goos,
        GOARCH: go.goarch,
      },
    },
  ).catch((error) => {
    if (error?.code === "ENOENT") throw error;
    throw new Error(`Go build of the teamhub launcher for ${target} failed`);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const targets = args.includes("--all")
    ? ALL_TARGETS
    : args.flatMap((arg, index) =>
        args[index - 1] === "--target" ? [arg] : [],
      );
  await buildDaemon(
    targets.length > 0 ? targets : [`${process.platform}-${process.arch}`],
  );
}
