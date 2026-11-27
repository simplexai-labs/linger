import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { zstdCompressSync } from "node:zlib";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { NODE_RUNTIME_VERSION } from "../../../../scripts/local-computer-node-distributions.mjs";
import { rename } from "node:fs/promises";
import {
  atomicPrivate,
  composeProject,
  privateDirectory,
} from "@linger/local-installation/instance";

import { CredentialStore } from "./computer-credential.js";
import { EnrollmentModule } from "./enrollment.js";
import {
  FAST_POLL_MS,
  FAST_POLL_WINDOW_MS,
  LOCAL_INSTANCE,
  LOCAL_STEPS,
  LocalServerModule,
  MIN_MACOS,
  anotherMeMissing,
  checkLocation,
  computerNotOnline,
  followHttps,
  formatInstallJobFailure,
  freeDiskBytes,
  hasNativePostgres,
  InstallerApi,
  installLocation,
  legacyMigrationResult,
  parseSetCookie,
  pollDelayMs,
  LocalServerUnverifiedError,
  proveLocalServer,
  runChild,
  RUNTIME_LOOKUP_HINT_MS,
  RUNTIME_LOOKUP_LIMIT_MS,
  SignInRejectedError,
  signInFailure,
  signInWithPassword,
  type LocalServerIdentity,
  type LocalServerOptions,
} from "./local-server.js";
import { localIdentityProof } from "@linger/local-installation/account";
import * as fsRetry from "@linger/local-installation/fs-retry";
import { ensureLocalmodelsTool } from "@linger/local-installation/localmodels-tool";
import * as nativeProcess from "@linger/local-installation/native-process";
import * as teamhubBinaries from "@linger/local-installation/teamhub-binaries";
import * as verifiedStamps from "@linger/local-installation/verified-stamps";
import * as windowsPrivate from "@linger/local-installation/windows-private";
import type { DesktopConfig } from "./config.js";
import { EventBus, type ModuleContext } from "./modules.js";
import {
  fixtureNode,
  silentLog,
  stubModule,
  tempDirectory,
  testHost,
  waitForInstaller,
} from "./test-support.js";

// These tests unpack source archives with real tar and run the installer stub
// in real subprocesses, which can exceed 1s under CI load on any host (and
// take longer on Windows).
const isWindowsHost = process.platform === "win32";
vi.setConfig({ testTimeout: isWindowsHost ? 20_000 : 15_000 });

// Fake timers that still advance with real time, for the installer stub's
// subprocess; AbortSignal.timeout runs on them too, since the native one
// uses a timer outside Vitest's fake clock.
const fakeClock = () => {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ["setTimeout", "clearTimeout", "Date"],
  });
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("timed out", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
  return () => {
    timeout.mockRestore();
    vi.useRealTimers();
  };
};

