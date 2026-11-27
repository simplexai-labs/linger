import { revokeFoundationGpuSharing } from "./foundation-services.js";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sleep } from "@linger/service-kit";
import { resolveBundledPi } from "./bundled-pi.js";
import {
  atomicPrivate,
  INSTANCE_BUSY,
  instanceLockFile,
  privateDirectory,
  readPrivate,
  withInstanceLock,
  type Instance,
} from "./instance.js";
import type { InstallOutcome, InstallerEvent } from "./events.js";
import {
  applyNativeSource,
  lastJsonObject,
  mountSavedByokSource,
  readByokEnvironment,
  type ByokGatewayFailure,
} from "./byok-source.js";
import {
  formatLocalmodelsFailureMessage,
  localmodelsFailure,
  redactLocalmodelsOutput,
} from "./localmodels-failure.js";
import {
  clearResumeLocalModels,
  isLibraryModelId,
  isStoppedDownloadErrorCode,
  localmodelsBaseDirectory,
  readOnDiskLoadedLibraryModels,
  readResumeLocalModels,
  runLocalmodels,
  uniqueLibraryModelIds,
  writeResumeLocalModels,
} from "./localmodels-tool.js";
import {
  readSetupChoice,
  DEFAULT_GPU_SHARING,
  readGpuSharing,
  writeGpuSharing,
} from "./setup-selection.js";
export interface LocalModelsPlanSummary {
  planId: string;
  gpuIndex: number;
  gpuName: string;
  llm: string;
  contextWindow: number;
  downloadBytes: number;
  diskBytes: number;
  memoryBytes: number;
  components: string[];
  warnings: string[];
}
export interface LocalModelsDegraded {
  code: string;
  message: string;
  reasons?: string[];
}
const REASON_CODE = /^[a-z][a-z0-9-]{0,63}$/;
export function reasonCodeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string =>
          typeof item === "string" && REASON_CODE.test(item),
      )
    : [];
}
export function localModelsDegradedFromOutcome(
  outcome: InstallOutcome,
): LocalModelsDegraded {
  const details =
    outcome.details && typeof outcome.details === "object"
      ? (outcome.details as { code?: unknown; reasons?: unknown })
      : undefined;
  const code =
    typeof details?.code === "string" && details.code.trim()
      ? details.code.trim()
      : "LOCAL_MODELS_RECOVERY_REQUIRED";
  const reasons = reasonCodeList(details?.reasons);
  return {
    code,
    message: outcome.message || "The local model stack is not ready.",
    ...(reasons.length ? { reasons } : {}),
  };
}
export function localModelsDegradedFromError(
  error: unknown,
): LocalModelsDegraded {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : "The local model stack is not ready.";
  return { code: "LOCAL_MODELS_RECOVERY_REQUIRED", message };
}
interface Binding {
  schema: "localmodels.stack-binding/v1";
  ready: boolean;
  planId: string;
  pi: {
    executable: string;
    environment: Record<string, string>;
    configFingerprint: string;
  } | null;
  // Why the stack is not ready, such as pi-extensions-unavailable.
  reasons?: { code?: unknown; message?: unknown }[];
}
interface Options {
  shareGpu?: boolean;
  localModelsApproval?: string;
  localModelsReplan?: boolean;
  signal: AbortSignal;
  onEvent: (e: InstallerEvent) => void;
}
interface Dependencies {
  localmodels?: typeof runLocalmodels;
}
interface RestoreDependencies extends Dependencies {
  // How long a restore waits for another holder of the stack's lock, and
  // how often it tries again.
  lockWaitMs?: number;
  lockRetryMs?: number;
  withLock?: typeof withLocalModelsLock;
}
// A little above the quit-time stop's 150 s hard exit, so a reopen during
// that stop sees where it left the stack.
const LOCK_WAIT_MS = 180_000;
// Binding reasons that a stopped stack reports after a quit, reboot, or app
// update; `stack up` starts the installed deployments and gateway without
// re-planning against a newer localmodels kit or model catalog.
const RESTARTABLE_BINDING_REASONS = new Set([
  "deployment-unavailable",
  "gateway-unavailable",
]);
// The Computer Daemon takes and at once releases this lock after it starts,
// to wait for a quit-time stop; a holder that meets that probe retries for
// this long instead of failing.
const LOCK_BUSY_WINDOW_MS = 2_000;
const LOCK_BUSY_RETRY_MS = 100;
function localModelsLockRoot(home: string): string {
  return path.join(path.resolve(home), "runtime/localmodels");
}
/**
 * The lock database `withLocalModelsLock` takes. The Computer Daemon derives
 * the same path from the config's `state_directory` (`installerLockPath`),
 * the file beside that directory, to wait for a quit-time stop or a resume
 * restore holding it.
 */
export function localModelsLockFile(home: string): string {
  return instanceLockFile(localModelsLockRoot(home));
}
/**
 * Runs `callback` holding the lock every deployment, restore check and
 * quit-time stop of a home's local model stack takes, so none of them sees
 * the stack half changed. Throws `INSTANCE_BUSY` when another still holds it
 * after a short retry window; the caller creates `<home>/runtime/localmodels`
 * first.
 */
