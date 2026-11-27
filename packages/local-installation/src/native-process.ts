import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { atomicPrivate, privateDirectory, readPrivate } from "./instance.js";
import { linuxNodeFdHygieneArgs } from "./native-process-fds.js";
import { runProcess, windowsTreeTermination } from "./process.js";
import {
  darwinBirthInCLocale,
  legacyDarwinIdentity,
  linuxProcessStates,
  nativeProcessIdentity as observed,
  nativeLeaseProcesses,
  posixLivePids,
  windowsLeaseTree,
  windowsProcesses,
  windowsSnapshot,
  type WindowsProcess,
  type WindowsSnapshot,
} from "./native-process-identity.js";

export type NativeService =
  | "postgres"
  | "livekit"
  | "teamhub"
  | "node-services"
  | "web";
const services = new Set([
  "postgres",
  "livekit",
  "teamhub",
  "node-services",
  "web",
]);
interface Lease {
  schemaVersion: 1;
  name: NativeService;
  pid: number;
  birth: string;
  lease: string;
  configuration: string;
}
export interface NativeProcessState {
  running: boolean;
  pid?: number;
}
const leaseKey = "LINGER_NATIVE_PROCESS_LEASE";
/**
 * How the supervisor restarts a service that exits without being asked to:
 * after `delaysMs[n - 1]` for the n-th exit within `windowMs` (the last
 * delay repeats), giving up at the `limit`-th. A service that exits before
 * it has run for `armAfterMs` is not restarted: that is a startup failure,
 * which the installer reports.
 */
export interface NativeRestartPolicy {
  delaysMs: number[];
  windowMs: number;
  limit: number;
  armAfterMs: number;
}
export const SERVICE_RESTART_POLICY: NativeRestartPolicy = {
  delaysMs: [1_000, 2_000, 5_000],
  windowMs: 60_000,
  limit: 5,
  armAfterMs: 10_000,
};
function paths(root: string, name: NativeService) {
  if (!services.has(name)) throw new Error("Invalid native service");
  return {
    record: path.join(root, "native", "processes", `${name}.json`),
    log: path.join(root, "native", "logs", `${name}.log`),
  };
}
/**
 * Written before every intended stop signals a supervisor, which reads it
 * before each restart; the name derives from its job file
 * (`<name>.<lease>.job`), which the supervisor knows.
 */
function stopRequest(root: string, name: NativeService, lease: string) {
  return path.join(root, "native", "processes", `${name}.${lease}.stop`);
}
// Only its presence counts, so appending nothing inside the private processes
// directory is enough: it changes no file a link could point at, and skips
// the ACL check a private write costs on Windows.
async function requestStop(file: string) {
  await writeFile(file, "", { flag: "a", mode: 0o600 });
}
async function stored(
  root: string,
  name: NativeService,
): Promise<Lease | undefined> {
  const text = await readPrivate(paths(root, name).record);
  if (!text) return;
  const record = JSON.parse(text) as Lease;
  if (
    record.schemaVersion !== 1 ||
    record.name !== name ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 2 ||
    typeof record.birth !== "string" ||
    !record.birth ||
    !/^[a-f0-9]{64}$/.test(record.lease) ||
    !/^[a-f0-9]{64}$/.test(record.configuration)
  )
    throw new Error("Invalid native process identity record");
  if (process.platform === "darwin" && !darwinBirthInCLocale(record.birth))
    return adoptLegacyDarwinBirth(root, name, record);
  return record;
}
/**
 * Linger 0.1.2 recorded a macOS birth with lstart in the locale it ran in;
 * every check now reads it in the C locale, so a service it started in, for
 * example, a German region format never matched again. When ps in this
 * process's own locale still prints the recorded birth for the live leader
 * holding the lease, it is that service: its record takes the C-locale birth,
 * once. Otherwise the record stays as it is and proves nothing.
 */
async function adoptLegacyDarwinBirth(
  root: string,
  name: NativeService,
  record: Lease,
): Promise<Lease> {
  const current = await observed(record.pid, record.lease);
  if (
    !current ||
    (await legacyDarwinIdentity(record.pid, record.lease)) !== record.birth
  )
    return record;
  const converted = { ...record, birth: current };
  await atomicPrivate(paths(root, name).record, JSON.stringify(converted));
  return converted;
}
async function stillLive(pid: number): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      // Windows has no zombies; an exited PID is gone.
    } else if (process.platform === "linux") {
      const info = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
      if (info.slice(info.lastIndexOf(")") + 2).startsWith("Z")) return false;
    } else {
      const state = await runProcess(
        "/bin/ps",
        ["-p", String(pid), "-o", "stat="],
        { timeoutMs: 5_000 },
      );
      if (state.code === 0 && state.stdout.trim().startsWith("Z")) return false;
    }
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") {
      // A PID owned by another user cannot be a native service this user
      // started; ignoring a foreign-UID reused PID avoids locking out resume
      // or stop while never signalling it.
      if (process.platform === "linux") {
        const owner = await stat(`/proc/${pid}`).then(
          (entry) => entry.uid,
          () => undefined,
        );
        if (owner === undefined || owner !== process.getuid?.()) return false;
      }
      return true;
    }
    throw error;
  }
}
async function groupLive(group: number): Promise<boolean> {
  // Windows has no process groups; the leader is the whole group.
  if (process.platform === "win32") return stillLive(group);
  if (process.platform === "linux")
    return (await linuxProcessStates(true)).some(
      (process) => process.group === group && process.state !== "Z",
    );
  const result = await runProcess("/bin/ps", ["-axo", "pid=,pgid=,stat="], {
    timeoutMs: 5_000,
  });
  if (result.code !== 0)
    throw new Error(
      "Native process group could not be inspected; identity record retained.",
    );
  return result.stdout
    .trim()
    .split("\n")
    .some((line) => {
      const [, pgid, state] = line.trim().split(/\s+/);
      return Number(pgid) === group && !state?.startsWith("Z");
    });
}
/** The recorded supervisor and what it started, or nothing when it is gone. */
function recordedTree(
  processes: WindowsProcess[],
  record: Pick<Lease, "pid" | "birth" | "lease">,
): WindowsProcess[] {
  const tree = windowsLeaseTree(processes, record.lease);
  const owner = tree[0];
  return owner?.pid === record.pid &&
    `win32:${owner.pid}:${owner.created}` === record.birth
    ? tree
    : [];
}
/**
 * Whether the recorded supervisor still runs its service. On Windows a
 * supervisor left with no process under it serves nothing, and one from an
 * earlier release may never exit on its own; counting it as running kept
 * every start waiting for a service that was gone.
 */
