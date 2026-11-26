// Headless commands the desktop setup page runs before anything is
// installed: which AI runtimes this computer has and whether they are signed
// in, installing one, its sign-in, the owner's sign-in for the new
// installation, and downloading the planned local model in the background.
// Each writes JSON lines on stdout; secrets arrive on stdin and are never
// written back.
import {
  inspectRuntime,
  inspectRuntimeDescriptors,
  prepareRuntime,
  runtimeEnvironmentFromDescriptors,
  type NativeRuntime,
} from "@linger/local-installation/managed-runtimes";
import type { InstallOutcome } from "@linger/local-installation/events";
import { presetLocalAccount } from "@linger/local-installation/account";
import { instanceRoot } from "@linger/local-installation/instance";
import {
  localmodelsBaseDirectory,
  runLocalmodels,
} from "@linger/local-installation/localmodels-tool";
import { LIBRARY_MODEL_ID } from "@linger/local-installation/setup-plan";
import {
  RuntimeLoginManager,
  type LoginMethod,
  type RuntimeLoginInput,
} from "./runtime-login.js";

export const SETUP_RUNTIMES: readonly NativeRuntime[] = [
  "codex",
  "claude",
  "pi",
];
export function setupRuntime(value: string): NativeRuntime {
  if (!(SETUP_RUNTIMES as readonly string[]).includes(value))
    throw new Error("Invalid runtime.");
  return value as NativeRuntime;
}
export function libraryModel(value: string): string {
  if (value.length > 200 || !LIBRARY_MODEL_ID.test(value))
    throw new Error("Invalid local model.");
  return value;
}
type Line = Record<string, unknown>;
type Write = (line: Line) => void;

export interface SetupRuntimeRow {
  runtime: NativeRuntime;
  installed: boolean;
  // Pi has no sign-in of its own; it is never signed in.
  signedIn: boolean;
  version?: string;
  // The check itself failed; the row is unknown, not missing.
  unknown?: true;
}
/** Each runtime as the computer has it now, through its managed profile. */
export async function runtimeStatus(
  home: string,
  dependencies: { inspect?: typeof inspectRuntime } = {},
): Promise<{ runtimes: SetupRuntimeRow[] }> {
  const inspect = dependencies.inspect ?? inspectRuntime;
  const runtimes = await Promise.all(
    SETUP_RUNTIMES.map(async (runtime): Promise<SetupRuntimeRow> => {
      try {
        const state = await inspect(runtime, {
          home,
          env: process.env,
          signal: AbortSignal.timeout(90_000),
        });
        const version = state.descriptor.version;
        return {
          runtime,
          installed: state.installed,
          signedIn: runtime !== "pi" && state.installed && state.ready,
          ...(typeof version === "string" && version ? { version } : {}),
        };
      } catch {
        return { runtime, installed: false, signedIn: false, unknown: true };
      }
    }),
  );
  return { runtimes };
}

/**
 * Installs one runtime the way an installation does (the harness plan and
 * apply), reusing one already installed. Byte progress goes out as
 * {"event":"progress"} lines, a few a second; the last line is the outcome.
 */
