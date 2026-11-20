import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readSetupChoice } from "./setup-selection.js";
import { privateDirectory } from "./instance.js";
import { runLocalmodels } from "./localmodels-tool.js";
import type { runProcess } from "./process.js";
import { localmodelsFailure } from "./localmodels-failure.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";
import type { PreparationOptions } from "./dependencies.js";

export type NativeRuntime = "codex" | "claude" | "pi";
export type RuntimePreparationOptions = Omit<PreparationOptions, "dependency">;
export interface RuntimeDependencies {
  run?: typeof runProcess;
  localmodels?: typeof runLocalmodels;
}
export interface RuntimeDescriptor {
  configFingerprint?: string | null;
  computer?: { authFile?: string };
  modelConfig?: { baseUrl: string; model: string; keySaved: boolean };
  environment?: Record<string, string>;
  runtime: NativeRuntime;
  executable: string | null;
  argvPrefix: string[];
  installed: boolean;
  authenticated: boolean;
  authMode: string | null;
  loginCommand: {
    executable: string;
    args: string[];
    env: Record<string, string>;
  } | null;
  deviceLoginCommand?: {
    executable: string;
    args: string[];
    env: Record<string, string>;
  } | null;
}
const root = (home: string) =>
  path.join(path.resolve(home), "runtime", "harness");
