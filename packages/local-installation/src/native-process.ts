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
  /** How long descendants get to exit on SIGINT before SIGKILL; tests shorten it. */
  interruptMs = 12_000,
): Promise<void> {
  const record = await stored(root, name);
  if (!record) return;
  // Before any signal, so the supervisor never restarts what this ends.
  const request = stopRequest(root, name, record.lease);
  await requestStop(request);
  if (process.platform === "win32")
    await stopWindowsTree(name, record.lease, record);
  else await stopLease(name, record, interruptMs);
  await rm(paths(root, name).record, { force: true });
  await rm(request, { force: true });
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
  for (;;) {
    for (const candidate of owned) {
      if (
        candidate.pid === record.pid ||
        interrupted.get(candidate.pid) === candidate.birth
      )
        continue;
      await signalOwned(candidate, "SIGINT");
      interrupted.set(candidate.pid, candidate.birth);
    }
    if (
      !owned.some((candidate) => candidate.pid !== record.pid) ||
      Date.now() >= deadline
    )
      break;
    await delay(100);
    owned = await nativeLeaseProcesses(record.lease);
  }
  // Keep the supervisor alive until separate-group descendants are reclaimed.
  const forceDeadline = Date.now() + 5_000;
  while (owned.some((candidate) => candidate.pid !== record.pid)) {
    for (const candidate of owned)
      if (candidate.pid !== record.pid) await signalOwned(candidate, "SIGKILL");
    await delay(100);
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
  if (owner) await signalOwned(owner, "SIGKILL");
  // A supervisor that checked for the stop request just before it was
  // written may have restarted its service since the last listing; with the
  // supervisor gone nothing restarts it again.
  for (let count = 0; count < 30; count++) {
    owned = await nativeLeaseProcesses(record.lease);
    if (!owned.length && !(await groupLive(record.pid))) break;
    for (const candidate of owned) await signalOwned(candidate, "SIGKILL");
    await delay(100);
  }
  if (
    (await groupLive(record.pid)) ||
    (await nativeLeaseProcesses(record.lease)).length
  )
    throw new Error(`Native ${name} did not stop; identity record retained.`);
}

function terminate(pid: number) {
  try {
    // Windows has no signals: every kill is TerminateProcess.
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
/** Deepest first, so that no process loses the parent that links it here. */
export function windowsTerminationOrder(tree: WindowsProcess[]): number[] {
  return tree.map((candidate) => candidate.pid).reverse();
}
async function windowsStopSnapshot(
  name: NativeService,
  lease: string,
  record?: Pick<Lease, "pid" | "birth">,
): Promise<{ snapshot: WindowsProcess[]; tree: WindowsProcess[] }> {
  const read = async () => {
    const snapshot = await windowsProcesses();
    const tree = windowsLeaseTree(snapshot, lease);
    const unverified =
      record && tree[0]?.pid !== record.pid
        ? snapshot.find(
            ({ pid, created }) =>
              pid === record.pid && `win32:${pid}:${created}` === record.birth,
          )
        : undefined;
    return { snapshot, tree, unverified };
  };
  let current = await read();
  // If a process exits during CIM enumeration, its PID and birth can still
  // appear in that snapshot even though its command line could not be read.
  // A fresh snapshot distinguishes that from a live, unverifiable process.
  if (current.unverified?.command === "") current = await read();
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
 * Ends the supervisor holding the lease and everything under it. Windows
 * links a child only through its parent's PID, so ending a parent first
 * (as the signal loop for process groups does) cut its children off the
 * tree: TeamHub, web and node-services outlived every stop and kept their
 * ports. Each pass ends one snapshot's processes leaves first; the
 * supervisor, whose command line carries the lease that finds the tree, goes
 * only once nothing is left under it.
 */
async function stopWindowsTree(
  name: NativeService,
  lease: string,
  record?: Pick<Lease, "pid" | "birth" | "lease">,
) {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const { snapshot, tree } = await windowsStopSnapshot(name, lease, record);
    if (!tree.length) return;
    if (Date.now() >= deadline) {
      if (record && (await endRecordedTree(name, record, snapshot))) return;
      throw new Error(`Native ${name} did not stop; identity record retained.`);
    }
    const order = windowsTerminationOrder(tree);
    for (const pid of tree.length > 1 ? order.slice(0, -1) : order) {
      try {
        terminate(pid);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      }
    }
    await delay(100);
  }
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
