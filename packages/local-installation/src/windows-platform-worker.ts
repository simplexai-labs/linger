import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolveDaemonExecutable } from "@linger/local-installation/daemon-executable";

// Keep intra-package imports on the package self-reference because
// native-process-worker.mjs imports native-process-identity.ts directly.
const LEASE_ENV_KEY = "LINGER_NATIVE_PROCESS_LEASE";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_MS = 5_000;

export interface GoProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly created: string;
  readonly name: string;
  readonly command: string;
}

export interface GoListenerEntry {
  readonly port: number;
  readonly pid: number;
  readonly address: string;
}

export interface GoProcessSnapshot {
  readonly processes: GoProcessEntry[];
  readonly listeners?: GoListenerEntry[];
}

export interface GoPrivateValidationFailure {
  readonly code: string;
  readonly ancestor?: string;
  readonly sid?: string;
  readonly stage?: string;
  readonly errorType?: string;
  readonly hresult?: string;
}

export interface GoValidatePrivatePathResult {
  readonly ok: boolean;
  readonly failure?: GoPrivateValidationFailure;
}

export type WindowsPlatformCallResult<T> =
  | { readonly kind: "ok"; readonly result: T }
  | { readonly kind: "unavailable"; readonly reason: string };

interface Refable {
  ref?(): unknown;
  unref?(): unknown;
}

export interface PlatformWorkerProcess extends Refable {
  stdin: NodeJS.WritableStream & Refable & { end(): void };
  stdout: NodeJS.ReadableStream & Refable;
  kill(): void;
  on(
    event: "close",
    listener: (code?: number | null, signal?: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error?: Error) => void): unknown;
}

export interface WindowsPlatformWorkerOptions {
  readonly resolveExecutable?: (explicitPath?: string) => string | null;
  readonly spawnWorker?: (executable: string) => PlatformWorkerProcess;
  readonly timeoutMs?: number;
  readonly idleMs?: number;
}