// Prints what the real installer prints and writes its private launcher.
const FAKE_INSTALLER = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const home = args[args.indexOf("--home") + 1];
if (args.includes("--user-keys")) {
  const changes = JSON.parse(fs.readFileSync(0, "utf8"));
  fs.writeFileSync(path.join(home, "keys-args.json"), JSON.stringify(args));
  // As the installer reports a folder the ACL program refused.
  if (Object.values(changes).includes("refused")) {
    process.stdout.write(JSON.stringify({ error: "Windows private path validation failed", refusal: { code: "WINDOWS_PRIVATE_PATH_UNSAFE", reason: "UNSAFE_PARENT_ACCESS" } }) + "\n");
    process.exit(1);
  }
  if (Object.values(changes).includes("bad")) {
    process.stdout.write(JSON.stringify({ error: "COMPOSIO_API_KEY is not a valid key" }) + "\n");
    process.exit(1);
  }
  const directory = path.join(home, "instances", "desktop");
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "user.env");
  const saved = { ...(fs.existsSync(file) ? require("node:util").parseEnv(fs.readFileSync(file, "utf8")) : {}), ...changes };
  const names = Object.keys(saved).filter((name) => saved[name]);
  fs.writeFileSync(file, names.map((name) => name + "=" + saved[name] + "\n").join(""));
  process.stdout.write(JSON.stringify({ saved: names }) + "\n");
  process.exit(0);
}
if (args.includes("--stop-local-models")) {
  // The quit's stop of the local models; its output goes to a log file.
  fs.writeFileSync(path.join(home, "stop-local-models.json"), JSON.stringify({ args, runAsNode: process.env.ELECTRON_RUN_AS_NODE }));
  process.stdout.write(JSON.stringify({ failed: [] }) + "\n");
  process.exit(0);
}
if (args.includes("--migrate")) {
  // Converts every legacy instance record, except a "desktop" that
  // migrate-skips holds back.
  const holds = fs.existsSync(path.join(home, "migrate-skips"));
  const instances = path.join(home, "instances");
  for (const name of fs.existsSync(instances) ? fs.readdirSync(instances) : []) {
    if (holds && name === "desktop") continue;
    const file = path.join(instances, name, "instance.json");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...record, project: record.project.replace(/^simplex-/, "linger-") }));
  }
  const skipped = holds ? [{ instance: "desktop", reason: "Its Computer is running 1 task(s)." }] : [];
  process.stdout.write(JSON.stringify({ skipped }) + "\n");
  process.exit(0);
}
if (args.includes("--check-byok")) {
  fs.mkdirSync(path.join(home, "installer"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "installer", "byok-env.json"),
    JSON.stringify({
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      XAI_API_KEY: process.env.XAI_API_KEY,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PGHOST: process.env.PGHOST,
      LINGER_COMPUTER_DAEMON: process.env.LINGER_COMPUTER_DAEMON,
    }),
  );
  process.stdout.write(JSON.stringify({ ok: true, protocol: "openai-responses", url: "https://byok.example/v1/responses", modelId: "m" }) + "\n");
  process.exit(0);
}
if (args.includes("--list-byok-models")) {
  process.stdout.write(JSON.stringify({ url: "https://byok.example/v1/models", models: [{ id: "m" }] }) + "\n");
  process.exit(0);
}
if (args.includes("--prefetch-bifrost")) {
  const trackDir = path.dirname(home);
  const trackFile = path.join(trackDir, "prefetch-events.jsonl");
  const trackEnabled = fs.existsSync(path.join(trackDir, "prefetch-track"));
  const record = (entry) => {
    if (trackEnabled) fs.appendFileSync(trackFile, JSON.stringify({ home, ...entry }) + "\n");
  };
  record({ event: "started", args, runAsNode: process.env.ELECTRON_RUN_AS_NODE });
  if (fs.existsSync(path.join(home, "prefetch-hang")) || fs.existsSync(path.join(trackDir, "prefetch-hang"))) {
    let exiting = false;
    const exitOn = (event, code) => {
      if (exiting) return;
      exiting = true;
      const delayMs = fs.existsSync(path.join(trackDir, "prefetch-exit-delay")) ? 120 : 0;
      setTimeout(() => {
        record({ event });
        process.exit(code);
      }, delayMs);
    };
    process.on("SIGTERM", () => exitOn("sigterm", 143));
    if (args.includes("--abort-on-stdin-close")) {
      process.stdin.once("end", () => exitOn("stdin_end", 1));
      process.stdin.once("close", () => exitOn("stdin_end", 1));
      process.stdin.resume();
    }
    setInterval(() => {}, 1000);
  } else if (fs.existsSync(path.join(home, "prefetch-unsupported"))) {
    process.stdout.write(JSON.stringify({ ok: false, unsupported: true, message: "no build" }) + "\n");
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ ok: true, cached: false, version: "1.4.2", name: "bifrost-bin", bytes: 1024 }) + "\n");
    process.exit(0);
  }
} else if (args.includes("--inspect")) {
  const target = args.includes("--inspect-target") ? args[args.indexOf("--inspect-target") + 1] : home;
  fs.mkdirSync(path.join(home, "runtime", "localmodels", "state"), { recursive: true });
  fs.writeFileSync(path.join(home, "runtime", "inspect-args.json"), JSON.stringify(args));
  fs.writeFileSync(
    path.join(home, "runtime", "inspect-env.json"),
    JSON.stringify({
      PATH: process.env.PATH,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      XAI_API_KEY: process.env.XAI_API_KEY,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PGHOST: process.env.PGHOST,
      LINGER_COMPUTER_DAEMON: process.env.LINGER_COMPUTER_DAEMON,
    }),
  );
  const hardware = { totalMemoryBytes: 64 * 1024 ** 3, diskFreeBytes: 200 * 1024 ** 3, gpus: [{ name: "RTX 4090" }] };
  const eligible = !fs.existsSync(path.join(target, "small-computer"));
  const modelFile = path.join(target, "inspect-model");
  const modelName = fs.existsSync(path.join(target, "unnamed-model"))
    ? ""
    : fs.existsSync(modelFile)
      ? fs.readFileSync(modelFile, "utf8").trim()
      : "qwen3-8b";
  const estimate = eligible
    ? { model: modelName, downloadBytes: 6 * 1024 ** 3, diskBytes: 8 * 1024 ** 3, memoryBytes: 12 * 1024 ** 3 }
    : { model: "", downloadBytes: null, diskBytes: null, memoryBytes: null };
  if (fs.existsSync(path.join(home, "tool-download"))) {
    // The first check downloads the localmodels tool, counted before the report.
    process.stdout.write(JSON.stringify({ event: "download", completed: 5, total: 10 }) + "\n");
    while (!fs.existsSync(path.join(home, "tool-ready")))
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (fs.existsSync(path.join(target, "check-fails"))) {
    // A failed check names its cause on stderr and prints null.
    process.stderr.write("The check failed: Unsupported or changed Codex provider configuration\n");
    process.stdout.write("null\n");
    process.exit(1);
  }
  process.stderr.write("Checked this computer in 1.5s.\n");
  const portBlocked = fs.existsSync(path.join(target, "port-in-use"));
  const oldDriver = !portBlocked && fs.existsSync(path.join(target, "old-driver"));
  const lowMemory = eligible && !portBlocked && !oldDriver && fs.existsSync(path.join(target, "low-memory"));
  const reasons = portBlocked
    ? [{ code: "gateway-port-in-use", message: "Gateway port 8080 is held by another process." }]
    : oldDriver
    ? [
        {
          code: "cuda-driver-update-required",
          message: "Driver 535.98 supports CUDA 12.1; requires CUDA >= 12.4.",
          detectedCudaVersion: "12.1",
          requiredCudaVersion: "12.4",
          driverVersion: "535.98",
        },
        {
          code: "cuda-driver-version-unknown",
          message: "Could not read driver CUDA version.",
          detectedCudaVersion: "invalid prose",
          requiredCudaVersion: "12.4",
          driverVersion: "[N/A]",
        },
      ]
    : eligible
    ? lowMemory
      ? [{ code: "free-memory-required", message: "Close other programs before installing.", freeBytes: 2899102924, requiredBytes: 13689304433 }]
      : []
    : [{ code: "facts-unavailable", message: "nvidia-smi was not found" }];
  // With the plan priced on capacity or temporarily blocked, the installer recommends a runtime.
  const recommendation = eligible && !lowMemory && !oldDriver && !portBlocked ? "local-models" : "codex";
  const local = {
    eligible: eligible && !lowMemory && !oldDriver && !portBlocked,
    state: portBlocked || oldDriver || lowMemory ? "blocked-now" : eligible ? "ready" : "unavailable",
    ...(lowMemory ? { basis: "capacity", memory: { ramAvailableBytes: 2899102924, ramRequiredBytes: 13689304433 } } : {}),
  };
  const finalEstimate = oldDriver || portBlocked ? { model: "", downloadBytes: null, diskBytes: null, memoryBytes: null } : estimate;
  process.stdout.write(JSON.stringify({ hardware, localModels: { ...local, reasons, estimate: finalEstimate }, recommendation }) + "\n");
  process.exit(0);
} else {
fs.mkdirSync(path.join(home, "installer"), { recursive: true });
fs.writeFileSync(path.join(home, "installer", "args.json"), JSON.stringify(args));
if (args.includes("--resume")) {
  fs.writeFileSync(
    path.join(home, "installer", "resume-env.json"),
    JSON.stringify({
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      XAI_API_KEY: process.env.XAI_API_KEY,
      NODE_OPTIONS: process.env.NODE_OPTIONS,
      PGHOST: process.env.PGHOST,
      LINGER_COMPUTER_DAEMON: process.env.LINGER_COMPUTER_DAEMON,
    }),
  );
  const code = fs.existsSync(path.join(home, "resume-fails")) ? 1 : 0;
  const runtimeFile = path.join(home, "resume-runtime.json");
  const runtime = fs.existsSync(runtimeFile) ? JSON.parse(fs.readFileSync(runtimeFile, "utf8")) : undefined;
  // The folder the services serve from: the one asked for, unless they
  // were left running on another (resume-serving names it).
  const repo = args[args.indexOf("--source-repo") + 1];
  const servingFile = path.join(home, "resume-serving");
  const source = fs.existsSync(servingFile) ? fs.readFileSync(servingFile, "utf8") : fs.existsSync(repo) ? fs.realpathSync(repo) : repo;
  // resume-fails may hold the failed outcome's message and details.
  const failure = code ? fs.readFileSync(path.join(home, "resume-fails"), "utf8").trim() : "";
  // resume-origin names the origin the installer moved the services to.
  const originFile = path.join(home, "resume-origin");
  const origin = fs.existsSync(originFile) ? fs.readFileSync(originFile, "utf8") : "http://localhost:3000";
  const outcome = failure ? JSON.parse(failure) : { message: code ? "Native teamhub stopped" : "ok", details: { source, origin } };
  // resume-timings.json holds the outcome's runtimeLookupTimings.
  const timingsFile = path.join(home, "resume-timings.json");
  const runtimeLookupTimings = fs.existsSync(timingsFile) ? JSON.parse(fs.readFileSync(timingsFile, "utf8")) : undefined;
  process.stdout.write("noise\n" + JSON.stringify({ code, ...outcome, ...(runtime ? { runtime } : {}), ...(runtimeLookupTimings ? { runtimeLookupTimings } : {}) }) + "\n");
  process.exit(code);
}
if (fs.existsSync(path.join(home, "start-refused"))) {
  // As the installer stops when the ACL program refuses its home.
  process.stdout.write(JSON.stringify({ startFailure: { code: "WINDOWS_PRIVATE_PATH_UNSAFE", reason: "UNSAFE_OWNER" } }) + "\n");
  process.stderr.write("Installer could not start (WINDOWS_PRIVATE_PATH_UNSAFE): Windows private path validation failed\n");
  process.exit(1);
}
// serve-stderr holds what the serving installer writes to stderr.
fs.writeFileSync(
  path.join(home, "installer", "server-env.json"),
  JSON.stringify({
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    XAI_API_KEY: process.env.XAI_API_KEY,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    PGHOST: process.env.PGHOST,
    LINGER_COMPUTER_DAEMON: process.env.LINGER_COMPUTER_DAEMON,
  }),
);
const serveStderr = path.join(home, "serve-stderr");
if (fs.existsSync(serveStderr)) process.stderr.write(fs.readFileSync(serveStderr, "utf8"));
const origin = "http://127.0.0.1:4321";
fs.writeFileSync(
  path.join(home, "installer", "launch.html"),
  '<meta http-equiv="refresh" content="0;url=' + origin + '/#token=abc&amp;x">',
);
process.stdout.write("Installer is running at " + origin + "\n");
}
`;

const sourceArchive = (root: string, variant?: string) => {
  const tree = path.join(root, "tree", "linger-1.0.0", "scripts");
  mkdirSync(tree, { recursive: true });
  writeFileSync(path.join(tree, "source-native.mjs"), "");
  writeFileSync(
    path.join(path.dirname(tree), "package.json"),
    JSON.stringify(
      variant ? { name: "linger", version: variant } : { name: "linger" },
    ),
  );
  const file = path.join(root, "linger.tar.gz");
  execFileSync("tar", [
    "-czf",
    file,
    "-C",
    path.join(root, "tree"),
    "linger-1.0.0",
  ]);
  const bytes = readFileSync(file);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

// A source package an earlier app unpacked into `directory`, named `name`.
const unpackedSource = (directory: string, name = "linger") => {
  mkdirSync(path.join(directory, "scripts"), { recursive: true });
  writeFileSync(path.join(directory, "scripts/source-native.mjs"), "");
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name }));
};

// An instance record an earlier Simplex app wrote under `home`.
const legacyInstance = (home: string, name = "desktop") => {
  mkdirSync(path.join(home, "instances", name), { recursive: true });
  writeFileSync(
    path.join(home, "instances", name, "instance.json"),
    JSON.stringify({ mode: "source-native", project: `simplex-${name}-1` }),
  );
};
const instanceProject = (home: string, name = "desktop") =>
  (
    JSON.parse(
      readFileSync(path.join(home, "instances", name, "instance.json"), "utf8"),
    ) as { project: string }
  ).project;

const DONE = {
  state: "waiting_user",
  errorCode: "RUNTIME_AUTH_REQUIRED",
  origin: "http://localhost:3000",
};

// The installer's local API: a session, then one job that runs to the end;
// a retried job runs to DONE.
const installerApi = (
  jobs: Record<string, unknown>[] = [],
  finish: Record<string, unknown> | Record<string, unknown>[] = DONE,
  setup: Response = Response.json({ recommendation: "local-models" }),
  running: Record<string, unknown> | Record<string, unknown>[] = {
    state: "running",
    stage: "images",
  },
  // Whether the instance's login exists before a job is created.
  installed = true,
) => {
  const finishes = Array.isArray(finish) ? finish : [finish];
  const updates = [running].flat();
  const created: unknown[] = [];
  const retried: unknown[] = [];
  const canceled: string[] = [];
  // The runtime the installation set up and its sign-in; tests change them.
  // The installer answers runtime lookups once `lookup` settles, as its
  // one lookup per instance ends; `asked` counts the requests.
  const runtime: {
    setupChoice: string;
    environment: Record<string, string>;
    login: Record<string, unknown>;
    logins: unknown[];
    lookup: Promise<void>;
    asked: number;
  } = {
    setupChoice: "claude",
    environment: {
      LINGER_CLAUDE_PATH: "/home/me/.linger/runtime/claude/claude",
      CLAUDE_CONFIG_DIR: "/home/me/.claude",
    },
    login: { state: "ready" },
    logins: [],
    lookup: Promise.resolve(),
    asked: 0,
  };
  let polls = 0;
  const job = (fields: Record<string, unknown>) => ({
    id: "job",
    instance: LOCAL_INSTANCE,
    createdAt: "2026-11-03T00:00:00Z",
    stages: [
      { id: "images", state: "running", progress: { completed: 1, total: 2 } },
    ],
    ...fields,
  });
  const handle = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (headers.get("origin") !== url.origin)
      return Response.json({ message: "origin" }, { status: 403 });
    if (url.pathname === "/api/session") {
      expect(JSON.parse(String(init.body))).toEqual({ token: "abc" });
      return new Response("{}", {
        headers: {
          "set-cookie": "linger_installer_session=s1; Path=/api; HttpOnly",
        },
      });
    }
    if (headers.get("cookie") !== "linger_installer_session=s1")
      return Response.json({ message: "session" }, { status: 401 });
    if (url.pathname === "/api/setup") return setup.clone();
    if (url.pathname === "/api/jobs" && init.method === "POST") {
      created.push(JSON.parse(String(init.body)));
      return Response.json(job({ state: "queued" }), { status: 202 });
    }
    if (url.pathname === "/api/jobs") return Response.json({ items: jobs });
    if (url.pathname === "/api/jobs/job/cancel" && init.method === "POST") {
      canceled.push("job");
      return Response.json(job({ state: "canceled" }), { status: 202 });
    }
    if (url.pathname === "/api/jobs/job/retry" && init.method === "POST") {
      retried.push(JSON.parse(String(init.body)));
      polls = 0;
      return Response.json(job({ state: "queued" }), { status: 202 });
    }
    if (url.pathname === "/api/jobs/job")
      return Response.json(
        job(
          ++polls <= updates.length
            ? updates[polls - 1]!
            : (finishes[retried.length] ?? DONE),
        ),
      );
    if (url.pathname === "/api/instances")
      return Response.json({
        items: [
          {
            name: LOCAL_INSTANCE,
            origin: "http://localhost:3000",
            mode: "source-native",
          },
        ],
      });
    if (url.pathname === `/api/instances/${LOCAL_INSTANCE}/login`)
      return !installed && created.length === 0
        ? Response.json(
            {
              code: "INSTANCE_NOT_FOUND",
              message: "Instance or login information not found.",
            },
            { status: 404 },
          )
        : Response.json({
            email: "owner@linger.local",
            password: "pw",
            origin: "http://localhost:3000",
          });
    if (url.pathname === `/api/instances/${LOCAL_INSTANCE}/runtime`) {
      runtime.asked++;
      const { signal } = init;
      await new Promise<void>((resolve, reject) => {
        const stop = () => reject(signal!.reason);
        if (signal?.aborted) stop();
        signal?.addEventListener("abort", stop, { once: true });
        void runtime.lookup.then(resolve);
      });
      return Response.json({
        setupChoice: runtime.setupChoice,
        environment: runtime.environment,
      });
    }
    if (url.pathname === "/api/runtime-login" && init.method === "DELETE") {
      runtime.logins.push("cancel");
      runtime.login = { state: "idle" };
      return Response.json(runtime.login);
    }
    if (url.pathname === "/api/runtime-login" && init.method === "POST") {
      runtime.logins.push(JSON.parse(String(init.body)));
      return Response.json(runtime.login);
    }
    if (url.pathname === "/api/runtime-login") {
      expect(url.searchParams.get("instance")).toBe(LOCAL_INSTANCE);
      return Response.json(runtime.login);
    }
    return new Response(null, { status: 404 });
  };
  return { handle, created, retried, canceled, runtime };
};

const TEAMHUB = "http://127.0.0.1:4100";
const APP_VERSION = "0.17.0";
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const server = (origin: string): LocalServerIdentity => ({
  origin,
  teamhub: TEAMHUB,
  key: KEY,
});

const fixture = (
  overrides:
    | Partial<LocalServerOptions>
    | ((home: string) => Partial<LocalServerOptions>) = {},
  config: Partial<DesktopConfig> = {},
  prepare: (home: string) => void = () => {},
  api = installerApi(),
  root = tempDirectory(),
) => {
  const home = path.join(root, "home");
  const installerDirectory = path.join(root, "installer");
  mkdirSync(installerDirectory);
  // The module runs installer.js as CommonJS-compatible script.
  writeFileSync(path.join(installerDirectory, "installer.js"), FAKE_INSTALLER);
  writeFileSync(
    path.join(installerDirectory, "package.json"),
    '{"type":"commonjs"}',
  );
  // The publisher's PostgreSQL for this computer, which Native needs.
  const target = typeof overrides === "function" ? {} : overrides;
  const platform = target.platform ?? "linux";
  const arch = target.arch ?? "x64";
  writeFileSync(
    path.join(installerDirectory, "distribution.json"),
    JSON.stringify({
      platform,
      arch,
      nativeSources: [{ target: `${platform}-${arch}` }],
    }),
  );
  const node = path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
  mkdirSync(path.join(node, "bin"), { recursive: true });
  fixtureNode(path.join(node, "bin", "node"));
  prepare(home);
  const setServer = vi.fn(() => true);
  const showUpdating = vi.fn();
  const bus = new EventBus();
  const showStarting = vi.fn();
  const showStartFailed = vi.fn();
  const loadServer = vi.fn();
  const prewarmAssets = vi.fn(async () => {});
  const preloadAuthenticated = vi.fn();
  const enroll = vi.fn(async () => {});
  const unenroll = vi.fn(async () => {});
  const syncLocalGatewayUrl = vi.fn(() => false);
  const defaultGrantFailure = vi.fn<
    () => { readonly directory: string; readonly error: string } | undefined
  >(() => undefined);
  let context: ModuleContext | undefined;
  const signIn = vi.fn(async () => {});
  // The installed server proves itself unless a test says otherwise.
  const proveServer = vi.fn(async (_server: LocalServerIdentity) => {});
  const options = typeof overrides === "function" ? overrides(home) : overrides;
  const download = options.fetch;
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    return url.origin === "http://127.0.0.1:4321"
      ? api.handle(url, init)
      : download!(input, init);
  }) as typeof fetch;
  const module = new LocalServerModule({
    home,
    version: APP_VERSION,
    installerDirectory,
    platform: "linux",
    arch: "x64",
    pollMs: 10,
    freeBytes: 1,
    signIn,
    serverIdentity: async (_home, origin) => ({
      origin,
      teamhub: TEAMHUB,
      key: KEY,
    }),
    proveServer,
    ...options,
    fetch: fetcher,
  });
  const host = testHost(
    [
      {
        ...stubModule("WindowManager"),
        setServer,
        showUpdating,
        showStarting,
        showStartFailed,
        loadServer,
        prewarmAssets,
        preloadAuthenticated,
      } as never,
      {
        ...stubModule("Enrollment"),
        enroll,
        unenroll,
        syncLocalGatewayUrl,
        start: async (ctx: ModuleContext) => {
          context = ctx;
        },
      } as never,
      {
        ...stubModule("WorkspaceGrants"),
        defaultFailure: defaultGrantFailure,
      } as never,
      module,
    ],
    config,
    bus,
  );
  return {
    root,
    home,
    module,
    host,
    setServer,
    showUpdating,
    showStarting,
    showStartFailed,
    loadServer,
    prewarmAssets,
    preloadAuthenticated,
    bus,
    enroll,
    unenroll,
    syncLocalGatewayUrl,
    defaultGrantFailure,
    config: () => context!.config.get(),
    signIn,
    proveServer,
    api,
  };
};

const installerArgs = (home: string) =>
  JSON.parse(
    readFileSync(path.join(home, "installer", "args.json"), "utf8"),
  ) as string[];

const inspectArgs = (home: string) =>
  JSON.parse(
    readFileSync(path.join(home, "runtime", "inspect-args.json"), "utf8"),
  ) as string[];

// A developer's linger checkout (LINGER_CHECKOUT) in the home folder.
const withCheckout = (home: string) => ({ checkout: path.join(home, "src") });
const checkout = (home: string) => {
  mkdirSync(path.join(home, "src", "scripts"), { recursive: true });
  writeFileSync(path.join(home, "src", "scripts/source-native.mjs"), "");
};

// A Mac checkout install; the fixture's distribution is for Linux.
const macCheckout = (home: string) => {
  checkout(home);
  writeFileSync(
    path.join(path.dirname(home), "installer", "distribution.json"),
    JSON.stringify({
      platform: "darwin",
      arch: "arm64",
      nativeSources: [{ target: "darwin-arm64" }],
    }),
  );
};

describe("LocalServerModule", () => {
  it("is offered only where native source mode runs", () => {
    const { module } = fixture({
      platform: "win32",
      arch: "arm64",
      checkout: "/src",
    });
    expect(module.status()).toMatchObject({
      available: false,
      phase: "idle",
    });
    expect(fixture({ checkout: "/src" }).module.status().available).toBe(true);
    expect(
      fixture({
        platform: "win32",
        arch: "x64",
        checkout: "/src",
      }).module.status().available,
    ).toBe(true);
    // Without the source package or a checkout there is nothing to install.
    expect(fixture().module.status().available).toBe(false);
  });

  it("offers Native only with PostgreSQL for this computer", async () => {
    const directory = tempDirectory();
    const write = (value: unknown) =>
      writeFileSync(
        path.join(directory, "distribution.json"),
        JSON.stringify(value),
      );
    expect(hasNativePostgres(directory, "linux-x64", {})).toBe(false);
    write({ platform: "linux", arch: "x64", nativeSources: [] });
    expect(hasNativePostgres(directory, "linux-x64", {})).toBe(false);
    write({
      platform: "linux",
      arch: "x64",
      nativeSources: [{ target: "linux-x64" }],
    });
    expect(hasNativePostgres(directory, "linux-x64", {})).toBe(true);
    // A distribution for another computer does not count.
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(false);
    // A developer's own sources replace the distribution's.
    expect(
      hasNativePostgres(directory, "linux-x64", {
        LINGER_NATIVE_DEPENDENCIES_JSON: "[]",
      }),
    ).toBe(false);
    expect(
      hasNativePostgres(directory, "win32-x64", {
        LINGER_NATIVE_DEPENDENCIES_JSON: '[{"target":"win32-x64"}]',
      }),
    ).toBe(true);
    // Windows gets Native as soon as its distribution pins PostgreSQL.
    write({
      platform: "win32",
      arch: "x64",
      nativeSources: [{ target: "win32-x64" }],
    });
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(true);
    // The Windows build bundles it beside the installer; it must be there.
    const bundled = { target: "win32-x64", file: "native/postgres.tar.gz" };
    write({ platform: "win32", arch: "x64", nativeSources: [bundled] });
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(false);
    mkdirSync(path.join(directory, "native"));
    writeFileSync(path.join(directory, bundled.file), "archive");
    expect(hasNativePostgres(directory, "win32-x64", {})).toBe(true);
    expect(fixture(withCheckout, {}, checkout).module.status().available).toBe(
      true,
    );
  });

  it("is not offered where the build has no PostgreSQL for this computer", async () => {
    const f = fixture(withCheckout, {}, (home) => {
      checkout(home);
      writeFileSync(
        path.join(path.dirname(home), "installer", "distribution.json"),
        JSON.stringify({ platform: "linux", arch: "x64", nativeSources: [] }),
      );
    });
    await f.host.start();
    expect(f.module.status().available).toBe(false);
    await expect(f.module.begin()).rejects.toThrow(/not supported/);
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    await f.host.stop("quit");
  });

  it("refuses an older macOS before it runs the installer", async () => {
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        platform: "darwin",
        arch: "arm64",
        macosVersion: () => "13.2",
      }),
      {},
      macCheckout,
    );
    await f.host.start();
    expect(f.module.status().available).toBe(true);
    await expect(f.module.begin()).rejects.toThrow(
      "Linger needs macOS 14.0 or later. This Mac runs macOS 13.2. Update macOS in System Settings > General > Software Update, then try again.",
    );
    expect(f.module.status()).toMatchObject({
      phase: "failed",
      step: "prepare",
    });
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    await f.host.stop("quit");
    // From the minimum on, the installer runs.
    const current = fixture(
      (home) => ({
        ...withCheckout(home),
        platform: "darwin",
        arch: "arm64",
        macosVersion: () => "14.0",
      }),
      {},
      macCheckout,
    );
    await current.host.start();
    await current.module.begin().catch(() => undefined);
    expect(existsSync(path.join(current.home, "installer", "args.json"))).toBe(
      true,
    );
    await current.host.stop("quit");
    // macOS refuses to open the app on an older system too.
    const packaging = readFileSync(
      path.join(import.meta.dirname, "../../packaging/mac/package.py"),
      "utf8",
    );
    expect(packaging).toContain(`MINIMUM_MACOS = "${MIN_MACOS}"`);
    expect(packaging).toContain("LSMinimumSystemVersion=MINIMUM_MACOS");
  });

  it("uses the runtime returned by the completed install without another lookup", async () => {
    const runtime = {
      setupChoice: "pi",
      environment: { LINGER_PI_PATH: "/managed/pi" },
    };
    const api = installerApi([], {
      state: "succeeded",
      origin: "http://localhost:3000",
      runtime,
    });
    const lookup = vi.spyOn(InstallerApi.prototype, "runtime");
    try {
      const f = fixture(withCheckout, {}, checkout, api);
      await f.host.start();
      await f.module.begin();
      expect(f.host.ctx.config.get().runtimeEnvironment).toEqual(
        runtime.environment,
      );
      expect(lookup).not.toHaveBeenCalled();
      await f.host.stop("quit");
    } finally {
      lookup.mockRestore();
    }
  });

  it("installs from the pinned source, signs in and connects this computer", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === "https://github.com/linger.tar.gz")
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/linger.tar.gz" },
        });
      return new Response(archive.bytes);
    });
    const f = fixture({
      sourceArchive: {
        url: "https://github.com/linger.tar.gz",
        sha256: archive.sha256,
      },
      fetch: fetcher as typeof fetch,
    });
    await f.host.start();
    const progress: number[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      progress.push(f.module.status().progress),
    );
    await f.module.begin();
    // The source comes over the network, so downloading shows as a step;
    // the runtime is signed in already, so signing in does not.
    expect(f.module.status().steps).toEqual(
      LOCAL_STEPS.filter((step) => step !== "signin"),
    );
    expect(f.module.status().signIn).toBeUndefined();
    expect(f.api.runtime.logins).toEqual([]);
    // The Computer daemon runs the runtime the installer set up.
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual(
      f.api.runtime.environment,
    );

    const args = installerArgs(f.home);
    const repo = args[args.indexOf("--source-repo") + 1]!;
    expect(repo.startsWith(path.join(f.home, "desktop", "source"))).toBe(true);
    expect(readFileSync(path.join(repo, "scripts/source-native.mjs"))).toEqual(
      Buffer.alloc(0),
    );
    expect(args).toEqual(
      expect.arrayContaining(["--external-computer", "--no-open"]),
    );
    expect(args[args.indexOf("--instance") + 1]).toBe(LOCAL_INSTANCE);
    expect(f.api.created).toEqual([
      {
        instance: LOCAL_INSTANCE,
        setupChoice: "pi",
      },
    ]);
    expect(f.signIn).toHaveBeenCalledWith(
      server("http://localhost:3000"),
      "owner@linger.local",
      "pw",
    );
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3000",
      undefined,
      { reason: "local_ready" },
    );
    expect(f.enroll).toHaveBeenCalled();
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      progress: 1,
      origin: "http://localhost:3000",
    });
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toEqual({
      home: f.home,
      repo,
      origin: "http://localhost:3000",
      version: APP_VERSION,
    });
    await f.host.stop("quit");
  });

  it("asks for the runtime sign-in when there is none and goes on once signed in", async () => {
    // The desktop connects the Computer itself, so the job succeeds and
    // only its runtime stage waits for the sign-in.
    const api = installerApi([], {
      state: "succeeded",
      setupChoice: "codex",
      origin: "http://localhost:3000",
      stages: [
        { id: "runtime", state: "waiting_user" },
        { id: "computer", state: "skipped" },
      ],
    });
    const requests = vi.spyOn(api, "handle");
    const lookups = () =>
      requests.mock.calls.filter(([url]) => url.pathname.endsWith("/runtime"));
    api.runtime.setupChoice = "codex";
    api.runtime.login = { state: "idle" };
    const openExternal = vi.fn(async () => {});
    const f = fixture(
      (home) => ({ ...withCheckout(home), openExternal, signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await waitForInstaller(() => expect(f.module.status().step).toBe("signin"));
    expect(lookups()).toHaveLength(0);
    expect(f.module.status()).toMatchObject({
      phase: "installing",
      message: "Sign in to Codex",
      signIn: { runtime: "codex", state: "required" },
    });
    expect(f.module.status().steps).toContain("signin");
    expect(f.enroll).not.toHaveBeenCalled();

    // The runtime's own login runs in the installer. On Linux, Codex's
    // browser login leaves its page to this app, which opens it once.
    const oauth =
      "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=x";
    api.runtime.login = { state: "waiting_user", url: oauth };
    await f.module.startSignIn();
    expect(api.runtime.logins).toEqual([
      { instance: LOCAL_INSTANCE, method: "browser" },
    ]);
    expect(f.module.status().signIn).toEqual({
      runtime: "codex",
      state: "waiting_user",
      url: oauth,
    });
    await waitForInstaller(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(openExternal).toHaveBeenCalledWith(oauth);

    // A code for another device instead; its page opens too.
    api.runtime.login = {
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-1234",
    };
    await f.module.startSignIn(undefined, true);
    expect(f.module.status().signIn).toEqual({
      runtime: "codex",
      state: "waiting_user",
      url: "https://auth.openai.com/codex/device",
      deviceCode: "ABCD-1234",
    });
    await waitForInstaller(() => expect(openExternal).toHaveBeenCalledTimes(2));
    expect(openExternal).toHaveBeenLastCalledWith(
      "https://auth.openai.com/codex/device",
    );

    // Claude Code's page shows a code to paste back.
    await f.module.startSignIn("pasted-code");
    expect(api.runtime.logins).toEqual([
      { instance: LOCAL_INSTANCE, method: "browser" },
      { instance: LOCAL_INSTANCE, method: "device" },
      { instance: LOCAL_INSTANCE, code: "pasted-code" },
    ]);

    // Signing in finishes in the browser; the next check sees it.
    api.runtime.login = { state: "ready" };
    await done;
    expect(lookups()).toHaveLength(1);
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      signIn: { runtime: "codex", state: "signed_in" },
    });
    expect(f.module.status().steps).toContain("signin");
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(f.enroll).toHaveBeenCalled();
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual(
      api.runtime.environment,
    );
    await f.host.stop("quit");
  });

  it("leaves the browser to the runtime, and cancels and retries its login", async () => {
    const api = installerApi([], {
      state: "succeeded",
      origin: "http://localhost:3000",
      stages: [{ id: "runtime", state: "waiting_user" }],
    });
    api.runtime.setupChoice = "claude";
    api.runtime.login = { state: "idle" };
    const openExternal = vi.fn(async () => {});
    const f = fixture(
      (home) => ({ ...withCheckout(home), openExternal, signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await waitForInstaller(() =>
      expect(f.module.status().signIn).toEqual({
        runtime: "claude",
        state: "required",
      }),
    );

    // Claude Code opens the browser on its own callback page; the link it
    // prints is the paste-code fallback, so nothing opens it here.
    const fallback = {
      state: "waiting_user" as const,
      url: "https://claude.com/cai/oauth/authorize?state=x",
      acceptsCode: true,
    };
    api.runtime.login = fallback;
    await f.module.startSignIn();
    expect(f.module.status().signIn).toEqual({
      runtime: "claude",
      ...fallback,
    });
    expect(openExternal).not.toHaveBeenCalled();
    // "Open browser again" opens it on request.
    await f.module.openSignInPage();
    expect(openExternal).toHaveBeenCalledWith(fallback.url);

    await f.module.cancelSignIn();
    expect(api.runtime.logins).toEqual([
      { instance: LOCAL_INSTANCE },
      "cancel",
    ]);
    expect(f.module.status().signIn).toEqual({
      runtime: "claude",
      state: "required",
    });

    // The login ends without a sign-in: the failure stays until a retry.
    api.runtime.login = {
      state: "failed",
      message: "Sign-in was not completed.",
    };
    await f.module.startSignIn();
    api.runtime.login = { state: "idle" };
    await delay(30);
    expect(f.module.status().signIn).toEqual({
      runtime: "claude",
      state: "failed",
      message: "Sign-in was not completed.",
    });

    api.runtime.login = fallback;
    await f.module.startSignIn();
    expect(f.module.status().signIn?.state).toBe("waiting_user");
    api.runtime.login = { state: "ready" };
    await done;
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      signIn: { runtime: "claude", state: "signed_in" },
    });
    expect(openExternal).toHaveBeenCalledTimes(1);
    await f.host.stop("quit");
  });

  it("says when no browser opens, and why a sign-in ended", async () => {
    const api = installerApi([], {
      state: "succeeded",
      origin: "http://localhost:3000",
      stages: [{ id: "runtime", state: "waiting_user" }],
    });
    api.runtime.setupChoice = "codex";
    api.runtime.login = { state: "idle" };
    const openExternal = vi.fn(async (_url: string): Promise<void> => {
      throw new Error("xdg-open exited with 3");
    });
    const f = fixture(
      (home) => ({ ...withCheckout(home), openExternal, signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await waitForInstaller(() =>
      expect(f.module.status().signIn?.state).toBe("required"),
    );
    const login = {
      state: "waiting_user" as const,
      url: "https://auth.openai.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=x",
    };
    api.runtime.login = login;
    await f.module.startSignIn();
    // No browser opened: the step says so, and the next checks keep it.
    await waitForInstaller(() =>
      expect(f.module.status().signIn).toEqual({
        runtime: "codex",
        ...login,
        browserFailed: true,
      }),
    );
    await delay(30);
    expect(f.module.status().signIn?.browserFailed).toBe(true);
    expect(openExternal).toHaveBeenCalledTimes(1);
    // Opening it by hand works now.
    openExternal.mockResolvedValueOnce(undefined);
    await f.module.openSignInPage();
    expect(f.module.status().signIn).toEqual({ runtime: "codex", ...login });

    // The installer says why it ended; the step keeps the reason.
    api.runtime.login = {
      state: "failed",
      reason: "timed_out",
      message: "Sign-in timed out. Retry or sign in later.",
    };
    await waitForInstaller(() =>
      expect(f.module.status().signIn).toEqual({
        runtime: "codex",
        state: "failed",
        reason: "timed_out",
        message: "Sign-in timed out. Retry or sign in later.",
      }),
    );
    api.runtime.login = { state: "idle" };
    await delay(30);
    expect(f.module.status().signIn?.reason).toBe("timed_out");

    api.runtime.login = { state: "ready" };
    await done;
    expect(f.module.status().signIn).toEqual({
      runtime: "codex",
      state: "signed_in",
    });
    await f.host.stop("quit");
  });

  it("names the runtime Auto chose, and installs another one instead", async () => {
    // Auto resolves to the local model, which runs on Pi.
    const api = installerApi();
    api.runtime.setupChoice = "local-models";
    api.runtime.login = {
      state: "failed",
      message: "Native browser sign-in is unavailable for this runtime.",
    };
    const f = fixture(
      (home) => ({ ...withCheckout(home), signInPollMs: 5 }),
      {},
      checkout,
      api,
    );
    await f.host.start();
    const done = f.module.begin();
    await waitForInstaller(() =>
      expect(f.module.status().signIn).toEqual({
        runtime: "pi",
        state: "failed",
        message: "Native browser sign-in is unavailable for this runtime.",
      }),
    );
    expect(f.module.status().message).toBe("Sign in to Pi");

    api.runtime.setupChoice = "codex";
    api.runtime.environment = { LINGER_CODEX_PATH: "/opt/codex/codex" };
    api.runtime.login = { state: "ready" };
    f.module.switchRuntime("codex");
    await done;
    expect(f.api.created).toEqual([
      { instance: LOCAL_INSTANCE, setupChoice: "pi" },
      { instance: LOCAL_INSTANCE, setupChoice: "codex" },
    ]);
    expect(f.module.status().phase).toBe("ready");
    // Signed in already, so the step went away with the old runtime.
    expect(f.module.status().signIn).toBeUndefined();
    expect(f.module.status().steps).not.toContain("signin");
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual({
      LINGER_CODEX_PATH: "/opt/codex/codex",
    });
    expect(f.host.ctx.config.get().preferredRuntime).toBe("codex");
    await f.host.stop("quit");
  });

  it("unpacks the published dependency store into the source, or goes on without it", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const store = path.join(root, "deps", "pnpm-store", "v11");
    mkdirSync(store, { recursive: true });
    writeFileSync(path.join(store, "index"), "packages");
    const bundleFile = path.join(root, "deps.tar.gz");
    execFileSync("tar", [
      "-czf",
      bundleFile,
      "-C",
      path.join(root, "deps"),
      "pnpm-store",
    ]);
    const bundle = readFileSync(bundleFile);
    for (const available of [true, false]) {
      const fetcher = vi.fn(async (input: string | URL | Request) =>
        String(input).endsWith("/deps.tar.gz")
          ? available
            ? new Response(bundle)
            : new Response("missing", { status: 404 })
          : new Response(archive.bytes),
      );
      const f = fixture({
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        sourceDependencies: {
          url: "https://cdn.example/deps.tar.gz",
          sha256: createHash("sha256").update(bundle).digest("hex"),
        },
        fetch: fetcher as typeof fetch,
      });
      await f.host.start();
      await f.module.begin();
      const args = installerArgs(f.home);
      const repo = args[args.indexOf("--source-repo") + 1]!;
      const index = path.join(repo, ".linger-runtime/pnpm-store/v11/index");
      expect(existsSync(index)).toBe(available);
      if (available) expect(readFileSync(index, "utf8")).toBe("packages");
      expect(f.module.status().phase).toBe("ready");
      await f.host.stop("quit");
    }
  });

  it("downloads the source package from a mirror when its host fails", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const hosts: string[] = [];
    const f = fixture({
      sourceArchive: {
        url: "https://github.com/linger.tar.gz",
        mirrors: ["https://mirror.example/linger.tar.gz"],
        sha256: archive.sha256,
      },
      fetch: (async (input: string | URL | Request) => {
        const url = new URL(String(input));
        hosts.push(url.host);
        return url.host === "github.com"
          ? new Response("unavailable", { status: 503 })
          : new Response(archive.bytes);
      }) as typeof fetch,
    });
    await f.host.start();
    await f.module.begin();
    expect(hosts[0]).toBe("github.com");
    expect(hosts.at(-1)).toBe("mirror.example");
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("keeps only the running version's source and then the new one's", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    let during: string[] = [];
    const f = fixture({
      sourceArchive: {
        url: "https://cdn.example/linger.tar.gz",
        sha256: archive.sha256,
      },
      fetch: (async () => {
        during = readdirSync(sources);
        return new Response(archive.bytes);
      }) as typeof fetch,
    });
    const sources = path.join(f.home, "desktop", "source");
    for (const old of ["older", "running"])
      mkdirSync(path.join(sources, old, "node_modules"), { recursive: true });
    writeFileSync(
      path.join(f.home, "desktop", "local-server.json"),
      JSON.stringify({
        home: f.home,
        repo: path.join(sources, "running"),
        origin: "http://localhost:3000",
      }),
    );
    await f.host.start();
    await f.module.begin();
    const current = archive.sha256.slice(0, 16);
    // The download comes after the older version is gone.
    expect(during).toEqual(["running"]);
    expect(readdirSync(sources)).toEqual([current]);
    await f.host.stop("quit");
  });

  it("opens the app once the Another Me and the starter agents are there", async () => {
    const polls = { anotherMe: 0, rooms: 0 };
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me")
        // The server answers {} until it has created the Another Me.
        return Response.json(
          ++polls.anotherMe < 3 ? {} : { agent_actor_id: "actor_anotherme_1" },
        );
      if (url.pathname === "/v0/tenants/t1/rooms")
        return Response.json({
          items: ++polls.rooms < 2 ? [] : [{ name: "Getting Started" }],
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
      }),
      {},
      checkout,
    );
    await f.host.start();
    const seen: { step: string; message: string }[] = [];
    f.host.ctx.bus.on("local-server.changed", () => {
      const { step, message } = f.module.status();
      seen.push({ step, message });
    });
    await f.module.begin();
    expect(seen).toContainEqual({
      step: "agents",
      message: "Preparing your Another Me…",
    });
    expect(polls).toEqual({ anotherMe: 4, rooms: 2 });
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("says what the server is missing when the Another Me never comes", async () => {
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me")
        return Response.json({});
      if (url.pathname === "/v0/tenants/t1/local-computers")
        return Response.json({
          items: [
            {
              computer_id: "cmp_1",
              status: "online",
              workspace_grants: [{ mode: "workspace-write" }],
              runtimes: [
                { type: "claude", status: "not_installed", models: [] },
                { type: "codex", status: "authentication_required" },
              ],
            },
          ],
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        agentsTimeoutMs: 0,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow(
      "No signed-in AI runtime is reported by this computer. It found Claude Code: not found on this computer; Codex: not signed in.",
    );
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("surfaces server placement_blocker diagnostics while polling and on timeout", async () => {
    let polls = 0;
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me") {
        polls += 1;
        return Response.json({
          placement_blocker: {
            reason: "no_ready_runtime_with_models",
            computer_id: "cmp_win_1",
            runtimes: [
              {
                type: "codex",
                status: "error",
                model_count: 0,
                message: "node.exe not found",
              },
              {
                type: "pi",
                status: "ready",
                model_count: 0,
              },
            ],
          },
        });
      }
      // Even when /local-computers returns 404, server placement_blocker explains why.
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
        agentsTimeoutMs: 15,
      }),
      { computerId: "cmp_win_1" },
      checkout,
    );
    const messages: string[] = [];
    f.host.ctx.bus.on("local-server.changed", () => {
      messages.push(f.module.status().message);
    });
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow(
      "No signed-in AI runtime is reported by this computer. It found Codex: check failed (node.exe not found); Pi: signed in but reports no models.",
    );
    expect(polls).toBeGreaterThanOrEqual(1);
    expect(messages).toContain("Waiting for a signed-in AI runtime…");
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("completes setup when placement_blocker clears after the runtime becomes ready", async () => {
    let polls = 0;
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me") {
        polls += 1;
        return Response.json(
          polls < 3
            ? {
                placement_blocker: {
                  reason: "no_ready_runtime_with_models",
                  computer_id: "cmp_win_1",
                  runtimes: [
                    {
                      type: "codex",
                      status: "authentication_required",
                      model_count: 0,
                    },
                  ],
                },
              }
            : { agent_actor_id: "actor_anotherme_1" },
        );
      }
      if (url.pathname === "/v0/tenants/t1/rooms")
        return Response.json({ items: [{ name: "Getting Started" }] });
      if (url.pathname === "/v0/tenants/t1/local-computers")
        return Response.json({
          items: [{ computer_id: "cmp_win_1", status: "online" }],
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
      }),
      { computerId: "cmp_win_1" },
      checkout,
    );
    await f.host.start();
    await f.module.begin();
    expect(polls).toBe(3);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("stops waiting immediately when creating the default workspace folder failed", async () => {
    let polls = 0;
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me") {
        polls += 1;
        return Response.json({
          placement_blocker: {
            reason: "no_writable_workspace_grant",
            computer_id: "cmp_1",
          },
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    f.defaultGrantFailure.mockReturnValue({
      directory: "/Users/alice/Linger",
      error: "EACCES: permission denied",
    });
    await expect(f.module.begin()).rejects.toThrow(
      "Linger could not create its default workspace folder (/Users/alice/Linger): EACCES: permission denied. Choose a writable folder in Linger Settings, then try again.",
    );
    expect(polls).toBe(1);
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("stops waiting once the Computer service cannot start", async () => {
    const polls = { anotherMe: 0 };
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me") {
        polls.anotherMe += 1;
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    const setup = f.module.begin();
    await waitForInstaller(() => expect(polls.anotherMe).toBeGreaterThan(0));
    f.host.ctx.bus.emit(
      "computer.failed",
      "read Computer config: private path grants access to another user (S-1-5-11)",
    );
    await expect(setup).rejects.toThrow(
      "The Computer service on this computer cannot start: read Computer config: private path grants access to another user (S-1-5-11). computer-daemon.log in the logs has details.",
    );
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("stops waiting immediately when the Computer daemon reports an identity conflict", async () => {
    const polls = { anotherMe: 0 };
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me") {
        polls.anotherMe += 1;
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    const setup = f.module.begin();
    await waitForInstaller(() => expect(polls.anotherMe).toBeGreaterThan(0));
    f.host.ctx.bus.emit("computer.connection", "identity_conflict");
    await expect(setup).rejects.toThrow(
      /already connected to another Computer registration/,
    );
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("waits for the enrolled Computer to report online before finishing setup", async () => {
    let computerPolls = 0;
    const server = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me")
        return Response.json({ agent_actor_id: "actor_anotherme_1" });
      if (url.pathname === "/v0/tenants/t1/rooms")
        return Response.json({ items: [{ name: "Getting Started" }] });
      if (url.pathname === "/v0/tenants/t1/local-computers") {
        computerPolls += 1;
        return Response.json({
          items: [
            {
              computer_id: "cmp_1",
              status: computerPolls < 3 ? "offline" : "online",
            },
          ],
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: server,
        sessionCookie: async () => "session=s",
        pollMs: 1,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await f.host.start();
    const messages: string[] = [];
    f.host.ctx.bus.on("local-server.changed", () => {
      messages.push(f.module.status().message);
    });
    await f.module.begin();
    expect(computerPolls).toBe(3);
    expect(messages).toContain("Connecting this computer…");
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");

    // On timeout while offline, it reports the Computer is offline instead
    // of claiming Another Me is missing.
    const offlineServer = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v0/me")
        return Response.json({ actors: [{ kind: "human", tenant_id: "t1" }] });
      if (url.pathname === "/v0/tenants/t1/another-me")
        return Response.json({ agent_actor_id: "actor_anotherme_1" });
      if (url.pathname === "/v0/tenants/t1/rooms")
        return Response.json({ items: [{ name: "Getting Started" }] });
      if (url.pathname === "/v0/tenants/t1/local-computers")
        return Response.json({
          items: [{ computer_id: "cmp_1", status: "offline" }],
        });
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const offline = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: offlineServer,
        sessionCookie: async () => "session=s",
        agentsTimeoutMs: 0,
      }),
      { computerId: "cmp_1" },
      checkout,
    );
    await offline.host.start();
    await expect(offline.module.begin()).rejects.toThrow(
      computerNotOnline({ status: "offline" }),
    );
    await offline.host.stop("quit");
  });

  it("rejects a source package with the wrong digest", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = fixture({
      sourceArchive: {
        url: "https://example.com/linger.tar.gz",
        sha256: "0".repeat(64),
      },
      fetch: (async () => new Response(archive.bytes)) as typeof fetch,
    });
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow();
    // The failure stays on the step it happened in.
    expect(f.module.status()).toMatchObject({
      phase: "failed",
      step: "download",
    });
    expect(f.signIn).not.toHaveBeenCalled();
  });

  it("installs from the source package bundled in the app", async () => {
    const f = fixture();
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(f.root, "installer", "source"));
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archive.bytes,
    );
    const bundled = (sha256: string) =>
      new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        freeBytes: 1,
        sourceArchive: { file: "source/linger.tar.gz", sha256 },
        signIn: f.signIn,
      });
    const damaged = bundled("0".repeat(64));
    await expect(damaged.begin()).rejects.toThrow(
      "The bundled linger.tar.gz is damaged",
    );
    // The installer stops after the source is in place; only the source matters.
    await bundled(archive.sha256)
      .begin()
      .catch(() => undefined);
    const args = installerArgs(f.home);
    const repo = args[args.indexOf("--source-repo") + 1]!;
    expect(existsSync(path.join(repo, "scripts/source-native.mjs"))).toBe(true);
  });

  it("hands Native the TeamHub binaries built from its source package", async () => {
    const f = fixture();
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(f.root, "installer", "source"));
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archive.bytes,
    );
    const binaries = path.join(
      f.root,
      "installer",
      "native",
      "teamhub-linux-x64",
    );
    mkdirSync(binaries, { recursive: true });
    const manifest = (sourceArchiveSha256: string) =>
      writeFileSync(
        path.join(binaries, "manifest.json"),
        JSON.stringify({
          target: "linux-x64",
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256,
          goVersion: "1.26.5",
          binaries: Object.fromEntries(
            ["teamhub", "migrate", "account"].map((command) => {
              writeFileSync(path.join(binaries, command), command);
              return [
                command,
                {
                  file: command,
                  sha256: createHash("sha256").update(command).digest("hex"),
                  bytes: command.length,
                },
              ];
            }),
          ),
        }),
      );
    const install = async () => {
      await new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        freeBytes: 1,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
      })
        .begin()
        .catch(() => undefined);
      const args = installerArgs(f.home);
      return path.join(
        args[args.indexOf("--source-repo") + 1]!,
        ".simplexai-runtime/prebuilt",
      );
    };
    // Binaries of another source package stay out; Native compiles.
    manifest("0".repeat(64));
    const prebuilt = await install();
    expect(existsSync(prebuilt)).toBe(false);
    manifest(archive.sha256);
    await install();
    expect(readFileSync(path.join(prebuilt, "migrate"), "utf8")).toBe(
      "migrate",
    );
    expect(existsSync(path.join(prebuilt, "manifest.json"))).toBe(true);
  });

  it("unpacks the services built from its source package into the source", async () => {
    const f = fixture();
    const archive = sourceArchive(f.root);
    mkdirSync(path.join(f.root, "installer", "source"));
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archive.bytes,
    );
    const bundle = path.join(
      f.root,
      "installer",
      "native",
      "runtime-linux-x64",
    );
    const tree = path.join(f.root, "runtime-tree", "runtime");
    mkdirSync(tree, { recursive: true });
    writeFileSync(
      path.join(tree, "files.json"),
      JSON.stringify({
        target: "linux-x64",
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: archive.sha256,
        files: {},
      }),
    );
    mkdirSync(bundle, { recursive: true });
    writeFileSync(
      path.join(bundle, "runtime.tar.zst"),
      zstdCompressSync(
        execFileSync("tar", ["-cf", "-", "-C", path.dirname(tree), "runtime"]),
      ),
    );
    const runtimeSha256 = createHash("sha256")
      .update(readFileSync(path.join(bundle, "runtime.tar.zst")))
      .digest("hex");
    const manifest = (sourceArchiveSha256: string, sha256 = runtimeSha256) =>
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "linux-x64",
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256,
          archive: { file: "runtime.tar.zst", sha256, bytes: 1 },
        }),
      );
    const install = async (glibcVersion = "2.35") => {
      await new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        freeBytes: 1,
        glibcVersion,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
      })
        .begin()
        .catch(() => undefined);
      const args = installerArgs(f.home);
      return path.join(
        args[args.indexOf("--source-repo") + 1]!,
        ".simplexai-runtime/offline",
      );
    };
    // Services of another source package, or a damaged archive, stay out;
    // Native installs the source's packages instead.
    manifest("0".repeat(64));
    const offline = await install();
    expect(existsSync(offline)).toBe(false);
    manifest(archive.sha256, "0".repeat(64));
    await install();
    expect(existsSync(offline)).toBe(false);
    manifest(archive.sha256);
    // Their native packages need glibc 2.35, like the PostgreSQL build.
    await install("2.31");
    expect(existsSync(offline)).toBe(false);
    await install();
    expect(
      JSON.parse(readFileSync(path.join(offline, "files.json"), "utf8")),
    ).toMatchObject({
      target: "linux-x64",
      sourceArchiveSha256: archive.sha256,
    });
    // The installer checks an unpacked runtime by size, not by hashing it.
    expect(existsSync(path.join(offline, "verified.json"))).toBe(true);
    // It unpacks in place, with no folder to rename after.
    expect(existsSync(`${offline}.partial`)).toBe(false);
    // An unpacking that stopped partway has no record and is done again.
    rmSync(path.join(offline, "verified.json"));
    writeFileSync(path.join(offline, "leftover"), "");
    await install();
    expect(existsSync(path.join(offline, "leftover"))).toBe(false);
    expect(existsSync(path.join(offline, "verified.json"))).toBe(true);
  });

  it("fails explicitly instead of falling back to source builds for a minimal 8-file offline skeleton", async () => {
    const f = fixture();
    const skeletonRoot = path.join(f.root, "skeleton-tree", "linger-1.0.0");
    mkdirSync(path.join(skeletonRoot, "apps", "teamhub"), { recursive: true });
    mkdirSync(path.join(skeletonRoot, "scripts"), { recursive: true });
    writeFileSync(path.join(skeletonRoot, ".env.example"), "");
    writeFileSync(
      path.join(skeletonRoot, "apps", "teamhub", "go.mod"),
      "module example.com/teamhub\n",
    );
    writeFileSync(
      path.join(skeletonRoot, "package.json"),
      JSON.stringify({ name: "linger" }),
    );
    writeFileSync(
      path.join(skeletonRoot, "scripts", "env-inventory.json"),
      JSON.stringify({ variables: [] }),
    );
    writeFileSync(path.join(skeletonRoot, "scripts", "local-defaults.env"), "");
    writeFileSync(
      path.join(skeletonRoot, "scripts", "replace-process.mjs"),
      "",
    );
    writeFileSync(path.join(skeletonRoot, "scripts", "source-native.mjs"), "");
    writeFileSync(path.join(skeletonRoot, "scripts", "with-local-env.mjs"), "");

    const archiveFile = path.join(f.root, "skeleton-linger.tar.gz");
    execFileSync("tar", [
      "-czf",
      archiveFile,
      "-C",
      path.join(f.root, "skeleton-tree"),
      "linger-1.0.0",
    ]);
    const archiveBytes = readFileSync(archiveFile);
    const archiveSha = createHash("sha256").update(archiveBytes).digest("hex");

    mkdirSync(path.join(f.root, "installer", "source"), { recursive: true });
    writeFileSync(
      path.join(f.root, "installer", "source", "linger.tar.gz"),
      archiveBytes,
    );

    const runtimeBundle = path.join(
      f.root,
      "installer",
      "native",
      "runtime-linux-x64",
    );
    const runtimeTree = path.join(f.root, "skeleton-runtime-tree", "runtime");
    mkdirSync(runtimeTree, { recursive: true });
    writeFileSync(
      path.join(runtimeTree, "files.json"),
      JSON.stringify({
        target: "linux-x64",
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: archiveSha,
        files: {},
      }),
    );
    mkdirSync(runtimeBundle, { recursive: true });
    writeFileSync(
      path.join(runtimeBundle, "runtime.tar.zst"),
      zstdCompressSync(
        execFileSync("tar", [
          "-cf",
          "-",
          "-C",
          path.dirname(runtimeTree),
          "runtime",
        ]),
      ),
    );
    const runtimeSha = createHash("sha256")
      .update(readFileSync(path.join(runtimeBundle, "runtime.tar.zst")))
      .digest("hex");
    const writeRuntimeManifest = (sha256 = runtimeSha) =>
      writeFileSync(
        path.join(runtimeBundle, "manifest.json"),
        JSON.stringify({
          target: "linux-x64",
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256: archiveSha,
          archive: { file: "runtime.tar.zst", sha256, bytes: 1 },
        }),
      );

    const runInstall = (glibcVersion = "2.35") =>
      new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: path.join(f.root, "installer"),
        platform: "linux",
        arch: "x64",
        freeBytes: 1,
        glibcVersion,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archiveSha },
        signIn: f.signIn,
      }).begin();

    // 1. Linux glibc older than 2.35 fails explicitly instead of skipping silently.
    writeRuntimeManifest();
    await expect(runInstall("2.31")).rejects.toThrow(
      "Linger requires Linux with glibc 2.35 or later (detected 2.31) because this release uses prebuilt offline services.",
    );

    // 2. Damaged offline runtime archive fails explicitly instead of falling back.
    writeRuntimeManifest("0".repeat(64));
    await expect(runInstall("2.35")).rejects.toThrow(
      /The bundled offline Linger services could not be unpacked or verified \(.*\)\. Reinstall Linger to restore them\./,
    );

    // 3. Damaged TeamHub binaries fail explicitly instead of falling back to Go compilation.
    const teamhubBundle = path.join(
      f.root,
      "installer",
      "native",
      "teamhub-linux-x64",
    );
    mkdirSync(teamhubBundle, { recursive: true });
    writeFileSync(
      path.join(teamhubBundle, "manifest.json"),
      JSON.stringify({
        target: "linux-x64",
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: "0".repeat(64),
        goVersion: "1.26.5",
        binaries: {},
      }),
    );
    await expect(runInstall("2.35")).rejects.toThrow(
      /The bundled TeamHub binaries could not be verified \(.*\)\. Reinstall Linger to restore them\./,
    );
  });

  it(
    "copies the services and Node.js a Mac build bundles as folders",
    async () => {
      const node = (home: string) =>
        path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
      const f = fixture({}, {}, (home) =>
        rmSync(node(home), { recursive: true, force: true }),
      );
      const installer = path.join(f.root, "installer");
      const archive = sourceArchive(f.root);
      mkdirSync(path.join(installer, "source"));
      writeFileSync(
        path.join(installer, "source", "linger.tar.gz"),
        archive.bytes,
      );
      writeFileSync(
        path.join(installer, "distribution.json"),
        JSON.stringify({
          platform: "darwin",
          arch: "arm64",
          nativeSources: [{ target: "darwin-arm64" }],
        }),
      );
      const bundle = path.join(installer, "native", "runtime-darwin-arm64");
      mkdirSync(path.join(bundle, "runtime", "web"), { recursive: true });
      mkdirSync(path.join(bundle, "node", "bin"), { recursive: true });
      const files = JSON.stringify({
        target: "darwin-arm64",
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: archive.sha256,
        files: {},
      });
      writeFileSync(path.join(bundle, "runtime", "files.json"), files);
      writeFileSync(path.join(bundle, "runtime", "web", "static-host.mjs"), "");
      // The signed binary; here the Node.js running the tests.
      fixtureNode(path.join(bundle, "node", "bin", "node"));
      const sha256 = (data: string | Buffer) =>
        createHash("sha256").update(data).digest("hex");
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "darwin-arm64",
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256: archive.sha256,
          layout: "directory",
          directory: { file: "runtime/files.json", sha256: sha256(files) },
          node: {
            version: NODE_RUNTIME_VERSION,
            file: "node/bin/node",
            sha256: sha256(readFileSync(process.execPath)),
          },
        }),
      );
      await new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: installer,
        platform: "darwin",
        arch: "arm64",
        freeBytes: 1,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
      })
        .begin()
        .catch(() => undefined);
      expect(sha256(readFileSync(path.join(node(f.home), "bin", "node")))).toBe(
        sha256(readFileSync(process.execPath)),
      );
      const args = installerArgs(f.home);
      const offline = path.join(
        args[args.indexOf("--source-repo") + 1]!,
        ".simplexai-runtime/offline",
      );
      expect(readFileSync(path.join(offline, "files.json"), "utf8")).toBe(
        files,
      );
      expect(existsSync(path.join(offline, "web", "static-host.mjs"))).toBe(
        true,
      );
      expect(existsSync(`${offline}.partial`)).toBe(false);
    },
    isWindowsHost ? 40_000 : 15_000,
  );

  it("reuses the shared Computer tools Node.js on Windows and macOS without network downloads", async () => {
    const sha256 = (data: string | Buffer) =>
      createHash("sha256").update(data).digest("hex");

    // Windows: copies resources/runtime/bin/node.exe into <home>/desktop/node/v<version>/node.exe.
    {
      const nodeDir = (home: string) =>
        path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
      const f = fixture({}, {}, (home) =>
        rmSync(nodeDir(home), { recursive: true, force: true }),
      );
      const resources = path.join(f.root, "resources");
      const installer = path.join(resources, "app", "dist", "installer");
      mkdirSync(installer, { recursive: true });
      writeFileSync(path.join(installer, "installer.js"), "process.exit(0);\n");
      writeFileSync(
        path.join(installer, "distribution.json"),
        JSON.stringify({
          platform: "win32",
          arch: "x64",
          nativeSources: [{ target: "win32-x64" }],
        }),
      );
      const sharedNode = path.join(resources, "runtime", "bin", "node.exe");
      mkdirSync(path.dirname(sharedNode), { recursive: true });
      const nodeBytes = Buffer.from("MZ-fake-windows-node-binary");
      writeFileSync(sharedNode, nodeBytes);

      const bundle = path.join(installer, "native", "runtime-win32-x64");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "win32-x64",
          sourceArchiveSha256: "a".repeat(64),
          layout: "archive",
          node: {
            version: NODE_RUNTIME_VERSION,
            shared: true,
            binary: "runtime/bin/node.exe",
            sha256: sha256(nodeBytes),
            bytes: nodeBytes.length,
          },
        }),
      );
      const archive = sourceArchive(f.root);
      mkdirSync(path.join(installer, "source"));
      writeFileSync(
        path.join(installer, "source", "linger.tar.gz"),
        archive.bytes,
      );
      const fetchMock = vi.fn(async () => {
        throw new Error("unexpected network download");
      }) as unknown as typeof fetch;

      await new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: installer,
        bundledNodePath: sharedNode,
        platform: "win32",
        arch: "x64",
        freeBytes: 1,
        checkPrivateLocation: async () => {},
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
        fetch: fetchMock,
      })
        .begin()
        .catch(() => undefined);

      const copied = path.join(nodeDir(f.home), "node.exe");
      expect(existsSync(copied)).toBe(true);
      expect(readFileSync(copied)).toEqual(nodeBytes);
      expect(existsSync(`${nodeDir(f.home)}.partial`)).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    }

    // macOS: resolves fallback <resources>/runtime/bin/node when bundledNodePath is omitted.
    {
      const nodeDir = (home: string) =>
        path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
      const f = fixture({}, {}, (home) =>
        rmSync(nodeDir(home), { recursive: true, force: true }),
      );
      const resources = path.join(
        f.root,
        "Linger.app",
        "Contents",
        "Resources",
      );
      const installer = path.join(resources, "app", "dist", "installer");
      mkdirSync(installer, { recursive: true });
      writeFileSync(
        path.join(installer, "installer.js"),
        readFileSync(path.join(f.root, "installer", "installer.js")),
      );
      writeFileSync(
        path.join(installer, "distribution.json"),
        JSON.stringify({
          platform: "darwin",
          arch: "arm64",
          nativeSources: [{ target: "darwin-arm64" }],
        }),
      );
      const sharedNode = path.join(resources, "runtime", "bin", "node");
      mkdirSync(path.dirname(sharedNode), { recursive: true });
      fixtureNode(sharedNode);
      const nodeBytes = readFileSync(sharedNode);

      const bundle = path.join(installer, "native", "runtime-darwin-arm64");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "darwin-arm64",
          sourceArchiveSha256: "a".repeat(64),
          layout: "directory",
          node: {
            version: NODE_RUNTIME_VERSION,
            shared: true,
            binary: "runtime/bin/node",
            sha256: sha256(nodeBytes),
            bytes: nodeBytes.length,
          },
        }),
      );
      const archive = sourceArchive(f.root);
      mkdirSync(path.join(installer, "source"));
      writeFileSync(
        path.join(installer, "source", "linger.tar.gz"),
        archive.bytes,
      );
      const fetchedUrls: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        fetchedUrls.push(String(input));
        throw new Error("unexpected network download");
      }) as unknown as typeof fetch;

      await new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: installer,
        platform: "darwin",
        arch: "arm64",
        freeBytes: 1,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
        fetch: fetchMock,
      })
        .begin()
        .catch(() => undefined);

      const copied = path.join(nodeDir(f.home), "bin", "node");
      expect(existsSync(copied)).toBe(true);
      expect(sha256(readFileSync(copied))).toBe(sha256(nodeBytes));
      expect(existsSync(`${nodeDir(f.home)}.partial`)).toBe(false);
      expect(fetchedUrls.some((url) => url.includes("node-v"))).toBe(false);
    }
  });

  it("falls back to downloading Node.js when the shared binary is missing or fails checksum", async () => {
    for (const mode of ["missing", "tampered"] as const) {
      const nodeDir = (home: string) =>
        path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
      const warn = vi.spyOn(silentLog, "warn");
      const f = fixture({}, {}, (home) =>
        rmSync(nodeDir(home), { recursive: true, force: true }),
      );
      const installer = path.join(f.root, "installer");
      writeFileSync(
        path.join(installer, "distribution.json"),
        JSON.stringify({
          platform: "win32",
          arch: "x64",
          nativeSources: [{ target: "win32-x64" }],
        }),
      );
      const sharedNode = path.join(f.root, "shared", "node.exe");
      if (mode === "tampered") {
        mkdirSync(path.dirname(sharedNode), { recursive: true });
        writeFileSync(sharedNode, "corrupted-bytes");
      }
      const bundle = path.join(installer, "native", "runtime-win32-x64");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "win32-x64",
          sourceArchiveSha256: "a".repeat(64),
          layout: "archive",
          node: {
            version: NODE_RUNTIME_VERSION,
            shared: true,
            binary: "runtime/bin/node.exe",
            sha256: "f".repeat(64),
            bytes: 123,
          },
        }),
      );
      const fetchedUrls: string[] = [];
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        fetchedUrls.push(String(input));
        return new Response("missing", { status: 404 });
      }) as unknown as typeof fetch;

      const archive = sourceArchive(f.root);
      mkdirSync(path.join(installer, "source"));
      writeFileSync(
        path.join(installer, "source", "linger.tar.gz"),
        archive.bytes,
      );

      const module = new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: installer,
        bundledNodePath: sharedNode,
        platform: "win32",
        arch: "x64",
        freeBytes: 1,
        checkPrivateLocation: async () => {},
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
        fetch: fetchMock,
      });
      const host = testHost([
        stubModule("WindowManager"),
        stubModule("Enrollment"),
        module,
      ]);
      await host.start();
      await expect(module.begin()).rejects.toThrow();
      await host.stop("quit");

      expect(fetchedUrls.some((url) => url.includes("node-v"))).toBe(true);
      expect(existsSync(path.join(nodeDir(f.home), "node.exe"))).toBe(false);
      expect(existsSync(`${nodeDir(f.home)}.partial`)).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        mode === "missing"
          ? "local_server.shared_node_missing"
          : "local_server.shared_node_failed",
        expect.any(Object),
      );
      warn.mockRestore();
    }
  });

  it("checks once whether this computer can serve a local model", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = fixture({ checkout: "/src" });
    // The app's own Node runs the check; the Node runtime is not needed.
    rmSync(path.join(f.home, "desktop", "node"), {
      recursive: true,
      force: true,
    });
    await f.host.start();
    expect(f.module.status().localModels).toEqual({ state: "unchecked" });
    f.module.inspect();
    expect(f.module.status().localModels).toEqual({ state: "checking" });
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toEqual({
        state: "checked",
        eligible: true,
        memoryBytes: 64 * 1024 ** 3,
        diskFreeBytes: 200 * 1024 ** 3,
        gpu: "RTX 4090",
        model: {
          name: "qwen3-8b",
          downloadBytes: 6 * 1024 ** 3,
          diskBytes: 8 * 1024 ** 3,
          memoryBytes: 12 * 1024 ** 3,
        },
        recommendation: "local-models",
      }),
    );
    expect(inspectArgs(f.home)).toEqual([
      "--home",
      f.home,
      "--inspect",
      "--inspect-target",
      f.home,
    ]);
    // How long the check took, as the installer reported it.
    expect(info).toHaveBeenCalledWith("local_server.inspect_log", {
      line: "Checked this computer in 1.5s.",
    });
    info.mockRestore();
  });

  it("reports a failed check with its cause instead of a crash", async () => {
    const info = vi.spyOn(silentLog, "info");
    const warn = vi.spyOn(silentLog, "warn");
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "check-fails"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toEqual({ state: "unavailable" }),
    );
    expect(warn).toHaveBeenCalledWith(
      "local_server.inspect_failed",
      expect.objectContaining({
        error: "The installer could not check this computer",
      }),
    );
    expect(info).toHaveBeenCalledWith("local_server.inspect_log", {
      line: "The check failed: Unsupported or changed Codex provider configuration",
    });
    info.mockRestore();
    warn.mockRestore();
  });

  it("counts the localmodels tool download while checking", async () => {
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "tool-download"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toEqual({
        state: "checking",
        download: { completed: 5, total: 10 },
      }),
    );
    writeFileSync(path.join(f.home, "tool-ready"), "");
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        recommendation: "local-models",
      }),
    );
  });

  it("does not recommend a local model it cannot name", async () => {
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "unnamed-model"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: false,
      }),
    );
    expect(f.module.status().localModels).not.toHaveProperty("recommendation");
  });

  it("reports a computer too small for a local model", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "small-computer"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: false,
        reasons: [{ code: "facts-unavailable" }],
        recommendation: "codex",
      }),
    );
    expect(f.module.status().localModels).not.toHaveProperty("model");
    // The page gets the code only; the tool's words go to the log.
    expect(JSON.stringify(f.module.status())).not.toContain("nvidia-smi");
    expect(info).toHaveBeenCalledWith(
      "local_server.inspected",
      expect.objectContaining({
        eligible: false,
        reasons: ["facts-unavailable: nvidia-smi was not found"],
      }),
    );
    info.mockRestore();
  });

  it("passes the resolved login-shell environment only to setup inspection and keeps it out of BYOK, setup server, and resume", async () => {
    const daemonPath = "/app/resources/computer/linger-computer-daemon";
    const shellOnlyEnv = {
      ...(process.env as Record<string, string>),
      PATH: `/custom/nvm/bin${path.delimiter}/usr/bin${path.delimiter}/bin`,
      ANTHROPIC_BASE_URL: "https://shell-profile.example",
      XAI_API_KEY: "shell-xai-secret",
      NODE_OPTIONS: "--max-old-space-size=9999",
      PGHOST: "shell-pg.invalid",
    };

    // 1. --inspect receives inspectEnv + LINGER_COMPUTER_DAEMON;
    //    --check-byok and setup server receive only process.env + LINGER_COMPUTER_DAEMON.
    const installFixture = fixture(
      (home) => ({
        ...withCheckout(home),
        daemonExecutable: daemonPath,
        inspectEnv: Promise.resolve(shellOnlyEnv),
      }),
      {},
      checkout,
      installerApi(),
    );
    await installFixture.host.start();
    installFixture.module.inspect();
    await waitForInstaller(() =>
      expect(installFixture.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: true,
      }),
    );
    const seenInspect = JSON.parse(
      readFileSync(
        path.join(installFixture.home, "runtime", "inspect-env.json"),
        "utf8",
      ),
    ) as Record<string, string | undefined>;
    expect(seenInspect.PATH).toContain("/custom/nvm/bin");
    expect(seenInspect.ANTHROPIC_BASE_URL).toBe(
      "https://shell-profile.example",
    );
    expect(seenInspect.LINGER_COMPUTER_DAEMON).toBe(daemonPath);

    await installFixture.module.checkByok({
      runtime: "codex",
      baseUrl: "https://byok.example",
      path: "/v1",
      endpoint: "/responses",
      apiKey: "test-key",
      modelId: "m",
      protocol: "openai-responses",
    });
    const seenByok = JSON.parse(
      readFileSync(
        path.join(installFixture.home, "installer", "byok-env.json"),
        "utf8",
      ),
    ) as Record<string, string | undefined>;
    expect(seenByok.LINGER_COMPUTER_DAEMON).toBe(daemonPath);
    expect(seenByok.XAI_API_KEY).not.toBe("shell-xai-secret");
    expect(seenByok.NODE_OPTIONS).not.toBe("--max-old-space-size=9999");
    expect(seenByok.PGHOST).not.toBe("shell-pg.invalid");
    expect(seenByok.ANTHROPIC_BASE_URL).not.toBe(
      "https://shell-profile.example",
    );

    await installFixture.module.begin();
    const seenServer = JSON.parse(
      readFileSync(
        path.join(installFixture.home, "installer", "server-env.json"),
        "utf8",
      ),
    ) as Record<string, string | undefined>;
    expect(seenServer.LINGER_COMPUTER_DAEMON).toBe(daemonPath);
    expect(seenServer.XAI_API_KEY).not.toBe("shell-xai-secret");
    expect(seenServer.NODE_OPTIONS).not.toBe("--max-old-space-size=9999");
    expect(seenServer.PGHOST).not.toBe("shell-pg.invalid");
    expect(seenServer.ANTHROPIC_BASE_URL).not.toBe(
      "https://shell-profile.example",
    );
    await installFixture.host.stop("quit");

    // 2. --resume receives only process.env + LINGER_COMPUTER_DAEMON, never inspectEnv.
    const resumeFixture = fixture(
      {
        daemonExecutable: daemonPath,
        inspectEnv: Promise.resolve(shellOnlyEnv),
      },
      {
        serverUrl: "http://localhost:3000",
        computerId: "cmp_1",
      },
      (home) => {
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({ repo: "/source", origin: "http://localhost:3000" }),
        );
      },
    );
    await resumeFixture.host.start();
    await waitForInstaller(() =>
      expect(resumeFixture.module.status().phase).toBe("ready"),
    );
    const seenResume = JSON.parse(
      readFileSync(
        path.join(resumeFixture.home, "installer", "resume-env.json"),
        "utf8",
      ),
    ) as Record<string, string | undefined>;
    expect(seenResume.LINGER_COMPUTER_DAEMON).toBe(daemonPath);
    expect(seenResume.XAI_API_KEY).not.toBe("shell-xai-secret");
    expect(seenResume.NODE_OPTIONS).not.toBe("--max-old-space-size=9999");
    expect(seenResume.PGHOST).not.toBe("shell-pg.invalid");
    expect(seenResume.ANTHROPIC_BASE_URL).not.toBe(
      "https://shell-profile.example",
    );
    await resumeFixture.host.stop("quit");
  });

  it("marks checked Inkling 2 Mini models with featuredInkling using the shared matcher", async () => {
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        path.join(home, "inspect-model"),
        "thinkingmachines/Inkling-2-Mini",
      );
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: true,
        model: {
          name: "thinkingmachines/Inkling-2-Mini",
          featuredInkling: true,
        },
      }),
    );
  });

  it("forwards validated CUDA driver versions without leaking tool prose", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "old-driver"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: false,
        reasons: [
          {
            code: "cuda-driver-update-required",
            detectedCudaVersion: "12.1",
            requiredCudaVersion: "12.4",
            driverVersion: "535.98",
          },
          {
            code: "cuda-driver-version-unknown",
            requiredCudaVersion: "12.4",
          },
        ],
        recommendation: "codex",
      }),
    );
    const serialized = JSON.stringify(f.module.status());
    expect(serialized).not.toContain("invalid prose");
    expect(serialized).not.toContain("Driver 535.98 supports CUDA 12.1");
    expect(info).toHaveBeenCalledWith(
      "local_server.inspected",
      expect.objectContaining({
        eligible: false,
        reasons: [
          "cuda-driver-update-required: Driver 535.98 supports CUDA 12.1; requires CUDA >= 12.4.",
          "cuda-driver-version-unknown: Could not read driver CUDA version.",
        ],
      }),
    );
    info.mockRestore();
  });

  it("holds a local model that needs free memory until a check finds it", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "low-memory"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: false,
        blockedNow: true,
        freeMemory: {
          ramAvailableBytes: 2899102924,
          ramRequiredBytes: 13689304433,
        },
        model: { name: "qwen3-8b" },
        reasons: [
          {
            code: "free-memory-required",
            freeBytes: 2899102924,
            requiredBytes: 13689304433,
          },
        ],
        recommendation: "codex",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "local_server.inspected",
      expect.objectContaining({ eligible: false, blocked_now: true }),
    );
    // The person closed other programs and checks again.
    rmSync(path.join(f.home, "low-memory"));
    f.module.recheck();
    expect(f.module.status().localModels).toEqual({ state: "checking" });
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: true,
        recommendation: "local-models",
      }),
    );
    expect(f.module.status().localModels).not.toHaveProperty("blockedNow");
    expect(f.module.status().localModels).not.toHaveProperty("freeMemory");
    info.mockRestore();
  });

  it("marks localModels blockedNow even when plan is null (such as gateway-port-in-use)", async () => {
    const f = fixture({ checkout: "/src" }, {}, (home) => {
      mkdirSync(home, { recursive: true });
      writeFileSync(path.join(home, "port-in-use"), "");
    });
    await f.host.start();
    f.module.inspect();
    await waitForInstaller(() =>
      expect(f.module.status().localModels).toMatchObject({
        state: "checked",
        eligible: false,
        blockedNow: true,
        reasons: [{ code: "gateway-port-in-use" }],
        recommendation: "codex",
      }),
    );
    expect(f.module.status().localModels).not.toHaveProperty("model");
    await f.host.stop("quit");
  });

  it("approves the deployment of the chosen local model", async () => {
    const api = installerApi([], {
      state: "waiting_user",
      errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
      localModelsPlan: { planId: "a".repeat(64) },
    });
    api.runtime.setupChoice = "local-models";
    const f = fixture(withCheckout, {}, checkout, api);
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    expect(f.api.created).toEqual([
      expect.objectContaining({
        setupChoice: "local-models",
      }),
    ]);
    expect(f.api.retried).toEqual([{ localModelsApproval: "a".repeat(64) }]);
    expect(f.module.status().phase).toBe("ready");
    // The local model runs on Pi, so the Computer prefers Pi.
    expect(f.host.ctx.config.get().preferredRuntime).toBe("pi");
    await f.host.stop("quit");
  });

  it("waits out a slow runtime lookup, says what it waits on and finishes", async () => {
    const restore = fakeClock();
    try {
      const api = installerApi([], {
        state: "succeeded",
        origin: "http://localhost:3000",
      });
      let finish!: () => void;
      api.runtime.lookup = new Promise((resolve) => {
        finish = resolve;
      });
      const f = fixture(withCheckout, {}, checkout, api);
      // As the desktop's enrollment does once signed in.
      f.enroll.mockImplementation(async () => {
        f.host.ctx.config.update({ computerId: "computer-1" });
      });
      await f.host.start();
      const done = f.module.begin();
      await waitForInstaller(() => expect(api.runtime.asked).toBe(1));
      expect(f.module.status()).toMatchObject({ phase: "installing" });
      expect(f.module.status().waiting).toBeUndefined();
      await vi.advanceTimersByTimeAsync(RUNTIME_LOOKUP_HINT_MS);
      expect(f.module.status()).toMatchObject({
        phase: "installing",
        waiting: "runtime",
      });
      // The lookup took 104 s on a reporter's Windows computer (#549),
      // past the 60 s the desktop once allowed it (#385).
      await vi.advanceTimersByTimeAsync(104_000 - RUNTIME_LOOKUP_HINT_MS);
      finish();
      await done;
      expect(f.module.status().phase).toBe("ready");
      expect(f.module.status().waiting).toBeUndefined();
      expect(api.runtime.asked).toBe(1);
      expect(f.host.ctx.config.get()).toMatchObject({
        runtimeEnvironment: api.runtime.environment,
        computerId: "computer-1",
      });
      await f.host.stop("quit");
    } finally {
      restore();
    }
  });

  it("names a runtime lookup that never ends, and Try Again picks up its late answer", async () => {
    const restore = fakeClock();
    try {
      const api = installerApi([], {
        state: "succeeded",
        origin: "http://localhost:3000",
      });
      let finish!: () => void;
      api.runtime.lookup = new Promise((resolve) => {
        finish = resolve;
      });
      const f = fixture(withCheckout, {}, checkout, api);
      f.enroll.mockImplementation(async () => {
        f.host.ctx.config.update({ computerId: "computer-1" });
      });
      await f.host.start();
      const first = f.module.begin().catch((error: unknown) => error);
      await waitForInstaller(() => expect(api.runtime.asked).toBe(1));
      await vi.advanceTimersByTimeAsync(RUNTIME_LOOKUP_LIMIT_MS);
      expect(await first).toMatchObject({ code: "runtime_lookup_timed_out" });
      expect(f.module.status()).toMatchObject({
        phase: "failed",
        failure: "runtime_lookup_timed_out",
      });
      expect(f.module.status().waiting).toBeUndefined();
      expect(f.enroll).not.toHaveBeenCalled();
      expect(f.host.ctx.config.get().computerId).toBeFalsy();
      // The installer's lookup ends after the desktop stopped waiting and
      // keeps its answer; Try Again (or the next launch) gets it at once.
      finish();
      await f.module.begin();
      expect(api.runtime.asked).toBe(2);
      expect(f.module.status()).toMatchObject({ phase: "ready" });
      expect(f.module.status().failure).toBeUndefined();
      expect(f.host.ctx.config.get().computerId).toBe("computer-1");
      await f.host.stop("quit");
    } finally {
      restore();
    }
  });

  it("asks for a new local model plan after a stopped deployment", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
      }),
    );
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    expect(f.api.retried).toEqual([{ localModelsReplan: true }]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("does not replan on binding-unavailable and reports the structured reason", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
        errorReasons: ["binding-unavailable"],
        message:
          "The upstream tool could not verify the local stack binding: Restore the existing install and try again.",
      }),
    );
    await f.host.start();
    await expect(f.module.begin({ runtime: "local" })).rejects.toThrow(
      "The local model stack couldn't be checked. Local model setup couldn't finish or verify this computer's local model state and Pi configuration. Check folder permissions or repair the existing installation and try again, or choose another AI runtime.",
    );
    expect(f.api.retried).toEqual([]);
    await f.host.stop("quit");
  });

  it("reports a repairable setup or verification error without double periods for LOCAL_MODELS_RECOVERY_REQUIRED", () => {
    const formatted = formatInstallJobFailure({
      errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
      message:
        "The upstream tool could not verify the local stack binding: Pi's configuration or this computer's state cannot be read safely. Restore the existing install and try again.. Existing resources were preserved.",
    });
    expect(formatted).not.toContain("can't run the local model");
    expect(formatted).toContain(
      "couldn't finish or verify this computer's local model state and Pi configuration",
    );
    expect(formatted).toContain("Check folder permissions or repair");
    expect(formatted).not.toContain("..");
    expect(formatted).toContain(
      "Restore the existing install and try again. Existing resources were preserved.",
    );

    const withReason = formatInstallJobFailure({
      errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
      message: "The upstream tool could not verify the local stack binding.",
      errorReasons: ["binding-unavailable"],
    });
    expect(withReason).toBe(
      "The local model stack couldn't be checked. Local model setup couldn't finish or verify this computer's local model state and Pi configuration. Check folder permissions or repair the existing installation and try again, or choose another AI runtime.",
    );
  });

  it("asks to free memory only when no local model fits", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_UNAVAILABLE",
      }),
    );
    await f.host.start();
    await expect(f.module.begin({ runtime: "local" })).rejects.toThrow(
      "Close other programs to free memory",
    );
    await f.host.stop("quit");
  });

  it("reports Hub reachability and disk failures accurately without blaming memory", async () => {
    for (const [causeCode, expected, forbidden] of [
      [
        "HUB_UNREACHABLE",
        "Couldn't reach the model download service",
        "free memory",
      ],
      ["DISK_INSUFFICIENT", "enough free disk space", "free memory"],
      [
        "GPU_CONFLICT",
        "Choose another AI runtime and try again.",
        "free memory",
      ],
      [
        "STACK_PLAN_FAILED",
        "Choose another AI runtime and try again.",
        "free memory",
      ],
      ["MEMORY_INSUFFICIENT", "Close other programs to free memory", "disk"],
    ] as const) {
      const f = fixture(
        withCheckout,
        {},
        checkout,
        installerApi([], {
          state: "waiting_user",
          errorCode: "LOCAL_MODELS_UNAVAILABLE",
          errorCauseCode: causeCode,
          message: `upstream cause ${causeCode}`,
        }),
      );
      await f.host.start();
      const failure = f.module.begin({ runtime: "local" });
      await expect(failure).rejects.toThrow(expected);
      await expect(failure).rejects.not.toThrow(forbidden);
      await f.host.stop("quit");
    }
  });

  it("retries the approved plan once on interrupted download instead of blind replanning", async () => {
    const planId = "a".repeat(64);
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [],
        [
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
            localModelsPlan: { planId },
          },
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
            errorCauseCode: "STACK_COMPONENT_FAILED",
            message: "Local model setup failed at: llm.",
          },
          DONE,
        ],
      ),
    );
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    expect(f.api.retried).toEqual([
      { localModelsApproval: planId },
      { localModelsApproval: planId },
    ]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("stops without blind replanning when retrying the approved plan fails again with STACK_COMPONENT_FAILED", async () => {
    const planId = "a".repeat(64);
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [],
        [
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
            localModelsPlan: { planId },
          },
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
            errorCauseCode: "STACK_COMPONENT_FAILED",
            message: "Local model setup failed at: llm.",
          },
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
            errorCauseCode: "STACK_COMPONENT_FAILED",
            message: "Local model setup failed at: llm.",
          },
        ],
      ),
    );
    await f.host.start();
    const failure = f.module.begin({ runtime: "local" });
    await expect(failure).rejects.toThrow(
      "Local model download or setup was interrupted",
    );
    await expect(failure).rejects.not.toThrow("free memory");
    expect(f.api.retried).toEqual([
      { localModelsApproval: planId },
      { localModelsApproval: planId },
    ]);
    await f.host.stop("quit");
  });

  it("still replans once when an approved plan fails with a non-retryable recovery cause", async () => {
    for (const causeCode of ["STACK_PLAN_CHANGED", "SEARCH_UNAVAILABLE"]) {
      const firstPlan = "a".repeat(64);
      const secondPlan = "b".repeat(64);
      const f = fixture(
        withCheckout,
        {},
        checkout,
        installerApi(
          [],
          [
            {
              state: "waiting_user",
              errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
              localModelsPlan: { planId: firstPlan },
            },
            {
              state: "waiting_user",
              errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
              errorCauseCode: causeCode,
            },
            {
              state: "waiting_user",
              errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
              localModelsPlan: { planId: secondPlan },
            },
            DONE,
          ],
        ),
      );
      await f.host.start();
      await f.module.begin({ runtime: "local" });
      expect(f.api.retried).toEqual([
        { localModelsApproval: firstPlan },
        { localModelsReplan: true },
        { localModelsApproval: secondPlan },
      ]);
      expect(f.module.status().phase).toBe("ready");
      await f.host.stop("quit");
    }
  });

  it("replans once when STACK_COMPONENT_FAILED arrives without a prior approval in this run", async () => {
    const replannedPlan = "c".repeat(64);
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [],
        [
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
            errorCauseCode: "STACK_COMPONENT_FAILED",
            message: "Local model setup failed at: llm.",
          },
          {
            state: "waiting_user",
            errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
            localModelsPlan: { planId: replannedPlan },
          },
          DONE,
        ],
      ),
    );
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    expect(f.api.retried).toEqual([
      { localModelsReplan: true },
      { localModelsApproval: replannedPlan },
    ]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("emits local-server.busy while installing and releases it on both success and failure", async () => {
    const events: boolean[] = [];
    const ok = fixture(withCheckout, {}, checkout, installerApi());
    ok.bus.on("local-server.busy", (busy) => events.push(busy));
    await ok.host.start();
    await ok.module.begin({ runtime: "local" });
    expect(events).toEqual([true, false]);
    await ok.host.stop("quit");

    events.length = 0;
    const failed = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_UNAVAILABLE",
        errorCauseCode: "HUB_UNREACHABLE",
      }),
    );
    failed.bus.on("local-server.busy", (busy) => events.push(busy));
    await failed.host.start();
    await expect(failed.module.begin({ runtime: "local" })).rejects.toThrow(
      "model download service",
    );
    expect(events).toEqual([true, false]);
    await failed.host.stop("quit");
  });

  it("starts again past an attempt that stopped waiting for the person", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([
        {
          id: "job",
          instance: LOCAL_INSTANCE,
          createdAt: "2026-11-03T00:00:00Z",
          state: "waiting_user",
          errorCode: "LOCAL_MODELS_UNAVAILABLE",
        },
      ]),
    );
    await f.host.start();
    await f.module.begin({ runtime: "local" });
    // The stopped attempt is closed first, or the installer hands it back.
    expect(f.api.canceled).toEqual(["job"]);
    expect(f.api.created).toEqual([
      { instance: LOCAL_INSTANCE, setupChoice: "local-models" },
    ]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("approves no local model the person did not choose", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], {
        state: "waiting_user",
        errorCode: "LOCAL_MODELS_APPROVAL_REQUIRED",
        localModelsPlan: { planId: "a".repeat(64) },
        message: "Review the plan before installing.",
      }),
    );
    await f.host.start();
    const failure = f.module.begin({ runtime: "pi" });
    await expect(failure).rejects.toThrow("can't run the local model");
    await expect(failure).rejects.not.toThrow("free memory");
    // The installer's own reason follows the advice.
    await expect(failure).rejects.toThrow(
      "Choose another AI runtime and try again. (Review the plan before installing.)",
    );
    expect(f.api.retried).toEqual([]);
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("installs LINGER_CHECKOUT only when it is a Linger source", async () => {
    const f = fixture(withCheckout, {}, (home) =>
      mkdirSync(path.join(home, "src"), { recursive: true }),
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow(/not a Linger checkout/);
    checkout(f.home);
    await f.module.begin({ runtime: "claude" });
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(
      realpathSync(path.join(f.home, "src")),
    );
    expect(f.api.created).toEqual([
      expect.objectContaining({
        setupChoice: "claude",
      }),
    ]);
    expect(f.module.status()).toMatchObject({
      phase: "ready",
    });
    // A checkout downloads nothing.
    expect(f.module.status().steps).not.toContain("download");
    await f.host.stop("quit");
  });

  it("logs the serving installer's timing events at info and other stderr at warn", async () => {
    const f = fixture(withCheckout, {}, (home) => {
      checkout(home);
      writeFileSync(
        path.join(home, "serve-stderr"),
        `${JSON.stringify({
          event: "installer.runtime_lookup_timings",
          instance: "desktop",
          timings: {
            config: 1,
            runtime: 2,
            localModels: 3,
            tool: 4,
            total: 10,
          },
        })}\nSomething else\n`,
      );
    });
    const info = vi.spyOn(silentLog, "info");
    const warn = vi.spyOn(silentLog, "warn");
    await f.host.start();
    await f.module.begin({ runtime: "claude" });
    await waitForInstaller(() =>
      expect(warn).toHaveBeenCalledWith("local_server.installer_stderr", {
        line: "Something else",
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "local_server.installer_runtime_timings",
      {
        instance: "desktop",
        config_ms: 1,
        runtime_ms: 2,
        local_models_ms: 3,
        tool_ms: 4,
        total_ms: 10,
      },
    );
    expect(warn).not.toHaveBeenCalledWith(
      "local_server.installer_stderr",
      expect.objectContaining({
        line: expect.stringContaining("runtime_lookup_timings"),
      }),
    );
    info.mockRestore();
    warn.mockRestore();
    await f.host.stop("quit");
  });

  it("enrolls this computer again, once, after the installer set the earlier Simplex data aside", async () => {
    const backup = (home: string) =>
      path.join(
        home,
        "instances",
        LOCAL_INSTANCE,
        "simplex-backup-2026-11-17T03-04-05-678Z",
      );
    const prepare = (home: string) => {
      checkout(home);
      mkdirSync(backup(home), { recursive: true });
    };
    const f = fixture(withCheckout, {}, prepare);
    await f.host.start();
    await f.module.begin();
    expect(f.unenroll).toHaveBeenCalledOnce();
    expect(f.unenroll.mock.invocationCallOrder[0]).toBeLessThan(
      f.enroll.mock.invocationCallOrder[0]!,
    );
    expect(f.config().legacyBackup).toBe(backup(f.home));
    expect(f.module.status()).toMatchObject({
      phase: "ready",
      legacyBackup: backup(f.home),
    });
    await f.host.stop("quit");

    // Told about already: the enrollment of the fresh database stays.
    const again = fixture(withCheckout, {}, prepare);
    again.host.ctx.config.update({ legacyBackup: backup(again.home) });
    await again.host.start();
    await again.module.begin();
    expect(again.unenroll).not.toHaveBeenCalled();
    expect(again.enroll).toHaveBeenCalled();
    expect(again.module.status().legacyBackup).toBeUndefined();
    await again.host.stop("quit");
  });

  it("shows no download step when nothing is downloaded", async () => {
    const f = fixture(withCheckout, {}, checkout);
    await f.host.start();
    const seen: { step: string; progress: number }[] = [];
    f.host.ctx.bus.on("local-server.changed", () => {
      const { step, progress } = f.module.status();
      seen.push({ step, progress });
    });
    await f.module.begin();
    expect(f.module.status().steps).toEqual([
      "prepare",
      "services",
      "workspace",
      "connect",
      "agents",
    ]);
    expect(seen.map(({ step }) => step)).not.toContain("download");
    // The installer's download stages finish preparing, within its share.
    expect(
      seen.filter(({ step }) => step === "prepare").at(-1)!.progress,
    ).toBeLessThanOrEqual(1 / 5);
    const progress = seen.map(({ progress }) => progress);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    await f.host.stop("quit");
  });

  it("falls back to Codex when the installer cannot inspect this computer", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [],
        undefined,
        Response.json({ message: "invalid" }, { status: 400 }),
      ),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toEqual([
      expect.objectContaining({ setupChoice: "codex" }),
    ]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("moves the bar while native services come up", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], undefined, undefined, {
        state: "running",
        stage: "services",
        message: "Waiting for native compilation and readiness (2/4 ready).",
        stages: [{ id: "services", state: "running" }],
      }),
    );
    await f.host.start();
    const seen: number[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      seen.push(f.module.status().progress),
    );
    await f.module.begin();
    // Services are the second of five steps without a download; half ready
    // is 1/5 + 0.625/5.
    expect(seen).toContain(0.325);
    await f.host.stop("quit");
  });

  it("shows the local model download the installer counts", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], undefined, undefined, {
        state: "running",
        stage: "runtime",
        message: "Downloading the local model…",
        stages: [
          {
            id: "runtime",
            state: "running",
            progress: {
              completed: 4,
              total: 10,
              unit: "bytes",
              bytesPerSecond: 2,
              partial: true,
            },
          },
        ],
      }),
    );
    await f.host.start();
    const seen: unknown[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      seen.push(f.module.status().transfer),
    );
    await f.module.begin();
    expect(seen).toContainEqual({
      label: "Downloading the local model…",
      completed: 4,
      total: 10,
      bytesPerSecond: 2,
      partial: true,
    });
    // Done, nothing downloads.
    expect(f.module.status().transfer).toBeUndefined();
    await f.host.stop("quit");
  });

  it("never steps back while the runtime prepares beside the checkout", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], undefined, undefined, [
        {
          state: "running",
          stage: "runtime",
          stages: [{ id: "runtime", state: "running" }],
        },
        { state: "running", stage: "images" },
      ]),
    );
    await f.host.start();
    const steps: string[] = [];
    f.host.ctx.bus.on("local-server.changed", () =>
      steps.push(f.module.status().step),
    );
    await f.module.begin();
    // The runtime reports from its own task while dependencies install.
    expect(steps).toContain("services");
    expect(steps.slice(steps.indexOf("services"))).not.toContain("prepare");
    await f.host.stop("quit");
  });

  it("follows the installation already running", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([
        {
          id: "other",
          instance: "default",
          state: "running",
          createdAt: "2026-11-04T00:00:00Z",
          stages: [],
        },
        {
          id: "job",
          instance: LOCAL_INSTANCE,
          state: "running",
          createdAt: "2026-11-03T00:00:00Z",
          stages: [],
        },
      ]),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toEqual([]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it.each([
    ["a subscription runtime", { runtime: "codex" } as const, "codex"],
    // The subscription on a computer whose pick is the local model.
    ["the installer's pick", { runtime: "recommended" } as const, "pi"],
  ])(
    "does not follow the local model download after %s is chosen instead",
    async (_name, plan, setupChoice) => {
      // The person chose the local model, quit part way through its
      // download, and chose again; the installer kept that job running.
      const f = fixture(
        withCheckout,
        {},
        checkout,
        installerApi([
          {
            id: "download",
            instance: LOCAL_INSTANCE,
            setupChoice: "local-models",
            state: "running",
            stage: "runtime",
            message: "Downloading the local model…",
            createdAt: "2026-11-03T00:00:00Z",
            stages: [{ id: "runtime", state: "running" }],
          },
        ]),
      );
      await f.host.start();
      const messages: string[] = [];
      f.host.ctx.bus.on("local-server.changed", () =>
        messages.push(f.module.status().message),
      );
      await f.module.begin(plan);
      expect(f.api.created).toEqual([
        { instance: LOCAL_INSTANCE, setupChoice },
      ]);
      expect(messages).not.toContain("Downloading the local model…");
      expect(f.module.status().phase).toBe("ready");
      await f.host.stop("quit");
    },
  );

  it("installs the local model chosen after a subscription setup", async () => {
    const subscription = {
      id: "old",
      instance: LOCAL_INSTANCE,
      setupChoice: "codex",
      state: "succeeded",
      origin: "http://localhost:3000",
      createdAt: "2026-11-03T00:00:00Z",
      stages: [],
    };
    // Its services still answer, so the same choice would follow it.
    const answering = (home: string) => ({
      ...withCheckout(home),
      fetch: (async () => new Response(null)) as typeof fetch,
    });
    const same = fixture(answering, {}, checkout, installerApi([subscription]));
    await same.host.start();
    await same.module.begin({ runtime: "codex" });
    expect(same.api.created).toEqual([]);
    await same.host.stop("quit");
    for (const state of ["succeeded", "running"]) {
      const f = fixture(
        answering,
        {},
        checkout,
        installerApi(
          [{ ...subscription, state }],
          DONE,
          undefined,
          // The new job stays queued until the running one has stopped,
          // which takes until the end of a step such as starting services.
          state === "running"
            ? [
                { state: "queued" },
                { state: "queued" },
                { state: "queued" },
                { state: "running", stage: "images" },
              ]
            : undefined,
        ),
      );
      await f.host.start();
      await f.module.begin({ runtime: "local" });
      expect(f.api.created).toEqual([
        { instance: LOCAL_INSTANCE, setupChoice: "local-models" },
      ]);
      expect(f.module.status().phase).toBe("ready");
      await f.host.stop("quit");
    }
  });

  it("installs again when a finished installation's data is gone", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi(
        [
          {
            id: "old",
            instance: LOCAL_INSTANCE,
            state: "succeeded",
            origin: "http://localhost:3000",
            createdAt: "2026-11-03T00:00:00Z",
            stages: [],
          },
        ],
        DONE,
        undefined,
        undefined,
        false,
      ),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toHaveLength(1);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("installs again when a finished installation's services are not running", async () => {
    // The app or the computer stopped after the installation finished and
    // before this computer connected; nothing answers at its origin.
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([
        {
          id: "old",
          instance: LOCAL_INSTANCE,
          state: "succeeded",
          origin: "http://localhost:3000",
          createdAt: "2026-11-03T00:00:00Z",
          stages: [],
        },
      ]),
    );
    await f.host.start();
    await f.module.begin();
    expect(f.api.created).toHaveLength(1);
    expect(f.enroll).toHaveBeenCalledOnce();
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("follows an installation that moved to another origin as the same server", async () => {
    const f = fixture(withCheckout, {}, (home) => {
      checkout(home);
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({
          home,
          repo: path.join(home, "src"),
          origin: "http://localhost:2999",
        }),
      );
    });
    await f.host.start();
    await f.module.begin();
    expect(f.module.status().phase).toBe("ready");
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3000",
      "http://localhost:2999",
      { reason: "local_ready" },
    );
    expect(f.unenroll).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("saves provider keys in user.env before the installation runs again with them", async () => {
    const finishedJob = {
      id: "old",
      instance: LOCAL_INSTANCE,
      state: "succeeded",
      origin: "http://localhost:3000",
      createdAt: "2026-11-03T00:00:00Z",
      stages: [],
    };
    const f = fixture(withCheckout, {}, checkout, installerApi([finishedJob]));
    await f.host.start();
    expect(f.module.status().keys).toEqual({ composio: false });
    const info = vi.spyOn(silentLog, "info");
    const warn = vi.spyOn(silentLog, "warn");
    await f.module.begin({
      runtime: "claude",
      keys: { composio: "composio-1" },
    });
    // The keys go over stdin, never in the arguments.
    const keysArgs = readFileSync(path.join(f.home, "keys-args.json"), "utf8");
    expect(JSON.parse(keysArgs)).toEqual([
      "--home",
      f.home,
      "--instance",
      LOCAL_INSTANCE,
      "--user-keys",
    ]);
    expect(
      readFileSync(
        path.join(f.home, "instances", LOCAL_INSTANCE, "user.env"),
        "utf8",
      ),
    ).toBe("COMPOSIO_API_KEY=composio-1\n");
    expect(f.module.status().keys).toEqual({ composio: true });
    // The finished installation does not carry them, so a new one runs.
    expect(f.api.created).toHaveLength(1);
    expect(f.module.status().phase).toBe("ready");
    expect(info).toHaveBeenCalledWith("local_server.keys_saved", {
      saved: ["COMPOSIO_API_KEY"],
    });
    const logged = JSON.stringify([info.mock.calls, warn.mock.calls]);
    expect(logged).not.toContain("composio-1");
    info.mockRestore();
    warn.mockRestore();
    await f.host.stop("quit");

    // Removing the Composio key keeps the voice keys a person put in
    // user.env by hand; without changes the finished
    // installation is followed as before.
    const again = fixture(
      withCheckout,
      {},
      (home) => {
        checkout(home);
        mkdirSync(path.join(home, "instances", LOCAL_INSTANCE), {
          recursive: true,
        });
        writeFileSync(
          path.join(home, "instances", LOCAL_INSTANCE, "user.env"),
          "COMPOSIO_API_KEY=composio-1\nSONIOX_API_KEY=soniox-1\n",
        );
      },
      installerApi([finishedJob]),
    );
    await again.host.start();
    await again.module.begin({
      runtime: "claude",
      keys: { composio: "" },
    });
    expect(again.module.status().keys).toEqual({ composio: false });
    expect(
      readFileSync(
        path.join(again.home, "instances", LOCAL_INSTANCE, "user.env"),
        "utf8",
      ),
    ).toBe("SONIOX_API_KEY=soniox-1\n");
    await again.host.stop("quit");
    // Its services still answer.
    const plain = fixture(
      (home) => ({
        ...withCheckout(home),
        fetch: (async () => new Response(null)) as typeof fetch,
      }),
      {},
      checkout,
      installerApi([finishedJob]),
    );
    await plain.host.start();
    await plain.module.begin({ runtime: "claude" });
    expect(existsSync(path.join(plain.home, "keys-args.json"))).toBe(false);
    expect(plain.api.created).toEqual([]);
    await plain.host.stop("quit");
  });

  it("stops before installing when the keys cannot be saved", async () => {
    const f = fixture(withCheckout, {}, checkout);
    await f.host.start();
    await expect(
      f.module.begin({
        runtime: "claude",
        keys: { composio: "bad" },
      }),
    ).rejects.toThrow(
      "Keys could not be saved: COMPOSIO_API_KEY is not a valid key",
    );
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    expect(f.module.status().phase).toBe("failed");
    await f.host.stop("quit");
  });

  it("reports a failed installation", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], { state: "failed", message: "Port 3000 is in use" }),
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow("Port 3000 is in use");
    expect(f.module.status()).toMatchObject({
      phase: "failed",
      message: "Port 3000 is in use",
    });
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("keeps the installer's refusal of a folder with the failure it caused", async () => {
    const f = fixture(withCheckout, {}, checkout);
    await f.host.start();
    try {
      writeFileSync(path.join(f.home, "start-refused"), "");
      await expect(f.module.begin()).rejects.toThrow(
        "The installer stopped while starting. Installer could not start (WINDOWS_PRIVATE_PATH_UNSAFE): Windows private path validation failed",
      );
      expect(f.module.status()).toMatchObject({
        phase: "failed",
        refusal: {
          code: "WINDOWS_PRIVATE_PATH_UNSAFE",
          reason: "UNSAFE_OWNER",
        },
      });
      rmSync(path.join(f.home, "start-refused"));
      await expect(
        f.module.begin({ runtime: "claude", keys: { composio: "refused" } }),
      ).rejects.toThrow("Keys could not be saved");
      expect(f.module.status().refusal).toEqual({
        code: "WINDOWS_PRIVATE_PATH_UNSAFE",
        reason: "UNSAFE_PARENT_ACCESS",
      });
      // Another failure does not carry it on.
      await expect(
        f.module.begin({ runtime: "claude", keys: { composio: "bad" } }),
      ).rejects.toThrow("COMPOSIO_API_KEY is not a valid key");
      expect(f.module.status().phase).toBe("failed");
      expect(f.module.status().refusal).toBeUndefined();
    } finally {
      await f.host.stop("quit");
    }
  });

  it("pre-checks both the install home and Computer daemon directory on Windows before unpacking", async () => {
    const checked: string[] = [];
    const daemonDir = "C:\\Users\\me\\AppData\\Roaming\\Linger\\computer";
    const winCheckout = (home: string) => {
      checkout(home);
      writeFileSync(
        path.join(path.dirname(home), "installer", "distribution.json"),
        JSON.stringify({
          platform: "win32",
          arch: "x64",
          nativeSources: [{ target: "win32-x64" }],
        }),
      );
    };
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        platform: "win32",
        arch: "x64",
        daemonDirectory: daemonDir,
        checkPrivateLocation: async (directory) => {
          checked.push(directory);
          if (directory === daemonDir) {
            throw Object.assign(
              new Error(
                `Windows private path validation failed: ${daemonDir} is inside a folder other accounts on this computer can rename or replace (ancestor: C:\\Users\\me\\AppData\\Roaming, sid: S-1-5-21-1-2-3-1007).`,
              ),
              {
                code: "WINDOWS_PRIVATE_PATH_UNSAFE",
                reason: "UNSAFE_PARENT_ACCESS",
              },
            );
          }
        },
      }),
      {},
      winCheckout,
    );
    await f.host.start();
    try {
      await expect(f.module.begin()).rejects.toThrow(
        `Desktop Computer directory validation failed: Windows private path validation failed: ${daemonDir}`,
      );
      expect(checked).toEqual([f.home, daemonDir]);
      expect(f.module.status()).toMatchObject({
        phase: "failed",
        step: "prepare",
      });
      // Daemon directory refusal must not masquerade as an install-location refusal.
      expect(f.module.status().refusal).toBeUndefined();
      // Installer never launched because preflight stopped in prepare.
      expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(
        false,
      );
    } finally {
      await f.host.stop("quit");
    }
  });

  it("preserves the Windows private-path refusal when home preflight fails", async () => {
    const winCheckout = (home: string) => {
      checkout(home);
      writeFileSync(
        path.join(path.dirname(home), "installer", "distribution.json"),
        JSON.stringify({
          platform: "win32",
          arch: "x64",
          nativeSources: [{ target: "win32-x64" }],
        }),
      );
    };
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        platform: "win32",
        arch: "x64",
        daemonDirectory: "C:\\Users\\me\\AppData\\Roaming\\Linger\\computer",
        checkPrivateLocation: async () => {
          throw Object.assign(
            new Error(
              "Windows private path validation failed: home is inside a folder other accounts on this computer can rename or replace (ancestor: C:\\Users\\me, sid: S-1-5-21-1-2-3-1007).",
            ),
            {
              code: "WINDOWS_PRIVATE_PATH_UNSAFE",
              reason: "UNSAFE_PARENT_ACCESS",
            },
          );
        },
      }),
      {},
      winCheckout,
    );
    await f.host.start();
    try {
      await expect(f.module.begin()).rejects.toThrow(
        "Windows private path validation failed",
      );
      expect(f.module.status()).toMatchObject({
        phase: "failed",
        step: "prepare",
        refusal: {
          code: "WINDOWS_PRIVATE_PATH_UNSAFE",
          reason: "UNSAFE_PARENT_ACCESS",
        },
      });
    } finally {
      await f.host.stop("quit");
    }
  });
});

describe("LocalServerModule install location", () => {
  it.each(["empty", "missing", "nonempty"])(
    "leaves the %s candidate untouched when selecting, resetting and selecting it again",
    async (kind) => {
      const f = fixture({ checkout: "/src" });
      const picked = path.join(f.root, "data");
      if (kind !== "missing") mkdirSync(picked);
      if (kind === "nonempty")
        writeFileSync(path.join(picked, "notes.txt"), "keep");
      const target = kind === "nonempty" ? path.join(picked, "Linger") : picked;
      await f.host.start();
      try {
        f.module.inspect();
        await waitForInstaller(() =>
          expect(f.module.status().localModels.state).toBe("checked"),
        );
        for (let attempt = 0; attempt < 2; attempt++) {
          await f.module.chooseLocation(picked);
          await waitForInstaller(() =>
            expect(f.module.status().localModels.state).toBe("checked"),
          );
          expect(f.module.status().location.path).toBe(target);
          expect(
            kind === "missing" ? existsSync(picked) : readdirSync(picked),
          ).toEqual(
            kind === "missing" ? false : kind === "empty" ? [] : ["notes.txt"],
          );
          if (kind === "nonempty") expect(existsSync(target)).toBe(false);
          await f.module.chooseLocation(null);
          await waitForInstaller(() =>
            expect(f.module.status().localModels.state).toBe("checked"),
          );
        }
      } finally {
        await f.host.stop("quit");
      }
    },
  );

  it("rechecks a new location and allows manual checks after installation fails", async () => {
    const f = fixture(
      withCheckout,
      {},
      checkout,
      installerApi([], { state: "failed", message: "Disk full" }),
    );
    const picked = path.join(f.root, "models");
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toMatchObject({
          state: "checked",
          eligible: true,
        }),
      );
      await expect(f.module.begin()).rejects.toThrow("Disk full");
      expect(f.module.status().phase).toBe("failed");
      mkdirSync(path.join(picked, "instances"), { recursive: true });
      writeFileSync(path.join(picked, "small-computer"), "");
      await f.module.chooseLocation(picked);
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toMatchObject({
          state: "checked",
          eligible: false,
        }),
      );
      expect(inspectArgs(f.home)).toContain(picked);
      rmSync(path.join(picked, "small-computer"));
      f.module.recheck();
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toMatchObject({
          state: "checked",
          eligible: true,
        }),
      );
    } finally {
      await f.host.stop("quit");
    }
  });

  it("checks the folder selected before the first model check", async () => {
    const f = fixture({ checkout: "/src" });
    const picked = path.join(f.root, "models");
    await f.host.start();
    try {
      await f.module.chooseLocation(picked);
      f.module.inspect();
      await waitForInstaller(() =>
        expect(f.module.status().localModels.state).toBe("checked"),
      );
      expect(inspectArgs(f.home)).toEqual([
        "--home",
        f.home,
        "--inspect",
        "--inspect-target",
        picked,
      ]);
      expect(existsSync(picked)).toBe(false);
      expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(
        false,
      );
    } finally {
      await f.host.stop("quit");
    }
  });

  it.each([false, true])(
    "rechecks the selected folder when an earlier check finishes (failed: %s)",
    async (failed) => {
      const f = fixture({ checkout: "/src" });
      const picked = path.join(f.root, "models");
      writeFileSync(path.join(f.home, "tool-download"), "");
      if (failed) writeFileSync(path.join(f.home, "check-fails"), "");
      await f.host.start();
      try {
        f.module.inspect();
        await waitForInstaller(() =>
          expect(inspectArgs(f.home)).toContain("--inspect"),
        );
        await f.module.chooseLocation(picked);
        writeFileSync(path.join(f.home, "tool-ready"), "");
        await waitForInstaller(() =>
          expect(inspectArgs(f.home)).toEqual([
            "--home",
            f.home,
            "--inspect",
            "--inspect-target",
            picked,
          ]),
        );
        await waitForInstaller(() =>
          expect(f.module.status().localModels).toMatchObject({
            state: "checked",
            eligible: true,
          }),
        );
        rmSync(path.join(f.home, "check-fails"), { force: true });
        writeFileSync(path.join(f.home, "small-computer"), "");
        await f.module.chooseLocation(null);
        await waitForInstaller(() =>
          expect(f.module.status().localModels).toMatchObject({
            state: "checked",
            eligible: false,
          }),
        );
      } finally {
        writeFileSync(path.join(f.home, "tool-ready"), "");
        await f.host.stop("quit");
      }
    },
  );

  it("aborts an in-flight inspection without warning when installing into a custom location", async () => {
    const warn = vi.spyOn(silentLog, "warn");
    const f = fixture(withCheckout, {}, checkout);
    const picked = path.join(f.root, "custom-home");
    writeFileSync(path.join(f.home, "tool-download"), "");
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toEqual({
          state: "checking",
          download: { completed: 5, total: 10 },
        }),
      );
      await f.module.chooseLocation(picked);
      await f.module.begin({
        runtime: "codex",
        byok: {
          baseUrl: "https://api.example.com",
          path: "/v1",
          endpoint: "/responses",
          protocol: "openai-responses",
          modelId: "gpt-5.4",
          runtime: "codex",
        },
      });
      // tool-ready was never created: the check only settled because install aborted it.
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toEqual({ state: "unchecked" }),
      );
      expect(warn).not.toHaveBeenCalledWith(
        "local_server.inspect_failed",
        expect.anything(),
      );
      expect(f.module.status().phase).toBe("ready");
      expect(installerArgs(picked)).toContain(picked);
    } finally {
      warn.mockRestore();
      writeFileSync(path.join(f.home, "tool-ready"), "");
      await f.host.stop("quit");
    }
  });

  it("keeps an in-flight inspection running when installing BYOK into the default location", async () => {
    const f = fixture(withCheckout, {}, checkout);
    writeFileSync(path.join(f.home, "tool-download"), "");
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toEqual({
          state: "checking",
          download: { completed: 5, total: 10 },
        }),
      );
      await f.module.begin({
        runtime: "codex",
        byok: {
          baseUrl: "https://api.example.com",
          path: "/v1",
          endpoint: "/responses",
          protocol: "openai-responses",
          modelId: "gpt-5.4",
          runtime: "codex",
        },
      });
      // Default-location install succeeds while inspection stays in flight.
      expect(f.module.status().phase).toBe("ready");
      expect(f.module.status().localModels.state).toBe("checking");
      // Releasing the tool download lets the same un-aborted inspection finish cleanly.
      writeFileSync(path.join(f.home, "tool-ready"), "");
      await waitForInstaller(() =>
        expect(f.module.status().localModels).toMatchObject({
          state: "checked",
          eligible: true,
        }),
      );
    } finally {
      writeFileSync(path.join(f.home, "tool-ready"), "");
      await f.host.stop("quit");
    }
  });

  it("installs into the folder picked on the setup page", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    const f = fixture({ sourceArchive: { file, sha256: archive.sha256 } });
    await f.host.start();
    expect(f.module.status().location).toEqual({
      path: f.home,
      custom: false,
    });
    const picked = path.join(f.root, "Data");
    mkdirSync(picked);
    writeFileSync(path.join(picked, "notes.txt"), "");
    await f.module.chooseLocation(picked);
    const home = path.join(picked, "Linger");
    expect(f.module.status().location).toEqual({
      path: home,
      custom: true,
      freeBytes: expect.any(Number),
      minFreeBytes: 1,
    });

    await f.module.begin();
    const args = installerArgs(home);
    expect(args[args.indexOf("--home") + 1]).toBe(home);
    expect(
      args[args.indexOf("--source-repo") + 1]!.startsWith(
        path.join(home, "desktop", "source"),
      ),
    ).toBe(true);
    // The desktop's record stays in the default home and points there.
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ home });
    expect(existsSync(path.join(f.home, "installer"))).toBe(false);
    expect(f.module.status().location).toEqual({ path: home, custom: false });
    await f.host.stop("quit");
  });

  it("creates the picked folder and can restore the default", async () => {
    const f = fixture({ checkout: "/src" });
    await f.host.start();
    await f.module.chooseLocation(path.join(f.root, "missing", "deeper"));
    // A folder that does not exist yet is made in the nearest one that does.
    expect(f.module.status().location).toEqual({
      path: path.join(f.root, "missing", "deeper"),
      custom: true,
      freeBytes: expect.any(Number),
      minFreeBytes: 1,
    });
    await f.module.chooseLocation(null);
    expect(f.module.status().location).toEqual({
      path: f.home,
      custom: false,
      freeBytes: expect.any(Number),
      minFreeBytes: 1,
    });
    await f.host.stop("quit");
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "rejects a folder without POSIX write permission",
    async () => {
      const f = fixture({ checkout: "/src" });
      const locked = path.join(f.root, "locked");
      mkdirSync(locked, { mode: 0o500 });
      await f.host.start();
      try {
        await f.module.chooseLocation(locked);
        expect(f.module.status().location).toEqual({
          path: f.home,
          custom: false,
          error: "Linger can't write to this folder. Choose another one.",
          rejectedPath: locked,
        });
      } finally {
        chmodSync(locked, 0o700);
        await f.host.stop("quit");
      }
    },
  );

  it("installs into an empty folder or one that holds Linger", async () => {
    const root = tempDirectory();
    expect(await installLocation(root)).toBe(root);
    writeFileSync(path.join(root, ".DS_Store"), "");
    expect(await installLocation(root)).toBe(root);
    mkdirSync(path.join(root, "instances"));
    writeFileSync(path.join(root, "notes.txt"), "");
    expect(await installLocation(root)).toBe(root);
    const other = tempDirectory();
    writeFileSync(path.join(other, "notes.txt"), "");
    expect(await installLocation(other)).toBe(path.join(other, "Linger"));
  });

  it("asks for free space on the folder's disk", async () => {
    const root = tempDirectory();
    expect(await checkLocation(root, 1)).toBeUndefined();
    expect(await checkLocation(root, Number.MAX_SAFE_INTEGER)).toMatch(
      /^Needs \d+ GB free; this disk has \d+ GB\.$/,
    );
    expect(await checkLocation("relative", 1)).toBe(
      "Choose a folder on this computer.",
    );
  });

  it("checks the default Windows data folder before launching the installer", async () => {
    const f = fixture({
      checkout: "/src",
      platform: "win32",
      freeBytes: Number.MAX_SAFE_INTEGER,
    });
    await f.host.start();
    try {
      await expect(f.module.begin()).rejects.toThrow(/Needs \d+ GB free/);
      expect(f.module.status().message).toContain(f.home);
      expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(
        false,
      );
    } finally {
      await f.host.stop("quit");
    }
  });

  it("reports an unsafe Windows folder without selecting it", async () => {
    const f = fixture({
      platform: "win32",
      checkPrivateLocation: async () => {
        throw new Error("This folder has shared access.");
      },
    });
    const picked = path.join(f.root, "shared");
    await f.module.chooseLocation(picked);
    expect(f.module.status().location).toEqual({
      path: f.home,
      custom: false,
      error: "This folder has shared access.",
      rejectedPath: picked,
    });
  });

  it("reads freeDiskBytes read-only without creating missing folders or probe files", async () => {
    const root = tempDirectory();
    const missing = path.join(root, "does-not-exist", "deeper");
    const free = await freeDiskBytes(missing);
    expect(typeof free).toBe("number");
    expect(Number.isFinite(free)).toBe(true);
    expect(free!).toBeGreaterThanOrEqual(0);
    expect(existsSync(path.join(root, "does-not-exist"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
    expect(await freeDiskBytes("relative/path")).toBeUndefined();
  });

  it("refreshes location space and emits only when freeBytes changes", async () => {
    const GiB = 1024 ** 3;
    let currentHomeFree = 5 * GiB;
    const f = fixture({
      checkout: "/src",
      freeBytes: 20 * GiB,
      freeDiskBytes: async () => currentHomeFree,
    });
    await f.host.start();
    const changed = vi.fn();
    const off = f.bus.on("local-server.changed", changed);
    try {
      await f.module.refreshLocationSpace();
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 5 * GiB,
        minFreeBytes: 20 * GiB,
      });
      expect(changed).toHaveBeenCalledTimes(1);

      // Same value does not emit again.
      await f.module.refreshLocationSpace();
      expect(changed).toHaveBeenCalledTimes(1);

      // A changed value updates status and emits.
      currentHomeFree = 35 * GiB;
      await f.module.refreshLocationSpace();
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 35 * GiB,
        minFreeBytes: 20 * GiB,
      });
      expect(changed).toHaveBeenCalledTimes(2);
    } finally {
      off();
      await f.host.stop("quit");
    }
  });

  it("discards a stale refreshLocationSpace result when chooseLocation runs concurrently", async () => {
    const GiB = 1024 ** 3;
    let staleResolve!: (value: number | undefined) => void;
    const picked = path.join(tempDirectory(), "custom-disk");
    mkdirSync(picked);
    let homeCalls = 0;
    const f = fixture({
      checkout: "/src",
      freeBytes: 1,
      freeDiskBytes: async (directory) => {
        if (directory === f.home) {
          homeCalls += 1;
          if (homeCalls === 1) {
            return new Promise<number | undefined>((resolve) => {
              staleResolve = resolve;
            });
          }
          return 12 * GiB;
        }
        return 95 * GiB;
      },
    });
    await f.host.start();
    try {
      const pendingRefresh = f.module.refreshLocationSpace();
      await f.module.chooseLocation(picked);
      expect(f.module.status().location).toEqual({
        path: picked,
        custom: true,
        freeBytes: 95 * GiB,
        minFreeBytes: 1,
      });
      // Resolve the older default-home probe after choosing the new path.
      staleResolve(4 * GiB);
      await pendingRefresh;
      expect(f.module.status().location).toEqual({
        path: picked,
        custom: true,
        freeBytes: 95 * GiB,
        minFreeBytes: 1,
      });
      // Resetting refreshes freeBytes for the default home.
      await f.module.chooseLocation(null);
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 12 * GiB,
        minFreeBytes: 1,
      });
    } finally {
      await f.host.stop("quit");
    }
  });

  it("preserves active path and freeBytes when a picked folder is rejected", async () => {
    const GiB = 1024 ** 3;
    const f = fixture({
      checkout: "/src",
      platform: "win32",
      freeBytes: 1,
      freeDiskBytes: async () => 18 * GiB,
      checkPrivateLocation: async () => {
        throw new Error("This folder has shared access.");
      },
    });
    await f.host.start();
    try {
      await f.module.refreshLocationSpace();
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 18 * GiB,
        minFreeBytes: 1,
      });
      const picked = path.join(f.root, "shared");
      await f.module.chooseLocation(picked);
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        error: "This folder has shared access.",
        rejectedPath: picked,
        freeBytes: 18 * GiB,
        minFreeBytes: 1,
      });
    } finally {
      await f.host.stop("quit");
    }
  });

  it("commits chooseLocation atomically and keeps only the latest overlapping choice", async () => {
    const GiB = 1024 ** 3;
    const slowDir = path.join(tempDirectory(), "slow-disk");
    const fastDir = path.join(tempDirectory(), "fast-disk");
    mkdirSync(slowDir);
    mkdirSync(fastDir);
    let slowProbeStarted!: () => void;
    const slowStarted = new Promise<void>((resolve) => {
      slowProbeStarted = resolve;
    });
    let resolveSlow!: (value: number | undefined) => void;
    const f = fixture({
      checkout: "/src",
      freeBytes: 1,
      freeDiskBytes: async (directory) => {
        if (directory === f.home) return 10 * GiB;
        if (directory === slowDir) {
          slowProbeStarted();
          return new Promise<number | undefined>((resolve) => {
            resolveSlow = resolve;
          });
        }
        return 120 * GiB;
      },
    });
    await f.host.start();
    const changed = vi.fn();
    const off = f.bus.on("local-server.changed", changed);
    try {
      await f.module.refreshLocationSpace();
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 10 * GiB,
        minFreeBytes: 1,
      });
      changed.mockClear();

      // Start a slow chooseLocation and wait until it is awaiting freeDiskBytes.
      const slowChoice = f.module.chooseLocation(slowDir);
      await slowStarted;
      // Must not expose (slowDir, 10 GiB) while freeDiskBytes(slowDir) is still pending.
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 10 * GiB,
        minFreeBytes: 1,
      });
      expect(changed).not.toHaveBeenCalled();

      // A newer fast chooseLocation commits (fastDir, 120 GiB).
      await f.module.chooseLocation(fastDir);
      expect(f.module.status().location).toEqual({
        path: fastDir,
        custom: true,
        freeBytes: 120 * GiB,
        minFreeBytes: 1,
      });
      expect(changed).toHaveBeenCalledTimes(1);

      // When the older slow choice resolves later, it is discarded without overwriting or emitting.
      resolveSlow(45 * GiB);
      await slowChoice;
      expect(f.module.status().location).toEqual({
        path: fastDir,
        custom: true,
        freeBytes: 120 * GiB,
        minFreeBytes: 1,
      });
      expect(changed).toHaveBeenCalledTimes(1);
    } finally {
      off();
      await f.host.stop("quit");
    }
  });

  it("checks the default data folder before launching the installer on non-Windows platforms too", async () => {
    const f = fixture({
      checkout: "/src",
      platform: "darwin",
      arch: "arm64",
      freeBytes: Number.MAX_SAFE_INTEGER,
    });
    await f.host.start();
    try {
      await expect(f.module.begin()).rejects.toThrow(/Needs \d+ GB free/);
      expect(f.module.status().message).toContain(f.home);
      expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(
        false,
      );
    } finally {
      await f.host.stop("quit");
    }
  });

  it("does not starve an in-flight refreshLocationSpace call when a second caller overlaps for the same target", async () => {
    const GiB = 1024 ** 3;
    const resolvers: Array<(value: number | undefined) => void> = [];
    const probe = vi.fn(
      () =>
        new Promise<number | undefined>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const f = fixture({
      checkout: "/src",
      freeBytes: 20 * GiB,
      freeDiskBytes: probe,
    });
    await f.host.start();
    try {
      const first = f.module.refreshLocationSpace();
      const second = f.module.refreshLocationSpace();
      expect(probe).toHaveBeenCalledTimes(2);
      // Resolving the first probe while the second is still pending must still populate freeBytes.
      resolvers[0]!(14 * GiB);
      await first;
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 14 * GiB,
        minFreeBytes: 20 * GiB,
      });
      resolvers[1]!(15 * GiB);
      await second;
      expect(f.module.status().location).toEqual({
        path: f.home,
        custom: false,
        freeBytes: 15 * GiB,
        minFreeBytes: 20 * GiB,
      });
    } finally {
      await f.host.stop("quit");
    }
  });

  it("refreshes location space when recheck is called while inspection is already checking", async () => {
    const GiB = 1024 ** 3;
    let free = 30 * GiB;
    const probe = vi.fn(async () => free);
    const f = fixture({
      checkout: "/src",
      freeBytes: 20 * GiB,
      freeDiskBytes: probe,
    });
    writeFileSync(path.join(f.home, "tool-download"), "");
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(f.module.status().location.freeBytes).toBe(30 * GiB),
      );
      expect(f.module.status().localModels.state).toBe("checking");

      free = 11 * GiB;
      f.module.recheck();
      await waitForInstaller(() =>
        expect(f.module.status().location.freeBytes).toBe(11 * GiB),
      );
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      writeFileSync(path.join(f.home, "tool-ready"), "");
      await f.host.stop("quit");
    }
  });

  it("refreshes location.freeBytes automatically when begin fails", async () => {
    const GiB = 1024 ** 3;
    let free = 40 * GiB;
    const f = fixture(
      (home) => ({
        ...withCheckout(home),
        freeBytes: 1,
        freeDiskBytes: async () => free,
      }),
      {},
      checkout,
      installerApi([], { state: "failed", message: "Disk full" }),
    );
    await f.host.start();
    try {
      await f.module.refreshLocationSpace();
      expect(f.module.status().location.freeBytes).toBe(40 * GiB);

      free = 3 * GiB;
      await expect(f.module.begin()).rejects.toThrow("Disk full");
      expect(f.module.status().phase).toBe("failed");
      await waitForInstaller(() =>
        expect(f.module.status().location.freeBytes).toBe(3 * GiB),
      );
    } finally {
      await f.host.stop("quit");
    }
  });
});

describe("LocalServerModule after a restart", () => {
  // This computer connected to the installed server, so setup finished.
  const enrolled = {
    serverUrl: "http://localhost:3000",
    computerId: "cmp_1",
  };
  const record = (home: string) => {
    mkdirSync(path.join(home, "desktop"), { recursive: true });
    writeFileSync(
      path.join(home, "desktop", "local-server.json"),
      JSON.stringify({ repo: "/source", origin: "http://localhost:3000" }),
    );
  };

  it("starts the installed services again for the local server", async () => {
    const f = fixture({}, enrolled, record);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3000",
      "http://localhost:3000",
      { reason: "resume_ready" },
    );
    // The services were down, so the window waited on the starting page.
    expect(f.showStarting).toHaveBeenCalledOnce();
    expect(f.showStartFailed).not.toHaveBeenCalled();
    const args = JSON.parse(
      readFileSync(path.join(f.home, "installer", "args.json"), "utf8"),
    ) as string[];
    expect(args).toEqual(
      expect.arrayContaining(["--resume", "--source-repo", "/source"]),
    );
    expect(args[args.indexOf("--instance") + 1]).toBe(LOCAL_INSTANCE);
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("logs the runtime lookup timings a resume outcome carries", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(
        path.join(home, "resume-timings.json"),
        JSON.stringify({
          config: 1,
          runtime: 2,
          localModels: 3,
          tool: 4,
          total: 10,
        }),
      );
    });
    const info = vi.spyOn(silentLog, "info");
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(info).toHaveBeenCalledWith(
      "local_server.installer_runtime_timings",
      {
        instance: LOCAL_INSTANCE,
        config_ms: 1,
        runtime_ms: 2,
        local_models_ms: 3,
        tool_ms: 4,
        total_ms: 10,
      },
    );
    info.mockRestore();
    await f.host.stop("quit");
  });

  it("ignores malformed runtime lookup timings in a resume outcome", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(
        path.join(home, "resume-timings.json"),
        JSON.stringify({
          config: "1",
          runtime: 2,
          localModels: 3,
          tool: 4,
          total: 10,
        }),
      );
    });
    const info = vi.spyOn(silentLog, "info");
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(info).not.toHaveBeenCalledWith(
      "local_server.installer_runtime_timings",
      expect.anything(),
    );
    info.mockRestore();
    await f.host.stop("quit");
  });

  it("follows the origin the installer moved the services to", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-origin"), "http://localhost:3001");
    });
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    // The same server at a new origin: the window follows it as a move,
    // which keeps this computer's enrollment.
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3001",
      "http://localhost:3000",
      { reason: "resume_ready" },
    );
    expect(f.unenroll).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: "/source", origin: "http://localhost:3001" });
    expect(f.module.status()).toMatchObject({
      origin: "http://localhost:3001",
    });
    await f.host.stop("quit");
  });

  it("syncs the local Runner Gateway URL when node-services moved to a new port on resume", async () => {
    // Owner-only, as loadInstance requires; plain writes on Windows inherit
    // the folder's shared DACL.
    const writeDesktopInstance = async (
      home: string,
      webPort: number,
      nodeServicesPort: number,
    ) => {
      const instanceRoot = path.join(home, "instances", LOCAL_INSTANCE);
      await privateDirectory(instanceRoot);
      await atomicPrivate(
        path.join(instanceRoot, "instance.json"),
        JSON.stringify({
          schemaVersion: 1,
          name: LOCAL_INSTANCE,
          mode: "source-native",
          root: instanceRoot,
          project: composeProject(instanceRoot, LOCAL_INSTANCE),
          origin: `http://localhost:${webPort}`,
          port: webPort,
          releaseDir: "/source",
          computerConfig: path.join(instanceRoot, "computer", "config.json"),
          computerExecutable: "/source/computer/linger-computer",
          source: {
            repo: "/source",
            ports: {
              web: webPort,
              teamhub: 59891,
              nodeServices: nodeServicesPort,
              document: 59903,
              postgres: 62622,
            },
          },
        }),
      );
    };
    const f = fixture({}, enrolled, record);
    await writeDesktopInstance(f.home, 3000, 59894);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.syncLocalGatewayUrl).toHaveBeenCalledWith(
      "ws://127.0.0.1:59894/v1/runner-gateway",
    );
    await f.host.stop("quit");
  });

  it("reports ownsWindow true before resume finishes and false for a remote server", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    await f.host.start();
    // Even while resume fails/prepares and servesWindow() is false, ownsWindow()
    // identifies this window as pointing at the installed local server.
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(await f.module.servesWindow()).toBe(false);
    expect(await f.module.ownsWindow()).toBe(true);
    f.host.ctx.config.update({ serverUrl: "https://remote.example.com" });
    expect(await f.module.ownsWindow()).toBe(false);
    await f.host.stop("quit");
  });

  it("stops the local models when the person quits, without waiting for them", async () => {
    const stopped = (home: string) => path.join(home, "stop-local-models.json");
    const f = fixture({}, enrolled, record);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    await f.host.stop("quit");
    // It runs on after the app is gone; its outcome goes to the log.
    await waitForInstaller(() =>
      expect(
        readFileSync(
          path.join(f.home, "installer", "local-models-stop.log"),
          "utf8",
        ),
      ).toBe('{"failed":[]}\n'),
    );
    expect(JSON.parse(readFileSync(stopped(f.home), "utf8"))).toEqual({
      args: ["--home", f.home, "--stop-local-models"],
      runAsNode: "1",
    });
  });

  it("leaves the local models running for an update, and stops none without an installation", async () => {
    const update = fixture({}, enrolled, record);
    await update.host.start();
    await waitForInstaller(() =>
      expect(update.module.status().phase).toBe("ready"),
    );
    await update.host.stop("update");
    const none = fixture();
    await none.host.start();
    await none.host.stop("quit");
    await delay(300);
    for (const home of [update.home, none.home])
      expect(existsSync(path.join(home, "stop-local-models.json"))).toBe(false);
  });

  it("moves the keys of the unpacked source's .env into the instance's user.env once", async () => {
    // Windows refuses to store credentials under shared ancestors such as Temp.
    const parent = realpathSync(homedir());
    const root = isWindowsHost
      ? mkdtempSync(path.join(parent, "desktop-acl-test-"))
      : tempDirectory();
    const f = fixture(
      {},
      enrolled,
      (home) => {
        const source = path.join(home, "desktop", "source", "previous");
        mkdirSync(source, { recursive: true });
        writeFileSync(
          path.join(source, ".env"),
          "SONIOX_API_KEY=soniox\nTEAMHUB_SECRET_ENCRYPTION_KEY=other\n",
        );
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: source,
            origin: "http://localhost:3000",
          }),
        );
      },
      undefined,
      root,
    );
    try {
      await f.host.start();
      await waitForInstaller(() => {
        const status = f.module.status();
        expect(status.phase, status.message).toBe("ready");
      });
      const source = path.join(f.home, "desktop", "source", "previous");
      expect(existsSync(path.join(source, ".env"))).toBe(false);
      const user = readFileSync(
        path.join(f.home, "instances", LOCAL_INSTANCE, "user.env"),
        "utf8",
      );
      expect(user).toContain("SONIOX_API_KEY='soniox'");
      expect(user).not.toContain("TEAMHUB_SECRET_ENCRYPTION_KEY");
    } finally {
      await f.host.stop("quit");
      if (isWindowsHost && path.dirname(realpathSync(root)) === parent)
        rmSync(root, { recursive: true, force: true, maxRetries: 10 });
    }
  });

  it("leaves a developer checkout's .env alone", async () => {
    const f = fixture(withCheckout, enrolled, (home) => {
      checkout(home);
      writeFileSync(path.join(home, "src", ".env"), "XAI_API_KEY=xai\n");
      mkdirSync(path.join(home, "desktop", "source", "src"), {
        recursive: true,
      });
      writeFileSync(
        path.join(home, "desktop", "source", "src", ".env"),
        "XAI_API_KEY=xai\n",
      );
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({
          home,
          repo: path.join(home, "src"),
          origin: "http://localhost:3000",
        }),
      );
    });
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(existsSync(path.join(f.home, "src", ".env"))).toBe(true);
    expect(
      existsSync(path.join(f.home, "instances", LOCAL_INSTANCE, "user.env")),
    ).toBe(false);
    await f.host.stop("quit");
  });

  it("takes the runtime and localmodels paths a resume reports, restarting the Computer once", async () => {
    const tool = {
      LINGER_LOCALMODELS_PYTHON:
        "/home/u/.linger/tools/localmodels/kit/python3",
      LINGER_LOCALMODELS_MODULE_DIR: "/home/u/.linger/tools/localmodels/kit",
      LINGER_LOCALMODELS_STATE: "/home/u/.linger/runtime/localmodels/state",
      LINGER_LOCALMODELS_BASE_DIR: "/home/u/.linger/runtime/localmodels/models",
    };
    const environment = { LINGER_PI_PATH: "/home/u/.linger/pi", ...tool };
    const f = fixture(
      {},
      {
        ...enrolled,
        runtimeEnvironment: { LINGER_PI_PATH: "/home/u/.linger/pi" },
      },
      (home) => {
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: "/source",
            origin: "http://localhost:3000",
          }),
        );
        writeFileSync(
          path.join(home, "resume-runtime.json"),
          JSON.stringify({ setupChoice: "local-models", environment }),
        );
      },
    );
    const restarts = vi.fn();
    f.bus.on("computer.runtime", restarts);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.host.ctx.config.get().runtimeEnvironment).toEqual(environment);
    expect(restarts).toHaveBeenCalledTimes(1);
    await f.host.stop("quit");
  });

  it("starts the services again in the folder they were installed in", async () => {
    const elsewhere = path.join(tempDirectory(), "Linger");
    const f = fixture({}, enrolled, (home) => {
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({
          home: elsewhere,
          repo: "/source",
          origin: "http://localhost:3000",
        }),
      );
    });
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const args = installerArgs(elsewhere);
    expect(args[args.indexOf("--home") + 1]).toBe(elsewhere);
    expect(args).toContain("--resume");
    expect(f.module.status().location).toEqual({
      path: elsewhere,
      custom: false,
    });
    await f.host.stop("quit");
  });

  // The services an app installed over this one unpacked: the record names
  // their source folder and the app that unpacked it.
  const installedBy = (archive: ReturnType<typeof sourceArchive>) =>
    fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        // The services still answer, as when only the app was replaced.
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        const sources = path.join(home, "desktop", "source");
        unpackedSource(path.join(sources, "previous"));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(sources, "previous"),
            origin: "http://localhost:3000",
          }),
        );
      },
    );

  it("moves the services to the source package of an app installed over an older one", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = installedBy(archive);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const sources = path.join(f.home, "desktop", "source");
    const current = path.join(sources, archive.sha256.slice(0, 16));
    const args = installerArgs(f.home);
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--source-repo") + 1]).toBe(current);
    // The window leaves the older interface while they restart.
    expect(f.showUpdating).toHaveBeenCalledOnce();
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3000",
      "http://localhost:3000",
      { reason: "resume_ready" },
    );
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toEqual({
      home: f.home,
      repo: current,
      origin: "http://localhost:3000",
      version: APP_VERSION,
    });
    await vi.waitFor(() =>
      expect(readdirSync(sources)).toEqual([path.basename(current)]),
    );
    await f.host.stop("quit");
  });

  it("keeps an older source folder a running process still starts from", async () => {
    const info = vi.spyOn(silentLog, "info");
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = installedBy(archive);
    const sources = path.join(f.home, "desktop", "source");
    const previous = path.join(sources, "previous");
    // A service the move did not reach still runs from the older folder.
    const service = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", path.join(previous, "server.mjs")],
      { stdio: "ignore" },
    );
    try {
      await new Promise((resolve) => service.once("spawn", resolve));
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      await vi.waitFor(() =>
        expect(info).toHaveBeenCalledWith("local_server.source_in_use", {
          source: "previous",
        }),
      );
      expect(readdirSync(sources).sort()).toEqual(
        [archive.sha256.slice(0, 16), "previous"].sort(),
      );
      await f.host.stop("quit");
    } finally {
      info.mockRestore();
      service.kill("SIGKILL");
    }
  });

  it("shows the start failure when moving to the newer source package fails", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = installedBy(archive);
    writeFileSync(path.join(f.home, "resume-fails"), "");
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(f.showStartFailed).toHaveBeenCalledWith("Native teamhub stopped");
    // Try Again moves them once more.
    rmSync(path.join(f.home, "resume-fails"));
    f.bus.emit("local-server.retry");
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(
      path.join(f.home, "desktop", "source", archive.sha256.slice(0, 16)),
    );
    await f.host.stop("quit");
  });

  it("keeps the older source until the services serve from the newer one", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = installedBy(archive);
    const sources = path.join(f.home, "desktop", "source");
    const previous = path.join(sources, "previous");
    const current = path.join(sources, archive.sha256.slice(0, 16));
    // The move stopped before the restart (the local model was not ready).
    writeFileSync(path.join(f.home, "resume-fails"), "");
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    // Try Again: the installer answers but the services still run from the
    // older folder.
    rmSync(path.join(f.home, "resume-fails"));
    writeFileSync(path.join(f.home, "resume-serving"), previous);
    f.bus.emit("local-server.retry");
    await waitForInstaller(() =>
      expect(f.showStartFailed).toHaveBeenCalledTimes(2),
    );
    expect(f.module.status().phase).toBe("failed");
    expect(f.setServer).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: previous });
    expect(readdirSync(sources).sort()).toEqual(
      [path.basename(current), "previous"].sort(),
    );
    // Once they restart on the newer folder, it is recorded and the older
    // one goes.
    rmSync(path.join(f.home, "resume-serving"));
    f.bus.emit("local-server.retry");
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: current });
    await vi.waitFor(() =>
      expect(readdirSync(sources)).toEqual([path.basename(current)]),
    );
    await f.host.stop("quit");
  });

  it("uses Starting instead of Updating for a same-version source bundle refresh and updates local-server.json", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        const sources = path.join(home, "desktop", "source");
        unpackedSource(path.join(sources, "previous"));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(sources, "previous"),
            origin: "http://localhost:3000",
            version: APP_VERSION,
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const sources = path.join(f.home, "desktop", "source");
    const current = path.join(sources, archive.sha256.slice(0, 16));
    expect(f.showStarting).toHaveBeenCalledOnce();
    expect(f.showUpdating).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toEqual({
      home: f.home,
      repo: current,
      origin: "http://localhost:3000",
      version: APP_VERSION,
    });
    await vi.waitFor(() =>
      expect(readdirSync(sources)).toEqual([path.basename(current)]),
    );
    await f.host.stop("quit");

    // A second launch with the updated local-server.json does not re-trigger
    // a source update or download.
    const download = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(null, { status: 200 }),
    );
    const second = fixture(
      {
        home: f.home,
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: download as typeof fetch,
      },
      enrolled,
    );
    await second.host.start();
    await waitForInstaller(() =>
      expect(second.module.status().phase).toBe("ready"),
    );
    expect(second.showUpdating).not.toHaveBeenCalled();
    expect(second.showStarting).not.toHaveBeenCalled();
    expect(
      download.mock.calls.some(([url]) =>
        String(url).startsWith("https://cdn.example/"),
      ),
    ).toBe(false);
    await second.host.stop("quit");
  });

  it("shows Updating when moving services to a newer version's source package", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        const sources = path.join(home, "desktop", "source");
        unpackedSource(path.join(sources, "previous"));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(sources, "previous"),
            origin: "http://localhost:3000",
            version: "0.16.0",
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showUpdating).toHaveBeenCalledOnce();
    expect(f.showStarting).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("normalizes trailing slashes and symlinks in serving.source so moved records do not stay stale", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = installedBy(archive);
    const current = path.join(
      f.home,
      "desktop",
      "source",
      archive.sha256.slice(0, 16),
    );
    let reported = `${current}${path.sep}`;
    if (!isWindowsHost) {
      const link = path.join(f.root, "home-link");
      symlinkSync(f.home, link);
      reported = `${path.join(link, "desktop", "source", archive.sha256.slice(0, 16))}${path.sep}`;
    }
    writeFileSync(path.join(f.home, "resume-serving"), reported);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStartFailed).not.toHaveBeenCalled();
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: current, version: APP_VERSION });
    await f.host.stop("quit");
  });

  it("starts the services on their own source package when it is this app's", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const repo = (home: string) =>
      path.join(home, "desktop", "source", archive.sha256.slice(0, 16));
    const download = vi.fn(
      async (_url: string | URL | Request) =>
        new Response(null, { status: 503 }),
    );
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: download as typeof fetch,
      },
      enrolled,
      (home) => {
        unpackedSource(repo(home));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: repo(home),
            origin: "http://localhost:3000",
            version: APP_VERSION,
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(repo(f.home));
    expect(f.showUpdating).not.toHaveBeenCalled();
    expect(
      download.mock.calls.some(([url]) =>
        String(url).startsWith("https://cdn.example/"),
      ),
    ).toBe(false);
    await f.host.stop("quit");
  });

  it("leaves services a newer app unpacked on their source package", async () => {
    const warn = vi.spyOn(silentLog, "warn");
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        const sources = path.join(home, "desktop", "source");
        unpackedSource(path.join(sources, "newer"));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(sources, "newer"),
            origin: "http://localhost:3000",
            version: "0.18.0",
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const newer = path.join(f.home, "desktop", "source", "newer");
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(newer);
    expect(f.showUpdating).not.toHaveBeenCalled();
    expect(readdirSync(path.join(f.home, "desktop", "source"))).toEqual([
      "newer",
    ]);
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: newer, version: "0.18.0" });
    expect(warn).toHaveBeenCalledWith("local_server.source_newer_than_app", {
      installed: "0.18.0",
      app: APP_VERSION,
    });
    warn.mockRestore();
    await f.host.stop("quit");
  });

  it("reports a failed restart", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(f.module.status().message).toBe("Native teamhub stopped");
    expect(f.setServer).not.toHaveBeenCalled();
    expect(f.showStartFailed).toHaveBeenCalledWith("Native teamhub stopped");
    await f.host.stop("quit");
  });

  it.each([
    [
      "LOCAL_MODELS_RECOVERY_REQUIRED",
      "Try Again to apply the approved local model plan again, or Set Up Again to review a new plan or choose another AI runtime.",
    ],
    [
      "LOCAL_MODELS_APPROVAL_REQUIRED",
      "Set Up Again to review the local model plan or choose another AI runtime.",
    ],
  ])(
    "names the action that works when the local model stops a restart (%s)",
    async (code, action) => {
      const f = fixture({}, enrolled, (home) => {
        record(home);
        writeFileSync(
          path.join(home, "resume-fails"),
          JSON.stringify({
            message: "The local model stack is not ready.",
            details: { code },
          }),
        );
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("failed"),
      );
      expect(f.showStartFailed).toHaveBeenCalledWith(
        `The local model stack is not ready. ${action}`,
      );
      await f.host.stop("quit");
    },
  );

  it("says why the local model stack is not ready, from its reason code", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(
        path.join(home, "resume-fails"),
        JSON.stringify({
          message:
            "The upstream tool could not verify the local stack binding.",
          details: {
            code: "LOCAL_MODELS_RECOVERY_REQUIRED",
            reasons: ["pi-extensions-unavailable", "gateway-unavailable"],
          },
        }),
      );
    });
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(f.showStartFailed).toHaveBeenCalledWith(
      "The local model's Pi can't load extensions, which every Linger run needs. The upstream tool could not verify the local stack binding. Try Again to apply the approved local model plan again, or Set Up Again to review a new plan or choose another AI runtime.",
    );
    await f.host.stop("quit");
  });

  it.each([
    "STACK_REPLAN_FAILED",
    "STACK_PLAN_CHANGED",
    "STACK_APPROVAL_MISMATCH",
    "STACK_PLAN_INVALID",
  ])(
    "guides to Set Up Again when an upgraded client cannot re-apply the saved plan (%s)",
    async (causeCode) => {
      const root = tempDirectory();
      const archive = sourceArchive(root);
      const f = installedBy(archive);
      const previous = path.join(f.home, "desktop", "source", "previous");
      writeFileSync(
        path.join(f.home, "resume-fails"),
        JSON.stringify({
          message:
            "Local model installation or verification did not finish: The saved local model plan no longer fits this computer's current memory or model catalog. Existing resources were preserved.",
          details: {
            code: "LOCAL_MODELS_RECOVERY_REQUIRED",
            causeCode,
            reasons: ["deployment-unavailable"],
          },
        }),
      );
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("failed"),
      );
      expect(f.showStartFailed).toHaveBeenCalledWith(
        "The local model service isn't running. Local model installation or verification did not finish: The saved local model plan no longer fits this computer's current memory or model catalog. Existing resources were preserved. Set Up Again to review a new plan or choose another AI runtime.",
      );
      // The older source record stays in place until the upgrade succeeds.
      expect(
        JSON.parse(
          readFileSync(
            path.join(f.home, "desktop", "local-server.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ repo: previous });
      await f.host.stop("quit");
    },
  );

  it("still offers Try Again when a local model resume failure is transient (STACK_APPLY_LOCKED)", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(
        path.join(home, "resume-fails"),
        JSON.stringify({
          message:
            "Local model installation or verification did not finish: Another local model operation is already running. Existing resources were preserved.",
          details: {
            code: "LOCAL_MODELS_RECOVERY_REQUIRED",
            causeCode: "STACK_APPLY_LOCKED",
            reasons: ["deployment-unavailable"],
          },
        }),
      );
    });
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(f.showStartFailed).toHaveBeenCalledWith(
      "The local model service isn't running. Local model installation or verification did not finish: Another local model operation is already running. Existing resources were preserved. Try Again to apply the approved local model plan again, or Set Up Again to review a new plan or choose another AI runtime.",
    );
    await f.host.stop("quit");
  });

  it("recovers from an upgrade replan failure through Set Up Again by replanning automatically", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const api = installerApi([], {
      state: "waiting_user",
      errorCode: "LOCAL_MODELS_RECOVERY_REQUIRED",
      message: "The saved local model plan no longer fits.",
    });
    api.runtime.setupChoice = "local-models";
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async (url: string | URL | Request) => {
          if (String(url).startsWith("https://cdn.example/"))
            return new Response(archive.bytes);
          return new Response(null, { status: 200 });
        }) as typeof fetch,
      },
      enrolled,
      (home) => {
        const sources = path.join(home, "desktop", "source");
        unpackedSource(path.join(sources, "previous"));
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(sources, "previous"),
            origin: "http://localhost:3000",
            version: "0.1.4",
          }),
        );
        writeFileSync(
          path.join(home, "resume-fails"),
          JSON.stringify({
            message:
              "Local model installation or verification did not finish: The saved local model plan no longer fits this computer's current memory or model catalog. Existing resources were preserved.",
            details: {
              code: "LOCAL_MODELS_RECOVERY_REQUIRED",
              causeCode: "STACK_REPLAN_FAILED",
              reasons: ["deployment-unavailable"],
            },
          }),
        );
      },
      api,
    );
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(f.showStartFailed).toHaveBeenCalledWith(
      expect.stringContaining(
        "Set Up Again to review a new plan or choose another AI runtime.",
      ),
    );
    // Set Up Again forgets the stale local-server record and opens setup.
    const opened = vi.fn();
    f.bus.on("setup.open", opened);
    f.bus.emit("local-server.reset");
    await waitForInstaller(() => expect(opened).toHaveBeenCalledOnce());
    expect(existsSync(path.join(f.home, "desktop", "local-server.json"))).toBe(
      false,
    );
    // Re-installing with local models replans automatically and finishes on
    // the upgraded client's source package.
    await f.module.begin({ runtime: "local" });
    expect(f.api.retried).toEqual([{ localModelsReplan: true }]);
    expect(f.module.status().phase).toBe("ready");
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({
      repo: path.join(f.home, "desktop", "source", archive.sha256.slice(0, 16)),
      version: APP_VERSION,
    });
    await f.host.stop("quit");
  });

  it("starts the services again when the person tries again", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    rmSync(path.join(f.home, "resume-fails"));
    f.bus.emit("local-server.retry");
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.setServer).toHaveBeenCalledWith(
      "http://localhost:3000",
      "http://localhost:3000",
      { reason: "resume_ready" },
    );
    await f.host.stop("quit");
  });

  it("keeps the window on the server when the services still run", async () => {
    const f = fixture(
      {
        fetch: (async () =>
          new Response(null, { status: 200 })) as typeof fetch,
      },
      enrolled,
      record,
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(f.showStarting).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("shows setup instead of resuming a Quick Install that stopped before this computer connected", async () => {
    // The record is written once the server runs, before this computer
    // connects; the app quit or the computer went off in between.
    const f = fixture(
      withCheckout,
      { serverUrl: "http://localhost:3000" },
      (home) => {
        checkout(home);
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: path.join(home, "src"),
            origin: "http://localhost:3000",
          }),
        );
      },
    );
    await f.host.start();
    expect(f.module.status().phase).toBe("idle");
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    expect(f.showStarting).not.toHaveBeenCalled();
    // Install on the setup page finishes it in the same place.
    await f.module.begin();
    expect(f.module.status().phase).toBe("ready");
    expect(installerArgs(f.home)).not.toContain("--resume");
    expect(f.signIn).toHaveBeenCalledOnce();
    expect(f.enroll).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("unpacks the source package again when its folder is gone", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const repo = (home: string) =>
      path.join(home, "desktop", "source", archive.sha256.slice(0, 16));
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: repo(home),
            origin: "http://localhost:3000",
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(repo(f.home));
    expect(
      existsSync(path.join(repo(f.home), "scripts/source-native.mjs")),
    ).toBe(true);
    await f.host.stop("quit");
  });

  it("unpacks the source package again when its folder is damaged", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const repo = (home: string) =>
      path.join(home, "desktop", "source", archive.sha256.slice(0, 16));
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        // This app's own folder: the marker is there, package.json is gone.
        mkdirSync(path.join(repo(home), "scripts"), { recursive: true });
        writeFileSync(path.join(repo(home), "scripts/source-native.mjs"), "");
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: repo(home),
            origin: "http://localhost:3000",
            version: APP_VERSION,
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(repo(f.home));
    expect(
      JSON.parse(readFileSync(path.join(repo(f.home), "package.json"), "utf8")),
    ).toEqual({ name: "linger" });
    await f.host.stop("quit");
  });

  it("moves to the source package when the earlier Simplex app unpacked the one in use", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const legacy = (home: string) =>
      path.join(home, "desktop", "source", "simplex");
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        unpackedSource(legacy(home), "simplexai-coworkspace");
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo: legacy(home),
            origin: "http://localhost:3000",
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    const sources = path.join(f.home, "desktop", "source");
    const current = path.join(sources, archive.sha256.slice(0, 16));
    const args = installerArgs(f.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(current);
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ repo: current });
    await vi.waitFor(() =>
      expect(readdirSync(sources)).toEqual([path.basename(current)]),
    );
    await f.host.stop("quit");
  });

  it("converts and resumes an earlier Simplex installation in a location the person chose", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const chosen = path.join(root, "chosen");
    const legacy = path.join(chosen, "desktop", "source", "simplex");
    const f = fixture(
      {
        sourceArchive: {
          url: "https://cdn.example/linger.tar.gz",
          sha256: archive.sha256,
        },
        fetch: (async () => new Response(archive.bytes)) as typeof fetch,
      },
      enrolled,
      (home) => {
        // The default home holds only the record and a setup that never
        // finished.
        legacyInstance(home);
        legacyInstance(chosen);
        unpackedSource(legacy, "simplexai-coworkspace");
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home: chosen,
            repo: legacy,
            origin: "http://localhost:3000",
          }),
        );
      },
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(instanceProject(f.home)).toBe("linger-desktop-1");
    expect(instanceProject(chosen)).toBe("linger-desktop-1");
    const current = path.join(
      chosen,
      "desktop",
      "source",
      archive.sha256.slice(0, 16),
    );
    const args = installerArgs(chosen);
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--home") + 1]).toBe(chosen);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(current);
    expect(existsSync(path.join(f.home, "desktop", "source"))).toBe(false);
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toEqual({
      home: chosen,
      repo: current,
      origin: "http://localhost:3000",
      version: APP_VERSION,
    });
    await vi.waitFor(() =>
      expect(readdirSync(path.dirname(current))).toEqual([
        path.basename(current),
      ]),
    );
    await f.host.stop("quit");
  });

  it("holds the app back only for the instance in use when a conversion is skipped", async () => {
    const chosen = path.join(tempDirectory(), "chosen");
    const setup = (skips: string) => (home: string) => {
      legacyInstance(home);
      legacyInstance(chosen);
      writeFileSync(
        path.join(skips === "default" ? home : chosen, "migrate-skips"),
        "",
      );
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({
          home: chosen,
          repo: "/source",
          origin: "http://localhost:3000",
        }),
      );
    };
    const unused = fixture({}, enrolled, setup("default"));
    await unused.host.start();
    await waitForInstaller(() =>
      expect(unused.module.status().phase).toBe("ready"),
    );
    expect(instanceProject(unused.home)).toBe("simplex-desktop-1");
    await unused.host.stop("quit");

    rmSync(chosen, { recursive: true });
    const used = fixture({}, enrolled, setup("chosen"));
    await used.host.start();
    await waitForInstaller(() =>
      expect(used.module.status().phase).toBe("failed"),
    );
    expect(used.module.status().message).toMatch(
      /could not convert this computer's installation.*running 1 task/,
    );
    expect(used.showStartFailed).toHaveBeenCalledOnce();
    expect(existsSync(path.join(chosen, "installer", "args.json"))).toBe(false);
    await used.host.stop("quit");
  });

  it("prunes older sources in the background without blocking resume ready", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const f = installedBy(archive);
    const sources = path.join(f.home, "desktop", "source");
    const current = path.join(sources, archive.sha256.slice(0, 16));
    let releasePrune!: (folders: Set<string>) => void;
    const foldersSpy = vi
      .spyOn(nativeProcess, "foldersInUse")
      .mockImplementation(
        () =>
          new Promise<Set<string>>((resolve) => {
            releasePrune = resolve;
          }),
      );
    try {
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      expect(f.setServer).toHaveBeenCalledWith(
        "http://localhost:3000",
        "http://localhost:3000",
        { reason: "resume_ready" },
      );
      // Old source stays until the background prune settles.
      expect(readdirSync(sources).sort()).toEqual(
        [path.basename(current), "previous"].sort(),
      );
      await vi.waitFor(() => expect(foldersSpy).toHaveBeenCalledOnce());
      releasePrune(new Set());
      await vi.waitFor(() =>
        expect(readdirSync(sources)).toEqual([path.basename(current)]),
      );
      await f.host.stop("quit");
    } finally {
      foldersSpy.mockRestore();
    }
  });

  const sha256Hex = (data: string | Buffer) =>
    createHash("sha256").update(data).digest("hex");

  const buildStagedUpdateBundle = (
    root: string,
    options: {
      target?: string;
      installerDir?: string;
      platform?: NodeJS.Platform;
      arch?: string;
      nativeSources?: readonly { readonly target: string }[];
      includeNode?: boolean;
      source?: ReturnType<typeof sourceArchive>;
      teamhubDigest?: string;
      runtimeDigest?: string;
      includeTool?: boolean;
      toolUrl?: string;
      toolBytes?: Buffer;
      toolSha256?: string;
      toolManifestSha256?: string;
      sourceFiles?: readonly string[];
    },
  ) => {
    const target = options.target ?? `${process.platform}-${process.arch}`;
    const staged = path.join(root, "Staged.app");
    const installerDir =
      options.installerDir ??
      path.join(staged, "Contents", "Resources", "app", "dist", "installer");
    mkdirSync(installerDir, { recursive: true });
    if (options.includeTool !== false || options.nativeSources !== undefined) {
      const distribution: Record<string, unknown> = {
        platform: options.platform ?? process.platform,
        arch: options.arch ?? process.arch,
      };
      if (options.nativeSources !== undefined) {
        distribution.nativeSources = options.nativeSources;
      }
      if (options.includeTool !== false) {
        distribution.localmodelsTool = {
          url: options.toolUrl ?? "https://cdn.example/localmodels.tgz",
          sha256: options.toolSha256 ?? sha256Hex(options.toolBytes ?? "tool"),
          bytes: options.toolBytes?.length ?? 4,
          sourceCommit: "a".repeat(40),
          manifestSha256: options.toolManifestSha256 ?? sha256Hex("manifest"),
        };
      }
      writeFileSync(
        path.join(installerDir, "distribution.json"),
        JSON.stringify(distribution),
      );
    }
    if (options.source) {
      const sourceDir = path.join(installerDir, "source");
      mkdirSync(sourceDir, { recursive: true });
      for (const name of options.sourceFiles ?? ["linger.tar.gz"])
        writeFileSync(path.join(sourceDir, name), options.source.bytes);
    }
    if (options.teamhubDigest) {
      const teamhubDir = path.join(installerDir, "native", `teamhub-${target}`);
      mkdirSync(teamhubDir, { recursive: true });
      const binaries = Object.fromEntries(
        ["teamhub", "migrate", "account"].map((command) => {
          writeFileSync(path.join(teamhubDir, command), command, {
            mode: 0o755,
          });
          return [
            command,
            {
              file: command,
              sha256: sha256Hex(command),
              bytes: command.length,
            },
          ];
        }),
      );
      writeFileSync(
        path.join(teamhubDir, "manifest.json"),
        JSON.stringify({
          target,
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256: options.teamhubDigest,
          goVersion: "1.26.5",
          binaries,
        }),
      );
    }
    const runtimeDir = path.join(installerDir, "native", `runtime-${target}`);
    if (options.runtimeDigest) {
      mkdirSync(path.join(runtimeDir, "runtime", "web", "dist"), {
        recursive: true,
      });
      mkdirSync(path.join(runtimeDir, "runtime", "node-services", "dist"), {
        recursive: true,
      });
      const files: Record<string, string> = {
        "web/static-host.mjs": "console.log('ok');",
        "web/dist/index.html": "<html></html>",
        "node-services/dist/main.js": "console.log('main');",
        "node-services/dist/supervisor.js": "console.log('sup');",
      };
      const manifestFiles: Record<string, { bytes: number; sha256: string }> =
        {};
      for (const [rel, body] of Object.entries(files)) {
        writeFileSync(path.join(runtimeDir, "runtime", rel), body);
        manifestFiles[rel] = {
          bytes: Buffer.byteLength(body),
          sha256: sha256Hex(body),
        };
      }
      const filesJson = JSON.stringify({
        schema: 1,
        target,
        sourceCommit: "a".repeat(40),
        sourceArchiveSha256: options.runtimeDigest,
        files: manifestFiles,
      });
      writeFileSync(path.join(runtimeDir, "runtime", "files.json"), filesJson);
      let nodeManifest:
        | {
            readonly version: string;
            readonly file: string;
            readonly sha256: string;
          }
        | undefined;
      if (options.includeNode) {
        mkdirSync(path.join(runtimeDir, "node", "bin"), { recursive: true });
        fixtureNode(path.join(runtimeDir, "node", "bin", "node"));
        nodeManifest = {
          version: NODE_RUNTIME_VERSION,
          file: "node/bin/node",
          sha256: sha256Hex(readFileSync(process.execPath)),
        };
      }
      writeFileSync(
        path.join(runtimeDir, "manifest.json"),
        JSON.stringify({
          target,
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256: options.runtimeDigest,
          layout: "directory",
          directory: {
            file: "runtime/files.json",
            sha256: sha256Hex(filesJson),
          },
          ...(nodeManifest ? { node: nodeManifest } : {}),
        }),
      );
    }
    return { staged, installerDir, runtimeDir };
  };

  const buildLocalmodelsArchive = (root: string) => {
    const pkg = path.join(root, "kit", "package");
    mkdirSync(path.join(pkg, "python"), { recursive: true });
    mkdirSync(path.join(pkg, "modules", "localmodels"), { recursive: true });
    writeFileSync(path.join(pkg, "python", "python"), "py", { mode: 0o755 });
    writeFileSync(
      path.join(pkg, "modules", "localmodels", "__init__.py"),
      "kit",
    );
    const manifestBody = JSON.stringify({
      schemaVersion: 1,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: "a".repeat(40),
      python: "python/python",
      moduleDir: "modules",
      assets: {
        "python/python": sha256Hex("py"),
        "modules/localmodels/__init__.py": sha256Hex("kit"),
      },
    });
    writeFileSync(path.join(pkg, "tool.json"), manifestBody);
    const tgz = path.join(root, "localmodels.tgz");
    execFileSync(
      process.platform === "win32" ? "tar.exe" : "tar",
      ["-czf", tgz, "-C", path.join(root, "kit"), "package"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const bytes = readFileSync(tgz);
    return {
      bytes,
      sha256: sha256Hex(bytes),
      manifestSha256: sha256Hex(manifestBody),
    };
  };

  it.skipIf(process.platform !== "darwin")(
    "clears macOS quarantine from copied runtime files when present and handles clean bundles",
    async () => {
      for (const quarantined of [true, false]) {
        const f = fixture();
        const archive = sourceArchive(f.root);
        const installer = path.join(f.root, "installer");
        const { runtimeDir } = buildStagedUpdateBundle(f.root, {
          target: "darwin-arm64",
          installerDir: installer,
          platform: "darwin",
          arch: "arm64",
          nativeSources: [{ target: "darwin-arm64" }],
          source: archive,
          runtimeDigest: archive.sha256,
          includeTool: false,
          includeNode: true,
        });
        if (quarantined) {
          execFileSync("/usr/bin/xattr", [
            "-w",
            "com.apple.quarantine",
            "0081;66000000;Chrome;",
            path.join(runtimeDir, "runtime"),
          ]);
          execFileSync("/usr/bin/xattr", [
            "-w",
            "com.apple.quarantine",
            "0081;66000000;Chrome;",
            path.join(runtimeDir, "runtime", "web", "static-host.mjs"),
          ]);
        }
        await new LocalServerModule({
          home: f.home,
          version: APP_VERSION,
          installerDirectory: installer,
          platform: "darwin",
          arch: "arm64",
          freeBytes: 1,
          sourceArchive: {
            file: "source/linger.tar.gz",
            sha256: archive.sha256,
          },
          signIn: f.signIn,
        })
          .begin()
          .catch(() => undefined);
        const offline = path.join(
          f.home,
          "desktop",
          "source",
          archive.sha256.slice(0, 16),
          ".simplexai-runtime",
          "offline",
        );
        const copiedScript = path.join(offline, "web", "static-host.mjs");
        expect(existsSync(copiedScript)).toBe(true);
        expect(existsSync(path.join(offline, "verified.json"))).toBe(true);
        expect(() =>
          execFileSync(
            "/usr/bin/xattr",
            ["-p", "com.apple.quarantine", copiedScript],
            { stdio: "pipe" },
          ),
        ).toThrow();
      }
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "clears macOS quarantine from a copied shared Node.js binary when present",
    async () => {
      const nodeDir = (home: string) =>
        path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
      const f = fixture({}, {}, (home) =>
        rmSync(nodeDir(home), { recursive: true, force: true }),
      );
      const resources = path.join(
        f.root,
        "Linger.app",
        "Contents",
        "Resources",
      );
      const installer = path.join(resources, "app", "dist", "installer");
      mkdirSync(installer, { recursive: true });
      writeFileSync(
        path.join(installer, "installer.js"),
        readFileSync(path.join(f.root, "installer", "installer.js")),
      );
      writeFileSync(
        path.join(installer, "distribution.json"),
        JSON.stringify({
          platform: "darwin",
          arch: "arm64",
          nativeSources: [{ target: "darwin-arm64" }],
        }),
      );
      const sharedNode = path.join(resources, "runtime", "bin", "node");
      mkdirSync(path.dirname(sharedNode), { recursive: true });
      const nodeBytes = Buffer.from("#!/bin/sh\nexit 1\n");
      writeFileSync(sharedNode, nodeBytes, { mode: 0o755 });
      execFileSync("/usr/bin/xattr", [
        "-w",
        "com.apple.quarantine",
        "0081;66000000;Chrome;",
        sharedNode,
      ]);
      const bundle = path.join(installer, "native", "runtime-darwin-arm64");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(
        path.join(bundle, "manifest.json"),
        JSON.stringify({
          target: "darwin-arm64",
          sourceArchiveSha256: "a".repeat(64),
          layout: "directory",
          node: {
            version: NODE_RUNTIME_VERSION,
            shared: true,
            binary: "runtime/bin/node",
            sha256: sha256Hex(nodeBytes),
            bytes: nodeBytes.length,
          },
        }),
      );
      const archive = sourceArchive(f.root);
      mkdirSync(path.join(installer, "source"), { recursive: true });
      writeFileSync(
        path.join(installer, "source", "linger.tar.gz"),
        archive.bytes,
      );
      await new LocalServerModule({
        home: f.home,
        version: APP_VERSION,
        installerDirectory: installer,
        platform: "darwin",
        arch: "arm64",
        freeBytes: 1,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        signIn: f.signIn,
      })
        .begin()
        .catch(() => undefined);
      const copied = path.join(nodeDir(f.home), "bin", "node");
      expect(existsSync(copied)).toBe(true);
      expect(() =>
        execFileSync("/usr/bin/xattr", ["-p", "com.apple.quarantine", copied], {
          stdio: "pipe",
        }),
      ).toThrow();
    },
  );

  it("pre-fetches localmodelsTool from a staged app bundle for locally enrolled installations", async () => {
    const info = vi.spyOn(silentLog, "info");
    try {
      const root = tempDirectory();
      const tool = buildLocalmodelsArchive(root);
      const { staged } = buildStagedUpdateBundle(root, {
        toolBytes: tool.bytes,
        toolSha256: tool.sha256,
        toolManifestSha256: tool.manifestSha256,
      });
      const toolSource = {
        url: "https://cdn.example/localmodels.tgz",
        sha256: tool.sha256,
        bytes: tool.bytes.length,
        sourceCommit: "a".repeat(40),
        manifestSha256: tool.manifestSha256,
      };

      let fetchCalls = 0;
      const fetcher = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === toolSource.url) {
          fetchCalls += 1;
          return new Response(tool.bytes, {
            headers: { "content-length": String(tool.bytes.length) },
          });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;

      // Without a local installation record, nothing is downloaded.
      const unconfigured = fixture({ fetch: fetcher }, {});
      await unconfigured.host.start();
      await unconfigured.module.prepareUpdateTool(
        staged,
        new AbortController().signal,
      );
      expect(fetchCalls).toBe(0);
      await unconfigured.host.stop("quit");

      // Enrolled local installation pre-fetches into its configured home.
      const customHome = path.join(tempDirectory(), "custom-home");
      mkdirSync(path.join(customHome, "tools", "localmodels"), {
        recursive: true,
      });
      writeFileSync(
        path.join(customHome, "region.json"),
        JSON.stringify({
          schema: 1,
          region: "global",
          resolved_at: new Date().toISOString(),
          method: "probe",
        }),
      );
      const f = fixture({ fetch: fetcher }, enrolled, (home) => {
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home: customHome,
            repo: "/source",
            origin: "http://localhost:3000",
          }),
        );
      });
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      await f.module.prepareUpdateTool(staged, new AbortController().signal);
      expect(fetchCalls).toBe(1);
      expect(info).toHaveBeenCalledWith(
        "local_server.update_tool_prepared",
        expect.objectContaining({
          sha256: toolSource.sha256.slice(0, 12),
        }),
      );

      // Re-using the cached kit later (repeat prepare or ensureLocalmodelsTool) makes zero network requests.
      await f.module.prepareUpdateTool(staged, new AbortController().signal);
      const resolved = await ensureLocalmodelsTool(
        customHome,
        {},
        { source: toolSource },
      );
      expect(resolved.moduleDir).toBe(
        path.join(
          customHome,
          "tools",
          "localmodels",
          toolSource.sha256,
          "modules",
        ),
      );
      expect(fetchCalls).toBe(1);
      await f.host.stop("quit");
    } finally {
      info.mockRestore();
    }
  });

  const deferred = <T = void>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  const okFetch = (async () => new Response("ok")) as typeof fetch;

  const startEnrolledLocalServer = async (options: {
    readonly root?: string;
    readonly currentArchive?: ReturnType<typeof sourceArchive>;
    readonly repoName?: string;
    readonly version?: string;
    readonly resumeFails?: boolean;
    readonly region?: boolean;
    readonly fetch?: typeof fetch;
    readonly rename?: LocalServerOptions["rename"];
    readonly bundledNodePath?: string;
    readonly setup?: (home: string, repo: string) => void;
  }) => {
    const repoName = options.repoName ?? "active";
    const f = fixture(
      {
        platform: process.platform,
        arch: process.arch,
        glibcVersion: "2.35",
        ...(options.currentArchive
          ? {
              sourceArchive: {
                file: "source/linger.tar.gz",
                sha256: options.currentArchive.sha256,
              },
            }
          : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.rename ? { rename: options.rename } : {}),
        ...(options.bundledNodePath
          ? { bundledNodePath: options.bundledNodePath }
          : {}),
      },
      enrolled,
      (home) => {
        const repo = path.join(home, "desktop", "source", repoName);
        unpackedSource(repo);
        mkdirSync(path.join(home, "desktop"), { recursive: true });
        writeFileSync(
          path.join(home, "desktop", "local-server.json"),
          JSON.stringify({
            home,
            repo,
            origin: "http://localhost:3000",
            ...(options.version ? { version: options.version } : {}),
          }),
        );
        if (options.resumeFails) {
          writeFileSync(path.join(home, "resume-fails"), "");
        }
        if (options.region) {
          writeFileSync(
            path.join(home, "region.json"),
            JSON.stringify({
              schema: 1,
              region: "global",
              resolved_at: new Date().toISOString(),
              method: "probe",
            }),
          );
        }
        options.setup?.(home, repo);
      },
      installerApi(),
      options.root,
    );
    if (
      options.currentArchive &&
      repoName !== options.currentArchive.sha256.slice(0, 16)
    ) {
      mkdirSync(path.join(f.root, "installer", "source"), { recursive: true });
      writeFileSync(
        path.join(f.root, "installer", "source", "linger.tar.gz"),
        options.currentArchive.bytes,
      );
    }
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe(
        options.resumeFails ? "failed" : "ready",
      ),
    );
    return f;
  };

  it("pre-stages bundled source, teamhub, and runtime without changing status or getting pruned", async () => {
    const info = vi.spyOn(silentLog, "info");
    const foldersSpy = vi
      .spyOn(nativeProcess, "foldersInUse")
      .mockResolvedValue(new Set());
    try {
      const root = tempDirectory();
      const tool = buildLocalmodelsArchive(root);
      const nextArchive = sourceArchive(path.join(root, "next-src"), "next");
      const currentArchive = sourceArchive(path.join(root, "curr-src"), "curr");
      const { staged } = buildStagedUpdateBundle(root, {
        source: nextArchive,
        teamhubDigest: nextArchive.sha256,
        runtimeDigest: nextArchive.sha256,
        toolBytes: tool.bytes,
        toolSha256: tool.sha256,
        toolManifestSha256: tool.manifestSha256,
      });

      let fetchCalls = 0;
      let failToolDownload = false;
      const fetcher = (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url === "https://cdn.example/localmodels.tgz") {
          fetchCalls += 1;
          if (failToolDownload) return new Response(null, { status: 404 });
          return new Response(tool.bytes, {
            headers: { "content-length": String(tool.bytes.length) },
          });
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;

      // Start with a failed resume so `record` still points to `previous`,
      // letting us verify both status-preservation after ready and prune protection.
      const f = await startEnrolledLocalServer({
        currentArchive,
        repoName: "previous",
        resumeFails: true,
        region: true,
        fetch: fetcher,
      });

      // Even if the online tool download fails offline, the bundled source +
      // teamhub + runtime still finish pre-staging before prepareUpdateTool throws.
      failToolDownload = true;
      await expect(
        f.module.prepareUpdateTool(staged, new AbortController().signal),
      ).rejects.toThrow();

      const preStaged = path.join(
        f.home,
        "desktop",
        "source",
        nextArchive.sha256.slice(0, 16),
      );
      expect(
        existsSync(path.join(preStaged, "scripts/source-native.mjs")),
      ).toBe(true);
      expect(
        readFileSync(
          path.join(preStaged, ".simplexai-runtime/prebuilt/teamhub"),
          "utf8",
        ),
      ).toBe("teamhub");
      expect(
        existsSync(
          path.join(preStaged, ".simplexai-runtime/offline/verified.json"),
        ),
      ).toBe(true);
      expect(info).toHaveBeenCalledWith(
        "local_server.update_source_prepared",
        expect.objectContaining({
          source: path.basename(preStaged),
        }),
      );

      // Retry to reach ready, triggering #schedulePruneSources on `previous`.
      rmSync(path.join(f.home, "resume-fails"));
      f.bus.emit("local-server.retry");
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      await vi.waitFor(() =>
        expect(
          existsSync(path.join(f.home, "desktop", "source", "previous")),
        ).toBe(false),
      );
      expect(existsSync(preStaged)).toBe(true);

      // While ready, preparing concurrently must not mutate status or emit changed.
      failToolDownload = false;
      const beforeStatus = f.module.status();
      const changed = vi.fn();
      const offChanged = f.bus.on("local-server.changed", changed);
      await Promise.all([
        f.module.prepareUpdateTool(staged, new AbortController().signal),
        f.module.prepareUpdateTool(staged, new AbortController().signal),
      ]);
      offChanged();
      expect(changed).not.toHaveBeenCalled();
      expect(f.module.status()).toEqual(beforeStatus);
      const callsAfterPrepare = fetchCalls;
      expect(callsAfterPrepare).toBeGreaterThanOrEqual(2);
      await f.module.prepareUpdateTool(staged, new AbortController().signal);
      expect(fetchCalls).toBe(callsAfterPrepare);
      const resolved = await ensureLocalmodelsTool(
        f.home,
        {},
        {
          source: {
            url: "https://cdn.example/localmodels.tgz",
            sha256: tool.sha256,
            bytes: tool.bytes.length,
            sourceCommit: "a".repeat(40),
            manifestSha256: tool.manifestSha256,
          },
        },
      );
      expect(resolved.moduleDir).toBe(
        path.join(f.home, "tools", "localmodels", tool.sha256, "modules"),
      );
      await f.host.stop("quit");
    } finally {
      foldersSpy.mockRestore();
      info.mockRestore();
    }
  });

  it("reuses a pre-staged source checkout on update resume without re-extracting", async () => {
    const root = tempDirectory();
    const target = `${process.platform}-${process.arch}`;
    const prevArchive = sourceArchive(path.join(root, "prev"), "prev");
    const nextArchive = sourceArchive(path.join(root, "next"), "next");
    const { staged, installerDir: stagedInstallerDir } =
      buildStagedUpdateBundle(root, {
        target,
        source: nextArchive,
        teamhubDigest: nextArchive.sha256,
        runtimeDigest: nextArchive.sha256,
        includeTool: false,
      });

    const oldApp = await startEnrolledLocalServer({
      currentArchive: prevArchive,
      repoName: prevArchive.sha256.slice(0, 16),
      version: "0.16.0",
    });
    await oldApp.module.prepareUpdateTool(staged, new AbortController().signal);
    await oldApp.host.stop("quit");

    const preStaged = path.join(
      oldApp.home,
      "desktop",
      "source",
      nextArchive.sha256.slice(0, 16),
    );
    writeFileSync(path.join(preStaged, "pre-staged-marker"), "kept");
    const offlineVerifiedFile = path.join(
      preStaged,
      ".simplexai-runtime/offline/verified.json",
    );
    const offlineVerifiedBody = readFileSync(offlineVerifiedFile, "utf8");

    // Launch the updated version using the same home; omit the bundled tarball in
    // its installerDirectory so resume succeeds only if it reuses the pre-staged tree.
    const nextInstallerDir = path.join(root, "next-installer");
    mkdirSync(nextInstallerDir, { recursive: true });
    cpSync(
      path.join(stagedInstallerDir, "native"),
      path.join(nextInstallerDir, "native"),
      { recursive: true },
    );
    writeFileSync(path.join(nextInstallerDir, "installer.js"), FAKE_INSTALLER);
    writeFileSync(
      path.join(nextInstallerDir, "package.json"),
      '{"type":"commonjs"}',
    );
    writeFileSync(
      path.join(nextInstallerDir, "distribution.json"),
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        nativeSources: [{ target }],
      }),
    );
    const nextApp = fixture(
      {
        home: oldApp.home,
        platform: process.platform,
        arch: process.arch,
        glibcVersion: "2.35",
        installerDirectory: nextInstallerDir,
        sourceArchive: {
          file: "source/linger.tar.gz",
          sha256: nextArchive.sha256,
        },
        fetch: okFetch,
      },
      enrolled,
    );
    await nextApp.host.start();
    await waitForInstaller(() =>
      expect(nextApp.module.status().phase).toBe("ready"),
    );
    const args = installerArgs(oldApp.home);
    expect(args[args.indexOf("--source-repo") + 1]).toBe(preStaged);
    expect(
      readFileSync(path.join(preStaged, "pre-staged-marker"), "utf8"),
    ).toBe("kept");
    expect(readFileSync(offlineVerifiedFile, "utf8")).toBe(offlineVerifiedBody);
    await nextApp.host.stop("quit");
  });

  it("cleans up partial staging and keeps records untouched on abort or invalid manifests", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(path.join(root, "src"));
    const targetDirName = archive.sha256.slice(0, 16);

    // Missing manifests and disagreeing manifests skip pre-staging without error.
    const noManifestBundle = buildStagedUpdateBundle(
      path.join(root, "no-manifest"),
      { source: archive, includeTool: false },
    );
    const mismatchBundle = buildStagedUpdateBundle(
      path.join(root, "mismatch"),
      {
        source: archive,
        teamhubDigest: archive.sha256,
        runtimeDigest: "f".repeat(64),
        includeTool: false,
      },
    );
    const multiArchiveBundle = buildStagedUpdateBundle(
      path.join(root, "multi"),
      {
        source: archive,
        teamhubDigest: archive.sha256,
        runtimeDigest: archive.sha256,
        includeTool: false,
        sourceFiles: ["a.tar.gz", "b.tar.gz"],
      },
    );

    const controller = new AbortController();
    const runtimeController = new AbortController();
    let seenPartial: string | undefined;
    let seenRuntimePartial: string | undefined;
    let activeAbort = controller;
    const f = await startEnrolledLocalServer({
      repoName: "active",
      version: "0.16.0",
      rename: async (from, to) => {
        if (from.endsWith(".partial")) {
          if (activeAbort === controller) {
            seenPartial = from;
            expect(existsSync(from)).toBe(true);
            controller.abort();
            throw controller.signal.reason;
          }
          if (from.endsWith(path.join("offline.partial"))) {
            seenRuntimePartial = from;
            expect(existsSync(from)).toBe(true);
            runtimeController.abort();
            throw runtimeController.signal.reason;
          }
        }
        await rename(from, to);
      },
    });

    for (const bundle of [
      noManifestBundle.staged,
      mismatchBundle.staged,
      multiArchiveBundle.staged,
    ]) {
      await f.module.prepareUpdateTool(bundle, new AbortController().signal);
    }
    const preStaged = path.join(f.home, "desktop", "source", targetDirName);
    expect(existsSync(preStaged)).toBe(false);

    // Abort mid-extraction during publish: cleans up `.partial` and leaves record intact.
    const validBundle = buildStagedUpdateBundle(path.join(root, "valid"), {
      source: archive,
      teamhubDigest: archive.sha256,
      runtimeDigest: archive.sha256,
      includeTool: false,
    });
    await expect(
      f.module.prepareUpdateTool(validBundle.staged, controller.signal),
    ).rejects.toThrow();
    expect(seenPartial).toBe(`${preStaged}.partial`);
    expect(existsSync(`${preStaged}.partial`)).toBe(false);
    expect(existsSync(preStaged)).toBe(false);

    // Abort mid-runtime copy after source extraction succeeds: cleans up
    // offline.partial and leaves existing records untouched.
    activeAbort = runtimeController;
    await expect(
      f.module.prepareUpdateTool(validBundle.staged, runtimeController.signal),
    ).rejects.toThrow();
    const offline = path.join(preStaged, ".simplexai-runtime", "offline");
    expect(seenRuntimePartial).toBe(`${offline}.partial`);
    expect(existsSync(`${offline}.partial`)).toBe(false);
    expect(existsSync(offline)).toBe(false);
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toEqual({
      home: f.home,
      repo: path.join(f.home, "desktop", "source", "active"),
      origin: "http://localhost:3000",
      version: "0.16.0",
    });
    await f.host.stop("quit");
  });

  it("keeps pre-staged source protection refcounted when one concurrent caller aborts before SOURCE_MARKER exists", async () => {
    const foldersSpy = vi
      .spyOn(nativeProcess, "foldersInUse")
      .mockResolvedValue(new Set());
    try {
      const root = tempDirectory();
      const currArchive = sourceArchive(path.join(root, "curr"), "curr");
      const v2Archive = sourceArchive(path.join(root, "v2"), "v2");
      const v3Archive = sourceArchive(path.join(root, "v3"), "v3");
      const v2Bundle = buildStagedUpdateBundle(path.join(root, "s2"), {
        source: v2Archive,
        teamhubDigest: v2Archive.sha256,
        runtimeDigest: v2Archive.sha256,
        includeTool: false,
      });
      const v3Bundle = buildStagedUpdateBundle(path.join(root, "s3"), {
        source: v3Archive,
        teamhubDigest: v3Archive.sha256,
        runtimeDigest: v3Archive.sha256,
        includeTool: false,
      });

      const v2Dir = path.join(
        root,
        "home",
        "desktop",
        "source",
        v2Archive.sha256.slice(0, 16),
      );
      const v3Dir = path.join(
        root,
        "home",
        "desktop",
        "source",
        v3Archive.sha256.slice(0, 16),
      );

      let v2PublishCount = 0;
      const v2Reached = deferred();
      const allowV2Publish = deferred();
      const v3Reached = deferred();
      const allowV3Publish = deferred();

      const c1 = new AbortController();
      const c2 = new AbortController();
      const c3 = new AbortController();
      const c4 = new AbortController();

      const f = await startEnrolledLocalServer({
        root,
        currentArchive: currArchive,
        repoName: "previous",
        resumeFails: true,
        fetch: okFetch,
        rename: async (from, to) => {
          if (from === `${v2Dir}.partial`) {
            v2PublishCount += 1;
            if (v2PublishCount === 1) {
              v2Reached.resolve();
              await allowV2Publish.promise;
              if (c1.signal.aborted) throw c1.signal.reason;
            }
          } else if (from === `${v3Dir}.partial`) {
            v3Reached.resolve();
            await allowV3Publish.promise;
          }
          await rename(from, to);
        },
      });

      // Case 1: Active caller c1 aborts before SOURCE_MARKER exists while sibling c2 waits and succeeds.
      const p1 = f.module.prepareUpdateTool(v2Bundle.staged, c1.signal);
      await v2Reached.promise;
      const p2 = f.module.prepareUpdateTool(v2Bundle.staged, c2.signal);
      await delay(15);
      c1.abort();
      allowV2Publish.resolve();
      await expect(p1).rejects.toThrow();
      await p2;
      expect(existsSync(path.join(v2Dir, "scripts/source-native.mjs"))).toBe(
        true,
      );

      // Case 2: Second caller c4 aborts before SOURCE_MARKER exists while active caller c3 is still staging.
      const p3 = f.module.prepareUpdateTool(v3Bundle.staged, c3.signal);
      await v3Reached.promise;
      const p4 = f.module.prepareUpdateTool(v3Bundle.staged, c4.signal);
      await delay(15);
      c4.abort();
      await expect(p4).rejects.toThrow();
      allowV3Publish.resolve();
      await p3;
      expect(existsSync(path.join(v3Dir, "scripts/source-native.mjs"))).toBe(
        true,
      );

      // Trigger #schedulePruneSources via resume retry; previous is deleted while v2 & v3 remain.
      rmSync(path.join(f.home, "resume-fails"));
      f.bus.emit("local-server.retry");
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      await vi.waitFor(() =>
        expect(
          existsSync(path.join(f.home, "desktop", "source", "previous")),
        ).toBe(false),
      );
      expect(existsSync(v2Dir)).toBe(true);
      expect(existsSync(v3Dir)).toBe(true);
      await f.host.stop("quit");
    } finally {
      foldersSpy.mockRestore();
    }
  });

  it("blocks #stageDirectory until an active prune completes so concurrent staging finishes intact", async () => {
    const root = tempDirectory();
    const currArchive = sourceArchive(path.join(root, "curr"), "curr");
    const nextArchive = sourceArchive(path.join(root, "next"), "next");
    const { staged } = buildStagedUpdateBundle(path.join(root, "s2"), {
      source: nextArchive,
      teamhubDigest: nextArchive.sha256,
      runtimeDigest: nextArchive.sha256,
      includeTool: false,
    });

    const pruneStarted = deferred();
    const releasePrune = deferred<Set<string>>();
    const foldersSpy = vi
      .spyOn(nativeProcess, "foldersInUse")
      .mockImplementationOnce(() => {
        pruneStarted.resolve();
        return releasePrune.promise;
      })
      .mockResolvedValue(new Set());

    try {
      const f = await startEnrolledLocalServer({
        currentArchive: currArchive,
        repoName: "previous",
        fetch: okFetch,
        setup: (home) => {
          // Leftover damaged directory matching nextArchive hash that prune will inspect.
          const damaged = path.join(
            home,
            "desktop",
            "source",
            nextArchive.sha256.slice(0, 16),
          );
          mkdirSync(damaged, { recursive: true });
          writeFileSync(path.join(damaged, "junk.txt"), "damaged");
        },
      });
      await pruneStarted.promise;

      const preStaged = path.join(
        f.home,
        "desktop",
        "source",
        nextArchive.sha256.slice(0, 16),
      );
      const prep = f.module.prepareUpdateTool(
        staged,
        new AbortController().signal,
      );
      await delay(20);
      // Staging must wait until the in-flight prune settles before touching preStaged.
      expect(
        existsSync(path.join(preStaged, "scripts/source-native.mjs")),
      ).toBe(false);

      releasePrune.resolve(new Set());
      await prep;
      expect(
        existsSync(path.join(f.home, "desktop", "source", "previous")),
      ).toBe(false);
      expect(
        existsSync(path.join(preStaged, "scripts/source-native.mjs")),
      ).toBe(true);
      expect(
        readFileSync(
          path.join(preStaged, ".simplexai-runtime/prebuilt/teamhub"),
          "utf8",
        ),
      ).toBe("teamhub");
      expect(
        existsSync(
          path.join(preStaged, ".simplexai-runtime/offline/verified.json"),
        ),
      ).toBe(true);
      await f.host.stop("quit");
    } finally {
      foldersSpy.mockRestore();
    }
  });

  it("drains all asset cleanups in #ensureSourceAssets before allowing a waiting caller to retry", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(path.join(root, "src"));
    const { staged } = buildStagedUpdateBundle(path.join(root, "s"), {
      source: archive,
      teamhubDigest: archive.sha256,
      runtimeDigest: archive.sha256,
      includeTool: false,
    });

    const c1 = new AbortController();
    const c2 = new AbortController();
    let offlineRenameCalls = 0;
    const cleanupStarted = deferred();
    const allowCleanupFinish = deferred();

    const realRemoveRetrying = fsRetry.removeRetrying;
    let holdFirstOfflinePartialCleanup = false;
    const removeSpy = vi
      .spyOn(fsRetry, "removeRetrying")
      .mockImplementation(async (targetPath) => {
        if (
          holdFirstOfflinePartialCleanup &&
          targetPath.endsWith(path.join("offline.partial"))
        ) {
          holdFirstOfflinePartialCleanup = false;
          cleanupStarted.resolve();
          await allowCleanupFinish.promise;
        }
        return realRemoveRetrying(targetPath);
      });

    try {
      const f = await startEnrolledLocalServer({
        repoName: "active",
        rename: async (from, to) => {
          if (from.endsWith(path.join("offline.partial"))) {
            offlineRenameCalls += 1;
            if (offlineRenameCalls === 1) {
              holdFirstOfflinePartialCleanup = true;
              c1.abort();
              throw c1.signal.reason;
            }
          }
          await rename(from, to);
        },
      });

      const p1 = f.module.prepareUpdateTool(staged, c1.signal);
      await cleanupStarted.promise;

      // Second caller enters while c1's offline.partial cleanup is still in flight.
      const p2 = f.module.prepareUpdateTool(staged, c2.signal);
      await delay(20);
      expect(offlineRenameCalls).toBe(1);

      allowCleanupFinish.resolve();
      await expect(p1).rejects.toThrow();
      await p2;
      expect(offlineRenameCalls).toBe(2);
      const preStaged = path.join(
        f.home,
        "desktop",
        "source",
        archive.sha256.slice(0, 16),
      );
      expect(
        existsSync(
          path.join(preStaged, ".simplexai-runtime/offline/verified.json"),
        ),
      ).toBe(true);
      expect(
        existsSync(path.join(preStaged, ".simplexai-runtime/offline.partial")),
      ).toBe(false);
      await f.host.stop("quit");
    } finally {
      removeSpy.mockRestore();
    }
  });

  it("skips pre-staging when the staged source hash matches the active record.repo", async () => {
    const info = vi.spyOn(silentLog, "info");
    try {
      const root = tempDirectory();
      const archive = sourceArchive(path.join(root, "src"));
      const { staged } = buildStagedUpdateBundle(path.join(root, "s"), {
        source: archive,
        teamhubDigest: archive.sha256,
        runtimeDigest: archive.sha256,
        includeTool: false,
      });

      const renameSpy = vi.fn(async (from: string, to: string) => {
        await rename(from, to);
      });
      const f = await startEnrolledLocalServer({
        currentArchive: archive,
        repoName: archive.sha256.slice(0, 16),
        rename: renameSpy,
        setup: (_home, active) => {
          writeFileSync(path.join(active, "live-sentinel.txt"), "live");
          mkdirSync(path.join(active, ".simplexai-runtime/prebuilt"), {
            recursive: true,
          });
          writeFileSync(
            path.join(active, ".simplexai-runtime/prebuilt/sentinel.txt"),
            "prebuilt",
          );
          mkdirSync(path.join(active, ".simplexai-runtime/offline"), {
            recursive: true,
          });
          // Intentionally omit verified.json so running #ensureNativeRuntime would have removed offline.
          writeFileSync(
            path.join(active, ".simplexai-runtime/offline/sentinel.txt"),
            "offline",
          );
        },
      });

      await f.module.prepareUpdateTool(staged, new AbortController().signal);
      expect(renameSpy).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalledWith(
        "local_server.update_source_prepared",
        expect.anything(),
      );
      const active = path.join(
        f.home,
        "desktop",
        "source",
        archive.sha256.slice(0, 16),
      );
      expect(readFileSync(path.join(active, "live-sentinel.txt"), "utf8")).toBe(
        "live",
      );
      expect(
        readFileSync(
          path.join(active, ".simplexai-runtime/prebuilt/sentinel.txt"),
          "utf8",
        ),
      ).toBe("prebuilt");
      expect(
        readFileSync(
          path.join(active, ".simplexai-runtime/offline/sentinel.txt"),
          "utf8",
        ),
      ).toBe("offline");
      await f.host.stop("quit");
    } finally {
      info.mockRestore();
    }
  });

  it("removes both prebuilt and prebuilt.verified.json when aborting during or right after TeamHub binary install", async () => {
    const root = tempDirectory();
    const archive = sourceArchive(path.join(root, "src"));
    const { staged } = buildStagedUpdateBundle(path.join(root, "s"), {
      source: archive,
      teamhubDigest: archive.sha256,
      includeTool: false,
    });

    const f = await startEnrolledLocalServer({ repoName: "active" });

    const preStaged = path.join(
      f.home,
      "desktop",
      "source",
      archive.sha256.slice(0, 16),
    );
    const binaryDir = path.join(preStaged, ".simplexai-runtime/prebuilt");
    const stampFile = teamhubBinaries.teamhubBinaryStampsFile(binaryDir);

    // Case 1: Abort during installTeamhubBinaries right as stamps are written.
    const realWriteStamps = verifiedStamps.writeSettledStamps;
    const c1 = new AbortController();
    const stampSpy = vi
      .spyOn(verifiedStamps, "writeSettledStamps")
      .mockImplementationOnce(async (file, digest, stamps) => {
        await realWriteStamps(file, digest, stamps);
        expect(existsSync(binaryDir)).toBe(true);
        expect(existsSync(stampFile)).toBe(true);
        c1.abort();
        throw c1.signal.reason;
      });
    try {
      await expect(
        f.module.prepareUpdateTool(staged, c1.signal),
      ).rejects.toThrow();
    } finally {
      stampSpy.mockRestore();
    }
    expect(existsSync(binaryDir)).toBe(false);
    expect(existsSync(stampFile)).toBe(false);

    // Case 2: Post-install abort right after installTeamhubBinaries returns "installed".
    const realInstallBinaries = teamhubBinaries.installTeamhubBinaries;
    const c2 = new AbortController();
    const installSpy = vi
      .spyOn(teamhubBinaries, "installTeamhubBinaries")
      .mockImplementationOnce(async (from, repo, expected) => {
        expect(expected.signal).toBeDefined();
        const state = await realInstallBinaries(from, repo, expected);
        expect(state).toBe("installed");
        expect(existsSync(binaryDir)).toBe(true);
        expect(existsSync(stampFile)).toBe(true);
        c2.abort();
        return state;
      });
    try {
      await expect(
        f.module.prepareUpdateTool(staged, c2.signal),
      ).rejects.toThrow();
    } finally {
      installSpy.mockRestore();
    }
    expect(existsSync(binaryDir)).toBe(false);
    expect(existsSync(stampFile)).toBe(false);
    await f.host.stop("quit");
  });

  it("pre-stages a newer shared bundled Node.js binary during prepareUpdateTool without touching status", async () => {
    const info = vi.spyOn(silentLog, "info");
    try {
      const root = tempDirectory();
      const target = `${process.platform}-${process.arch}`;
      const nextNodeVersion = "99.1.0";
      const nextArchive = sourceArchive(path.join(root, "node-src"), "next");
      const { staged, runtimeDir } = buildStagedUpdateBundle(root, {
        target,
        source: nextArchive,
        teamhubDigest: nextArchive.sha256,
        runtimeDigest: nextArchive.sha256,
        includeTool: false,
      });

      const stagedNodePath = path.join(
        staged,
        "Contents",
        "Resources",
        "runtime",
        "bin",
        "node",
      );
      mkdirSync(path.dirname(stagedNodePath), { recursive: true });
      const nodePayload = "#!/bin/sh\necho node-99\n";
      writeFileSync(stagedNodePath, nodePayload, { mode: 0o755 });
      const nodeSha = sha256Hex(nodePayload);

      const manifestPath = path.join(runtimeDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest.node = {
        version: nextNodeVersion,
        shared: true,
        binary: "runtime/bin/node",
        sha256: nodeSha,
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const currentNodePath = path.join(
        root,
        "current-app",
        "runtime",
        "bin",
        "node",
      );
      mkdirSync(path.dirname(currentNodePath), { recursive: true });
      writeFileSync(currentNodePath, "#!/bin/sh\necho node-old\n", {
        mode: 0o755,
      });

      const f = await startEnrolledLocalServer({
        repoName: "active",
        bundledNodePath: currentNodePath,
      });
      const beforeStatus = f.module.status();
      const changed = vi.fn();
      const offChanged = f.bus.on("local-server.changed", changed);

      await f.module.prepareUpdateTool(staged, new AbortController().signal);
      offChanged();

      const expectedNode = path.join(
        f.home,
        "desktop",
        "node",
        `v${nextNodeVersion}`,
        "bin",
        "node",
      );
      expect(existsSync(expectedNode)).toBe(true);
      expect(readFileSync(expectedNode, "utf8")).toBe(nodePayload);
      expect(changed).not.toHaveBeenCalled();
      expect(f.module.status()).toEqual(beforeStatus);
      expect(info).toHaveBeenCalledWith(
        "local_server.update_node_prepared",
        expect.objectContaining({
          version: nextNodeVersion,
          ms: expect.any(Number),
        }),
      );

      // Repeat call skips silently without copying or logging again.
      info.mockClear();
      await f.module.prepareUpdateTool(staged, new AbortController().signal);
      expect(info).not.toHaveBeenCalledWith(
        "local_server.update_node_prepared",
        expect.anything(),
      );

      // Invalid shared node specs (bad version, unexpected binary, empty
      // sha256, non-shared flag, mismatched target) are ignored without
      // copying or failing.
      const invalidSpecs: Array<{
        readonly label: string;
        readonly target?: string;
        readonly node: Record<string, unknown>;
      }> = [
        {
          label: "../escape",
          node: {
            version: "../escape",
            shared: true,
            binary: "runtime/bin/node",
            sha256: nodeSha,
          },
        },
        {
          label: "99.4.0",
          node: {
            version: "99.4.0",
            shared: true,
            binary: "runtime/bin/node.exe",
            sha256: nodeSha,
          },
        },
        {
          label: "99.5.0",
          node: {
            version: "99.5.0",
            shared: true,
            binary: "runtime/bin/node",
            sha256: "",
          },
        },
        {
          label: "99.6.0",
          node: {
            version: "99.6.0",
            shared: false,
            binary: "runtime/bin/node",
            sha256: nodeSha,
          },
        },
        {
          label: "99.7.0",
          target: "other-arch",
          node: {
            version: "99.7.0",
            shared: true,
            binary: "runtime/bin/node",
            sha256: nodeSha,
          },
        },
      ];
      for (const spec of invalidSpecs) {
        const nextManifest = {
          ...manifest,
          target: spec.target ?? target,
          node: spec.node,
        };
        writeFileSync(manifestPath, JSON.stringify(nextManifest));
        await expect(
          f.module.prepareUpdateTool(staged, new AbortController().signal),
        ).resolves.toBeUndefined();
        expect(
          existsSync(path.join(f.home, "desktop", "node", `v${spec.label}`)),
        ).toBe(false);
      }
      expect(info).not.toHaveBeenCalledWith(
        "local_server.update_node_prepared",
        expect.anything(),
      );

      // A staged bundle without a shared Node binary skips without failing and
      // does not fall back to the current app's bundledNodePath.
      rmSync(stagedNodePath);
      const manifestMissing = {
        ...manifest,
        target,
        node: {
          version: "99.2.0",
          shared: true,
          binary: "runtime/bin/node",
          sha256: nodeSha,
        },
      };
      writeFileSync(manifestPath, JSON.stringify(manifestMissing));
      await expect(
        f.module.prepareUpdateTool(staged, new AbortController().signal),
      ).resolves.toBeUndefined();
      expect(existsSync(path.join(f.home, "desktop", "node", "v99.2.0"))).toBe(
        false,
      );

      await f.host.stop("quit");
    } finally {
      info.mockRestore();
    }
  });

  it("rejects on staged shared Node.js SHA-256 mismatch, cleans up partial, and lets sibling source staging settle", async () => {
    const info = vi.spyOn(silentLog, "info");
    const realRemoveRetrying = fsRetry.removeRetrying;
    const nodeCleanupDone = deferred();
    const sourceReached = deferred();
    const allowSourcePublish = deferred();
    let expectedNodeDir = "";
    let nodePartialRemovals = 0;
    const removeSpy = vi
      .spyOn(fsRetry, "removeRetrying")
      .mockImplementation(async (targetPath) => {
        await realRemoveRetrying(targetPath);
        if (expectedNodeDir && targetPath === `${expectedNodeDir}.partial`) {
          nodePartialRemovals += 1;
          if (nodePartialRemovals === 2) nodeCleanupDone.resolve();
        }
      });
    try {
      const root = tempDirectory();
      const target = `${process.platform}-${process.arch}`;
      const nextNodeVersion = "99.3.0";
      const nextArchive = sourceArchive(
        path.join(root, "node-mismatch-src"),
        "next-mismatch",
      );
      const { staged, runtimeDir } = buildStagedUpdateBundle(root, {
        target,
        source: nextArchive,
        teamhubDigest: nextArchive.sha256,
        runtimeDigest: nextArchive.sha256,
        includeTool: false,
      });

      const stagedNodePath = path.join(
        staged,
        "Contents",
        "Resources",
        "runtime",
        "bin",
        "node",
      );
      mkdirSync(path.dirname(stagedNodePath), { recursive: true });
      writeFileSync(stagedNodePath, "#!/bin/sh\necho tampered-node\n", {
        mode: 0o755,
      });

      const manifestPath = path.join(runtimeDir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest.node = {
        version: nextNodeVersion,
        shared: true,
        binary: "runtime/bin/node",
        sha256: "0".repeat(64),
      };
      writeFileSync(manifestPath, JSON.stringify(manifest));

      let preStaged = "";
      const f = await startEnrolledLocalServer({
        repoName: "active",
        rename: async (from, to) => {
          if (preStaged && to === preStaged) {
            sourceReached.resolve();
            await allowSourcePublish.promise;
          }
          await rename(from, to);
        },
      });
      expectedNodeDir = path.join(
        f.home,
        "desktop",
        "node",
        `v${nextNodeVersion}`,
      );
      preStaged = path.join(
        f.home,
        "desktop",
        "source",
        nextArchive.sha256.slice(0, 16),
      );

      let settled = false;
      const outcome = f.module
        .prepareUpdateTool(staged, new AbortController().signal)
        .then(
          () => {
            settled = true;
            return { ok: true as const };
          },
          (error: unknown) => {
            settled = true;
            return { ok: false as const, error };
          },
        );

      // Wait until both #prepareUpdateNode has failed and cleaned up its
      // .partial directory and #prepareUpdateSource is paused at publish.
      await Promise.all([sourceReached.promise, nodeCleanupDone.promise]);
      await delay(10);
      expect(settled).toBe(false);

      allowSourcePublish.resolve();
      const result = await outcome;
      expect(result.ok).toBe(false);
      expect(result.ok ? undefined : result.error).toBeInstanceOf(Error);
      expect(result.ok ? "" : (result.error as Error).message).toMatch(
        /damaged/,
      );
      expect(existsSync(`${expectedNodeDir}.partial`)).toBe(false);
      expect(existsSync(expectedNodeDir)).toBe(false);
      expect(
        existsSync(path.join(preStaged, "scripts/source-native.mjs")),
      ).toBe(true);
      expect(info).toHaveBeenCalledWith(
        "local_server.update_source_prepared",
        expect.objectContaining({ source: nextArchive.sha256.slice(0, 16) }),
      );
      expect(info).not.toHaveBeenCalledWith(
        "local_server.update_node_prepared",
        expect.anything(),
      );

      await f.host.stop("quit");
    } finally {
      removeSpy.mockRestore();
      info.mockRestore();
    }
  });

  it("forgets the installation and its enrollment when the person sets up again", async () => {
    const f = fixture({}, enrolled, (home) => {
      record(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    const opened = vi.fn();
    f.bus.on("setup.open", opened);
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    f.bus.emit("local-server.reset");
    await waitForInstaller(() => expect(opened).toHaveBeenCalledOnce());
    expect(f.module.status().phase).toBe("idle");
    expect(existsSync(path.join(f.home, "desktop", "local-server.json"))).toBe(
      false,
    );
    expect(f.unenroll).toHaveBeenCalledOnce();
    expect(f.config().serverUrl).toBeUndefined();
    expect(f.loadServer).toHaveBeenCalledOnce();
    // Try Again has nothing left to start.
    rmSync(path.join(f.home, "installer", "args.json"));
    f.bus.emit("local-server.retry");
    await delay(50);
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    await f.host.stop("quit");
  });

  it("renews the same Computer ID across local-server reset and re-enrollment with retained daemon identity", async () => {
    const root = tempDirectory();
    const home = path.join(root, "home");
    const installerDirectory = path.join(root, "installer");
    mkdirSync(installerDirectory, { recursive: true });
    writeFileSync(
      path.join(installerDirectory, "installer.js"),
      FAKE_INSTALLER,
    );
    writeFileSync(
      path.join(installerDirectory, "package.json"),
      '{"type":"commonjs"}',
    );
    writeFileSync(
      path.join(installerDirectory, "distribution.json"),
      JSON.stringify({
        platform: "linux",
        arch: "x64",
        nativeSources: [{ target: "linux-x64" }],
      }),
    );
    const node = path.join(home, "desktop", "node", `v${NODE_RUNTIME_VERSION}`);
    mkdirSync(path.join(node, "bin"), { recursive: true });
    fixtureNode(path.join(node, "bin", "node"));
    checkout(home);

    const daemonIdentityFile = path.join(root, "state", "daemon-identity.json");
    mkdirSync(path.dirname(daemonIdentityFile), { recursive: true });
    const pubkey = Buffer.alloc(32, 5);
    writeFileSync(
      daemonIdentityFile,
      JSON.stringify({
        public_key: pubkey.toString("base64").replace(/=+$/, ""),
      }),
    );
    const expectedDaemonId = createHash("sha256")
      .update(pubkey)
      .digest("base64url");

    const computers: {
      readonly computer_id: string;
      readonly daemon_id: string | undefined;
      readonly owner_actor_id: string;
    }[] = [];
    const enrollmentBodies: Record<string, unknown>[] = [];
    let resetOccurred = false;
    let postResetPolls = 0;
    const api = installerApi();
    const teamhubToken = (computerId: string) =>
      `sr1.${Buffer.from(
        JSON.stringify({
          runner_id: computerId,
          tenant_owners: [{ tenant_id: "t1", owner_actor_id: "actor_ann" }],
        }),
      ).toString("base64url")}.${"s".repeat(43)}`;

    const fetcher = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin === "http://127.0.0.1:4321") return api.handle(url, init);
      if (url.pathname === "/v0/me")
        return Response.json({
          actors: [{ id: "actor_ann", kind: "human", tenant_id: "t1" }],
          server_capabilities: ["local_computer_enrollment_daemon_id"],
        });
      if (url.pathname === "/v0/tenants/t1/local-computer-enrollments") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        enrollmentBodies.push(body);
        const requestedId =
          typeof body.computer_id === "string" ? body.computer_id : undefined;
        const daemonId =
          typeof body.daemon_id === "string" ? body.daemon_id : undefined;
        const existing =
          computers.find((c) => c.computer_id === requestedId) ??
          (daemonId
            ? computers.find(
                (c) =>
                  c.daemon_id === daemonId && c.owner_actor_id === "actor_ann",
              )
            : undefined);
        const resolvedId =
          existing?.computer_id ?? `cmp_${String(computers.length + 1)}`;
        if (!existing) {
          computers.push({
            computer_id: resolvedId,
            daemon_id: daemonId,
            owner_actor_id: "actor_ann",
          });
        }
        return Response.json({
          enrollment_id: `enr_${resolvedId}`,
          computer_id: resolvedId,
          authorization_code: `code_${resolvedId}`,
          expires_at: "2026-11-18T00:00:00Z",
        });
      }
      if (url.pathname.startsWith("/v0/local-computer-enrollments/")) {
        const id = url.pathname.split("/")[3]!.replace(/^enr_/, "");
        return Response.json({
          computer_id: id,
          tenant_id: "t1",
          gateway_url: "wss://localhost:4319/v1/runner",
          gateway_token: teamhubToken(id),
          credential_expires_at: "2026-12-18T00:00:00Z",
        });
      }
      if (url.pathname === "/v0/tenants/t1/another-me")
        return Response.json({ agent_actor_id: "actor_anotherme_1" });
      if (url.pathname === "/v0/tenants/t1/rooms")
        return Response.json({ items: [{ name: "Getting Started" }] });
      if (url.pathname === "/v0/tenants/t1/local-computers") {
        const online = !resetOccurred || ++postResetPolls >= 2;
        return Response.json({
          items: computers.map((c) => ({
            computer_id: c.computer_id,
            status: online ? "online" : "offline",
          })),
        });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const bus = new EventBus();
    const initialGrant = {
      grantId: "grant_1",
      path: path.join(root, "workspace"),
      label: "Workspace",
      access: "read_write" as const,
      createdAt: "2026-11-01T00:00:00Z",
    };
    const enrollment = new EnrollmentModule({
      sessionCookie: async () => "session=s",
      defaultDisplayName: "Studio Mac",
      credentials: new CredentialStore(path.join(root, "credential.json")),
      daemonIdentityFile,
      fetch: fetcher,
    });
    const module = new LocalServerModule({
      home,
      version: APP_VERSION,
      installerDirectory,
      checkout: path.join(home, "src"),
      platform: "linux",
      arch: "x64",
      pollMs: 1,
      freeBytes: 1,
      signIn: async () => {},
      serverIdentity: async (_h, origin) => ({
        origin,
        teamhub: TEAMHUB,
        key: KEY,
      }),
      proveServer: async () => {},
      sessionCookie: async () => "session=s",
      fetch: fetcher,
    });
    let hostContext: ModuleContext | undefined;
    const host = testHost(
      [
        {
          ...stubModule("Config"),
          start: async (ctx: ModuleContext) => {
            hostContext = ctx;
          },
        },
        {
          ...stubModule("WindowManager"),
          setServer: (origin: string) => {
            if (origin !== hostContext!.config.get().serverUrl) {
              hostContext!.config.update({ serverUrl: origin });
              bus.emit("server.changed", origin);
            }
            return true;
          },
          showUpdating: vi.fn(),
          showStarting: vi.fn(),
          showStartFailed: vi.fn(),
          loadServer: vi.fn(),
          prewarmAssets: vi.fn(async () => {}),
          preloadAuthenticated: vi.fn(),
        } as never,
        {
          ...stubModule("WorkspaceGrants", ["Config"]),
          ensureDefault: vi.fn(async () => {}),
          defaultFailure: vi.fn(() => undefined),
        } as never,
        enrollment,
        module,
      ],
      { workspaceGrants: [initialGrant] },
      bus,
    );

    const opened = vi.fn();
    bus.on("setup.open", opened);
    await host.start();

    await module.begin();
    expect(module.status().phase).toBe("ready");
    expect(host.ctx.config.get().computerId).toBe("cmp_1");
    expect(enrollmentBodies[0]?.daemon_id).toBe(expectedDaemonId);

    resetOccurred = true;
    bus.emit("local-server.reset");
    await waitForInstaller(() => expect(opened).toHaveBeenCalledOnce());
    expect(host.ctx.config.get().computerId).toBeUndefined();
    expect(host.ctx.config.get().serverUrl).toBeUndefined();
    expect(host.ctx.config.get().savedEnrollments).toEqual({
      "http://localhost:3000": {
        computerId: "cmp_1",
        tenantId: "t1",
        ownerActorId: "actor_ann",
      },
    });
    expect(host.ctx.config.get().workspaceGrants).toEqual([initialGrant]);

    await module.begin();
    expect(module.status().phase).toBe("ready");
    expect(host.ctx.config.get().computerId).toBe("cmp_1");
    expect(host.ctx.config.get().workspaceGrants).toEqual([initialGrant]);
    expect(computers).toHaveLength(1);
    expect(enrollmentBodies).toHaveLength(2);
    expect(enrollmentBodies[1]?.computer_id).toBe("cmp_1");
    expect(enrollmentBodies[1]?.daemon_id).toBe(expectedDaemonId);
    expect(postResetPolls).toBe(2);
    await host.stop("quit");
  });

  it("writes its record in one piece", async () => {
    const f = fixture(withCheckout, {}, checkout);
    await f.host.start();
    await f.module.begin();
    expect(readdirSync(path.join(f.home, "desktop")).sort()).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]),
    );
    expect(
      JSON.parse(
        readFileSync(path.join(f.home, "desktop", "local-server.json"), "utf8"),
      ),
    ).toMatchObject({ origin: "http://localhost:3000" });
    await f.host.stop("quit");
  });

  it(
    "leaves no staged record behind when the record cannot be moved into place",
    // A target directory returns EPERM on Windows, consuming the 30 s retry budget.
    { timeout: isWindowsHost ? 45_000 : 5_000 },
    async () => {
      const f = fixture(withCheckout, {}, checkout);
      mkdirSync(path.join(f.home, "desktop", "local-server.json", "x"), {
        recursive: true,
      });
      await f.host.start();
      try {
        await expect(f.module.begin()).rejects.toMatchObject({
          syscall: "rename",
        });
        expect(readdirSync(path.join(f.home, "desktop"))).toEqual(
          expect.not.arrayContaining([expect.stringMatching(/\.tmp$/)]),
        );
      } finally {
        await f.host.stop("quit");
      }
    },
  );

  it("leaves the services alone when the window uses another server", async () => {
    const f = fixture({}, { serverUrl: "https://linger.example" }, record);
    await f.host.start();
    expect(f.module.status().phase).toBe("idle");
    expect(existsSync(path.join(f.home, "installer", "args.json"))).toBe(false);
    await f.host.stop("quit");
  });
});

