// Persistent owner of one native service group. Only redacted lines reach disk.
import { spawn } from "node:child_process";
import { constants, closeSync, existsSync, writeSync } from "node:fs";
import { open, rm } from "node:fs/promises";
import path from "node:path";
import { lineRedactor } from "./redaction.ts";
import {
  nativeLeaseProcesses,
  nativeProcessIdentity,
} from "./native-process-identity.ts";
import {
  WITHOUT_ADMINISTRATORS_SCRIPT,
  windowsCommandLine,
} from "./windows-restricted-token.ts";

const file = process.argv[2];
// Absent for a service nothing restarts; native-process.ts sets the values.
const validRestart = (policy) =>
  policy === undefined ||
  (Array.isArray(policy.delaysMs) &&
    policy.delaysMs.length > 0 &&
    policy.delaysMs.every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) &&
    [policy.windowMs, policy.limit, policy.armAfterMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ));
/**
 * Ends what an exited service left running under this lease, SIGTERM first
 * and SIGKILL after five seconds, rechecking each process's lease right
 * before signalling it. Windows links descendants only through their
 * parent, so there the exited service's are already out of reach.
 */
async function endLeftovers(lease) {
  if (process.platform === "win32") return;
  const deadline = Date.now() + 7_000;
  for (let signal = "SIGTERM"; ; ) {
    const owned = await nativeLeaseProcesses(lease).catch(() => []);
    if (!owned.length || Date.now() >= deadline) return;
    for (const { pid, birth } of owned)
      if ((await nativeProcessIdentity(pid, lease, false)) === birth)
        try {
          process.kill(pid, signal);
        } catch {
          // Already gone.
        }
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (Date.now() >= deadline - 2_000) signal = "SIGKILL";
  }
}
// Windows reports neither owner nor mode bits; the native directory ACL,
// repaired by privateDirectory, is what keeps these files private there.
const privateOwner = (info) =>
  process.platform === "win32" ||
  (info.uid === process.getuid?.() && !(info.mode & 0o077));
