import { homedir } from "node:os";
import path from "node:path";
import type { InstallerEvent } from "./events.js";
import { localmodelsFailure } from "./localmodels-failure.js";
import { runLocalmodels } from "./localmodels-tool.js";
import { DEFAULT_GPU_SHARING } from "./setup-selection.js";
import { windowsPrivateRefusal } from "./windows-private.js";

export type SetupChoice = "local-models" | "codex" | "claude" | "pi";
export type RuntimeChoice = Exclude<SetupChoice, "local-models">;
/**
 * Runtime and model source are separate: local models also run behind a
 * runtime, and only they need the local stack's gateway. The stored choice
 * names one combination per runtime; "local-models" is the local source served
 * by Pi, the only runtime the local stack binds today.
 */
export type ModelSource = "local" | "runtime" | "byok";
export interface SetupSelection {
  runtime: RuntimeChoice;
  modelSource: ModelSource;
}
export function setupSelection(
  choice: SetupChoice | SetupSelection,
): SetupSelection {
  if (typeof choice !== "string") return choice;
  return choice === "local-models"
    ? { runtime: "pi", modelSource: "local" }
    : { runtime: choice, modelSource: "runtime" };
}
/**
 * One upstream stack reason. Clients pick their copy by `code` and its counts;
 * `message` is upstream diagnostic text for logs, never shown or matched on.
 */
export interface SetupReason {
  code: string;
  message: string;
  /** On gpu-memory-required: the card other programs hold memory on. */
  gpuIndex?: number;
  /** Memory free now: that card's VRAM, or RAM on free-memory-required. */
  freeBytes?: number;
  /** The memory the install needs free, for the same resource. */
  requiredBytes?: number;
  /** On cuda-driver-update-required: the CUDA version the installed driver supports. */
  detectedCudaVersion?: string;
  /** On CUDA driver reasons: the minimum CUDA version the pinned engine needs. */
  requiredCudaVersion?: string;
  /** On CUDA driver reasons: the installed NVIDIA driver version when known. */
  driverVersion?: string;
}
/** Whether local models can install now, as the localmodels tool says. */
export type LocalModelsState = "ready" | "blocked-now" | "unavailable";
/** Memory free now against what the plan needs, from the localmodels tool. */
export interface SetupMemory {
  ramAvailableBytes: number;
  ramRequiredBytes: number;
  vramFreeBytes?: number;
  vramRequiredBytes?: number;
}
export interface SetupGpu {
  index: number;
  name: string;
  totalMemoryBytes: number;
  freeMemoryBytes: number;
  busy: boolean;
}
export interface SetupEstimate {
  downloadBytes: number | null;
  diskBytes: number | null;
  memoryBytes: number | null;
  durationSeconds: { min: number; max: number } | null;
  assumption: string;
}
/** One closeable GPU process reported on an upstream `stack.upgrade` hint. */
export interface SetupUpgradeGpuApp {
  name: string;
  pids: number[];
  bytes: number;
}
/**
 * Upstream `stack.upgrade`: a stronger local model unlocked when other
 * programs release memory, with the quantitative reasons blocking it now.
 */