const versionFailures: Record<string, string> = {
  RUNTIME_VERSION_TIMEOUT:
    "Runtime version verification timed out after two bounded attempts.",
  RUNTIME_VERSION_EXECUTION_FAILED: "Runtime version executable failed.",
  RUNTIME_VERSION_MISMATCH: "Runtime did not report the approved version.",
};
export function runtimeVersionFailure(
  value: unknown,
): { code: string; message: string } | undefined {
  const code = (value as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(versionFailures, code)
    ? { code, message: versionFailures[code]! }
    : undefined;
}
/**
 * The failures this module reports with their own code: a harness plan
 * refused before anything changed (an unusable SIMPLEX_PI_PATH, a Windows
 * runtime root too long for Pi without long paths), an apply that left the
 * runtime unusable, a Pi that cannot load extensions, and any other
 * localmodels failure.
 */
const runtimeFailures = new Set([
  "RUNTIME_PLAN_REFUSED",
  "RUNTIME_ACTION_FAILED",
  "RUNTIME_EXTENSIONS_FAILED",
  "LOCALMODELS_RUNTIME_UNAVAILABLE",
]);
export function runtimeFailureCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && runtimeFailures.has(code)
    ? code
    : undefined;
}
type LocalmodelsResult = Awaited<ReturnType<typeof runLocalmodels>>;
function unavailable(failed?: {
  args: string[];
  result: LocalmodelsResult;
  onEvent?: (event: InstallerEvent) => void;
}): Error {
  if (failed) {
    try {
      const value = JSON.parse(
        failed.result.stdout.trim().split("\n").at(-1) ?? "",
      );
      const failure =
        value?.schema === "localmodels.harness-error/v1"
          ? runtimeVersionFailure(value)
          : undefined;
      if (failure)
        return Object.assign(new Error(failure.message), {
          code: failure.code,
        });
    } catch {
      /* Non-JSON output is read below as redacted diagnostics. */
    }
    const { code, cause, log } = localmodelsFailure(failed.args, failed.result);
    for (const message of log)
      failed.onEvent?.({ kind: "log", stage: "runtime", message });
    if (code === "RUNTIME_EXTENSIONS_FAILED")
      return Object.assign(
        new Error(
          "Pi cannot load extensions, which Linger needs on every run. If you installed Pi yourself, update or remove it, then try again.",
        ),
        { code },
      );
    if (code === "RUNTIME_ACTION_FAILED") {
      const planned = failed.args[1] === "plan";
      return Object.assign(
        new Error(
          `The localmodels Runtime ${planned ? "plan was refused" : "operation failed"}${cause ? `: ${cause}` : "."}`,
        ),
        { code: planned ? "RUNTIME_PLAN_REFUSED" : code },
      );
    }
    if (cause)
      return Object.assign(
        new Error(`The localmodels Runtime operation failed: ${cause}`),
        { code: "LOCALMODELS_RUNTIME_UNAVAILABLE" },
      );
  }

  return Object.assign(
    new Error(
      "The localmodels Runtime operation is unavailable. Check the verified tool installation and retry.",
    ),
    { code: "LOCALMODELS_RUNTIME_UNAVAILABLE" },
  );
}
function isRuntimeDescriptor(value: unknown): value is RuntimeDescriptor {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<RuntimeDescriptor>;
  return (
    typeof row.runtime === "string" &&
    ["codex", "claude", "pi"].includes(row.runtime) &&
    typeof row.installed === "boolean" &&
    typeof row.authenticated === "boolean" &&
    Array.isArray(row.argvPrefix)
  );
}
function parseRuntimeDescriptors(
  stdout: string,
): RuntimeDescriptor[] | undefined {
  const line = stdout.trim().split("\n").at(-1)?.trim();
  if (!line) return undefined;
  let value: { schema?: unknown; runtimes?: unknown };
  try {
    value = JSON.parse(line) as { schema?: unknown; runtimes?: unknown };
  } catch {
    return undefined;
  }
  if (
    value?.schema !== "localmodels.harness-status/v1" ||
    !Array.isArray(value.runtimes) ||
    !value.runtimes.every(isRuntimeDescriptor)
  )
    return undefined;
  return value.runtimes;
}
function inspectionFromDescriptor(
  runtime: NativeRuntime,
  row: RuntimeDescriptor,
  platform?: NodeJS.Platform,
): RuntimeInspection {
  const targetPlatform = platform ?? process.platform;
  const quote = (value: string) =>
    targetPlatform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", "'\\''")}'`;
  const login = row.loginCommand;
  return {
    runtime,
    executable: row.executable ?? runtime,
    installed: row.installed,
    ready: row.authenticated,
    loginCommand: login
      ? `${targetPlatform === "win32" ? "& " : ""}${[login.executable, ...login.args].map(quote).join(" ")}`
      : "",
    ...(login
      ? {}
      : {
          loginInstructions:
            "Choose an API provider and enter its key in Linger.",
        }),
    descriptor: row,
  };
}
export async function inspectRuntimeDescriptors(
  home: string,
  options: {
    signal?: AbortSignal;
    env?: NodeJS.ProcessEnv;
    runtime?: NativeRuntime;
  } = {},
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeDescriptor[]> {
  options.signal?.throwIfAborted();
  try {
    const result = await (dependencies.localmodels ?? runLocalmodels)(
      home,
      [
        "harness",
        "status",
        "--root",
        root(home),
        ...(options.runtime ? ["--runtime", options.runtime] : []),
        "--json",
      ],
      { signal: options.signal, env: options.env, timeoutMs: 120000 },
    );
    options.signal?.throwIfAborted();
    if (result.code !== 0)
      throw unavailable({ args: ["harness", "status"], result });
    const runtimes = parseRuntimeDescriptors(result.stdout);
    if (!runtimes) throw unavailable();
    return runtimes;
  } catch (error) {
    options.signal?.throwIfAborted();
    if ((error as { code?: string })?.code === "COMMAND_TIMEOUT") throw error;
    const failure = runtimeVersionFailure(error);
    if (failure)
      throw Object.assign(new Error(failure.message), { code: failure.code });
    if (error instanceof Error && runtimeFailureCode(error)) throw error;
    throw unavailable();
  }
}
/** Only the instance's chosen Harness is an explicit Computer binding. */
export async function inspectSelectedRuntimeDescriptors(
  home: string,
  instanceRoot: string,
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeDescriptor[]> {
  const choice = await readSetupChoice({ root: instanceRoot });
  if (!choice || choice === "local-models") return [];
  const rows = await inspectRuntimeDescriptors(
    home,
    { runtime: choice },
    dependencies,
  );
  return rows.filter((row) => row.runtime === choice);
}
export function runtimeEnvironmentFromDescriptors(
  descriptors: RuntimeDescriptor[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const row of descriptors) {
    for (const key of [
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
    ]) {
      if (row.environment?.[key] !== undefined) env[key] = row.environment[key];
    }
    const key = `LINGER_${row.runtime.toUpperCase()}_PATH`;
    if (row.installed && row.executable) {
      if (row.argvPrefix.length)
        throw new Error(
          "The upstream Runtime descriptor requires arguments unsupported by Computer.",
        );
      env[key] = row.executable;
    }
  }
  return env;
}
/** Upstream owns artifact locks, discovery, install strategy, verification and publication. */
export async function installNativeRuntime(
  runtime: NativeRuntime,
  options: RuntimePreparationOptions,
  dependencies: RuntimeDependencies = {},
): Promise<InstallOutcome> {
  options.signal.throwIfAborted();
  const tool = dependencies.localmodels ?? runLocalmodels;
  const plans = path.join(path.resolve(options.home), "setup", "harness-plans");
  await privateDirectory(plans);
  options.signal.throwIfAborted();
  const temporary = await realpath(await mkdtemp(path.join(plans, "plan-")));
  try {
    await privateDirectory(temporary);
    const file = path.join(temporary, "plan.json");
    const planned = await tool(
      options.home,
      [
        "harness",
        "plan",
        "--runtime",
        runtime,
        "--root",
        root(options.home),
        "--node",
        process.execPath,
        "--out",
        file,
        "--json",
      ],
      {
        signal: options.signal,
        env: options.env,
        timeoutMs: 120000,
        onEvent: options.onEvent,
      },
    );
    if (planned.code !== 0)
      throw unavailable({
        args: ["harness", "plan"],
        result: planned,
        onEvent: options.onEvent,
      });
    const plan = JSON.parse(await readFile(file, "utf8")) as {
      schema: string;
      id: string;
      runtime: string;
    };
    if (
      plan.schema !== "localmodels.harness-plan/v1" ||
      plan.runtime !== runtime ||
      !/^[a-f0-9]{64}$/.test(plan.id)
    )
      throw unavailable();
    const apply = async () => {
      options.signal.throwIfAborted();
      const applied = await tool(
        options.home,
        ["harness", "apply", file, "--approve", plan.id, "--jsonl"],
        {
          signal: options.signal,
          env: options.env,
          timeoutMs: 20 * 60000,
          onEvent: options.onEvent,
        },
      );
      if (applied.code !== 0)
        throw unavailable({
          args: ["harness", "apply"],
          result: applied,
          onEvent: options.onEvent,
        });
      return applied;
    };
    let applied: LocalmodelsResult;
    try {
      applied = await apply();
    } catch (error) {
      // On Windows the kit's version probe right after unpacking can fail
      // to spawn the fresh executable (antivirus still holds it), which it
      // reports as an execution failure. One later attempt usually succeeds;
      // it downloads again because the kit discards its stage on failure.
      if (
        (options.platform ?? process.platform) !== "win32" ||
        options.signal.aborted ||
        (error as { code?: string })?.code !==
          "RUNTIME_VERSION_EXECUTION_FAILED"
      )
        throw error;
      options.onEvent?.({
        kind: "log",
        stage: "runtime",
        message: `The ${runtime} version check failed right after install; retrying once.\n`,
      });
      await delay(3_000, undefined, { signal: options.signal });
      applied = await apply();
    }
    // `localmodels harness apply --jsonl` prints the post-install
    // localmodels.harness-status/v1 document as its final stdout line.
    // Reusing it avoids a redundant status invocation right after apply.
    const appliedRow = parseRuntimeDescriptors(applied.stdout)?.find(
      (item) => item.runtime === runtime,
    );
    const state = appliedRow
      ? inspectionFromDescriptor(runtime, appliedRow, options.platform)
      : await inspectRuntime(runtime, options, dependencies);
    if (!state.installed) throw unavailable();
    return {
      code: 0,
      state: "ready",
      message: `${runtime} is installed. Authentication will be checked separately.`,
      details: { executable: state.executable, descriptor: state.descriptor },
    };
  } catch (error) {
    options.signal.throwIfAborted();
    if ((error as { code?: string })?.code === "COMMAND_TIMEOUT") throw error;
    const failure = runtimeVersionFailure(error);
    if (failure)
      throw Object.assign(new Error(failure.message), { code: failure.code });
    if (error instanceof Error && runtimeFailureCode(error)) throw error;
    throw unavailable();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export interface RuntimeInspection {
  runtime: NativeRuntime;
  executable: string;
  installed: boolean;
  ready: boolean;
  loginCommand: string;
  loginInstructions?: string;
  descriptor: RuntimeDescriptor;
}
export async function inspectRuntime(
  runtime: NativeRuntime,
  options: Omit<RuntimePreparationOptions, "onEvent">,
  dependencies: RuntimeDependencies = {},
): Promise<RuntimeInspection> {
  const rows = await inspectRuntimeDescriptors(
    options.home,
    { signal: options.signal, env: options.env, runtime },
    dependencies,
  );
  const row = rows.find((item) => item.runtime === runtime);
  if (!row) throw unavailable();
  return inspectionFromDescriptor(runtime, row, options.platform);
}
export async function prepareRuntime(
  runtime: NativeRuntime,
  options: RuntimePreparationOptions & {
    reuseInstalled?: boolean;
    onDescriptor?: (descriptor: RuntimeDescriptor) => void;
  },
  dependencies: RuntimeDependencies = {},
): Promise<InstallOutcome> {
  let state: RuntimeInspection | undefined;
  let fallbackEnv = options.env;
  if (options.reuseInstalled) {
    try {
      const existing = await inspectRuntime(runtime, options, dependencies);
      if (existing.installed) {
        options.onEvent({
          kind: "log",
          stage: "runtime",
          message: `Reusing the installed ${runtime} runtime.\n`,
        });
        state = existing;
      } else if (!fallbackEnv) {
        fallbackEnv = runtimeEnvironmentFromDescriptors([existing.descriptor]);
      }
    } catch (error) {
      if (options.signal.aborted) throw error;
    }
  }
  if (!state) {
    const { prepareDependencies } = await import("./dependencies.js");
    const installed = await prepareDependencies(
      {
        ...options,
        ...(fallbackEnv ? { env: fallbackEnv } : {}),
        dependency: runtime,
      },
      dependencies,
    );
    if (installed.code !== 0) return installed;
    const details = installed.details as { descriptor?: unknown } | undefined;
    state =
      isRuntimeDescriptor(details?.descriptor) &&
      details.descriptor.runtime === runtime
        ? inspectionFromDescriptor(
            runtime,
            details.descriptor,
            options.platform,
          )
        : await inspectRuntime(runtime, options, dependencies);
  }
  options.onDescriptor?.(state.descriptor);
  if (state.ready)
    return {
      code: 0,
      state: "ready",
      message: `${runtime} is installed and authenticated.`,
      details: state,
    };
  const message = `${runtime} requires authentication. Continue in Linger or choose to sign in later; business services remain available.`;
  options.onEvent({
    kind: "stage",
    stage: "runtime",
    state: "waiting_user",
    message,
  });
  return {
    code: 4,
    state: "action_required",
    message,
    details: {
      code: "RUNTIME_AUTH_REQUIRED",
      runtime,
      executable: state.executable,
      loginCommand: state.loginCommand,
      ...(state.loginInstructions
        ? { loginInstructions: state.loginInstructions }
        : {}),
    },
  };
}