let output;
try {
  const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let job;
  try {
    const info = await input.stat();
    if (!info.isFile() || !privateOwner(info))
      throw new Error("Unsafe native job");
    job = JSON.parse(await input.readFile("utf8"));
  } finally {
    await input.close();
  }
  await rm(file);
  if (
    typeof job.executable !== "string" ||
    !Array.isArray(job.args) ||
    job.args.some((value) => typeof value !== "string") ||
    typeof job.cwd !== "string" ||
    typeof job.log !== "string" ||
    typeof job.name !== "string" ||
    !/^[a-z-]+$/.test(job.name) ||
    !validRestart(job.restart) ||
    !job.env ||
    job.env.LINGER_NATIVE_PROCESS_LEASE !==
      process.env.LINGER_NATIVE_PROCESS_LEASE ||
    !Array.isArray(job.redactions) ||
    ![undefined, true].includes(job.withoutAdministrators)
  )
    throw new Error("Invalid native job");
  output = await open(
    job.log,
    constants.O_CREAT |
      constants.O_APPEND |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  const info = await output.stat();
  if (!info.isFile() || !privateOwner(info))
    throw new Error("Unsafe native log");
  const secrets = job.redactions
    .filter((value) => typeof value === "string" && value.length)
    .sort((a, b) => b.length - a.length);
  let dropped = 0;
  const append = (line) => {
    try {
      if (dropped) {
        writeSync(
          output.fd,
          `[linger-supervisor] ${job.name} could not write ${dropped} log lines\n`,
        );
        dropped = 0;
      }
      writeSync(output.fd, line);
    } catch {
      // Keep draining the pipes and retain the process owner even when disk
      // writes fail, and try again with the next line: a full disk frees up.
      // Never fall back to an unredacted stream or crash here.
      dropped++;
    }
  };
  const streams = [0, 1].map(() =>
    lineRedactor((line) => {
      for (const secret of secrets)
        line = line.replaceAll(secret, "[REDACTED]");
      append(line);
    }),
  );
  // One grep-friendly line per supervisor decision, beside the service's own.
  const note = (text) => append(`[linger-supervisor] ${job.name} ${text}\n`);
  // Stay group leader after the service exits: descendants may still be alive.
  process.on("SIGINT", () => {});
  process.on("SIGTERM", () => {});
  const restricted = job.withoutAdministrators && process.platform === "win32";
  const launch = () => {
    const child = restricted
      ? spawn(
          path.win32.join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe",
          ),
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(WITHOUT_ADMINISTRATORS_SCRIPT, "utf16le").toString(
              "base64",
            ),
          ],
          { cwd: job.cwd, env: job.env, windowsHide: true },
        )
      : spawn(job.executable, job.args, {
          cwd: job.cwd,
          env: job.env,
          // This detached supervisor has no console, so on Windows the service
          // would open a visible one that air, PowerShell and go then share.
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
    const run = {
      child,
      startedAt: Date.now(),
      spawned: new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      }),
      exited: new Promise((resolve) => {
        child.once("error", () => resolve({ code: null, signal: null }));
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
    };
    if (restricted)
      child.stdin.end(
        JSON.stringify(windowsCommandLine(job.executable, job.args)),
      );
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => streams[0].write(chunk));
    child.stderr.on("data", (chunk) => streams[1].write(chunk));
    return run;
  };
  let run = launch();
  await run.spawned;
  process.send?.("ready");
  process.on("disconnect", () => {});
  note(`started pid=${run.child.pid}`);
  const lease = process.env.LINGER_NATIVE_PROCESS_LEASE;
  // The installer writes this file before it signals an intended stop
  // (stopNativeProcess), so an exit it caused is never restarted.
  const stopRequest = file.replace(/\.job$/, ".stop");
  const stopRequested = () => existsSync(stopRequest);
  const policy = job.restart;
  const exits = [];
  let armed = false;
  for (;;) {
    const { code, signal } = await run.exited;
    for (const stream of streams) stream.flush();
    const now = Date.now();
    const exit = `exited code=${code} signal=${signal} uptime_ms=${now - run.startedAt}`;
    // A service that never came up is a startup failure the installer
    // reports; restarts begin once it has run for a while.
    armed ||= !!policy && now - run.startedAt >= policy.armAfterMs;
    let reason;
    if (!policy) reason = "not_supervised";
    else if (stopRequested()) reason = "stop_requested";
    else if (!armed) reason = "startup";
    else {
      exits.push(now);
      while (exits[0] <= now - policy.windowMs) exits.shift();
      if (exits.length >= policy.limit) reason = "crash_loop";
    }
    if (reason) {
      note(`${exit} restart=no reason=${reason}`);
      if (reason === "crash_loop")
        note(
          `gave up restarting after ${exits.length} exits within ${policy.windowMs} ms`,
        );
      break;
    }
    const wait =
      policy.delaysMs[Math.min(exits.length, policy.delaysMs.length) - 1];
    note(`${exit} restarting_in_ms=${wait}`);
    await new Promise((resolve) => setTimeout(resolve, wait));
    // What the exited service started would hold its port and files.
    await endLeftovers(lease);
    if (stopRequested()) {
      note("restart cancelled reason=stop_requested");
      break;
    }
    run = launch();
    try {
      await run.spawned;
      note(`restarted pid=${run.child.pid} attempt=${exits.length}`);
    } catch (error) {
      note(`restart failed error=${error?.code ?? "unknown"}`);
    }
  }
  const check = async () => {
    try {
      // Air and other watchers create new groups. Their inherited lease
      // keeps ownership provable even after their original parent exits.
      if (!(await nativeLeaseProcesses(lease)).length) {
        closeSync(output.fd);
        process.exit(0);
      }
    } catch {
      /* Keep the owner alive when group membership is uncertain. */
    }
    setTimeout(check, 100);
  };
  void check();
} catch {
  process.send?.("failed");
  await output?.close().catch(() => {});
  process.exit(1);
}
