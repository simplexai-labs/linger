import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildSync } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { spawnDaemon, type DaemonChild } from "./computer-daemon.js";

// Quit, crash and system-sleep paths of the app-to-daemon link, with real
// processes. The fake daemon behaves like the real one in Desktop mode: it
// reports a status line, runs one runtime in its own process group, and on
// stdin EOF stops that runtime and exits. Windows has no SIGSTOP and cannot
// exec a script; there the daemon's job object ends its runtimes
// (internal/process/job_windows.go) and the stdin EOF path is covered by
// TestDesktopChannelShutsDownOnStdinEOF.

const here = path.dirname(fileURLToPath(import.meta.url));

const FAKE_DAEMON = `#!${process.execPath}
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
const dir = process.env.FAKE_DAEMON_DIR;
const runtime = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
  stdio: "ignore",
});
writeFileSync(dir + "/pids.json", JSON.stringify({ daemon: process.pid, runtime: runtime.pid }));
process.stdout.write(JSON.stringify({ type: "status", connection: "connected" }) + "\\n");
let armed = null;
let graceful = false;
createInterface({ input: process.stdin }).on("line", (raw) => {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === "local_models_stop.arm") {
      armed = msg;
      return;
    }
    if (msg.type === "local_models_stop.disarm") {
      armed = null;
      return;
    }
    if (msg.type === "shutdown") {
      graceful = true;
      return;
    }
  } catch {}
  process.stdout.write(raw + "\\n");
});
process.stdin.on("end", () => {
  if (!graceful && armed) {
    mkdirSync(path.dirname(armed.log_file), { recursive: true });
    const out = openSync(armed.log_file, "w", 0o600);
    const helper = spawn(armed.executable, armed.args, {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, ...armed.env },
    });
    helper.unref();
    closeSync(out);
  }
  runtime.kill("SIGTERM");
  writeFileSync(dir + "/shutdown", "stdin closed");
  process.exit(0);
});
`;

// The app side: the real spawnDaemon, in a process the test can kill.
const APP = (source: string) => `
import { spawnDaemon } from ${JSON.stringify(source)};
const [executable, log, dir, armJson] = process.argv.slice(2);
const child = spawnDaemon(executable, log)("config.json", { FAKE_DAEMON_DIR: dir });
if (armJson) child.write(armJson);
child.onLine((line) => process.stdout.write(line + "\\n"));
setInterval(() => {}, 1000);
`;