async function serving(record: Lease): Promise<boolean> {
  if (process.platform !== "win32")
    return (await observed(record.pid, record.lease)) === record.birth;
  return recordedTree(await windowsProcesses(), record).length > 1;
}
export async function inspectNativeProcess(
  root: string,
  name: NativeService,
): Promise<NativeProcessState> {
  const record = await stored(root, name);
  if (!record) return { running: false };
  return { running: await serving(record), pid: record.pid };
}
/**
 * Inspects multiple native services together. On Windows this reuses one
 * process snapshot across all recorded services and skips enumeration when no
 * service has a saved record.
 */
export async function inspectNativeProcesses(
  root: string,
  names: readonly NativeService[],
): Promise<NativeProcessState[]> {
  if (process.platform !== "win32")
    return Promise.all(names.map((name) => inspectNativeProcess(root, name)));
  const records = await Promise.all(names.map((name) => stored(root, name)));
  if (records.every((record) => !record))
    return names.map(() => ({ running: false }));
  const snapshot = await windowsProcesses();
  return records.map((record) =>
    record
      ? {
          running: recordedTree(snapshot, record).length > 1,
          pid: record.pid,
        }
      : { running: false },
  );
}
export interface NativeListener {
  name: NativeService;
  port: number;
}
export interface NativeListenerState {
  running: boolean;
  /**
   * Windows only: the PID of a process outside the service's recorded tree
   * that listens on its port. The service cannot serve there, and a health
   * check on that port reaches the other process.
   */
  foreign?: number;
}
/** Whether each service runs and, on Windows, whether its port is its own. */
export async function inspectNativeListeners(
  root: string,
  listeners: NativeListener[],
): Promise<NativeListenerState[]> {
  if (process.platform !== "win32")
    return Promise.all(
      listeners.map(async ({ name }) => ({
        running: (await inspectNativeProcess(root, name)).running,
      })),
    );
  const snapshot = await windowsSnapshot(
    process.env.SystemRoot ?? "C:\\Windows",
  );
  return Promise.all(
    listeners.map(async ({ name, port }) => {
      const record = await stored(root, name);
      const tree = record ? recordedTree(snapshot.processes, record) : [];
      const owner = snapshot.listeners.get(port);
      return {
        running: tree.length > 1,
        ...(owner !== undefined &&
        !tree.some((candidate) => candidate.pid === owner)
          ? { foreign: owner }
          : {}),
      };
    }),
  );
}
interface NativeConfiguration {
  executable: string;
  args: string[];
  cwd: string;
  /** Stable executable path when two cache layouts run the same binary. */
  configurationExecutable?: string;
  /** Generated configuration the process reads; a change counts as a new configuration. */
  settings?: string;
}
function configurationHash(options: NativeConfiguration): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        executable: options.configurationExecutable ?? options.executable,
        args: options.args,
        cwd: options.cwd,
        settings: options.settings,
      }),
    )
    .digest("hex");
}
/** True only when a recorded, running process would restart for this configuration. */
export async function nativeConfigurationChanged(
  options: NativeConfiguration & { root: string; name: NativeService },
): Promise<boolean> {
  const existing = await stored(options.root, options.name);
  if (!existing || !(await serving(existing))) return false;
  return configurationHash(options) !== existing.configuration;
}
export async function startNativeProcess(
  options: NativeConfiguration & {
    root: string;
    name: NativeService;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    redactions?: string[];
    restartOnConfigurationChange?: boolean;
    /**
     * Windows: start the service from a copy of the supervisor's token with
     * Administrators disabled. The same service either way, so this is not
     * part of the configuration.
     */
    withoutAdministrators?: boolean;
    /**
     * Restart the service when it exits unasked. How it is supervised is not
     * part of the configuration, so a running service keeps its supervisor.
     */
    restartOnExit?: NativeRestartPolicy;
  },
): Promise<NativeProcessState> {
  options.signal?.throwIfAborted();
  const location = paths(options.root, options.name);
  const configuration = configurationHash(options);
  const existing = await stored(options.root, options.name);
  if (existing && (await serving(existing))) {
    if (configuration !== existing.configuration) {
      if (!options.restartOnConfigurationChange)
        throw new Error(
          `Native ${options.name} configuration changed; stop this instance before restarting.`,
        );
      await stopNativeProcess(options.root, options.name);
      return startNativeProcess({
        ...options,
        restartOnConfigurationChange: false,
      });
    }
    return { running: true, pid: existing.pid };
  }
  if (existing && process.platform === "win32") {
    // The lease names the supervisor on its command line, so whatever is
    // still on it, such as a supervisor that outlived its service, is this
    // service's own to end. A recorded PID alone proves nothing on Windows,
    // which reuses PIDs quickly.
    await stopNativeProcess(options.root, options.name);
  } else if (existing) {
    // A supervisor killed with the app (a forced quit, a crash) leaves its
    // service running without it. The unguessable lease in their
    // environment proves those processes are this service's own, so they
    // are ended the way a stop ends them; a PID or group without the lease
    // proves nothing and is never signalled.
    if ((await nativeLeaseProcesses(existing.lease)).length)
      await stopNativeProcess(options.root, options.name);
    else if ((await stillLive(existing.pid)) || (await groupLive(existing.pid)))
      throw new Error(
        `Native ${options.name} process identity cannot be verified; refusing to replace it.`,
      );
    await rm(location.record, { force: true });
    await rm(stopRequest(options.root, options.name, existing.lease), {
      force: true,
    });
  }
  await privateDirectory(path.dirname(location.record));
  await privateDirectory(path.dirname(location.log));
  const lease = randomBytes(32).toString("hex");
  const job = path.join(
    path.dirname(location.record),
    `${options.name}.${lease}.job`,
  );
  // The worker argv contains only a private file path, never service arguments or credentials.
  await atomicPrivate(
    job,
    JSON.stringify({
      name: options.name,
      executable: options.executable,
      args: options.args,
      cwd: options.cwd,
      env: { ...options.env, [leaseKey]: lease },
      ...(options.withoutAdministrators ? { withoutAdministrators: true } : {}),
      ...(options.restartOnExit ? { restart: options.restartOnExit } : {}),
      log: location.log,
      redactions: [
        ...new Set(
          [
            ...(options.redactions ?? []),
            ...Object.entries(options.env)
              .filter(([key]) =>
                /password|passwd|secret|token|api.?key|credential|database_url/i.test(
                  key,
                ),
              )
              .map(([, value]) => value),
          ].filter((value): value is string => Boolean(value)),
        ),
      ],
    }),
  );
  const worker = new URL("./native-process-worker.mjs", import.meta.url);
  if (!existsSync(worker)) {
    await rm(job, { force: true });
    throw new Error(
      "Native process supervisor is missing from this installation.",
    );
  }
  const child = spawn(
    process.execPath,
    [...linuxNodeFdHygieneArgs(), fileURLToPath(worker), job],
    {
      cwd: options.cwd,
      env: {
        [leaseKey]: lease,
        PATH: process.env.PATH,
        // Windows processes cannot load system libraries without it.
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot }
          : {}),
      },
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  let birth: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new Error(`Native ${options.name} supervisor start timed out.`),
          ),
        5_000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", finish);
      child.once("exit", () =>
        finish(new Error(`Native ${options.name} supervisor failed to start.`)),
      );
      child.once("message", (message) =>
        message === "ready"
          ? finish()
          : finish(new Error(`Native ${options.name} failed to start.`)),
      );
    });
    birth = await observed(child.pid!, lease);
    if (!birth)
      throw new Error(`Native ${options.name} identity could not be verified.`);
    const record: Lease = {
      schemaVersion: 1,
      name: options.name,
      pid: child.pid!,
      birth,
      lease,
      configuration,
    };
    await atomicPrivate(location.record, JSON.stringify(record) + "\n");
    child.disconnect();
    child.unref();
    if (options.signal?.aborted) {
      await stopNativeProcess(options.root, options.name);
      options.signal.throwIfAborted();
    }
    return { running: true, pid: child.pid };
  } catch (error) {
    // A failed record write must not leave an unmanageable owned group behind.
    if (process.platform === "win32") {
      await stopWindowsTree(options.name, lease).catch((failure: unknown) => {
        throw new Error(
          `Native ${options.name} failed to stop after identity persistence failed.`,
          { cause: failure },
        );
      });
      if (child.connected) child.disconnect();
      child.unref();
      throw error;
    }
    const deadline = Date.now() + 5_000;
    for (;;) {
      const owned = await nativeLeaseProcesses(lease);
      if (!owned.length) break;
      const descendants = owned.filter(
        (candidate) => candidate.pid !== child.pid,
      );
      for (const candidate of descendants.length ? descendants : owned) {
        await signalLeasedProcess(options.name, candidate, lease, "SIGKILL");
      }
      await delay(20);
      if (Date.now() >= deadline)
        throw new Error(
          `Native ${options.name} failed to stop after identity persistence failed.`,
          { cause: error },
        );
    }
    // When the lease could not be proved, the supervisor this call spawned
    // and has not reaped is still provably its own, and so is the group it
    // leads: end them, or the service keeps its files (postmaster.pid) and
    // ports against every retry.
    await endUnreapedGroup(child);
    if (child.connected) child.disconnect();
    child.unref();
    throw error;
  } finally {
    await rm(job, { force: true });
  }
}

