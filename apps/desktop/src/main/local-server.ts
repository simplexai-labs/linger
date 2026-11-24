import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  constants as fsConstants,
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { createZstdDecompress } from "node:zlib";

import {
  LocalIdentityError,
  proveLocalIdentity,
  readLocalIdentity,
  readLocalLogin,
} from "@linger/local-installation/account";
import { extractArchiveFallback } from "@linger/local-installation/archive";
import { downloadInRegion } from "@linger/local-installation/region";
import { latestLegacyBackup } from "@linger/local-installation/legacy-database";
import { legacyMigrationPending } from "@linger/local-installation/home";
import { loadInstance } from "@linger/local-installation/instance";
import { foldersInUse } from "@linger/local-installation/native-process";
import { normalizeFailurePunctuation } from "@linger/local-installation/localmodels-failure";
import { validateSourceRepository } from "@linger/local-installation/source-checkout";
import type { LegacyInstanceSkipped } from "@linger/local-installation/legacy-migration";
import {
  type SetupChoice,
  type SetupMemory,
  setupChoices,
} from "@linger/local-installation/setup-plan";
import {
  removeRetrying,
  renameRetrying,
} from "@linger/local-installation/fs-retry";
import {
  markNativeRuntimeVerified,
  nativeRuntimeVerified,
  NATIVE_RUNTIME_DIRECTORY,
  readNativeRuntime,
} from "@linger/local-installation/native-runtime";
import { linuxNodeFdHygieneArgs } from "@linger/local-installation/native-process-fds";
import {
  installTeamhubBinaries,
  TEAMHUB_BINARY_DIRECTORY,
} from "@linger/local-installation/teamhub-binaries";
import { redact } from "@linger/local-installation/redaction";
import { isInkling2MiniModelId } from "@linger/service-kit/featured-models";
import {
  windowsPrivateRefusal,
  type WindowsPrivateRefusal,
} from "@linger/local-installation/windows-private";
import { adoptUserEnvironment } from "@linger/local-installation/user-environment";

import {
  NODE_RUNTIME_RELEASES,
  NODE_RUNTIME_VERSION,
  nodeRuntimeDownloadUrls,
} from "../../../../scripts/local-computer-node-distributions.mjs";
import type { Logger } from "./log.js";
import type { Module, ModuleContext, StopReason } from "./modules.js";
import {
  type WindowLoadReason,
  parseServerUrl,
  sameOrigin,
} from "./navigation.js";
import { humanTenant, type EnrollmentModule } from "./enrollment.js";
import { compareVersions } from "./update-manifest.js";
import { systemProxy } from "./system-proxy.js";
import type { WindowManagerModule } from "./window-manager.js";
import {
  installerKeyChanges,
  savedProviderKeys,
  type ProviderKeyChanges,
} from "./provider-keys.js";
import type {
  SetupByokCheck,
  SetupByokConfig,
  SetupByokEndpoint,
  SetupByokModels,
  SetupByokProtocol,
  SetupReason,
} from "../shared/setup.js";

// The pinned linger source this build installs, written by the release build:
// downloaded from `url` (or a mirror of it), or bundled in the app at `file`.
export type SourceArchive =
  | {
      readonly url: string;
      readonly mirrors?: readonly string[];
      readonly sha256: string;
    }
  | { readonly file: string; readonly sha256: string };

// The source package's dependency store for this platform, published beside
// it; the native install then needs no package registry.
export interface SourceDependencies {
  readonly url: string;
  readonly mirrors?: readonly string[];
  readonly sha256: string;
}
// A file every complete source tree has.
const SOURCE_MARKER = "scripts/source-native.mjs";
// Where scripts/source-native.mjs looks for that store in the checkout.
const DEPENDENCY_STORE = ".linger-runtime/pnpm-store";

// The inference model the installer would deploy here, with what it needs.
export interface LocalModel {
  readonly name: string;
  readonly downloadBytes: number | null;
  readonly diskBytes: number | null;
  readonly memoryBytes: number | null;
}

// What the installer found on this computer, for the optional local model.
export type LocalModelsCheck =
  | { readonly state: "unchecked" | "unavailable" }
  // While the check first downloads the localmodels tool: its bytes.
  | { readonly state: "checking"; readonly download?: Transfer }
  | {
      readonly state: "checked";
      // Whether this computer can serve a local model now.
      readonly eligible: boolean;
      // A temporary blocker prevents installing right now (the tool's state
      // "blocked-now", such as memory held by other programs, gateway port in
      // use, or harness unavailable); shown on hold until a new check clears
      // it.
      readonly blockedNow?: true;
      // While blocked now: the memory free now and what the plan needs, as
      // the tool counts them (VRAM only for a discrete GPU).
      readonly freeMemory?: SetupMemory;
      readonly memoryBytes: number;
      readonly diskFreeBytes: number | null;
      readonly gpu?: string;
      // Present when eligible or when a blocked-now report included a plan.
      readonly model?: LocalModel;
      // The localmodels tool's code for why not, or, when eligible, for
      // what could still stop the install, with the counts it carries.
      readonly reasons?: readonly SetupReason[];
      // The localmodels tool's pick for this computer, which Quick Install
      // installs; the page adds no rule of its own.
      readonly recommendation?: SetupChoice;
    };

// A download under way: its bytes so far and in all, and the rate when the
// source reports one. partial: the counts cover only the file downloading
// now, so nothing says what remains.
export interface Transfer {
  readonly completed: number;
  readonly total?: number;
  readonly bytesPerSecond?: number;
  readonly partial?: boolean;
}

// What to install, chosen on the setup page; the installer applies it at once.
export interface LocalServerPlan {
  // "local" runs tasks on an inference model deployed on this computer.
  readonly runtime: "recommended" | "codex" | "claude" | "pi" | "local";
  // Optional BYOK configuration mounted onto local Bifrost.
  readonly byok?: SetupByokConfig;
  // Provider keys edited on the page, saved before the installer runs.
  readonly keys?: ProviderKeyChanges;
}

export const QUICK_INSTALL: LocalServerPlan = {
  runtime: "recommended",
};

// Whether the installer can set up PostgreSQL for a native install on
// `target`: it takes the source for it from LINGER_NATIVE_DEPENDENCIES_JSON
// or else the distribution.json beside it.
export function hasNativePostgres(
  installerDirectory: string,
  target: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  // A bundled archive (Windows) must also be there; it is named relative to
  // the installer, or absolute in the environment.
  const covers = (sources: unknown) =>
    Array.isArray(sources) &&
    sources.some((source) => {
      const value = source as { target?: unknown; file?: unknown } | null;
      return (
        value?.target === target &&
        (value.file === undefined ||
          (typeof value.file === "string" &&
            existsSync(path.resolve(installerDirectory, value.file))))
      );
    });
  try {
    const raw = environment.LINGER_NATIVE_DEPENDENCIES_JSON;
    if (raw) return covers(JSON.parse(raw));
    const value = JSON.parse(
      readFileSync(path.join(installerDirectory, "distribution.json"), "utf8"),
    ) as { platform?: unknown; arch?: unknown; nativeSources?: unknown };
    return (
      `${String(value.platform)}-${String(value.arch)}` === target &&
      covers(value.nativeSources)
    );
  } catch {
    return false;
  }
}

// The steps the setup page shows, in order. "download" shows only when
// something big is downloaded: the source package.
// "signin" shows only when the AI runtime has no sign-in on this computer.
export const LOCAL_STEPS = [
  "prepare",
  "download",
  "services",
  "workspace",
  "signin",
  "connect",
  "agents",
] as const;
export type LocalServerStep = (typeof LOCAL_STEPS)[number];

export type LocalServerPreparing = "updating" | "starting";

export type LocalServerPhase =
  | "idle"
  | "preparing"
  | "installing"
  | "ready"
  | "failed";

// Where the installation goes: the installer home, holding the source, the
// build and the data.
export interface LocalServerLocation {
  readonly path: string;
  // Chosen on the setup page instead of the default.
  readonly custom: boolean;
  // Why the folder last chosen cannot be used.
  readonly error?: string;
}

export type LocalRuntime = "codex" | "claude" | "pi";

// The AI runtime's own sign-in, which the installer runs; while the setup
// page waits for it. No secret passes through here: the person signs in on
// the vendor's page, and Claude Code's authorization code goes straight to
// its login process.
export interface RuntimeSignIn {
  readonly runtime: LocalRuntime;
  // required: not started; starting/waiting_user: the login runs, url is
  // the vendor's page and deviceCode what to enter there; failed: it ended
  // without a sign-in (message says why); signed_in: done, the step stays
  // on the list.
  readonly state:
    | "required"
    | "starting"
    | "waiting_user"
    | "failed"
    | "signed_in";
  readonly url?: string;
  readonly deviceCode?: string;
  // The vendor's page shows a code to paste back (Claude Code).
  readonly acceptsCode?: boolean;
  // Why a failed sign-in ended, which the page words itself; message is the
  // installer's own English for anything else.
  readonly reason?: RuntimeLoginReason;
  readonly message?: string;
  // The browser could not be opened on url; the page offers to copy it.
  readonly browserFailed?: boolean;
}

// unavailable: no native sign-in for this runtime; timed_out: nobody
// finished it in time; ended: the login stopped without a sign-in.
export type RuntimeLoginReason = "unavailable" | "timed_out" | "ended";

// Why an installation stopped, for failures the setup page words itself:
// the runtime lookup outlasted RUNTIME_LOOKUP_LIMIT_MS, or the installer
// stopped answering while it ran.
export type LocalServerFailure =
  | "runtime_lookup_timed_out"
  | "runtime_lookup_unreachable";

// What a running step still waits on once it has taken a while; the page
// says so, since the bar does not move meanwhile.
export type LocalServerWaiting = "runtime";

// Codex's two logins: browser calls back to this computer, so the browser
// must run here; device shows a code to enter in any browser, which needs
// device-code sign-in turned on in the person's ChatGPT settings.
export type RuntimeLoginMethod = "browser" | "device";

export interface LocalServerStatus {
  // Source installs ship for macOS arm64, Linux x64 and Windows x64 only, and need the
  // pinned source package or a developer checkout.
  readonly available: boolean;
  readonly phase: LocalServerPhase;
  readonly message: string;
  // While preparing: whether the services restart on a new version or
  // only start, for pages that word it themselves.
  readonly preparing?: LocalServerPreparing;
  // While installing: the steps shown, the current one and the overall share
  // done (0-1).
  readonly steps: readonly LocalServerStep[];
  readonly step: LocalServerStep;
  readonly progress: number;
  // While the current step downloads: what and how far.
  readonly transfer?: Transfer & { readonly label: string };
  // While installing: what a step that has run a while still waits on.
  readonly waiting?: LocalServerWaiting;
  // Which installation this is; each Install or Try Again starts a new one.
  readonly attempt: number;
  readonly localModels: LocalModelsCheck;
  readonly location: LocalServerLocation;
  // Which provider keys the installation location holds; never the
  // keys themselves.
  readonly keys: {
    readonly composio: boolean;
  };
  readonly origin?: string;
  // While the "signin" step waits for the person.
  readonly signIn?: RuntimeSignIn;
  readonly byokCheck?: SetupByokCheck;
  readonly byokModels?: SetupByokModels;
  // Where this installation moved the data of the earlier Simplex app,
  // which it could not upgrade.
  readonly legacyBackup?: string;
  // While failed because the installer refused a folder as not private
  // (Windows): its code and reason.
  readonly refusal?: WindowsPrivateRefusal;
  // While failed for a reason the page words itself.
  readonly failure?: LocalServerFailure;
  // While ready after a degraded resume where local models could not be restored.
  readonly localModelsDegraded?: LocalModelsDegradedStatus;
}

export interface LocalModelsDegradedStatus {
  readonly code: string;
  readonly message: string;
  readonly reasons?: readonly string[];
}

export interface LocalServerOptions {
  // The default LINGER_HOME of the installer.
  // The desktop keeps its Node runtime and its record here wherever the
  // installation goes.
  readonly home: string;
  // This app's version, recorded with the source package it unpacks.
  readonly version: string;
  // The bundled installer (installer.js, web/, native-process-worker.mjs).
  readonly installerDirectory: string;
  readonly sourceArchive?: SourceArchive;
  readonly sourceDependencies?: SourceDependencies;
  // A linger checkout installed instead of the source package, for developers
  // (LINGER_CHECKOUT).
  readonly checkout?: string;
  // Signs the app's web session in to the local server with its owner, once
  // the server proved it is this installation's (signInWithPassword).
  readonly signIn: (
    server: LocalServerIdentity,
    email: string,
    password: string,
  ) => Promise<void>;
  // The installed server's identity; read from its private files by default.
  readonly serverIdentity?: (
    home: string,
    origin: string,
  ) => Promise<LocalServerIdentity>;
  // Asks the server to prove it; proveLocalServer by default.
  readonly proveServer?: (server: LocalServerIdentity) => Promise<void>;
  // The cookie header of that web session, to follow the agents it sets up.
  readonly sessionCookie?: (origin: string) => Promise<string | undefined>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  // This Mac's macOS version (Electron's process.getSystemVersion); not
  // checked without it.
  readonly macosVersion?: () => string | undefined;
  readonly fetch?: typeof fetch;
  readonly pollMs?: number;
  // The free space a picked folder needs; LOCATION_FREE_BYTES by default.
  readonly freeBytes?: number;
  // How long setup waits for the Another Me; AGENTS_TIMEOUT_MS by default.
  readonly agentsTimeoutMs?: number;
  // Opens the runtime's sign-in page in the browser.
  readonly openExternal?: (url: string) => Promise<void>;
  // How often the sign-in step checks for a sign-in; SIGN_IN_POLL_MS by
  // default.
  readonly signInPollMs?: number;
  // Moves an unpacked folder into place; fs.rename by default.
  readonly rename?: (from: string, to: string) => Promise<void>;
  // The glibc of this Linux computer; the running one's by default.
  readonly glibcVersion?: string;
  // Chromium's proxy for a URL (session.resolveProxy); without it the
  // services get no system proxy.
  readonly resolveProxy?: (url: string) => Promise<string>;
  // How often the running server the window shows is checked, and how long
  // one that does not answer gets to come back by itself before a resume;
  // WATCH_MS and UNREACHABLE_GRACE_MS by default.
  readonly watchMs?: number;
  readonly unreachableGraceMs?: number;
}

// The starter Room the server makes for a new owner, with their Agents.
const STARTER_ROOM = "Getting Started";
const AGENTS_TIMEOUT_MS = 5 * 60_000;
// Each check runs the installer's runtime status, a short process.
const SIGN_IN_POLL_MS = 3_000;
// How long one check that the installed server still answers as itself
// serves the pages that ask whether to offer the owner account.
const SERVER_CHECK_TTL_MS = 2_000;
const WATCH_MS = 30_000;
// Longer than a service supervisor's restart delays (1, 2 and 5 seconds)
// plus a web start, so a restart it has under way is not doubled.
const UNREACHABLE_GRACE_MS = 20_000;
// A ready server counts as stopped only after this many unanswered checks in
// a row, spread over the grace, each waiting longer than a launch's fast
// check: one under heavy load (such as local model inference) can answer
// slowly for a while, and resuming it would send the window to Starting.
const UNREACHABLE_PROBES = 3;
const UNREACHABLE_PROBE_TIMEOUT_MS = 5_000;
// A server that keeps going away is resumed at most this often on its own;
// Retry is never held back.
const RECOVERY_INTERVAL_MS = 60_000;

// The instance the desktop installs.
export const LOCAL_INSTANCE = "desktop";

export interface LegacyMigrationRun {
  code: number | null;
  output: string;
  error: string;
}

/**
 * Reads `installer.js --migrate`: the instances it left unconverted, and why
 * `instance`, the one this app uses, could not be converted, if so.
 */
export function legacyMigrationResult(
  run: LegacyMigrationRun,
  instance: string,
): { failure?: string; skipped: LegacyInstanceSkipped[] } {
  if (run.code !== 0)
    return {
      failure:
        run.error.trim().slice(-1500) ||
        `The installer exited with code ${run.code}.`,
      skipped: [],
    };
  let skipped: LegacyInstanceSkipped[] = [];
  try {
    const parsed = JSON.parse(run.output.trim().split("\n").at(-1) ?? "") as {
      skipped?: unknown;
    };
    if (Array.isArray(parsed.skipped))
      skipped = parsed.skipped.filter(
        (entry): entry is LegacyInstanceSkipped =>
          typeof (entry as LegacyInstanceSkipped)?.instance === "string" &&
          typeof (entry as LegacyInstanceSkipped)?.reason === "string",
      );
  } catch {
    // An installer that answers no list converted everything it could.
  }
  const own = skipped.find((entry) => entry.instance === instance);
  return {
    skipped,
    ...(own && {
      failure: `Linger could not convert this computer's installation from the earlier Simplex app. ${own.reason}`,
    }),
  };
}
const NATIVE_TARGETS = new Set(["darwin-arm64", "linux-x64", "win32-x64"]);
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
// The free space a first installation asks for, as the installer advises;
// a local model needs its own on top.
export const LOCATION_FREE_BYTES = 20 * GiB;