interface Pids {
  daemon: number;
  runtime: number;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(
  check: () => boolean,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(process.platform === "win32")(
  "Computer daemon across quit, crash and sleep",
  () => {
    let directory: string;
    let executable: string;
    let appBundle: string;
    const cleanup: (() => void)[] = [];

    beforeAll(() => {
      const build = mkdtempSync(path.join(os.tmpdir(), "daemon-app-"));
      appBundle = path.join(build, "app.mjs");
      buildSync({
        stdin: {
          contents: APP(path.join(here, "computer-daemon.ts")),
          resolveDir: here,
          loader: "ts",
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: appBundle,
        logLevel: "silent",
      });
      return () => rmSync(build, { recursive: true, force: true });
    });

    const setUp = () => {
      directory = mkdtempSync(path.join(os.tmpdir(), "daemon-lifecycle-"));
      executable = path.join(directory, "daemon.mjs");
      writeFileSync(executable, FAKE_DAEMON);
      chmodSync(executable, 0o755);
    };

    const pids = async (): Promise<Pids> => {
      const file = path.join(directory, "pids.json");
      await until(() => existsSync(file), 10_000, "the daemon to start");
      return JSON.parse(readFileSync(file, "utf8")) as Pids;
    };

    const startDaemon = (): DaemonChild => {
      const child = spawnDaemon(
        executable,
        path.join(directory, "logs", "computer-daemon.log"),
      )("config.json", { FAKE_DAEMON_DIR: directory });
      return child;
    };

    const exited = (child: DaemonChild) =>
      new Promise<number | null>((resolve) =>
        child.onExit((code) => resolve(code)),
      );

    afterEach(() => {
      for (const step of cleanup.splice(0)) step();
      rmSync(directory, { recursive: true, force: true });
    });

    it("ends the daemon and its runtime when the app is killed", async () => {
      setUp();
      const app: ChildProcess = spawn(
        process.execPath,
        [
          appBundle,
          executable,
          path.join(directory, "logs", "computer-daemon.log"),
          directory,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      cleanup.push(() => app.kill("SIGKILL"));
      await new Promise<void>((resolve) =>
        app.stdout!.once("data", () => resolve()),
      );
      const { daemon, runtime } = await pids();
      expect(alive(daemon) && alive(runtime)).toBe(true);
      cleanup.push(() => {
        for (const pid of [daemon, runtime])
          if (alive(pid)) process.kill(pid, "SIGKILL");
      });

      // A crash or force quit: no before-quit, no stop(). The OS closes the
      // daemon's stdin, and the daemon is not in the app's process group.
      app.kill("SIGKILL");

      await until(
        () => !alive(daemon) && !alive(runtime),
        5_000,
        "the daemon and its runtime to exit",
      );
      expect(readFileSync(path.join(directory, "shutdown"), "utf8")).toBe(
        "stdin closed",
      );
    });

    it("stops a daemon that was frozen and thawed, as across system sleep", async () => {
      setUp();
      const child = startDaemon();
      const { daemon, runtime } = await pids();
      cleanup.push(() => child.kill());
      const lines: string[] = [];
      child.onLine((line) => lines.push(line));

      process.kill(daemon, "SIGSTOP");
      child.write(JSON.stringify({ type: "probe", n: 1 }));
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(lines).toEqual([]);
      process.kill(daemon, "SIGCONT");
      await until(() => lines.length === 1, 5_000, "the queued line");

      const code = exited(child);
      child.stop();
      expect(await code).toBe(0);
      await until(() => !alive(runtime), 5_000, "the runtime to exit");
    });

    it("kills a daemon still frozen at quit together with its runtimes", async () => {
      setUp();
      const child = startDaemon();
      const { daemon, runtime } = await pids();
      cleanup.push(() => {
        for (const pid of [daemon, runtime])
          if (alive(pid)) process.kill(pid, "SIGKILL");
      });

      // Frozen: stdin EOF cannot be read, so the graceful stop does nothing
      // and ComputerDaemonModule falls back to kill() after its grace period.
      process.kill(daemon, "SIGSTOP");
      const code = exited(child);
      child.stop();
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(daemon)).toBe(true);
      child.kill();

      expect(await code).toBeNull();
      await until(() => !alive(runtime), 5_000, "the runtime to exit");
      expect(existsSync(path.join(directory, "shutdown"))).toBe(false);
    });

    it("launches detached local-models stop on unexpected app SIGKILL and skips it on planned shutdown", async () => {
      setUp();
      const marker = path.join(directory, "stopped.json");
      const logFile = path.join(
        directory,
        "installer",
        "local-models-stop.log",
      );
      const stopScript = path.join(directory, "stop-stub.mjs");
      writeFileSync(
        stopScript,
        `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ argv: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE }));
process.stdout.write('{"failed":[]}\\n');
`,
      );
      const armLine = JSON.stringify({
        type: "local_models_stop.arm",
        executable: process.execPath,
        args: [stopScript, "--home", directory, "--stop-local-models"],
        log_file: logFile,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });

      const app: ChildProcess = spawn(
        process.execPath,
        [
          appBundle,
          executable,
          path.join(directory, "logs", "computer-daemon.log"),
          directory,
          armLine,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      cleanup.push(() => app.kill("SIGKILL"));
      await new Promise<void>((resolve) =>
        app.stdout!.once("data", () => resolve()),
      );
      const { daemon, runtime } = await pids();
      cleanup.push(() => {
        for (const pid of [daemon, runtime])
          if (alive(pid)) process.kill(pid, "SIGKILL");
      });

      // Hard crash: no shutdown line precedes EOF, so the daemon spawns the
      // detached stop helper before exiting.
      app.kill("SIGKILL");
      await until(
        () => !alive(daemon) && !alive(runtime),
        5_000,
        "the daemon and its runtime to exit after crash",
      );
      await until(
        () => existsSync(marker),
        5_000,
        "detached local-models stop helper to run after crash",
      );
      expect(JSON.parse(readFileSync(marker, "utf8"))).toEqual({
        argv: ["--home", directory, "--stop-local-models"],
        runAsNode: "1",
      });
      expect(readFileSync(logFile, "utf8")).toBe('{"failed":[]}\n');

      // Planned update shutdown: sending shutdown before EOF skips crash stop.
      rmSync(marker, { force: true });
      const planned = startDaemon();
      const secondPids = await pids();
      cleanup.push(() => {
        for (const pid of [secondPids.daemon, secondPids.runtime])
          if (alive(pid)) process.kill(pid, "SIGKILL");
      });
      const exitCode = exited(planned);
      planned.write(armLine);
      planned.write(JSON.stringify({ type: "shutdown", reason: "update" }));
      planned.stop();
      expect(await exitCode).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(existsSync(marker)).toBe(false);
    });
  },
);