describe("followHttps", () => {
  it("refuses a redirect away from HTTPS", async () => {
    const fetcher = followHttps(
      (async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://example.com/x" },
        })) as typeof fetch,
    );
    await expect(fetcher("https://example.com/a")).rejects.toThrow(/HTTPS/);
  });
});

// A TeamHub with KEY: it answers challenges for WEB_ORIGIN and logs in.
const WEB_ORIGIN = "http://localhost:3000";
const teamhub = (
  answer: (nonce: string) => Response | Promise<Response> = (nonce) =>
    Response.json({
      proof: localIdentityProof(KEY, nonce, WEB_ORIGIN).toString("base64url"),
    }),
) =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/v0/local/identity")
      return answer(
        (JSON.parse(String(init?.body)) as { nonce: string }).nonce,
      );
    return new Response("{}", {
      headers: {
        "set-cookie":
          "linger_session=v; Path=/; HttpOnly; SameSite=Lax; Max-Age=60",
      },
    });
  });
const sentPassword = (fetcher: ReturnType<typeof teamhub>, password: string) =>
  fetcher.mock.calls.some(([, init]) => String(init?.body).includes(password));

describe("proveLocalServer", () => {
  // The same vector as TeamHub's internal/localidentity test.
  it("computes TeamHub's proof", () => {
    expect(
      localIdentityProof(KEY, "A".repeat(43), WEB_ORIGIN).toString("base64url"),
    ).toBe("eKUTsEU-NZv-SW4c6jF3nCKa44wHETVelI_1rT6yu9w");
  });

  it("accepts the server that holds the key, asked on its own port", async () => {
    const fetcher = teamhub();
    await proveLocalServer(server(WEB_ORIGIN), fetcher as typeof fetch);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`${TEAMHUB}/v0/local/identity`);
    const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(nonce, "base64url")).toHaveLength(32);
  });

  it.each([
    [
      "another key",
      (nonce: string) =>
        Response.json({
          proof: localIdentityProof(
            Buffer.alloc(32),
            nonce,
            WEB_ORIGIN,
          ).toString("base64url"),
        }),
      "wrong proof",
    ],
    [
      "another origin",
      (nonce: string) =>
        Response.json({
          proof: localIdentityProof(
            KEY,
            nonce,
            "http://localhost:3001",
          ).toString("base64url"),
        }),
      "wrong proof",
    ],
    ["no proof", () => Response.json({}), "wrong proof"],
    ["a page", () => new Response("<html>"), "invalid answer"],
    ["an error", () => new Response("", { status: 404 }), "status 404"],
  ])("rejects a server that answers with %s", async (_case, answer, reason) => {
    await expect(
      proveLocalServer(server(WEB_ORIGIN), teamhub(answer) as typeof fetch),
    ).rejects.toMatchObject({
      name: "LocalServerUnverifiedError",
      reason,
      message: "Linger on this computer is not responding.",
    });
  });

  it("rejects an earlier answer replayed for a new challenge", async () => {
    let first: string | undefined;
    const fetcher = teamhub((nonce) => {
      first ??= localIdentityProof(KEY, nonce, WEB_ORIGIN).toString(
        "base64url",
      );
      return Response.json({ proof: first });
    });
    await proveLocalServer(server(WEB_ORIGIN), fetcher as typeof fetch);
    await expect(
      proveLocalServer(server(WEB_ORIGIN), fetcher as typeof fetch),
    ).rejects.toMatchObject({ reason: "wrong proof" });
    const nonces = fetcher.mock.calls.map(
      ([, init]) => (JSON.parse(String(init?.body)) as { nonce: string }).nonce,
    );
    expect(new Set(nonces).size).toBe(2);
  });

  it("gives up on a server that does not answer", async () => {
    const fetcher = teamhub(
      () => new Promise<Response>(() => {}),
    ).mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal!.reason),
          ),
        ),
    );
    await expect(
      proveLocalServer(server(WEB_ORIGIN), fetcher as typeof fetch, 20),
    ).rejects.toMatchObject({ reason: "no answer" });
  });

  it("treats nothing listening as no answer", async () => {
    await expect(
      proveLocalServer(server(WEB_ORIGIN), (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch),
    ).rejects.toBeInstanceOf(LocalServerUnverifiedError);
  });
});

