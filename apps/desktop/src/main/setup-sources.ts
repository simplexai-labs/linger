// The model sources the setup page offers before anything is installed: the
// subscription runtimes (Claude Code, Codex, Pi) with their install and
// sign-in, and the planned local model downloading in the background while
// another source runs. Each runs a headless installer command
// (installer.js --runtime-status, --prepare-runtime, --runtime-login,
// --download-local-model) that answers in JSON lines; LocalServer supplies
// how to run it.

import type {
  SetupBackgroundModel,
  SetupRuntimeName,
  SetupRuntimeRow,
} from "../shared/setup.js";

export const SETUP_RUNTIME_NAMES: readonly SetupRuntimeName[] = [
  "claude",
  "codex",
  "pi",
];

// A headless installer command. Each stdout line is parsed as JSON and
// handed to onLine; write sends a line on its stdin; stop ends it (SIGTERM),
// and done resolves with its exit code.
export interface SetupCommandProcess {
  write(line: string): void;
  stop(): void;
  readonly done: Promise<number>;
}
export type SetupCommandRunner = (
  args: readonly string[],
  options: {
    // Runs on the pinned Node.js an installation uses rather than the app's
    // own (an install of a runtime records the Node.js it runs on).
    readonly pinnedNode?: boolean;
    // The person's terminal environment, as the setup check uses.
    readonly inspect?: boolean;
    readonly onLine: (line: Record<string, unknown>) => void;
  },
) => Promise<SetupCommandProcess>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
const text = (value: unknown, max = 600): string | undefined =>
  typeof value === "string" && value ? value.slice(0, max) : undefined;

export class SetupRuntimes {
  readonly #run: SetupCommandRunner;
  readonly #changed: () => void;
  readonly #openExternal: ((url: string) => Promise<void>) | undefined;
  readonly #platform: NodeJS.Platform;
  #rows = new Map<SetupRuntimeName, SetupRuntimeRow>();
  #checked = false;
  #checking: Promise<void> | undefined;
  #processes = new Map<SetupRuntimeName, SetupCommandProcess>();
  #opened = new Map<SetupRuntimeName, string>();
  #cancelled = new Set<SetupRuntimeName>();

  constructor(options: {
    run: SetupCommandRunner;
    changed: () => void;
    openExternal?: (url: string) => Promise<void>;
    platform?: NodeJS.Platform;
  }) {
    this.#run = options.run;
    this.#changed = options.changed;
    this.#openExternal = options.openExternal;
    this.#platform = options.platform ?? process.platform;
  }

  // Absent until the first check, install or sign-in starts.
  rows(): readonly SetupRuntimeRow[] | undefined {
    if (!this.#checked && !this.#checking && !this.#rows.size) return undefined;
    return SETUP_RUNTIME_NAMES.map(
      (runtime) =>
        this.#rows.get(runtime) ?? {
          runtime,
          installed: false,
          signedIn: false,
          state: "checking",
        },
    );
  }

  // The subscription runtimes signed in now, Codex first: the one the
  // installation runs by default, then the others it also configures.
  signedIn(): ("codex" | "claude")[] {
    return (["codex", "claude"] as const).filter(
      (runtime) => this.#rows.get(runtime)?.signedIn,
    );
  }

  busy(): boolean {
    return SETUP_RUNTIME_NAMES.some((runtime) => this.#working(runtime));
  }

  #working(runtime: SetupRuntimeName): boolean {
    const state = this.#rows.get(runtime)?.state;
    return state === "installing" || state === "signing_in";
  }