// Runs Linger on this computer: fetches a pinned Node 26 and the linger
// source, drives the bundled installer through its local API and signs the
// window in to the result. The desktop itself is the Computer, so the
// installer skips its own and the desktop enrolls once signed in.
export class LocalServerModule implements Module {
  readonly name = "LocalServer";
  readonly dependsOn = ["WindowManager", "Enrollment"];
  readonly #options: LocalServerOptions;
  #ctx: ModuleContext | undefined;
  #phase: LocalServerPhase = "idle";
  #message = "";
  #preparing: LocalServerPreparing = "starting";
  #step: LocalServerStep = "prepare";
  #progress = 0;
  #transfer: LocalServerStatus["transfer"];
  // Counts installations started, so the setup page restarts its timers.
  #attempt = 0;
  #origin: string | undefined;
  #resuming = false;
  #busyCount = 0;
  #started = false;
  #running: Promise<void> | undefined;
  #check: LocalModelsCheck = { state: "unchecked" };
  #checkedAt: number | undefined;
  // Read once from the bundled installer's distribution.
  #nativePostgres: boolean | undefined;
  // Where an installation goes unless the setup page chose another folder:
  // the one already installed, else the default home.
  #home: string;
  #location: string | undefined;
  #locationError: string | undefined;
  #refusal: WindowsPrivateRefusal | undefined;
  #failure: LocalServerFailure | undefined;
  #waiting: LocalServerWaiting | undefined;
  #localModelsDegraded: LocalModelsDegradedStatus | undefined;
  #node: Promise<string> | undefined;
  #abort = new AbortController();
  #offRetry: (() => void) | undefined;
  #offUnreachable: (() => void) | undefined;
  #watch: ReturnType<typeof setInterval> | undefined;
  #recovering = false;
  #recoveredAt: number | undefined;
  #offReset: (() => void) | undefined;
  #offDaemon: (() => void) | undefined;
  #offDaemonConnection: (() => void) | undefined;
  #offComputerChanged: (() => void) | undefined;
  #daemonFailure: string | undefined;
  #daemonConnection: string | undefined;
  #signIn: RuntimeSignIn | undefined;
  #byokCheck: SetupByokCheck | undefined;
  #byokModels: SetupByokModels | undefined;
  #legacyBackup: string | undefined;
  // The installer that runs the sign-in, and what the person asked for
  // while the step waits.
  #signInInstaller: InstallerApi | undefined;
  #signInWake: (() => void) | undefined;
  #switchTo: LocalRuntime | undefined;
  #switchByok: SetupByokConfig | undefined;
  #opened: string | undefined;
  // The Codex login this app asked for; undefined leaves the choice, and
  // opening the browser, to the installer.
  #signInMethod: RuntimeLoginMethod | undefined;
  #serverCheck:
    | { readonly at: number; readonly ok: Promise<boolean> }
    | undefined;
  #serverOk: boolean | undefined;