describe("signInWithPassword", () => {
  it("hands the session cookies of the local server to the app", async () => {
    const set = vi.fn(async () => {});
    const fetcher = teamhub();
    await signInWithPassword(
      server(WEB_ORIGIN),
      "owner@linger.local",
      "pw",
      set,
      fetcher as typeof fetch,
    );
    const [url, init] = fetcher.mock.calls[1]!;
    // The login goes to TeamHub's port, as the window's origin.
    expect(String(url)).toBe(`${TEAMHUB}/v0/auth/login`);
    expect(init?.headers).toMatchObject({ origin: WEB_ORIGIN });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "linger_session",
        value: "v",
        path: "/",
        httpOnly: true,
        sameSite: "lax",
      }),
    );
  });

  it.each([
    ["answers wrongly", () => Response.json({ proof: "A".repeat(43) })],
    ["serves a page", () => new Response("<html>login</html>")],
  ])("never sends the password to a server that %s", async (_case, answer) => {
    const fetcher = teamhub(answer);
    await expect(
      signInWithPassword(
        server(WEB_ORIGIN),
        "owner@linger.local",
        "a-private-password",
        async () => {},
        fetcher as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(LocalServerUnverifiedError);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(sentPassword(fetcher, "a-private-password")).toBe(false);
  });

  it("fails without a session", async () => {
    const fetcher = teamhub();
    fetcher.mockImplementationOnce(async (_input, init) => {
      const { nonce } = JSON.parse(String(init?.body)) as { nonce: string };
      return Response.json({
        proof: localIdentityProof(KEY, nonce, WEB_ORIGIN).toString("base64url"),
      });
    });
    fetcher.mockImplementationOnce(
      async () => new Response("{}", { status: 401 }),
    );
    await expect(
      signInWithPassword(
        server(WEB_ORIGIN),
        "a",
        "b",
        async () => {},
        fetcher as typeof fetch,
      ),
    ).rejects.toEqual(new SignInRejectedError(401));
  });
});

