// Watch + auto-restart development runner for Linger Desktop.
// Rebuilds desktop main/preload bundles via esbuild watch, watches installer,
// teamhub-cli, and Go daemon sources incrementally, and restarts Electron on
// every clean build while keeping localmodels checkouts live (zero-restart).
import { spawn } from "node:child_process";
import { existsSync, watch as fsWatch } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { context as esbuildContext } from "esbuild";

import { buildDaemon, daemonFileName } from "./build-daemon.mjs";
import {
  buildInstallerBundle,
  buildTeamhubCli,
  desktopEsbuildConfigs,
} from "./build-steps.mjs";
import {
  classifyWatchEvent,
  DEV_USAGE,
  parseDevArgs,
  resolveDevSession,
} from "./dev-config.mjs";
import {
  computerToolsDirectory,
  stageDesktopComputerTools,
} from "./stage-computer-tools.mjs";

const desktopDir = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(desktopDir, "..", "..");
const require = createRequire(import.meta.url);

function log(message) {
  process.stdout.write(`[desktop-dev] ${message}\n`);
}

function resolveElectronBinary() {
  let binary;
  try {
    binary = require("electron");
  } catch (error) {
    throw new Error(
      `Electron binary is not installed (${error instanceof Error ? error.message : String(error)}). Run: pnpm --filter @linger/desktop electron:install`,
      { cause: error },
    );
  }
  if (typeof binary !== "string" || !existsSync(binary))
    throw new Error(
      `Electron binary is missing at ${String(binary)}. Run: pnpm --filter @linger/desktop electron:install`,
    );
  return binary;
}

async function syncCachedOrRequestedComputerTools(
  hostTarget,
  withComputerTools,
) {
  const bundleDir = computerToolsDirectory(
    hostTarget,
    path.join(desktopDir, "dist"),
  );
  if (!withComputerTools && !existsSync(`${bundleDir}.node.json`)) {
    log(
      "Skipping uncached computer-tools download (daemon runs without browser/CUA tools; pass --with-computer-tools to download).",
    );
    return;
  }
  await stageDesktopComputerTools([hostTarget]);
}

