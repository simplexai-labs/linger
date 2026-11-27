import { prepareFoundationServices } from "./foundation-services.js";
import { portFree } from "./ports.js";
import { prepareModelGateway, stopModelGateway } from "./model-gateway.js";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  canBuildNativeServicesFromSource,
  canCompileTeamhubFromSource,
  prepareSourceConfiguration,
  saveSourceBinding,
  validateSourceRepository,
  type BackgroundVoiceToolsHandle,
  type BackgroundVoiceToolsLaunchOptions,
  type EnvironmentReport,
  type SourceInstallOptions,
} from "./source-checkout.js";
import {
  INSTANCE_BUSY,
  loadInstance,
  privateDirectory,
  readLocalIdentityKey,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import {
  prepareNativeDependencies,
  prepareNativeVoiceTools,
  resolveNativeVoiceToolsPlan,
} from "./native-dependencies.js";
import { linuxNodeFdHygieneArgs } from "./native-process-fds.js";
import { readLiveKitSettings, startNativeLiveKit } from "./native-livekit.js";
import { checkNativeRuntime } from "./native-runtime.js";
import { checkTeamhubBinaries } from "./teamhub-binaries.js";
import { sourceRegion } from "@linger/service-kit";
import { npmRegistryEnvironment } from "./npm-registry.js";
import {
  cachedRegion,
  formatRegionResolution,
  recordRegionFallback,
  resolveRegion,
  type Region,
  type RegionResolutionInfo,
} from "./region.js";
import { prepareNativeDatabase } from "./native-database.js";
import {
  inspectNativeListeners,
  inspectNativeProcess,
  inspectNativeProcesses,
  nativeConfigurationChanged,
  reclaimNativeOrphans,
  SERVICE_RESTART_POLICY,
  startNativeProcess,
  stopNativeProcess,
  stopNativeProcesses,
  type NativeListenerState,
  type NativeService,
} from "./native-process.js";
import {
  ensureLocalAccount,
  localAccountProvisioned,
  preProvisionLocalAccount,
  validateLocalCredentials,
} from "./account.js";
import {
  configureManagedCodex,
  managedRuntimeEnvironment,
} from "./managed-codex.js";
import { prepareRuntime, runtimeVersionFailure } from "./managed-runtimes.js";
import {
  applyNativeSource,
  prepareByokNativeRuntime,
  prepareByokRuntime,
  readByokEnvironment,
  type ByokGatewayFailure,
} from "./byok-source.js";
import { withLocalmodelsToolCache } from "./localmodels-tool.js";
import {
  readSetupChoice,
  writeGpuSharing,
  validateSetupChoice,
  writeSetupChoice,
} from "./setup-selection.js";
import {
  hasPendingLibraryModelsToRestore,
  isLocalRuntimeModel,
  localModelsDegradedFromError,
  localModelsDegradedFromOutcome,
  prepareLocalModels,
  restoreByokSource,
  restoreLocalModels,
  type LocalModelsDegraded,
} from "./local-models.js";
import { clearResumeLocalModels } from "./localmodels-tool.js";
import { prepareSourceComputer } from "./source-computer.js";
import { connectComputer, stopComputer } from "./computer.js";
import { prepareLocalEnrollment } from "./local-enrollment.js";
import { excerptLine, lineRedactor, redact } from "./redaction.js";
import { runProcess } from "./process.js";
import { systemProxyEnvironment } from "./service-proxy.js";
import {
  installAppleDeveloperTools,
  needsAppleDeveloperTools,
} from "./apple-developer-tools.js";
import type { InstallOutcome, InstallerEvent, InstallStage } from "./events.js";

export const nativeServices = [
  "web",
  "node-services",
  "teamhub",
  "livekit",
  "postgres",
] as const;
/** Marks a native service whose stop failed without a more specific code. */
export const NATIVE_SERVICE_STOP_FAILED = "NATIVE_SERVICE_STOP_FAILED";

export interface PrepareVoiceToolsOptions {
  home: string;
  instanceName: string;
  waitForGoOnStdin?: boolean;
  signal?: AbortSignal;
  stdin?: AsyncIterable<Buffer | string>;
  lockWaitMs?: number;
}

async function appendLiveKitLog(root: string, message: string): Promise<void> {
  try {
    await privateDirectory(path.join(root, "native"));
    const logs = path.join(root, "native", "logs");
    await privateDirectory(logs);
    const file = path.join(logs, "livekit.log");
    const handle = await open(
      file,
      constants.O_CREAT |
        constants.O_APPEND |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        (process.platform !== "win32" &&
          (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
      ) {
        return;
      }
      const line = `[linger-voice-tools] ${new Date().toISOString()} ${redact(message.replace(/\r?\n/g, " "))}\n`;
      await handle.write(line);
    } finally {
      await handle.close();
    }
  } catch {
    // Logging must never block background voice-tools extraction or LiveKit startup.
  }
}

async function readStdinDecision(
  stream: AsyncIterable<Buffer | string>,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) return "";
  let buffer = "";
  const iterator = stream[Symbol.asyncIterator]();
  let abortResolve: (() => void) | undefined;
  const aborted = signal
    ? new Promise<"aborted">((resolve) => {
        abortResolve = () => resolve("aborted");
        signal.addEventListener("abort", abortResolve, { once: true });
      })
    : undefined;
  try {
    for (;;) {
      const result = aborted
        ? await Promise.race([iterator.next(), aborted])
        : await iterator.next();
      if (result === "aborted" || signal?.aborted) return "";
      if (result.done) return buffer.trim();
      buffer += Buffer.isBuffer(result.value)
        ? result.value.toString("utf8")
        : result.value;
      const newline = buffer.indexOf("\n");
      if (newline >= 0) return buffer.slice(0, newline).trim();
    }
  } catch {
    return "";
  } finally {
    if (signal && abortResolve) {
      signal.removeEventListener("abort", abortResolve);
    }
    void iterator.return?.().catch(() => undefined);
  }
}

/**
 * Extracts and verifies the bundled voice tools and, once the parent installer
 * commits and the instance is still running, starts native LiveKit in the
 * background.
 */
export async function prepareVoiceToolsAndStartLiveKit(
  options: PrepareVoiceToolsOptions,
): Promise<void> {
  const home = path.resolve(options.home);
  const outerSignal = options.signal ?? new AbortController().signal;
  const workController = new AbortController();
  const workSignal = AbortSignal.any([outerSignal, workController.signal]);
  const stdinController = new AbortController();
  const stdinSignal = AbortSignal.any([outerSignal, stdinController.signal]);
  const initialInstance = await loadInstance({
    name: options.instanceName,
    home,
  }).catch(() => undefined);
  let logRoot = initialInstance?.root;
  const log = async (message: string) => {
    if (!logRoot) return;
    await appendLiveKitLog(logRoot, message);
  };
  let stdinDecision: string | undefined;
  let decisionPromise: Promise<string> | undefined;
  try {
    if (options.waitForGoOnStdin) {
      decisionPromise = readStdinDecision(
        options.stdin ?? process.stdin,
        stdinSignal,
      ).then((decision) => {
        stdinDecision = decision;
        if (decision !== "go") workController.abort();
        return decision;
      });
    }
    await log("Preparing voice tools in the background.");
    let voice: { bin: string; livekit: string } | undefined;
    try {
      voice = await prepareNativeVoiceTools({ home, signal: workSignal });
    } catch (error) {
      if (
        options.waitForGoOnStdin &&
        workController.signal.aborted &&
        !outerSignal.aborted
      ) {
        await log(
          `Skipping background LiveKit startup (installer signaled ${stdinDecision ? JSON.stringify(stdinDecision) : "EOF"}).`,
        );
        return;
      }
      await log(
        `Voice tools preparation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
    if (!voice) {
      await log(
        "Voice tools are not configured for this computer; skipping LiveKit.",
      );
      return;
    }
    if (decisionPromise) {
      const decision = await decisionPromise;
      if (decision !== "go") {
        await log(
          `Skipping background LiveKit startup (installer signaled ${decision ? JSON.stringify(decision) : "EOF"}).`,
        );
        return;
      }
    }
    if (workSignal.aborted) {
      await log(
        "Skipping background LiveKit startup because preparation was aborted.",
      );
      return;
    }
    const instance =
      (await loadInstance({ name: options.instanceName, home })) ??
      initialInstance;
    if (!instance) {
      await log(
        `Instance ${options.instanceName} no longer exists; skipping LiveKit.`,
      );
      return;
    }
    logRoot = instance.root;
    const lockWaitMs = options.lockWaitMs ?? 60_000;
    const lockDeadline = Date.now() + lockWaitMs;
    let lockAcquired = false;
    for (;;) {
      if (workSignal.aborted) {
        await log(
          "Skipping background LiveKit startup because preparation was aborted.",
        );
        return;
      }
      try {
        await withInstanceLock(instance, async () => {
          lockAcquired = true;
          const liveKit = await readLiveKitSettings(instance.root);
          if (!liveKit) {
            await log("LiveKit settings are missing; skipping LiveKit.");
            return;
          }
          const [postgresState, teamhubState, livekitState] =
            await inspectNativeProcesses(instance.root, [
              "postgres",
              "teamhub",
              "livekit",
            ]);
          if (!postgresState?.running || !teamhubState?.running) {
            await log(
              "Instance core services are not running; skipping background LiveKit startup.",
            );
            return;
          }
          if (livekitState?.running) {
            await log(
              "Native LiveKit is already running; skipping duplicate startup.",
            );
            return;
          }
          await log("Starting native LiveKit in the background.");
          try {
            await startNativeLiveKit({
              root: instance.root,
              executable: voice.livekit,
              settings: liveKit,
              signal: workSignal,
            });
            await log("Native LiveKit is ready.");
          } catch (error) {
            await log(
              `Native LiveKit startup failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            throw error;
          }
        });
        return;
      } catch (error) {
        if (
          lockAcquired ||
          (error as { code?: unknown } | null)?.code !== INSTANCE_BUSY
        ) {
          throw error;
        }
        if (Date.now() >= lockDeadline) {
          await log(
            "Timed out waiting for instance lock; skipping background LiveKit startup.",
          );
          return;
        }
        try {
          await delay(
            Math.min(100, Math.max(1, lockDeadline - Date.now())),
            undefined,
            { signal: workSignal },
          );
        } catch (delayError) {
          if (workSignal.aborted) {
            await log(
              "Skipping background LiveKit startup because preparation was aborted.",
            );
            return;
          }
          throw delayError;
        }
      }
    }
  } finally {
    stdinController.abort();
  }
}

/**
 * Builds a detached background voice-tools launcher that runs the specified
 * installer entrypoint with `--prepare-voice-tools` and coordinates commit or
 * abort over stdin.
 */