export async function withLocalModelsLock<T>(
  home: string,
  callback: () => Promise<T>,
  timing: { busyWindowMs?: number; busyRetryMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (timing.busyWindowMs ?? LOCK_BUSY_WINDOW_MS);
  for (;;) {
    let started = false;
    try {
      return await withInstanceLock(
        { root: localModelsLockRoot(home) } as Instance,
        () => {
          started = true;
          return callback();
        },
      );
    } catch (error) {
      // A callback that ran is never run again, whatever it threw.
      if (
        started ||
        (error as { code?: unknown }).code !== INSTANCE_BUSY ||
        Date.now() >= deadline
      )
        throw error;
      await sleep(timing.busyRetryMs ?? LOCK_BUSY_RETRY_MS);
    }
  }
}
// What each stack component downloads, as the setup page names it.
const DOWNLOADS: Record<string, string> = {
  llm: "the local model",
  decision: "the decision model",
  embedding: "the embedding model",
  rerank: "the reranking model",
  stt: "the speech recognition model",
  tts: "the speech model",
  search: "the search service",
};
// A localmodels.stack-progress/v1 event from `stack apply --jsonl`, as the
// runtime stage's byte counter. The tool counts the file downloading now
// (done/total); component_done/component_total, when it sends them, count
// the whole component, so the page can show what remains.
export function stackProgress(value: unknown): InstallerEvent | undefined {
  const event = value as Record<string, unknown> | null;
  const count = (key: string) => {
    const n = event?.[key];
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0
      ? n
      : undefined;
  };
  const done = count("done"),
    total = count("total");
  if (
    event?.event !== "progress" ||
    typeof event.component !== "string" ||
    !/^[a-z][a-z0-9_-]{0,40}$/.test(event.component) ||
    !(event.phase === "download" || event.phase === "verify") ||
    done === undefined ||
    total === undefined ||
    done > total
  )
    return;
  const wholeDone = count("component_done"),
    wholeTotal = count("component_total");
  const whole =
    wholeDone !== undefined &&
    wholeTotal !== undefined &&
    wholeTotal > 0 &&
    wholeDone <= wholeTotal;
  // A rate is bytes over elapsed time, so it may be fractional.
  const rawRate = event.bytes_per_second;
  const rate =
    typeof rawRate === "number" && Number.isFinite(rawRate) && rawRate >= 0
      ? Math.round(rawRate)
      : undefined;
  const what =
    event.step === "engine"
      ? "the inference engine"
      : (DOWNLOADS[event.component] ?? "the local model files");
  return {
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: `${event.phase === "download" ? "Downloading" : "Checking"} ${what}…`,
    progress: {
      completed: whole ? wholeDone : done,
      total: whole ? wholeTotal : total,
      unit: "bytes",
      ...(rate !== undefined && event.phase === "download"
        ? { bytesPerSecond: rate }
        : {}),
      ...(whole ? {} : { partial: true }),
    },
  };
}
function review(value: unknown): LocalModelsPlanSummary {
  const v = value as LocalModelsPlanSummary & { schema?: string };
  if (
    v?.schema !== "localmodels.stack-review/v1" ||
    !/^[a-f0-9]{64}$/.test(v.planId) ||
    !Number.isSafeInteger(v.gpuIndex) ||
    v.gpuIndex < 0 ||
    ![v.gpuName, v.llm].every(
      (x) => typeof x === "string" && x.length > 0 && x.length < 1024,
    ) ||
    ![v.contextWindow, v.downloadBytes, v.diskBytes, v.memoryBytes].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    ![v.components, v.warnings].every(
      (a) =>
        Array.isArray(a) &&
        a.every(
          (x) =>
            typeof x === "string" &&
            x.length < 4000 &&
            ![...x].some(
              (c) => c.charCodeAt(0) < 32 && c !== "\t" && c !== "\n",
            ),
        ),
    )
  )
    throw new Error("Invalid upstream local model review.");
  return {
    planId: v.planId,
    gpuIndex: v.gpuIndex,
    gpuName: v.gpuName,
    llm: v.llm,
    contextWindow: v.contextWindow,
    downloadBytes: v.downloadBytes,
    diskBytes: v.diskBytes,
    memoryBytes: v.memoryBytes,
    components: v.components,
    warnings: v.warnings,
  };
}
function binding(value: unknown, id?: string): Binding {
  const b = value as Binding;
  if (
    b?.schema !== "localmodels.stack-binding/v1" ||
    typeof b.ready !== "boolean" ||
    !/^[a-f0-9]{64}$/.test(b.planId) ||
    (id !== undefined && b.planId !== id)
  )
    throw new Error("Invalid upstream local model binding.");
  if (
    b.ready &&
    (!b.pi ||
      !path.isAbsolute(b.pi.executable) ||
      !/^[a-f0-9]{64}$/.test(b.pi.configFingerprint) ||
      !b.pi.environment ||
      Object.entries(b.pi.environment).some(
        ([key, v]) =>
          key !== "PI_CODING_AGENT_DIR" ||
          typeof v !== "string" ||
          !path.isAbsolute(v),
      ))
  )
    throw new Error("Invalid upstream Pi binding.");
  return b;
}
// The binding's reason codes, such as pi-extensions-unavailable.
function reasonCodes(observed: Binding | null): string[] {
  return reasonCodeList(
    (observed?.reasons ?? []).map((reason) => reason?.code),
  );
}
// The first reason's upstream message, for display only.
function reasonMessage(observed: Binding | null): string | undefined {
  const message = observed?.reasons?.[0]?.message;
  return typeof message === "string" && message.trim()
    ? message.trim()
    : undefined;
}
export interface LocalModelsEnvironmentOptions {
  readonly resolveBundledPi?: typeof resolveBundledPi;
  readonly platform?: NodeJS.Platform;
}
async function isExecutableFile(
  file: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;
    if (platform !== "win32") await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function expandHomePath(rawPath: string): string {
  if (rawPath === "~") return os.homedir();
  if (rawPath.startsWith("~/") || rawPath.startsWith("~\\"))
    return path.join(os.homedir(), rawPath.slice(2));
  return rawPath;
}
async function hasMissingReusedPiPath(planJson: string): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    return false;
  }
  const tools = (parsed as { harness?: { tools?: unknown } } | null)?.harness
    ?.tools;
  if (!Array.isArray(tools)) return false;
  for (const entry of tools) {
    if (!entry || typeof entry !== "object") continue;
    const tool = entry as {
      tool?: unknown;
      action?: unknown;
      path?: unknown;
    };
    if (
      tool.tool !== "pi" ||
      tool.action !== "reuse" ||
      typeof tool.path !== "string"
    )
      continue;
    const trimmed = tool.path.trim();
    if (!trimmed) continue;
    const expanded = expandHomePath(trimmed);
    if (!path.isAbsolute(expanded)) continue;
    try {
      const info = await stat(expanded);
      if (!info.isFile()) return true;
    } catch {
      return true;
    }
  }
  return false;
}
export async function localModelsEnvironment(
  instance: Instance,
  options: LocalModelsEnvironmentOptions = {},
): Promise<NodeJS.ProcessEnv> {
  if ((await readSetupChoice(instance)) !== "local-models") return {};
  const raw = await readPrivate(
    path.join(
      path.resolve(instance.root, "../.."),
      "runtime/localmodels/binding.json",
    ),
  );
  if (!raw) return {};
  const b = binding(JSON.parse(raw));
  if (!b.ready || !b.pi) return {};
  const platform = options.platform ?? process.platform;
  const piExecutable = (await isExecutableFile(b.pi.executable, platform))
    ? b.pi.executable
    : (await (options.resolveBundledPi ?? resolveBundledPi)())?.executable;
  return {
    ...b.pi.environment,
    ...(piExecutable ? { LINGER_PI_PATH: piExecutable } : {}),
    LINGER_LOCAL_MODELS_REVISION: b.pi.configFingerprint,
  };
}
// The saved plan's ID, or undefined when no plan was saved.
async function savedPlanID(home: string): Promise<string | undefined> {
  const raw = await readPrivate(
    path.join(home, "runtime/localmodels/plan.json"),
  );
  if (!raw) return undefined;
  const saved = JSON.parse(raw) as { schema?: string; plan_id?: string };
  if (
    saved.schema !== "localmodels.stack-plan/v1" ||
    !/^[a-f0-9]{64}$/.test(saved.plan_id ?? "")
  )
    throw new Error("Invalid saved upstream plan.");
  return saved.plan_id;
}
export async function hasSavedLocalModelsPlan(home: string): Promise<boolean> {
  return (await savedPlanID(home)) !== undefined;
}
// What localmodels reports about the plan's deployed stack and its Pi, or
// null when it could not tell.
async function observeBinding(
  planFile: string,
  planID: string,
  command: (
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<Binding | null> {
  const result = await command([
    "setup",
    "binding",
    "--plan",
    planFile,
    "--lang",
    "en",
    "--json",
  ]);
  if (result.code !== 0) return null;
  return binding(JSON.parse(result.stdout), planID);
}
class ReviewPlanExitError extends Error {
  readonly result: { code: number; stdout: string; stderr: string };
  constructor(result: { code: number; stdout: string; stderr: string }) {
    super("The upstream model plan could not be reviewed.");
    this.result = result;
  }
}
export async function reviewSavedModelPlan(
  home: string,
  file: string,
  options: { signal?: AbortSignal } = {},
  dependencies: Dependencies = {},
): Promise<LocalModelsPlanSummary> {
  const result = await (dependencies.localmodels ?? runLocalmodels)(
    home,
    ["setup", "review", "--plan", path.resolve(file), "--lang", "en", "--json"],
    { signal: options.signal, timeoutMs: 120000 },
  );
  if (result.code !== 0) throw new ReviewPlanExitError(result);
  return review(JSON.parse(result.stdout));
}
export async function prepareLocalModels(
  instance: Instance,
  options: Options,
  dependencies: Dependencies = {},
): Promise<InstallOutcome | undefined> {
  options.signal.throwIfAborted();
  // Why the binding was not ready, for the client to word; set once observed.
  let reasons: string[] = [];
  const action = (
    code: string,
    message: string,
    extra: {
      summary?: LocalModelsPlanSummary;
      causeCode?: string;
      bindingReasons?: string[];
    } = {},
  ): InstallOutcome => {
    const bindingReasons = extra.bindingReasons ?? reasons;
    return {
      code: 4,
      state: "action_required",
      message,
      details: {
        code,
        ...(extra.causeCode ? { causeCode: extra.causeCode } : {}),
        ...(extra.summary ? { localModelsPlan: extra.summary } : {}),
        ...(bindingReasons.length ? { reasons: bindingReasons } : {}),
      },
    };
  };
  if (options.localModelsReplan && options.localModelsApproval)
    return action(
      "LOCAL_MODELS_RECOVERY_REQUIRED",
      "Reviewing a new plan and approving it must be separate requests.",
    );
  const home = path.resolve(instance.root, "../.."),
    root = path.join(home, "runtime/localmodels"),
    planFile = path.join(root, "plan.json"),
    inputsFile = path.join(root, "plan-inputs.json");
  await privateDirectory(root);
  await privateDirectory(path.join(root, "models"));
  return withLocalModelsLock(home, async () => {
    let saved = await readPrivate(planFile);
    if (options.shareGpu === false) {
      try {
        await revokeFoundationGpuSharing(
          instance,
          { home, mainPlan: saved !== undefined, signal: options.signal },
          { run: dependencies.localmodels },
        );
      } catch {
        options.signal.throwIfAborted();
        return action(
          "GPU_SHARING_REVOCATION_FAILED",
          "GPU sharing revocation could not be confirmed. Existing models were not stopped; retry before approving a plan.",
        );
      }
    }
    if (options.shareGpu !== undefined)
      await writeGpuSharing(instance, options.shareGpu);
    const shareGpu =
      options.shareGpu ??
      (await readGpuSharing(instance)) ??
      DEFAULT_GPU_SHARING;
    const invoke = dependencies.localmodels ?? runLocalmodels;
    // Says why localmodels refused: its cause in the outcome, its redacted
    // output in the installer log.
    const refused = (
      code: string,
      text: string,
      args: string[],
      result: { code: number; stdout: string; stderr: string },
    ) => {
      const { cause, causeCode, log } = localmodelsFailure(args, result);
      for (const message of log)
        options.onEvent({ kind: "log", stage: "runtime", message });
      return action(
        code,
        formatLocalmodelsFailureMessage(
          text,
          cause,
          "Existing resources were preserved.",
        ),
        { causeCode },
      );
    };
    const command = async (args: string[]) => {
      let buffer = "";
      // The end of an uncaptured run's output, without its byte counters.
      let tail = "";
      const captured = !(args[0] === "stack" && args[1] === "apply");
      const handleLine = (rawLine: string, emitProgress: boolean) => {
        let event: unknown;
        try {
          event = JSON.parse(rawLine);
        } catch {
          if (!captured) tail = `${tail}${rawLine}\n`.slice(-8000);
          return;
        }
        if (
          !captured &&
          (event as { event?: unknown } | null)?.event !== "progress"
        )
          tail = `${tail}${rawLine}\n`.slice(-8000);
        if (emitProgress) {
          const progress = stackProgress(event);
          if (progress) options.onEvent(progress);
        }
      };
      const result = await invoke(home, args, {
        signal: options.signal,
        timeoutMs:
          args[0] === "stack" && (args[1] === "apply" || args[1] === "up")
            ? undefined
            : 120000,
        capture: captured,
        onEvent: options.onEvent,
        onOutput: (chunk) => {
          buffer += chunk;
          if (buffer.length > 128000) buffer = buffer.slice(-64000);
          for (;;) {
            const newline = buffer.indexOf("\n");
            if (newline < 0) break;
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            handleLine(line, true);
          }
        },
      });
      if (!captured && buffer.trim()) handleLine(buffer, false);
      return captured ? result : { ...result, stderr: tail };
    };
    if (!saved && options.localModelsApproval)
      return action(
        "LOCAL_MODELS_APPROVAL_REQUIRED",
        "The approved upstream plan does not exist. Generate and review a plan first.",
      );
    if (!saved || options.localModelsReplan) {
      const temporary = path.join(root, `plan-${randomUUID()}.json`);
      try {
        const result = await command([
          "stack",
          "plan",
          "--defer-services",
          ...(shareGpu ? ["--share-gpu"] : []),
          "--decision",
          "none",
          "--base-dir",
          path.join(root, "models"),
          "--out",
          temporary,
          "--json",
        ]);
        if (result.code !== 0)
          return refused(
            "LOCAL_MODELS_UNAVAILABLE",
            "The upstream planner could not create a local model plan",
            ["stack", "plan"],
            result,
          );
        const generated = await readPrivate(temporary);
        if (!generated)
          throw new Error("The upstream planner did not save a plan.");
        const planned = await reviewSavedModelPlan(
          home,
          temporary,
          { signal: options.signal },
          { localmodels: invoke },
        );
        await atomicPrivate(planFile, generated);
        await atomicPrivate(
          inputsFile,
          JSON.stringify({ planId: planned.planId, shareGpu, decision: false }),
        );
        saved = generated;
      } finally {
        await rm(temporary, { force: true });
      }
    }
    let summary: LocalModelsPlanSummary;
    try {
      summary = await reviewSavedModelPlan(
        home,
        planFile,
        { signal: options.signal },
        { localmodels: invoke },
      );
    } catch (error) {
      if (
        options.signal.aborted ||
        options.localModelsReplan ||
        !(error instanceof ReviewPlanExitError)
      )
        throw error;
      const { log } = localmodelsFailure(["setup", "review"], error.result);
      for (const message of log)
        options.onEvent({ kind: "log", stage: "runtime", message });
      return action(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        "The saved local model plan could not be reviewed with the current local model tool. Review a new plan; existing resources were preserved.",
        { causeCode: "STACK_PLAN_INVALID" },
      );
    }
    const bindFile = path.join(root, "binding.json");
    const previous = await readPrivate(bindFile);
    const observe = async () => {
      const observed = await observeBinding(planFile, summary.planId, command);
      if (observed) reasons = observed.ready ? [] : reasonCodes(observed);
      return observed;
    };
    let inputs:
      | { planId?: unknown; shareGpu?: unknown; decision?: unknown }
      | undefined;
    try {
      const raw = await readPrivate(inputsFile);
      inputs = raw ? JSON.parse(raw) : undefined;
    } catch {
      // A damaged or incomplete approval binding cannot authorize deployment.
    }
    const approvedInputs =
      inputs?.planId === summary.planId &&
      inputs?.shareGpu === shareGpu &&
      inputs?.decision === false;
    // A binding saved for this plan means it was approved and deployed once.
    const deployed =
      !!previous &&
      !options.localModelsReplan &&
      binding(JSON.parse(previous)).planId === summary.planId;
    if (deployed) {
      const observed = await observe();
      if (observed?.ready) {
        await atomicPrivate(bindFile, JSON.stringify(observed));
        return;
      }
      if (!approvedInputs)
        return action(
          "LOCAL_MODELS_RECOVERY_REQUIRED",
          "The local model stack is not ready, and its resource choices changed since its plan was approved. Review a new plan; existing resources were preserved.",
          { bindingReasons: [] },
        );
      // When the installed stack is simply stopped (quit, reboot, or an app
      // upgrade to a newer localmodels kit or catalog), start it in place with
      // `stack up` first. Unlike `stack apply`, `stack up` does not re-plan
      // against the current kit's Python path, live free memory, or retired
      // catalog entries.
      if (
        reasons.length > 0 &&
        reasons.every((code) => RESTARTABLE_BINDING_REASONS.has(code))
      ) {
        options.onEvent({
          kind: "log",
          stage: "runtime",
          message: `The local model stack is not ready (${reasons.join(", ")}); starting the installed stack again.\n`,
        });
        const started = await command([
          "stack",
          "up",
          planFile,
          ...(shareGpu ? ["--share-gpu"] : []),
          "--json",
        ]);
        if (started.code === 0) {
          const revived = await observe();
          if (revived?.ready) {
            await atomicPrivate(bindFile, JSON.stringify(revived));
            options.onEvent({
              kind: "stage",
              stage: "runtime",
              state: "succeeded",
              message:
                "The upstream local model stack and Pi connection are ready.",
            });
            return;
          }
        } else {
          const upFailure = localmodelsFailure(["stack", "up"], started);
          for (const message of upFailure.log)
            options.onEvent({ kind: "log", stage: "runtime", message });
        }
      }
      // If `stack up` did not restore the binding (for example drift, missing
      // files, or a Pi without extension support from an earlier localmodels),
      // applying the approved plan again can still repair it while the
      // approval it was deployed under holds, unless the saved plan pins a
      // reused Pi executable that no longer exists on disk.
      if (saved && (await hasMissingReusedPiPath(saved))) {
        options.onEvent({
          kind: "log",
          stage: "runtime",
          message:
            "The saved local model plan's reused Pi executable no longer exists; skipping stack apply.\n",
        });
        return action(
          "LOCAL_MODELS_RECOVERY_REQUIRED",
          "The saved local model plan references a Pi executable that no longer exists (for example after moving the Linger app). Review a new plan; existing resources were preserved.",
        );
      }
      options.onEvent({
        kind: "log",
        stage: "runtime",
        message: `The local model stack is not ready (${reasons.join(", ") || "unknown"}); applying its approved plan again.\n`,
      });
    } else {
      if (!approvedInputs)
        return action(
          "LOCAL_MODELS_RECOVERY_REQUIRED",
          "Local model resource choices changed or their approval binding is unavailable. Review a new plan; existing resources were preserved.",
        );
      if (
        options.localModelsApproval !== summary.planId ||
        options.localModelsReplan
      )
        return action(
          "LOCAL_MODELS_APPROVAL_REQUIRED",
          "Review the upstream local model plan before installing.",
          { summary },
        );
    }
    const applied = await command([
      "stack",
      "apply",
      planFile,
      "--approve",
      summary.planId,
      "--jsonl",
    ]);
    if (applied.code !== 0)
      return refused(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        "Local model installation or verification did not finish",
        ["stack", "apply"],
        applied,
      );
    const observed = await observe();
    if (!observed?.ready)
      return action(
        "LOCAL_MODELS_RECOVERY_REQUIRED",
        formatLocalmodelsFailureMessage(
          "The upstream tool could not verify the local stack binding",
          reasonMessage(observed),
          "Existing resources were preserved.",
        ),
      );
    await atomicPrivate(bindFile, JSON.stringify(observed));
    options.onEvent({
      kind: "stage",
      stage: "runtime",
      state: "succeeded",
      message: "The upstream local model stack and Pi connection are ready.",
    });
  });
}
// Runs `callback` under the local model lock, waiting for another holder.
// Returns undefined when the wait runs out.
async function waitForLocalModelsLock<T>(
  home: string,
  callback: () => Promise<T>,
  signal: AbortSignal,
  dependencies: RestoreDependencies,
): Promise<{ value: T } | undefined> {
  const lock = dependencies.withLock ?? withLocalModelsLock;
  const deadline = Date.now() + (dependencies.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    try {
      // This loop is the wait; the lock's own short retry adds nothing.
      return { value: await lock(home, callback, { busyWindowMs: 0 }) };
    } catch (error) {
      if ((error as { code?: unknown }).code !== INSTANCE_BUSY) throw error;
      if (Date.now() >= deadline) return undefined;
      await sleep(dependencies.lockRetryMs ?? 1000, signal);
    }
  }
}

/**
 * Brings back the Bifrost gateway of a saved BYOK source, which the
 * desktop's quit stops with the stack. A failure is logged and returned,
 * never thrown: failing the resume would block the whole local workspace,
 * including the Models page that switches the source. Returns undefined
 * when there was nothing to do or the gateway is up.
 */
export async function restoreByokSource(
  home: string,
  options: { signal: AbortSignal; onEvent: (e: InstallerEvent) => void },
  dependencies: RestoreDependencies & { fetch?: typeof fetch } = {},
): Promise<ByokGatewayFailure | undefined> {
  const source = await readByokEnvironment(home);
  if (source?.mode !== "byok") return undefined;
  // The quit-time stop holds the lock while it takes the gateway down, so a
  // gateway that answers before it ends is not proof that it stays up.
  const held = await waitForLocalModelsLock(
    home,
    async () => {
      // `source apply --mode byok` unloads any library models marked `loaded`
      // on disk (e.g. after a crash or reboot when no `resume-models.json`
      // exists). Snapshot them into `resume-models.json` first so the
      // following `restoreLocalModels` still brings them back.
      const onDiskLoaded = await readOnDiskLoadedLibraryModels(home);
      if (onDiskLoaded.length > 0) {
        const existing = await readResumeLocalModels(home);
        await writeResumeLocalModels(home, [
          ...(existing ?? []),
          ...onDiskLoaded,
        ]).catch(() => undefined);
      }
      return mountSavedByokSource(home, source, options, dependencies);
    },
    options.signal,
    dependencies,
  );
  const failure: ByokGatewayFailure | undefined = held
    ? held.value
    : {
        code: "LOCAL_MODELS_BUSY",
        message: "Another local model operation is still running.",
      };
  if (failure)
    options.onEvent({
      kind: "log",
      message: `${failure.message} (${failure.code}) The Computer mounts the gateway again before the next Run once the endpoint is reachable.`,
    });
  return failure;
}

interface ObservedLibraryModel {
  id: string;
  piModel: string;
}

interface ObservedFailedLibraryModel extends ObservedLibraryModel {
  errorCode?: string;
  errorDetail?: string;
}

interface ObservedLibraryState {
  loadedModels: ObservedLibraryModel[];
  loadingIds: string[];
  idleModels: ObservedLibraryModel[];
  failedModels: ObservedFailedLibraryModel[];
}

interface LibraryLoadErrorEvent {
  code?: string;
  detail?: string;
  message?: string;
}

const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const LIBRARY_LOAD_IDLE_TIMEOUT_MS = 240_000;

/**
 * Reports whether this home has local library models recorded for restoration
 * after a quit/upgrade stop or marked `loaded` on disk (e.g. after a reboot or
 * crash).
 */
export async function hasPendingLibraryModelsToRestore(
  home: string,
): Promise<boolean> {
  const resumeModels = await readResumeLocalModels(home);
  if (resumeModels && resumeModels.length > 0) return true;
  return (await readOnDiskLoadedLibraryModels(home)).length > 0;
}

function validErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value)
    ? value
    : fallback;
}