interface RawWorkerEnvelope {
  readonly ok?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface WorkerInstance {
  readonly executable: string;
  readonly child: PlatformWorkerProcess;
  readonly lines: ReturnType<typeof createInterface>;
  readonly onExit: () => void;
  sawValidReply: boolean;
  closedIntentionally: boolean;
  timedOut: boolean;
  pending?: {
    readonly action: string;
    readonly resolve: (result: WindowsPlatformCallResult<unknown>) => void;
  };
}

function setWorkerRef(child: PlatformWorkerProcess, active: boolean): void {
  const method = active ? "ref" : "unref";
  child[method]?.();
  child.stdin[method]?.();
  child.stdout[method]?.();
}

function spawnDefaultPlatformWorker(executable: string): PlatformWorkerProcess {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env[LEASE_ENV_KEY];
  return spawn(executable, ["platform", "--worker"], {
    env,
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
}

function defaultResolveExecutable(explicitPath?: string): string | null {
  if (process.platform !== "win32") return null;
  return resolveDaemonExecutable(process.env, explicitPath, "win32");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseProcessSnapshot(value: unknown): GoProcessSnapshot | null {
  if (!isObject(value) || !Array.isArray(value.processes)) return null;
  const processes: GoProcessEntry[] = [];
  for (const row of value.processes) {
    if (!isObject(row)) return null;
    if (typeof row.pid !== "number" || typeof row.ppid !== "number") {
      return null;
    }
    processes.push({
      pid: row.pid,
      ppid: row.ppid,
      created: typeof row.created === "string" ? row.created : "",
      name: typeof row.name === "string" ? row.name : "",
      command: typeof row.command === "string" ? row.command : "",
    });
  }
  let listeners: GoListenerEntry[] | undefined;
  if (value.listeners !== undefined) {
    if (!Array.isArray(value.listeners)) return null;
    listeners = [];
    for (const row of value.listeners) {
      if (
        !isObject(row) ||
        typeof row.port !== "number" ||
        typeof row.pid !== "number" ||
        typeof row.address !== "string"
      ) {
        return null;
      }
      listeners.push({
        port: row.port,
        pid: row.pid,
        address: row.address,
      });
    }
  }
  return listeners !== undefined ? { processes, listeners } : { processes };
}

function parseValidatePrivatePathResult(
  value: unknown,
): GoValidatePrivatePathResult | null {
  if (!isObject(value) || typeof value.ok !== "boolean") return null;
  if (value.ok) return { ok: true };
  if (!isObject(value.failure) || typeof value.failure.code !== "string") {
    return { ok: false, failure: { code: "UNCHECKED" } };
  }
  const f = value.failure;
  const code = typeof f.code === "string" ? f.code : "UNCHECKED";
  const failure: GoPrivateValidationFailure = {
    code,
    ...(typeof f.ancestor === "string" && f.ancestor
      ? { ancestor: f.ancestor }
      : {}),
    ...(typeof f.sid === "string" && f.sid ? { sid: f.sid } : {}),
    ...(typeof f.stage === "string" && f.stage ? { stage: f.stage } : {}),
    ...(typeof f.errorType === "string" && f.errorType
      ? { errorType: f.errorType }
      : {}),
    ...(typeof f.hresult === "string" && f.hresult
      ? { hresult: f.hresult }
      : {}),
  };
  return { ok: false, failure };
}

export interface WindowsPlatformWorkerClient {
  call<T>(
    request: { readonly action: string } & Record<string, unknown>,
    parse: (value: unknown) => T | null,
    timeoutMs?: number,
    daemonExecutable?: string,
  ): Promise<WindowsPlatformCallResult<T>>;
  close(): void;
}

/**
 * Creates a persistent NDJSON client for `linger-computer-daemon.exe platform --worker`.
 * Automatically degrades to `{ kind: "unavailable" }` when the binary is absent,
 * older than the worker protocol, or lacks the requested action.
 */
export function createWindowsPlatformWorkerClient(
  options: WindowsPlatformWorkerOptions = {},
): WindowsPlatformWorkerClient {
  const resolveExecutable =
    options.resolveExecutable ?? defaultResolveExecutable;
  const spawnWorker = options.spawnWorker ?? spawnDefaultPlatformWorker;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;

  let active: WorkerInstance | null = null;
  let idleTimer: NodeJS.Timeout | undefined;
  let tail: Promise<void> = Promise.resolve();
  let inFlight = 0;
  const unsupportedWorker = new Set<string>();
  const unsupportedActions = new Map<string, Set<string>>();

  const clearIdle = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
  };

  const markActionUnsupported = (executable: string, action: string) => {
    let actions = unsupportedActions.get(executable);
    if (!actions) {
      actions = new Set<string>();
      unsupportedActions.set(executable, actions);
    }
    actions.add(action);
  };

  const reset = (
    kill: boolean,
    reason?: string,
    options: {
      readonly intentional?: boolean;
      readonly timedOut?: boolean;
    } = {},
  ) => {
    clearIdle();
    const current = active;
    if (!current) return;
    if (options.intentional) current.closedIntentionally = true;
    if (options.timedOut) current.timedOut = true;
    active = null;
    process.off("exit", current.onExit);
    current.lines.close();
    const pending = current.pending;
    current.pending = undefined;
    try {
      if (kill) current.child.kill();
      else current.child.stdin.end();
    } catch {
      // The worker has already exited.
    }
    pending?.resolve({
      kind: "unavailable",
      reason: reason ?? "worker_closed",
    });
  };

  const scheduleIdle = () => {
    clearIdle();
    if (!active || inFlight > 0) return;
    setWorkerRef(active.child, false);
    idleTimer = setTimeout(
      () => reset(false, undefined, { intentional: true }),
      idleMs,
    );
    idleTimer.unref();
  };

  const ensureWorker = (executable: string): WorkerInstance => {
    if (active && active.executable === executable) {
      setWorkerRef(active.child, true);
      return active;
    }
    if (active) reset(false, undefined, { intentional: true });

    const child = spawnWorker(executable);
    const lines = createInterface({ input: child.stdout });
    const onExit = () => {
      try {
        child.kill();
      } catch {
        // The worker has already exited.
      }
    };
    const instance: WorkerInstance = {
      executable,
      child,
      lines,
      onExit,
      sawValidReply: false,
      closedIntentionally: false,
      timedOut: false,
    };

    child.stdin.on("error", () => {
      if (active === instance) reset(true, "worker_stdin_error");
    });

    lines.on("line", (raw) => {
      const line = raw.trim().replace(/^\ufeff/, "");
      if (!line) return;
      const pending = instance.pending;
      if (!pending) {
        if (active === instance) reset(true, "worker_desync");
        return;
      }
      instance.pending = undefined;
      let parsed: RawWorkerEnvelope;
      try {
        parsed = JSON.parse(line) as RawWorkerEnvelope;
      } catch {
        if (!instance.sawValidReply) unsupportedWorker.add(executable);
        if (active === instance) reset(true, "worker_invalid_json");
        pending.resolve({ kind: "unavailable", reason: "worker_invalid_json" });
        return;
      }
      if (typeof parsed.ok !== "boolean") {
        if (!instance.sawValidReply) unsupportedWorker.add(executable);
        if (active === instance) reset(true, "worker_invalid_envelope");
        pending.resolve({
          kind: "unavailable",
          reason: "worker_invalid_envelope",
        });
        return;
      }
      instance.sawValidReply = true;
      if (!parsed.ok) {
        const message =
          typeof parsed.error === "string" ? parsed.error : "worker_error";
        if (message === "unknown platform action") {
          markActionUnsupported(executable, pending.action);
        }
        pending.resolve({ kind: "unavailable", reason: message });
        return;
      }
      pending.resolve({ kind: "ok", result: parsed.result });
    });

    child.on("close", (code) => {
      // Even when stdin hit EPIPE before close fired (causing reset to clear
      // `active`), an older binary exiting non-zero before producing any valid
      // NDJSON envelope must still be marked unsupported.
      if (
        !instance.sawValidReply &&
        !instance.closedIntentionally &&
        !instance.timedOut
      ) {
        unsupportedWorker.add(executable);
      }
      if (active === instance) {
        reset(
          false,
          typeof code === "number" ? `worker_exit_${code}` : "worker_closed",
        );
      }
    });

    child.on("error", () => {
      if (!instance.sawValidReply && !instance.closedIntentionally) {
        unsupportedWorker.add(executable);
      }
      if (active === instance) {
        reset(true, "worker_spawn_error");
      }
    });

    process.once("exit", onExit);
    active = instance;
    return instance;
  };

  const call = <T>(
    request: { readonly action: string } & Record<string, unknown>,
    parse: (value: unknown) => T | null,
    timeoutMs = defaultTimeoutMs,
    daemonExecutable?: string,
  ): Promise<WindowsPlatformCallResult<T>> => {
    const executable = resolveExecutable(daemonExecutable);
    if (!executable) {
      return Promise.resolve({
        kind: "unavailable",
        reason: "daemon_not_found",
      });
    }
    if (
      unsupportedWorker.has(executable) ||
      unsupportedActions.get(executable)?.has(request.action)
    ) {
      return Promise.resolve({
        kind: "unavailable",
        reason: "daemon_unsupported",
      });
    }

    inFlight += 1;
    clearIdle();
    const payload = JSON.stringify(request);
    const runTask = tail.then(
      () =>
        new Promise<WindowsPlatformCallResult<T>>((resolve) => {
          if (
            unsupportedWorker.has(executable) ||
            unsupportedActions.get(executable)?.has(request.action)
          ) {
            inFlight -= 1;
            scheduleIdle();
            resolve({ kind: "unavailable", reason: "daemon_unsupported" });
            return;
          }
          let instance: WorkerInstance;
          try {
            instance = ensureWorker(executable);
          } catch {
            inFlight -= 1;
            scheduleIdle();
            resolve({ kind: "unavailable", reason: "worker_spawn_error" });
            return;
          }
          let settled = false;
          const finish = (response: WindowsPlatformCallResult<unknown>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            inFlight -= 1;
            scheduleIdle();
            if (response.kind === "unavailable") {
              resolve(response);
              return;
            }
            const parsed = parse(response.result);
            if (parsed === null) {
              if (active === instance) reset(true, "worker_invalid_payload");
              resolve({
                kind: "unavailable",
                reason: "worker_invalid_payload",
              });
              return;
            }
            resolve({ kind: "ok", result: parsed });
          };
          const timer = setTimeout(() => {
            if (active === instance)
              reset(true, "worker_timeout", { timedOut: true });
            finish({ kind: "unavailable", reason: "worker_timeout" });
          }, timeoutMs);
          timer.unref();
          instance.pending = { action: request.action, resolve: finish };
          try {
            instance.child.stdin.write(`${payload}\n`);
          } catch {
            if (active === instance) reset(true, "worker_write_error");
            finish({ kind: "unavailable", reason: "worker_write_error" });
          }
        }),
    );
    tail = runTask.then(
      () => undefined,
      () => undefined,
    );
    return runTask;
  };

  return {
    call,
    close: () => reset(false, undefined, { intentional: true }),
  };
}

const defaultPlatformWorker = createWindowsPlatformWorkerClient();

/** Closes the default persistent Windows Go platform worker if running. */
export function closeWindowsPlatformWorker(): void {
  defaultPlatformWorker.close();
}

/** Queries live Windows processes (and optional IPv4 TCP listeners) via the Go daemon worker. */
export function callWindowsProcessSnapshot(
  includeListeners: boolean,
  timeoutMs = 15_000,
  daemonExecutable?: string,
): Promise<WindowsPlatformCallResult<GoProcessSnapshot>> {
  return defaultPlatformWorker.call(
    { action: "process-snapshot", includeListeners },
    parseProcessSnapshot,
    timeoutMs,
    daemonExecutable,
  );
}

/** Validates or repairs a Windows private file, directory, or location via the Go daemon worker. */
export function callWindowsValidatePrivatePath(
  request: {
    readonly path: string;
    readonly kind: "file" | "directory" | "location";
    readonly repair: boolean;
  },
  timeoutMs = DEFAULT_TIMEOUT_MS,
  daemonExecutable?: string,
): Promise<WindowsPlatformCallResult<GoValidatePrivatePathResult>> {
  return defaultPlatformWorker.call(
    {
      action: "validate-private-path",
      path: request.path,
      kind: request.kind,
      repair: request.repair,
    },
    parseValidatePrivatePathResult,
    timeoutMs,
    daemonExecutable,
  );
}