export function createVoiceToolsBackgroundLauncher(
  installerScript: string,
): (options: BackgroundVoiceToolsLaunchOptions) => BackgroundVoiceToolsHandle {
  const entry = path.resolve(installerScript);
  return (options) => {
    const child = spawn(
      process.execPath,
      [
        ...linuxNodeFdHygieneArgs(),
        entry,
        "--prepare-voice-tools",
        "--home",
        options.home,
        "--instance",
        options.instanceName,
      ],
      {
        env: options.env,
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    child.on("error", () => undefined);
    child.stdin?.on("error", () => undefined);
    child.unref();
    let settled = false;
    const signalChild = (line: "go\n" | "abort\n") => {
      if (settled) return;
      settled = true;
      try {
        child.stdin?.end(line);
      } catch {
        // The detached worker may already have exited; ignore broken-pipe writes.
      }
    };
    return {
      commit: () => signalChild("go\n"),
      abort: () => signalChild("abort\n"),
    };
  };
}

interface ReservedLoopbackPort {
  ok: true;
  release: () => Promise<void>;
}
interface OccupiedLoopbackPort {
  ok: false;
  code: "EADDRINUSE";
}
type LoopbackPortReservation = ReservedLoopbackPort | OccupiedLoopbackPort;

// Holds LiveKit's loopback HTTP port while voice tools extract asynchronously
// so foundation services and BYOK gateways cannot claim it before LiveKit starts.
async function reserveLoopbackPort(
  port: number,
): Promise<LoopbackPortReservation> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve({ ok: false, code: "EADDRINUSE" });
        return;
      }
      reject(error);
    };
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      server.unref();
      let closed = false;
      resolve({
        ok: true,
        release: async () => {
          if (closed) return;
          closed = true;
          if (!server.listening) return;
          await new Promise<void>((done) => {
            server.close(() => done());
          });
        },
      });
    });
  });
}
function requireNative(instance: Instance) {
  if (instance.mode !== "source-native" || !instance.source)
    throw new Error("This operation requires a native source instance.");
  return instance.source;
}
export async function nativeSourceInstanceName(
  repository: string,
): Promise<string> {
  const canonical = await realpath(repository);
  return `native-${createHash("sha256").update(canonical).digest("hex").slice(0, 12)}`;
}
export async function prepareNativeConfiguration(
  repository: string,
  options: {
    name?: string;
    home?: string;
    port?: number;
    computerName?: string;
    externalComputer?: boolean;
    rebindSource?: boolean;
  } = {},
) {
  const repo = await validateSourceRepository(repository);
  const name = options.name ?? (await nativeSourceInstanceName(repo));
  return prepareSourceConfiguration(repo, { ...options, name });
}
export async function checkNativeSourceEnvironment(options: {
  repo: string;
  home?: string;
  signal: AbortSignal;
}): Promise<EnvironmentReport> {
  options.signal.throwIfAborted();
  const supported =
    (process.platform === "darwin" && process.arch === "arm64") ||
    (process.platform === "linux" && process.arch === "x64") ||
    (process.platform === "win32" && process.arch === "x64");
  const checks: EnvironmentReport["checks"] = [
    {
      id: "platform",
      title: "Operating system",
      state: supported ? "ready" : "action_required",
      detail: supported
        ? `${process.platform}/${process.arch}`
        : "Native source currently provides macOS arm64, Linux x64 and Windows x64 components.",
    },
  ];
  let ready = false;
  try {
    await validateSourceRepository(options.repo);
    ready = true;
  } catch {
    /* A preflight report never exposes parser or private file contents. */
  }
  checks.push({
    id: "source-native",
    title: "Native source checkout",
    state: ready ? "ready" : "action_required",
    detail: ready
      ? "Native source runs directly on this computer."
      : "Select a checkout containing scripts/source-native.mjs.",
  });
  let directory = path.resolve(options.home ?? options.repo);
  for (;;) {
    try {
      const disk = await statfs(directory);
      const availableBytes = Number(disk.bavail) * Number(disk.bsize);
      checks.push({
        id: "disk",
        title: "Available storage",
        state: availableBytes > 0 ? "ready" : "action_required",
        detail:
          "Native component sizes are verified before download; source dependency and compilation space is additional.",
      });
      return {
        platform: process.platform,
        arch: process.arch,
        releaseAvailable: ready && supported,
        checks,
        availableBytes,
      };
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        path.dirname(directory) === directory
      )
        throw error;
      directory = path.dirname(directory);
    }
  }
}
const probeEndpoints = (source: NonNullable<Instance["source"]>) =>
  [
    ["web", "web", source.ports.web, "/healthz"],
    ["teamhub", "teamhub", source.ports.teamhub, "/healthz"],
    ["node-services", "node-services", source.ports.nodeServices, "/readyz"],
    ["document-runtime", "node-services", source.ports.document, "/readyz"],
  ] as const;
type ProbeEndpoints = ReturnType<typeof probeEndpoints>;
type ProbeEndpoint = ProbeEndpoints[number];
interface HttpEndpointProbe {
  service: ProbeEndpoint[0];
  owner: ProbeEndpoint[1];
  port: number;
  ok: boolean;
}
interface ServiceReadiness {
  service: ProbeEndpoint[0];
  ready: boolean;
}
// Interval between listener snapshots while endpoints remain unready, avoiding
// per-tick OS process enumeration during startup.
const LISTENER_SNAPSHOT_INTERVAL_MS = 5_000;
async function probeHttpEndpoint(
  port: number,
  endpoint: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
      redirect: "error",
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(2_000),
      ]),
    });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
