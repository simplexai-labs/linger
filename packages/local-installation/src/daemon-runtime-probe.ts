import {
  isAbsoluteForPlatform,
  resolveDaemonExecutable,
} from "./daemon-executable.js";
import { runProcess } from "./process.js";

export { resolveDaemonExecutable };

export type DaemonProbeRuntimeKind = "codex" | "claude" | "pi" | "antigravity";
export type SetupRuntimeKind = "codex" | "claude" | "pi";
export type DaemonRuntimeStatus =
  | "ready"
  | "authentication_required"
  | "incompatible"
  | "not_installed"
  | "error";

export const DAEMON_RUNTIME_PROBE_SCHEMA = "linger.daemon.runtime-probe/v1";

/**
 * Runtime preference order synchronized with
 * apps/web/src/features/local-computer/computer-readiness.ts (`appOrder`).
 */
export const RUNTIME_PREFERENCE_ORDER: readonly SetupRuntimeKind[] = [
  "claude",
  "codex",
  "pi",
];

export interface DaemonRuntimeObservation {
  readonly type: DaemonProbeRuntimeKind;
  readonly status: DaemonRuntimeStatus;
  readonly installed: boolean;
  readonly authenticated: boolean;
  readonly version?: string;
  readonly requiredVersion?: string;
  readonly executable?: string;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface DaemonRuntimeProbeOptions {
  readonly runtimes?: readonly DaemonProbeRuntimeKind[];
  readonly configuredPaths?: Partial<Record<DaemonProbeRuntimeKind, string>>;
  readonly includeBundled?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly daemonExecutable?: string;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly run?: typeof runProcess;
}

const VALID_RUNTIME_TYPES = new Set<DaemonProbeRuntimeKind>([
  "codex",
  "claude",
  "pi",
  "antigravity",
]);

const VALID_STATUSES = new Set<DaemonRuntimeStatus>([
  "ready",
  "authentication_required",
  "incompatible",
  "not_installed",
  "error",
]);

interface RawProbeEntry {
  type?: unknown;
  status?: unknown;
  installed?: unknown;
  authenticated?: unknown;
  version?: unknown;
  required_version?: unknown;
  executable?: unknown;
  error?: { code?: unknown; message?: unknown } | null;
}

function parseDaemonProbeOutput(
  stdout: string,
): DaemonRuntimeObservation[] | null {
  const line = stdout.trim().split("\n").at(-1)?.trim();
  if (!line) return null;
  let parsed: { schema?: unknown; runtimes?: unknown };
  try {
    parsed = JSON.parse(line) as { schema?: unknown; runtimes?: unknown };
  } catch {
    return null;
  }
  if (
    parsed?.schema !== DAEMON_RUNTIME_PROBE_SCHEMA ||
    !Array.isArray(parsed.runtimes)
  ) {
    return null;
  }
  const results: DaemonRuntimeObservation[] = [];
  for (const raw of parsed.runtimes as RawProbeEntry[]) {
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.type !== "string" ||
      !VALID_RUNTIME_TYPES.has(raw.type as DaemonProbeRuntimeKind) ||
      typeof raw.status !== "string" ||
      !VALID_STATUSES.has(raw.status as DaemonRuntimeStatus) ||
      typeof raw.installed !== "boolean" ||
      typeof raw.authenticated !== "boolean"
    ) {
      return null;
    }
    const error =
      raw.error &&
      typeof raw.error === "object" &&
      typeof raw.error.code === "string" &&
      typeof raw.error.message === "string"
        ? { code: raw.error.code, message: raw.error.message }
        : undefined;
    results.push({
      type: raw.type as DaemonProbeRuntimeKind,
      status: raw.status as DaemonRuntimeStatus,
      installed: raw.installed,
      authenticated: raw.authenticated,
      ...(typeof raw.version === "string" && raw.version
        ? { version: raw.version }
        : {}),
      ...(typeof raw.required_version === "string" && raw.required_version
        ? { requiredVersion: raw.required_version }
        : {}),
      ...(typeof raw.executable === "string" && raw.executable
        ? { executable: raw.executable }
        : {}),
      ...(error ? { error } : {}),
    });
  }
  return results;
}

/**
 * Delegates AI Runtime discovery, minimum-version verification, and
 * authentication probing to `linger-computer-daemon probe-runtimes --json`
 * (the single source of truth shared with the resident daemon).
 * Returns `null` when no daemon executable is available in this environment.
 */
export async function probeRuntimesWithDaemon(
  options: DaemonRuntimeProbeOptions = {},
): Promise<DaemonRuntimeObservation[] | null> {
  options.signal?.throwIfAborted();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const daemon = options.run
    ? (options.daemonExecutable ?? env.LINGER_COMPUTER_DAEMON ?? null)
    : resolveDaemonExecutable(env, options.daemonExecutable, platform);
  if (!daemon) return null;

  const args: string[] = ["probe-runtimes", "--json"];
  if (options.includeBundled === true) {
    args.push("--include-bundled");
  }
  for (const runtime of options.runtimes ?? []) {
    args.push("--runtime", runtime);
  }
  const pathFlags: ReadonlyArray<readonly [DaemonProbeRuntimeKind, string]> = [
    ["codex", "--codex-path"],
    ["claude", "--claude-path"],
    ["pi", "--pi-path"],
    ["antigravity", "--antigravity-path"],
  ];
  for (const [kind, flag] of pathFlags) {
    const configured = options.configuredPaths?.[kind]?.trim();
    if (configured && isAbsoluteForPlatform(configured, platform)) {
      args.push(flag, configured);
    }
  }
  const run = options.run ?? runProcess;
  try {
    const result = await run(daemon, args, {
      env,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 45_000,
    });
    options.signal?.throwIfAborted();
    if (result.code !== 0) return null;
    return parseDaemonProbeOutput(result.stdout);
  } catch (error) {
    options.signal?.throwIfAborted();
    void error;
    return null;
  }
}

/**
 * Picks the recommended non-local runtime from daemon observations using the
 * exact same priority as apps/web/src/features/local-computer/computer-readiness.ts:
 * ready -> authentication_required -> incompatible -> installed -> fallback ("claude"),
 * ordered claude -> codex -> pi.
 */
export function recommendRuntimeFromDaemon(
  observations: readonly DaemonRuntimeObservation[],
  fallback: SetupRuntimeKind = "claude",
): SetupRuntimeKind {
  const byType = new Map(observations.map((entry) => [entry.type, entry]));
  for (const status of [
    "ready",
    "authentication_required",
    "incompatible",
  ] as const) {
    for (const kind of RUNTIME_PREFERENCE_ORDER) {
      if (byType.get(kind)?.status === status) return kind;
    }
  }
  for (const kind of RUNTIME_PREFERENCE_ORDER) {
    if (byType.get(kind)?.installed) return kind;
  }
  return fallback;
}
