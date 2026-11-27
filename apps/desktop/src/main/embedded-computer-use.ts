import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { restartDelay } from "./computer-daemon.js";
import type { ModuleContext } from "./modules.js";

// The packager preserves the vendor signature on this standalone entry. Resolve
// it in the running bundle on every launch, including retries after an update.
async function installedDriver(
  resources: string,
  signal: AbortSignal,
): Promise<string> {
  const executable = path.join(
    realpathSync(resources),
    "cli/computer-tools/cua/cua-driver",
  );
  if (realpathSync(executable) !== executable)
    throw new Error("Cua driver outside its installed location");
  await promisify(execFile)(
    "/usr/bin/codesign",
    [
      "--verify",
      "--strict",
      '-R=identifier "cua-driver" and anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "YCK386LBJ7"',
      executable,
    ],
    { env: {}, timeout: 30_000, signal },
  );
  return executable;
}

export class EmbeddedComputerUse {
  #directory?: string;
  #child?: ChildProcess;
  #closed?: Promise<void>;
  #retry?: NodeJS.Timeout;
  readonly #lifetime = new AbortController();

  get stopped(): boolean {
    return this.#lifetime.signal.aborted;
  }
  #failures = 0;

  constructor(
    readonly resources: string,
    readonly selected: () => boolean = () => true,
  ) {}

  get socket(): string {
    if (!this.#directory)
      throw new Error("Embedded Cua has no private directory");
    return path.join(this.#directory, "driver.sock");
  }

  async start(ctx: ModuleContext): Promise<void> {
    if (!this.#canLaunch()) return;
    this.#directory = mkdtempSync("/tmp/linger-host-");
    await this.#launch(ctx);
  }

  // Called only before spawning or after the previous child has closed.
  #canLaunch(): boolean {
    if (this.stopped) return false;
    if (this.selected()) return true;
    this.#lifetime.abort();
    if (this.#directory)
      rmSync(this.#directory, { recursive: true, force: true });
    return false;
  }

  async #launch(ctx: ModuleContext): Promise<void> {
    const retry = (reason: string) => {
      if (!this.#canLaunch()) return;
      const delay = restartDelay(++this.#failures);
      ctx.log.warn("embedded_cua.restart", { reason, restart_in_ms: delay });
      this.#retry = setTimeout(() => void this.#launch(ctx), delay);
    };
    try {
      if (!this.#canLaunch()) return;
      const executable = await installedDriver(
        this.resources,
        this.#lifetime.signal,
      );
      if (!this.#canLaunch()) return;
      const socket = this.socket;
      const pidFile = path.join(this.#directory!, "driver.pid");
      // The previous child has closed. A forced exit can leave its files.
      rmSync(socket, { force: true });
      rmSync(pidFile, { force: true });
      const child = spawn(
        executable,
        ["serve", "--embedded", "--socket", socket, "--pid-file", pidFile],
        {
          env: {
            CUA_DRIVER_PARENT_LIVENESS_STDIN: "1",
            CUA_DRIVER_EMBEDDED: "1",
            HOME: os.homedir(),
            PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
            CUA_TELEMETRY_ENABLED: "false",
            CUA_DRIVER_RS_UPDATE_CHECK: "0",
            CUA_DRIVER_WINDOW_CHANGE_TIMEOUT_MS: "0",
          },
          windowsHide: true,
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      this.#child = child;
      child.stdin.on("error", () => {});
      const started = Date.now();
      let reason: string | undefined;
      child.once("error", (error) => {
        reason = error.message;
      });
      this.#closed = new Promise((resolve) =>
        child.once("close", (code, signal) => {
          this.#child = undefined;
          if (Date.now() - started >= 60_000) this.#failures = 0;
          retry(reason ?? String(signal ?? code));
          resolve();
        }),
      );
      // Let the dependent Computer daemon bind on its first attempt.
      while (this.#child === child && !this.stopped) {
        const probe = createConnection(socket);
        try {
          await once(probe, "connect");
          return;
        } catch {
          if (Date.now() - started >= 5000) {
            reason = "Cua socket readiness timed out";
            await this.#stopChild();
            return;
          }
        } finally {
          probe.destroy();
        }
        await delay(50);
      }
    } catch (error) {
      retry(String(error));
    }
  }

  async #stopChild(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    const kill = setTimeout(() => child.kill("SIGKILL"), 1500);
    try {
      child.stdin?.end();
      await this.#closed;
    } finally {
      clearTimeout(kill);
    }
  }

  async stop(): Promise<void> {
    this.#lifetime.abort();
    clearTimeout(this.#retry);
    await this.#stopChild();
    if (this.#directory)
      rmSync(this.#directory, { recursive: true, force: true });
  }
}