async function probeHttpEndpoints(
  endpoints: ProbeEndpoints,
  signal?: AbortSignal,
): Promise<HttpEndpointProbe[]> {
  return Promise.all(
    endpoints.map(async ([service, owner, port, endpoint]) => ({
      service,
      owner,
      port,
      ok: await probeHttpEndpoint(port, endpoint, signal),
    })),
  );
}
async function snapshotNativeListeners(
  instance: Instance,
  endpoints: ProbeEndpoints,
): Promise<NativeListenerState[] | undefined> {
  return inspectNativeListeners(
    instance.root,
    endpoints.map(([, name, port]) => ({ name, port })),
  ).catch(() => undefined);
}
export async function probeNativeSourceServices(
  instance: Instance,
  signal?: AbortSignal,
) {
  const endpoints = probeEndpoints(requireNative(instance));
  const states = await snapshotNativeListeners(instance, endpoints);
  if (!states) return endpoints.map(([service]) => ({ service, ready: false }));
  return Promise.all(
    endpoints.map(async ([service, , port, endpoint], index) => {
      const { running, foreign } = states[index]!;
      // Another process on the port would answer the health check for a
      // service that cannot listen there.
      if (foreign !== undefined)
        return { service, ready: false, foreign, port };
      if (!running) return { service, ready: false };
      return {
        service,
        ready: await probeHttpEndpoint(port, endpoint, signal),
      };
    }),
  );
}
const watchedServices = ["teamhub", "node-services", "web"] as const;
// Where each service log ends, so startup reads only what this run wrote.
async function logEnds(instance: Instance) {
  const ends = new Map<string, number>();
  for (const name of watchedServices)
    ends.set(
      name,
      await lstat(path.join(instance.root, "native/logs", `${name}.log`)).then(
        (info) => info.size,
        () => 0,
      ),
    );
  return ends;
}
// The last part of what a service logged since `from`.
async function logSince(instance: Instance, name: string, from: number) {
  let handle;
  try {
    handle = await open(
      path.join(instance.root, "native/logs", `${name}.log`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch {
    return "";
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(size < from ? 0 : from, size - 64 * 1024);
    const bytes = Buffer.alloc(size - start);
    await handle.read(bytes, 0, bytes.length, start);
    return bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}
// The compiler's own lines from the last failed build, redacted and
// bounded, so the setup page can show why without the log file.
export function compileFailureExcerpt(text: string, limit = 12) {
  const lines = redact(text).split(/\r?\n/u);
  const last = (pattern: RegExp, end: number) => {
    for (let index = end - 1; index >= 0; index--)
      if (pattern.test(lines[index]!)) return index;
    return -1;
  };
  const failed = last(/failed to build/, lines.length);
  if (failed < 0) return "";
  const building = last(/\bbuilding\.\.\./, failed);
  return lines
    .slice(building + 1, failed + 1)
    .map((line) => line.trim())
    .filter((line) => line && !/^(?:\S+\s+)?(?:watching|!exclude)\b/.test(line))
    .slice(-limit)
    .map((line) => excerptLine(line))
    .join("\n");
}
// A compile that fails stops TeamHub or leaves the dev server waiting for an
// edit that never comes; read the logs so the failure ends startup at once.
async function startupFailure(instance: Instance, ends: Map<string, number>) {
  const logs = path.join(instance.root, "native/logs");
  for (const name of watchedServices) {
    const text = await logSince(instance, name, ends.get(name) ?? 0);
    if (/no space left on device|ENOSPC/.test(text))
      return `This computer's disk is full, so native ${name} could not be built. Free up some space and try again.`;
    if (name === "teamhub" && /failed to build/.test(text)) {
      const excerpt = compileFailureExcerpt(text);
      return `Native teamhub failed to compile.${excerpt ? `\n${excerpt}\n` : " "}Inspect ${path.join(logs, "teamhub.log")}.`;
    }
  }
  return undefined;
}
const WAIT_HEALTHY_POLL_MS = [
  100, 150, 200, 200, 200, 200, 200, 200, 200, 200, 200, 200, 500,
] as const;

async function waitHealthy(
  instance: Instance,
  signal: AbortSignal,
  onEvent: (event: InstallerEvent) => void,
  ends: Map<string, number>,
): Promise<ServiceReadiness[]> {
  const endpoints = probeEndpoints(requireNative(instance));
  const startedAt = Date.now();
  const deadline = startedAt + 20 * 60_000;
  let last = 0;
  let lastSnapshotAt = startedAt;
  let pollAttempt = 0;
  const occupied = new Map<string, number>();
  const readyAt = new Map<string, string>();
  const recordReady = (service: string, now: number) => {
    if (readyAt.has(service)) return;
    const elapsed = ((now - startedAt) / 1000).toFixed(1);
    readyAt.set(service, elapsed);
    onEvent({
      kind: "log",
      stage: "services",
      message: `Native service ${service} ready in ${elapsed}s.\n`,
    });
  };
  for (;;) {
    signal.throwIfAborted();
    const httpChecks = await probeHttpEndpoints(endpoints, signal);
    signal.throwIfAborted();
    const allHttpOk = httpChecks.every((check) => check.ok);
    // Confirm listener ownership once all HTTP probes pass, track an active
    // foreign holder for its 15s limit, and periodically snapshot to detect
    // silent process exits.
    const shouldSnapshot =
      allHttpOk ||
      occupied.size > 0 ||
      Date.now() - lastSnapshotAt >= LISTENER_SNAPSHOT_INTERVAL_MS;
    let checks: ServiceReadiness[];
    if (shouldSnapshot) {
      const states = await snapshotNativeListeners(instance, endpoints);
      signal.throwIfAborted();
      const now = Date.now();
      lastSnapshotAt = now;
      if (states) {
        checks = endpoints.map(([service], index) => {
          const state = states[index]!;
          return {
            service,
            ready:
              httpChecks[index]!.ok &&
              state.running &&
              state.foreign === undefined,
          };
        });
        if (!allHttpOk) {
          for (const check of checks) {
            if (check.ready) recordReady(check.service, now);
          }
        }
        if (checks.every((check) => check.ready)) {
          // Confirm HTTP readiness after the listener snapshot so a foreign
          // process that answered before exiting cannot satisfy readiness for
          // a service that has not bound its port yet.
          const confirmed = await probeHttpEndpoints(endpoints, signal);
          signal.throwIfAborted();
          if (confirmed.every((check) => check.ok)) {
            const confirmedAt = Date.now();
            for (const check of checks) recordReady(check.service, confirmedAt);
            const summary = checks
              .map(
                ({ service }) => `${service} ${readyAt.get(service) ?? "0.0"}`,
              )
              .join(", ");
            onEvent({
              kind: "log",
              stage: "services",
              message: `Native collaboration services ready (s): ${summary}.\n`,
            });
            return checks;
          }
          checks = confirmed.map(({ service, ok }) => ({ service, ready: ok }));
        }
        // A port another process holds never frees up by waiting; the service
        // that should listen there exits or retries until the deadline.
        for (const [index, [service, , port]] of endpoints.entries()) {
          const foreign = states[index]!.foreign;
          if (foreign === undefined) {
            occupied.delete(service);
            continue;
          }
          const since = occupied.get(service) ?? Date.now();
          occupied.set(service, since);
          if (Date.now() - since >= 15_000)
            throw new Error(
              `Native ${service} cannot listen on port ${port}: another program (PID ${foreign}) is using it. End that program, then try again.`,
            );
        }
        // A failed build exits the service, so its log explains the stop.
        const failure = await startupFailure(instance, ends);
        if (failure) throw new Error(failure);
        for (const name of watchedServices) {
          const ownerStopped = endpoints.some(
            ([, owner], index) => owner === name && !states[index]!.running,
          );
          if (ownerStopped) {
            // With the service gone, whatever holds its port is another program.
            for (const [, owner, port] of endpoints)
              if (owner === name && !(await portFree(port)))
                throw new Error(
                  `Native ${name} cannot listen on port ${port}: another program is using it. Quit that program, then try again.`,
                );
            throw new Error(
              `Native ${name} stopped during startup. Inspect ${path.join(instance.root, "native/logs", `${name}.log`)}.`,
            );
          }
        }
      } else {
        // A failed listener query proves neither readiness nor a stopped
        // service; check logs and retry on a later tick.
        checks = endpoints.map(([service]) => ({ service, ready: false }));
        const failure = await startupFailure(instance, ends);
        if (failure) throw new Error(failure);
      }
    } else {
      const now = Date.now();
      checks = httpChecks.map(({ service, ok }) => ({
        service,
        ready: ok && !occupied.has(service),
      }));
      for (const check of checks) {
        if (check.ready) recordReady(check.service, now);
      }
      // A failed build exits the service, so its log explains the stop.
      const failure = await startupFailure(instance, ends);
      if (failure) throw new Error(failure);
    }
    if (Date.now() >= deadline) {
      const waiting = checks
        .filter((row) => !row.ready)
        .map((row) => row.service);
      throw new Error(
        `Native source services did not become ready before the startup deadline: ${waiting.join(", ")}. Inspect ${path.join(instance.root, "native/logs")}.`,
      );
    }
    if (Date.now() - last >= 10_000) {
      last = Date.now();
      onEvent({
        kind: "log",
        stage: "services",
        message: `Waiting for native compilation and readiness (${checks.filter((row) => row.ready).length}/4 ready).\n`,
      });
    }
    const interval =
      WAIT_HEALTHY_POLL_MS[
        Math.min(pollAttempt, WAIT_HEALTHY_POLL_MS.length - 1)
      ]!;
    pollAttempt += 1;
    await delay(interval, undefined, { signal });
  }
}
// What each stage is doing, for a failure that brings no message of its own.
const STAGE_ACTIVITY: Record<InstallStage, string> = {
  preflight: "checking this computer",
  release: "preparing private native toolchains and PostgreSQL",
  images: "installing checkout dependencies",
  services: "starting native services",
  account: "preparing the local account",
  computer: "connecting this Computer",
  runtime: "preparing the AI runtime",
};
// Seconds each stage took, in the order they ran, for the install job's
// outcome and log; a stage that runs again adds to its time.
function stageTimer(now = () => Date.now()) {
  const timings: Partial<Record<InstallStage, number>> = {};
  let current: InstallStage = "preflight";
  let since = now();
  const close = () => {
    const at = now();
    timings[current] = (timings[current] ?? 0) + (at - since) / 1000;
    since = at;
  };
  return {
    enter(stage: InstallStage) {
      if (stage === current) return;
      close();
      current = stage;
    },
    finish() {
      close();
      return Object.fromEntries(
        Object.entries(timings).map(([stage, seconds]) => [
          stage,
          Math.round(seconds * 10) / 10,
        ]),
      ) as Partial<Record<InstallStage, number>>;
    },
  };
}

export async function installNativeSource(
  options: SourceInstallOptions,
  now?: () => number,
): Promise<InstallOutcome> {
  const timer = stageTimer(now);
  const outcome = await withLocalmodelsToolCache(() =>
    runNativeSource(options, timer),
  );
  const timings = timer.finish();
  options.onEvent({
    kind: "log",
    message: `Native install timings (s): ${Object.entries(timings)
      .map(([stage, seconds]) => `${stage} ${seconds}`)
      .join(", ")}\n`,
  });
  return {
    ...outcome,
    details: {
      ...(typeof outcome.details === "object" ? outcome.details : {}),
      timings,
    },
  };
}

async function runNativeSource(
  options: SourceInstallOptions,
  timer: ReturnType<typeof stageTimer>,
): Promise<InstallOutcome> {
  let stage: InstallStage = "preflight";
  const secrets: string[] = [
    options.password,
    options.model?.apiKey,
    options.runtimeModel?.apiKey,
  ].filter((item): item is string => Boolean(item));
  const safe = (text: string) => {
    let value = redact(text);
    for (const secret of secrets)
      value = value.split(secret).join("[REDACTED]");
    return value;
  };
  const emit = (event: InstallerEvent) =>
    options.onEvent({ ...event, message: safe(event.message) });
  const step = (next: InstallStage, message: string) => {
    stage = next;
    timer.enter(next);
    emit({ kind: "stage", stage, state: "running", message });
  };
  const output = lineRedactor((message) =>
    emit({ kind: "log", stage, message }),
  );
  let instance: Instance | undefined;
  try {
    options.signal.throwIfAborted();
    validateLocalCredentials(options);
    if (options.byok?.apiKey) secrets.push(options.byok.apiKey);
    if (options.setupChoice) validateSetupChoice(options.setupChoice);
    const choice = options.byok
      ? (options.byok.runtime ??
        (options.setupChoice && options.setupChoice !== "local-models"
          ? options.setupChoice
          : "claude"))
      : (options.setupChoice ?? (await readSetupChoice(options)));
    if (!choice)
      return {
        code: 4,
        state: "action_required",
        message: "Choose a Harness before starting native source.",
        details: { code: "SETUP_SELECTION_REQUIRED" },
      };
    // The desktop owns its instance and ships a new source package with
    // each update, so its instance follows the bundled checkout.
    const configured = await prepareNativeConfiguration(options.repo, {
      ...options,
      rebindSource: options.externalComputer,
    });
    instance = configured.instance;
    for (const [key, value] of Object.entries(configured.env))
      if (
        value &&
        /secret|password|token|key|credential|database_url/i.test(key)
      )
        secrets.push(value);
    const identityKey = await readLocalIdentityKey(instance.root);
    if (!identityKey)
      throw new Error("The instance has no server identity key.");
    secrets.push(identityKey);
    for (const message of configured.warnings)
      emit({ kind: "log", stage, message });
    const current = instance;
    return await withInstanceLock(current, async () => {
      const home = path.resolve(current.root, "../..");
      const explicitLocal =
        options.setupChoice === "local-models" ||
        Boolean(options.localModelsApproval) ||
        Boolean(options.localModelsReplan) ||
        options.shareGpu !== undefined;
      if (
        Boolean(options.byok) ||
        options.setupChoice !== undefined ||
        Boolean(options.localModelsApproval)
      ) {
        await clearResumeLocalModels(home).catch(() => undefined);
      }
      // A restart reads the choice from setup-choice.json, which a source
      // switched since on the Models page does not update, so a saved BYOK,
      // subscription, or local source keeps its own runtime and model state
      // instead of resetting or unloading loaded library models.
      const saved =
        !options.byok && !options.setupChoice && !explicitLocal
          ? await readByokEnvironment(home)
          : undefined;
      const restoredByok = saved?.mode === "byok" ? saved : undefined;
      const restoredLocal = saved?.mode === "local" ? saved : undefined;
      const restoredSubscription =
        saved?.mode === "subscription" ? saved : undefined;
      await writeSetupChoice(current, choice);
      if (options.shareGpu !== undefined)
        await writeGpuSharing(current, options.shareGpu);
      if (options.runtimeModel)
        await configureManagedCodex(
          current.root,
          options.runtimeModel,
          options.signal,
        );
      const controller = new AbortController();
      const signal = AbortSignal.any([options.signal, controller.signal]);
      const started: NativeService[] = [];
      let regionProbeController: AbortController | undefined;
      const abortRegionProbe = () => {
        regionProbeController?.abort();
        regionProbeController = undefined;
      };
      let backgroundVoice: BackgroundVoiceToolsHandle | undefined;
      let backgroundVoiceSettled = false;
      let releaseLiveKitReservation: (() => Promise<void>) | undefined;
      const releaseLiveKitPort = async () => {
        const release = releaseLiveKitReservation;
        releaseLiveKitReservation = undefined;
        if (release) await release();
      };
      const commitBackgroundVoice = () => {
        if (!backgroundVoice || backgroundVoiceSettled) return;
        backgroundVoiceSettled = true;
        backgroundVoice.commit();
      };
      const abortBackgroundVoice = () => {
        if (!backgroundVoice || backgroundVoiceSettled) return;
        backgroundVoiceSettled = true;
        backgroundVoice.abort();
      };
      const hadProvisionedAccount = await localAccountProvisioned(current.root);
      const hasVoiceProviderKey = Boolean(
        configured.env.SONIOX_API_KEY?.trim() ||
        configured.env.XAI_API_KEY?.trim(),
      );
      const voiceLauncher =
        options.launchVoiceToolsBackground === false
          ? undefined
          : options.launchVoiceToolsBackground;
      let voice: { bin: string; livekit: string } | undefined;
      let voiceDeferred = false;
      let voicePlanFailed = false;
      let voicePortUnavailable = false;
      let voicePlan: Awaited<ReturnType<typeof resolveNativeVoiceToolsPlan>>;
      try {
        voicePlan = await resolveNativeVoiceToolsPlan(home);
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        voicePlanFailed = true;
        emit({
          kind: "log",
          stage: "release",
          message: `The voice tools could not be prepared: ${error instanceof Error ? error.message : String(error)}\n`,
        });
      }
      // Only defer voice tools on true cold first installs with no voice
      // provider keys: node-services /readyz waits on LiveKit whenever a voice
      // key exists in user.env or Postgres. Reserve LiveKit's port before the
      // parallel runtime starts so BYOK Bifrost or foundation services cannot
      // take it, while keeping worker spawn after reclaimEarlierProcesses.
      const canDeferVoice = Boolean(
        configured.liveKit &&
        voicePlan &&
        !voicePlan.prepared &&
        !voicePlan.damaged &&
        voiceLauncher &&
        !hadProvisionedAccount &&
        !hasVoiceProviderKey,
      );
      if (canDeferVoice && configured.liveKit && voicePlan) {
        let reservation = await reserveLoopbackPort(
          configured.liveKit.httpPort,
        );
        if (!reservation.ok) {
          await reclaimEarlierProcesses(current, home, emit);
          reservation = await reserveLoopbackPort(configured.liveKit.httpPort);
        }
        if (reservation.ok) {
          releaseLiveKitReservation = reservation.release;
          voice = { bin: voicePlan.bin, livekit: voicePlan.livekit };
          voiceDeferred = true;
        } else {
          voicePortUnavailable = true;
          emit({
            kind: "log",
            stage: "release",
            message: `Voice stays off: LiveKit could not reserve local port ${configured.liveKit.httpPort} (EADDRINUSE).\n`,
          });
        }
      }
      let runtimeOutcome: InstallOutcome | undefined;
      let runtimeError: unknown;
      let runtimeAborted = false;
      let runtimePending = true;
      let byokGateway: ByokGatewayFailure | undefined;
      let localModelsDegraded: LocalModelsDegraded | undefined;
      let localModelsRestored = false;
      const restoredLocalModels = new Set<string>();
      let runtimeRecovery: Promise<void> | undefined;
      let runtimeRecoveryError: unknown;
      let runtimeRecoveryFailed = false;
      const startRuntimeRecovery = (work: () => Promise<void>) => {
        runtimeRecovery = (async () => {
          try {
            signal.throwIfAborted();
            await work();
          } catch (error) {
            runtimeRecoveryFailed = true;
            runtimeRecoveryError = error;
          }
        })();
      };
      const awaitRuntimeRecovery = async () => {
        if (!runtimeRecovery) return;
        await runtimeRecovery;
        if (runtimeRecoveryFailed) throw runtimeRecoveryError;
        signal.throwIfAborted();
      };
      const resumeLocalModels =
        Boolean(options.resume || options.degradeLocalModels) &&
        !options.setupChoice &&
        !options.localModelsApproval &&
        !options.localModelsReplan;
      const logLocalModelsDegraded = (degraded: LocalModelsDegraded) => {
        emit({
          kind: "log",
          stage: "runtime",
          message: `${degraded.message} (${degraded.code}) Linger is starting without local models; open the Models page to manage local models or switch to another AI runtime.\n`,
        });
      };
      const restoreSavedLocalModel = async () => {
        try {
          signal.throwIfAborted();
          const restored = await restoreLocalModels(current, {
            signal,
            onEvent: emit,
            onRestored: (models) => {
              localModelsRestored = true;
              for (const id of models) restoredLocalModels.add(id);
            },
          });
          signal.throwIfAborted();
          if (restored) {
            localModelsDegraded = localModelsDegradedFromOutcome(restored);
            logLocalModelsDegraded(localModelsDegraded);
          }
        } catch (error) {
          if (signal.aborted) throw error;
          localModelsDegraded = localModelsDegradedFromError(error);
          logLocalModelsDegraded(localModelsDegraded);
        }
      };
      const runtime = (async () => {
        try {
          if (restoredByok) {
            runtimeOutcome = await prepareByokNativeRuntime(
              restoredByok.runtime,
              {
                home,
                signal,
                onEvent: emit,
                ...(options.resume
                  ? { reuseInstalled: true }
                  : {
                      env: await managedRuntimeEnvironment(home, current.root),
                    }),
                onDescriptor: (descriptor) =>
                  options.onRuntimeDescriptors?.([descriptor]),
              },
            );
            // A gateway that does not come back leaves the services usable,
            // so start mounting it eagerly in the background without blocking
            // migrations, then restore any previously loaded library models
            // afterwards because `source apply --mode byok` unloads local models
            // before mounting BYOK.
            if (!runtimeOutcome) {
              startRuntimeRecovery(async () => {
                byokGateway = await restoreByokSource(home, {
                  signal,
                  onEvent: emit,
                });
                signal.throwIfAborted();
                if (await hasPendingLibraryModelsToRestore(home))
                  await restoreSavedLocalModel();
              });
            }
          } else if (options.byok) {
            const byokRuntime =
              choice === "local-models"
                ? (options.byok.runtime ?? "claude")
                : choice;
            runtimeOutcome = await prepareByokRuntime(
              { ...options.byok, runtime: byokRuntime },
              {
                onDescriptor: (descriptor) =>
                  options.onRuntimeDescriptors?.([descriptor]),
                home,
                signal,
                onEvent: emit,
                env: await managedRuntimeEnvironment(home, current.root),
              },
            );
          } else if (restoredSubscription) {
            // Keep the saved subscription source without re-running
            // `source apply --mode subscription` (which unloads loaded local
            // library models during updates and restarts), and restore any
            // library models that were loaded before stop or crash in the
            // background without blocking migrations.
            runtimeOutcome = await prepareRuntime(
              restoredSubscription.runtime,
              {
                home,
                signal,
                onEvent: emit,
                ...(options.resume
                  ? { reuseInstalled: true }
                  : {
                      env: await managedRuntimeEnvironment(home, current.root),
                    }),
                onDescriptor: (descriptor) =>
                  options.onRuntimeDescriptors?.([descriptor]),
              },
            );
            if (
              runtimeOutcome.code === 0 ||
              (runtimeOutcome.details as { code?: string } | undefined)
                ?.code === "RUNTIME_AUTH_REQUIRED"
            ) {
              startRuntimeRecovery(async () => {
                if (await hasPendingLibraryModelsToRestore(home))
                  await restoreSavedLocalModel();
              });
            }
          } else if (choice === "local-models") {
            // A restart or app upgrade from the saved setup choice keeps a
            // model source the person switched to on the Models page (BYOK or
            // subscription), leaving the local model stack stopped just as
            // restoreLocalModels does.
            const switchedAway =
              !explicitLocal && (saved?.mode ?? "local") !== "local";
            if (!switchedAway) {
              const runLocalModelsPrep = async () => {
                let prepared: InstallOutcome | undefined;
                try {
                  prepared = await prepareLocalModels(current, {
                    shareGpu: options.shareGpu,
                    signal,
                    onEvent: emit,
                    localModelsApproval: options.localModelsApproval,
                    localModelsReplan: options.localModelsReplan,
                  });
                  signal.throwIfAborted();
                } catch (error) {
                  if (!resumeLocalModels || signal.aborted) throw error;
                  localModelsDegraded = localModelsDegradedFromError(error);
                }
                if (prepared && resumeLocalModels) {
                  // Failing a resume for local models would lock the person out
                  // of the workspace and the Models page that switches runtimes.
                  localModelsDegraded =
                    localModelsDegradedFromOutcome(prepared);
                } else {
                  runtimeOutcome = prepared;
                }
                if (localModelsDegraded) {
                  logLocalModelsDegraded(localModelsDegraded);
                }
                // A person who chose local models just now makes them the
                // source, replacing one an earlier setup left. A restart reads
                // the choice from setup-choice.json and passes no approval, so a
                // source the person switched since on the Models page stays.
                if (
                  !runtimeOutcome &&
                  !localModelsDegraded &&
                  (options.setupChoice === "local-models" ||
                    options.localModelsApproval)
                )
                  runtimeOutcome = await applyNativeSource(
                    home,
                    "local",
                    "pi",
                    {
                      signal,
                      onEvent: emit,
                    },
                  );
                else if (
                  !runtimeOutcome &&
                  !localModelsDegraded &&
                  !options.localModelsReplan &&
                  ((restoredLocal &&
                    isLocalRuntimeModel(restoredLocal.runtimeModel)) ||
                    (await hasPendingLibraryModelsToRestore(home)))
                )
                  await restoreSavedLocalModel();
              };
              // Degraded-tolerant resumes convert local-model failures into
              // warnings rather than aborting migrations, so start them eagerly
              // in the background without blocking migrations or service startup.
              if (resumeLocalModels && !explicitLocal) {
                startRuntimeRecovery(runLocalModelsPrep);
              } else {
                await runLocalModelsPrep();
              }
            }
          } else if (restoredLocal) {
            // Setup originally chose a subscription runtime, then the person
            // switched to local mode on Settings -> Models. Preserve local mode
            // and restore the saved local model instead of overwriting
            // model-source.json back to subscription.
            runtimeOutcome = await prepareByokNativeRuntime(
              restoredLocal.runtime,
              {
                home,
                signal,
                onEvent: emit,
                ...(options.resume
                  ? { reuseInstalled: true }
                  : {
                      env: await managedRuntimeEnvironment(home, current.root),
                    }),
                onDescriptor: (descriptor) =>
                  options.onRuntimeDescriptors?.([descriptor]),
              },
            );
            if (!runtimeOutcome) {
              startRuntimeRecovery(async () => {
                await restoreSavedLocalModel();
              });
            }
          } else {
            runtimeOutcome = await prepareRuntime(choice, {
              home,
              signal,
              onEvent: emit,
              ...(options.resume
                ? { reuseInstalled: true }
                : { env: await managedRuntimeEnvironment(home, current.root) }),
              onDescriptor: (descriptor) =>
                options.onRuntimeDescriptors?.([descriptor]),
            });
            if (
              choice !== "pi" &&
              (runtimeOutcome.code === 0 ||
                (runtimeOutcome.details as { code?: string } | undefined)
                  ?.code === "RUNTIME_AUTH_REQUIRED")
            ) {
              if (options.setupChoice !== undefined) {
                runtimeOutcome =
                  (await applyNativeSource(home, "subscription", choice, {
                    signal,
                    onEvent: emit,
                  })) ?? runtimeOutcome;
              } else {
                const hasPendingLocal =
                  await hasPendingLibraryModelsToRestore(home);
                if (!hasPendingLocal) {
                  runtimeOutcome =
                    (await applyNativeSource(home, "subscription", choice, {
                      signal,
                      onEvent: emit,
                    })) ?? runtimeOutcome;
                } else {
                  startRuntimeRecovery(async () => {
                    await restoreSavedLocalModel();
                  });
                }
              }
            } else if (
              choice === "pi" &&
              options.setupChoice === undefined &&
              (runtimeOutcome.code === 0 ||
                (runtimeOutcome.details as { code?: string } | undefined)
                  ?.code === "RUNTIME_AUTH_REQUIRED")
            ) {
              startRuntimeRecovery(async () => {
                if (await hasPendingLibraryModelsToRestore(home))
                  await restoreSavedLocalModel();
              });
            }
          }
          if (
            runtimeOutcome &&
            runtimeOutcome.code !== 0 &&
            (runtimeOutcome.details as { code?: string } | undefined)?.code !==
              "RUNTIME_AUTH_REQUIRED" &&
            !controller.signal.aborted
          ) {
            runtimeAborted = true;
            controller.abort();
          }
        } catch (error) {
          runtimeError = error;
          if (!controller.signal.aborted) {
            runtimeAborted = true;
            controller.abort();
          }
        } finally {
          runtimePending = false;
        }
      })();
      try {
        step("release", "Preparing private native toolchains and PostgreSQL…");
        // Each part of the release stage logs its time, so a slow install
        // says which part was slow.
        const timed = async <T>(
          what: string,
          run: () => Promise<T>,
          timedOptions: {
            detail?: (value: T) => string;
            stage?: InstallStage;
          } = {},
        ): Promise<T> => {
          const startedAt = Date.now();
          const value = await run();
          const detail = timedOptions.detail?.(value) ?? "";
          emit({
            kind: "log",
            stage: timedOptions.stage ?? stage,
            message: `${what} took ${((Date.now() - startedAt) / 1000).toFixed(1)}s${detail}.\n`,
          });
          return value;
        };
        // The desktop puts the TeamHub binaries it ships into the checkout,
        // and unpacks the services it built into the checkout.
        let checked = "";
        const [binaries, bundled] = await Promise.all([
          timed(
            "Checking the bundled TeamHub binaries",
            () => checkTeamhubBinaries(current.source!.repo),
            { detail: (state) => ` (${state})` },
          ),
          options.externalComputer
            ? timed(
                "Checking the bundled Native services",
                () =>
                  checkNativeRuntime(current.source!.repo, {
                    signal,
                    checked: (how, files) => {
                      checked = `, ${files} files by ${how === "sizes" ? "size" : "sha256"}`;
                    },
                  }),
                { detail: (state) => ` (${state}${checked})` },
              )
            : Promise.resolve(false as const),
        ]);
        signal.throwIfAborted();
        const offline = bundled === "verified";
        if (
          binaries !== "verified" &&
          !(await canCompileTeamhubFromSource(current.source!.repo))
        ) {
          throw new Error(
            binaries === "removed"
              ? "The bundled TeamHub binaries are damaged and could not be verified. Reinstall Linger to restore them."
              : "The bundled TeamHub binaries are missing and this release does not include Go source files to compile them. Reinstall Linger to restore them.",
          );
        }
        if (
          options.externalComputer &&
          !offline &&
          !(await canBuildNativeServicesFromSource(current.source!.repo))
        ) {
          throw new Error(
            bundled === "removed"
              ? "The bundled offline Linger services are damaged and could not be verified. Reinstall Linger to restore them."
              : "The bundled offline Linger services are unavailable (for example due to an incomplete install or Linux older than glibc 2.35) and this release does not include source files to build them. Reinstall Linger to restore them.",
          );
        }
        if (binaries !== "absent")
          emit({
            kind: "log",
            stage,
            message:
              binaries === "verified"
                ? "Using the bundled TeamHub binaries; Go is not needed.\n"
                : "The bundled TeamHub binaries do not verify; compiling TeamHub instead.\n",
          });
        if (bundled && bundled !== "absent")
          emit({
            kind: "log",
            stage,
            message:
              bundled === "verified"
                ? "Using the bundled Native services; no packages are installed.\n"
                : "The bundled Native services do not verify; installing the checkout's packages instead.\n",
          });
        // Voice needs LiveKit and ffmpeg; the desktop ships them for each
        // computer. They run whether or not a voice key is set, so a key
        // saved later in the app works without a reinstall. A computer
        // without them, or a failed preparation, keeps voice off and the
        // install going; TeamHub then reports voice as unavailable. Both
        // operations lock the shared native-tools directory, so they run
        // sequentially here.
        const tools = await timed(
          "Preparing the private toolchains and PostgreSQL",
          () =>
            prepareNativeDependencies({
              repo: current.source!.repo,
              home,
              signal,
              onEvent: emit,
              go: binaries !== "verified",
              packages: !offline,
            }),
        );
        if (!voiceDeferred && !voicePlanFailed && !voicePortUnavailable) {
          const voiceTools = await timed("Preparing the voice tools", () =>
            prepareNativeVoiceTools({
              home,
              signal,
              onEvent: emit,
            }),
          ).catch((error: unknown) => {
            if (signal.aborted) throw error;
            emit({
              kind: "log",
              stage,
              message: `The voice tools could not be prepared: ${error instanceof Error ? error.message : String(error)}\n`,
            });
            return undefined;
          });
          if (!voiceTools)
            emit({
              kind: "log",
              stage,
              message:
                "Voice stays off: this installation has no voice tools for this computer.\n",
            });
          voice = configured.liveKit ? voiceTools : undefined;
        } else if (voicePlanFailed) {
          emit({
            kind: "log",
            stage,
            message:
              "Voice stays off: this installation has no voice tools for this computer.\n",
          });
        }
        // node-services downloads its voice model packages from the region's
        // registry first, and nothing it starts probes again. On a cold offline
        // install with no cached region, start the probe in the background so
        // release, database initialization, and migrations never wait on the
        // network, then finalize the service region right before services start.
        let regionInfo: RegionResolutionInfo | undefined;
        let regionResolved = false;
        const immediateRegion = await cachedRegion(home, {
          signal,
          onResolved: (info) => {
            regionInfo = info;
          },
        });
        let region: Region;
        if (immediateRegion) {
          region = immediateRegion;
          regionResolved = true;
          emit({
            kind: "log",
            stage,
            message: regionInfo
              ? `${formatRegionResolution(regionInfo)}\n`
              : `Download region: ${region}.\n`,
          });
        } else {
          region = "global";
          regionProbeController = new AbortController();
          const regionProbeSignal = AbortSignal.any([
            signal,
            regionProbeController.signal,
          ]);
          void resolveRegion(home, { signal: regionProbeSignal }).catch(
            () => undefined,
          );
        }
        const baseEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...tools.env,
          ...configured.env,
          SIMPLEX_REGION: region,
        };
        // Only TeamHub gets the identity key and pre-reserved voice tools bin
        // (serviceOptions); no other service reads them.
        delete baseEnv.TEAMHUB_LOCAL_IDENTITY_KEY;
        delete baseEnv.TEAMHUB_VOICE_TOOLS_BIN;
        const buildEnv = (): NodeJS.ProcessEnv => ({
          ...baseEnv,
          ...(voice
            ? {
                // TeamHub and the voice workers run ffmpeg and ffprobe from PATH.
                PATH: [voice.bin, tools.env.PATH]
                  .filter(Boolean)
                  .join(path.delimiter),
              }
            : { TEAMHUB_VOICE_MEDIA: "off" }),
        });
        let env = buildEnv();
        await timed("Protecting the instance data directories", () =>
          Promise.all(
            ["data/agent", "data/artifacts", "native"].map((directory) =>
              privateDirectory(path.join(current.root, directory)),
            ),
          ),
        );
        const command = async (
          operation: string,
          commandOptions: {
            extraEnv?: NodeJS.ProcessEnv;
            input?: string;
            sink?: { write(chunk: string): void };
            stage?: InstallStage;
            retried?: boolean;
            signal?: AbortSignal;
          } = {},
        ): Promise<void> => {
          const {
            extraEnv = {},
            input,
            sink,
            retried = false,
            stage: commandStage = stage,
            signal: commandSignal = signal,
          } = commandOptions;
          const startedAt = Date.now();
          const ownedSink = sink
            ? undefined
            : lineRedactor((message) =>
                emit({ kind: "log", stage: commandStage, message }),
              );
          const activeSink = sink ?? ownedSink!;
          const heartbeat = setInterval(
            () =>
              emit({
                kind: "log",
                stage: commandStage,
                message: `Native ${operation} is running (${Math.floor((Date.now() - startedAt) / 1000)}s elapsed).\n`,
              }),
            10_000,
          );
          // The end of the output, to tell a missing compiler from other failures.
          let tail = "";
          let code: number;
          try {
            ({ code } = await runProcess(
              process.execPath,
              [
                path.join(current.source!.repo, "scripts/source-native.mjs"),
                operation,
              ],
              {
                cwd: current.source!.repo,
                env: { ...env, ...extraEnv },
                signal: commandSignal,
                timeoutMs: 30 * 60_000,
                input,
                capture: false,
                onOutput: (chunk) => {
                  activeSink.write(chunk);
                  tail = (tail + chunk).slice(-64_000);
                },
              },
            ));
          } finally {
            clearInterval(heartbeat);
            ownedSink?.flush();
          }
          if (code === 0) return;
          // Prebuilt binaries cover every native module, but when one has to
          // compile after all a Mac needs Apple's tools; install them and retry.
          if (
            !retried &&
            (await needsAppleDeveloperTools(tail, { signal: commandSignal }))
          ) {
            const installing = "Installing Apple developer tools…";
            emit({
              kind: "stage",
              stage: commandStage,
              state: "running",
              message: installing,
            });
            await installAppleDeveloperTools({
              signal: commandSignal,
              onWaiting: (seconds) =>
                emit({
                  kind: "log",
                  stage: commandStage,
                  message: `${installing} Choose Install in the window macOS opened (${seconds}s elapsed).\n`,
                }),
            });
            emit({
              kind: "log",
              stage: commandStage,
              message: `Apple developer tools are installed. Running native ${operation} again.\n`,
            });
            return command(operation, { ...commandOptions, retried: true });
          }
          throw new Error(`Native source ${operation} failed (exit ${code}).`);
        };
        // pnpm reports "Progress: resolved N, reused R, downloaded D, added A";
        // those lines become the stage counter instead of log noise.
        const packages = lineRedactor((line) => {
          const counts =
            /^Progress: resolved (\d+), reused \d+, downloaded \d+, added (\d+)/.exec(
              line,
            );
          if (!counts) return emit({ kind: "log", stage, message: line });
          const [total, completed] = [Number(counts[1]), Number(counts[2])];
          if (completed > 0)
            emit({
              kind: "log",
              stage,
              message: `Installing dependencies: ${completed} of ${total} packages\n`,
              progress: { completed, total, unit: "packages" },
            });
        });
        // A failed install retries from the next registry; the packages it
        // already fetched stay in the store. Later installs start from the
        // registry that worked.
        let registries = tools.registries;
        const install = async (operation: string) => {
          for (const [index, registry] of registries.entries()) {
            try {
              await command(operation, {
                extraEnv: npmRegistryEnvironment(registry),
                sink: packages,
              });
              registries = registries.slice(index);
              if (index > 0)
                await recordRegionFallback(home, sourceRegion(registry));
              return;
            } catch (error) {
              signal.throwIfAborted();
              const next = registries[index + 1];
              if (!next) throw error;
              emit({
                kind: "log",
                stage,
                message: `Dependency installation from ${new URL(registry).host} failed; retrying with ${new URL(next).host}.\n`,
              });
            } finally {
              packages.flush();
            }
          }
        };
        step(
          "images",
          "Installing checkout dependencies and building its native Computer release…",
        );
        if (!offline) await install("prepare");
        if (!options.externalComputer) {
          await install("prepare-computer");
          await command("computer-release");
        }
        emit({
          kind: "stage",
          stage,
          state: offline ? "skipped" : "succeeded",
          message: offline
            ? "The bundled Native services need no dependencies."
            : options.externalComputer
              ? "Source dependencies are ready."
              : "Source dependencies and native Computer release are ready.",
        });
        step(
          "services",
          "Starting private PostgreSQL and applying migrations…",
        );
        await reclaimEarlierProcesses(current, home, emit);
        // Spawn the detached voice-tools worker strictly AFTER orphan cleanup
        // so Windows orphan reclamation never kills the freshly spawned worker.
        if (voiceDeferred && configured.liveKit && voiceLauncher) {
          backgroundVoice = voiceLauncher({
            home,
            instanceName: current.name,
            env: { ...process.env },
          });
          if (backgroundVoice) {
            emit({
              kind: "log",
              stage,
              message: "Preparing private voice tools in the background.\n",
            });
          } else {
            await releaseLiveKitPort();
            voiceDeferred = false;
            const voiceTools = await timed("Preparing the voice tools", () =>
              prepareNativeVoiceTools({
                home,
                signal,
                onEvent: emit,
              }),
            ).catch((error: unknown) => {
              if (signal.aborted) throw error;
              emit({
                kind: "log",
                stage,
                message: `The voice tools could not be prepared: ${error instanceof Error ? error.message : String(error)}\n`,
              });
              return undefined;
            });
            if (!voiceTools) {
              voice = undefined;
              emit({
                kind: "log",
                stage,
                message:
                  "Voice stays off: this installation has no voice tools for this computer.\n",
              });
            } else {
              voice = voiceTools;
            }
            env = buildEnv();
          }
        }
        // The services read user.env, the credentials and the voice tools from
        // their environment, which their command line does not cover: a
        // change restarts them.
        const shared = {
          env: configured.env,
          // Tool availability only: a voice key saved in the app or user.env
          // changes env, not this.
          voice: voice ? voice.bin : "off",
        };
        const settings = JSON.stringify(shared);
        // The Desktop's system proxy goes only to TeamHub, for every https
        // call it makes to the outside, and to node-services, whose voice
        // workers tunnel Soniox and xAI through it; a changed proxy restarts
        // them. Without one their settings stay as they were, so nothing
        // restarts for it.
        const proxyEnv = systemProxyEnvironment(env);
        const proxied = proxyEnv.HTTPS_PROXY
          ? { proxy: proxyEnv.HTTPS_PROXY }
          : {};
        const nodeServicesSettings = JSON.stringify({ ...shared, ...proxied });
        // TeamHub also restarts for a new identity key; the digest keeps the
        // key itself out of the process record.
        const teamhubSettings = JSON.stringify({
          ...shared,
          ...proxied,
          identity: createHash("sha256").update(identityKey).digest("hex"),
        });
        const storedBefore = await loadInstance({ name: current.name, home });
        const switchingCheckout = Boolean(
          storedBefore?.source &&
          storedBefore.releaseDir !== current.releaseDir,
        );
        const [teamhubState, nodeServicesState, webState, postgresState] =
          await inspectNativeProcesses(current.root, [
            "teamhub",
            "node-services",
            "web",
            "postgres",
          ]);
        const anyServiceRunning = Boolean(
          teamhubState?.running ||
          nodeServicesState?.running ||
          webState?.running,
        );
        const postgresWasRunning = Boolean(postgresState?.running);
        // Mark before startup so a failed init/readiness step can stop a process
        // it managed to create without touching a previously running cluster.
        if (!postgresWasRunning) started.push("postgres");
        const { legacyBackup } = await timed(
          "Preparing private PostgreSQL",
          () =>
            prepareNativeDatabase({
              instance: current,
              postgresBin: tools.postgresBin,
              postgresConfigurationExecutable:
                tools.postgresConfigurationExecutable,
              env,
              signal,
              onOutput: (chunk) => output.write(chunk),
            }),
        );
        if (legacyBackup)
          emit({
            kind: "log",
            stage,
            message: `The data from the earlier Simplex app can't be upgraded to Linger, so Linger starts with a fresh workspace. The earlier data was moved, not deleted, to ${legacyBackup}.\n`,
          });
        // Emits the services stage and captures the log ends that
        // waitHealthy reads, before any service starts.
        const beginServices = () => {
          emit({
            kind: "stage",
            stage: "services",
            state: "running",
            message: "Starting native collaboration services…",
          });
          return logEnds(current);
        };
        // Bind LiveKit's saved port before the model controller asks the OS
        // for its own port; an unbound port can be assigned to either service.
        const bindLiveKit = async () => {
          if (voiceDeferred) return;
          const liveKit = voice && (await readLiveKitSettings(current.root));
          if (voice && liveKit) {
            if (!(await inspectNativeProcess(current.root, "livekit")).running)
              started.push("livekit");
            await startNativeLiveKit({
              root: current.root,
              executable: voice.livekit,
              settings: liveKit,
              signal,
            });
          } else if (
            (await inspectNativeProcess(current.root, "livekit")).running
          )
            await stopNativeProcess(current.root, "livekit");
        };
        const finalizeServiceRegion = async () => {
          if (regionResolved) return;
          regionResolved = true;
          signal.throwIfAborted();
          let lateInfo: RegionResolutionInfo | undefined;
          const lateRegion = await cachedRegion(home, {
            signal,
            onResolved: (info) => {
              lateInfo = info;
            },
          });
          baseEnv.SIMPLEX_REGION = lateRegion ?? "global";
          env = buildEnv();
          emit({
            kind: "log",
            stage: "services",
            message: lateRegion
              ? lateInfo
                ? `${formatRegionResolution(lateInfo)}\n`
                : `Download region: ${lateRegion}.\n`
              : "Download region: global (probe pending; continuing offline startup).\n",
          });
        };
        const provisionOwner = async (
          email: string,
          password: string,
          ownerOptions: { signal?: AbortSignal; stage?: InstallStage } = {},
        ) => {
          if (!secrets.includes(password)) secrets.push(password);
          await command("owner", {
            extraEnv: { OWNER_EMAIL: email },
            input: `${password}\n`,
            stage: ownerOptions.stage ?? "account",
            signal: ownerOptions.signal ?? signal,
          });
        };
        const startAndAwaitServices = async (
          ends: Awaited<ReturnType<typeof logEnds>>,
        ) => {
          const serviceOptions = (
            name: "teamhub" | "node-services" | "web",
          ) => ({
            root: current.root,
            name,
            executable: process.execPath,
            args: [
              path.join(current.source!.repo, "scripts/source-native.mjs"),
              name,
            ],
            cwd: current.source!.repo,
            env:
              name === "teamhub"
                ? {
                    ...env,
                    ...proxyEnv,
                    TEAMHUB_LOCAL_IDENTITY_KEY: identityKey,
                    ...(voice ? { TEAMHUB_VOICE_TOOLS_BIN: voice.bin } : {}),
                  }
                : name === "node-services"
                  ? { ...env, ...proxyEnv }
                  : env,
            signal,
            redactions: secrets,
            // A changed user.env, port, credential, voice tool or system
            // proxy restarts it.
            settings:
              name === "teamhub"
                ? teamhubSettings
                : name === "node-services"
                  ? nodeServicesSettings
                  : settings,
            restartOnConfigurationChange: true,
            // Its supervisor brings it back when it exits unasked, so the
            // window does not wait on a dead port until the next launch.
            restartOnExit: SERVICE_RESTART_POLICY,
          });
          // Stop the Agent Service before TeamHub restarts for a changed
          // configuration, so it can requeue in-flight Runs while TeamHub is
          // still up. When web's configuration also changed, stop it
          // concurrently alongside node-services so all three services then
          // start concurrently via Promise.allSettled (unchanged web stays up).
          // Pre-stopped node-services and web, like pre-existing teamhub, stay
          // untracked in `started` so rollback does not stop previously running
          // services. When TeamHub is not running or not changing,
          // node-services is left alone so it can reconnect.
          const preStopped =
            (await nativeConfigurationChanged(serviceOptions("teamhub"))) &&
            (await inspectNativeProcess(current.root, "node-services")).running;
          const webPreStop =
            preStopped &&
            (await nativeConfigurationChanged(serviceOptions("web"))) &&
            (await inspectNativeProcess(current.root, "web")).running;
          signal.throwIfAborted();
          if (preStopped) {
            if (webPreStop) {
              const stopped = await Promise.allSettled([
                stopNativeProcess(current.root, "node-services"),
                stopNativeProcess(current.root, "web"),
              ]);
              const stopFailed = stopped.find(
                (result) => result.status === "rejected",
              );
              if (stopFailed) throw stopFailed.reason;
            } else {
              await stopNativeProcess(current.root, "node-services");
            }
          }
          const serviceNames = ["teamhub", "node-services", "web"] as const;
          const states = await inspectNativeProcesses(
            current.root,
            serviceNames,
          );
          for (const [index, name] of serviceNames.entries()) {
            if (
              !states[index]!.running &&
              !(preStopped && name === "node-services") &&
              !(webPreStop && name === "web")
            )
              started.push(name);
          }
          await finalizeServiceRegion();
          // Settle every start before rollback so a supervisor still being
          // spawned is recorded and can be stopped.
          const results = await Promise.allSettled(
            serviceNames.map((name) =>
              startNativeProcess(serviceOptions(name)),
            ),
          );
          const failed = results.find((result) => result.status === "rejected");
          if (failed) throw failed.reason;
          // Pre-provision the local owner directly in PostgreSQL while
          // collaboration services become healthy so ensureLocalAccount hits
          // HTTP 200 on its first login check. Launched strictly after every
          // service spawn settles so `started` is complete, and drained before
          // returning or rethrowing so no owner process races with rollback or
          // ensureLocalAccount.
          const preProvisionController = new AbortController();
          const preProvisionSignal = AbortSignal.any([
            signal,
            preProvisionController.signal,
          ]);
          const preProvision = preProvisionLocalAccount(
            current,
            preProvisionSignal,
            {
              email: options.email,
              password: options.password,
              provisionOwner: (email, password) =>
                provisionOwner(email, password, {
                  signal: preProvisionSignal,
                  stage: "services",
                }),
            },
          );
          preProvision.catch(() => undefined);
          let probed: ServiceReadiness[];
          try {
            probed = await timed(
              "Waiting for native collaboration services",
              () => waitHealthy(current, signal, emit, ends),
              { stage: "services" },
            );
          } catch (error) {
            preProvisionController.abort();
            await preProvision.catch(() => undefined);
            throw error;
          }
          await preProvision.catch(() => undefined);
          signal.throwIfAborted();
          return probed;
        };
        const provisionAccount = () =>
          ensureLocalAccount(current, signal, {
            email: options.email,
            password: options.password,
            provisionOwner: (email, password) =>
              provisionOwner(email, password, { signal, stage: "account" }),
          });
        const overlapWithRuntime =
          !switchingCheckout &&
          !anyServiceRunning &&
          (Boolean(options.resume) ||
            (Boolean(options.setupChoice || options.byok) &&
              (!hadProvisionedAccount || Boolean(legacyBackup))));
        // Without `stageForLogs`, timings log under the current stage.
        const prepareLocalStackServices = async (
          stageForLogs?: InstallStage,
        ) => {
          const runLocalStack = async () => {
            const foundationMainPlan =
              !restoredByok &&
              !options.byok &&
              !(!explicitLocal && saved && saved.mode !== "local");
            await timed(
              "Preparing foundation services",
              () =>
                prepareFoundationServices(current, choice, {
                  home,
                  signal,
                  onEvent: emit,
                  shareGpu: options.shareGpu,
                  mainPlan: foundationMainPlan,
                }),
              { stage: stageForLogs },
            );
            // Binds the local stack's gateway for local models; with a runtime's own
            // sign-in, retires one an earlier release started.
            await prepareModelGateway(
              current,
              // A restored BYOK or subscription source keeps its own gateway
              // choice whatever setup-choice.json recorded: a local-models
              // choice would require the local stack.
              restoredByok
                ? { runtime: restoredByok.runtime, modelSource: "byok" }
                : options.byok
                  ? {
                      runtime:
                        choice === "local-models"
                          ? (options.byok.runtime ?? "claude")
                          : choice,
                      modelSource: "byok",
                    }
                  : restoredSubscription
                    ? restoredSubscription.runtime
                    : choice,
              {
                home,
                signal,
                onEvent: emit,
              },
            );
          };
          if (localModelsDegraded) {
            try {
              await runLocalStack();
            } catch (error) {
              signal.throwIfAborted();
              emit({
                kind: "log",
                stage: stageForLogs ?? "runtime",
                message: `Local model gateway preparation skipped during degraded resume: ${error instanceof Error ? error.message : String(error)}\n`,
              });
            }
          } else {
            await runLocalStack();
          }
        };
        const prepareLocalStackWithRecovery = async (
          stageForLogs?: InstallStage,
        ) => {
          await awaitRuntimeRecovery();
          await prepareLocalStackServices(stageForLogs);
        };
        const prepareRuntimeSide = async (stageForLogs?: InstallStage) => {
          await timed("Waiting for runtime preparation", () => runtime, {
            stage: stageForLogs,
          });
          signal.throwIfAborted();
          await prepareLocalStackWithRecovery(stageForLogs);
        };
        const migrate = (stageForLogs?: InstallStage) =>
          timed(
            "Running database migrations",
            () => command("migrate", { stage: stageForLogs }),
            { stage: stageForLogs },
          );
        const servicesSucceeded = async () => {
          await saveSourceBinding(current);
          emit({
            kind: "stage",
            stage: "services",
            state: "succeeded",
            message: "Native source services are ready.",
          });
        };
        const accountSucceeded = () =>
          emit({
            kind: "stage",
            stage: "account",
            state: "succeeded",
            message: "Local account is ready.",
          });
        // Runs the runtime/local-stack branch concurrently with service startup
        // and account verification. Each wall-clock second counts once toward
        // the critical path: services and account while branch2 runs, then
        // runtime only for any wait beyond a fulfilled branch2.
        const runParallelTail = async (
          branch1Work: () => Promise<void>,
          branch2Work: (
            setBranchStage: (next: InstallStage) => void,
          ) => Promise<{ service: string; ready: boolean }[]>,
        ): Promise<{ service: string; ready: boolean }[]> => {
          let firstFailure: { error: unknown; stage: InstallStage } | undefined;
          const failBranch = (
            error: unknown,
            failedStage: InstallStage,
          ): never => {
            firstFailure ??= { error, stage: failedStage };
            controller.abort();
            throw error;
          };
          const branch1 = (async () => {
            try {
              await branch1Work();
            } catch (error) {
              return failBranch(error, "runtime");
            }
          })();
          const branch2 = (async () => {
            let branchStage: InstallStage = "services";
            try {
              return await branch2Work((next) => {
                branchStage = next;
              });
            } catch (error) {
              return failBranch(error, branchStage);
            }
          })();
          let branch1Pending = true;
          const settled1 = Promise.allSettled([branch1]).then(([result]) => {
            branch1Pending = false;
            return result;
          });
          const [result2] = await Promise.allSettled([branch2]);
          if (branch1Pending && result2.status === "fulfilled")
            timer.enter("runtime");
          const result1 = await settled1;
          if (result1.status === "rejected" || result2.status === "rejected") {
            stage = runtimeAborted
              ? "runtime"
              : (firstFailure?.stage ??
                (result1.status === "rejected" ? "runtime" : "services"));
            throw firstFailure
              ? firstFailure.error
              : result1.status === "rejected"
                ? result1.reason
                : (result2 as PromiseRejectedResult).reason;
          }
          return result2.value;
        };
        let checks: { service: string; ready: boolean }[];
        if (overlapWithRuntime) {
          // LiveKit binds before the fork so the runtime branch's foundation
          // services can never take its port.
          const ends = await beginServices();
          await bindLiveKit();
          timer.enter("services");
          checks = await runParallelTail(
            () => prepareRuntimeSide("runtime"),
            async (setStage) => {
              await migrate("services");
              const probed = await startAndAwaitServices(ends);
              setStage("account");
              timer.enter("account");
              emit({
                kind: "stage",
                stage: "account",
                state: "running",
                message: "Preparing local account and workspace…",
              });
              await provisionAccount();
              return probed;
            },
          );
          await servicesSucceeded();
          stage = "account";
          accountSucceeded();
        } else {
          // The runtime is ready before the checkout's migrations run: when it is
          // not, services still running from an earlier checkout keep the
          // schema they know. Count only the runtime wait beyond the parallel work.
          if (runtimePending) timer.enter("runtime");
          await timed("Waiting for runtime preparation", () => runtime);
          signal.throwIfAborted();
          timer.enter("services");
          await migrate();
          const ends = await beginServices();
          await bindLiveKit();
          // LiveKit has bound its port and migrations have succeeded; await any
          // eager background runtime recovery, then run foundation and gateway
          // preparation in parallel with service startup and account
          // verification.
          checks = await runParallelTail(
            () => prepareLocalStackWithRecovery("runtime"),
            async (setStage) => {
              const probed = await startAndAwaitServices(ends);
              setStage("account");
              timer.enter("account");
              emit({
                kind: "stage",
                stage: "account",
                state: "running",
                message: "Preparing local account and workspace…",
              });
              await provisionAccount();
              return probed;
            },
          );
          await servicesSucceeded();
          stage = "account";
          accountSucceeded();
          signal.throwIfAborted();
        }
        const finalizeBackgroundVoice = async () => {
          if (!backgroundVoice) return;
          await releaseLiveKitPort();
          commitBackgroundVoice();
          emit({
            kind: "log",
            stage: "services",
            message:
              "Voice tools preparation and LiveKit startup are continuing in the background.\n",
          });
        };
        if (options.externalComputer) {
          const authPending =
            (runtimeOutcome?.details as { code?: string } | undefined)?.code ===
            "RUNTIME_AUTH_REQUIRED";
          emit({
            kind: "stage",
            stage: "computer",
            state: "skipped",
            message: "The desktop client connects this Computer after sign-in.",
          });
          emit({
            kind: "stage",
            stage: "runtime",
            state: authPending ? "waiting_user" : "succeeded",
            message: authPending
              ? "Runtime sign-in can be completed later."
              : "Runtime is ready.",
          });
          await finalizeBackgroundVoice();
          return {
            code: 0,
            state: "ready",
            message: `Native source services are running: ${current.origin}`,
            details: {
              origin: current.origin,
              services: checks,
              computer: {
                state: "action_required",
                connected: false,
                detail:
                  "The desktop client connects this Computer after sign-in.",
                runtimes: [],
                activeOperations: 0,
              },
              businessVerification: "not_run",
              ...(byokGateway ? { byokGateway } : {}),
              ...(localModelsDegraded ? { localModelsDegraded } : {}),
              ...(localModelsRestored ? { localModelsRestored: true } : {}),
              ...(restoredLocalModels.size
                ? { restoredLocalModels: [...restoredLocalModels] }
                : {}),
            },
          };
        }
        step("computer", "Connecting this Computer to the native workspace…");
        try {
          await prepareSourceComputer(current, signal, (value) =>
            output.write(value),
          );
          const computer = await connectComputer(current, {
            signal,
            interactive: false,
            authorize: () => prepareLocalEnrollment(current, signal),
            onProgress: (value) => output.write(value),
          });
          const authPending =
            (runtimeOutcome?.details as { code?: string } | undefined)?.code ===
            "RUNTIME_AUTH_REQUIRED";
          const ready = computer.state === "ready" && !authPending;
          emit({
            kind: "stage",
            stage: "computer",
            state: computer.connected ? "succeeded" : "waiting_user",
            message: computer.detail,
          });
          emit({
            kind: "stage",
            stage: "runtime",
            state: ready ? "succeeded" : "waiting_user",
            message: ready
              ? "Runtime is ready."
              : "Runtime sign-in can be completed later.",
          });
          await finalizeBackgroundVoice();
          return {
            code: ready ? 0 : 4,
            state: ready ? "ready" : "action_required",
            message: `Native source services are running: ${current.origin}\n${computer.detail}`,
            details: {
              origin: current.origin,
              services: checks,
              computer,
              businessVerification: "not_run",
              ...(byokGateway ? { byokGateway } : {}),
              ...(localModelsDegraded ? { localModelsDegraded } : {}),
              ...(localModelsRestored ? { localModelsRestored: true } : {}),
              ...(restoredLocalModels.size
                ? { restoredLocalModels: [...restoredLocalModels] }
                : {}),
              ...(authPending && typeof runtimeOutcome?.details === "object"
                ? runtimeOutcome.details
                : {}),
            },
          };
        } catch (error) {
          options.signal.throwIfAborted();
          const detail = safe(
            error instanceof Error
              ? error.message
              : "Computer connection requires attention.",
          );
          const services = await probeNativeSourceServices(
            current,
            options.signal,
          );
          await finalizeBackgroundVoice();
          return {
            code: 4,
            state: "action_required",
            message: `Native source services are running: ${current.origin}\n${detail}`,
            details: {
              code: "COMPUTER_SETUP_REQUIRED",
              origin: current.origin,
              services,
              computer: {
                state: "action_required",
                connected: false,
                detail,
                runtimes: [],
                activeOperations: -1,
              },
              businessVerification: "not_run",
            },
          };
        }
      } catch (error) {
        // The side that failed first is the cause; the other one only
        // stopped because of it.
        const runtimeFailedFirst = runtimeAborted;
        abortRegionProbe();
        abortBackgroundVoice();
        await releaseLiveKitPort();
        controller.abort();
        await runtime;
        await runtimeRecovery;
        for (const name of started.reverse()) {
          try {
            await stopNativeProcess(current.root, name);
          } catch {
            emit({
              kind: "log",
              stage,
              message: `Native ${name} cleanup needs attention; its identity record was retained.`,
            });
          }
        }
        options.signal.throwIfAborted();
        if (runtimeFailedFirst) {
          stage = "runtime";
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrows the first failure unchanged
          if (runtimeError) throw runtimeError;
          if (
            runtimeOutcome &&
            runtimeOutcome.code !== 0 &&
            (runtimeOutcome.details as { code?: string } | undefined)?.code !==
              "RUNTIME_AUTH_REQUIRED"
          ) {
            const message = safe(runtimeOutcome.message);
            if (
              runtimeOutcome.state === "failed" ||
              runtimeOutcome.state === "prerequisite_unavailable"
            )
              emit({ kind: "stage", stage, state: "failed", message });
            return {
              ...runtimeOutcome,
              message,
              details: {
                ...(typeof runtimeOutcome.details === "object"
                  ? runtimeOutcome.details
                  : {}),
                stage,
              },
            };
          }
        }
        throw error;
      } finally {
        abortRegionProbe();
        abortBackgroundVoice();
        await releaseLiveKitPort();
        controller.abort();
        await runtime;
        await runtimeRecovery;
      }
    });
  } catch (error) {
    const interrupted = options.signal.aborted;
    const versionFailure = runtimeVersionFailure(error);
    // An abort nobody asked for has no cause of its own to show; name the
    // step instead of the bare "This operation was aborted".
    const unexplained =
      !interrupted && error instanceof Error && error.name === "AbortError";
    const detail =
      versionFailure?.message ??
      (unexplained
        ? `Setup stopped unexpectedly while ${STAGE_ACTIVITY[stage]}. Retry; if it stops again, send the installer log to support.`
        : safe(
            error instanceof Error
              ? error.message
              : "Native source installation failed.",
          ));
    if (error instanceof Error)
      emit({
        kind: "log",
        stage,
        message: `Native source installation ended in ${stage}: ${error.name}: ${error.message}\n`,
      });
    emit({ kind: "stage", stage, state: "failed", message: detail });
    return {
      code: interrupted ? 130 : 1,
      state: interrupted ? "cancelled" : "failed",
      message: `${detail}\nData is retained. Retry the installation.`,
      details: {
        code: versionFailure?.code ?? "NATIVE_SOURCE_INSTALLATION_FAILED",
        stage,
        ...(instance ? { origin: instance.origin } : {}),
      },
    };
  } finally {
    output.flush();
  }
}
/**
 * Ends the processes of this instance an earlier run lost track of (an
 * earlier release's stop left them, their supervisor died, or a failed
 * attempt kept no record of them), so they neither hold the ports and data
 * files nor answer health checks for the new services.
 */
async function reclaimEarlierProcesses(
  instance: Instance,
  home: string,
  onEvent?: (event: InstallerEvent) => void,
) {
  const source = requireNative(instance);
  const liveKit = await readLiveKitSettings(instance.root);
  const ended = await reclaimNativeOrphans(instance.root, {
    ports: [
      ...Object.values(source.ports),
      ...(liveKit ? [liveKit.httpPort] : []),
    ],
    paths: [home, instance.root, source.repo],
  });
  if (ended.length)
    onEvent?.({
      kind: "log",
      stage: "services",
      message: `Ended ${ended.length} Linger processes an earlier run left behind (PIDs ${ended.join(", ")}).\n`,
    });
}
export async function stopNativeSource(
  instance: Instance,
  signal?: AbortSignal,
  options: { log?: (message: string) => void } = {},
) {
  requireNative(instance);
  await withInstanceLock(instance, async () => {
    const timings: [string, string][] = [];
    const seconds = (ms: number) => (ms / 1000).toFixed(1);
    const timedStep = async (
      name: string,
      label: string,
      run: () => Promise<void>,
    ) => {
      const startedAt = Date.now();
      let failed = false;
      try {
        await run();
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        const elapsed = seconds(Date.now() - startedAt);
        timings.push([name, elapsed]);
        options.log?.(
          failed
            ? `Stopping ${label} failed after ${elapsed}s.`
            : `Stopped ${label} in ${elapsed}s.`,
        );
      }
    };
    try {
      signal?.throwIfAborted();
      await timedStep("computer", "native computer", () =>
        stopComputer(instance, { signal }),
      );
      let failedService: NativeService | undefined;
      try {
        await stopNativeProcesses(instance.root, nativeServices, {
          signal,
          onServiceDone: (name, durationMs, error) => {
            const elapsed = seconds(durationMs);
            timings.push([name, elapsed]);
            if (error !== undefined) {
              failedService = name;
              options.log?.(
                `Stopping native ${name} failed after ${elapsed}s.`,
              );
            } else {
              options.log?.(`Stopped native ${name} in ${elapsed}s.`);
            }
          },
        });
      } catch (error) {
        if (!failedService) throw error;
        const code = (error as NodeJS.ErrnoException | null)?.code;
        throw Object.assign(
          new Error(
            error instanceof Error
              ? error.message
              : `Could not stop ${failedService}.`,
            { cause: error },
          ),
          {
            code: code ?? NATIVE_SERVICE_STOP_FAILED,
            nativeService: failedService,
          },
        );
      }
      await timedStep("orphans", "native orphans", () =>
        reclaimEarlierProcesses(instance, path.resolve(instance.root, "../..")),
      );
      await timedStep("gateway", "native model gateway", () =>
        stopModelGateway(instance, signal),
      );
    } finally {
      if (timings.length > 0) {
        options.log?.(
          `Native stop timings (s): ${timings
            .map(([name, elapsed]) => `${name} ${elapsed}`)
            .join(", ")}.`,
        );
      }
    }
  });
}
export async function nativeSourceLogs(
  instance: Instance,
  options: {
    service?: string;
    follow?: boolean;
    signal?: AbortSignal;
    onOutput?: (chunk: string) => void;
  } = {},
) {
  requireNative(instance);
  const names = options.service ? [options.service] : [...nativeServices];
  if (names.some((name) => !nativeServices.includes(name as NativeService)))
    throw new Error("Unknown native source service");
  const positions = new Map<string, number>();
  const streams = new Map<string, ReturnType<typeof lineRedactor>>();
  let stdout = "";
  const write = (name: string, chunk: string) => {
    const labelled = `[${name}] ${chunk}`;
    options.onOutput?.(labelled);
    stdout = (stdout + labelled).slice(-256 * 1024);
  };
  try {
    do {
      options.signal?.throwIfAborted();
      for (const name of names) {
        const file = path.join(instance.root, "native/logs", `${name}.log`);
        let handle;
        try {
          handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        try {
          const info = await handle.stat();
          // Windows reports no owner or mode; the native directory ACL applies.
          if (
            !info.isFile() ||
            (process.platform !== "win32" &&
              (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
          )
            throw new Error("Native logs must be private owned regular files.");
          let offset = positions.get(name);
          const initial = offset === undefined;
          if (offset === undefined) offset = Math.max(0, info.size - 64 * 1024);
          if (offset > info.size) {
            streams.get(name)?.flush();
            streams.delete(name);
            offset = 0;
          }
          let stream = streams.get(name);
          if (!stream) {
            stream = lineRedactor((value) => write(name, value));
            streams.set(name, stream);
          }
          // Read a bounded window from each service per poll, rather than loading
          // an ever-growing log into the installation manager's memory.
          const bytes = Buffer.alloc(
            Math.min(64 * 1024, Math.max(0, info.size - offset)),
          );
          const { bytesRead } = await handle.read(
            bytes,
            0,
            bytes.length,
            offset,
          );
          positions.set(name, offset + bytesRead);
          let text = bytes.subarray(0, bytesRead).toString("utf8");
          if (initial && offset > 0) {
            const boundary = text.indexOf("\n");
            text = boundary < 0 ? "" : text.slice(boundary + 1);
          }
          stream.write(text);
        } finally {
          await handle.close();
        }
      }
      if (!options.follow) break;
      await delay(500, undefined, { signal: options.signal });
    } while (!options.signal?.aborted);
  } finally {
    for (const stream of streams.values()) stream.flush();
  }
  return { stdout, stderr: "", code: 0 };
}