describe("signInFailure", () => {
  it("says what to do by status and error kind, not by message", () => {
    expect(signInFailure(new SignInRejectedError(401))).toBe(
      "The saved password no longer works. Log in with your email and password.",
    );
    const refused = new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
    });
    expect(signInFailure(refused)).toBe(
      "Linger on this computer is not responding.",
    );
    expect(
      signInFailure(
        new DOMException("The operation timed out", "TimeoutError"),
      ),
    ).toBe("Linger on this computer is not responding.");
    expect(signInFailure(new DOMException("aborted", "AbortError"))).toBe(
      "Linger on this computer is not responding.",
    );
    expect(signInFailure(new LocalServerUnverifiedError("wrong proof"))).toBe(
      "Linger on this computer is not responding.",
    );
    // A message that merely mentions 401 is not a rejected password.
    expect(signInFailure(new Error("Signing in to Linger failed (401)"))).toBe(
      "Signing in to Linger failed (401)",
    );
    expect(signInFailure(new SignInRejectedError(500))).toBe(
      "Signing in to Linger failed (500)",
    );
  });
});

describe("parseSetCookie", () => {
  it("ignores a header without a name", () => {
    expect(parseSetCookie("=x")).toBeUndefined();
    expect(parseSetCookie("a=b=c; Secure")).toMatchObject({
      name: "a",
      value: "b=c",
      secure: true,
    });
  });
});