function cleanUserCause(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = redactLocalmodelsOutput(raw).replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > 300 ? `${cleaned.slice(0, 299)}…` : cleaned;
}

function parseLibraryLoadError(
  value: unknown,
): LibraryLoadErrorEvent | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const isError =
    record.event === "error" ||
    record.kind === "error" ||
    record.ok === false ||
    (typeof record.code === "string" &&
      (typeof record.detail === "string" ||
        typeof record.message === "string"));
  if (!isError) return undefined;
  const read = (key: string) => {
    const field = record[key];
    return typeof field === "string" && field.trim() ? field.trim() : undefined;
  };
  const code = read("code");
  const message = read("message");
  const detail = read("detail");
  if (!code && !message && !detail) return undefined;
  return { code, message, detail };
}

// Inspects the model library to see which local models are loaded, currently
// loading, idle, or failed. Returns undefined when the kit does not return a
// library status report so older kits keep relying on setup binding.
async function observeLibraryModels(
  home: string,
  invoke: typeof runLocalmodels,
  signal: AbortSignal,
): Promise<ObservedLibraryState | undefined> {
  const result = await invoke(
    home,
    [
      "library",
      "status",
      "--base-dir",
      localmodelsBaseDirectory(home),
      "--json",
    ],
    { signal, timeoutMs: 30_000 },
  );
  if (result.code !== 0) return undefined;
  const parsed = lastJsonObject(result.stdout);
  if (!Array.isArray(parsed?.models)) return undefined;
  const loadedModels: ObservedLibraryModel[] = [];
  const loadingIds: string[] = [];
  const idleModels: ObservedLibraryModel[] = [];
  const failedModels: ObservedFailedLibraryModel[] = [];
  for (const entry of parsed.models as Record<string, unknown>[]) {
    if (!isLibraryModelId(entry?.id)) continue;
    const model: ObservedLibraryModel = {
      id: entry.id,
      piModel: typeof entry.pi_model === "string" ? entry.pi_model : "",
    };
    if (entry.state === "loaded") {
      loadedModels.push(model);
    } else if (entry.state === "loading") {
      loadingIds.push(entry.id);
    } else if (entry.state === "idle") {
      idleModels.push(model);
    } else if (entry.state === "failed") {
      const err =
        entry.error &&
        typeof entry.error === "object" &&
        !Array.isArray(entry.error)
          ? (entry.error as { code?: unknown; detail?: unknown })
          : undefined;
      failedModels.push({
        ...model,
        ...(typeof err?.code === "string" && err.code.trim()
          ? { errorCode: err.code.trim() }
          : {}),
        ...(typeof err?.detail === "string" && err.detail.trim()
          ? { errorDetail: err.detail.trim() }
          : {}),
      });
    }
  }
  return { loadedModels, loadingIds, idleModels, failedModels };
}