  constructor(options: LocalServerOptions) {
    this.#options = options;
    this.#home = options.home;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    // After a reboot the local services are gone; start them again while the
    // window still points at them. A record of a Quick Install that stopped
    // before this computer connected (the app quit or the computer went off
    // during its last steps) is not resumed: setup shows instead, and its
    // Install finishes that installation.
    let record = await this.#readRecord();
    // The record stays in the default home, but the installation it names
    // may be in a location the person chose; that home converts too, and
    // only its own instance holds the app back.
    const inUse = record?.home ?? this.#options.home;
    let migrationFailure: string | undefined;
    for (const home of new Set([this.#options.home, inUse])) {
      const failure = await this.#migrateLegacyHome(ctx, home);
      if (home === inUse) migrationFailure = failure;
    }
    if (record) this.#home = record.home;
    const config = ctx.config.get();
    const resumes =
      !!record &&
      config.serverUrl !== undefined &&
      sameOrigin(config.serverUrl, record.origin) &&
      !!config.computerId;
    this.#started = true;
    if (migrationFailure) {
      // Resume would fail on the legacy record with a less useful error;
      // Retry resumes, and the installer migrates again first.
      this.#set("failed", migrationFailure);
      if (resumes)
        ctx
          .get<WindowManagerModule>("WindowManager")
          ?.showStartFailed(migrationFailure);
    } else if (record && resumes) void this.#resume(record, this.#abort.signal);
    this.#offDaemon = ctx.bus.on("computer.failed", (reason) => {
      this.#daemonFailure = reason;
    });
    this.#offDaemonConnection = ctx.bus.on("computer.connection", (state) => {
      this.#daemonConnection = state;
    });
    this.#offComputerChanged = ctx.bus.on("computer.changed", () => {
      this.#daemonConnection = undefined;
    });
    this.#offRetry = ctx.bus.on("local-server.retry", () => {
      if (this.#phase === "ready") {
        void this.#recoverUnreachable("retry", 0, false);
        return;
      }
      if (this.#phase !== "failed") return;
      void this.#readRecord().then((latest) => {
        const target = latest ?? record;
        if (target && this.#phase === "failed") {
          record = target;
          void this.#resume(target, this.#abort.signal);
        }
      });
    });
    this.#offReset = ctx.bus.on("local-server.reset", () => {
      record = undefined;
      void this.#reset();
    });
    const grace = this.#options.unreachableGraceMs ?? UNREACHABLE_GRACE_MS;
    this.#offUnreachable = ctx.bus.on("local-server.unreachable", () => {
      void this.#recoverUnreachable("load_failed", grace, true);
    });
    this.#watch = setInterval(
      () => void this.#recoverUnreachable("watch", grace, true),
      this.#options.watchMs ?? WATCH_MS,
    );
    this.#watch.unref?.();
  }

  async stop(reason: StopReason): Promise<void> {
    this.#offRetry?.();
    this.#offUnreachable?.();
    clearInterval(this.#watch);
    this.#offReset?.();
    this.#offDaemon?.();
    this.#offDaemonConnection?.();
    this.#offComputerChanged?.();
    // The installer manager keeps running a started installation; it exits
    // by itself once idle.
    this.#abort.abort();
    if (this.#busyCount > 0) {
      this.#busyCount = 0;
      this.#ctx?.bus.emit("local-server.busy", false);
    }
    if (reason === "quit") await this.#stopLocalModels();
  }

  #acquireBusy(): void {
    this.#busyCount += 1;
    if (this.#busyCount === 1) this.#ctx?.bus.emit("local-server.busy", true);
  }

  #releaseBusy(): void {
    if (this.#busyCount === 0) return;
    this.#busyCount -= 1;
    if (this.#busyCount === 0) this.#ctx?.bus.emit("local-server.busy", false);
  }

  // The Computer exits with the app, so after a quit nothing uses the local
  // models: the bundled installer unloads the model library's models and
  // stops the stack with the gateway the localmodels tool started, which
  // would otherwise keep their memory and ports until the next reboot. The
  // services and the model controller keep running, as after every quit;
  // the next launch's resume brings the approved stack up again while the
  // model source is still local. The stop runs on
  // after the app is gone, its output in the installer's folder. An update
  // or an uninstall stops the models with the services instead.
  async #stopLocalModels(): Promise<void> {
    if (!(await this.#readRecord()) || !existsSync(this.#installerScript()))
      return;
    const directory = path.join(this.#options.home, "installer");
    let output: number;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      output = openSync(
        path.join(directory, "local-models-stop.log"),
        "w",
        0o600,
      );
    } catch (error) {
      this.#ctx?.log.warn("local_server.local_models_stop_failed", {
        error: String(error),
      });
      return;
    }
    try {
      const child = spawn(
        process.execPath,
        [
          ...linuxNodeFdHygieneArgs(this.#options.platform),
          this.#installerScript(),
          "--home",
          this.#options.home,
          "--stop-local-models",
        ],
        {
          detached: true,
          // A detached Windows process otherwise opens its own console window.
          windowsHide: true,
          stdio: ["ignore", output, output],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      child.once("error", (error) =>
        this.#ctx?.log.warn("local_server.local_models_stop_failed", {
          error: String(error),
        }),
      );
      child.unref();
      this.#ctx?.log.info("local_server.local_models_stopping", {
        home: this.#options.home,
      });
    } finally {
      closeSync(output);
    }
  }

  async resumable(serverUrl: string): Promise<boolean> {
    if (this.#resuming && this.#origin && sameOrigin(this.#origin, serverUrl))
      return true;
    const record = await this.#readRecord();
    return record !== undefined && sameOrigin(record.origin, serverUrl);
  }

  // Whether the window should show "Starting Linger" instead of the retrying
  // offline page when `serverUrl` fails to load. True while a resume is active
  // for this origin, or during initial boot before LocalServer.start() begins
  // the resume; false once resume has settled so a later transient failure
  // never traps the window on the non-retrying Starting page.
  async isStarting(serverUrl: string): Promise<boolean> {
    if (this.#resuming)
      return this.#origin !== undefined && sameOrigin(this.#origin, serverUrl);
    if (!this.#started) return this.resumable(serverUrl);
    return false;
  }

  status(): LocalServerStatus {
    // The services run natively, so the build must carry PostgreSQL for
    // this computer.
    this.#nativePostgres ??= hasNativePostgres(
      this.#options.installerDirectory,
      this.#target(),
    );
    const available =
      NATIVE_TARGETS.has(this.#target()) &&
      existsSync(this.#installerScript()) &&
      !!(this.#options.sourceArchive || this.#options.checkout) &&
      this.#nativePostgres;
    const keys = savedProviderKeys(
      this.#location ?? this.#home,
      LOCAL_INSTANCE,
    );
    return {
      available,
      phase: this.#phase,
      message: this.#message,
      ...(this.#phase === "preparing" ? { preparing: this.#preparing } : {}),
      steps: this.#steps(),
      step: this.#step,
      progress: this.#progress,
      ...(this.#transfer ? { transfer: this.#transfer } : {}),
      ...(this.#waiting && this.#phase === "installing"
        ? { waiting: this.#waiting }
        : {}),
      attempt: this.#attempt,
      localModels: this.#check,
      location: {
        path: this.#location ?? this.#home,
        custom: this.#location !== undefined,
        ...(this.#locationError ? { error: this.#locationError } : {}),
      },
      keys: {
        composio: !!keys.composio,
      },
      ...(this.#origin ? { origin: this.#origin } : {}),
      ...(this.#signIn ? { signIn: this.#signIn } : {}),
      ...(this.#byokCheck ? { byokCheck: this.#byokCheck } : {}),
      ...(this.#byokModels ? { byokModels: this.#byokModels } : {}),
      ...(this.#legacyBackup ? { legacyBackup: this.#legacyBackup } : {}),
      ...(this.#refusal ? { refusal: this.#refusal } : {}),
      ...(this.#failure ? { failure: this.#failure } : {}),
      ...(this.#localModelsDegraded
        ? { localModelsDegraded: this.#localModelsDegraded }
        : {}),
    };
  }

  // Installs, signs in and connects this computer; resolves once the window
  // shows the local server. A second call joins the running installation.
  begin(plan: LocalServerPlan = QUICK_INSTALL): Promise<void> {
    this.#running ??= this.#install(plan).finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  // Installs into a folder the person picked, once it can hold Linger; null
  // goes back to the default.
  async chooseLocation(picked: string | null): Promise<void> {
    if (this.#running) return;
    const previous = this.#location;
    if (picked === null) {
      this.#location = undefined;
      this.#locationError = undefined;
    } else {
      const home = await installLocation(picked);
      this.#locationError = await checkLocation(home, this.#freeBytes());
      if (!this.#locationError)
        this.#location = home === this.#home ? undefined : home;
    }
    if (previous !== this.#location && this.#check.state !== "unchecked")
      this.recheck();
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Asks the installer whether this computer can serve a local model; the
  // setup window asks as it opens, before anything is installed, and again
  // through recheck(). Then fetches the Node runtime an installation starts
  // with.
  inspect(): void {
    if (
      this.#check.state !== "unchecked" ||
      this.#running ||
      (this.#phase !== "idle" && this.#phase !== "failed") ||
      !this.status().available
    )
      return;
    this.#check = { state: "checking" };
    this.#checkedAt = undefined;
    this.#ctx?.bus.emit("local-server.changed");
    const started = Date.now();
    const signal = this.#abort.signal;
    if (!signal.aborted) void this.#ensureNode(signal).catch(() => undefined);
    const home = this.#location ?? this.#home;
    void this.#inspect(home, signal, (download) => {
      if (this.#check.state !== "checking") return;
      this.#check = { state: "checking", download };
      this.#ctx?.bus.emit("local-server.changed");
    })
      .then(
        ({ check, reasonLog }) => {
          this.#ctx?.log.info("local_server.inspected", {
            ms: Date.now() - started,
            eligible: check.state === "checked" && check.eligible,
            ...(check.state === "checked" && check.blockedNow
              ? {
                  blocked_now: true,
                  ...(check.freeMemory
                    ? { free_memory: check.freeMemory }
                    : {}),
                }
              : {}),
            ...(check.state === "checked" && check.recommendation
              ? { recommendation: check.recommendation }
              : {}),
            ...(reasonLog.length ? { reasons: reasonLog } : {}),
          });
          return check;
        },
        (error: unknown) => {
          this.#ctx?.log.warn("local_server.inspect_failed", {
            ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          });
          return { state: "unavailable" } as const;
        },
      )
      .then((check) => {
        if (signal.aborted) return;
        if (home !== (this.#location ?? this.#home)) {
          this.#check = { state: "unchecked" };
          this.inspect();
          return;
        }
        this.#check = check;
        this.#checkedAt =
          check.state === "unavailable" ? undefined : Date.now();
        this.#ctx?.bus.emit("local-server.changed");
      });
  }

  // Checks again, for example after the person closed other programs to free
  // the memory the local model needs.
  recheck(): void {
    if (
      this.#check.state === "checking" ||
      this.#running ||
      (this.#phase !== "idle" && this.#phase !== "failed")
    )
      return;
    this.#check = { state: "unchecked" };
    this.inspect();
  }

  // Tests the endpoint with one request from this computer. The page reads
  // the outcome from byokCheck in the state its command returns, and tells
  // a test in flight by itself.
  async checkByok(byok: SetupByokConfig): Promise<void> {
    const out = await this.#byokCommand("--check-byok", byok, 50_000);
    this.#byokCheck =
      out.ok === true &&
      isByokProtocol(out.protocol) &&
      typeof out.url === "string"
        ? {
            state: "ready",
            protocol: out.protocol,
            url: out.url,
            modelId:
              typeof out.modelId === "string" ? out.modelId : byok.modelId,
            contextWindow:
              typeof out.contextWindow === "number"
                ? out.contextWindow
                : 131_072,
          }
        : {
            state: "failed",
            message: byokFailure(out, "Could not test the BYOK endpoint."),
          };
  }

  // Lists the models the endpoint serves at its base URL + path + /models,
  // read back like a test from byokModels.
  async listByokModels(endpoint: SetupByokEndpoint): Promise<void> {
    const out = await this.#byokCommand("--list-byok-models", endpoint, 35_000);
    this.#byokModels =
      typeof out.url === "string" && Array.isArray(out.models)
        ? {
            state: "ready",
            url: out.url,
            models: (out.models as unknown[]).flatMap((row) => {
              const { id, name, contextWindow } = (row ?? {}) as Record<
                string,
                unknown
              >;
              return typeof id === "string" && id
                ? [
                    {
                      id,
                      ...(typeof name === "string" && name ? { name } : {}),
                      ...(typeof contextWindow === "number"
                        ? { contextWindow }
                        : {}),
                    },
                  ]
                : [];
            }),
          }
        : {
            state: "failed",
            message: byokFailure(out, "Could not list the endpoint's models."),
          };
  }

  // Runs the installer's headless BYOK command: the endpoint and key go on
  // stdin, never in argv, and its last stdout line is the JSON answer. A
  // failure to run it comes back as { ok: false, message }.
  async #byokCommand(
    flag: "--check-byok" | "--list-byok-models",
    input: SetupByokEndpoint,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const home = this.#location ?? this.#home;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...linuxNodeFdHygieneArgs(this.#options.platform),
            this.#installerScript(),
            "--home",
            home,
            flag,
          ],
          {
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              LINGER_HOME: home,
            },
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        let last = "";
        createInterface({ input: child.stdout }).on("line", (line) => {
          if (line.trim()) last = line;
        });
        child.once("error", reject);
        child.once("close", () => resolve(last));
        child.stdin.end(JSON.stringify(input));
      });
      const parsed: unknown = JSON.parse(output);
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {};
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async #inspect(
    targetHome: string,
    signal: AbortSignal,
    onDownload: (download: Transfer) => void,
  ): Promise<{
    check: LocalModelsCheck;
    // The tool's codes with its words, for the log only.
    reasonLog: string[];
  }> {
    // The app's own Node runs the check, so it needs no download of its own;
    // installing still uses the pinned Node runtime.
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          ...linuxNodeFdHygieneArgs(this.#options.platform),
          this.#installerScript(),
          "--home",
          this.#options.home,
          "--inspect",
          "--inspect-target",
          targetHome,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            LINGER_HOME: this.#options.home,
          },
          signal,
        },
      );
      // The check logs how long its parts took on stderr.
      let logged = 0;
      createInterface({ input: child.stderr }).on("line", (line) => {
        if (!line.trim() || logged++ >= 20) return;
        this.#ctx?.log.info("local_server.inspect_log", {
          line: line.slice(0, 300),
        });
      });
      // The report is the last line; lines before it count the bytes of the
      // localmodels tool while the check first downloads it.
      let last = "";
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (!line.trim()) return;
        last = line;
        let event: { event?: unknown; completed?: unknown; total?: unknown };
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const count = (value: unknown) =>
          typeof value === "number" && Number.isFinite(value) && value >= 0
            ? value
            : undefined;
        const completed = count(event?.completed);
        const total = count(event?.total);
        if (event?.event === "download" && completed !== undefined)
          onDownload({ completed, ...(total ? { total } : {}) });
      });
      child.once("error", reject);
      child.once("close", () => resolve(last));
    });
    // A failed check prints null; its cause is in the logged stderr.
    const report = JSON.parse(output) as {
      recommendation?: unknown;
      localModels?: {
        eligible?: unknown;
        state?: unknown;
        memory?: Record<string, unknown>;
        reasons?: unknown;
        estimate?: {
          model?: unknown;
          downloadBytes?: unknown;
          diskBytes?: unknown;
          memoryBytes?: unknown;
        };
      };
      hardware?: {
        totalMemoryBytes?: unknown;
        diskFreeBytes?: unknown;
        gpus?: { name?: unknown }[];
      };
    } | null;
    const hardware = report?.hardware;
    if (
      typeof report?.localModels?.eligible !== "boolean" ||
      typeof hardware?.totalMemoryBytes !== "number"
    )
      throw new Error("The installer could not check this computer");
    const gpu = hardware.gpus?.[0]?.name;
    const estimate = report.localModels.estimate;
    const bytes = (value: unknown) =>
      typeof value === "number" && value >= 0 ? value : null;
    const name =
      typeof estimate?.model === "string" && estimate.model
        ? estimate.model
        : undefined;
    // A blocked-now report holds local models even when no plan could be built
    // yet (for example gateway-port-in-use or harness-unavailable).
    const blockedNow = report.localModels.state === "blocked-now";
    const eligible = report.localModels.eligible && !!name && !blockedNow;
    const memory = report.localModels.memory;
    const freeMemory: SetupMemory | undefined =
      blockedNow &&
      bytes(memory?.ramAvailableBytes) !== null &&
      bytes(memory?.ramRequiredBytes) !== null
        ? {
            ramAvailableBytes: memory!.ramAvailableBytes as number,
            ramRequiredBytes: memory!.ramRequiredBytes as number,
            ...(bytes(memory?.vramFreeBytes) !== null &&
            bytes(memory?.vramRequiredBytes) !== null
              ? {
                  vramFreeBytes: memory!.vramFreeBytes as number,
                  vramRequiredBytes: memory!.vramRequiredBytes as number,
                }
              : {}),
          }
        : undefined;
    const listed = Array.isArray(report.localModels.reasons)
      ? (report.localModels.reasons as Record<string, unknown>[]).filter(
          (reason) => typeof reason?.code === "string",
        )
      : [];
    // The page words each reason by its code and counts, never the tool's.
    const version = (value: unknown) =>
      typeof value === "string" && /^\d+(?:\.\d+){0,2}$/.test(value)
        ? value
        : null;
    const reasons = listed.map((reason): SetupReason => {
      const counted = (key: "gpuIndex" | "freeBytes" | "requiredBytes") =>
        bytes(reason[key]) !== null ? { [key]: reason[key] as number } : {};
      const versioned = (
        key: "detectedCudaVersion" | "requiredCudaVersion" | "driverVersion",
      ) => {
        const value = version(reason[key]);
        return value !== null ? { [key]: value } : {};
      };
      return {
        code: reason.code as string,
        ...counted("gpuIndex"),
        ...counted("freeBytes"),
        ...counted("requiredBytes"),
        ...versioned("detectedCudaVersion"),
        ...versioned("requiredCudaVersion"),
        ...versioned("driverVersion"),
      };
    });
    const reasonLog = listed.map(({ code, message }) =>
      typeof message === "string" && message
        ? `${code}: ${message}`
        : `${code}`,
    );
    const pick = report.recommendation;
    // The local model is recommended only with a model the page can show.
    const recommendation =
      typeof pick === "string" &&
      (setupChoices as readonly string[]).includes(pick) &&
      (pick !== "local-models" || eligible)
        ? (pick as SetupChoice)
        : undefined;
    const check: LocalModelsCheck = {
      state: "checked",
      eligible,
      memoryBytes: hardware.totalMemoryBytes,
      diskFreeBytes:
        typeof hardware.diskFreeBytes === "number"
          ? hardware.diskFreeBytes
          : null,
      ...(typeof gpu === "string" ? { gpu } : {}),
      ...(blockedNow ? { blockedNow } : {}),
      ...(freeMemory ? { freeMemory } : {}),
      ...((eligible || blockedNow) && name
        ? {
            model: {
              name,
              downloadBytes: bytes(estimate?.downloadBytes),
              diskBytes: bytes(estimate?.diskBytes),
              memoryBytes: bytes(estimate?.memoryBytes),
              ...(isInkling2MiniModelId(name)
                ? { featuredInkling: true as const }
                : {}),
            },
          }
        : {}),
      ...(reasons.length ? { reasons } : {}),
      ...(recommendation ? { recommendation } : {}),
    };
    return { check, reasonLog };
  }

  // Logs how long one part of setup took, so a slow setup says which part.
  async #timed<T>(step: string, run: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await run();
    } finally {
      this.#ctx?.log.info("local_server.timing", {
        step,
        ms: Date.now() - started,
      });
    }
  }

  async #install(plan: LocalServerPlan): Promise<void> {
    const status = this.status();
    if (!status.available)
      throw new Error("Running Linger on this computer is not supported here");
    const signal = this.#abort.signal;
    const home = this.#location ?? this.#home;
    this.#attempt += 1;
    this.#acquireBusy();
    try {
      // A retry starts over from the first step.
      this.#step = "prepare";
      this.#progress = 0;
      this.#endSignIn();
      this.#advance("prepare", 0, "Checking this computer…");
      await this.#adoptSourceKeys(home);
      // Keep what runs now until this version replaces it.
      const record = await this.#readRecord();
      await this.#timed("prune_sources", () =>
        this.#pruneSources(home, [
          record?.repo,
          this.#options.sourceArchive?.sha256.slice(0, 16),
        ]),
      );
      // A chosen folder may have filled up or gone since it was picked.
      if (this.#location) {
        const model =
          this.#check.state === "checked" ? this.#check.model : undefined;
        const error = await checkLocation(
          home,
          this.#freeBytes() +
            (plan.runtime === "local" ? (model?.diskBytes ?? 0) : 0),
        );
        if (error) throw new Error(error);
      }
      const node = await this.#timed("node", () => this.#ensureNode(signal));
      const keysChanged = Object.keys(plan.keys ?? {}).length > 0;
      if (keysChanged)
        await this.#timed("keys", () =>
          this.#saveKeys(node, home, plan.keys!, signal),
        );
      this.#advance(
        "download",
        0,
        this.#downloadsSource() ? "Downloading Linger…" : "Unpacking Linger…",
      );
      const repo = await this.#timed("source", () =>
        this.#ensureSource(home, signal),
      );
      await this.#timed("dependencies", () =>
        this.#ensureDependencies(repo, signal),
      );
      this.#advance("download", 0.1, "Starting the installer…");
      const installer = await this.#timed("installer_launch", () =>
        this.#launchInstaller(node, home, repo, signal),
      );
      const runInstaller = (next: LocalServerPlan, fresh = false) =>
        this.#timed("installer_job", () =>
          installer.run(
            next,
            signal,
            (stage, share, text, transfer) =>
              this.#advance(stage, share, text, transfer),
            fresh,
          ),
        );
      // Reuse a fresh non-local recommendation from the setup window check
      // instead of running a duplicate setup inspection.
      const inspectedRuntime =
        plan.runtime === "recommended" &&
        !plan.byok &&
        !this.#location &&
        !keysChanged &&
        this.#check.state === "checked" &&
        this.#checkedAt !== undefined &&
        Date.now() - this.#checkedAt < 60_000 &&
        this.#check.recommendation &&
        this.#check.recommendation !== "local-models"
          ? this.#check.recommendation
          : undefined;
      const effectivePlan: LocalServerPlan = inspectedRuntime
        ? { ...plan, runtime: inspectedRuntime }
        : plan;
      // Changed keys reach the services only when the installation runs
      // again, even after one that finished.
      let job = await runInstaller(
        effectivePlan,
        keysChanged || Boolean(plan.byok),
      );
      // The runtime is installed but has no sign-in here: the server would
      // never create the Another Me, so ask for it now. Another runtime
      // reruns the installation for it.
      for (;;) {
        const nextChoice = job.signInRequired
          ? await this.#timed("await_signin", () =>
              this.#awaitSignIn(installer, signal, job.setupChoice),
            )
          : undefined;
        if (!nextChoice) break;
        this.#endSignIn();
        this.#step = "services";
        job =
          typeof nextChoice === "string"
            ? await runInstaller(
                {
                  runtime: nextChoice,
                  ...(plan.keys ? { keys: plan.keys } : {}),
                },
                true,
              )
            : await runInstaller(
                {
                  runtime: nextChoice.byok.runtime,
                  byok: nextChoice.byok,
                  ...(plan.keys ? { keys: plan.keys } : {}),
                },
                true,
              );
      }
      // Prewarm main-window assets in the background as soon as the server
      // origin is known.
      void this.#ctx
        ?.get<WindowManagerModule>("WindowManager")
        .prewarmAssets(job.origin);
      // The desktop's Computer runs the runtime this installer set up, with
      // its profile, rather than whatever its PATH finds.
      const runtime = await this.#timed("installer_runtime", async () =>
        job.runtime && !job.signInRequired
          ? job.runtime
          : this.#runtimeOf(installer, signal),
      );
      const preferredRuntime = setupRuntime(runtime.setupChoice);
      this.#ctx?.config.update({
        runtimeEnvironment: runtime.environment,
        ...(preferredRuntime ? { preferredRuntime } : {}),
      });
      this.#ctx?.log.info("local_server.runtime", {
        runtime: runtime.setupChoice,
        keys: Object.keys(runtime.environment),
      });
      // The installer set a database from before Linger aside for a fresh
      // one; this computer's enrollment belongs to the old one, so it
      // enrolls again. Noted in the config so that happens once.
      const legacyBackup = await latestLegacyBackup(
        path.join(home, "instances", LOCAL_INSTANCE),
      );
      if (
        legacyBackup &&
        legacyBackup !== this.#ctx?.config.get().legacyBackup
      ) {
        this.#ctx?.log.warn("local_server.legacy_data_set_aside", {
          backup: legacyBackup,
        });
        await this.#ctx?.get<EnrollmentModule>("Enrollment").unenroll();
        this.#ctx?.config.update({ legacyBackup, savedEnrollments: undefined });
        this.#legacyBackup = legacyBackup;
      }
      this.#advance("connect", 0, "Connecting this computer…");
      const login = await installer.login();
      await this.#timed("sign_in_as", () =>
        this.#signInAs(home, job.origin, login.email, login.password),
      );
      // The installation this window used in the same location is the same
      // server, at another origin when the installer moved its web port.
      const previous = await this.#readRecord();
      await this.#writeRecord({
        home,
        repo,
        origin: job.origin,
        version: this.#options.version,
      });
      await this.#pruneSources(home, [repo]);
      this.#home = home;
      this.#location = undefined;
      this.#ready(
        job.origin,
        previous?.home === home ? previous.origin : undefined,
      );
      this.#daemonConnection = undefined;
      await this.#timed("enroll", () =>
        this.#ctx!.get<EnrollmentModule>("Enrollment").enroll(),
      );
      this.#ctx
        ?.get<WindowManagerModule>("WindowManager")
        .preloadAuthenticated(job.origin);
      this.#advance("agents", 0, "Preparing your agents…");
      await this.#timed("await_agents", () =>
        this.#awaitAgents(job.origin, signal),
      );
      this.#set("ready", "Linger is running on this computer.");
    } catch (error) {
      this.#endSignIn();
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#ctx?.log.warn("local_server.install_failed", {
        step: this.#step,
        error: message,
      });
      this.#set(
        "failed",
        message,
        windowsPrivateRefusal((error as { refusal?: unknown } | null)?.refusal),
        localServerFailure((error as { code?: unknown } | null)?.code),
      );
      throw error;
    } finally {
      this.#releaseBusy();
    }
  }

  #advance(
    step: LocalServerStep,
    share: number,
    message: string,
    transfer?: Transfer,
  ): void {
    const steps = this.#steps();
    share = Math.min(1, Math.max(0, share));
    // Without a download, its stages finish preparing instead.
    if (!steps.includes(step)) {
      step = "prepare";
      share = 0.5 + share / 2;
    }
    // The runtime prepares beside the checkout and both report; neither the
    // step nor the bar moves backwards.
    if (steps.indexOf(step) > steps.indexOf(this.#step)) this.#step = step;
    this.#progress = Math.max(
      this.#progress,
      (steps.indexOf(step) + share) / steps.length,
    );
    this.#transfer = transfer && { ...transfer, label: message };
    this.#set("installing", message);
  }

  // Waits on the "signin" step until the installer finds the runtime signed
  // in, which the person does here or in a terminal; resolves with another
  // runtime when they choose one instead. Nothing shows when it already is.
  async #awaitSignIn(
    installer: InstallerApi,
    signal: AbortSignal,
    setupChoice?: string,
  ): Promise<LocalRuntime | { readonly byok: SetupByokConfig } | undefined> {
    const runtime =
      setupRuntime(setupChoice) ??
      setupRuntime((await this.#runtimeOf(installer, signal)).setupChoice) ??
      "pi";
    this.#signInInstaller = installer;
    this.#switchTo = undefined;
    this.#switchByok = undefined;
    try {
      for (;;) {
        signal.throwIfAborted();
        if (this.#switchByok) return { byok: this.#switchByok };
        if (this.#switchTo) return this.#switchTo;
        const login = await installer.runtimeLogin();
        if (login.state === "ready") {
          if (this.#signIn) {
            this.#ctx?.log.info("local_server.runtime_signed_in", { runtime });
            this.#signIn = { runtime, state: "signed_in" };
            this.#advance("signin", 1, "Signed in");
          }
          return undefined;
        }
        if (!this.#signIn)
          this.#ctx?.log.info("local_server.runtime_sign_in_required", {
            runtime,
          });
        this.#showSignIn(runtime, login);
        const woken = new Promise<void>((resolve) => {
          this.#signInWake = resolve;
        });
        await Promise.race([
          woken,
          delay(this.#options.signInPollMs ?? SIGN_IN_POLL_MS, undefined, {
            signal,
          }),
        ]);
      }
    } finally {
      this.#signInInstaller = undefined;
      this.#signInWake = undefined;
    }
  }

  // Shows the installer's login state on the step.
  #showSignIn(runtime: LocalRuntime, login: RuntimeLogin): void {
    const previous = this.#signIn;
    const state =
      login.state === "idle" || login.state === "ready"
        ? // A failure stays until the person tries again.
          previous?.state === "failed"
          ? "failed"
          : "required"
        : login.state;
    const url = state === "waiting_user" ? login.url : undefined;
    const reason =
      state === "failed"
        ? login.state === "failed"
          ? login.reason
          : previous?.reason
        : undefined;
    this.#signIn = {
      runtime,
      state,
      ...(url ? { url } : {}),
      ...(url && login.deviceCode ? { deviceCode: login.deviceCode } : {}),
      ...(url && login.acceptsCode ? { acceptsCode: true } : {}),
      ...(reason ? { reason } : {}),
      ...(state === "failed"
        ? { message: login.message ?? previous?.message ?? "" }
        : {}),
      ...(url && url === previous?.url && previous.browserFailed
        ? { browserFailed: true }
        : {}),
    };
    // On macOS and Windows, Claude Code and Codex open the browser
    // themselves, on the page that calls back to them; the link they print
    // is the fallback. A device login opens nothing, and on Linux this app
    // asks Codex to leave the browser to it, so those pages open here,
    // where a failure to open shows.
    if (
      url &&
      url !== this.#opened &&
      (this.#signIn.deviceCode || this.#signInMethod === "browser")
    ) {
      this.#opened = url;
      void this.openSignInPage();
    }
    this.#advance("signin", 0, `Sign in to ${RUNTIME_NAMES[runtime]}`);
  }

  #endSignIn(): void {
    this.#signIn = undefined;
    this.#signInInstaller = undefined;
    this.#signInWake = undefined;
    this.#opened = undefined;
    this.#signInMethod = undefined;
  }

  // Whether the window shows the Linger this app installed here and its
  // server still answers as itself; only then can its owner account sign the
  // window in. The services can stop while the app runs, and another program
  // can take their port, so the server is asked every time, at most once per
  // SERVER_CHECK_TTL_MS.
  async servesWindow(): Promise<boolean> {
    const record = await this.#windowRecord();
    if (!record) return false;
    const now = Date.now();
    if (!this.#serverCheck || now - this.#serverCheck.at >= SERVER_CHECK_TTL_MS)
      this.#serverCheck = { at: now, ok: this.#checkServer(record) };
    return this.#serverCheck.ok;
  }

  // The owner account the installer created, read from its private file on
  // every call so the password is never kept in memory.
  async account(): Promise<LocalAccount> {
    const record = await this.#readRecord();
    if (!record) throw new Error("Linger is not installed on this computer.");
    return readLocalAccount(
      path.join(record.home, "instances", LOCAL_INSTANCE),
    );
  }

  // Signs the window in to the installed Linger with its owner account; the
  // password goes from the file to the server and nowhere else.
  async signInWithAccount(): Promise<void> {
    const record = await this.#windowRecord();
    if (!record)
      throw new Error(
        "This window is not showing the Linger on this computer.",
      );
    const account = await this.account();
    try {
      await this.#signInAs(
        record.home,
        record.origin,
        account.email,
        account.password,
      );
    } catch (error) {
      throw new Error(signInFailure(error), { cause: error });
    }
  }

  // The installation the window shows while its services run.
  async #windowRecord(): Promise<LocalRecord | undefined> {
    if (this.#phase !== "ready") return undefined;
    const record = await this.#readRecord();
    const serverUrl = this.#ctx?.config.get().serverUrl;
    return record && serverUrl && sameOrigin(record.origin, serverUrl)
      ? record
      : undefined;
  }

  async #serverIdentity(
    home: string,
    origin: string,
  ): Promise<LocalServerIdentity> {
    try {
      if (this.#options.serverIdentity)
        return await this.#options.serverIdentity(home, origin);
      const identity = await readLocalIdentity({
        root: path.join(home, "instances", LOCAL_INSTANCE),
      });
      return { origin, ...identity };
    } catch (error) {
      throw new LocalServerUnverifiedError("no identity", { cause: error });
    }
  }

  async #checkServer(record: LocalRecord): Promise<boolean> {
    const prove =
      this.#options.proveServer ??
      ((server) => proveLocalServer(server, this.#options.fetch));
    let ok = true;
    let reason: string | undefined;
    try {
      await prove(await this.#serverIdentity(record.home, record.origin));
    } catch (error) {
      ok = false;
      reason = unverifiedReason(error);
    }
    // Only changes are logged, so the periodic checks stay out of the log.
    if (ok !== this.#serverOk)
      this.#ctx?.log[ok ? "info" : "warn"]("local_server.identity", {
        ok,
        ...(reason ? { reason } : {}),
      });
    this.#serverOk = ok;
    return ok;
  }

  async #signInAs(
    home: string,
    origin: string,
    email: string,
    password: string,
  ): Promise<void> {
    try {
      await this.#options.signIn(
        await this.#serverIdentity(home, origin),
        email,
        password,
      );
    } catch (error) {
      if (error instanceof LocalServerUnverifiedError) {
        this.#ctx?.log.warn("local_server.identity_unverified", {
          reason: error.reason,
        });
        // The next question about the account asks the server again.
        this.#serverCheck = undefined;
      }
      throw error;
    }
  }

  // Starts the runtime's own login (the installer runs it), or hands it the
  // code the vendor's page showed. device starts Codex's device-code login,
  // for a browser on another device. On Linux, Codex's browser login opens
  // its page from here rather than from the CLI, so a failure to open shows.
  async startSignIn(code?: string, device = false): Promise<void> {
    const installer = this.#signInInstaller;
    const runtime = this.#signIn?.runtime;
    if (!installer || !runtime) return;
    if (code === undefined)
      this.#signInMethod =
        runtime !== "codex"
          ? undefined
          : device
            ? "device"
            : (this.#options.platform ?? process.platform) === "linux"
              ? "browser"
              : undefined;
    this.#signIn = { runtime, state: "starting" };
    this.#ctx?.bus.emit("local-server.changed");
    const login = await installer
      .runtimeLogin(
        true,
        code,
        code === undefined ? this.#signInMethod : undefined,
      )
      .catch((error: unknown) => ({
        state: "failed" as const,
        message: error instanceof Error ? error.message : String(error),
      }));
    if (this.#signInInstaller !== installer) return;
    if (login.state === "ready") this.#signInWake?.();
    else this.#showSignIn(runtime, login);
  }

  // Stops the runtime's login the person started; they can start it again.
  async cancelSignIn(): Promise<void> {
    const installer = this.#signInInstaller;
    const runtime = this.#signIn?.runtime;
    if (!installer || !runtime) return;
    await installer.cancelRuntimeLogin();
    if (this.#signInInstaller !== installer) return;
    this.#signIn = { runtime, state: "required" };
    this.#opened = undefined;
    this.#signInMethod = undefined;
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Leaves the sign-in for another AI runtime; the installation reruns for
  // it.
  switchRuntime(runtime: LocalRuntime): void {
    if (!this.#signInInstaller || runtime === this.#signIn?.runtime) return;
    this.#switchTo = runtime;
    this.#signInWake?.();
  }

  switchToByok(byok: SetupByokConfig): void {
    if (!this.#signInInstaller) return;
    this.#switchByok = byok;
    this.#signInWake?.();
  }

  // Opens the sign-in page in the default browser. When none opens, the
  // step says so and the page offers the link to copy; the link itself is
  // never logged, since it carries the login's state.
  async openSignInPage(): Promise<void> {
    const url = this.#signIn?.url;
    const open = this.#options.openExternal;
    if (!url || !open || new URL(url).protocol !== "https:") return;
    let failed = false;
    try {
      await open(url);
    } catch (error) {
      failed = true;
      this.#ctx?.log.warn("local_server.sign_in_browser_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const signIn = this.#signIn;
    if (signIn?.url !== url || !!signIn.browserFailed === failed) return;
    const { browserFailed: _, ...rest } = signIn;
    this.#signIn = failed ? { ...rest, browserFailed: true } : rest;
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Whether the source package comes over the network; a bundled one and a
  // developer's checkout are already here.
  #downloadsSource(): boolean {
    const archive = this.#options.sourceArchive;
    return !this.#options.checkout && !!archive && "url" in archive;
  }

  // The steps the setup page shows: downloading only when the source comes
  // over the network.
  #steps(): readonly LocalServerStep[] {
    return LOCAL_STEPS.filter(
      (step) =>
        (step !== "download" || this.#downloadsSource()) &&
        (step !== "signin" || this.#signIn !== undefined),
    );
  }

  // The runtime the installation set up. On Windows the installer's lookup
  // can run for minutes with nothing to report, so after a while the page
  // says what it waits on.
  async #runtimeOf(
    installer: InstallerApi,
    signal: AbortSignal,
  ): Promise<InstanceRuntime> {
    const slow = setTimeout(() => {
      this.#waiting = "runtime";
      this.#ctx?.bus.emit("local-server.changed");
    }, RUNTIME_LOOKUP_HINT_MS);
    try {
      return await installer.runtime(signal);
    } finally {
      clearTimeout(slow);
      this.#waiting = undefined;
    }
  }

  // A refusal or a failure reason stays only with the failure it caused.
  #set(
    phase: LocalServerPhase,
    message: string,
    refusal?: WindowsPrivateRefusal,
    failure?: LocalServerFailure,
  ): void {
    // A failure stays on the step it happened in.
    if (phase !== "installing" && phase !== "ready" && phase !== "failed") {
      this.#progress = 0;
      this.#step = "prepare";
    }
    if (phase === "ready") this.#progress = 1;
    if (phase !== "installing") this.#transfer = undefined;
    this.#phase = phase;
    this.#message = message;
    this.#refusal = phase === "failed" ? refusal : undefined;
    this.#failure = phase === "failed" ? failure : undefined;
    if (phase !== "ready") this.#localModelsDegraded = undefined;
    this.#ctx?.bus.emit("local-server.changed");
  }

  #freeBytes(): number {
    return this.#options.freeBytes ?? LOCATION_FREE_BYTES;
  }

  #macos(): string | undefined {
    if ((this.#options.platform ?? process.platform) !== "darwin")
      return undefined;
    return this.#options.macosVersion?.();
  }

  #target(): string {
    return `${this.#options.platform ?? process.platform}-${this.#options.arch ?? process.arch}`;
  }

  // An install from before the rename keeps legacy names in its instance
  // records; the bundled installer converts them once, before the services
  // start. Returns why this computer's instance in `home` stayed
  // unconverted, for the person to see; other instances it left behind are
  // only logged.
  async #migrateLegacyHome(
    ctx: ModuleContext,
    home: string,
  ): Promise<string | undefined> {
    if (
      !(await legacyMigrationPending(home)) ||
      !existsSync(this.#installerScript())
    )
      return undefined;
    const outcome = await new Promise<LegacyMigrationRun>((resolve) => {
      const child = spawn(
        process.execPath,
        [
          ...linuxNodeFdHygieneArgs(this.#options.platform),
          this.#installerScript(),
          "--home",
          home,
          "--migrate",
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            LINGER_HOME: home,
          },
        },
      );
      let output = "";
      let error = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(-20_000);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        error = (error + chunk.toString("utf8")).slice(-2000);
      });
      child.once("error", (failure) =>
        resolve({ code: null, output, error: failure.message }),
      );
      child.once("close", (code) => resolve({ code, output, error }));
    });
    const { failure, skipped } = legacyMigrationResult(outcome, LOCAL_INSTANCE);
    for (const entry of skipped)
      ctx.log.warn("local_server.legacy_instance_skipped", {
        home,
        instance: entry.instance,
        reason: entry.reason,
      });
    if (failure) {
      ctx.log.warn("local_server.home_migration_failed", {
        home,
        error: failure,
      });
      return failure;
    }
    ctx.log.info("local_server.home_migrated", { home });
    return undefined;
  }

  #installerScript(): string {
    return path.join(this.#options.installerDirectory, "installer.js");
  }

  // The desktop's own files in the default home.
  #desktopDirectory(...parts: string[]): string {
    return path.join(this.#options.home, "desktop", ...parts);
  }

  // Checking this computer and installing may both need Node at once.
  #ensureNode(signal: AbortSignal): Promise<string> {
    // The pinned Node.js and the native services do not start on an older
    // macOS; say so instead of running the installer.
    const macos = this.#macos();
    if (macos && !atLeast(macos, MIN_MACOS))
      return Promise.reject(
        new Error(
          `Linger needs macOS ${MIN_MACOS} or later. This Mac runs macOS ${macos}. Update macOS in System Settings > General > Software Update, then try again.`,
        ),
      );
    this.#node ??= this.#fetchNode(signal).catch((error: unknown) => {
      this.#node = undefined;
      throw error;
    });
    return this.#node;
  }

  async #fetchNode(signal: AbortSignal): Promise<string> {
    const release = NODE_RUNTIME_RELEASES[this.#target()];
    if (!release) throw new Error("No Node.js build for this computer");
    const directory = this.#desktopDirectory(
      "node",
      `v${NODE_RUNTIME_VERSION}`,
    );
    // Windows builds are zips with node.exe at the top.
    const binary =
      (this.#options.platform ?? process.platform) === "win32"
        ? path.join(directory, "node.exe")
        : path.join(directory, "bin", "node");
    if (existsSync(binary)) return binary;
    // A build that bundles the services also bundles this same Node.js: the
    // release archive, or on macOS its signed binary.
    const bundle = await this.#bundledRuntime();
    const bundled = bundle?.node;
    if (
      bundle?.layout === "directory" &&
      bundled?.version === NODE_RUNTIME_VERSION
    ) {
      await this.#copyBundled(
        this.#bundledRuntimeFile(path.dirname(path.dirname(bundled.file))),
        directory,
        { file: path.relative(directory, binary), sha256: bundled.sha256 },
        signal,
      );
      return binary;
    }
    if (
      bundled?.file === release.archive &&
      bundled.sha256 === release.sha256
    ) {
      await this.#extract(
        {
          file: this.#bundledRuntimeFile(bundled.file),
          sha256: bundled.sha256,
        },
        directory,
        path.relative(directory, binary),
        signal,
      );
      return binary;
    }
    const [url, ...mirrors] = nodeRuntimeDownloadUrls(release.archive);
    await this.#unpack(
      {
        url: url!,
        mirrors,
        sha256: release.sha256,
        maxBytes: 256 * MiB,
      },
      directory,
      path.relative(directory, binary),
      this.#desktopDirectory("downloads"),
      signal,
    );
    return binary;
  }

  // The source package, unpacked once into the installation folder; or the
  // developer's checkout.
  async #ensureSource(home: string, signal: AbortSignal): Promise<string> {
    if (this.#options.checkout) {
      const repo = await realpath(this.#options.checkout);
      if (!(await isFile(path.join(repo, "scripts/source-native.mjs"))))
        throw new Error(
          "LINGER_CHECKOUT is not a Linger checkout (scripts/source-native.mjs is missing)",
        );
      return repo;
    }
    const archive = this.#options.sourceArchive;
    if (!archive) throw new Error("This build has no source package");
    const directory = path.join(
      home,
      "desktop",
      "source",
      archive.sha256.slice(0, 16),
    );
    if (await isFile(path.join(directory, SOURCE_MARKER))) {
      if (
        await validateSourceRepository(directory).then(
          () => true,
          () => false,
        )
      ) {
        await this.#timed("teamhub_binaries", () =>
          this.#ensureTeamhubBinaries(directory, archive.sha256, signal),
        );
        await this.#timed("native_runtime", () =>
          this.#ensureNativeRuntime(directory, archive.sha256, signal),
        );
        return directory;
      }
      // This package's own folder, damaged since it was unpacked (files
      // removed by hand or by a cleanup): the installer would refuse it, so
      // it is unpacked again in its place.
      this.#ctx?.log.warn("local_server.source_damaged", {
        source: path.basename(directory),
      });
      await removeRetrying(directory);
    }
    if ("file" in archive)
      await this.#extract(archive, directory, SOURCE_MARKER, signal);
    else
      await this.#unpack(
        { ...archive, maxBytes: 1024 * MiB },
        directory,
        SOURCE_MARKER,
        path.join(home, "desktop", "downloads"),
        signal,
        (bytes) =>
          this.#advance(
            "download",
            (bytes.completed / bytes.total) * 0.05,
            "Downloading Linger…",
            bytes,
          ),
      );
    if (!(await isFile(path.join(directory, SOURCE_MARKER))))
      throw new Error("The source package is not a Linger source tree");
    await this.#timed("teamhub_binaries", () =>
      this.#ensureTeamhubBinaries(directory, archive.sha256, signal),
    );
    await this.#timed("native_runtime", () =>
      this.#ensureNativeRuntime(directory, archive.sha256, signal),
    );
    return directory;
  }

  // The manifest of the services and Node.js this build bundles for this
  // computer (scripts/build-native-runtime.mjs), or undefined without them.
  async #bundledRuntime(): Promise<BundledRuntime | undefined> {
    try {
      return JSON.parse(
        await readFile(this.#bundledRuntimeFile("manifest.json"), "utf8"),
      ) as BundledRuntime;
    } catch {
      return undefined;
    }
  }

  #bundledRuntimeFile(file: string): string {
    return path.join(
      this.#options.installerDirectory,
      "native",
      `runtime-${this.#target()}`,
      file,
    );
  }

  // Unpacks the services this build compiled from its source package into
  // the source, so Native installs no packages and needs no network. Without
  // them Native installs the source's packages and runs it in development.
  async #ensureNativeRuntime(
    repo: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const bundle = await this.#bundledRuntime();
    if (!bundle) return;
    const target = this.#target();
    const directory = path.join(repo, NATIVE_RUNTIME_DIRECTORY);
    const glibc = this.#glibcVersion();
    if (glibc && !atLeast(glibc, MIN_GLIBC)) {
      // Its native packages, like the PostgreSQL build, need a newer glibc;
      // Native installs the source's packages instead.
      this.#ctx?.log.warn("local_server.native_runtime_skipped", {
        glibc,
        required: MIN_GLIBC,
      });
      return;
    }
    try {
      if (bundle.target !== target || bundle.sourceArchiveSha256 !== sha256)
        throw new Error("The bundled services are for another source package");
      const current = await readNativeRuntime(directory).catch(() => undefined);
      if (
        current?.target === target &&
        current.sourceArchiveSha256 === sha256 &&
        (await nativeRuntimeVerified(directory))
      )
        return;
      this.#advance("download", 0.05, "Unpacking Linger services…");
      await removeRetrying(directory);
      if (bundle.layout === "directory")
        await this.#copyBundled(
          this.#bundledRuntimeFile(path.dirname(bundle.directory!.file)),
          directory,
          {
            file: path.basename(bundle.directory!.file),
            sha256: bundle.directory!.sha256,
          },
          signal,
        );
      else {
        const file = this.#bundledRuntimeFile(bundle.archive!.file);
        await this.#checkArchive(file, bundle.archive!.sha256, signal);
        // Unpacked in place: renaming a folder of fresh files waited up to
        // 30 s for Windows' scanners.
        await this.#unpackInto(file, directory, signal);
      }
      // The record written last marks it complete, and the installer then
      // need not hash every file.
      await markNativeRuntimeVerified(directory);
      this.#ctx?.log.info("local_server.native_runtime", { target });
    } catch (error) {
      if (signal.aborted) throw error;
      await removeRetrying(directory).catch(() => undefined);
      this.#ctx?.log.warn("local_server.native_runtime_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The glibc this Linux computer runs, or undefined elsewhere.
  #glibcVersion(): string | undefined {
    if ((this.#options.platform ?? process.platform) !== "linux") return;
    if (this.#options.glibcVersion) return this.#options.glibcVersion;
    const report = process.report.getReport() as
      | { header?: { glibcVersionRuntime?: string } }
      | undefined;
    return report?.header?.glibcVersionRuntime;
  }

  // Copies a folder the app bundles unpacked (macOS) to `directory`, which
  // appears only once complete; `check` is a file in it with its sha256.
  // Files copied out of a downloaded app keep its quarantine, and macOS would
  // refuse to run the binaries among them.
  async #copyBundled(
    from: string,
    directory: string,
    check: { file: string; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    if (existsSync(path.join(directory, check.file))) return;
    const copied = `${directory}.partial`;
    try {
      await removeRetrying(copied);
      await mkdir(path.dirname(copied), { recursive: true });
      // A clone on APFS: no extra space and no time.
      await cp(from, copied, {
        recursive: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(
        path.join(copied, check.file),
        { signal },
      ))
        hash.update(chunk as Buffer);
      if (hash.digest("hex") !== check.sha256)
        throw new Error(`The bundled ${check.file} is damaged`);
      await this.#unquarantine(copied, signal);
      await this.#publish(copied, directory, check.file, signal);
    } finally {
      await removeRetrying(copied);
    }
  }

  async #unquarantine(directory: string, signal: AbortSignal): Promise<void> {
    if ((this.#options.platform ?? process.platform) !== "darwin") return;
    await run(
      "/usr/bin/xattr",
      ["-dr", "com.apple.quarantine", directory],
      directory,
      signal,
    ).catch((error: unknown) => {
      if (signal.aborted) throw error;
      this.#ctx?.log.warn("local_server.unquarantine_failed", {
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // Copies the TeamHub binaries this build compiled from its source package
  // into the source, so Native runs them instead of compiling. Without them
  // Native downloads Go and compiles TeamHub itself.
  async #ensureTeamhubBinaries(
    repo: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const target = this.#target();
    try {
      const state = await installTeamhubBinaries(
        path.join(
          this.#options.installerDirectory,
          "native",
          `teamhub-${target}`,
        ),
        repo,
        { target, sourceArchiveSha256: sha256 },
      );
      if (state === "installed") {
        await this.#unquarantine(
          path.join(repo, TEAMHUB_BINARY_DIRECTORY),
          signal,
        );
        this.#ctx?.log.info("local_server.teamhub_binaries", { target });
      }
    } catch (error) {
      this.#ctx?.log.warn("local_server.teamhub_binaries_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Unpacks the published dependency store into the checkout, so installing
  // its packages needs no registry. Without it, the installer downloads them.
  async #ensureDependencies(repo: string, signal: AbortSignal): Promise<void> {
    const bundle = this.#options.sourceDependencies;
    if (this.#options.checkout || !bundle) return;
    const store = path.join(repo, DEPENDENCY_STORE);
    if (existsSync(store)) return;
    const message = "Downloading Linger dependencies…";
    this.#advance("download", 0.05, message);
    try {
      await this.#unpack(
        { ...bundle, maxBytes: 4 * GiB },
        store,
        ".",
        path.join(path.dirname(path.dirname(repo)), "downloads"),
        signal,
        (bytes) =>
          this.#advance(
            "download",
            0.05 + (bytes.completed / bytes.total) * 0.05,
            message,
            bytes,
          ),
      );
    } catch (error) {
      if (signal.aborted) throw error;
      this.#ctx?.log.warn("local_server.dependencies_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Keys used to go in the unpacked source package's .env, which the next
  // update deleted. They move once into the instance's user.env, which the
  // installer reads and every update keeps; a developer's checkout is left
  // alone.
  async #adoptSourceKeys(home: string): Promise<void> {
    if (this.#options.checkout) return;
    const parent = path.join(home, "desktop", "source");
    const root = path.join(home, "instances", LOCAL_INSTANCE);
    for (const entry of await readdir(parent).catch(() => [] as string[])) {
      const moved = await adoptUserEnvironment(
        root,
        path.join(parent, entry, ".env"),
        (keys) => this.#ctx?.log.warn("local_server.keys_not_moved", { keys }),
      );
      if (moved.length)
        this.#ctx?.log.info("local_server.keys_moved", { keys: moved });
    }
  }

  // Each version unpacks beside the last and builds its own dependencies, so
  // once services run from this one the older ones only fill the disk.
  async #pruneSources(
    home: string,
    keep: readonly (string | undefined)[],
  ): Promise<void> {
    if (this.#options.checkout) return;
    const parent = path.join(home, "desktop", "source");
    const kept = keep.flatMap((item) => (item ? [path.basename(item)] : []));
    const prunable = (
      await readdir(parent).catch(() => [] as string[])
    ).flatMap((entry) =>
      kept.includes(entry) ? [] : [path.join(parent, entry)],
    );
    if (!prunable.length) return;
    // A service still running from a folder (its restart onto the kept one
    // has not happened, or failed) would lose its files under it.
    const inUse = await foldersInUse(prunable);
    for (const folder of prunable) {
      if (inUse.has(folder)) {
        this.#ctx?.log.info("local_server.source_in_use", {
          source: path.basename(folder),
        });
        continue;
      }
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // Downloads a verified archive and unpacks its single top-level folder
  // into `directory`, which appears only once complete; `marker` is a file
  // every complete one has. Sources in the installation's download region
  // come first (nodejs.org or its China mirror for Node.js), and the
  // installer it starts reads the region resolved here.
  async #unpack(
    archive: {
      url: string;
      mirrors?: readonly string[];
      sha256: string;
      maxBytes: number;
    },
    directory: string,
    marker: string,
    downloads: string,
    signal: AbortSignal,
    onBytes?: (bytes: { completed: number; total: number }) => void,
  ): Promise<void> {
    await mkdir(downloads, { recursive: true, mode: 0o700 });
    const file = path.join(
      downloads,
      path.basename(new URL(archive.url).pathname),
    );
    const unpacked = `${directory}.partial`;
    try {
      await downloadInRegion(
        this.#location ?? this.#home,
        {
          url: archive.url,
          ...(archive.mirrors && { mirrors: archive.mirrors }),
          output: file,
          algorithm: "sha256",
          digest: archive.sha256,
          maxBytes: archive.maxBytes,
          signal,
          // A retry continues a large download where it stopped.
          resumable: true,
          onProgress: (completed, total) =>
            total && onBytes?.({ completed, total }),
        },
        followHttps(this.#options.fetch ?? fetch),
      );
      await this.#unpackInto(file, unpacked, signal);
      await this.#publish(unpacked, directory, marker, signal);
    } finally {
      await rm(file, { force: true });
      await removeRetrying(unpacked);
    }
  }

  // Unpacks an archive bundled in the app after checking its digest.
  async #extract(
    archive: { file: string; sha256: string },
    directory: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<void> {
    const file = path.resolve(this.#options.installerDirectory, archive.file);
    await this.#checkArchive(file, archive.sha256, signal);
    const unpacked = `${directory}.partial`;
    try {
      await this.#unpackInto(file, unpacked, signal);
      await this.#publish(unpacked, directory, marker, signal);
    } finally {
      await removeRetrying(unpacked);
    }
  }

  async #checkArchive(
    file: string,
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal }))
      hash.update(chunk as Buffer);
    if (hash.digest("hex") !== sha256)
      throw new Error(`The bundled ${path.basename(file)} is damaged`);
  }

  // Unpacks the archive's single top-level folder into an empty `unpacked`.
  // tar runs inside it and names the archive relative to it: those paths
  // stay ASCII under any user or chosen folder name, which Windows' tar.exe
  // may otherwise read in the ANSI code page.
  async #unpackInto(
    file: string,
    unpacked: string,
    signal: AbortSignal,
  ): Promise<void> {
    await unpackArchive(file, unpacked, signal, {
      onFallback: (command) =>
        this.#ctx?.log.warn("local_server.tar_fallback", {
          command,
          archive: path.basename(file),
        }),
    });
  }

  // Moves a finished `unpacked` folder to `directory`. One that is already
  // complete there stays; a half-done one is replaced. Windows can hold the
  // fresh files for a moment (antivirus, indexing), so the move waits that
  // out and the log keeps each locked attempt.
  async #publish(
    unpacked: string,
    directory: string,
    marker: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (existsSync(path.join(directory, marker))) return;
    await removeRetrying(directory);
    await renameRetrying(unpacked, directory, {
      ...(this.#options.platform ? { platform: this.#options.platform } : {}),
      ...(this.#options.rename ? { rename: this.#options.rename } : {}),
      signal,
      onRetry: (error, attempt) =>
        this.#ctx?.log.warn("local_server.rename_locked", {
          directory,
          attempt,
          code: error.code,
          error: error.message,
        }),
    });
  }

  // The system proxy for the installer runs that start the services, which
  // pass it to TeamHub and node-services only. Logged without its address.
  async #systemProxyEnv(): Promise<Record<string, string>> {
    const startedAt = Date.now();
    const proxy = await systemProxy(process.env, this.#options.resolveProxy);
    this.#ctx?.log.info("local_server.system_proxy", {
      source: proxy.source,
      ms: Date.now() - startedAt,
    });
    return proxy.env;
  }

  // Saves the provider keys with the installer, before it installs; the keys go
  // over stdin, never in arguments or logs.
  async #saveKeys(
    node: string,
    home: string,
    changes: ProviderKeyChanges,
    signal: AbortSignal,
  ): Promise<void> {
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        node,
        [
          ...linuxNodeFdHygieneArgs(this.#options.platform),
          this.#installerScript(),
          "--home",
          home,
          "--instance",
          LOCAL_INSTANCE,
          "--user-keys",
        ],
        {
          stdio: ["pipe", "pipe", "ignore"],
          windowsHide: true,
          env: { ...process.env, LINGER_HOME: home },
          signal,
        },
      );
      let text = "";
      child.stdout.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("close", () => resolve(text));
      child.stdin.end(JSON.stringify(installerKeyChanges(changes)));
    });
    let outcome: { saved?: unknown; error?: unknown; refusal?: unknown } = {};
    try {
      outcome = JSON.parse(output.trim().split("\n").at(-1) ?? "") as never;
    } catch {
      // Reported below.
    }
    if (!Array.isArray(outcome.saved))
      throw Object.assign(
        new Error(
          typeof outcome.error === "string"
            ? `Keys could not be saved: ${outcome.error}`
            : "Keys could not be saved",
        ),
        { refusal: windowsPrivateRefusal(outcome.refusal) },
      );
    this.#ctx?.log.info("local_server.keys_saved", { saved: outcome.saved });
    this.#ctx?.bus.emit("local-server.changed");
  }

  // Starts the installer manager (or reaches the one already running) and
  // opens an API session with the one-time token from its private launcher.
  async #launchInstaller(
    node: string,
    home: string,
    repo: string,
    signal: AbortSignal,
  ): Promise<InstallerApi> {
    const proxyEnv = await this.#systemProxyEnv();
    const child = spawn(
      node,
      [
        ...linuxNodeFdHygieneArgs(this.#options.platform),
        this.#installerScript(),
        "--home",
        home,
        "--source-repo",
        repo,
        "--external-computer",
        "--instance",
        LOCAL_INSTANCE,
        "--no-open",
      ],
      {
        detached: true,
        // A detached Windows process otherwise opens its own console window.
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...proxyEnv, LINGER_HOME: home },
      },
    );
    const log = this.#ctx?.log;
    // The installer explains a failed start on stderr in one write, which
    // can span lines (one reason per instance); keep the last one whole.
    let reason = "";
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      reason = text.trim().slice(0, 1500) || reason;
    });
    // By line, so a timing event split across chunks still parses.
    createInterface({ input: child.stderr }).on("line", (line) => {
      if (!line.trim()) return;
      const event = installerTimingEvent(line);
      if (event)
        log?.info("local_server.installer_runtime_timings", { ...event });
      else
        log?.warn("local_server.installer_stderr", {
          line: line.slice(0, 1500),
        });
    });
    const origin = await new Promise<string>((resolve, reject) => {
      let output = "";
      const fail = (message: string) => {
        child.stdout.removeAllListeners("data");
        reject(
          Object.assign(new Error(message), {
            refusal: startRefusal(output),
          }),
        );
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        const match =
          /Installer is running at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
        if (match) resolve(match[1]!);
      });
      child.once("error", () => fail("The installer could not start"));
      // "close" follows exit once stderr, which explains it, is drained.
      child.once("close", () =>
        fail(
          reason
            ? `The installer stopped while starting. ${reason}`
            : "The installer stopped while starting",
        ),
      );
      signal.addEventListener("abort", () => fail("Cancelled"), { once: true });
    });
    child.stdout.resume();
    child.unref();
    const launcher = await readFile(
      path.join(home, "installer", "launch.html"),
      "utf8",
    );
    const target = /url=([^"]+)"/.exec(launcher)?.[1]?.replaceAll("&amp;", "&");
    if (!target || new URL(target).origin !== origin)
      throw new Error("The installer did not provide a sign-in link");
    return InstallerApi.open(
      target,
      this.#options.fetch ?? fetch,
      this.#options.pollMs ?? 1000,
      this.#ctx?.log,
    );
  }

  // `previous` is the origin this installation answered at before.
  #ready(
    origin: string,
    previous?: string,
    reason: WindowLoadReason = "local_ready",
  ): void {
    this.#origin = origin;
    this.#ctx
      ?.get<WindowManagerModule>("WindowManager")
      ?.setServer(origin, previous, { reason });
  }

  // The server sets up the Another Me once this computer offers a signed-in
  // Runtime, then the starter Agents and their Room. Setup ends when they are
  // there, so the app opens with them rather than filling in afterwards.
  async #awaitAgents(origin: string, signal: AbortSignal): Promise<void> {
    const cookie = await this.#options.sessionCookie?.(origin);
    if (!cookie) return;
    const get = async (pathname: string): Promise<unknown> => {
      const response = await (this.#options.fetch ?? fetch)(
        new URL(pathname, origin),
        {
          headers: { accept: "application/json", cookie },
          redirect: "error",
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        },
      );
      if (response.status === 404) return undefined;
      if (!response.ok)
        throw new Error(`${pathname} failed (${String(response.status)})`);
      return response.json();
    };
    const tenant = humanTenant(await get("/v0/me"));
    if (!tenant) return;
    const base = `/v0/tenants/${encodeURIComponent(tenant)}`;
    const timeout = this.#options.agentsTimeoutMs ?? AGENTS_TIMEOUT_MS;
    const deadline = Date.now() + timeout;
    for (;;) {
      signal.throwIfAborted();
      // A Computer service that cannot start never connects; waiting out the
      // deadline would only hide why.
      if (this.#daemonFailure) {
        this.#ctx?.log.warn("local_server.computer_failed", {
          reason: this.#daemonFailure,
        });
        throw new Error(computerServiceFailed(this.#daemonFailure));
      }
      if (this.#daemonConnection === "identity_conflict") {
        this.#ctx?.log.warn("local_server.computer_identity_conflict");
        throw new Error(
          "This computer's local identity is already connected to another Computer registration. Choose Reconnect This Computer in the Linger menu, or remove the duplicate Computer and try again.",
        );
      }
      if (this.#daemonConnection === "auth_failed") {
        this.#ctx?.log.warn("local_server.computer_auth_failed");
        throw new Error(
          "This computer's sign-in expired before it could connect. Choose Reconnect This Computer in the Linger menu, then try again.",
        );
      }
      if (this.#daemonConnection === "upgrade_required") {
        this.#ctx?.log.warn("local_server.computer_upgrade_required");
        throw new Error(
          "This computer's Linger app is too old for the server. Update Linger, then try again.",
        );
      }
      // The Another Me has an Agent once the server created it; there is no
      // status to wait for.
      const anotherMe = (await get(`${base}/another-me`)) as
        | { agent_actor_id?: string }
        | undefined;
      if (!anotherMe) return;
      if (anotherMe.agent_actor_id) {
        const rooms = (await get(`${base}/rooms`)) as
          | { items?: { name?: string }[] }
          | undefined;
        const starterReady = rooms?.items?.some(
          (room) => room.name === STARTER_ROOM,
        );
        if (starterReady || Date.now() >= deadline) {
          const computerId = this.#ctx?.config.get().computerId;
          if (!computerId) return;
          const computers = (await get(`${base}/local-computers`).catch(
            () => undefined,
          )) as { items?: ReportedComputer[] } | undefined;
          if (!computers) return;
          const computer = computers.items?.find(
            (item) => item.computer_id === computerId,
          );
          if (computer?.status === "online" && !computer.upgrade_required)
            return;
          if (Date.now() >= deadline) {
            this.#ctx?.log.warn("local_server.computer_offline_after_agents", {
              computer_id: computerId,
              computer_status: computer?.status,
            });
            throw new Error(computerNotOnline(computer));
          }
          this.#advance("agents", 0.8, "Connecting this computer…");
        } else {
          this.#advance("agents", 0.6, "Adding your starter agents…");
        }
      } else {
        if (Date.now() >= deadline) {
          // Say what the server is missing, as this computer last reported it.
          const computers = (await get(`${base}/local-computers`).catch(
            () => undefined,
          )) as { items?: ReportedComputer[] } | undefined;
          const computerId = this.#ctx?.config.get().computerId;
          const computer = computers?.items?.find(
            (item) => item.computer_id === computerId,
          );
          this.#ctx?.log.warn("local_server.another_me_missing", {
            computer_id: computerId,
            computer_status: computer?.status,
            runtimes: computer?.runtimes?.map(
              (runtime) =>
                `${runtime.type}:${runtime.status}:${runtime.models?.length ?? 0}`,
            ),
          });
          throw new Error(
            anotherMeMissing(computers ? computer : null, timeout),
          );
        }
        this.#advance("agents", 0.2, "Preparing your Another Me…");
      }
      await delay(this.#options.pollMs ?? 1_000, undefined, { signal });
    }
  }

  // Runs the installer headless against the saved instance; it starts only
  // the services that are not running and asks for nothing. When this app
  // brings a newer source package (it was installed over an older one), the
  // services move to it first: the window and the Computer already are this
  // version, and the older services would serve the older interface.
  async #resume(record: LocalRecord, signal: AbortSignal): Promise<void> {
    let currentRecord = record;
    this.#origin = record.origin;
    this.#resuming = true;
    const startedAt = Date.now();
    let stage = "fast_ready_check";
    this.#ctx?.log.info("local_server.resume_started");
    const windows = this.#ctx?.get<WindowManagerModule>("WindowManager");
    this.#acquireBusy();
    try {
      const update = this.#sourceUpdate(currentRecord);
      if (update) {
        // The services restart even if they still answer.
        this.#preparing = "updating";
        this.#set("preparing", "Updating Linger on this computer…");
        windows?.showUpdating();
      } else {
        this.#preparing = "starting";
        this.#set("preparing", "Starting Linger on this computer…");
        // The window would show the server as unreachable until it is back.
        const checkStartedAt = Date.now();
        let reachable = await this.#reachable(currentRecord.origin);
        if (!reachable) {
          // If an earlier restart moved the instance onto a new port before
          // desktop state caught up, follow the live origin right away instead
          // of showing Starting with the stale port.
          const moved = await this.#readInstanceOrigin(currentRecord.home);
          if (
            moved &&
            !sameOrigin(moved, currentRecord.origin) &&
            (await this.#reachable(moved)) &&
            (await this.#checkServer({ ...currentRecord, origin: moved }))
          ) {
            const previous = currentRecord.origin;
            currentRecord = { ...currentRecord, origin: moved };
            await this.#writeRecord(currentRecord);
            this.#ctx?.log.info("local_server.origin_moved", {
              from: previous,
              to: moved,
            });
            this.#ready(moved, previous, "port_moved");
            reachable = true;
          }
        }
        this.#ctx?.log.info("local_server.resume_stage", {
          stage: "fast_ready_check",
          ms: Date.now() - checkStartedAt,
        });
        if (!reachable) windows?.showStarting();
      }
      // A source folder the installer no longer runs is unpacked again from
      // this app's package: one removed since (by hand, or a cleanup that an
      // uninstall left half done), or one the earlier Simplex app unpacked.
      const repo =
        this.#options.sourceArchive &&
        !this.#options.checkout &&
        (update ||
          !(await validateSourceRepository(currentRecord.repo).then(
            () => true,
            () => false,
          )))
          ? await this.#ensureSource(currentRecord.home, signal)
          : currentRecord.repo;
      const serving = await this.#runResume(
        currentRecord,
        repo,
        signal,
        (next) => {
          stage = next;
        },
      );
      // The installer moves the web port off one another program took. The
      // record and the window follow the origin together (a launch resumes
      // only while they agree), and so does this computer's enrollment: it
      // is the same server.
      const origin =
        serving.origin ??
        (await this.#readInstanceOrigin(currentRecord.home)) ??
        currentRecord.origin;
      if (repo !== currentRecord.repo) {
        // The record moves, and the older folder goes, only once the
        // services run from the new one and answer; until then the older
        // services keep running from their folder, and Retry moves them.
        if (
          serving.source !== (await realpath(repo).catch(() => repo)) ||
          !(await this.#reachable(origin))
        )
          throw new Error(
            "Linger could not restart on this version. The earlier version is still installed; try again.",
          );
        await this.#moved({ ...currentRecord, origin }, repo);
      } else if (origin !== currentRecord.origin)
        await this.#writeRecord({ ...currentRecord, origin });
      if (origin !== currentRecord.origin)
        this.#ctx?.log.info("local_server.origin_moved", {
          from: currentRecord.origin,
          to: origin,
        });
      if (update)
        this.#ctx?.log.info("local_server.source_updated", {
          source: path.basename(repo),
          from: currentRecord.version,
        });
      this.#ready(origin, currentRecord.origin, "resume_ready");
      this.#set("ready", "Linger is running on this computer.");
      this.#ctx?.log.info("local_server.resume_succeeded", {
        total_ms: Date.now() - startedAt,
      });
    } catch (error) {
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#ctx?.log.warn("local_server.resume_failed", {
        stage,
        total_ms: Date.now() - startedAt,
        error: this.#formatResumeError(message),
      });
      this.#set("failed", message);
      windows?.showStartFailed(message);
    } finally {
      this.#releaseBusy();
      this.#resuming = false;
    }
  }

  // The person gave up on the installation the window used, whose services
  // do not start (it may have been removed or left broken by an uninstall):
  // forget it and this computer's enrollment with it, and show setup. Its
  // Install sets this computer up again in the same location, keeping what
  // is left of that instance.
  async #reset(): Promise<void> {
    const ctx = this.#ctx!;
    try {
      await rm(this.#recordFile(), { force: true });
      this.#origin = undefined;
      this.#set("idle", "");
      ctx.log.info("local_server.reset");
      await ctx.get<EnrollmentModule>("Enrollment").unenroll();
      ctx.config.update({ serverUrl: undefined });
      ctx.get<WindowManagerModule>("WindowManager").loadServer();
    } catch (error) {
      ctx.log.warn("local_server.reset_failed", { error: String(error) });
    }
    ctx.bus.emit("setup.open");
  }

  // The services can stop while the window shows them. Their supervisors
  // restart them, so one that does not answer first gets `graceMs` to come
  // back, checked again during it; one still silent after that (its
  // supervisor gave up or was ended too) is resumed like a launch: the
  // installer starts what is not running.
  async #recoverUnreachable(
    trigger: "retry" | "load_failed" | "watch",
    graceMs: number,
    throttled: boolean,
  ): Promise<void> {
    if (this.#recovering || this.#resuming || this.#phase !== "ready") return;
    if (
      throttled &&
      this.#recoveredAt !== undefined &&
      Date.now() - this.#recoveredAt < RECOVERY_INTERVAL_MS
    )
      return;
    this.#recovering = true;
    try {
      let record = await this.#windowRecord();
      if (!record || (await this.#stillAnswers(record.origin))) return;
      const checks = graceMs > 0 ? UNREACHABLE_PROBES - 1 : 0;
      for (let check = 0; check < checks; check++) {
        await delay(graceMs / checks, undefined, {
          signal: this.#abort.signal,
        });
        if (this.#resuming) return;
        record = await this.#windowRecord();
        if (!record || (await this.#stillAnswers(record.origin))) return;
      }
      this.#recoveredAt = Date.now();
      this.#ctx?.log.warn("local_server.unreachable_resume", { trigger });
      await this.#resume(record, this.#abort.signal);
    } catch {
      // Aborted by stop.
    } finally {
      this.#recovering = false;
    }
  }

  // Whether the services already answer, such as after only the app quit.
  #reachable(origin: string): Promise<boolean> {
    return answers(this.#options.fetch ?? fetch, origin);
  }

  // Whether a ready server still answers, given more time than a launch's
  // fast check.
  #stillAnswers(origin: string): Promise<boolean> {
    return answers(
      this.#options.fetch ?? fetch,
      origin,
      UNREACHABLE_PROBE_TIMEOUT_MS,
    );
  }

  // Whether the services run another source package than this app brings,
  // one that an older app unpacked. An older app installed over a newer one
  // leaves its services as they are: the newer services may have changed
  // the data in ways the older ones do not know.
  #sourceUpdate(record: LocalRecord): boolean {
    const archive = this.#options.sourceArchive;
    if (
      this.#options.checkout ||
      !archive ||
      path.basename(record.repo) === archive.sha256.slice(0, 16)
    )
      return false;
    if (
      record.version &&
      compareVersions(record.version, this.#options.version) > 0
    ) {
      this.#ctx?.log.warn("local_server.source_newer_than_app", {
        installed: record.version,
        app: this.#options.version,
      });
      return false;
    }
    return true;
  }

  async #moved(record: LocalRecord, repo: string): Promise<void> {
    await this.#writeRecord({
      ...record,
      repo,
      version: this.#options.version,
    });
    await this.#pruneSources(record.home, [repo]);
  }

  // Resolves with the source folder the installer reports the services
  // serving from, and the origin they serve at.
  async #runResume(
    record: LocalRecord,
    repo: string,
    signal: AbortSignal,
    onStage?: (stage: string) => void,
  ): Promise<{ source?: string; origin?: string }> {
    await this.#adoptSourceKeys(record.home);
    // Resolved while the Node runtime is checked, so a slow PAC script does
    // not add to the start.
    const proxyEnv = this.#systemProxyEnv();
    onStage?.("ensure_node");
    const nodeStartedAt = Date.now();
    const node = await this.#ensureNode(signal);
    this.#ctx?.log.info("local_server.resume_stage", {
      stage: "ensure_node",
      ms: Date.now() - nodeStartedAt,
    });
    const env = {
      ...process.env,
      ...(await proxyEnv),
      LINGER_HOME: record.home,
    };
    onStage?.("installer_resume");
    const resumeStartedAt = Date.now();
    const outcome = await new Promise<ResumeOutcome>((resolve, reject) => {
      const child = spawn(
        node,
        [
          ...linuxNodeFdHygieneArgs(this.#options.platform),
          this.#installerScript(),
          "--home",
          record.home,
          "--source-repo",
          repo,
          "--external-computer",
          "--instance",
          LOCAL_INSTANCE,
          "--resume",
        ],
        {
          stdio: ["ignore", "pipe", "ignore"],
          // The pinned Node is a console program; without this Windows
          // opens a console window for it.
          windowsHide: true,
          env,
          signal,
        },
      );
      let output = "";
      let settled = false;
      let exited = false;
      let exitedCode: number | null = null;
      let drainTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null, destroyStdout = false) => {
        if (settled) return;
        settled = true;
        if (drainTimer) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
        if (destroyStdout) child.stdout.destroy();
        const parsed = parseResumeOutcome(output);
        if (parsed) resolve(parsed);
        else reject(new Error(`The installer exited with code ${code}`));
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (exited && !settled && parseResumeOutcome(output, true))
          finish(exitedCode, true);
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        if (drainTimer) {
          clearTimeout(drainTimer);
          drainTimer = undefined;
        }
        child.stdout.destroy();
        reject(error);
      });
      child.once("close", (code) => finish(code));
      // Detached native services spawned during --resume can inherit the
      // stdout pipe handle on Windows and keep "close" from firing after the
      // installer already flushed its outcome JSON and exited. Settle at once
      // when a complete outcome line is already buffered; otherwise wait for
      // trailing pipe chunks or end up to a short safety cap.
      child.once("exit", (code) => {
        if (settled) return;
        exited = true;
        exitedCode = code;
        if (parseResumeOutcome(output, true)) {
          finish(code, true);
          return;
        }
        child.stdout.once("end", () => finish(code));
        drainTimer = setTimeout(() => finish(code, true), 1_000);
        drainTimer.unref?.();
      });
    });
    this.#ctx?.log.info("local_server.resume_stage", {
      stage: "installer_resume",
      ms: Date.now() - resumeStartedAt,
    });
    const lookupTimings = runtimeLookupTimingFields(
      outcome.runtimeLookupTimings,
    );
    if (lookupTimings)
      this.#ctx?.log.info("local_server.installer_runtime_timings", {
        instance: LOCAL_INSTANCE,
        ...lookupTimings,
      });
    if (outcome.code !== 0) {
      const { code, causeCode, reasons } = outcome.details ?? {};
      const action =
        code === "LOCAL_MODELS_RECOVERY_REQUIRED" &&
        typeof causeCode === "string" &&
        REPLAN_ONLY_CAUSES.has(causeCode)
          ? RESUME_REPLAN_ACTION
          : typeof code === "string" && Object.hasOwn(RESUME_ACTIONS, code)
            ? RESUME_ACTIONS[code]
            : undefined;
      const notReady = localModelNotReadyMessage(reasons);
      throw new Error(
        [notReady, outcome.message || "The installation stopped", action]
          .filter(Boolean)
          .join(" "),
      );
    }
    // The services run without the BYOK gateway; the Computer mounts it
    // again before the next Run on it, so this only leaves a trace.
    const byokGateway = outcome.details?.byokGateway as
      | { code?: unknown; message?: unknown }
      | null
      | undefined;
    if (
      byokGateway &&
      typeof byokGateway === "object" &&
      typeof byokGateway.code === "string"
    )
      this.#ctx?.log.warn("local_server.byok_gateway_unavailable", {
        code: byokGateway.code,
        message:
          typeof byokGateway.message === "string" ? byokGateway.message : "",
      });
    // The services run without local models; the person can still reach the
    // workspace and the Models page to manage local models or switch runtimes.
    const localModelsDegraded = outcome.details?.localModelsDegraded as
      | { code?: unknown; message?: unknown; reasons?: unknown }
      | null
      | undefined;
    if (
      localModelsDegraded &&
      typeof localModelsDegraded === "object" &&
      typeof localModelsDegraded.code === "string"
    ) {
      const degradedReasons = Array.isArray(localModelsDegraded.reasons)
        ? localModelsDegraded.reasons.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      const degraded: LocalModelsDegradedStatus = {
        code: localModelsDegraded.code,
        message:
          typeof localModelsDegraded.message === "string"
            ? localModelsDegraded.message
            : "",
        ...(degradedReasons.length ? { reasons: degradedReasons } : {}),
      };
      this.#localModelsDegraded = degraded;
      this.#ctx?.log.warn("local_server.local_models_unavailable", {
        ...degraded,
      });
    } else {
      this.#localModelsDegraded = undefined;
    }
    this.#adoptRuntime(outcome.runtime);
    const { source, origin } = outcome.details ?? {};
    return {
      ...(typeof source === "string" ? { source } : {}),
      ...(typeof origin === "string" && parseServerUrl(origin) === origin
        ? { origin }
        : {}),
    };
  }

  #formatResumeError(message: string): string {
    const stripped = message
      .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, "$1")
      .replace(/(https?:\/\/[^\s#]+)#[^\s#]*/g, "$1");
    const redacted = redact(stripped);
    return redacted.length > 500 ? `${redacted.slice(0, 497)}...` : redacted;
  }

  // Every resume reports the runtime and localmodels tool paths, so an
  // install from before the Computer knew one gains it. A change restarts
  // the Computer once its running tasks end.
  #adoptRuntime(runtime: InstanceRuntime | undefined): void {
    const ctx = this.#ctx;
    if (
      !ctx ||
      !runtime?.environment ||
      typeof runtime.environment !== "object" ||
      Object.values(runtime.environment).some(
        (value) => typeof value !== "string",
      )
    )
      return;
    if (
      isDeepStrictEqual(
        ctx.config.get().runtimeEnvironment ?? {},
        runtime.environment,
      )
    )
      return;
    ctx.config.update({ runtimeEnvironment: runtime.environment });
    ctx.log.info("local_server.runtime", {
      runtime: runtime.setupChoice,
      keys: Object.keys(runtime.environment),
    });
    ctx.bus.emit("computer.runtime");
  }

  // Reads the desktop instance's current origin from instance.json via the
  // shared validated loader, where the installer persists port moves as soon
  // as a taken port is reassigned.
  async #readInstanceOrigin(home: string): Promise<string | undefined> {
    try {
      const instance = await loadInstance({ name: LOCAL_INSTANCE, home });
      return instance ? parseServerUrl(instance.origin) : undefined;
    } catch {
      return undefined;
    }
  }

  // Kept in the default home, wherever the installation went.
  #recordFile(): string {
    return this.#desktopDirectory("local-server.json");
  }

  async #readRecord(): Promise<LocalRecord | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.#recordFile(), "utf8"),
      ) as Partial<LocalRecord>;
      return typeof value.repo === "string" && typeof value.origin === "string"
        ? {
            // Records from before the install location are in the default
            // home.
            home:
              typeof value.home === "string" && path.isAbsolute(value.home)
                ? value.home
                : this.#options.home,
            repo: value.repo,
            origin: value.origin,
            ...(typeof value.version === "string"
              ? { version: value.version }
              : {}),
          }
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #writeRecord(record: LocalRecord): Promise<void> {
    await mkdir(this.#desktopDirectory(), { recursive: true, mode: 0o700 });
    // Written aside and moved into place: a record cut short by a power loss
    // would read as no installation while the window still points at it.
    const staged = `${this.#recordFile()}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(staged, JSON.stringify(record), { mode: 0o600 });
      await renameRetrying(staged, this.#recordFile());
    } catch (error) {
      // Each failed write would otherwise leave one more staged file.
      await rm(staged, { force: true });
      throw error;
    }
  }
}

// What the desktop installed, so it can start the services again.
// dist/installer/native/runtime-<target>/manifest.json: an archive of the
// services beside the Node.js release, or on macOS both as folders.
interface BundledRuntime {
  target: string;
  sourceArchiveSha256: string;
  layout?: "archive" | "directory";
  archive?: { file: string; sha256: string };
  // runtime/files.json, when the services are a folder.
  directory?: { file: string; sha256: string };
  // The release archive, or node/bin/node in the folder layout.
  node?: { version?: string; file: string; sha256: string };
}

// The bundled services' native packages need this glibc or newer, like the
// PostgreSQL build: Ubuntu 22.04, Debian 12.
const MIN_GLIBC = "2.35";

// The oldest macOS every binary Linger runs on a Mac starts on: the bundled
// PostgreSQL and LiveKit's ffmpeg are built for 14.0 (Node.js 26 for 13.5,
// Electron for 13.0). packaging/mac/package.py writes the same value as
// LSMinimumSystemVersion.
export const MIN_MACOS = "14.0";

const atLeast = (version: string, minimum: string): boolean => {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [wantMajor = 0, wantMinor = 0] = minimum.split(".").map(Number);
  return major !== wantMajor ? major > wantMajor : minor >= wantMinor;
};

// The single JSON line `installer.js --resume` prints.
interface ResumeOutcome {
  code: number;
  message: string;
  details?: {
    source?: unknown;
    origin?: unknown;
    code?: unknown;
    causeCode?: unknown;
    reasons?: unknown;
    // Why a saved BYOK source's gateway did not come back: `{ code, message }`.
    byokGateway?: unknown;
    // Why local models did not come back on resume: `{ code, message, reasons? }`.
    localModelsDegraded?: unknown;
  };
  runtime?: InstanceRuntime;
  // Resume stderr is not piped (detached services could hold it open), so
  // the runtime lookup's stage timings ride in the outcome instead.
  runtimeLookupTimings?: unknown;
}

interface RuntimeLookupTimingFields {
  config_ms: number;
  runtime_ms: number;
  local_models_ms: number;
  tool_ms: number;
  total_ms: number;
}

// The installer's runtime lookup timings, or undefined unless every stage is
// a finite number; an older or newer installer must never fail the caller.
function runtimeLookupTimingFields(
  value: unknown,
): RuntimeLookupTimingFields | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { config, runtime, localModels, tool, total } = value as Record<
    string,
    unknown
  >;
  const stages = [config, runtime, localModels, tool, total];
  if (!stages.every((ms) => typeof ms === "number" && Number.isFinite(ms)))
    return undefined;
  return {
    config_ms: config as number,
    runtime_ms: runtime as number,
    local_models_ms: localModels as number,
    tool_ms: tool as number,
    total_ms: total as number,
  };
}

// The installer's `installer.runtime_lookup_timings` stderr event as log
// fields, keyed on the event name rather than the line's wording.
function installerTimingEvent(
  line: string,
): (RuntimeLookupTimingFields & { instance?: string }) | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const { event, instance, timings } = parsed as Record<string, unknown>;
  if (event !== "installer.runtime_lookup_timings") return undefined;
  const fields = runtimeLookupTimingFields(timings);
  if (!fields) return undefined;
  return { ...(typeof instance === "string" ? { instance } : {}), ...fields };
}

function parseResumeOutcomeLine(line: string): ResumeOutcome | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      typeof (parsed as { code?: unknown }).code === "number" &&
      Number.isFinite((parsed as { code: number }).code)
    )
      return parsed as ResumeOutcome;
  } catch {
    // Ignore non-JSON lines from installer logs or detached grandchildren.
  }
  return undefined;
}

// Scans stdout lines in reverse for the last valid ResumeOutcome JSON object so
// trailing non-JSON log lines from detached grandchildren never break parsing.
function parseResumeOutcome(
  output: string,
  requireNewline = false,
): ResumeOutcome | undefined {
  const lines = output.split("\n");
  const end = requireNewline ? lines.length - 1 : lines.length;
  for (let index = end - 1; index >= 0; index--) {
    const outcome = parseResumeOutcomeLine(lines[index]!);
    if (outcome) return outcome;
  }
  return undefined;
}

interface LocalRecord {
  // The installer home.
  readonly home: string;
  readonly repo: string;
  readonly origin: string;
  // The version of the app that unpacked `repo`; a record without one was
  // written by an app older than any that reads it.
  readonly version?: string;
}

// This computer as the server's Local Computers list reports it.
export interface ReportedComputer {
  readonly computer_id?: string;
  readonly status?: string;
  readonly upgrade_required?: boolean;
  readonly runtimes?: readonly {
    readonly type?: string;
    readonly status?: string;
    readonly message?: string;
    readonly models?: readonly unknown[];
  }[];
  readonly workspace_grants?: readonly { readonly mode?: string }[];
}

const RUNTIME_NAMES: Record<string, string> = {
  codex: "Codex",
  claude: "Claude Code",
  pi: "Pi",
};

const RUNTIME_STATES: Record<string, string> = {
  not_installed: "not found on this computer",
  authentication_required: "not signed in",
  incompatible: "version not supported",
  error: "check failed",
  unknown: "not checked yet",
};

// Why setup gave up on the Another Me. The server creates it once this
// computer is online, shares a writable folder and reports a signed-in
// runtime with a model; `computer` is what the server last heard from this
// computer, undefined when it does not list it, null when the list could not
// be read.
export const computerServiceFailed = (reason: string): string =>
  `The Computer service on this computer cannot start: ${reason.replace(/[.\s]+$/, "")}. computer-daemon.log in the logs has details.`;

export function computerNotOnline(
  computer: ReportedComputer | undefined,
): string {
  if (!computer)
    return "This computer did not come online on Linger: the server does not list this computer. Choose Reconnect This Computer in the Linger tray menu, then try again.";
  if (computer.status !== "online")
    return "This computer did not come online on Linger: its Computer service is not connected. computer-daemon.log in the logs says why.";
  if (computer.upgrade_required)
    return "This computer's Computer service is too old for the server. Update Linger, then try again.";
  return "This computer did not come online on Linger.";
}

export const anotherMeMissing = (
  computer: ReportedComputer | undefined | null,
  timeoutMs: number,
): string => {
  const minutes = Math.max(1, Math.round(timeoutMs / 60_000));
  const waited = `Your Another Me was not created after ${minutes} minute${minutes === 1 ? "" : "s"}. The server creates it once this computer is connected with a signed-in AI runtime (Codex, Claude Code or Pi).`;
  const reason = ((): string => {
    if (computer === null)
      return "Linger could not read this computer's status from the server.";
    if (!computer)
      return "The server does not list this computer: it never connected, or it shares no folder with agents. Choose Reconnect This Computer in the Linger tray menu, then try again.";
    if (computer.status !== "online")
      return "The server sees this computer as offline: its Computer service is not connected. computer-daemon.log in the logs says why.";
    if (computer.upgrade_required)
      return "This computer's Computer service is too old for the server. Update Linger, then try again.";
    if (
      !computer.workspace_grants?.some(
        (grant) => grant.mode === "workspace-write",
      )
    )
      return "This computer shares no folder that agents can write to.";
    const runtimes = computer.runtimes ?? [];
    if (
      runtimes.some(
        (runtime) => runtime.status === "ready" && runtime.models?.length,
      )
    )
      return "This computer reports a signed-in runtime, but the server did not create the Another Me; the server log says why (another_me.create_failed).";
    const found = runtimes.map((runtime) => {
      const name = RUNTIME_NAMES[runtime.type ?? ""] ?? runtime.type;
      const state =
        runtime.status === "ready"
          ? "signed in but reports no models"
          : (RUNTIME_STATES[runtime.status ?? ""] ?? runtime.status);
      return `${name}: ${state}${runtime.message ? ` (${runtime.message})` : ""}`;
    });
    return [
      "No signed-in AI runtime is reported by this computer.",
      ...(found.length ? [`It found ${found.join("; ")}.`] : []),
      "Install Codex or Claude Code and sign in to it in a terminal (codex login, or claude), then restart Linger and try again.",
    ].join(" ");
  })();
  return `${waited}\n${reason}`;
};

interface Job {
  readonly runtime?: InstanceRuntime;
  readonly setupChoice?: string;
  readonly id: string;
  readonly instance: string;
  readonly state: string;
  readonly createdAt: string;
  readonly preparation?: string;
  readonly stage?: string;
  readonly message?: string;
  readonly origin?: string;
  readonly errorCode?: string;
  readonly errorCauseCode?: string;
  readonly errorReasons?: readonly string[];
  // The deployment the installer asks to approve before a local model.
  readonly localModelsPlan?: { readonly planId: string };
  readonly stages: readonly {
    readonly id: string;
    readonly state: string;
    readonly progress?: {
      readonly completed: number;
      readonly total?: number;
      readonly unit?: string;
      readonly bytesPerSecond?: number;
      readonly partial?: boolean;
    };
  }[];
}

// Where each installer stage sits among the steps the setup page shows, as
// the share of that step it starts and ends at.
const STAGES: Record<string, readonly [LocalServerStep, number, number]> = {
  preflight: ["download", 0.1, 0.2],
  release: ["download", 0.2, 0.3],
  images: ["download", 0.3, 1],
  runtime: ["services", 0, 0.25],
  services: ["services", 0.25, 1],
  account: ["workspace", 0, 1],
  computer: ["workspace", 1, 1],
};

// Whether a server answers at an origin at all.
async function answers(
  fetcher: typeof fetch,
  origin: string,
  timeoutMs = 1_000,
): Promise<boolean> {
  try {
    await fetcher(origin, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return true;
  } catch {
    return false;
  }
}

// Done: services run and the owner exists. A runtime sign-in still missing
// is the setup page's own step.
const finished = (job: Job): boolean =>
  !!job.origin &&
  (job.state === "succeeded" ||
    (job.state === "waiting_user" &&
      job.errorCode === "RUNTIME_AUTH_REQUIRED"));

// The runtime has no sign-in on this computer. The desktop connects the
// Computer itself (--external-computer), so the job succeeds and only its
// runtime stage waits; an installation that connects one ends waiting with
// RUNTIME_AUTH_REQUIRED instead.
const signInRequired = (job: Job): boolean =>
  job.errorCode === "RUNTIME_AUTH_REQUIRED" ||
  job.stages.some(
    (stage) => stage.id === "runtime" && stage.state === "waiting_user",
  );

// Why a local model could not be deployed after all.
const LOCAL_MODEL_FAILURES = new Set([
  "LOCAL_MODELS_APPROVAL_REQUIRED",
  "LOCAL_MODELS_UNAVAILABLE",
  "LOCAL_MODELS_RECOVERY_REQUIRED",
  "GPU_SHARING_REVOCATION_FAILED",
]);

// What works from the start-failure page when the local model stops a
// restart: a restart applies the approved plan again, but only setup can
// approve a new one or switch the runtime.
const RESUME_REPLAN_ACTION =
  "Set Up Again to review a new plan or choose another AI runtime.";
const RESUME_ACTIONS: Record<string, string> = {
  LOCAL_MODELS_RECOVERY_REQUIRED:
    "Try Again to apply the approved local model plan again, or Set Up Again to review a new plan or choose another AI runtime.",
  LOCAL_MODELS_APPROVAL_REQUIRED:
    "Set Up Again to review the local model plan or choose another AI runtime.",
};
// Upstream stack guard codes where re-applying the same saved plan without
// replanning cannot succeed (for example after a localmodels kit or catalog
// update, or when the saved plan no longer fits).
const REPLAN_ONLY_CAUSES = new Set([
  "STACK_REPLAN_FAILED",
  "STACK_PLAN_CHANGED",
  "STACK_APPROVAL_MISMATCH",
  "STACK_PLAN_INVALID",
]);
// Upstream apply failures where re-applying the same approved plan resumes
// interrupted downloads or component setup without replanning over the network.
const RETRY_APPLY_CAUSES = new Set([
  "STACK_COMPONENT_FAILED",
  "STACK_APPLY_INTERRUPTED",
]);

// Formats a failed installer job into user-facing guidance based on its
// structured error code, cause code, and reason codes so Hub/disk/GPU
// failures, interrupted downloads, and repairable setup/verification errors
// report accurate guidance without blaming memory or hardware incompatibility.
export function formatInstallJobFailure(
  job: Pick<Job, "errorCode" | "errorCauseCode" | "errorReasons" | "message">,
): string {
  const detail = job.message
    ? normalizeFailurePunctuation(job.message)
    : undefined;
  const suffix = detail ? ` (${detail})` : "";
  if (job.errorCode === "LOCAL_MODELS_UNAVAILABLE") {
    switch (job.errorCauseCode) {
      case "HUB_UNREACHABLE":
        return `Couldn't reach the model download service to prepare the local model. Check your internet connection or proxy settings and try again, or choose another AI runtime.${suffix}`;
      case "DISK_INSUFFICIENT":
        return `This computer doesn't have enough free disk space for the local model. Free up disk space, or choose another AI runtime, and try again.${suffix}`;
      case "GPU_CONFLICT":
      case "STACK_PLAN_FAILED":
        return `This computer can't run the local model right now. Choose another AI runtime and try again.${suffix}`;
      default:
        // MEMORY_INSUFFICIENT, or an older localmodels kit that emits no
        // structured stack-plan error code.
        return `This computer can't run the local model right now. Close other programs to free memory, or choose another AI runtime, and try again.${suffix}`;
    }
  }
  const notReady = localModelNotReadyMessage(job.errorReasons);
  if (job.errorCode === "LOCAL_MODELS_RECOVERY_REQUIRED") {
    if (
      !notReady &&
      job.errorCauseCode &&
      RETRY_APPLY_CAUSES.has(job.errorCauseCode)
    )
      return `Local model download or setup was interrupted. Check your internet connection and try again, or choose another AI runtime.${suffix}`;
    return `${notReady ? `${notReady} ` : ""}Local model setup couldn't finish or verify this computer's local model state and Pi configuration. Check folder permissions or repair the existing installation and try again, or choose another AI runtime.${!notReady ? suffix : ""}`;
  }
  if (LOCAL_MODEL_FAILURES.has(job.errorCode ?? "")) {
    return `${notReady ? `${notReady} ` : ""}This computer can't run the local model right now. Choose another AI runtime and try again.${!notReady ? suffix : ""}`;
  }
  return detail || "The installation stopped";
}