export interface SetupUpgrade {
  modelName?: string;
  selectedGpuIndex: number | null;
  estimate: SetupEstimate & { model: string };
  reasons: SetupReason[];
  gpuApps?: SetupUpgradeGpuApp[];
}
export interface SetupReport {
  hardware: {
    platform: string;
    arch: string;
    totalMemoryBytes: number;
    diskFreeBytes: number | null;
    gpus: SetupGpu[];
  };
  choices: SetupChoice[];
  localModels: {
    eligible: boolean;
    /**
     * Upstream `stack.state`. "blocked-now": the hardware can run the plan,
     * but installing now would stop until other programs free memory (or quit
     * another inference app). A tool without the field reports the same case
     * with basis "capacity" or reason free-memory-required.
     */
    state: LocalModelsState;
    /** Upstream `stack.hardwareCapable`, when the tool reports it. */
    hardwareCapable?: boolean | null;
    /** Upstream `stack.memory`, when the tool reports it. */
    memory?: SetupMemory;
    reasons: SetupReason[];
    /**
     * "capacity": the plan fits this computer's hardware only once other
     * programs release memory (upstream basis "capacity" or reason
     * free-memory-required); the install plans again against the memory free
     * then.
     */
    basis?: "capacity";
    selectedGpuIndex: number | null;
    estimate: SetupEstimate & { model: string };
    /**
     * Upstream `stack.upgrade`, when freeing memory unlocks a stronger local
     * model than the currently selected plan.
     */
    upgrade?: SetupUpgrade;
  };
  runtimes: {
    choice: RuntimeChoice;
    installed: boolean;
    auth: "unknown" | "authenticated" | "unauthenticated";
    estimate: SetupEstimate;
  }[];
  recommendation: SetupChoice;
}
export interface SetupOptions {
  shareGpu?: boolean;
  home?: string;
  targetHome?: string;
  userHome?: string;
  signal?: AbortSignal;
  localmodels?: typeof runLocalmodels;
  onEvent?: (event: InstallerEvent) => void;
}
interface UpstreamPlan {
  llm: { model: { id: string }; placement: { gpus: { index: number }[] } };
  budget: {
    download_bytes: number;
    disk_needed_bytes: number;
    ram_needed_bytes: number;
  };
}
interface UpstreamUpgrade {
  plan?: {
    llm?: {
      model?: { id?: unknown };
      placement?: { gpus?: { index?: unknown }[] };
    };
    budget?: {
      download_bytes?: unknown;
      disk_needed_bytes?: unknown;
      ram_needed_bytes?: unknown;
    };
  } | null;
  summary?: {
    llm?: unknown;
    llmName?: unknown;
    downloadBytes?: unknown;
    diskBytes?: unknown;
    memoryBytes?: unknown;
  } | null;
  reasons?: unknown;
  gpuApps?: unknown;
}
interface UpstreamReport {
  schema: string;
  facts: {
    platform: string;
    arch: string;
    ram: { total_bytes: number };
    disk: { free_bytes: number | null };
    gpus: {
      index: number;
      uuid?: string;
      name: string;
      total_bytes: number;
      free_bytes: number;
    }[];
    services?: { compute_processes?: { gpu_uuid: string }[] | null };
  };
  stack: {
    available: boolean;
    state?: LocalModelsState;
    hardwareCapable?: boolean | null;
    basis?: "capacity" | null;
    memory?: SetupMemory | null;
    reasons: SetupReason[];
    plan: UpstreamPlan | null;
    upgrade?: UpstreamUpgrade | null;
  };
  harness: {
    schema: string;
    runtimes: {
      runtime: RuntimeChoice;
      installed: boolean;
      authenticated: boolean | null;
      estimate?: SetupEstimate;
    }[];
  };
  recommendation: SetupChoice;
}
export const setupChoices: readonly SetupChoice[] = [
  "local-models",
  "codex",
  "claude",
  "pi",
];
/**
 * Presentation adapter only. Host probes, admission, recommendation and
 * budgets belong upstream, with one exception: when local models are blocked
 * now, a tool before setup-report `stack.state` still picks "local-models",
 * which its own install-time plan refuses; the adapter replaces that pick.
 * Remove the override and the fallbacks once the pinned tool reports `state`.
 */