function selectLibraryModel<T extends ObservedLibraryModel>(
  models: readonly T[],
  runtimeModel: string,
): T | undefined {
  if (!runtimeModel) return undefined;
  return models.find((model) => model.piModel === runtimeModel);
}

// Formats a failed `library load` or `library unload` invocation into a
// structured InstallOutcome and logs the redacted cause.
function libraryFailureOutcome(
  verb: "load" | "unload",
  modelId: string,
  result: { code: number; stdout: string; stderr: string },
  errEvent: LibraryLoadErrorEvent | undefined,
  onEvent: (e: InstallerEvent) => void,
): InstallOutcome {
  if (errEvent) {
    const code = validErrorCode(errEvent.code, "LOCAL_MODEL_LOAD_FAILED");
    const cause = cleanUserCause(errEvent.message ?? errEvent.detail);
    onEvent({
      kind: "log",
      stage: "runtime",
      message: `localmodels library ${verb} exited with code ${result.code} (${code})${cause ? `: ${cause}` : ""}.\n`,
    });
    return {
      code: 1,
      state: "failed",
      message: formatLocalmodelsFailureMessage(
        `Could not reload local model ${modelId}`,
        cause,
      ),
      details: { code },
    };
  }
  const { code, cause, log } = localmodelsFailure(["library", verb], result);
  for (const message of log)
    onEvent({ kind: "log", stage: "runtime", message });
  return {
    code: 1,
    state: "failed",
    message: formatLocalmodelsFailureMessage(
      `Could not reload local model ${modelId}`,
      cause,
    ),
    details: { code: validErrorCode(code, "LOCAL_MODEL_LOAD_FAILED") },
  };
}