// Why the local model stack was not ready, by the reason code localmodels'
// setup binding gives.
const LOCAL_MODEL_NOT_READY: Record<string, string> = {
  "pi-extensions-unavailable":
    "The local model's Pi can't load extensions, which every Linger run needs.",
  "deployment-unavailable": "The local model service isn't running.",
  "acceptance-unavailable": "The local model stack hasn't passed its checks.",
  "gateway-ownership": "The local model gateway isn't running.",
  "gateway-unavailable": "The local model gateway isn't running.",
  "pi-model-unavailable": "Pi can't reach the local model.",
  "pi-config-changed": "Pi's settings changed while they were checked.",
  "plan-invalid": "The approved local model plan can't be read.",
  "binding-unavailable": "The local model stack couldn't be checked.",
};

function localModelNotReadyMessage(reasons: unknown): string | undefined {
  if (!Array.isArray(reasons)) return undefined;
  const code = reasons.find(
    (item): item is string =>
      typeof item === "string" && Object.hasOwn(LOCAL_MODEL_NOT_READY, item),
  );
  return code ? LOCAL_MODEL_NOT_READY[code] : undefined;
}

export interface Reconnect {
  readonly windowMs: number;
  readonly maxBackoffMs: number;
}

const RECONNECT: Reconnect = { windowMs: 60_000, maxBackoffMs: 5_000 };
// The runtime lookup runs a harness status probe (120 s at most) with
// private folder and pinned tool checks around it; on Windows each of those
// is a PowerShell ACL request of up to 30 s, so a slow machine takes a few
// minutes and the worst case of every inner limit stays near seven. The
// installer runs one lookup per instance and keeps its answer, so waiting
// costs nothing and asking again joins it. This limit only ends a lookup
// that has stopped making progress; it is not a performance budget.
export const RUNTIME_LOOKUP_LIMIT_MS = 10 * 60_000;
// When the setup page starts saying what the bar is waiting on.
export const RUNTIME_LOOKUP_HINT_MS = 15_000;