export async function prepareSetupRuntime(
  home: string,
  runtime: NativeRuntime,
  options: {
    signal: AbortSignal;
    write: Write;
    prepare?: typeof prepareRuntime;
  },
): Promise<{ installed: boolean; signedIn: boolean; message?: string }> {
  let sent = 0;
  const outcome = await (options.prepare ?? prepareRuntime)(runtime, {
    home,
    signal: options.signal,
    reuseInstalled: true,
    onEvent: (event) => {
      const progress = event.progress;
      if (event.kind !== "stage" || progress?.unit !== "bytes") return;
      const done = progress.total === progress.completed;
      if (!done && Date.now() - sent < 250) return;
      sent = Date.now();
      options.write({
        event: "progress",
        completed: progress.completed,
        ...(progress.total ? { total: progress.total } : {}),
      });
    },
  }).catch((error: unknown): InstallOutcome => {
    options.signal.throwIfAborted();
    return {
      code: 1,
      state: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  });
  const code = (outcome.details as { code?: unknown } | undefined)?.code;
  const installed = outcome.code === 0 || code === "RUNTIME_AUTH_REQUIRED";
  return {
    installed,
    signedIn: outcome.code === 0 && runtime !== "pi",
    ...(installed ? {} : { message: outcome.message.slice(0, 600) }),
  };
}

/**
 * Runs one runtime's own sign-in before any installation exists. Snapshots
 * go out as lines whenever they change, until it is signed in or ends; each
 * stdin line is a code the vendor's page showed. Aborting stops the login.
 */
export async function setupRuntimeLogin(
  home: string,
  runtime: NativeRuntime,
  options: {
    signal: AbortSignal;
    write: Write;
    codes?: AsyncIterable<string>;
    method?: LoginMethod;
    pollMs?: number;
    manager?: RuntimeLoginManager;
  },
): Promise<void> {
  const manager =
    options.manager ??
    new RuntimeLoginManager(
      inspectRuntime,
      process.platform,
      15 * 60_000,
      async () =>
        runtimeEnvironmentFromDescriptors(
          (await inspectRuntimeDescriptors(home, { runtime })).filter(
            (row) => row.runtime === runtime,
          ),
        ),
    );
  const input: RuntimeLoginInput = {
    instance: "setup",
    home,
    root: home,
    runtime,
  };
  let last = "";
  let ended = false;
  const send = (snapshot: Line) => {
    const text = JSON.stringify(snapshot);
    if (text !== last) options.write(snapshot);
    last = text;
    if (snapshot.state === "ready" || snapshot.state === "failed") ended = true;
  };
  const failed = (error: unknown): Line => ({
    state: "failed",
    reason: "ended",
    message:
      error instanceof Error ? error.message : "Sign-in could not start.",
  });
  const stopped = new Promise<void>((resolve) => {
    if (options.signal.aborted) resolve();
    options.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  try {
    send(
      await manager
        .start(input, undefined, options.method)
        .catch((error: unknown) => failed(error)),
    );
    if (options.codes)
      void (async () => {
        for await (const raw of options.codes!) {
          const code = raw.trim();
          if (!code || ended || options.signal.aborted) continue;
          send(
            await manager
              .start(input, code)
              .catch((error: unknown) => failed(error)),
          );
        }
      })().catch(() => undefined);
    while (!ended && !options.signal.aborted) {
      await Promise.race([
        stopped,
        new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 1500)),
      ]);
      if (options.signal.aborted) break;
      send(
        await manager.status(input).catch((error: unknown) => failed(error)),
      );
    }
  } finally {
    if (!ended) manager.cancel(input.instance);
    manager.close();
  }
}

/**
 * Sets the owner's email and password for the installation about to be
 * created. Read from stdin as JSON; the password is never echoed.
 */
export async function presetOwnerAccount(
  home: string,
  instance: string,
  input: string,
): Promise<{ written: boolean } | { error: string }> {
  try {
    let value: { email?: unknown; password?: unknown };
    try {
      value = JSON.parse(input) as typeof value;
    } catch {
      throw new Error("Invalid sign-in.");
    }
    if (typeof value?.email !== "string" || typeof value.password !== "string")
      throw new Error("Invalid sign-in.");
    return await presetLocalAccount(instanceRoot({ name: instance, home }), {
      email: value.email,
      password: value.password,
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Invalid sign-in.",
    };
  }
}

/**
 * Downloads a model into the model library, as Settings › Models does,
 * without loading it. Progress goes out as {"event":"progress"} lines; the
 * last line is the outcome. A busy library (exit 2) is retried a few times,
 * since an installation that just stopped may still hold it.
 */
export async function downloadLocalModel(
  home: string,
  model: string,
  options: {
    signal: AbortSignal;
    write: Write;
    localmodels?: typeof runLocalmodels;
    retryMs?: number;
  },
): Promise<{ state: "done" | "failed"; code?: string; message?: string }> {
  const invoke = options.localmodels ?? runLocalmodels;
  let sent = 0;
  for (let attempt = 0; ; attempt++) {
    let buffer = "";
    let error: { code?: string; message?: string } | undefined;
    let result = false;
    const line = (text: string) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event?.schema !== "localmodels.library-event/v1") return;
      if (event.event === "progress") {
        const count = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
            ? Math.round(value)
            : undefined;
        const completed = count(event.done);
        const total = count(event.total);
        if (completed === undefined) return;
        if (Date.now() - sent < 500 && completed !== total) return;
        sent = Date.now();
        const rate = count(event.bytes_per_second);
        options.write({
          event: "progress",
          phase: event.phase === "verify" ? "verify" : "download",
          completed,
          ...(total ? { total } : {}),
          ...(rate !== undefined ? { bytesPerSecond: rate } : {}),
        });
      } else if (event.event === "result") {
        result = event.ok !== false;
      } else if (event.event === "error") {
        error = {
          ...(typeof event.code === "string" ? { code: event.code } : {}),
          ...(typeof event.detail === "string"
            ? { message: event.detail.slice(0, 300) }
            : {}),
        };
      }
    };
    const outcome = await invoke(
      home,
      [
        "library",
        "download",
        model,
        "--base-dir",
        localmodelsBaseDirectory(home),
        "--jsonl",
      ],
      {
        signal: options.signal,
        capture: false,
        onOutput: (chunk) => {
          buffer += chunk;
          if (buffer.length > 128000) buffer = buffer.slice(-64000);
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            line(buffer.slice(0, newline).trim());
            buffer = buffer.slice(newline + 1);
          }
        },
      },
    );
    if (buffer.trim()) line(buffer.trim());
    if (outcome.code === 0 && (result || !error)) return { state: "done" };
    if (outcome.code === 2 && attempt < 5) {
      await new Promise((resolve) =>
        setTimeout(resolve, options.retryMs ?? 3000),
      );
      options.signal.throwIfAborted();
      continue;
    }
    return {
      state: "failed",
      ...(error?.code ? { code: error.code } : {}),
      message:
        error?.message ?? `The model download stopped (exit ${outcome.code}).`,
    };
  }
}