// Runs `library unload` while the caller holds the local models lock to reset a
// failed model record before reloading it.
async function runUnloadLibraryModel(
  home: string,
  modelId: string,
  options: { signal: AbortSignal; onEvent: (e: InstallerEvent) => void },
  invoke: typeof runLocalmodels,
): Promise<InstallOutcome | undefined> {
  const result = await invoke(
    home,
    [
      "library",
      "unload",
      modelId,
      "--base-dir",
      localmodelsBaseDirectory(home),
      "--json",
    ],
    { signal: options.signal, timeoutMs: 120_000 },
  );
  if (result.code === 0) return undefined;
  return libraryFailureOutcome(
    "unload",
    modelId,
    result,
    parseLibraryLoadError(lastJsonObject(result.stdout)),
    options.onEvent,
  );
}

// Runs `library load` while the caller holds the local models lock.
async function runLoadLibraryModel(
  home: string,
  modelId: string,
  options: { signal: AbortSignal; onEvent: (e: InstallerEvent) => void },
  invoke: typeof runLocalmodels,
): Promise<InstallOutcome | undefined> {
  options.onEvent({
    kind: "stage",
    stage: "runtime",
    state: "running",
    message: `Restoring local model ${modelId}…`,
  });
  let buffer = "";
  let tail = "";
  let lastErrorEvent: LibraryLoadErrorEvent | undefined;
  const handleLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      tail = `${tail}${rawLine}\n`.slice(-8000);
      return;
    }
    const errEvent = parseLibraryLoadError(parsed);
    if (errEvent) lastErrorEvent = errEvent;
  };
  const result = await invoke(
    home,
    [
      "library",
      "load",
      modelId,
      "--base-dir",
      localmodelsBaseDirectory(home),
      "--jsonl",
    ],
    {
      signal: options.signal,
      idleTimeoutMs: LIBRARY_LOAD_IDLE_TIMEOUT_MS,
      capture: false,
      onEvent: options.onEvent,
      onOutput: (chunk) => {
        buffer += chunk;
        if (buffer.length > 128000) buffer = buffer.slice(-64000);
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline < 0) break;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handleLine(line);
        }
      },
    },
  );
  if (buffer.trim()) handleLine(buffer);
  if (result.code === 0) return undefined;
  if (!lastErrorEvent && result.stdout.trim()) {
    lastErrorEvent = parseLibraryLoadError(lastJsonObject(result.stdout));
  }
  return libraryFailureOutcome(
    "load",
    modelId,
    { ...result, stderr: tail || result.stderr },
    lastErrorEvent,
    options.onEvent,
  );
}