const FAILURES: ReadonlySet<string> = new Set<LocalServerFailure>([
  "runtime_lookup_timed_out",
  "runtime_lookup_unreachable",
]);
const localServerFailure = (code: unknown): LocalServerFailure | undefined =>
  typeof code === "string" && FAILURES.has(code)
    ? (code as LocalServerFailure)
    : undefined;

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_CLOSED",
  // fetch stops waiting for response headers after 300 s; the installer may
  // still be working on the answer.
  "UND_ERR_HEADERS_TIMEOUT",
]);

// The code of a transport failure worth retrying, found on the error or its
// causes; undefined for anything else, HTTP and JSON errors included.
const transientCode = (error: unknown): string | undefined => {
  for (let at = error, depth = 0; at && depth < 5; depth++) {
    if (!(at instanceof Error)) return undefined;
    // The per-request timeout; the caller's own abort is ruled out before.
    if (at.name === "TimeoutError" || at.name === "AbortError") return at.name;
    const code = (at as { code?: unknown }).code;
    if (typeof code === "string" && TRANSIENT_CODES.has(code)) return code;
    at = at.cause;
  }
  return undefined;
};

// The desktop is the installer's only client here: it starts the job and
// follows it, and nothing of the installer UI is shown.
export class InstallerApi {
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #pollMs: number;
  readonly #log: Logger | undefined;
  readonly #reconnect: Reconnect;
  #cookie = "";

