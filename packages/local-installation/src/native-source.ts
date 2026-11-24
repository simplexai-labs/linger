import { prepareFoundationServices } from "./foundation-services.js";
import { portFree } from "./ports.js";
import { prepareModelGateway, stopModelGateway } from "./model-gateway.js";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, statfs } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  prepareSourceConfiguration,
  saveSourceBinding,
  validateSourceRepository,
  type EnvironmentReport,
  type SourceInstallOptions,
} from "./source-checkout.js";
import {
  loadInstance,
  privateDirectory,
  readLocalIdentityKey,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import {
  prepareNativeDependencies,
  prepareNativeVoiceTools,
} from "./native-dependencies.js";
import { readLiveKitSettings, startNativeLiveKit } from "./native-livekit.js";
import { checkNativeRuntime } from "./native-runtime.js";
import { checkTeamhubBinaries } from "./teamhub-binaries.js";
import { sourceRegion } from "@linger/service-kit";
import { npmRegistryEnvironment } from "./npm-registry.js";
import { recordRegionFallback, resolveRegion } from "./region.js";
import { prepareNativeDatabase } from "./native-database.js";
import {
  inspectNativeListeners,
  inspectNativeProcess,
  nativeConfigurationChanged,
  reclaimNativeOrphans,
  SERVICE_RESTART_POLICY,
  startNativeProcess,
  stopNativeProcess,
  type NativeService,
} from "./native-process.js";
import {
  ensureLocalAccount,
  localAccountProvisioned,
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
import {
  readSetupChoice,
  writeGpuSharing,
  validateSetupChoice,
  writeSetupChoice,
} from "./setup-selection.js";
import {
  isLocalRuntimeModel,
  localModelsDegradedFromError,
  localModelsDegradedFromOutcome,
  prepareLocalModels,
  restoreByokSource,
  restoreLocalModels,
  type LocalModelsDegraded,
} from "./local-models.js";
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
export async function probeNativeSourceServices(
  instance: Instance,
  signal?: AbortSignal,
) {
  const endpoints = probeEndpoints(requireNative(instance));
  const states = await inspectNativeListeners(
    instance.root,
    endpoints.map(([, name, port]) => ({ name, port })),
  ).catch(() => endpoints.map(() => ({ running: false, foreign: undefined })));
  return Promise.all(
    endpoints.map(async ([service, , port, endpoint], index) => {
      const { running, foreign } = states[index]!;
      // Another process on the port would answer the health check for a
      // service that cannot listen there.
      if (foreign !== undefined)
        return { service, ready: false, foreign, port };
      try {
        if (!running) return { service, ready: false };
        const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
          redirect: "error",
          signal: AbortSignal.any([
            ...(signal ? [signal] : []),
            AbortSignal.timeout(2_000),
          ]),
        });
        await response.body?.cancel();
        return { service, ready: response.ok };
      } catch {
        return { service, ready: false };
      }
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
async function waitHealthy(
  instance: Instance,
  signal: AbortSignal,
  onEvent: (event: InstallerEvent) => void,
  ends: Map<string, number>,
) {
  const deadline = Date.now() + 20 * 60_000;
  let last = 0;
  const occupied = new Map<string, number>();
  for (;;) {
    signal.throwIfAborted();
    const probed = await probeNativeSourceServices(instance, signal);
    if (probed.every((check) => check.ready))
      return probed.map(({ service, ready }) => ({ service, ready }));
    // A port another process holds never frees up by waiting; the service
    // that should listen there exits or retries until the deadline.
    for (const check of probed) {
      if (!("foreign" in check)) {
        occupied.delete(check.service);
        continue;
      }
      const since = occupied.get(check.service) ?? Date.now();
      occupied.set(check.service, since);
      if (Date.now() - since >= 15_000)
        throw new Error(
          `Native ${check.service} cannot listen on port ${check.port}: another program (PID ${check.foreign}) is using it. End that program, then try again.`,
        );
    }
    const checks = probed;
    // A failed build exits the service, so its log explains the stop.
    const failure = await startupFailure(instance, ends);
    if (failure) throw new Error(failure);
    for (const name of watchedServices)
      if (!(await inspectNativeProcess(instance.root, name)).running) {
        // With the service gone, whatever holds its port is another program.
        for (const [, owner, port] of probeEndpoints(instance.source!))
          if (owner === name && !(await portFree(port)))
            throw new Error(
              `Native ${name} cannot listen on port ${port}: another program is using it. Quit that program, then try again.`,
            );
        throw new Error(
          `Native ${name} stopped during startup. Inspect ${path.join(instance.root, "native/logs", `${name}.log`)}.`,
        );
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
    await delay(500, undefined, { signal });
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
  const outcome = await runNativeSource(options, timer);
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
      // A restart reads the choice from setup-choice.json, which a source
      // switched since on the Models page does not update, so a saved BYOK or
      // local source keeps its own runtime and gateway/model, and a
      // local-models choice switched to BYOK or subscription leaves the local
      // stack stopped.
      const saved =
        !options.byok && !options.setupChoice && !explicitLocal
          ? await readByokEnvironment(home)
          : undefined;
      const restoredByok = saved?.mode === "byok" ? saved : undefined;
      const restoredLocal = saved?.mode === "local" ? saved : undefined;
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
      let runtimeOutcome: InstallOutcome | undefined;
      let runtimeError: unknown;
      let runtimeAborted = false;
      let runtimePending = true;
      let byokGateway: ByokGatewayFailure | undefined;
      let localModelsDegraded: LocalModelsDegraded | undefined;
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
          const restored = await restoreLocalModels(current, {
            signal,
            onEvent: emit,
          });
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
            // so the outcome only reports it.
            if (!runtimeOutcome)
              byokGateway = await restoreByokSource(home, {
                signal,
                onEvent: emit,
              });
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
          } else if (choice === "local-models") {
            // A restart or app upgrade from the saved setup choice keeps a
            // model source the person switched to on the Models page (BYOK or
            // subscription), leaving the local model stack stopped just as
            // restoreLocalModels does.
            const switchedAway =
              !explicitLocal && (saved?.mode ?? "local") !== "local";
            if (!switchedAway) {
              let prepared: InstallOutcome | undefined;
              try {
                prepared = await prepareLocalModels(current, {
                  shareGpu: options.shareGpu,
                  signal,
                  onEvent: emit,
                  localModelsApproval: options.localModelsApproval,
                  localModelsReplan: options.localModelsReplan,
                });
              } catch (error) {
                if (!resumeLocalModels || signal.aborted) throw error;
                localModelsDegraded = localModelsDegradedFromError(error);
              }
              if (prepared && resumeLocalModels) {
                // Failing a resume for local models would lock the person out
                // of the workspace and the Models page that switches runtimes.
                localModelsDegraded = localModelsDegradedFromOutcome(prepared);
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
                runtimeOutcome = await applyNativeSource(home, "local", "pi", {
                  signal,
                  onEvent: emit,
                });
              else if (
                !runtimeOutcome &&
                !localModelsDegraded &&
                !options.localModelsReplan &&
                restoredLocal &&
                isLocalRuntimeModel(restoredLocal.runtimeModel)
              )
                await restoreSavedLocalModel();
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
            if (!runtimeOutcome) await restoreSavedLocalModel();
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
            )
              runtimeOutcome =
                (await applyNativeSource(home, "subscription", choice, {
                  signal,
                  onEvent: emit,
                })) ?? runtimeOutcome;
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
        const offline = bundled === "verified";
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
        const voice = configured.liveKit ? voiceTools : undefined;
        // node-services downloads its voice model packages from the region's
        // registry first, and nothing it starts probes again.
        const region = await resolveRegion(home, { signal });
        emit({ kind: "log", stage, message: `Download region: ${region}.\n` });
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          ...tools.env,
          ...configured.env,
          SIMPLEX_REGION: region,
          ...(voice
            ? {
                // TeamHub and the voice workers run ffmpeg and ffprobe from PATH.
                PATH: [voice.bin, tools.env.PATH]
                  .filter(Boolean)
                  .join(path.delimiter),
              }
            : { TEAMHUB_VOICE_MEDIA: "off" }),
        };
        // Only TeamHub gets the identity key (serviceOptions); no other
        // service may prove itself as this instance's server.
        delete env.TEAMHUB_LOCAL_IDENTITY_KEY;
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
          } = {},
        ): Promise<void> => {
          const {
            extraEnv = {},
            input,
            sink,
            retried = false,
            stage: commandStage = stage,
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
                signal,
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
          if (!retried && (await needsAppleDeveloperTools(tail, { signal }))) {
            const installing = "Installing Apple developer tools…";
            emit({
              kind: "stage",
              stage: commandStage,
              state: "running",
              message: installing,
            });
            await installAppleDeveloperTools({
              signal,
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
        const storedBefore = await loadInstance({ name: current.name, home });
        const switchingCheckout = Boolean(
          storedBefore?.source &&
          storedBefore.releaseDir !== current.releaseDir,
        );
        const hadProvisionedAccount = await localAccountProvisioned(
          current.root,
        );
        const anyServiceRunning = (
          await Promise.all(
            (["teamhub", "node-services", "web"] as const).map((name) =>
              inspectNativeProcess(current.root, name),
            ),
          )
        ).some((state) => state.running);
        const postgresWasRunning = (
          await inspectNativeProcess(current.root, "postgres")
        ).running;
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
          // Stop the Agent Service only when TeamHub is about to restart for a
          // changed configuration, so its graceful shutdown can requeue
          // in-flight Runs while TeamHub is still up. When TeamHub is not
          // running or not changing, node-services is left alone so it can
          // reconnect. It was running before this run, so it is never recorded
          // as started: if a later step fails, its replacement stays up beside
          // the new TeamHub; if TeamHub's own restart fails, node-services
          // stays stopped until the next resume.
          const preStopped =
            (await nativeConfigurationChanged(serviceOptions("teamhub"))) &&
            (await inspectNativeProcess(current.root, "node-services")).running;
          if (preStopped)
            await stopNativeProcess(current.root, "node-services");
          const serviceNames = ["teamhub", "node-services", "web"] as const;
          if (preStopped) {
            for (const name of serviceNames) {
              const running = (await inspectNativeProcess(current.root, name))
                .running;
              if (!running && name !== "node-services") started.push(name);
              await startNativeProcess(serviceOptions(name));
            }
          } else {
            const states = await Promise.all(
              serviceNames.map((name) =>
                inspectNativeProcess(current.root, name),
              ),
            );
            for (const [index, name] of serviceNames.entries()) {
              if (!states[index]!.running) started.push(name);
            }
            // Settle every start before rollback so a supervisor still being
            // spawned is recorded and can be stopped.
            const results = await Promise.allSettled(
              serviceNames.map((name) =>
                startNativeProcess(serviceOptions(name)),
              ),
            );
            const failed = results.find(
              (result) => result.status === "rejected",
            );
            if (failed) throw failed.reason;
          }
          return timed(
            "Waiting for native collaboration services",
            () => waitHealthy(current, signal, emit, ends),
            { stage: "services" },
          );
        };
        const provisionAccount = () =>
          ensureLocalAccount(current, signal, {
            email: options.email,
            password: options.password,
            provisionOwner: async (email, password) => {
              secrets.push(password);
              await command("owner", {
                extraEnv: { OWNER_EMAIL: email },
                input: `${password}\n`,
                stage: "account",
              });
            },
          });
        const overlapWithRuntime =
          !switchingCheckout &&
          !anyServiceRunning &&
          (Boolean(options.resume) ||
            (Boolean(options.setupChoice || options.byok) &&
              (!hadProvisionedAccount || Boolean(legacyBackup))));
        // Without `stageForLogs`, timings log under the current stage.
        // `beforeFoundation` runs once the runtime is ready, before the
        // foundation services.
        const prepareRuntimeSide = async (
          stageForLogs?: InstallStage,
          beforeFoundation?: () => Promise<unknown>,
        ) => {
          await timed("Waiting for runtime preparation", () => runtime, {
            stage: stageForLogs,
          });
          signal.throwIfAborted();
          await beforeFoundation?.();
          const prepareLocalStackServices = async () => {
            await timed(
              "Preparing foundation services",
              () =>
                prepareFoundationServices(current, choice, {
                  home,
                  signal,
                  onEvent: emit,
                  shareGpu: options.shareGpu,
                }),
              { stage: stageForLogs },
            );
            // Binds the local stack's gateway for local models; with a runtime's own
            // sign-in, retires one an earlier release started.
            await prepareModelGateway(
              current,
              // A restored BYOK source keeps its gateway whatever the saved
              // choice: a local-models choice would require the local stack.
              restoredByok
                ? { runtime: restoredByok.runtime, modelSource: "byok" }
                : options.byok && choice !== "local-models"
                  ? { runtime: choice, modelSource: "byok" }
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
              await prepareLocalStackServices();
            } catch (error) {
              signal.throwIfAborted();
              emit({
                kind: "log",
                stage: stageForLogs ?? "runtime",
                message: `Local model gateway preparation skipped during degraded resume: ${error instanceof Error ? error.message : String(error)}\n`,
              });
            }
          } else {
            await prepareLocalStackServices();
          }
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
        let checks: { service: string; ready: boolean }[];
        if (overlapWithRuntime) {
          // LiveKit binds before the fork so the runtime branch's foundation
          // services can never take its port.
          const ends = await beginServices();
          await bindLiveKit();
          // Each second counts once, toward the critical path: services and
          // account while branch2 runs, then runtime only for the wait beyond.
          timer.enter("services");
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
              await prepareRuntimeSide("runtime");
            } catch (error) {
              return failBranch(error, "runtime");
            }
          })();
          const branch2 = (async () => {
            let branchStage: InstallStage = "services";
            try {
              await migrate(branchStage);
              const probed = await startAndAwaitServices(ends);
              branchStage = "account";
              timer.enter("account");
              emit({
                kind: "stage",
                stage: branchStage,
                state: "running",
                message: "Preparing local account and workspace…",
              });
              await provisionAccount();
              return probed;
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
          if (branch1Pending) timer.enter("runtime");
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
          checks = result2.value;
          await servicesSucceeded();
          stage = "account";
          accountSucceeded();
        } else {
          // The runtime is ready before the checkout's migrations run: when it is
          // not, services still running from an earlier checkout keep the
          // schema they know.
          let ends: Awaited<ReturnType<typeof logEnds>> | undefined;
          // Count only the runtime wait beyond the parallel work.
          if (runtimePending) timer.enter("runtime");
          await prepareRuntimeSide(undefined, async () => {
            timer.enter("services");
            await migrate();
            ends = await beginServices();
            await bindLiveKit();
          });
          checks = await startAndAwaitServices(ends!);
          await servicesSucceeded();
          step("account", "Preparing local account and workspace…");
          await provisionAccount();
          accountSucceeded();
          await runtime;
          signal.throwIfAborted();
        }
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
          return {
            code: 4,
            state: "action_required",
            message: `Native source services are running: ${current.origin}\n${detail}`,
            details: {
              code: "COMPUTER_SETUP_REQUIRED",
              origin: current.origin,
              services: await probeNativeSourceServices(
                current,
                options.signal,
              ),
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
        controller.abort();
        await runtime;
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
        controller.abort();
        await runtime;
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
) {
  requireNative(instance);
  await withInstanceLock(instance, async () => {
    signal?.throwIfAborted();
    await stopComputer(instance, { signal });
    for (const name of nativeServices) {
      signal?.throwIfAborted();
      try {
        await stopNativeProcess(instance.root, name);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        throw Object.assign(
          new Error(
            error instanceof Error ? error.message : `Could not stop ${name}.`,
            { cause: error },
          ),
          { code: code ?? NATIVE_SERVICE_STOP_FAILED, nativeService: name },
        );
      }
    }
    await reclaimEarlierProcesses(
      instance,
      path.resolve(instance.root, "../.."),
    );
    await stopModelGateway(instance, signal);
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