/**
 * Reports whether a saved `runtime_model` names a local model managed by the
 * localmodels library or adopted from a local stack (`localmodels/...` or
 * `localmodels-library/...`, excluding BYOK sentinel IDs).
 */
export function isLocalRuntimeModel(runtimeModel: string): boolean {
  if (
    runtimeModel === "localmodels-byok" ||
    runtimeModel.endsWith("/localmodels-byok")
  )
    return false;
  return (
    runtimeModel.startsWith("localmodels/") ||
    runtimeModel.startsWith("localmodels-library/")
  );
}

function stoppedDownloadOutcome(
  failedTarget: ObservedFailedLibraryModel,
): InstallOutcome {
  const code = validErrorCode(
    failedTarget.errorCode,
    "LOCAL_MODEL_LOAD_FAILED",
  );
  const cause = cleanUserCause(failedTarget.errorDetail);
  return {
    code: 1,
    state: "failed",
    message: formatLocalmodelsFailureMessage(
      `Could not reload local model ${failedTarget.id}`,
      cause,
    ),
    details: { code },
  };
}

interface LibraryRestorePlan {
  isLocalSource: boolean;
  savedRuntimeModel: string;
  wantedModelIds: string[];
  wantsFallbackSavedRuntimeModel: boolean;
  resumeFileModels: string[] | undefined;
  applyIfAlreadyLoaded: boolean;
}