  private constructor(
    origin: string,
    fetcher: typeof fetch,
    pollMs: number,
    log: Logger | undefined,
    reconnect: Reconnect,
  ) {
    this.#origin = origin;
    this.#fetch = fetcher;
    this.#pollMs = pollMs;
    this.#log = log;
    this.#reconnect = reconnect;
  }

  // Exchanges the one-time token in the launcher URL for a session.
  static async open(
    url: string,
    fetcher: typeof fetch,
    pollMs: number,
    log?: Logger,
    reconnect: Reconnect = RECONNECT,
  ): Promise<InstallerApi> {
    const target = new URL(url);
    const token = new URLSearchParams(target.hash.slice(1)).get("token");
    if (!token) throw new Error("The installer did not provide a sign-in link");
    const api = new InstallerApi(
      target.origin,
      fetcher,
      pollMs,
      log,
      reconnect,
    );
    const response = await api.#call("/api/session", { token });
    if (!response.ok)
      throw new Error(`The installer refused the session (${response.status})`);
    const session = response.headers
      .getSetCookie()
      .map(parseSetCookie)
      .find((cookie) => cookie?.name === "linger_installer_session");
    if (!session) throw new Error("The installer did not open a session");
    api.#cookie = `${session.name}=${session.value}`;
    return api;
  }

