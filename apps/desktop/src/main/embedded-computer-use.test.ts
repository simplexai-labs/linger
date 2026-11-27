import { execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import { buildSync } from "esbuild";
import { expect, it, vi } from "vitest";

import { EmbeddedComputerUse } from "./embedded-computer-use.js";
import { tempDirectory, testHost } from "./test-support.js";

it.skipIf(process.platform !== "darwin")(
  "rejects an unsigned installed entry",
  async () => {
    const resources = tempDirectory();
    const executable = path.join(
      resources,
      "cli/computer-tools/cua/cua-driver",
    );
    mkdirSync(path.dirname(executable), { recursive: true });
    const marker = path.join(resources, "executed");
    writeFileSync(executable, `#!/bin/sh\ntouch '${marker}'\n`, {
      mode: 0o700,
    });
    const driver = new EmbeddedComputerUse(resources);
    const host = testHost([]);
    const warn = vi.spyOn(host.ctx.log, "warn");
    try {
      await driver.start(host.ctx);
      expect(warn).toHaveBeenCalledWith(
        "embedded_cua.restart",
        expect.objectContaining({
          reason: expect.stringContaining("codesign"),
        }),
      );
      expect(existsSync(marker)).toBe(false);
    } finally {
      await driver.stop();
      warn.mockRestore();
      rmSync(resources, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "retires a queued retry when the enrollment no longer selects the host",
  async () => {
    const resources = tempDirectory();
    let selected = true;
    const driver = new EmbeddedComputerUse(resources, () => selected);
    const host = testHost([]);
    const warn = vi.spyOn(host.ctx.log, "warn");
    vi.useFakeTimers();
    try {
      await driver.start(host.ctx); // Missing bundle entry schedules one retry.
      const directory = path.dirname(driver.socket);
      expect(warn).toHaveBeenCalledTimes(1);
      selected = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(driver.stopped).toBe(true);
      expect(existsSync(directory)).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      await driver.stop();
      vi.useRealTimers();
      warn.mockRestore();
      rmSync(resources, { recursive: true, force: true });
    }
  },
);

const resources = "/Applications/Linger.app/Contents/Resources";
const installed =
  process.platform === "darwin" &&
  existsSync(path.join(resources, "cli/computer-tools/cua/cua-driver"));

it.skipIf(!installed)(
  "restarts the installed driver and reaps it on host quit or SIGKILL",
  async () => {
    const build = tempDirectory();
    const file = path.join(build, "host.mjs");
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      buildSync({
        stdin: {
          contents: `import { EmbeddedComputerUse } from './embedded-computer-use.ts';
      const driver = new EmbeddedComputerUse(process.argv[2]);
      await driver.start({log: {warn: (...args) => console.error(...args)}});
      process.send(driver.socket);
      process.on('message', async () => { await driver.stop(); process.disconnect(); });`,
          resolveDir: import.meta.dirname,
        },
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: file,
      });
      for (const crash of [false, true]) {
        const secret = "fake-gateway-env-sentinel";
        const host = fork(file, [resources], {
          env: { HOME: process.env.HOME, LINGER_COMPUTER_TOKEN: secret },
          execArgv: [],
          stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        const closed = once(host, "close");
        try {
          const [socket] = (await once(host, "message")) as [string];
          const dir = path.dirname(socket);
          expect(statSync(dir).mode & 0o777).toBe(0o700);
          expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103);
          const ready = async (previous?: number) => {
            let pid = 0;
            await vi.waitFor(
              async () => {
                pid = Number(
                  readFileSync(path.join(dir, "driver.pid"), "utf8").trim(),
                );
                expect(pid).toBeGreaterThan(1);
                expect(pid).not.toBe(previous);
                const client = createConnection(socket);
                try {
                  await once(client, "connect");
                } finally {
                  client.destroy();
                }
              },
              { timeout: 40_000 },
            );
            return pid;
          };
          let pid = await ready();
          expect(
            Number(
              execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], {
                encoding: "utf8",
              }),
            ),
          ).toBe(host.pid);
          expect(
            execFileSync(
              "/bin/ps",
              ["eww", "-p", String(pid), "-o", "command="],
              { encoding: "utf8" },
            ).includes(secret),
          ).toBe(false);
          if (crash) {
            process.kill(pid, "SIGKILL");
            pid = await ready(pid);
            host.kill("SIGKILL");
          } else {
            process.kill(pid, "SIGSTOP");
            host.send("quit");
          }
          await closed;
          await vi.waitFor(
            () => {
              expect(alive(pid)).toBe(false);
              if (!crash) expect(existsSync(dir)).toBe(false);
            },
            { timeout: 5000 },
          );
          if (crash) rmSync(dir, { recursive: true, force: true });
        } finally {
          if (host.exitCode === null && host.signalCode === null)
            host.kill("SIGKILL");
          await closed;
        }
      }
    } finally {
      rmSync(build, { recursive: true, force: true });
    }
  },
  120_000,
);