export async function inspectSetup(
  options: SetupOptions = {},
): Promise<SetupReport> {
  options.signal?.throwIfAborted();
  const home = path.resolve(
    options.home ?? path.join(options.userHome ?? homedir(), ".simplexai"),
  );
  const targetHome = path.resolve(options.targetHome ?? home);
  let failure: string | undefined;
  try {
    const args = [
      "setup",
      "inspect",
      "--root",
      path.join(targetHome, "runtime", "harness"),
      "--model-base-dir",
      path.join(targetHome, "runtime", "localmodels", "models"),
      "--decision",
      "none",
      "--offline",
      "--defer-services",
      ...((options.shareGpu ?? DEFAULT_GPU_SHARING) ? ["--share-gpu"] : []),
      // Reason messages and the summary in English, as the app shows them.
      "--lang",
      "en",
      "--json",
    ];
    const result = await (options.localmodels ?? runLocalmodels)(home, args, {
      signal: options.signal,
      timeoutMs: 120000,
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    });
    options.signal?.throwIfAborted();
    if (result.code !== 0) {
      const { cause, log } = localmodelsFailure(args, result);
      // The cause goes first: the desktop logs only the first stderr lines,
      // and the full output after it can be a long traceback.
      if (cause)
        options.onEvent?.({
          kind: "log",
          message: `localmodels setup inspect failed: ${cause}`,
        });
      for (const message of log) options.onEvent?.({ kind: "log", message });
      failure = cause;
      throw new Error("Upstream setup failed");
    }
    const value = JSON.parse(result.stdout) as UpstreamReport;
    if (
      value.schema !== "localmodels.setup-report/v1" ||
      value.harness.schema !== "localmodels.harness-status/v1" ||
      !setupChoices.includes(value.recommendation) ||
      typeof value.stack.available !== "boolean"
    )
      throw new Error("Invalid upstream report");
    const plan = value.stack.plan;
    if (value.stack.available && !plan)
      throw new Error("Missing upstream plan");
    const estimate = (budget?: SetupEstimate): SetupEstimate => ({
      downloadBytes: budget?.downloadBytes ?? null,
      diskBytes: budget?.diskBytes ?? null,
      memoryBytes: budget?.memoryBytes ?? null,
      durationSeconds: budget?.durationSeconds ?? null,
      assumption:
        budget?.assumption ??
        "Resource estimates are unavailable from localmodels.",
    });
    // Either structured mark means the plan needs memory other programs
    // hold now, which the install-time plan refuses.
    const capacity =
      value.stack.basis === "capacity" ||
      value.stack.reasons.some(
        (reason) => reason.code === "free-memory-required",
      );
    // The tool's own state when it reports one; an older tool marks the
    // blocked case only by the capacity basis or reason.
    const states: readonly string[] = ["ready", "blocked-now", "unavailable"];
    const state: LocalModelsState =
      value.stack.state && states.includes(value.stack.state)
        ? value.stack.state
        : capacity
          ? "blocked-now"
          : value.stack.available
            ? "ready"
            : "unavailable";
    const ok = (bytes: unknown): bytes is number =>
      typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0;
    const version = (text: unknown): text is string =>
      typeof text === "string" && /^\d+(?:\.\d+){0,2}$/.test(text);
    const counts = (memory: SetupMemory) => {
      if (!ok(memory.ramAvailableBytes) || !ok(memory.ramRequiredBytes))
        return undefined;
      return {
        ramAvailableBytes: memory.ramAvailableBytes,
        ramRequiredBytes: memory.ramRequiredBytes,
        ...(ok(memory.vramFreeBytes) && ok(memory.vramRequiredBytes)
          ? {
              vramFreeBytes: memory.vramFreeBytes,
              vramRequiredBytes: memory.vramRequiredBytes,
            }
          : {}),
      };
    };
    const sanitizeReason = ({
      code,
      message,
      gpuIndex,
      freeBytes,
      requiredBytes,
      detectedCudaVersion,
      requiredCudaVersion,
      driverVersion,
    }: SetupReason): SetupReason => ({
      code,
      message,
      ...(ok(gpuIndex) ? { gpuIndex } : {}),
      ...(ok(freeBytes) ? { freeBytes } : {}),
      ...(ok(requiredBytes) ? { requiredBytes } : {}),
      ...(version(detectedCudaVersion) ? { detectedCudaVersion } : {}),
      ...(version(requiredCudaVersion) ? { requiredCudaVersion } : {}),
      ...(version(driverVersion) ? { driverVersion } : {}),
    });
    const parseUpgrade = (
      raw: UpstreamUpgrade | null | undefined,
    ): SetupUpgrade | undefined => {
      if (!raw || typeof raw !== "object") return undefined;
      const planModel =
        typeof raw.plan?.llm?.model?.id === "string"
          ? raw.plan.llm.model.id.trim()
          : "";
      const summaryModel =
        typeof raw.summary?.llm === "string" ? raw.summary.llm.trim() : "";
      const model = planModel || summaryModel;
      if (!model) return undefined;
      const reasons = Array.isArray(raw.reasons)
        ? raw.reasons
            .filter(
              (entry): entry is SetupReason =>
                Boolean(entry) &&
                typeof entry === "object" &&
                typeof (entry as { code?: unknown }).code === "string" &&
                (entry as { code: string }).code.length > 0 &&
                typeof (entry as { message?: unknown }).message === "string",
            )
            .map(sanitizeReason)
        : [];
      if (reasons.length === 0) return undefined;
      const modelName =
        typeof raw.summary?.llmName === "string" && raw.summary.llmName.trim()
          ? raw.summary.llmName.trim()
          : undefined;
      const firstGpu = raw.plan?.llm?.placement?.gpus?.[0]?.index;
      const selectedGpuIndex = ok(firstGpu) ? firstGpu : null;
      const downloadBytes = ok(raw.plan?.budget?.download_bytes)
        ? raw.plan.budget.download_bytes
        : ok(raw.summary?.downloadBytes)
          ? raw.summary.downloadBytes
          : null;
      const diskBytes = ok(raw.plan?.budget?.disk_needed_bytes)
        ? raw.plan.budget.disk_needed_bytes
        : ok(raw.summary?.diskBytes)
          ? raw.summary.diskBytes
          : null;
      const memoryBytes = ok(raw.plan?.budget?.ram_needed_bytes)
        ? raw.plan.budget.ram_needed_bytes
        : ok(raw.summary?.memoryBytes)
          ? raw.summary.memoryBytes
          : null;
      const hasBudget =
        downloadBytes !== null || diskBytes !== null || memoryBytes !== null;
      const gpuApps = Array.isArray(raw.gpuApps)
        ? raw.gpuApps.flatMap((entry): SetupUpgradeGpuApp[] => {
            if (!entry || typeof entry !== "object") return [];
            const { name, pids, bytes } = entry as {
              name?: unknown;
              pids?: unknown;
              bytes?: unknown;
            };
            if (typeof name !== "string" || !name.trim() || !ok(bytes))
              return [];
            const cleanPids = Array.isArray(pids)
              ? pids.filter(
                  (pid): pid is number =>
                    typeof pid === "number" &&
                    Number.isSafeInteger(pid) &&
                    pid >= 0,
                )
              : [];
            return [{ name: name.trim(), pids: cleanPids, bytes }];
          })
        : [];
      return {
        ...(modelName ? { modelName } : {}),
        selectedGpuIndex,
        estimate: {
          ...estimate(
            hasBudget
              ? {
                  downloadBytes,
                  diskBytes,
                  memoryBytes,
                  durationSeconds: null,
                  assumption:
                    "Resource plan supplied by localmodels; duration is unknown.",
                }
              : undefined,
          ),
          model,
        },
        reasons,
        ...(gpuApps.length ? { gpuApps } : {}),
      };
    };
    const upgrade = parseUpgrade(value.stack.upgrade);
    const memory = value.stack.memory ? counts(value.stack.memory) : undefined;
    const runtimes = value.harness.runtimes;
    const installed = runtimes.filter((row) => row.installed);
    // A tool before `stack.state` recommends local models whenever they fit
    // the hardware, even when they cannot be installed until memory is
    // freed. Then the adapter picks as upstream does for unavailable local
    // models: an installed (signed-in first) runtime, else Codex.
    const recommendation =
      state === "blocked-now" && value.recommendation === "local-models"
        ? ((installed.find((row) => row.authenticated) ?? installed[0])
            ?.runtime ?? "codex")
        : value.recommendation;
    return {
      hardware: {
        platform: value.facts.platform,
        arch: value.facts.arch,
        totalMemoryBytes: value.facts.ram.total_bytes,
        diskFreeBytes: value.facts.disk.free_bytes,
        gpus: value.facts.gpus.map((g) => ({
          index: g.index,
          name: g.name,
          totalMemoryBytes: g.total_bytes,
          freeMemoryBytes: g.free_bytes,
          busy:
            value.facts.services?.compute_processes?.some(
              (process) => process.gpu_uuid === g.uuid,
            ) ?? false,
        })),
      },
      choices: [...setupChoices],
      localModels: {
        eligible: state === "ready" && value.stack.available,
        state,
        ...(typeof value.stack.hardwareCapable === "boolean" ||
        value.stack.hardwareCapable === null
          ? { hardwareCapable: value.stack.hardwareCapable }
          : {}),
        ...(memory ? { memory } : {}),
        reasons: value.stack.reasons.map(sanitizeReason),
        ...(capacity ? { basis: "capacity" as const } : {}),
        selectedGpuIndex: plan?.llm.placement.gpus[0]?.index ?? null,
        estimate: {
          ...estimate(
            plan
              ? {
                  downloadBytes: plan.budget.download_bytes,
                  diskBytes: plan.budget.disk_needed_bytes,
                  memoryBytes: plan.budget.ram_needed_bytes,
                  durationSeconds: null,
                  assumption:
                    "Resource plan supplied by localmodels; duration is unknown.",
                }
              : undefined,
          ),
          model: plan?.llm.model.id ?? "",
        },
        ...(upgrade ? { upgrade } : {}),
      },
      runtimes: runtimes.map((row) => ({
        choice: row.runtime,
        installed: row.installed,
        auth:
          row.authenticated === null
            ? "unknown"
            : row.authenticated
              ? "authenticated"
              : "unauthenticated",
        estimate: estimate(row.estimate),
      })),
      recommendation,
    };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (windowsPrivateRefusal(error)) throw error;
    throw Object.assign(
      new Error(
        failure
          ? `The localmodels setup check failed: ${failure}`
          : "The localmodels setup report is unavailable. Check the verified tool installation and retry.",
      ),
      { code: "LOCALMODELS_SETUP_UNAVAILABLE" },
    );
  }
}