// Checks whether target local models are loaded, loading, idle, or failed
// while the caller holds the local models lock, reloading any idle or crashed
// targets and (only in local mode) re-applying the local source. Returns
// `handled: true` when no generic no-model `source apply` fallback is needed.
async function restoreLibraryModelsUnderLock(
  home: string,
  plan: LibraryRestorePlan,
  options: { signal: AbortSignal; onEvent: (e: InstallerEvent) => void },
  dependencies: RestoreDependencies,
): Promise<{
  handled: boolean;
  outcome?: InstallOutcome;
  restoredIds: string[];
}> {
  if (
    plan.wantedModelIds.length === 0 &&
    !plan.wantsFallbackSavedRuntimeModel
  ) {
    return { handled: false, restoredIds: [] };
  }
  const invoke = dependencies.localmodels ?? runLocalmodels;
  const library = await observeLibraryModels(home, invoke, options.signal);
  if (!library) return { handled: false, restoredIds: [] };

  const loadedById = new Map(library.loadedModels.map((m) => [m.id, m]));
  const loadingSet = new Set(library.loadingIds);
  const idleById = new Map(library.idleModels.map((m) => [m.id, m]));
  const failedById = new Map(library.failedModels.map((m) => [m.id, m]));

  let targetIds: string[];
  if (plan.wantedModelIds.length > 0) {
    targetIds = plan.wantedModelIds;
  } else {
    // Legacy fallback (no resume-models.json and no on-disk loaded records):
    // match the single saved runtime_model in local mode.
    const loaded = library.loadedModels.find(
      (model) => model.piModel === plan.savedRuntimeModel,
    );
    if (loaded) {
      if (!plan.applyIfAlreadyLoaded) return { handled: true, restoredIds: [] };
      const applied = await applyNativeSource(
        home,
        "local",
        "pi",
        { signal: options.signal, onEvent: options.onEvent, model: loaded.id },
        dependencies,
      );
      return applied
        ? { handled: true, outcome: applied, restoredIds: [] }
        : { handled: true, restoredIds: [] };
    }
    if (library.loadingIds.length > 0)
      return { handled: true, restoredIds: [] };
    const idleTarget = selectLibraryModel(
      library.idleModels,
      plan.savedRuntimeModel,
    );
    const failedTarget = idleTarget
      ? undefined
      : selectLibraryModel(library.failedModels, plan.savedRuntimeModel);
    const target = idleTarget ?? failedTarget;
    if (!target) return { handled: false, restoredIds: [] };
    targetIds = [target.id];
  }

  const hasResumeRecord = plan.resumeFileModels !== undefined;
  const remainingPending = new Set(plan.resumeFileModels ?? []);
  const settlePending = async (modelId: string) => {
    if (!hasResumeRecord) return;
    const removed = remainingPending.delete(modelId);
    if (!removed) return;
    try {
      if (remainingPending.size > 0) {
        await writeResumeLocalModels(home, [...remainingPending]);
      } else {
        await clearResumeLocalModels(home);
      }
    } catch {
      // Updating the resume record is best-effort; restore already completed.
    }
  };

  const restoredIds: string[] = [];
  const activeLoaded: ObservedLibraryModel[] = [];
  let firstFailure: InstallOutcome | undefined;
  let matchedAnyInLibrary = false;

  for (const modelId of targetIds) {
    options.signal.throwIfAborted();
    const loaded = loadedById.get(modelId);
    if (loaded) {
      matchedAnyInLibrary = true;
      activeLoaded.push(loaded);
      await settlePending(modelId);
      continue;
    }
    if (loadingSet.has(modelId)) {
      matchedAnyInLibrary = true;
      await settlePending(modelId);
      continue;
    }
    const idle = idleById.get(modelId);
    const failed = idle ? undefined : failedById.get(modelId);
    if (!idle && !failed) {
      // Model was removed from the library since the stop; drop it from pending.
      await settlePending(modelId);
      continue;
    }
    matchedAnyInLibrary = true;
    if (failed && isStoppedDownloadErrorCode(failed.errorCode)) {
      firstFailure ??= stoppedDownloadOutcome(failed);
      await settlePending(modelId);
      continue;
    }
    if (failed) {
      const unloadOutcome = await runUnloadLibraryModel(
        home,
        failed.id,
        options,
        invoke,
      );
      options.signal.throwIfAborted();
      if (unloadOutcome) {
        firstFailure ??= unloadOutcome;
        await settlePending(modelId);
        continue;
      }
    }
    const loadOutcome = await runLoadLibraryModel(
      home,
      modelId,
      options,
      invoke,
    );
    options.signal.throwIfAborted();
    if (loadOutcome) {
      firstFailure ??= loadOutcome;
      await settlePending(modelId);
      continue;
    }
    restoredIds.push(modelId);
    activeLoaded.push(idle ?? failed!);
    await settlePending(modelId);
  }

  if (hasResumeRecord && remainingPending.size === 0) {
    await clearResumeLocalModels(home).catch(() => undefined);
  }

  if (!matchedAnyInLibrary) {
    return { handled: false, restoredIds };
  }

  // Only local mode binds `model-source.json` to a loaded local model. When
  // the user's active source is `subscription` or `byok`, `library load` has
  // already registered the models on Bifrost and Pi without switching sources.
  if (
    plan.isLocalSource &&
    activeLoaded.length > 0 &&
    (restoredIds.length > 0 || plan.applyIfAlreadyLoaded)
  ) {
    const primary =
      activeLoaded.find(
        (model) =>
          plan.savedRuntimeModel !== "" &&
          model.piModel === plan.savedRuntimeModel,
      ) ?? activeLoaded[0]!;
    const applied = await applyNativeSource(
      home,
      "local",
      "pi",
      { signal: options.signal, onEvent: options.onEvent, model: primary.id },
      dependencies,
    );
    if (applied) {
      return { handled: true, outcome: firstFailure ?? applied, restoredIds };
    }
  }

  return firstFailure
    ? { handled: true, outcome: firstFailure, restoredIds }
    : { handled: true, restoredIds };
}