/**
 * Ends the process group a detached child leads while the child is not yet
 * reaped: until then its PID, and so its group, cannot belong to another
 * program.
 */
async function endUnreapedGroup(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  if (child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
    await Promise.race([exited, delay(5_000)]);
  }
  // The leader's exit does not wait for the rest of its group.
  for (let count = 0; count < 50 && (await groupLive(child.pid)); count++) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM") return;
      if (code !== "ESRCH") throw error;
    }
    await delay(100);
  }
}

/**
 * Marks a stop refused because the recorded PID now belongs to another
 * program: none of the service's own processes are left.
 */
export const NATIVE_PROCESS_REPLACED = "NATIVE_PROCESS_REPLACED";
export const NATIVE_PROCESS_IDENTITY_UNVERIFIED =
  "NATIVE_PROCESS_IDENTITY_UNVERIFIED";
export const NATIVE_PROCESS_SIGNAL_DENIED = "NATIVE_PROCESS_SIGNAL_DENIED";

async function signalLeasedProcess(
  name: NativeService,
  candidate: { pid: number; birth: string },
  lease: string,
  signal: NodeJS.Signals,
  record?: Pick<Lease, "pid" | "birth">,
): Promise<void> {
  // Revalidate the birth and unguessable lease immediately before signalling.
  if (
    record &&
    candidate.pid === record.pid &&
    candidate.birth !== record.birth
  )
    return;
  if ((await observed(candidate.pid, lease, false)) !== candidate.birth) return;
  try {
    process.kill(candidate.pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return;
    if (code === "EPERM") {
      // If the process exited and its PID was reused between verification and
      // kill, it is already gone; otherwise report the service and PID clearly.
      if ((await observed(candidate.pid, lease, false)) !== candidate.birth)
        return;
      throw Object.assign(
        new Error(
          `Native ${name} process (PID ${candidate.pid}) could not be signalled with ${signal} (EPERM); stop it manually and retry.`,
        ),
        {
          code: NATIVE_PROCESS_SIGNAL_DENIED,
          pid: candidate.pid,
          cause: error,
        },
      );
    }
    throw error;
  }
}
export async function stopNativeProcess(
  root: string,
  name: NativeService,
  /** How long POSIX descendants get to exit on SIGINT before SIGKILL; tests shorten it. */
  interruptMs = 12_000,
): Promise<void> {
  if (process.platform === "win32") {
    await stopWindowsBatch(root, [name], {});
    return;
  }
  const record = await stored(root, name);
  if (!record) return;
  // Before any signal, so the supervisor never restarts what this ends.
  const request = stopRequest(root, name, record.lease);
  await requestStop(request);
  await stopLease(name, record, interruptMs);
  await rm(paths(root, name).record, { force: true });
  await rm(request, { force: true });
}
export interface StopNativeProcessesOptions {
  signal?: AbortSignal;
  /** How long POSIX descendants get to exit on SIGINT before SIGKILL; tests shorten it. */
  interruptMs?: number;
  /**
   * Invoked in `names` order as each service finishes or fails. On POSIX,
   * `durationMs` is each service's isolated stop time; on Windows batch
   * shutdown (where services stop concurrently across shared snapshots),
   * `durationMs` is cumulative elapsed time from the start of the batch.
   */
  onServiceDone?: (
    name: NativeService,
    durationMs: number,
    error?: unknown,
  ) => void;
}
/**
 * Stops multiple native services in dependency order. POSIX stops services
 * sequentially so each gets its own graceful SIGINT drain. Windows batches
 * snapshot enumeration across all services: record-load failures, Pass 1
 * identity-verification failures, and `.stop` write failures stop before
 * signalling downstream services so they stay untouched; once Pass 1 begins
 * terminating verified services' children in dependency order, a later failure
 * (such as a 12-second deadline timeout or record cleanup error on an earlier
 * service) still surfaces at that earlier service while verified downstream
 * services may already have been terminated.
 */
export async function stopNativeProcesses(
  root: string,
  names: readonly NativeService[],
  options: StopNativeProcessesOptions = {},
): Promise<void> {
  if (process.platform !== "win32") {
    for (const name of names) {
      options.signal?.throwIfAborted();
      const startedAt = Date.now();
      try {
        await stopNativeProcess(root, name, options.interruptMs);
      } catch (error) {
        options.onServiceDone?.(name, Date.now() - startedAt, error);
        throw error;
      }
      options.onServiceDone?.(name, Date.now() - startedAt);
    }
    return;
  }
  await stopWindowsBatch(root, names, options);
}
const STOP_POLL_MS = [20, 40, 80, 100] as const;
const POSIX_LEASE_REFRESH_MS = 500;
const WINDOWS_EXIT_WAIT_MS = 500;
const WINDOWS_SUPERVISOR_SELF_EXIT_WAIT_MS = 150;

function pollDelay(attempt: number): Promise<void> {
  return delay(STOP_POLL_MS[Math.min(attempt, STOP_POLL_MS.length - 1)]);
}

/**
 * macOS and Linux: ends the supervisor holding the lease and everything
 * under it, SIGINT first and SIGKILL for what outlives `interruptMs`.
 */
async function stopLease(
  name: NativeService,
  record: Pick<Lease, "pid" | "birth" | "lease">,
  interruptMs: number,
): Promise<void> {
  const current = await observed(record.pid, record.lease);
  let owned = await nativeLeaseProcesses(record.lease);
  if (current !== record.birth && !owned.length) {
    if ((await stillLive(record.pid)) || (await groupLive(record.pid)))
      throw Object.assign(
        new Error(
          `Native ${name} process identity changed; refusing to signal this PID.`,
        ),
        { code: NATIVE_PROCESS_REPLACED },
      );
    return;
  }
  const signalOwned = (
    candidate: { pid: number; birth: string },
    signal: NodeJS.Signals,
  ) => signalLeasedProcess(name, candidate, record.lease, signal, record);
  const interrupted = new Map<number, string>();
  const deadline = Date.now() + interruptMs;
  let lastRefreshAt = Date.now();
  let tracked: number[] = [];
  let ownedFresh = true;
  for (let attempt = 0; ; attempt++) {
    if (ownedFresh) {
      for (const candidate of owned) {
        if (
          candidate.pid === record.pid ||
          interrupted.get(candidate.pid) === candidate.birth
        )
          continue;
        await signalOwned(candidate, "SIGINT");
        interrupted.set(candidate.pid, candidate.birth);
      }
      tracked = owned
        .filter((candidate) => candidate.pid !== record.pid)
        .map((candidate) => candidate.pid);
      ownedFresh = false;
    }
    if (!tracked.length || Date.now() >= deadline) break;
    await pollDelay(attempt);
    const remaining = await posixLivePids(tracked);
    const now = Date.now();
    // Refresh the full lease list once tracked PIDs exit (to catch newly
    // spawned descendants before concluding drain) or periodically (to catch
    // new descendants and avoid stalling on a reused PID).
    if (
      remaining.size === 0 ||
      now - lastRefreshAt >= POSIX_LEASE_REFRESH_MS ||
      now >= deadline
    ) {
      owned = await nativeLeaseProcesses(record.lease);
      lastRefreshAt = Date.now();
      ownedFresh = true;
    } else {
      tracked = [...remaining];
    }
  }
  // Keep the supervisor alive until separate-group descendants are reclaimed.
  const forceDeadline = Date.now() + 5_000;
  while (owned.some((candidate) => candidate.pid !== record.pid)) {
    const forced: number[] = [];
    for (const candidate of owned) {
      if (candidate.pid === record.pid) continue;
      await signalOwned(candidate, "SIGKILL");
      forced.push(candidate.pid);
    }
    const waitDeadline = Math.min(
      forceDeadline,
      Date.now() + POSIX_LEASE_REFRESH_MS,
    );
    let active = forced;
    for (let poll = 0; ; poll++) {
      await pollDelay(poll);
      const remaining = await posixLivePids(active);
      if (remaining.size === 0 || Date.now() >= waitDeadline) break;
      active = [...remaining];
    }
    owned = await nativeLeaseProcesses(record.lease);
    if (
      Date.now() >= forceDeadline &&
      owned.some((candidate) => candidate.pid !== record.pid)
    )
      throw new Error(
        `Native ${name} still has live descendants; identity record retained.`,
      );
  }
  const owner = owned.find((candidate) => candidate.pid === record.pid);
  if (owner) {
    await signalOwned(owner, "SIGKILL");
    // Wait briefly for the supervisor itself to exit before the full lease and
    // process-group check so the first confirmation scan settles immediately.
    const ownerDeadline = Date.now() + POSIX_LEASE_REFRESH_MS;
    for (let poll = 0; Date.now() < ownerDeadline; poll++) {
      if (!(await stillLive(record.pid))) break;
      await pollDelay(poll);
    }
  }
  // A supervisor that checked for the stop request just before it was
  // written may have restarted its service since the last listing; with the
  // supervisor gone nothing restarts it again.
  let settled = false;
  for (let count = 0; count < 30; count++) {
    let liveInGroup: boolean;
    [owned, liveInGroup] = await Promise.all([
      nativeLeaseProcesses(record.lease),
      groupLive(record.pid),
    ]);
    if (!owned.length && !liveInGroup) {
      settled = true;
      break;
    }
    for (const candidate of owned) await signalOwned(candidate, "SIGKILL");
    await pollDelay(count);
  }
  if (!settled) {
    const [liveInGroup, remainingOwned] = await Promise.all([
      groupLive(record.pid),
      nativeLeaseProcesses(record.lease),
    ]);
    if (liveInGroup || remainingOwned.length)
      throw new Error(`Native ${name} did not stop; identity record retained.`);
  }
}

function terminate(pid: number) {
  try {
    // Windows has no signals: every kill is TerminateProcess.
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function terminateBestEffort(pids: readonly number[]) {
  for (const pid of pids) {
    try {
      terminate(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  }
}
/**
 * Polls Windows PID liveness with `process.kill(pid, 0)` until every PID exits
 * or the bounded wait window / overall deadline expires. Tight bounding ensures
 * an immediately reused PID never stalls shutdown.
 */
async function waitWindowsPidsExited(
  pids: readonly number[],
  maxWaitMs: number,
  deadline: number,
): Promise<boolean> {
  let pending = [...new Set(pids)];
  if (!pending.length) return true;
  const waitUntil = Math.min(deadline, Date.now() + maxWaitMs);
  for (let attempt = 0; ; attempt++) {
    const alive: number[] = [];
    for (const pid of pending) {
      if (await stillLive(pid)) alive.push(pid);
    }
    if (!alive.length) return true;
    const remaining = waitUntil - Date.now();
    if (remaining <= 0) return false;
    pending = alive;
    await delay(
      Math.min(
        STOP_POLL_MS[Math.min(attempt, STOP_POLL_MS.length - 1)]!,
        remaining,
      ),
    );
  }
}
/** Deepest first, so that no process loses the parent that links it here. */
export function windowsTerminationOrder(tree: WindowsProcess[]): number[] {
  return tree.map((candidate) => candidate.pid).reverse();
}
function inspectWindowsStopEntry(
  snapshot: WindowsProcess[],
  lease: string,
  record: Pick<Lease, "pid" | "birth">,
) {
  const tree = windowsLeaseTree(snapshot, lease);
  const unverified =
    tree[0]?.pid !== record.pid
      ? snapshot.find(
          ({ pid, created }) =>
            pid === record.pid && `win32:${pid}:${created}` === record.birth,
        )
      : undefined;
  return { snapshot, tree, unverified };
}
function toError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new Error(String(error), { cause: error });
}

async function windowsStopSnapshot(
  name: NativeService,
  lease: string,
  record: Pick<Lease, "pid" | "birth">,
): Promise<{ snapshot: WindowsProcess[]; tree: WindowsProcess[] }> {
  let current = inspectWindowsStopEntry(
    await windowsProcesses(),
    lease,
    record,
  );
  // If a process exits during CIM enumeration, its PID and birth can still
  // appear in that snapshot even though its command line could not be read.
  // A fresh snapshot distinguishes that from a live, unverifiable process.
  if (current.unverified?.command === "")
    current = inspectWindowsStopEntry(await windowsProcesses(), lease, record);
  if (current.unverified) {
    throw Object.assign(
      new Error(
        `Native ${name} process identity cannot be verified; identity record retained.`,
      ),
      { code: NATIVE_PROCESS_IDENTITY_UNVERIFIED },
    );
  }
  return current;
}

/**
 * Ends an unrecorded supervisor holding `lease` and everything under it
 * (startup rollback after failed identity persistence). Windows links a child
 * only through its parent's PID, so each pass ends one snapshot's processes
 * leaves first; the supervisor, whose command line carries the lease that
 * finds the tree, goes only once nothing is left under it.
 */
async function stopWindowsTree(name: NativeService, lease: string) {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const tree = windowsLeaseTree(await windowsProcesses(), lease);
    if (!tree.length) return;
    if (Date.now() >= deadline) throw new Error(`Native ${name} did not stop.`);
    const order = windowsTerminationOrder(tree);
    if (tree.length > 1) {
      const children = order.slice(0, -1);
      terminateBestEffort(children);
      const childrenExited = await waitWindowsPidsExited(
        children,
        WINDOWS_EXIT_WAIT_MS,
        deadline,
      );
      if (childrenExited) {
        await waitWindowsPidsExited(
          [tree[0]!.pid],
          WINDOWS_SUPERVISOR_SELF_EXIT_WAIT_MS,
          deadline,
        );
      }
    } else {
      terminateBestEffort(order);
      await waitWindowsPidsExited(order, WINDOWS_EXIT_WAIT_MS, deadline);
    }
  }
}

interface WindowsBatchEntry {
  name: NativeService;
  record?: Lease;
  request?: string;
  stopWritten: boolean;
  done: boolean;
  error?: Error;
  finishedAt?: number;
}

async function readWindowsBatchSnapshot(
  active: readonly (WindowsBatchEntry & { record: Lease })[],
): Promise<{
  snapshot: WindowsProcess[];
  inspected: Map<WindowsBatchEntry, ReturnType<typeof inspectWindowsStopEntry>>;
}> {
  const retriedEmpty = new Set<WindowsBatchEntry>();
  for (;;) {
    const snapshot = await windowsProcesses();
    const inspected = new Map(
      active.map((entry) => [
        entry,
        inspectWindowsStopEntry(snapshot, entry.record.lease, entry.record),
      ]),
    );
    // If any recorded process exited mid-CIM enumeration, its PID and birth
    // can appear once without a command line; give each entry its own retry
    // so staggered exits across services never starve one another.
    const needsRetry = active.filter(
      (entry) =>
        inspected.get(entry)!.unverified?.command === "" &&
        !retriedEmpty.has(entry),
    );
    if (!needsRetry.length) return { snapshot, inspected };
    for (const entry of needsRetry) retriedEmpty.add(entry);
  }
}

async function stopWindowsBatch(
  root: string,
  names: readonly NativeService[],
  options: StopNativeProcessesOptions,
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!names.length) return;
  const batchStartedAt = Date.now();
  const entries: WindowsBatchEntry[] = await Promise.all(
    names.map(async (name): Promise<WindowsBatchEntry> => {
      try {
        const record = await stored(root, name);
        return {
          name,
          record,
          request: record ? stopRequest(root, name, record.lease) : undefined,
          stopWritten: false,
          done: !record,
          ...(record ? {} : { finishedAt: Date.now() }),
        };
      } catch (error) {
        return {
          name,
          stopWritten: false,
          done: false,
          error: toError(error),
          finishedAt: Date.now(),
        };
      }
    }),
  );

  let reportedIndex = 0;
  let reportedFailure = false;
  const flushReported = () => {
    while (reportedIndex < entries.length) {
      const entry = entries[reportedIndex]!;
      if (entry.error !== undefined) {
        const elapsed = Math.max(
          0,
          (entry.finishedAt ?? Date.now()) - batchStartedAt,
        );
        reportedIndex += 1;
        reportedFailure = true;
        options.onServiceDone?.(entry.name, elapsed, entry.error);
        throw entry.error;
      }
      if (!entry.done) break;
      const elapsed = Math.max(
        0,
        (entry.finishedAt ?? Date.now()) - batchStartedAt,
      );
      reportedIndex += 1;
      options.onServiceDone?.(entry.name, elapsed);
    }
  };

  // Stop before the first record that failed to load so downstream services
  // stay untouched until earlier ones finish and the failure surfaces.
  const firstLoadErrorIndex = entries.findIndex(
    (entry) => entry.error !== undefined,
  );
  let limit = firstLoadErrorIndex >= 0 ? firstLoadErrorIndex : entries.length;

  const removeEntryFiles = async (
    entry: WindowsBatchEntry & { record: Lease },
  ) => {
    try {
      await rm(paths(root, entry.name).record, { force: true });
      await rm(entry.request!, { force: true });
      entry.done = true;
      entry.finishedAt = Date.now();
    } catch (error) {
      entry.error = toError(error);
      entry.finishedAt = Date.now();
      limit = Math.min(limit, entries.indexOf(entry));
    }
  };

  flushReported();

  const hasPendingRecords = () =>
    entries
      .slice(0, limit)
      .some((entry) => !entry.done && entry.record !== undefined);

  if (!hasPendingRecords()) {
    flushReported();
    return;
  }

  const deadline = batchStartedAt + 12_000;
  try {
    for (;;) {
      options.signal?.throwIfAborted();
      const active = entries
        .slice(0, limit)
        .filter(
          (entry): entry is WindowsBatchEntry & { record: Lease } =>
            !entry.done && entry.record !== undefined,
        );
      if (!active.length) break;

      const { snapshot, inspected } = await readWindowsBatchSnapshot(active);

      // Truncate at the first service that fails identity verification so
      // earlier services finish and the error surfaces at that service; on
      // Pass 1 this leaves it and all downstream services untouched.
      for (let index = 0; index < limit; index++) {
        const entry = entries[index]!;
        if (entry.done || !entry.record) continue;
        const result = inspected.get(entry)!;
        if (result.unverified) {
          entry.error = Object.assign(
            new Error(
              `Native ${entry.name} process identity cannot be verified; identity record retained.`,
            ),
            { code: NATIVE_PROCESS_IDENTITY_UNVERIFIED },
          );
          entry.finishedAt = Date.now();
          limit = index;
          break;
        }
      }

      const cleared: Array<WindowsBatchEntry & { record: Lease }> = [];
      for (const entry of entries.slice(0, limit)) {
        if (entry.done || !entry.record) continue;
        const result = inspected.get(entry)!;
        if (!result.tree.length)
          cleared.push(entry as WindowsBatchEntry & { record: Lease });
      }

      if (cleared.length) {
        await Promise.all(cleared.map(removeEntryFiles));
      }

      flushReported();
      let remaining = entries
        .slice(0, limit)
        .filter(
          (entry): entry is WindowsBatchEntry & { record: Lease } =>
            !entry.done && entry.record !== undefined,
        );
      if (!remaining.length) break;

      // Write `.stop` request files before terminating any process (including
      // deadline `taskkill`) so no supervisor can restart its service during
      // batch shutdown. Sequential writes stop before downstream services if a
      // `.stop` write fails.
      const freshlyStopped = new Set<WindowsBatchEntry>();
      for (const entry of remaining) {
        if (entry.stopWritten) continue;
        try {
          await requestStop(entry.request!);
          entry.stopWritten = true;
          freshlyStopped.add(entry);
        } catch (error) {
          entry.error = toError(error);
          entry.finishedAt = Date.now();
          limit = Math.min(limit, entries.indexOf(entry));
          break;
        }
      }
      flushReported();
      remaining = remaining.filter((entry) => entries.indexOf(entry) < limit);
      if (!remaining.length) break;

      if (Date.now() >= deadline) {
        for (const [index, entry] of remaining.entries()) {
          options.signal?.throwIfAborted();
          let targetSnapshot: WindowsProcess[];
          if (index === 0 && !freshlyStopped.has(entry)) {
            targetSnapshot = snapshot;
          } else {
            // Re-read a fresh snapshot before targeting any subsequent service
            // (a prior `endRecordedTree` can take up to 18s, during which PIDs
            // can exit and be reused) or any entry whose `.stop` file was just
            // written after `snapshot` was captured.
            let fresh: { snapshot: WindowsProcess[]; tree: WindowsProcess[] };
            try {
              fresh = await windowsStopSnapshot(
                entry.name,
                entry.record.lease,
                entry.record,
              );
            } catch (error) {
              entry.error = toError(error);
              entry.finishedAt = Date.now();
              limit = Math.min(limit, entries.indexOf(entry));
              break;
            }
            if (!fresh.tree.length) {
              await removeEntryFiles(entry);
              flushReported();
              if (entry.error !== undefined) break;
              continue;
            }
            targetSnapshot = fresh.snapshot;
          }
          let stopped: boolean;
          try {
            stopped = await endRecordedTree(
              entry.name,
              entry.record,
              targetSnapshot,
            );
          } catch (error) {
            entry.error = toError(error);
            entry.finishedAt = Date.now();
            limit = Math.min(limit, entries.indexOf(entry));
            break;
          }
          if (stopped) {
            await removeEntryFiles(entry);
            flushReported();
            if (entry.error !== undefined) break;
          } else {
            entry.error = new Error(
              `Native ${entry.name} did not stop; identity record retained.`,
            );
            entry.finishedAt = Date.now();
            limit = Math.min(limit, entries.indexOf(entry));
            break;
          }
        }
        break;
      }

      const terminatedChildren: number[] = [];
      const supervisorsToWait: number[] = [];
      const terminatedSupervisors: number[] = [];
      for (const entry of remaining) {
        const tree = inspected.get(entry)!.tree;
        const order = windowsTerminationOrder(tree);
        try {
          if (tree.length > 1) {
            const children = order.slice(0, -1);
            terminateBestEffort(children);
            terminatedChildren.push(...children);
            supervisorsToWait.push(tree[0]!.pid);
          } else if (!freshlyStopped.has(entry)) {
            // Only terminate a supervisor-only tree after a post-`.stop`
            // snapshot confirms no child was spawned before `.stop` existed.
            terminateBestEffort(order);
            terminatedSupervisors.push(...order);
          }
        } catch (error) {
          entry.error = toError(error);
          entry.finishedAt = Date.now();
          limit = Math.min(limit, entries.indexOf(entry));
          break;
        }
      }

      const terminatedAll = [...terminatedChildren, ...terminatedSupervisors];
      if (terminatedAll.length) {
        const allTerminatedExited = await waitWindowsPidsExited(
          terminatedAll,
          WINDOWS_EXIT_WAIT_MS,
          deadline,
        );
        if (supervisorsToWait.length > 0 && allTerminatedExited) {
          await waitWindowsPidsExited(
            supervisorsToWait,
            WINDOWS_SUPERVISOR_SELF_EXIT_WAIT_MS,
            deadline,
          );
        }
      }
    }
  } catch (error) {
    if (reportedFailure || options.signal?.aborted) throw error;
    flushReported();
    const failed = entries[reportedIndex];
    if (failed) {
      failed.error = toError(error);
      failed.finishedAt = Date.now();
      flushReported();
    }
    throw error;
  }

  flushReported();
}

/**
 * Last resort when TerminateProcess left part of the tree alive: taskkill /T
 * ends what Windows still links to the supervisor. Only a supervisor whose
 * PID and creation time match the record in this very snapshot is targeted,
 * so a PID Windows has handed to another program is never touched. True when
 * nothing under the lease is left afterwards.
 */
async function endRecordedTree(
  name: NativeService,
  record: Pick<Lease, "pid" | "birth" | "lease">,
  snapshot: WindowsProcess[],
): Promise<boolean> {
  const owner = recordedTree(snapshot, record)[0];
  if (!owner) return false;
  const invocation = windowsTreeTermination({
    pid: owner.pid,
    exitCode: null,
    signalCode: null,
  });
  if (!invocation) return false;
  await runProcess(invocation.command, invocation.args, {
    timeoutMs: 15_000,
  }).catch(() => undefined);
  const deadline = Date.now() + 3_000;
  for (;;) {
    const { tree } = await windowsStopSnapshot(name, record.lease, record);
    if (!tree.length) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

const SUPERVISOR = "native-process-worker.mjs";
const comparable = (value: string) => value.replaceAll("/", "\\").toLowerCase();
/**
 * What Windows must end before this instance's services start: processes an
 * earlier run started and lost track of. Each is proved this instance's own
 * by its command line, never by a program name alone:
 * - a supervisor whose job file is in this instance's process directory but
 *   whose service is gone or whose lease no record holds any more;
 * - a process listening on one of this instance's ports that runs from one
 *   of this installation's folders yet belongs to no recorded service, with
 *   its wrappers up to its supervisor (a stop of an earlier release ended
 *   the supervisor and left TeamHub, web and node-services running).
 * The result lists PIDs in the order to end them, deepest first.
 */
export function windowsOrphans(
  snapshot: WindowsSnapshot,
  records: Array<Pick<Lease, "pid" | "birth" | "lease">>,
  options: { root: string; ports: number[]; paths: string[]; self: number },
): number[] {
  const { processes } = snapshot;
  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const owned = new Set<number>();
  const leases = new Set<string>();
  for (const record of records) {
    const tree = recordedTree(processes, record);
    if (tree.length < 2) continue;
    leases.add(record.lease);
    for (const entry of tree) owned.add(entry.pid);
  }
  // This process and the ones that started it are never ended.
  const keep = new Set<number>();
  for (
    let entry = byPid.get(options.self);
    entry && !keep.has(entry.pid);
    entry = byPid.get(entry.parent)
  )
    keep.add(entry.pid);
  const children = (parent: WindowsProcess) =>
    processes.filter(
      (entry) => entry.parent === parent.pid && entry.created >= parent.created,
    );
  const order: number[] = [];
  const end = (top: WindowsProcess) => {
    const tree = [top];
    for (let index = 0; index < tree.length; index++)
      for (const child of children(tree[index]!))
        if (!tree.includes(child)) tree.push(child);
    for (const pid of windowsTerminationOrder(tree))
      if (!order.includes(pid) && !owned.has(pid) && !keep.has(pid))
        order.push(pid);
  };
  const jobs =
    comparable(path.join(options.root, "native", "processes")) + "\\";
  for (const entry of processes) {
    const command = comparable(entry.command);
    if (!command.includes(SUPERVISOR) || !command.includes(jobs)) continue;
    const lease = /\.([a-f0-9]{64})\.job\b/.exec(command)?.[1];
    if (lease && !leases.has(lease)) end(entry);
  }
  const folders = options.paths.map((folder) => comparable(folder) + "\\");
  const ours = (entry: WindowsProcess) =>
    !keep.has(entry.pid) &&
    folders.some((folder) => comparable(entry.command).includes(folder));
  for (const port of options.ports) {
    const pid = snapshot.listeners.get(port);
    let top = pid === undefined ? undefined : byPid.get(pid);
    if (!top || owned.has(top.pid) || !ours(top)) continue;
    // A supervisor heads every service tree, at most four links up
    // (node-services: main.js, its supervisor, cmd.exe, source-native.mjs).
    for (
      let depth = 0;
      depth < 4 && !comparable(top.command).includes(SUPERVISOR);
      depth++
    ) {
      const parent = byPid.get(top.parent);
      if (
        !parent ||
        parent.created > top.created ||
        owned.has(parent.pid) ||
        !ours(parent)
      )
        break;
      top = parent;
    }
    end(top);
  }
  return order;
}
/**
 * Ends what `windowsOrphans` finds for this instance on Windows, and what
 * `reclaimUnrecordedLeases` finds on macOS and Linux; nothing elsewhere.
 * Returns the PIDs it ended.
 */
export async function reclaimNativeOrphans(
  root: string,
  options: { ports: number[]; paths: string[] },
): Promise<number[]> {
  const records: Lease[] = [];
  for (const name of services)
    try {
      const record = await stored(root, name as NativeService);
      if (record) records.push(record);
    } catch {
      // A damaged record proves nothing; its supervisor counts as unrecorded.
    }
  if (process.platform !== "win32")
    return reclaimUnrecordedLeases(root, records);
  const ended: number[] = [];
  const deadline = Date.now() + 12_000;
  for (;;) {
    const orphans = windowsOrphans(
      await windowsSnapshot(process.env.SystemRoot ?? "C:\\Windows"),
      records,
      {
        root,
        ...options,
        self: process.pid,
      },
    );
    if (!orphans.length) return ended;
    if (Date.now() >= deadline)
      throw new Error(
        `Processes an earlier Linger started on this computer did not stop (PIDs ${orphans.join(", ")}).`,
      );
    const refused: number[] = [];
    for (const pid of orphans)
      try {
        terminate(pid);
        if (!ended.includes(pid)) ended.push(pid);
      } catch {
        // Such as one started as administrator.
        refused.push(pid);
      }
    if (refused.length === orphans.length)
      throw new Error(
        `Processes an earlier Linger started on this computer could not be ended (PIDs ${refused.join(", ")}). End them in Task Manager, then try again.`,
      );
    await delay(100);
  }
}

/**
 * The ones of `folders` that a running process of this user starts from: its
 * command line names a path inside one. When processes cannot be listed,
 * every folder counts as in use, so nothing a service needs is removed.
 */
export async function foldersInUse(
  folders: readonly string[],
): Promise<Set<string>> {
  let commands: string[];
  try {
    commands =
      process.platform === "win32"
        ? (await windowsProcesses()).map((entry) => entry.command)
        : (await ownCommands()).map((entry) => entry.command);
  } catch {
    return new Set(folders);
  }
  const used = await Promise.all(
    folders.map(async (folder) => {
      // A service may run from the resolved path of a linked folder.
      const names = [folder, await realpath(folder).catch(() => folder)];
      return commands.some((command) =>
        names.some((name) => command.includes(name + path.sep)),
      );
    }),
  );
  return new Set(folders.filter((_, index) => used[index]));
}
/** Each process of this user with its command line (macOS and Linux). */
async function ownCommands(): Promise<Array<{ pid: number; command: string }>> {
  if (process.platform === "linux") {
    const listed = await Promise.all(
      (await linuxProcessStates(true)).map(async ({ pid, state }) => {
        if (state === "Z") return undefined;
        const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
          () => "",
        );
        return { pid, command: command.split("\0").join(" ") };
      }),
    );
    return listed.filter((entry) => entry !== undefined);
  }
  const result = await runProcess("/bin/ps", ["-axo", "pid=,uid=,command="], {
    timeoutMs: 5_000,
  });
  if (result.code !== 0)
    throw new Error("Native processes could not be enumerated.");
  return result.stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match && Number(match[2]) === process.getuid?.()
      ? [{ pid: Number(match[1]), command: match[3]! }]
      : [];
  });
}
/**
 * macOS and Linux: ends the services an earlier attempt started and kept no
 * record of (it failed or was killed before writing one), which otherwise
 * keep their files and ports, such as PostgreSQL's postmaster.pid, against
 * every retry. A supervisor is this instance's own when its command line
 * names a job file in this instance's process directory and its environment
 * carries that job's unguessable lease. Returns the supervisors it ended.
 */
async function reclaimUnrecordedLeases(
  root: string,
  records: Array<Pick<Lease, "lease">>,
): Promise<number[]> {
  const recorded = new Set(records.map((record) => record.lease));
  const jobs = path.join(root, "native", "processes") + path.sep;
  const ended: number[] = [];
  for (const { pid, command } of await ownCommands()) {
    if (!command.includes(SUPERVISOR)) continue;
    const at = command.indexOf(jobs);
    const job =
      at < 0
        ? undefined
        : /^([a-z-]+)\.([a-f0-9]{64})\.job(?:\s|$)/.exec(
            command.slice(at + jobs.length),
          );
    if (!job || !services.has(job[1]!) || recorded.has(job[2]!)) continue;
    const [, name, lease] = job as unknown as [string, NativeService, string];
    const birth = await observed(pid, lease);
    if (!birth) continue;
    const request = stopRequest(root, name, lease);
    await requestStop(request);
    await stopLease(name, { pid, birth, lease }, 12_000);
    await rm(request, { force: true });
    ended.push(pid);
  }
  return ended;
}