function daemonBinaryPath(hostTarget) {
  return path.join(
    desktopDir,
    "dist",
    "computer",
    hostTarget,
    daemonFileName(hostTarget),
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopChild(child, graceMs = 4_000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once("exit", () => resolve(true));
  });
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const clean = await Promise.race([exited, sleep(graceMs).then(() => false)]);
  if (!clean && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already exited.
    }
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function main() {
  const options = parseDevArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(DEV_USAGE);
    return;
  }

  const session = resolveDevSession(options, { repoRoot, env: process.env });
  if (options.dryRun) {
    const summary = {
      mode: session.mode,
      profile: session.profile,
      userData: session.userData,
      home: session.home,
      serverUrl: session.serverUrl,
      checkout: session.checkout,
      localmodels: session.localmodels,
      debug: session.debug,
      hostTarget: session.hostTarget,
      watch: session.watch,
      reset: session.reset,
      skipDaemon: session.skipDaemon,
      electronArgs: session.electronArgs,
    };
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }

  const electronBinary = resolveElectronBinary();
  const { version } = JSON.parse(
    await readFile(path.join(desktopDir, "package.json"), "utf8"),
  );

  if (session.reset) {
    log(`Resetting isolated profile "${session.profile}"...`);
    await rm(session.userData, { recursive: true, force: true });
    await rm(session.home, { recursive: true, force: true });
  }

  const hostTarget = session.hostTarget;
  const externalDaemon = process.env.LINGER_COMPUTER_DAEMON?.trim();
  const existingDaemon = existsSync(daemonBinaryPath(hostTarget));
  const shouldBuildDaemonInitial =
    !externalDaemon && (!session.skipDaemon || !existingDaemon);

  const allowMissingNativeArchives = session.mode !== "quick-install";

  let readyToRestart = false;
  let shuttingDown = false;
  let restartTimer;
  let electronChild = null;
  let electronRestarting = false;
  let pendingRestart = false;
  let pendingReason = "";

  const startElectron = () => {
    const args = [".", ...session.electronArgs];
    log(`Launching Electron (${session.mode} mode)...`);
    const child = spawn(electronBinary, args, {
      cwd: desktopDir,
      env: session.electronEnv,
      stdio: "inherit",
    });
    electronChild = child;
    child.once("exit", (code, signal) => {
      if (electronChild === child) electronChild = null;
      if (shuttingDown || electronRestarting) return;
      if (!session.watch) {
        process.exitCode = code ?? (signal ? 1 : 0);
        void shutdown();
        return;
      }
      log(
        `Electron exited (${signal ? `signal ${signal}` : `code ${code}`}). Waiting for file changes (press r + Enter to relaunch, q + Enter to quit)...`,
      );
    });
  };

  const restartElectron = async (reason) => {
    if (shuttingDown) return;
    if (electronRestarting) {
      pendingRestart = true;
      pendingReason = reason;
      return;
    }
    electronRestarting = true;
    try {
      do {
        pendingRestart = false;
        const why = pendingReason || reason;
        pendingReason = "";
        if (electronChild) {
          log(`Restarting Electron (${why})...`);
          await stopChild(electronChild);
        } else {
          log(`Starting Electron (${why})...`);
        }
        if (!shuttingDown) startElectron();
      } while (pendingRestart && !shuttingDown);
    } finally {
      electronRestarting = false;
    }
  };

  const scheduleRestart = (reason) => {
    if (!readyToRestart || shuttingDown) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      void restartElectron(reason);
    }, 200);
  };

  const restartPlugin = (label, onInitialBuild) => ({
    name: `desktop-dev-restart-${label}`,
    setup(build) {
      let builds = 0;
      build.onEnd((result) => {
        builds += 1;
        if (builds === 1) {
          onInitialBuild(result);
          return;
        }
        if (!readyToRestart) return;
        if (result.errors.length > 0) {
          log(
            `${label} rebuild failed (${result.errors.length} error(s)); keeping previous window.`,
          );
          return;
        }
        log(`${label} rebuilt.`);
        scheduleRestart(label);
      });
    },
  });

  const esbuildContexts = [];
  const fsWatchers = [];
  let rl;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(restartTimer);
    if (rl) rl.close();
    for (const watcher of fsWatchers) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher close error on exit.
      }
    }
    await Promise.all(
      esbuildContexts.map((ctx) => ctx.dispose().catch(() => undefined)),
    );
    await stopChild(electronChild);
  };

  const onSignal = (signal) => {
    log(`Received ${signal}, shutting down...`);
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  const buildStarted = Date.now();
  log("Running initial build...");
  const configs = desktopEsbuildConfigs({ desktopDir, version });
  const labels = ["main", "preload/index", "preload/shell", "preload/setup"];
  const initialBuildPromises = [];
  const created = await Promise.all(
    configs.map((config, idx) => {
      let resolveInitial;
      let rejectInitial;
      initialBuildPromises.push(
        new Promise((resolve, reject) => {
          resolveInitial = resolve;
          rejectInitial = reject;
        }),
      );
      return esbuildContext({
        ...config,
        plugins: [
          ...(config.plugins ?? []),
          restartPlugin(labels[idx], (result) => {
            if (result.errors.length > 0)
              rejectInitial(
                new Error(
                  `${labels[idx]} initial build failed (${result.errors.length} error(s))`,
                ),
              );
            else resolveInitial();
          }),
        ],
      });
    }),
  );
  esbuildContexts.push(...created);

  await Promise.all([
    session.watch
      ? Promise.all(created.map((ctx) => ctx.watch())).then(() =>
          Promise.all(initialBuildPromises),
        )
      : Promise.all(created.map((ctx) => ctx.rebuild())),
    buildInstallerBundle({
      desktopDir,
      daemonTargets: [hostTarget],
      preserveNativeArchives: true,
      allowMissingNativeArchives,
      log,
    }),
    buildTeamhubCli({ desktopDir, daemonTargets: [hostTarget] }),
    (async () => {
      if (shouldBuildDaemonInitial) {
        await buildDaemon([hostTarget]);
        await syncCachedOrRequestedComputerTools(
          hostTarget,
          session.withComputerTools,
        );
      } else if (externalDaemon) {
        log(
          `Using external daemon from LINGER_COMPUTER_DAEMON=${externalDaemon}`,
        );
      } else {
        log(`Reusing existing Go daemon at ${daemonBinaryPath(hostTarget)}`);
      }
    })(),
  ]);

  log(`Initial build ready in ${Date.now() - buildStarted} ms.`);
  log(`  mode:       ${session.mode}`);
  log(`  profile:    ${session.profile}`);
  log(`  userData:   ${session.userData}`);
  log(`  home:       ${session.home}`);
  if (session.serverUrl)
    log(
      `  server:     ${session.serverUrl} (Web HMR active inside Desktop window)`,
    );
  if (session.checkout) log(`  checkout:   ${session.checkout}`);
  if (session.localmodels)
    log(
      `  localmodels: ${session.localmodels.moduleDir} (${session.localmodels.python}) — Python edits take effect live on next call`,
    );
  if (session.debug) log(`  debug:      LOCALMODELS_DEBUG=${session.debug}`);

  if (session.watch) {
    readyToRestart = true;

    const inFlight = new Map();
    const pending = new Set();
    const timers = new Map();

    const triggerRebuild = (target) => {
      clearTimeout(timers.get(target));
      timers.set(
        target,
        setTimeout(() => {
          void runTargetRebuild(target);
        }, 250),
      );
    };

    const runTargetRebuild = async (target) => {
      if (shuttingDown) return;
      if (inFlight.get(target)) {
        pending.add(target);
        return;
      }
      inFlight.set(target, true);
      try {
        do {
          pending.delete(target);
          const started = Date.now();
          log(`Rebuilding ${target}...`);
          try {
            if (target === "installer") {
              await buildInstallerBundle({
                desktopDir,
                daemonTargets: [hostTarget],
                preserveNativeArchives: true,
                allowMissingNativeArchives,
                log,
              });
            } else if (target === "teamhub-cli") {
              await buildTeamhubCli({
                desktopDir,
                daemonTargets: [hostTarget],
              });
            } else if (target === "daemon") {
              await buildDaemon([hostTarget]);
              await syncCachedOrRequestedComputerTools(
                hostTarget,
                session.withComputerTools,
              );
            }
            log(`${target} rebuilt in ${Date.now() - started} ms.`);
            scheduleRestart(target);
          } catch (error) {
            log(
              `${target} rebuild failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        } while (pending.has(target) && !shuttingDown);
      } finally {
        inFlight.set(target, false);
      }
    };

    const watchDirs = [
      {
        area: "installer",
        dir: path.join(repoRoot, "apps", "linger-installer", "src"),
      },
      {
        area: "installer",
        dir: path.join(repoRoot, "packages", "local-installation", "src"),
      },
      {
        area: "teamhub-cli",
        dir: path.join(repoRoot, "apps", "teamhub-cli", "src"),
      },
      ...(!session.skipDaemon && !externalDaemon
        ? [
            {
              area: "daemon",
              dir: path.join(repoRoot, "apps", "computer", "local-daemon"),
            },
          ]
        : []),
    ];

    for (const { area, dir } of watchDirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = fsWatch(dir, { recursive: true }, (_event, file) => {
          const target = classifyWatchEvent(area, file);
          if (target) triggerRebuild(target);
        });
        fsWatchers.push(watcher);
      } catch (error) {
        log(
          `Warning: could not watch ${path.relative(repoRoot, dir)} (${error instanceof Error ? error.message : String(error)}).`,
        );
      }
    }

    if (process.stdin.isTTY) {
      log("Shortcuts: r + Enter to restart Electron, q + Enter to quit.");
      rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const cmd = line.trim().toLowerCase();
        if (cmd === "r" || cmd === "rs" || cmd === "restart") {
          void restartElectron("manual");
        } else if (cmd === "q" || cmd === "quit" || cmd === "exit") {
          void shutdown().finally(() => process.exit(0));
        }
      });
    }
  }

  startElectron();
}

main().catch((error) => {
  process.stderr.write(
    `[desktop-dev] ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