/**
 * Brings back the local model stack and previously loaded library models after
 * a quit, crash, reboot, or app update. Restores any models recorded in
 * `resume-models.json` or left `loaded` on disk regardless of active model
 * source mode (`local`, `subscription`, or `byok`) without switching away from
 * a `subscription` or `byok` source. When no post-stop record exists and the
 * active source is `local` (or unset on a `local-models` setup), falls back to
 * the saved `runtime_model` and approved stack plan without ever guessing an
 * arbitrary idle model. Returns an outcome when stack recovery or library
 * restoration fails, which resume callers surface via `details.localModelsDegraded`.
 */
export async function restoreLocalModels(
  instance: Instance,
  options: {
    signal: AbortSignal;
    onEvent: (e: InstallerEvent) => void;
    onRestored?: (models: string[]) => void;
  },
  dependencies: RestoreDependencies = {},
): Promise<InstallOutcome | undefined> {
  const setupChoice = await readSetupChoice(instance);
  const home = path.resolve(instance.root, "../..");
  const source = await readByokEnvironment(home);
  const resumeFileModels = await readResumeLocalModels(home);
  const onDiskLoaded = await readOnDiskLoadedLibraryModels(home);
  const planID = await savedPlanID(home);

  // Installs from earlier releases may have no model source saved yet; their
  // source is the local stack they set up. Conversely, a non-local setup that
  // later switched to local mode on the Models page still counts as local.
  const isLocalSource =
    source?.mode === "local" || (!source && setupChoice === "local-models");
  const explicitlyEmptyResume =
    resumeFileModels !== undefined && resumeFileModels.length === 0;
  const wantedModelIds = uniqueLibraryModelIds([
    ...(resumeFileModels ?? []),
    ...onDiskLoaded,
  ]);

  // Respect an explicit empty stop record when deciding whether to fall back
  // to `savedRuntimeModel`, while still letting `needsStack` bring a stopped
  // Quick Install stack and gateway back up on warm resume.
  const savedRuntimeModel = source?.mode === "local" ? source.runtimeModel : "";
  const wantsFallbackSavedRuntimeModel =
    isLocalSource &&
    isLocalRuntimeModel(savedRuntimeModel) &&
    !explicitlyEmptyResume &&
    wantedModelIds.length === 0;
  const needsStack = isLocalSource && Boolean(planID);
  const needsLibrary =
    wantedModelIds.length > 0 || wantsFallbackSavedRuntimeModel;
  if (!needsStack && !needsLibrary) return;

  const invoke = dependencies.localmodels ?? runLocalmodels;
  const wantsLocalModel =
    wantedModelIds.length > 0 || wantsFallbackSavedRuntimeModel;

  // A quit-time stop may still hold the lock; checking, loading, and applying
  // under the same lock prevents racing with a quit-time unload.
  const held = await waitForLocalModelsLock(
    home,
    async () => {
      const observed = needsStack
        ? await observeBinding(
            path.join(home, "runtime/localmodels/plan.json"),
            planID!,
            (args) =>
              invoke(home, args, { signal: options.signal, timeoutMs: 120000 }),
          )
        : null;
      if (needsStack && !observed?.ready) {
        return { needsPrepare: true as const };
      }
      const restored = await restoreLibraryModelsUnderLock(
        home,
        {
          isLocalSource,
          savedRuntimeModel,
          wantedModelIds,
          wantsFallbackSavedRuntimeModel,
          resumeFileModels,
          applyIfAlreadyLoaded: false,
        },
        options,
        dependencies,
      );
      if (restored.restoredIds.length > 0) {
        options.onRestored?.(restored.restoredIds);
      }
      return {
        needsPrepare: false as const,
        ...(restored.outcome ? { outcome: restored.outcome } : {}),
      };
    },
    options.signal,
    dependencies,
  );
  if (!held)
    return {
      code: 4,
      state: "action_required",
      message:
        "Another local model operation is still running. Try again once it ends.",
      details: {
        code: needsStack
          ? "LOCAL_MODELS_RECOVERY_REQUIRED"
          : "LOCAL_MODELS_BUSY",
      },
    };
  if (!held.value.needsPrepare) {
    return held.value.outcome;
  }

  // prepareLocalModels takes the lock itself, and the lock is not reentrant.
  const prepared = await prepareLocalModels(instance, options, dependencies);
  if (prepared) return prepared;

  const postHeld = await waitForLocalModelsLock(
    home,
    async (): Promise<{ outcome?: InstallOutcome }> => {
      if (wantsLocalModel) {
        const restored = await restoreLibraryModelsUnderLock(
          home,
          {
            isLocalSource,
            savedRuntimeModel,
            wantedModelIds,
            wantsFallbackSavedRuntimeModel,
            resumeFileModels,
            applyIfAlreadyLoaded: true,
          },
          options,
          dependencies,
        );
        if (restored.handled) {
          options.onRestored?.(restored.restoredIds);
          return restored.outcome ? { outcome: restored.outcome } : {};
        }
      }
      const applied = await applyNativeSource(
        home,
        "local",
        "pi",
        { signal: options.signal, onEvent: options.onEvent },
        dependencies,
      );
      if (!applied) options.onRestored?.([]);
      return applied ? { outcome: applied } : {};
    },
    options.signal,
    dependencies,
  );
  if (!postHeld)
    return {
      code: 4,
      state: "action_required",
      message:
        "Another local model operation is still running. Try again once it ends.",
      details: {
        code: wantsLocalModel
          ? "LOCAL_MODELS_BUSY"
          : "LOCAL_MODELS_RECOVERY_REQUIRED",
      },
    };
  return postHeld.value.outcome;
}