describe("anotherMeMissing", () => {
  const online = {
    computer_id: "cmp_1",
    status: "online",
    workspace_grants: [{ mode: "workspace-write" }],
  };

  it("says how long it waited and what the server needs", () => {
    const [waited] = anotherMeMissing(undefined, 300_000).split("\n");
    expect(waited).toBe(
      "Your Another Me was not created after 5 minutes. The server creates it once this computer is connected with a signed-in AI runtime (Codex, Claude Code or Pi).",
    );
  });

  it.each([
    [null, "could not read this computer's status"],
    [undefined, "does not list this computer"],
    [{ ...online, status: "offline" }, "computer-daemon.log"],
    [{ ...online, upgrade_required: true }, "Update Linger"],
    [{ ...online, workspace_grants: [{ mode: "read-only" }] }, "no folder"],
    [
      {
        ...online,
        runtimes: [{ type: "codex", status: "ready", models: [{}] }],
      },
      "another_me.create_failed",
    ],
    [
      { ...online, runtimes: [{ type: "pi", status: "ready", models: [] }] },
      "Pi: signed in but reports no models",
    ],
    [
      {
        ...online,
        runtimes: [
          { type: "codex", status: "error", message: "node.exe not found" },
        ],
      },
      "Codex: check failed (node.exe not found)",
    ],
    [{ ...online, runtimes: [] }, "codex login"],
  ])("names the reason for %j", (computer, reason) => {
    expect(anotherMeMissing(computer, 60_000).split("\n")[1]).toContain(reason);
  });

  it.each([
    [
      { reason: "no_online_computer", computer_id: "cmp_1" },
      "computer-daemon.log",
    ],
    [
      { reason: "computer_upgrade_required", computer_id: "cmp_1" },
      "Update Linger",
    ],
    [
      { reason: "no_writable_workspace_grant", computer_id: "cmp_1" },
      "no folder",
    ],
    [
      {
        reason: "no_ready_runtime_with_models",
        computer_id: "cmp_win_1",
        runtimes: [
          {
            type: "codex",
            status: "authentication_required",
            model_count: 0,
            message: "Sign in required",
          },
          { type: "pi", status: "ready", model_count: 0 },
        ],
      },
      "Codex: not signed in (Sign in required); Pi: signed in but reports no models",
    ],
    [
      {
        reason: "create_failed",
        computer_id: "cmp_1",
      },
      "another_me.create_failed",
    ],
  ])("prefers server placement_blocker for %j", (blocker, reason) => {
    expect(anotherMeMissing(null, 60_000, blocker).split("\n")[1]).toContain(
      reason,
    );
  });

  it("includes default workspace grant failure details when no writable grant exists", () => {
    const [, detail] = anotherMeMissing(
      undefined,
      60_000,
      { reason: "no_writable_workspace_grant", computer_id: "cmp_1" },
      { directory: "C:\\Users\\alice\\Linger", error: "EPERM: access denied" },
    ).split("\n");
    expect(detail).toContain("C:\\Users\\alice\\Linger");
    expect(detail).toContain("EPERM: access denied");
  });
});