  // Reads each runtime's install and sign-in from this computer again.
  check(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = undefined;
      this.#changed();
    });
    this.#changed();
    return this.#checking;
  }

  async #check(): Promise<void> {
    let report: Record<string, unknown> = {};
    try {
      const child = await this.#run(["--runtime-status"], {
        inspect: true,
        onLine: (line) => {
          if (Array.isArray(line.runtimes)) report = line;
        },
      });
      await child.done;
    } catch {
      // Unknown rows read as not installed; Check again asks once more.
    }
    const found = new Map<string, Record<string, unknown>>();
    for (const row of Array.isArray(report.runtimes) ? report.runtimes : [])
      found.set(String(record(row).runtime), record(row));
    for (const runtime of SETUP_RUNTIME_NAMES) {
      const current = this.#rows.get(runtime);
      // A runtime setup is installing or signing in keeps that state.
      if (current && current.state !== "checking" && current.state !== "idle")
        continue;
      const row = found.get(runtime) ?? {};
      const version = text(row.version, 80);
      this.#rows.set(runtime, {
        runtime,
        installed: row.installed === true,
        signedIn: runtime !== "pi" && row.signedIn === true,
        ...(version ? { version } : {}),
        state: "idle",
        ...(current?.failed
          ? { failed: current.failed, message: current.message ?? "" }
          : {}),
      });
    }
    this.#checked = true;
  }

  #set(runtime: SetupRuntimeName, row: Partial<SetupRuntimeRow>): void {
    const current = this.#rows.get(runtime) ?? {
      runtime,
      installed: false,
      signedIn: false,
      state: "idle" as const,
    };
    this.#rows.set(runtime, { ...current, ...row });
    this.#changed();
  }

  // Installs the runtime the way an installation does, with its bytes.
  async install(runtime: SetupRuntimeName): Promise<void> {
    if (this.#working(runtime)) return;
    const {
      failed: _f,
      message: _m,
      ...current
    } = this.#rows.get(runtime) ??
    ({ runtime, installed: false, signedIn: false, state: "idle" } as const);
    this.#rows.set(runtime, {
      ...current,
      state: "installing",
      install: { completed: 0 },
    });
    this.#changed();
    let outcome: Record<string, unknown> = {};
    let error: string | undefined;
    try {
      const child = await this.#run(["--prepare-runtime", runtime], {
        pinnedNode: true,
        onLine: (line) => {
          if (line.event === "progress") {
            const completed = count(line.completed);
            const total = count(line.total);
            if (completed === undefined) return;
            this.#set(runtime, {
              install: { completed, ...(total ? { total } : {}) },
            });
          } else if (line.outcome) outcome = record(line.outcome);
          else if (line.error) error = text(line.error);
        },
      });
      this.#processes.set(runtime, child);
      // Cancelled while it was starting.
      if (this.#cancelled.has(runtime)) child.stop();
      await child.done;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.#processes.delete(runtime);
    }
    const installed = outcome.installed === true;
    const cancelled = this.#cancelled.delete(runtime);
    const { install: _i, ...rest } = this.#rows.get(runtime)!;
    this.#rows.set(runtime, {
      ...rest,
      installed: installed || rest.installed,
      signedIn: runtime !== "pi" && outcome.signedIn === true,
      state: "idle",
      ...(installed || cancelled
        ? {}
        : {
            failed: "install" as const,
            message: text(outcome.message) ?? error ?? "",
          }),
    });
    this.#changed();
  }

  // Starts the runtime's own sign-in: the vendor's page opens in the
  // browser (the CLI opens it on macOS and Windows; a device login and
  // Linux open it from here). Snapshots follow until signed in or ended.
  async signIn(runtime: "codex" | "claude", device = false): Promise<void> {
    if (this.#working(runtime)) return;
    const {
      failed: _f,
      message: _m,
      ...current
    } = this.#rows.get(runtime) ?? {
      runtime,
      installed: true,
      signedIn: false,
      state: "idle" as const,
    };
    this.#rows.set(runtime, { ...current, state: "signing_in", signIn: {} });
    this.#opened.delete(runtime);
    this.#changed();
    let failed: string | undefined;
    let ready = false;
    const browser =
      runtime === "codex" && !device && this.#platform === "linux";
    try {
      const child = await this.#run(
        [
          "--runtime-login",
          runtime,
          ...(device && runtime === "codex" ? ["--device-login"] : []),
        ],
        {
          onLine: (line) => {
            if (line.state === "ready") {
              ready = true;
              return;
            }
            if (line.state === "failed") {
              failed = text(line.message) ?? text(line.reason) ?? "";
              return;
            }
            if (line.error) {
              failed = text(line.error) ?? "";
              return;
            }
            if (line.state !== "waiting_user" && line.state !== "starting")
              return;
            const url = text(line.url, 4096);
            const deviceCode = text(line.deviceCode, 64);
            const previous = this.#rows.get(runtime)?.signIn;
            this.#set(runtime, {
              signIn: {
                ...(url ? { url } : {}),
                ...(url && deviceCode ? { deviceCode } : {}),
                ...(url && line.acceptsCode === true
                  ? { acceptsCode: true }
                  : {}),
                ...(previous?.browserFailed && previous.url === url
                  ? { browserFailed: true }
                  : {}),
              },
            });
            if (
              url &&
              (deviceCode || browser) &&
              this.#opened.get(runtime) !== url
            ) {
              this.#opened.set(runtime, url);
              void this.openPage(runtime);
            }
          },
        },
      );
      this.#processes.set(runtime, child);
      // Cancelled while it was starting.
      if (this.#cancelled.has(runtime)) child.stop();
      await child.done;
    } catch (error) {
      failed = error instanceof Error ? error.message : String(error);
    } finally {
      this.#processes.delete(runtime);
    }
    if (this.#cancelled.delete(runtime)) failed = undefined;
    const { signIn: _s, ...rest } = this.#rows.get(runtime)!;
    this.#rows.set(runtime, {
      ...rest,
      state: "idle",
      signedIn: ready || rest.signedIn,
      ...(ready || failed === undefined
        ? {}
        : { failed: "signin" as const, message: failed }),
    });
    this.#changed();
  }

  // Gives Claude Code's login the code its page showed.
  code(runtime: "codex" | "claude", code: string): void {
    this.#processes.get(runtime)?.write(code.trim());
  }

  // Stops an install or sign-in setup started; the row reads as before it.
  cancel(runtime: SetupRuntimeName): void {
    if (!this.#working(runtime)) return;
    this.#cancelled.add(runtime);
    this.#processes.get(runtime)?.stop();
  }

  async openPage(runtime: SetupRuntimeName): Promise<void> {
    const url = this.#rows.get(runtime)?.signIn?.url;
    if (!url || !this.#openExternal || new URL(url).protocol !== "https:")
      return;
    let failed = false;
    try {
      await this.#openExternal(url);
    } catch {
      failed = true;
    }
    const signIn = this.#rows.get(runtime)?.signIn;
    if (signIn?.url !== url || !!signIn.browserFailed === failed) return;
    this.#set(runtime, { signIn: { ...signIn, browserFailed: failed } });
  }

  signInLink(runtime: SetupRuntimeName, what: "url" | "code"): string {
    const signIn = this.#rows.get(runtime)?.signIn;
    return (what === "code" ? signIn?.deviceCode : signIn?.url) ?? "";
  }

  stopAll(): void {
    for (const runtime of SETUP_RUNTIME_NAMES) this.cancel(runtime);
  }
}

// The planned local model, downloading into the model library while another
// source runs; once done, Settings › Models offers it. It stops with the app;
// Settings › Models resumes a download that stopped.
export class BackgroundModel {
  readonly #run: SetupCommandRunner;
  readonly #changed: () => void;
  #state: SetupBackgroundModel | undefined;
  #process: SetupCommandProcess | undefined;
  #starting = false;
  #stopped = false;

  constructor(options: { run: SetupCommandRunner; changed: () => void }) {
    this.#run = options.run;
    this.#changed = options.changed;
  }

  state(): SetupBackgroundModel | undefined {
    return this.#state;
  }

  // Starts the download once; a failed one starts again.
  async start(model: string): Promise<void> {
    if (
      this.#starting ||
      this.#stopped ||
      (this.#state?.model === model && this.#state.state === "done")
    )
      return;
    this.#starting = true;
    this.#state = {
      model,
      state: "downloading",
      completed: this.#state?.model === model ? this.#state.completed : 0,
      ...(this.#state?.model === model && this.#state.total
        ? { total: this.#state.total }
        : {}),
    };
    this.#changed();
    let outcome: Record<string, unknown> = {};
    let error: string | undefined;
    try {
      this.#process = await this.#run(["--download-local-model", model], {
        onLine: (line) => {
          if (line.event === "progress") {
            const completed = count(line.completed);
            if (completed === undefined) return;
            const total = count(line.total);
            const rate = count(line.bytesPerSecond);
            this.#state = {
              model,
              state: "downloading",
              phase: line.phase === "verify" ? "verify" : "download",
              completed,
              ...(total ? { total } : {}),
              ...(rate !== undefined ? { bytesPerSecond: rate } : {}),
            };
            this.#changed();
          } else if (line.outcome) outcome = record(line.outcome);
          else if (line.error) error = text(line.error);
        },
      });
      if (this.#stopped) this.#process.stop();
      await this.#process.done;
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      this.#process = undefined;
      this.#starting = false;
    }
    const previous = this.#state!;
    const code = text(outcome.code, 80);
    this.#state =
      outcome.state === "done"
        ? {
            model,
            state: "done",
            completed: previous.total ?? previous.completed,
            ...(previous.total ? { total: previous.total } : {}),
          }
        : {
            model,
            state: "failed",
            completed: previous.completed,
            ...(previous.total ? { total: previous.total } : {}),
            ...(code ? { code } : {}),
            message: text(outcome.message) ?? error ?? "",
          };
    this.#changed();
  }

  // Ends the download for good: the app is quitting.
  stop(): void {
    this.#stopped = true;
    this.#process?.stop();
  }
}