  // Runs the installation for the plan, or follows the one already running,
  // and resolves once the local server is up.
  // `fresh` installs again for a runtime chosen since.
  async run(
    plan: LocalServerPlan,
    signal: AbortSignal,
    onStep: (
      step: LocalServerStep,
      share: number,
      message: string,
      transfer?: Transfer,
    ) => void,
    fresh = false,
  ): Promise<{
    readonly origin: string;
    readonly signInRequired: boolean;
    readonly setupChoice?: string;
    readonly runtime?: InstanceRuntime;
  }> {
    const { items } = await this.#json<{ items: Job[] }>("/api/jobs");
    const latest = items
      .filter((item) => item.instance === LOCAL_INSTANCE && !item.preparation)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    let job: Job;
    if (
      !fresh &&
      latest &&
      // A job for another choice is the person's earlier answer: after a quit
      // part way through the local model download, choosing a subscription
      // must not follow that download. The installer replaces it.
      runsPlan(latest, plan) &&
      (["queued", "running"].includes(latest.state) ||
        // A finished one only while its instance is still there; its data
        // may have been removed since. Its services must still run too: after
        // the app or the computer stopped part way through setup, a new job
        // starts them again.
        (finished(latest) &&
          (await this.#call(`/api/instances/${LOCAL_INSTANCE}/login`)).ok &&
          (await answers(this.#fetch, latest.origin!))))
    )
      job = latest;
    else {
      // The installer answers a new request with a job still waiting for
      // the person, so an attempt that stopped there would be handed back,
      // failed as it ended, on every later attempt.
      if (latest?.state === "waiting_user")
        await this.#json(
          `/api/jobs/${encodeURIComponent(latest.id)}/cancel`,
          {},
        );
      const setupChoice = plan.byok
        ? plan.byok.runtime
        : plan.runtime === "local"
          ? "local-models"
          : plan.runtime === "recommended"
            ? await this.#json<{ recommendation?: string }>("/api/setup").then(
                recommended,
                // Inspection probes GPUs and model tools; when it cannot run,
                // Codex is the runtime that needs nothing on this computer.
                () => "codex",
              )
            : plan.runtime;
      job = await this.#json<Job>("/api/jobs", {
        instance: LOCAL_INSTANCE,
        ...(setupChoice ? { setupChoice } : {}),
        ...(plan.byok ? { byok: plan.byok } : {}),
      });
    }
    // The person chose the local model after seeing what it needs, so its
    // deployment plan is approved here; once, against a plan that keeps
    // changing. An interrupted deployment resumes the approved plan once before
    // giving up; a stale or incompatible saved plan replans once.
    let approved: string | undefined;
    let retriedApply = false;
    let replanned = false;
    // Where the bar last stood, kept while the installer cannot be reached.
    let shown: [LocalServerStep, number] | undefined;
    for (;;) {
      const at = job.stage ? STAGES[job.stage] : undefined;
      if (at) {
        const current = job.stage;
        const stage = job.stages.find((item) => item.id === current);
        const counter = stage?.progress;
        // Native services report readiness only in the message ("2/4 ready").
        const ready = /\((\d+)\/(\d+) ready\)/.exec(job.message ?? "");
        const part =
          stage?.state === "succeeded" || stage?.state === "skipped"
            ? 1
            : counter?.total
              ? counter.completed / counter.total
              : ready
                ? Number(ready[1]) / Math.max(1, Number(ready[2]))
                : 0;
        // A byte counter on the running step is a download to show.
        const bytes =
          stage?.state === "running" &&
          counter?.unit === "bytes" &&
          counter.total
            ? counter
            : undefined;
        shown = [at[0], at[1] + (at[2] - at[1]) * part];
        onStep(
          shown[0],
          shown[1],
          job.message ?? "",
          bytes && {
            completed: bytes.completed,
            total: bytes.total,
            ...(bytes.bytesPerSecond !== undefined
              ? { bytesPerSecond: bytes.bytesPerSecond }
              : {}),
            ...(bytes.partial ? { partial: true } : {}),
          },
        );
      }
      if (finished(job)) {
        const live = job === latest ? undefined : job;
        return {
          origin: job.origin!,
          signInRequired: signInRequired(job),
          setupChoice: live?.runtime?.setupChoice ?? live?.setupChoice,
          runtime: live?.runtime,
        };
      }
      const planId = job.localModelsPlan?.planId;
      if (
        job.state === "waiting_user" &&
        job.errorCode === "LOCAL_MODELS_APPROVAL_REQUIRED" &&
        plan.runtime === "local" &&
        planId &&
        planId !== approved
      ) {
        approved = planId;
        onStep("services", 0, "Deploying the local model");
        job = await this.#json<Job>(
          `/api/jobs/${encodeURIComponent(job.id)}/retry`,
          { localModelsApproval: planId },
        );
        continue;
      }
      if (
        job.state === "waiting_user" &&
        job.errorCode === "LOCAL_MODELS_RECOVERY_REQUIRED" &&
        plan.runtime === "local" &&
        !job.errorReasons?.includes("binding-unavailable")
      ) {
        const retryableApply =
          !!job.errorCauseCode && RETRY_APPLY_CAUSES.has(job.errorCauseCode);
        if (approved && !retriedApply && retryableApply) {
          retriedApply = true;
          onStep("services", 0, "Deploying the local model");
          job = await this.#json<Job>(
            `/api/jobs/${encodeURIComponent(job.id)}/retry`,
            { localModelsApproval: approved },
          );
          continue;
        }
        if (!replanned && !(retriedApply && retryableApply)) {
          replanned = true;
          onStep("services", 0, "Deploying the local model");
          job = await this.#json<Job>(
            `/api/jobs/${encodeURIComponent(job.id)}/retry`,
            { localModelsReplan: true },
          );
          continue;
        }
      }
      if (!["queued", "running"].includes(job.state))
        throw new Error(formatInstallJobFailure(job));
      await delay(this.#pollMs, undefined, { signal });
      job = await this.#poll(job.id, signal, () => {
        if (shown) onStep(shown[0], shown[1], "Reconnecting to the installer…");
      });
    }
  }

  // Reads the job again. The read is idempotent, so a dropped connection is
  // retried for a while: the job keeps running in the installer either way.
  async #poll(
    id: string,
    signal: AbortSignal,
    onReconnect: () => void,
  ): Promise<Job> {
    let since: number | undefined;
    let wait = this.#pollMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#json<Job>(`/api/jobs/${encodeURIComponent(id)}`);
      } catch (error) {
        if (signal.aborted) throw error;
        const code = transientCode(error);
        if (!code) throw error;
        this.#log?.warn("local_server.installer_unreachable", {
          stage: "poll_job",
          job_id: id,
          code,
          attempt,
        });
        since ??= Date.now();
        if (Date.now() - since >= this.#reconnect.windowMs)
          throw new Error(
            "Couldn't read the installation progress. Try again to reconnect to the running installation.",
            { cause: error },
          );
        onReconnect();
        await delay(wait, undefined, { signal });
        wait = Math.min(wait * 2, this.#reconnect.maxBackoffMs);
      }
    }
  }

  // The owner account the installer created for this instance.
  login(): Promise<{ readonly email: string; readonly password: string }> {
    return this.#json(`/api/instances/${LOCAL_INSTANCE}/login`);
  }

  // The runtime the installation set up, with the paths of its executable
  // and profile. The installer answers once its lookup ends, and asking
  // again joins the running one, so a dropped connection is asked again
  // like a job poll; only RUNTIME_LOOKUP_LIMIT_MS in all ends the wait.
  async runtime(signal: AbortSignal): Promise<InstanceRuntime> {
    const deadline = AbortSignal.timeout(RUNTIME_LOOKUP_LIMIT_MS);
    const either = AbortSignal.any([signal, deadline]);
    let since: number | undefined;
    let wait = this.#pollMs;
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#json(
          `/api/instances/${LOCAL_INSTANCE}/runtime`,
          undefined,
          "GET",
          either,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (deadline.aborted)
          throw Object.assign(
            new Error(
              "Checking the AI runtime on this computer did not finish in time.",
              { cause: error },
            ),
            { code: "runtime_lookup_timed_out" },
          );
        const code = transientCode(error);
        if (!code) throw error;
        this.#log?.warn("local_server.installer_unreachable", {
          stage: "runtime",
          code,
          attempt,
        });
        // A lookup that outlasted fetch's wait for an answer is still
        // running in the installer: ask again at once to join it.
        if (code === "UND_ERR_HEADERS_TIMEOUT") continue;
        since ??= Date.now();
        if (Date.now() - since >= this.#reconnect.windowMs)
          throw Object.assign(
            new Error(
              "Lost the connection to the installer while checking the AI runtime.",
              { cause: error },
            ),
            { code: "runtime_lookup_unreachable" },
          );
        await delay(wait, undefined, { signal });
        wait = Math.min(wait * 2, this.#reconnect.maxBackoffMs);
      }
    }
  }

  // The runtime's sign-in: checks it, or with `start` begins the runtime's
  // own login (or gives it the code the vendor's page showed).
  cancelRuntimeLogin(): Promise<RuntimeLogin> {
    return this.#json(
      `/api/runtime-login?instance=${LOCAL_INSTANCE}`,
      undefined,
      "DELETE",
    );
  }

  runtimeLogin(
    start = false,
    code?: string,
    method?: RuntimeLoginMethod,
  ): Promise<RuntimeLogin> {
    return start
      ? this.#json("/api/runtime-login", {
          instance: LOCAL_INSTANCE,
          ...(code ? { code } : {}),
          ...(method ? { method } : {}),
        })
      : this.#json(`/api/runtime-login?instance=${LOCAL_INSTANCE}`);
  }

  #call(
    pathname: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    signal = AbortSignal.timeout(60_000),
  ): Promise<Response> {
    return this.#fetch(new URL(pathname, this.#origin), {
      method,
      headers: {
        accept: "application/json",
        // The installer only takes writes from its own origin.
        origin: this.#origin,
        ...(this.#cookie ? { cookie: this.#cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      redirect: "error",
      signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  async #json<T>(
    pathname: string,
    body?: unknown,
    method?: string,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.#call(pathname, body, method, signal);
    if (!response.ok) {
      const error = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(
        error?.message || `The installer request failed (${response.status})`,
      );
    }
    return (await response.json()) as T;
  }
}

interface InstanceRuntime {
  readonly setupChoice?: string;
  readonly environment: Record<string, string>;
}

interface RuntimeLogin {
  readonly state: "idle" | "starting" | "waiting_user" | "ready" | "failed";
  readonly url?: string;
  readonly deviceCode?: string;
  readonly acceptsCode?: boolean;
  readonly reason?: RuntimeLoginReason;
  readonly message?: string;
}

// The runtime an installation's setup choice runs; local models run on pi.
const isByokProtocol = (value: unknown): value is SetupByokProtocol =>
  value === "openai-chat" ||
  value === "openai-responses" ||
  value === "anthropic";

// The refusal the installer names in its startFailure line on stdout when
// it could not start (startFailureLine in apps/linger-installer).
const startRefusal = (output: string): WindowsPrivateRefusal | undefined => {
  for (const line of output.split("\n")) {
    if (!line.startsWith('{"startFailure"')) continue;
    try {
      const parsed = JSON.parse(line) as { startFailure?: unknown };
      return windowsPrivateRefusal(parsed.startFailure);
    } catch {
      return undefined;
    }
  }
  return undefined;
};
// The installer's own words when it failed with { ok: false, message }:
// localmodels names the address and HTTP status there.
const byokFailure = (out: Record<string, unknown>, fallback: string): string =>
  typeof out.message === "string" && out.message ? out.message : fallback;

const setupRuntime = (choice: string | undefined): LocalRuntime | undefined =>
  choice === "local-models"
    ? "pi"
    : choice === "codex" || choice === "claude" || choice === "pi"
      ? choice
      : undefined;

// The installer's own pick; local models stand for the pi runtime.
const recommended = (report: { recommendation?: string }) =>
  report.recommendation === "local-models"
    ? "pi"
    : (report.recommendation ?? "codex");

// Whether the job installs what the plan asks for. The installer picks for
// "recommended", which never deploys the local model (see `recommended`).
// A job that names no choice used the saved one and is followed as before.
const runsPlan = (job: Job, plan: LocalServerPlan): boolean =>
  !job.setupChoice ||
  (plan.runtime === "recommended"
    ? job.setupChoice !== "local-models"
    : job.setupChoice ===
      (plan.runtime === "local" ? "local-models" : plan.runtime));

export interface SetCookie {
  readonly name: string;
  readonly value: string;
  readonly path?: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite?: "lax" | "strict" | "no_restriction";
  // Seconds since the epoch; absent for a session cookie.
  readonly expirationDate?: number;
}

export const parseSetCookie = (header: string): SetCookie | undefined => {
  const [pair = "", ...attributes] = header.split(";");
  const split = pair.indexOf("=");
  if (split <= 0) return undefined;
  const cookie: {
    -readonly [K in keyof SetCookie]: SetCookie[K];
  } = {
    name: pair.slice(0, split).trim(),
    value: pair.slice(split + 1).trim(),
    httpOnly: false,
    secure: false,
  };
  for (const attribute of attributes) {
    const [key = "", ...rest] = attribute.split("=");
    const value = rest.join("=").trim();
    switch (key.trim().toLowerCase()) {
      case "path":
        cookie.path = value;
        break;
      case "httponly":
        cookie.httpOnly = true;
        break;
      case "secure":
        cookie.secure = true;
        break;
      case "samesite":
        cookie.sameSite =
          value.toLowerCase() === "none"
            ? "no_restriction"
            : value.toLowerCase() === "strict"
              ? "strict"
              : "lax";
        break;
      case "max-age":
        cookie.expirationDate = Date.now() / 1000 + Number(value);
        break;
      case "expires":
        cookie.expirationDate ??= Date.parse(value) / 1000;
        break;
    }
  }
  return cookie;
};

export interface LocalAccount {
  readonly email: string;
  readonly password: string;
  // The private local-account.json it came from.
  readonly file: string;
}

// Reads an instance's owner account; a missing file says where it should be.
export async function readLocalAccount(root: string): Promise<LocalAccount> {
  try {
    return await readLocalLogin({ root });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    throw new Error(
      `The account file of Linger on this computer is missing (${path.join(root, "local-account.json")}).`,
      { cause: error },
    );
  }
}

// A sign-in the local server answered with an error status.
export class SignInRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Signing in to Linger failed (${status})`);
    this.name = "SignInRejectedError";
    this.status = status;
  }
}

// What a person can do about a failed sign-in with this computer's account.
export const signInFailure = (error: unknown): string => {
  if (error instanceof SignInRejectedError && error.status === 401)
    return "The saved password no longer works. Log in with your email and password.";
  // fetch rejects with a TypeError when nothing answers, and with a
  // TimeoutError or AbortError when the answer takes too long. What answers
  // without proving it is this installation's server is not Linger either.
  if (
    error instanceof LocalServerUnverifiedError ||
    error instanceof TypeError ||
    (error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  )
    return "Linger on this computer is not responding.";
  return error instanceof Error ? error.message : String(error);
};

// The installed server as the desktop checks it: the origin the window
// uses, TeamHub's own loopback address and the key only TeamHub and this
// computer's account hold.
export interface LocalServerIdentity {
  readonly origin: string;
  readonly teamhub: string;
  readonly key: Uint8Array;
}

// The installed server did not prove it is this installation's.
export class LocalServerUnverifiedError extends Error {
  // Says what failed, never with what.
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super("Linger on this computer is not responding.", options);
    this.name = "LocalServerUnverifiedError";
    this.reason = reason;
  }
}

const unverifiedReason = (error: unknown): string =>
  error instanceof LocalServerUnverifiedError
    ? error.reason
    : error instanceof Error
      ? error.name
      : "unknown";

export const LOCAL_IDENTITY_TIMEOUT_MS = 5_000;

// Asks TeamHub to prove it holds this installation's identity key. The
// challenge goes to TeamHub's own port: a program on the web port could
// pass it on to a TeamHub still running, but whatever answers on TeamHub's
// port and holds the key is TeamHub.
export const proveLocalServer = async (
  server: LocalServerIdentity,
  fetcher: typeof fetch = fetch,
  timeoutMs = LOCAL_IDENTITY_TIMEOUT_MS,
): Promise<void> => {
  try {
    await proveLocalIdentity({
      url: new URL("/v0/local/identity", server.teamhub),
      origin: server.origin,
      key: server.key,
      signal: AbortSignal.timeout(timeoutMs),
      fetch: fetcher,
    });
  } catch (error) {
    if (error instanceof LocalIdentityError)
      throw new LocalServerUnverifiedError(error.reason, {
        cause: error.cause,
      });
    throw error;
  }
};

// Signs in to the local server with its owner and hands the session cookies
// to the app's web session; the password is never stored, and is sent only
// after the server proved it is this installation's TeamHub. Both requests
// go to TeamHub's own loopback port, the cookies to the window's origin.
export const signInWithPassword = async (
  server: LocalServerIdentity,
  email: string,
  password: string,
  setCookie: (cookie: SetCookie) => Promise<void>,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  await proveLocalServer(server, fetcher);
  const response = await fetcher(new URL("/v0/auth/login", server.teamhub), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: server.origin,
    },
    body: JSON.stringify({ identifier: email, password }),
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  if (!response.ok) throw new SignInRejectedError(response.status);
  const cookies = response.headers
    .getSetCookie()
    .map(parseSetCookie)
    .filter((cookie) => cookie !== undefined);
  if (!cookies.length) throw new Error("Signing in to Linger failed");
  for (const cookie of cookies) await setCookie(cookie);
};

// Release assets redirect to a CDN; the digest, not the host, is what is
// trusted, but every hop stays on HTTPS.
export const followHttps =
  (fetcher: typeof fetch): typeof fetch =>
  async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    for (let hop = 0; hop < 5; hop++) {
      const response = await fetcher(url, { ...init, redirect: "manual" });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location)
        return response;
      await response.body?.cancel();
      url = new URL(location, url);
      if (url.protocol !== "https:")
        throw new Error("Download redirected away from HTTPS");
    }
    throw new Error("Too many download redirects");
  };

// The folder a picked one installs into: the folder itself when it is empty
// or already holds Linger, else a Linger folder inside it.
export const installLocation = async (picked: string): Promise<string> => {
  const entries = await readdir(picked).catch(() => [] as string[]);
  return entries.every((entry) => entry.startsWith(".")) ||
    entries.includes("instances") ||
    entries.includes("installer")
    ? picked
    : path.join(picked, "Linger");
};

// Why Linger cannot install into `directory`, or undefined when it can: the
// folder (or the one it will be made in) must take files and its disk must
// have `neededBytes` free.
export const checkLocation = async (
  directory: string,
  neededBytes: number,
): Promise<string | undefined> => {
  if (!path.isAbsolute(directory)) return "Choose a folder on this computer.";
  let existing = directory;
  while (!(await isDirectory(existing))) {
    if (path.dirname(existing) === existing)
      return "This folder can't be found.";
    existing = path.dirname(existing);
  }
  const probe = path.join(existing, `.linger-${randomUUID()}`);
  try {
    await writeFile(probe, "", { flag: "wx" });
  } catch {
    return "Linger can't write to this folder. Choose another one.";
  } finally {
    await rm(probe, { force: true });
  }
  const disk = await statfs(existing);
  const free = Number(disk.bavail) * Number(disk.bsize);
  if (free < neededBytes)
    return `Needs ${Math.ceil(neededBytes / GiB)} GB free; this disk has ${Math.floor(free / GiB)} GB.`;
  return undefined;
};

const isDirectory = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isDirectory();
  } catch {
    return false;
  }
};

const isFile = async (file: string): Promise<boolean> => {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
};

// Windows' own bsdtar reads both the tar.gz source package and the Node zip;
// a GNU tar earlier on PATH (Git for Windows) reads neither "C:" paths nor zips.
export function tarCommand(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot =
    env.SystemRoot?.trim() || env.windir?.trim() || "C:\\Windows";
  return path.win32.join(systemRoot, "System32", "tar.exe");
}

export interface UnpackArchiveOptions {
  readonly command?: string;
  readonly runCommand?: typeof run;
  readonly fallback?: typeof extractArchiveFallback;
  readonly onFallback?: (command: string) => void;
}

// Unpacks `file` (stripping its single top-level directory) into an empty
// `unpacked` folder. If system tar is missing (for example on stripped Windows
// images without System32\tar.exe), falls back to the pure-Node extractor and
// surfaces an actionable error if that also fails.
export async function unpackArchive(
  file: string,
  unpacked: string,
  signal: AbortSignal,
  options: UnpackArchiveOptions = {},
): Promise<void> {
  const command = options.command ?? tarCommand();
  const runCommand = options.runCommand ?? run;
  const fallback = options.fallback ?? extractArchiveFallback;
  await removeRetrying(unpacked);
  await mkdir(unpacked, { recursive: true, mode: 0o700 });
  try {
    // Windows' tar may not read zstd; Node's zlib does, and tar reads stdin.
    if (file.endsWith(".zst")) {
      await runCommand(
        command,
        ["-xf", "-", "--strip-components=1"],
        unpacked,
        signal,
        createReadStream(file, { signal }).pipe(createZstdDecompress()),
      );
      return;
    }
    await runCommand(
      command,
      ["-xf", path.relative(unpacked, file), "--strip-components=1"],
      unpacked,
      signal,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    options.onFallback?.(command);
    await removeRetrying(unpacked);
    await mkdir(unpacked, { recursive: true, mode: 0o700 });
    try {
      await fallback(file, unpacked, { strip: 1, signal });
    } catch (fallbackError) {
      const detail =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `Failed to unpack ${path.basename(file)}: ${command} was not found (ENOENT) and the built-in extractor failed (${detail}). Restore Windows tar.exe or reinstall Linger.`,
        { cause: fallbackError },
      );
    }
  }
}

// Resolves once the child exited and closed its stdio, so nothing of it
// still holds the files it wrote.
// `input`, when given, is the child's stdin.
const run = (
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  input?: Readable,
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: [input ? "pipe" : "ignore", "ignore", "ignore"],
      signal,
      windowsHide: true,
    });
    child.once("error", reject);
    if (input)
      pipeline(input, child.stdin!).catch((error: unknown) => {
        child.kill();
        reject(error);
      });
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with code ${code}`)),
    );
  });