describe("LocalServerModule on Windows", () => {
  const locked = () =>
    Object.assign(new Error("EPERM: operation not permitted, rename"), {
      code: "EPERM",
    });
  // Windows' Node runtime is node.exe at the top of its folder.
  const windowsNode = (home: string) =>
    fixtureNode(
      path.join(
        home,
        "desktop",
        "node",
        `v${NODE_RUNTIME_VERSION}`,
        "node.exe",
      ),
    );

  it("waits out files held right after unpacking the source", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    const moves: string[] = [];
    const f = fixture(
      {
        platform: "win32",
        checkPrivateLocation: async () => {},
        sourceArchive: { file, sha256: archive.sha256 },
        rename: async (from, to) => {
          moves.push(path.basename(to));
          if (moves.length <= 2) throw locked();
          await rename(from, to);
        },
      },
      {},
      windowsNode,
    );
    await f.host.start();
    await f.module.begin();
    const hash = archive.sha256.slice(0, 16);
    expect(moves).toEqual([hash, hash, hash]);
    expect(readdirSync(path.join(f.home, "desktop", "source"))).toEqual([hash]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("replaces a half-done source folder and unpacks under a non-ASCII folder", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    const f = fixture({ sourceArchive: { file, sha256: archive.sha256 } });
    await f.host.start();
    const picked = path.join(f.root, "\u65b0\u5efa\u6587\u4ef6\u5939");
    mkdirSync(picked);
    await f.module.chooseLocation(picked);
    expect(f.module.status().location).toEqual({
      path: picked,
      custom: true,
      freeBytes: expect.any(Number),
      minFreeBytes: 1,
    });
    const hash = archive.sha256.slice(0, 16);
    const source = path.join(picked, "desktop", "source");
    // A run that stopped half-way left the folder without its marker.
    mkdirSync(path.join(source, hash), { recursive: true });
    writeFileSync(path.join(source, hash, "half"), "");
    await f.module.begin();
    expect(readdirSync(path.join(source, hash)).sort()).toEqual([
      "package.json",
      "scripts",
    ]);
    expect(f.module.status().phase).toBe("ready");
    await f.host.stop("quit");
  });

  it("reports a move that fails for good and leaves nothing half-done", async () => {
    const archive = sourceArchive(tempDirectory());
    const file = path.join(tempDirectory(), "linger.tar.gz");
    writeFileSync(file, archive.bytes);
    let moves = 0;
    const f = fixture(
      {
        platform: "win32",
        checkPrivateLocation: async () => {},
        sourceArchive: { file, sha256: archive.sha256 },
        rename: async () => {
          moves++;
          throw Object.assign(new Error("EXDEV: cross-device link"), {
            code: "EXDEV",
          });
        },
      },
      {},
      windowsNode,
    );
    await f.host.start();
    await expect(f.module.begin()).rejects.toThrow("EXDEV: cross-device link");
    expect(moves).toBe(1);
    expect(f.module.status()).toMatchObject({ phase: "failed" });
    expect(readdirSync(path.join(f.home, "desktop", "source"))).toEqual([]);
    await f.host.stop("quit");
  });
});

describe("LocalServerModule owner account", () => {
  // The installer tests verify the actual Windows ACL policy. Here the
  // account reader still uses a real file, and we control the ACL decision.
  let acl: MockInstance<typeof windowsPrivate.windowsPrivatePath> | undefined;
  beforeEach(() => {
    if (process.platform === "win32")
      acl = vi
        .spyOn(windowsPrivate, "windowsPrivatePath")
        .mockResolvedValue(undefined);
  });
  afterEach(() => acl?.mockRestore());

  const ORIGIN = "http://localhost:3000";
  const enrolled = { serverUrl: ORIGIN, computerId: "cmp_1" };
  const installed =
    (account?: Record<string, unknown>, mode = 0o600) =>
    (home: string) => {
      mkdirSync(path.join(home, "desktop"), { recursive: true });
      writeFileSync(
        path.join(home, "desktop", "local-server.json"),
        JSON.stringify({ home, repo: "/source", origin: ORIGIN }),
      );
      if (!account) return;
      const directory = path.join(home, "instances", LOCAL_INSTANCE);
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, "local-account.json");
      writeFileSync(file, JSON.stringify(account));
      chmodSync(file, mode);
    };
  const OWNER = {
    email: "owner@linger.local",
    password: "a-private-password",
    provisioned: true,
  };

  it("signs the window in to the installed server with the account file", async () => {
    const f = fixture({}, enrolled, installed(OWNER));
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(await f.module.servesWindow()).toBe(true);
    expect(await f.module.account()).toEqual({
      email: OWNER.email,
      password: OWNER.password,
      file: path.join(
        f.home,
        "instances",
        LOCAL_INSTANCE,
        "local-account.json",
      ),
    });
    await f.module.signInWithAccount();
    expect(f.signIn).toHaveBeenCalledWith(
      server(ORIGIN),
      OWNER.email,
      OWNER.password,
    );
    await f.host.stop("quit");
  });

  it("does not offer the account while the services are not running", async () => {
    const f = fixture({}, enrolled, (home) => {
      installed(OWNER)(home);
      writeFileSync(path.join(home, "resume-fails"), "");
    });
    // Not started yet: nothing is serving the window.
    expect(await f.module.servesWindow()).toBe(false);
    await f.host.start();
    await waitForInstaller(() =>
      expect(f.module.status().phase).toBe("failed"),
    );
    expect(await f.module.servesWindow()).toBe(false);
    await expect(f.module.signInWithAccount()).rejects.toThrow(
      "This window is not showing the Linger on this computer.",
    );
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it.each([
    [
      new SignInRejectedError(401),
      "The saved password no longer works. Log in with your email and password.",
    ],
    [
      new TypeError("fetch failed"),
      "Linger on this computer is not responding.",
    ],
    [
      new LocalServerUnverifiedError("wrong proof"),
      "Linger on this computer is not responding.",
    ],
  ])("says what to do when signing in fails (%s)", async (error, message) => {
    const f = fixture({}, enrolled, installed(OWNER));
    f.signIn.mockRejectedValueOnce(error);
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    await expect(f.module.signInWithAccount()).rejects.toThrow(message);
    await f.host.stop("quit");
  });

  it("offers the account only while the server proves it is this installation's", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const f = fixture({}, enrolled, installed(OWNER));
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      expect(await f.module.servesWindow()).toBe(true);
      expect(f.proveServer).toHaveBeenLastCalledWith(server(ORIGIN));
      // The services stopped, or another program took the port.
      f.proveServer.mockRejectedValue(
        new LocalServerUnverifiedError("no answer"),
      );
      // One check serves the pages for two seconds.
      expect(await f.module.servesWindow()).toBe(true);
      now += 2_000;
      expect(await f.module.servesWindow()).toBe(false);
      expect(await f.module.servesWindow()).toBe(false);
      expect(f.proveServer).toHaveBeenCalledTimes(2);
      // The services are back.
      f.proveServer.mockResolvedValue(undefined);
      now += 2_000;
      expect(await f.module.servesWindow()).toBe(true);
      await f.host.stop("quit");
    } finally {
      clock.mockRestore();
    }
  });

  it("neither offers nor sends the account without the server's identity", async () => {
    const f = fixture(
      {
        serverIdentity: async () => {
          throw new Error(
            "Linger on this computer has no server identity yet.",
          );
        },
      },
      enrolled,
      installed(OWNER),
    );
    await f.host.start();
    await waitForInstaller(() => expect(f.module.status().phase).toBe("ready"));
    expect(await f.module.servesWindow()).toBe(false);
    await expect(f.module.signInWithAccount()).rejects.toThrow(
      "Linger on this computer is not responding.",
    );
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("does not offer the account to another server", async () => {
    const f = fixture(
      {},
      { serverUrl: "https://team.example.com" },
      installed(OWNER),
    );
    await f.host.start();
    expect(await f.module.servesWindow()).toBe(false);
    await expect(f.module.signInWithAccount()).rejects.toThrow(
      "This window is not showing the Linger on this computer.",
    );
    expect(f.signIn).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("does not offer it before Linger is installed here", async () => {
    const f = fixture({}, enrolled);
    await f.host.start();
    expect(await f.module.servesWindow()).toBe(false);
    await expect(f.module.account()).rejects.toThrow(
      "Linger is not installed on this computer.",
    );
    await f.host.stop("quit");
  });

  it.each([
    [
      "missing",
      installed(),
      /^The account file of Linger on this computer is missing \(.*local-account\.json\)\.$/,
    ],
    [
      "not provisioned",
      installed({ ...OWNER, provisioned: false }),
      "The local account file is invalid or the account has not been created.",
    ],
  ])(
    "says why a %s account file cannot sign in",
    async (_case, prepare, message) => {
      const f = fixture({}, enrolled, prepare);
      await f.host.start();
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      const failure = f.module.signInWithAccount();
      await expect(failure).rejects.toThrow(message);
      await expect(failure).rejects.not.toThrow(OWNER.password);
      expect(f.signIn).not.toHaveBeenCalled();
      await f.host.stop("quit");
    },
  );

  it("rejects an account file readable by others", async () => {
    const message =
      process.platform === "win32"
        ? "Windows private path validation failed: the account file is shared with other accounts."
        : "The local account file must be private and owned by the current user (chmod 600).";
    acl?.mockRejectedValueOnce(new Error(message));
    const f = fixture({}, enrolled, installed(OWNER, 0o644));
    await f.host.start();
    try {
      await waitForInstaller(() =>
        expect(f.module.status().phase).toBe("ready"),
      );
      const failure = f.module.signInWithAccount();
      await expect(failure).rejects.toThrow(message);
      await expect(failure).rejects.not.toThrow(OWNER.password);
      expect(f.signIn).not.toHaveBeenCalled();
    } finally {
      await f.host.stop("quit");
    }
  });
});

describe("legacyMigrationResult", () => {
  const skipped = [
    { instance: "default", reason: "Its Computer is running 2 task(s)." },
  ];

  it("only logs instances this app does not use", () => {
    expect(
      legacyMigrationResult(
        { code: 0, output: `${JSON.stringify({ skipped })}\n`, error: "" },
        LOCAL_INSTANCE,
      ),
    ).toEqual({ skipped });
  });

  it("fails with the reason when this app's instance stayed unconverted", () => {
    const own = [
      {
        instance: LOCAL_INSTANCE,
        reason: "Another Linger installer is using it.",
      },
    ];
    expect(
      legacyMigrationResult(
        { code: 0, output: JSON.stringify({ skipped: own }), error: "" },
        LOCAL_INSTANCE,
      ),
    ).toEqual({
      skipped: own,
      failure:
        "Linger could not convert this computer's installation from the earlier Simplex app. Another Linger installer is using it.",
    });
  });

  it("shows every line of an installer that could not start", () => {
    expect(
      legacyMigrationResult(
        { code: 1, output: "", error: "Installer could not start: a\nb: c\n" },
        LOCAL_INSTANCE,
      ),
    ).toEqual({ skipped: [], failure: "Installer could not start: a\nb: c" });
    expect(
      legacyMigrationResult({ code: 0, output: "", error: "" }, LOCAL_INSTANCE),
    ).toEqual({ skipped: [] });
  });
});

it("allows a slow installer runtime lookup and keeps the login deadline", async () => {
  // Native AbortSignal.timeout uses a timer outside Vitest's fake clock.
  vi.useFakeTimers();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(
      () => controller.abort(new DOMException("timed out", "TimeoutError")),
      ms,
    );
    return controller.signal;
  });
  try {
    const runtime = { setupChoice: "pi", environment: {} };
    const signals = new Map<string, AbortSignal>();
    let responseMs = 125_000;
    const api = await InstallerApi.open(
      "http://127.0.0.1:9/#token=abc",
      (input, options) => {
        const pathname = new URL(String(input)).pathname;
        if (pathname === "/api/session")
          return Promise.resolve(
            new Response("{}", {
              headers: {
                "set-cookie": "linger_installer_session=s1; Path=/api",
              },
            }),
          );
        const signal = options!.signal!;
        signals.set(pathname, signal);
        return new Promise((resolve, reject) => {
          const reply = setTimeout(
            () => resolve(Response.json(runtime)),
            responseMs,
          );
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(reply);
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      1,
    );
    const controller = new AbortController();
    const requests = Promise.allSettled([
      api.runtime(controller.signal),
      api.login(),
    ]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(signals.get(`/api/instances/${LOCAL_INSTANCE}/login`)?.aborted).toBe(
      false,
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(signals.get(`/api/instances/${LOCAL_INSTANCE}/login`)?.aborted).toBe(
      true,
    );
    expect(
      signals.get(`/api/instances/${LOCAL_INSTANCE}/runtime`)?.aborted,
    ).toBe(false);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(await requests).toEqual([
      { status: "fulfilled", value: runtime },
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "TimeoutError" }),
      },
    ]);

    const cancelled = api
      .runtime(controller.signal)
      .catch((error: unknown) => error);
    controller.abort(new Error("Desktop stopped"));
    expect(await cancelled).toBe(controller.signal.reason);

    // A lookup that keeps running is waited for, well past the 180 s the
    // desktop once allowed it.
    responseMs = 9 * 60_000;
    const slow = api.runtime(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    await expect(slow).resolves.toEqual(runtime);

    responseMs = RUNTIME_LOOKUP_LIMIT_MS + 1;
    const overdue = api
      .runtime(new AbortController().signal)
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(RUNTIME_LOOKUP_LIMIT_MS);
    expect(await overdue).toMatchObject({
      code: "runtime_lookup_timed_out",
      message:
        "Checking the AI runtime on this computer did not finish in time.",
    });
  } finally {
    timeout.mockRestore();
    vi.useRealTimers();
  }
});

describe("InstallerApi polling", () => {
  const reset = () =>
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket hang up"), {
        code: "ECONNRESET",
      }),
    });
  const job = (fields: Record<string, unknown>) =>
    Response.json({
      id: "job",
      instance: LOCAL_INSTANCE,
      createdAt: "2026-11-03T00:00:00Z",
      stage: "images",
      stages: [{ id: "images", state: "running" }],
      ...fields,
    });
  // An installer whose job polls answer from `polls`, in order; a function
  // entry throws, and the last entry repeats.
  const installer = (polls: (Record<string, unknown> | (() => never))[]) => {
    const created: unknown[] = [];
    const posts: string[] = [];
    let reads = 0;
    const fetcher = (async (input: URL, init: RequestInit = {}) => {
      if (init.method === "POST") posts.push(input.pathname);
      if (input.pathname === "/api/session")
        return new Response("{}", {
          headers: { "set-cookie": "linger_installer_session=s1; Path=/api" },
        });
      if (input.pathname === "/api/jobs" && init.method === "POST") {
        created.push(JSON.parse(String(init.body)));
        return job({ state: "queued" });
      }
      if (input.pathname === "/api/jobs") return Response.json({ items: [] });
      if (input.pathname === "/api/jobs/job") {
        const next = polls[Math.min(reads++, polls.length - 1)]!;
        return typeof next === "function" ? next() : job(next);
      }
      return Response.json({}, { status: 404 });
    }) as unknown as typeof fetch;
    return { fetcher, created, posts, reads: () => reads };
  };
  const warnings: Record<string, unknown>[] = [];
  const log = {
    info: () => {},
    warn: (_: string, fields?: Record<string, unknown>) =>
      warnings.push(fields!),
    error: () => {},
  };
  const open = (fetcher: typeof fetch, windowMs = 60_000) =>
    InstallerApi.open("http://127.0.0.1:9/#token=abc", fetcher, 1, log, {
      windowMs,
      maxBackoffMs: 5,
    });
  const plan = { runtime: "codex" } as Parameters<InstallerApi["run"]>[0];

  it("reconnects after a dropped connection and follows the same job", async () => {
    warnings.length = 0;
    const fake = installer([
      () => {
        throw reset();
      },
      { state: "succeeded", origin: "http://localhost:3000" },
    ]);
    const messages: string[] = [];
    const result = await (
      await open(fake.fetcher)
    ).run(plan, new AbortController().signal, (_s, _p, message) =>
      messages.push(message),
    );
    expect(result.origin).toBe("http://localhost:3000");
    expect(fake.created).toHaveLength(1);
    expect(fake.posts).toEqual(["/api/session", "/api/jobs"]);
    expect(messages).toContain("Reconnecting to the installer…");
    expect(warnings).toEqual([
      { stage: "poll_job", job_id: "job", code: "ECONNRESET", attempt: 1 },
    ]);
  });

  it("asks for the runtime again after a dropped connection or fetch's own wait", async () => {
    warnings.length = 0;
    const runtime = { setupChoice: "pi", environment: {} };
    const failures = [
      reset(),
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("Headers Timeout Error"), {
          code: "UND_ERR_HEADERS_TIMEOUT",
        }),
      }),
    ];
    let asked = 0;
    const fetcher = (async (input: URL) => {
      if (input.pathname === "/api/session")
        return new Response("{}", {
          headers: { "set-cookie": "linger_installer_session=s1; Path=/api" },
        });
      asked++;
      const failure = failures.shift();
      if (failure) throw failure;
      return Response.json(runtime);
    }) as unknown as typeof fetch;
    await expect(
      (await open(fetcher)).runtime(new AbortController().signal),
    ).resolves.toEqual(runtime);
    expect(asked).toBe(3);
    expect(warnings).toEqual([
      { stage: "runtime", code: "ECONNRESET", attempt: 1 },
      { stage: "runtime", code: "UND_ERR_HEADERS_TIMEOUT", attempt: 2 },
    ]);
  });

  it("names a runtime lookup the installer stopped answering", async () => {
    const fetcher = (async (input: URL) => {
      if (input.pathname === "/api/session")
        return new Response("{}", {
          headers: { "set-cookie": "linger_installer_session=s1; Path=/api" },
        });
      throw reset();
    }) as unknown as typeof fetch;
    await expect(
      (await open(fetcher, 30)).runtime(new AbortController().signal),
    ).rejects.toMatchObject({ code: "runtime_lookup_unreachable" });
  });

  it("gives up once the installer stays unreachable", async () => {
    const fake = installer([
      () => {
        throw reset();
      },
    ]);
    await expect(
      (await open(fake.fetcher, 30)).run(
        plan,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow(
      "Couldn't read the installation progress. Try again to reconnect to the running installation.",
    );
    expect(fake.created).toHaveLength(1);
  });

  it("reports a failed job as before", async () => {
    const fake = installer([{ state: "failed", message: "Images broke" }]);
    await expect(
      (await open(fake.fetcher)).run(
        plan,
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toThrow("Images broke");
  });

  it("stops reconnecting when the caller aborts", async () => {
    const controller = new AbortController();
    const fake = installer([
      () => {
        controller.abort();
        throw reset();
      },
    ]);
    await expect(
      (await open(fake.fetcher)).run(plan, controller.signal, () => {}),
    ).rejects.toThrow();
    expect(fake.reads()).toBe(1);
  });
});

describe("pollDelayMs", () => {
  it("uses fast polling for the first 10s then relaxes to basePollMs without exceeding basePollMs", () => {
    const start = 10_000;
    expect(FAST_POLL_MS).toBe(200);
    expect(FAST_POLL_WINDOW_MS).toBe(10_000);
    expect(pollDelayMs(start, 1_000, start)).toBe(200);
    expect(pollDelayMs(start, 1_000, start + 9_999)).toBe(200);
    expect(pollDelayMs(start, 1_000, start + 10_000)).toBe(1_000);
    expect(pollDelayMs(start, 1_000, start + 30_000)).toBe(1_000);
    expect(pollDelayMs(start, 10, start)).toBe(10);
    expect(pollDelayMs(start, 10, start + 15_000)).toBe(10);
  });
});

describe("LocalServerModule background pre-staging, Bifrost pre-fetch, and early prewarm", () => {
  const readPrefetchEvents = (root: string) => {
    const file = path.join(root, "prefetch-events.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            home: string;
            event: string;
            args?: string[];
            runAsNode?: string;
          },
      );
  };

  // Sets up a bundled local source archive plus a directory-layout offline
  // native runtime and bundled TeamHub binary for pre-staging tests.
  const setupBundledArchiveFixture = (
    platform: NodeJS.Platform = "darwin",
    arch = "arm64",
    api = installerApi(),
  ) => {
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const sha256 = (data: string | Buffer) =>
      createHash("sha256").update(data).digest("hex");
    const target = `${platform}-${arch}`;
    const f = fixture(
      {
        platform,
        arch,
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
      },
      {},
      (home) => {
        const installer = path.join(path.dirname(home), "installer");
        mkdirSync(path.join(installer, "source"), { recursive: true });
        writeFileSync(
          path.join(installer, "source", "linger.tar.gz"),
          archive.bytes,
        );
        const bundle = path.join(installer, "native", `runtime-${target}`);
        mkdirSync(path.join(bundle, "runtime", "web"), { recursive: true });
        const files = JSON.stringify({
          target,
          sourceCommit: "a".repeat(40),
          sourceArchiveSha256: archive.sha256,
          files: {},
        });
        writeFileSync(path.join(bundle, "runtime", "files.json"), files);
        writeFileSync(
          path.join(bundle, "runtime", "web", "static-host.mjs"),
          "",
        );
        writeFileSync(
          path.join(bundle, "manifest.json"),
          JSON.stringify({
            target,
            sourceCommit: "a".repeat(40),
            sourceArchiveSha256: archive.sha256,
            layout: "directory",
            directory: { file: "runtime/files.json", sha256: sha256(files) },
          }),
        );
        const teamhubDir = path.join(installer, "native", `teamhub-${target}`);
        mkdirSync(teamhubDir, { recursive: true });
        const ext = platform === "win32" ? ".exe" : "";
        const binaries: Record<
          string,
          { file: string; sha256: string; bytes: number }
        > = {};
        for (const cmd of ["teamhub", "migrate", "account"]) {
          const file = `${cmd}${ext}`;
          const binBytes = Buffer.from(`#!/bin/sh\n# ${cmd}\n`);
          writeFileSync(path.join(teamhubDir, file), binBytes, {
            mode: 0o755,
          });
          binaries[cmd] = {
            file,
            sha256: sha256(binBytes),
            bytes: binBytes.length,
          };
        }
        writeFileSync(
          path.join(teamhubDir, "manifest.json"),
          JSON.stringify({
            target,
            sourceCommit: "a".repeat(40),
            sourceArchiveSha256: archive.sha256,
            goVersion: "1.24.0",
            binaries,
          }),
        );
      },
      api,
      root,
    );
    return { ...f, archive };
  };

  it("silently pre-stages bundled source and native runtime during inspect() and joins on begin() with granular timings", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = setupBundledArchiveFixture("linux", "x64");
    const phases: string[] = [];
    const progresses: number[] = [];
    f.bus.on("local-server.changed", () => {
      const s = f.module.status();
      phases.push(s.phase);
      progresses.push(s.progress);
    });
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(info).toHaveBeenCalledWith(
          "local_server.prestage",
          expect.objectContaining({ status: "completed" }),
        ),
      );
      // Silent pre-staging must never mutate phase/progress or emit installing.
      expect(f.module.status().phase).toBe("idle");
      expect(f.module.status().progress).toBe(0);
      expect(phases).not.toContain("installing");
      expect(progresses.every((p) => p === 0)).toBe(true);

      const stagedRepo = path.join(
        f.home,
        "desktop",
        "source",
        f.archive.sha256.slice(0, 16),
      );
      expect(
        existsSync(path.join(stagedRepo, "scripts/source-native.mjs")),
      ).toBe(true);
      expect(
        existsSync(
          path.join(stagedRepo, ".simplexai-runtime/offline/files.json"),
        ),
      ).toBe(true);
      expect(
        existsSync(
          path.join(stagedRepo, ".simplexai-runtime/prebuilt/teamhub"),
        ),
      ).toBe(true);

      // Granular timings were logged with prestage: true.
      const timingCalls = () =>
        info.mock.calls
          .filter(([event]) => event === "local_server.timing")
          .map(([, fields]) => fields as Record<string, unknown>);
      const prestageSteps = timingCalls()
        .filter((fields) => fields.prestage === true)
        .map((fields) => fields.step);
      expect(prestageSteps).toEqual(
        expect.arrayContaining([
          "teamhub_binaries",
          "native_runtime",
          "native_runtime_cp",
          "native_runtime_verify",
          "native_runtime_xattr",
          "native_runtime_publish",
          "native_runtime_mark_verified",
        ]),
      );

      // Subsequent begin() joins the completed pre-stage without duplicating
      // native_runtime copy/unpack steps.
      const cpCountBefore = timingCalls().filter(
        (fields) => fields.step === "native_runtime_cp",
      ).length;
      expect(cpCountBefore).toBe(1);

      await f.module.begin();
      expect(f.module.status().phase).toBe("ready");
      expect(info).toHaveBeenCalledWith(
        "local_server.prestage",
        expect.objectContaining({ status: "joined" }),
      );
      const cpCountAfter = timingCalls().filter(
        (fields) => fields.step === "native_runtime_cp",
      ).length;
      expect(cpCountAfter).toBe(1);
    } finally {
      info.mockRestore();
      await f.host.stop("quit");
    }
  });

  it("does not pre-stage remote URL sourceArchive or developer checkout during inspect()", async () => {
    const info = vi.spyOn(silentLog, "info");
    const fetchMock = vi.fn(async () => {
      throw new Error("remote archive must not be fetched during inspect");
    }) as unknown as typeof fetch;
    const remote = fixture({
      sourceArchive: {
        url: "https://downloads.example/linger.tar.gz",
        sha256: "a".repeat(64),
      },
      fetch: fetchMock,
    });
    const dev = fixture(withCheckout, {}, checkout);
    await remote.host.start();
    await dev.host.start();
    try {
      remote.module.inspect();
      dev.module.inspect();
      await waitForInstaller(() =>
        expect(remote.module.status().localModels.state).toBe("checked"),
      );
      await waitForInstaller(() =>
        expect(dev.module.status().localModels.state).toBe("checked"),
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(existsSync(path.join(remote.home, "desktop", "source"))).toBe(
        false,
      );
      expect(info).not.toHaveBeenCalledWith(
        "local_server.prestage",
        expect.anything(),
      );
    } finally {
      info.mockRestore();
      await remote.host.stop("quit");
      await dev.host.stop("quit");
    }
  });

  it("aborts in-flight pre-staging and Bifrost pre-fetch on cancelPrestage() and chooseLocation() without leaving .partial directories", async () => {
    const info = vi.spyOn(silentLog, "info");
    // 1. Abort in-flight pre-stage via cancelPrestage() while rename is paused,
    //    verifying .partial is cleaned up and final directory is not published.
    let releaseRename!: () => void;
    let renameEntered!: () => void;
    const renameReady = new Promise<void>((resolve) => {
      renameEntered = resolve;
    });
    const f = setupBundledArchiveFixture("linux", "x64");
    const blocked = new LocalServerModule({
      home: f.home,
      version: APP_VERSION,
      installerDirectory: path.join(f.root, "installer"),
      platform: "linux",
      arch: "x64",
      pollMs: 10,
      freeBytes: 1,
      sourceArchive: {
        file: "source/linger.tar.gz",
        sha256: f.archive.sha256,
      },
      signIn: f.signIn,
      rename: async (from, to) => {
        renameEntered();
        await new Promise<void>((resolve) => {
          releaseRename = resolve;
        });
        await rename(from, to);
      },
    });
    const bus = new EventBus();
    const host = testHost(
      [
        {
          ...stubModule("WindowManager"),
          setServer: vi.fn(() => true),
          prewarmAssets: vi.fn(async () => {}),
          preloadAuthenticated: vi.fn(),
        } as never,
        {
          ...stubModule("Enrollment"),
          enroll: vi.fn(async () => {}),
          unenroll: vi.fn(async () => {}),
          syncLocalGatewayUrl: vi.fn(() => false),
        } as never,
        blocked,
      ],
      {},
      bus,
    );
    writeFileSync(path.join(f.root, "prefetch-track"), "");
    writeFileSync(path.join(f.root, "prefetch-hang"), "");
    await host.start();
    try {
      blocked.inspect();
      await renameReady;
      // Wait for inspect to finish and spawn the hanging Bifrost pre-fetch.
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(f.root).some((e) => e.event === "started"),
        ).toBe(true),
      );
      blocked.cancelPrestage();
      releaseRename();
      await waitForInstaller(() =>
        expect(info).toHaveBeenCalledWith(
          "local_server.prestage",
          expect.objectContaining({ status: "aborted" }),
        ),
      );
      await waitForInstaller(() =>
        expect(info).toHaveBeenCalledWith(
          "local_server.bifrost_prefetch",
          expect.objectContaining({ status: "aborted" }),
        ),
      );
      const sourceRoot = path.join(f.home, "desktop", "source");
      const entries = existsSync(sourceRoot) ? readdirSync(sourceRoot) : [];
      expect(entries.some((entry) => entry.endsWith(".partial"))).toBe(false);
      // Because cancelPrestage() aborted before teamhub/native_runtime ran,
      // the offline runtime directory was never published either.
      const stagedRepo = path.join(sourceRoot, f.archive.sha256.slice(0, 16));
      expect(
        existsSync(path.join(stagedRepo, ".simplexai-runtime/offline")),
      ).toBe(false);
      expect(
        existsSync(path.join(stagedRepo, ".simplexai-runtime/offline.partial")),
      ).toBe(false);
    } finally {
      await host.stop("quit");
    }

    // 2. Switching location via chooseLocation() also cancels Bifrost pre-fetch
    //    for the old home and leaves the new candidate untouched.
    const f2 = fixture(withCheckout, {}, checkout);
    writeFileSync(path.join(f2.root, "prefetch-track"), "");
    writeFileSync(path.join(f2.root, "prefetch-hang"), "");
    const picked = path.join(f2.root, "other-home");
    await f2.host.start();
    try {
      f2.module.inspect();
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(f2.root).some((e) => e.event === "started"),
        ).toBe(true),
      );
      await f2.module.chooseLocation(picked);
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(f2.root).some(
            (e) => e.event === "sigterm" || e.event === "stdin_end",
          ),
        ).toBe(true),
      );
      expect(existsSync(picked)).toBe(false);
    } finally {
      info.mockRestore();
      await f2.host.stop("quit");
    }
  });

  it("fires Bifrost pre-fetch on inspect(), checkByok(), and listByokModels() without blocking, and hands off cleanly before installer_job across platforms", async () => {
    const info = vi.spyOn(silentLog, "info");
    // 1. checkByok() and listByokModels() fire pre-fetch without blocking even
    //    when --prefetch-bifrost hangs, and begin() stops and awaits its exit
    //    BEFORE starting installer_job so localmodels' archive lock is released.
    let sawExitedBeforeJobCreate = false;
    const byokApi = installerApi();
    const origHandle = byokApi.handle;
    let fByokRoot = "";
    byokApi.handle = async (url, init) => {
      if (url.pathname === "/api/jobs" && init?.method === "POST") {
        sawExitedBeforeJobCreate = readPrefetchEvents(fByokRoot).some(
          (e) => e.event === "sigterm" || e.event === "stdin_end",
        );
      }
      return origHandle(url, init);
    };
    const fByok = fixture(withCheckout, {}, checkout, byokApi);
    fByokRoot = fByok.root;
    writeFileSync(path.join(fByok.root, "prefetch-track"), "");
    writeFileSync(path.join(fByok.root, "prefetch-hang"), "");
    writeFileSync(path.join(fByok.root, "prefetch-exit-delay"), "");
    await fByok.host.start();
    try {
      await fByok.module.checkByok({
        runtime: "codex",
        baseUrl: "https://byok.example",
        path: "/v1",
        endpoint: "/responses",
        apiKey: "k",
        modelId: "m",
        protocol: "openai-responses",
      });
      expect(fByok.module.status().byokCheck?.state).toBe("ready");
      await fByok.module.listByokModels({
        baseUrl: "https://byok.example",
        path: "/v1",
        endpoint: "/responses",
        protocol: "openai-responses",
      });
      expect(fByok.module.status().byokModels?.state).toBe("ready");
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(fByok.root).filter((e) => e.event === "started"),
        ).toHaveLength(1),
      );
      expect(readPrefetchEvents(fByok.root)[0]?.args).toContain(
        "--abort-on-stdin-close",
      );

      await fByok.module.begin({
        runtime: "codex",
        byok: {
          runtime: "codex",
          baseUrl: "https://byok.example",
          path: "/v1",
          endpoint: "/responses",
          apiKey: "k",
          modelId: "m",
          protocol: "openai-responses",
        },
      });
      expect(sawExitedBeforeJobCreate).toBe(true);
    } finally {
      await fByok.host.stop("quit");
    }

    // 2. Pure subscription install (claude/codex) aborts in-flight Bifrost pre-fetch.
    const fSub = fixture(withCheckout, {}, checkout);
    writeFileSync(path.join(fSub.root, "prefetch-track"), "");
    writeFileSync(path.join(fSub.root, "prefetch-hang"), "");
    await fSub.host.start();
    try {
      fSub.module.inspect();
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(fSub.root).some((e) => e.event === "started"),
        ).toBe(true),
      );
      await fSub.module.begin({ runtime: "claude" });
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(fSub.root).some(
            (e) => e.event === "sigterm" || e.event === "stdin_end",
          ),
        ).toBe(true),
      );
    } finally {
      await fSub.host.stop("quit");
    }

    // 3. On Windows (no SIGTERM sent), closing stdin cleanly terminates the
    //    pre-fetch child via --abort-on-stdin-close before installer_job starts.
    let winExitedBeforeJobCreate = false;
    const winApi = installerApi();
    const origWinHandle = winApi.handle;
    let fWinRoot = "";
    winApi.handle = async (url, init) => {
      if (url.pathname === "/api/jobs" && init?.method === "POST") {
        winExitedBeforeJobCreate = readPrefetchEvents(fWinRoot).some(
          (e) => e.event === "stdin_end",
        );
      }
      return origWinHandle(url, init);
    };
    const fWin = fixture(
      (home) => ({
        ...withCheckout(home),
        platform: "win32",
        arch: "x64",
        checkPrivateLocation: async () => {},
      }),
      {},
      (home) => {
        checkout(home);
        writeFileSync(
          path.join(path.dirname(home), "installer", "distribution.json"),
          JSON.stringify({
            platform: "win32",
            arch: "x64",
            nativeSources: [{ target: "win32-x64" }],
          }),
        );
        const nodeDir = path.join(
          home,
          "desktop",
          "node",
          `v${NODE_RUNTIME_VERSION}`,
        );
        fixtureNode(path.join(nodeDir, "node.exe"));
      },
      winApi,
    );
    fWinRoot = fWin.root;
    writeFileSync(path.join(fWin.root, "prefetch-track"), "");
    writeFileSync(path.join(fWin.root, "prefetch-hang"), "");
    await fWin.host.start();
    try {
      fWin.module.inspect();
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(fWin.root).some((e) => e.event === "started"),
        ).toBe(true),
      );
      await fWin.module.begin({ runtime: "local" });
      expect(winExitedBeforeJobCreate).toBe(true);
      expect(
        readPrefetchEvents(fWin.root).some((e) => e.event === "sigterm"),
      ).toBe(false);
    } finally {
      info.mockRestore();
      await fWin.host.stop("quit");
    }
  });

  it("triggers early prewarmAssets once when services succeed without preloading authenticated window before enroll, and overlaps installer_runtime with sign_in_as", async () => {
    const info = vi.spyOn(silentLog, "info");
    let releaseRuntime!: () => void;
    const api = installerApi(
      [],
      {
        state: "succeeded",
        origin: "http://localhost:3000",
        stages: [
          { id: "services", state: "succeeded" },
          { id: "account", state: "succeeded" },
        ],
      },
      Response.json({ recommendation: "claude" }),
      [
        {
          state: "running",
          stage: "account",
          stages: [
            { id: "services", state: "succeeded" },
            { id: "account", state: "running" },
          ],
        },
        {
          state: "running",
          stage: "account",
          stages: [
            { id: "services", state: "succeeded" },
            { id: "account", state: "running" },
          ],
        },
      ],
    );
    api.runtime.lookup = new Promise<void>((resolve) => {
      releaseRuntime = resolve;
    });
    const order: string[] = [];
    const f = fixture(withCheckout, {}, checkout, api);
    f.prewarmAssets.mockImplementation(async () => {
      order.push("prewarmAssets");
    });
    f.signIn.mockImplementation(async () => {
      order.push("signIn");
    });
    f.enroll.mockImplementation(async () => {
      order.push("enroll");
    });
    f.preloadAuthenticated.mockImplementation(() => {
      order.push("preloadAuthenticated");
    });
    await f.host.start();
    try {
      const installing = f.module.begin();
      // Early prewarm fires during polling, and sign_in_as overlaps while
      // installer_runtime is still pending — neither enroll nor
      // preloadAuthenticated has run yet.
      await waitForInstaller(() => expect(api.runtime.asked).toBe(1));
      await waitForInstaller(() => expect(f.signIn).toHaveBeenCalledOnce());
      expect(f.prewarmAssets).toHaveBeenCalledOnce();
      expect(f.prewarmAssets).toHaveBeenCalledWith("http://localhost:3000");
      expect(f.enroll).not.toHaveBeenCalled();
      expect(f.preloadAuthenticated).not.toHaveBeenCalled();

      releaseRuntime();
      await installing;

      expect(f.module.status().phase).toBe("ready");
      // Deduplicated: prewarmAssets was NOT called a second time after job end.
      expect(f.prewarmAssets).toHaveBeenCalledOnce();
      expect(order).toEqual([
        "prewarmAssets",
        "signIn",
        "enroll",
        "preloadAuthenticated",
      ]);
      const timedSteps = info.mock.calls
        .filter(([event]) => event === "local_server.timing")
        .map(([, fields]) => (fields as { step: string }).step);
      expect(timedSteps).toEqual(
        expect.arrayContaining(["installer_runtime", "sign_in_as"]),
      );
    } finally {
      info.mockRestore();
      await f.host.stop("quit");
    }
  });

  it("serializes a new same-home install behind a cancelled pre-stage's cleanup so .partial never races", async () => {
    const info = vi.spyOn(silentLog, "info");
    let releaseFirstRename!: () => void;
    let firstRenameEntered!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstRenameEntered = resolve;
    });
    let renameCalls = 0;
    const api = installerApi();
    const base = setupBundledArchiveFixture("linux", "x64", api);
    const mod = new LocalServerModule({
      home: base.home,
      version: APP_VERSION,
      installerDirectory: path.join(base.root, "installer"),
      platform: "linux",
      arch: "x64",
      pollMs: 10,
      freeBytes: 1,
      sourceArchive: {
        file: "source/linger.tar.gz",
        sha256: base.archive.sha256,
      },
      signIn: base.signIn,
      serverIdentity: async (_h, origin) => ({
        origin,
        teamhub: TEAMHUB,
        key: KEY,
      }),
      proveServer: async () => {},
      fetch: ((input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        return api.handle(url, init);
      }) as typeof fetch,
      rename: async (from, to) => {
        renameCalls += 1;
        if (renameCalls === 1) {
          firstRenameEntered();
          await new Promise<void>((resolve) => {
            releaseFirstRename = resolve;
          });
          // Simulate an interrupted publish so the first task's finally block
          // removes `${directory}.partial` after cancellation.
          throw new Error("interrupted");
        }
        await rename(from, to);
      },
    });
    const bus = new EventBus();
    const host = testHost(
      [
        {
          ...stubModule("WindowManager"),
          setServer: vi.fn(() => true),
          prewarmAssets: vi.fn(async () => {}),
          preloadAuthenticated: vi.fn(),
        } as never,
        {
          ...stubModule("Enrollment"),
          enroll: vi.fn(async () => {}),
          unenroll: vi.fn(async () => {}),
          syncLocalGatewayUrl: vi.fn(() => false),
        } as never,
        mod,
      ],
      {},
      bus,
    );
    await host.start();
    try {
      mod.inspect();
      await firstReady;
      // Cancel pre-staging while its first task still holds `.partial`, then
      // immediately start begin() on the same default home.
      mod.cancelPrestage();
      const installing = mod.begin();
      await delay(60);
      // The foreground install must wait for the cancelled pre-stage to finish
      // cleaning up `.partial` before starting a new extraction/rename.
      expect(renameCalls).toBe(1);

      releaseFirstRename();
      await installing;

      expect(mod.status().phase).toBe("ready");
      expect(renameCalls).toBeGreaterThanOrEqual(2);
      const stagedRepo = path.join(
        base.home,
        "desktop",
        "source",
        base.archive.sha256.slice(0, 16),
      );
      expect(
        existsSync(path.join(stagedRepo, "scripts/source-native.mjs")),
      ).toBe(true);
      expect(existsSync(`${stagedRepo}.partial`)).toBe(false);
    } finally {
      info.mockRestore();
      await host.stop("quit");
    }
  });

  it("checks Windows private-path safety before silently pre-staging and writes nothing on refusal", async () => {
    const warn = vi.spyOn(silentLog, "warn");
    const root = tempDirectory();
    const archive = sourceArchive(root);
    const checkPrivateLocation = vi.fn(async () => {
      throw Object.assign(new Error("unsafe ancestor ACL"), {
        code: "WINDOWS_PRIVATE_PATH_UNSAFE",
        reason: "UNSAFE_PARENT_ACCESS",
      });
    });
    const f = fixture(
      {
        platform: "win32",
        arch: "x64",
        sourceArchive: { file: "source/linger.tar.gz", sha256: archive.sha256 },
        checkPrivateLocation,
      },
      {},
      (home) => {
        const installer = path.join(path.dirname(home), "installer");
        mkdirSync(path.join(installer, "source"), { recursive: true });
        writeFileSync(
          path.join(installer, "source", "linger.tar.gz"),
          archive.bytes,
        );
      },
      installerApi(),
      root,
    );
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(warn).toHaveBeenCalledWith(
          "local_server.prestage",
          expect.objectContaining({ status: "failed" }),
        ),
      );
      expect(checkPrivateLocation).toHaveBeenCalledWith(f.home);
      expect(existsSync(path.join(f.home, "desktop", "source"))).toBe(false);
      expect(f.module.status().phase).toBe("idle");
      expect(f.module.status().refusal).toBeUndefined();
    } finally {
      warn.mockRestore();
      await f.host.stop("quit");
    }
  });

  it.skipIf(process.platform === "win32")(
    "runChild waits for child close before rejecting when aborted on SIGTERM",
    async () => {
      const dir = tempDirectory();
      const startedFile = path.join(dir, "started");
      const exitedFile = path.join(dir, "exited");
      const script = [
        `const fs = require("node:fs");`,
        `process.on("SIGTERM", () => {`,
        `  setTimeout(() => { fs.writeFileSync(${JSON.stringify(exitedFile)}, "1"); process.exit(0); }, 150);`,
        `});`,
        `fs.writeFileSync(${JSON.stringify(startedFile)}, "1");`,
        `setInterval(() => {}, 1000);`,
      ].join("\n");
      const controller = new AbortController();
      const running = runChild(
        process.execPath,
        ["-e", script],
        dir,
        controller.signal,
      );
      await waitForInstaller(() => expect(existsSync(startedFile)).toBe(true));
      controller.abort(new Error("stop-now"));
      await expect(running).rejects.toThrow("stop-now");
      // runChild must NOT have rejected before the child finished its 150ms
      // cleanup and closed.
      expect(existsSync(exitedFile)).toBe(true);
    },
  );

  it("removes TEAMHUB_BINARY_DIRECTORY when aborted after installTeamhubBinaries wrote manifest.json and before unquarantine completes", async () => {
    const info = vi.spyOn(silentLog, "info");
    const f = setupBundledArchiveFixture("linux", "x64");
    const realInstall = teamhubBinaries.installTeamhubBinaries;
    let abortedOnce = false;
    const spy = vi
      .spyOn(teamhubBinaries, "installTeamhubBinaries")
      .mockImplementation(async (...args) => {
        const state = await realInstall(...args);
        if (!abortedOnce && state === "installed") {
          abortedOnce = true;
          f.module.cancelPrestage();
        }
        return state;
      });
    await f.host.start();
    try {
      f.module.inspect();
      await waitForInstaller(() =>
        expect(info).toHaveBeenCalledWith(
          "local_server.prestage",
          expect.objectContaining({ status: "aborted" }),
        ),
      );
      expect(abortedOnce).toBe(true);
      const stagedRepo = path.join(
        f.home,
        "desktop",
        "source",
        f.archive.sha256.slice(0, 16),
      );
      const prebuiltDir = path.join(stagedRepo, ".simplexai-runtime/prebuilt");
      // Prebuilt directory was cleaned up so the next run reinstalls and
      // completes unquarantine instead of seeing a stale manifest.json.
      expect(existsSync(prebuiltDir)).toBe(false);

      spy.mockRestore();
      await f.module.begin();
      expect(f.module.status().phase).toBe("ready");
      expect(existsSync(path.join(prebuiltDir, "teamhub"))).toBe(true);
      expect(info).toHaveBeenCalledWith(
        "local_server.teamhub_binaries",
        expect.objectContaining({ target: "linux-x64" }),
      );
    } finally {
      spy.mockRestore();
      info.mockRestore();
      await f.host.stop("quit");
    }
  });

  it("suppresses late Bifrost pre-fetch when setup closes during inspect() and cleans up BYOK pre-fetch started during sign-in", async () => {
    // (a) Closing setup via cancelPrestage() while inspect() is in flight
    //     prevents inspect()'s completion from spawning --prefetch-bifrost.
    const fLate = fixture(withCheckout, {}, (home) => {
      checkout(home);
      writeFileSync(path.join(home, "tool-download"), "");
    });
    writeFileSync(path.join(fLate.root, "prefetch-track"), "");
    await fLate.host.start();
    try {
      fLate.module.inspect();
      await waitForInstaller(() =>
        expect(fLate.module.status().localModels).toEqual({
          state: "checking",
          download: { completed: 5, total: 10 },
        }),
      );
      // Setup closes while inspect() is still running.
      fLate.module.cancelPrestage();
      writeFileSync(path.join(fLate.home, "tool-ready"), "");
      await waitForInstaller(() =>
        expect(fLate.module.status().localModels.state).toBe("checked"),
      );
      await delay(80);
      expect(readPrefetchEvents(fLate.root)).toEqual([]);
    } finally {
      writeFileSync(path.join(fLate.home, "tool-ready"), "");
      await fLate.host.stop("quit");
    }

    // (b) Testing BYOK during #awaitSignIn starts --prefetch-bifrost; finishing
    //     subscription sign-in stops and cleans it up before ready.
    const signInApi = installerApi([], {
      state: "waiting_user",
      errorCode: "RUNTIME_AUTH_REQUIRED",
      origin: "http://localhost:3000",
      setupChoice: "codex",
    });
    signInApi.runtime.login = { state: "idle" };
    const fSignIn = fixture(
      (home) => ({
        ...withCheckout(home),
        signInPollMs: 20,
      }),
      {},
      checkout,
      signInApi,
    );
    writeFileSync(path.join(fSignIn.root, "prefetch-track"), "");
    writeFileSync(path.join(fSignIn.root, "prefetch-hang"), "");
    await fSignIn.host.start();
    try {
      const installing = fSignIn.module.begin({ runtime: "codex" });
      await waitForInstaller(() =>
        expect(fSignIn.module.status().signIn?.state).toBe("required"),
      );
      await fSignIn.module.checkByok({
        runtime: "codex",
        baseUrl: "https://byok.example",
        path: "/v1",
        endpoint: "/responses",
        apiKey: "k",
        modelId: "m",
        protocol: "openai-responses",
      });
      await waitForInstaller(() =>
        expect(
          readPrefetchEvents(fSignIn.root).some((e) => e.event === "started"),
        ).toBe(true),
      );
      // Complete subscription sign-in without switching to BYOK.
      signInApi.runtime.login = { state: "ready" };
      await installing;
      expect(fSignIn.module.status().phase).toBe("ready");
      expect(
        readPrefetchEvents(fSignIn.root).some(
          (e) => e.event === "sigterm" || e.event === "stdin_end",
        ),
      ).toBe(true);
    } finally {
      await fSignIn.host.stop("quit");
    }
  });
});
