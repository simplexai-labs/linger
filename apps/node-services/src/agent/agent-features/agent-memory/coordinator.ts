import {
  decodeExecutionContextKey,
  type ExecutionContextRef,
} from "../../executor/context-ref.js";
import type { Ghost } from "../../executor/ghost.js";
import type {
  RuntimeHistoryJsonValue,
  RuntimeHistoryOptions,
  RuntimeHistoryRecord,
  RuntimeHistoryInspection,
} from "../../executor/history.js";
import type { AgentId } from "../../executor/types.js";
import type { LocalRuntimeSettings } from "../../runtime-settings.js";
import type { TeamHubRuntimeStateClient } from "../../executor/teamhub-runtime-state-client.js";
import type { AgentLogger } from "../../observability/agent-log.js";
import { ModelCallError, type ModelCall } from "../../../runtime-model-call.js";
import type { MemoryClient } from "./client.js";
import { memoryInstructions, memoryOutputSchema } from "./prompts.js";
import {
  applyMemoryEdits,
  InvalidMemoryOutputError,
  memorySectionHeadings,
} from "./sections.js";
import { sha256Hex } from "@linger/service-kit/node";

// A failed maintenance step waits before retrying: 1, 2, 4 ... 60 minutes.
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const STAGE_TIMEOUT_MS = { extract: 5 * 60_000, consolidate: 10 * 60_000 };
// Passes whose stage call fails past its own attempts with an invalid or
// timed-out output, allowed per stage before maintenance stops for the Agent.
const MAX_STAGE_ATTEMPTS = 3;
// Extraction shares the model with the conversation it reads, so it waits
// for this many succeeded Meta Runs instead of following every one.
const RUNS_PER_EXTRACTION = 5;
// Consolidation sends the whole memory to the model. As in Codex, it waits until the
// Agent has had no succeeded Run for this long. Every consolidation needs a
// later Run to become due again, so this also spaces consolidations apart.
const IDLE_BEFORE_CONSOLIDATION_MS = 6 * 60 * 60_000;
// Waiting candidates past this size, or in every session slot, are
// consolidated before more are extracted, so an Agent that is never idle
// stays within the document limits.
const MAX_WAITING_CANDIDATE_BYTES = 64_000;
const MAX_SESSIONS = 30;
// Memory sources are the conversation and its tool traffic. Usage, lifecycle,
// reasoning and provider events add no fact (Codex repeats every item as a
// provider event), and a compaction summary restates earlier records.
const SOURCE_CATEGORIES: ReadonlySet<RuntimeHistoryRecord["category"]> =
  new Set(["message", "tool_call", "tool_result"]);
// A longer string, typically a file or page a tool returned, keeps its head.
const MAX_SOURCE_TEXT = 4_000;
// A stage's input, instructions included, takes half of the Agent model's
// context window. Runtimes that report no window (such as Codex) or a large
// window keep the three-bytes-per-token estimate and fixed ceilings; runtimes
// reporting a constrained window (<= 128K tokens, such as 65K local models)
// use a conservative 1.5 UTF-8 bytes-per-token estimate so dense non-ASCII
// and JSON transcripts fit below the window on the first attempt.
const WINDOW_INPUT_SHARE = 0.5;
const BYTES_PER_TOKEN = 3;
const CONSTRAINED_BYTES_PER_TOKEN = 1.5;
const CONSTRAINED_CONTEXT_WINDOW = 131_072;
const MAX_INPUT_BYTES = 400_000;
const MAX_EXTRACTION_RECORD_BYTES = 250_000;
const MAX_MEMORY_BYTES = 200_000;
const MIN_ADAPTIVE_INPUT_BYTES = 4_096;
const MAX_SHRINK_STEPS_PER_PASS = 4;

export interface MemoryBudget {
  /** One stage's input, instructions included. */
  readonly input: number;
  /** The Memory a consolidation may produce: at most half of its input, so
   * candidates always have room beside it. */
  readonly memory: number;
}

export function memoryBudget(
  contextWindow: number | undefined,
  adaptiveInputBytes?: number,
): MemoryBudget {
  const bytesPerToken =
    contextWindow !== undefined && contextWindow <= CONSTRAINED_CONTEXT_WINDOW
      ? CONSTRAINED_BYTES_PER_TOKEN
      : BYTES_PER_TOKEN;
  const windowInput =
    contextWindow === undefined
      ? MAX_INPUT_BYTES
      : Math.min(
          MAX_INPUT_BYTES,
          Math.floor(contextWindow * WINDOW_INPUT_SHARE * bytesPerToken),
        );
  const input =
    adaptiveInputBytes === undefined
      ? windowInput
      : Math.max(
          MIN_ADAPTIVE_INPUT_BYTES,
          Math.min(windowInput, adaptiveInputBytes),
        );
  return {
    input,
    memory: Math.min(MAX_MEMORY_BYTES, Math.floor(windowInput / 2)),
  };
}

/**
 * Preserves existing persisted memory when an Agent already holds more memory
 * than a tighter window budget allows (for example after switching to a
 * smaller local model), preventing forced deletion or repeated validation errors.
 */
function consolidationMemoryLimit(
  budgetMemory: number,
  existingMemory: string,
): number {
  const existingBytes = bytes(existingMemory);
  if (existingBytes <= budgetMemory) return budgetMemory;
  return Math.min(
    MAX_MEMORY_BYTES,
    existingBytes + Math.max(16_384, Math.floor(budgetMemory / 2)),
  );
}

function bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * `resume` only finishes a pending stage, `extract` also reads new history,
 * and `consolidate` then merges every waiting candidate once.
 */
type PassMode = "resume" | "extract" | "consolidate";

function clip(
  value: RuntimeHistoryJsonValue,
  maxText = MAX_SOURCE_TEXT,
): RuntimeHistoryJsonValue {
  if (typeof value === "string")
    return value.length > maxText
      ? `${value.slice(0, maxText)}… [${value.length - maxText} characters omitted]`
      : value;
  if (Array.isArray(value)) return value.map((item) => clip(item, maxText));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, clip(item, maxText)]),
    );
  return value;
}

function clipStringToBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (bytes(value) <= maxBytes) return value;
  const suffix = "… [omitted]";
  const suffixBytes = bytes(suffix);
  if (maxBytes <= suffixBytes) return "";
  const budget = maxBytes - suffixBytes;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (bytes(value.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  let end = low;
  if (end > 0) {
    const lastCode = value.charCodeAt(end - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) end -= 1;
  }
  return `${value.slice(0, end)}${suffix}`;
}

/**
 * Fits a string so its JSON-encoded representation (`JSON.stringify(value)`)
 * uses at most `maxJsonBytes`.
 */
function clipJsonStringToBytes(value: string, maxJsonBytes: number): string {
  if (maxJsonBytes <= 2) return "";
  if (bytes(JSON.stringify(value)) <= maxJsonBytes) return value;
  let bound = Math.max(0, maxJsonBytes - 2);
  let candidate = clipStringToBytes(value, bound);
  while (
    candidate.length > 0 &&
    bytes(JSON.stringify(candidate)) > maxJsonBytes
  ) {
    bound = Math.floor(bound * 0.75);
    candidate = clipStringToBytes(value, bound);
  }
  return candidate;
}

const MEMORY_SECTION_HEADING = /^## +(.*\S)\s*$/u;
const MEMORY_FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const MEMORY_OMITTED_MARKER =
  "[earlier memory sections omitted to fit context budget]\n\n";

/**
 * Trims markdown memory to fit within `maxJsonBytes` (as a JSON string),
 * preserving the most recent `## ` sections when possible.
 */
function clipMemoryToJsonBytes(memory: string, maxJsonBytes: number): string {
  if (maxJsonBytes <= 2) return "";
  if (bytes(JSON.stringify(memory)) <= maxJsonBytes) return memory;
  const sections: string[][] = [];
  let fence: string | undefined;
  for (const line of memory.split("\n")) {
    const marker = MEMORY_FENCE.exec(line)?.[1];
    if (marker && (!fence || marker.startsWith(fence)))
      fence = fence ? undefined : marker;
    const isHeading = !fence && !marker && MEMORY_SECTION_HEADING.test(line);
    if (isHeading) sections.push([line]);
    else if (sections.length > 0) sections.at(-1)!.push(line);
  }
  if (sections.length > 1) {
    const kept: string[] = [];
    for (let i = sections.length - 1; i >= 0; i -= 1) {
      const candidate =
        MEMORY_OMITTED_MARKER + [sections[i]!.join("\n"), ...kept].join("\n");
      if (bytes(JSON.stringify(candidate)) > maxJsonBytes) break;
      kept.unshift(sections[i]!.join("\n"));
    }
    if (kept.length > 0) {
      return MEMORY_OMITTED_MARKER + kept.join("\n");
    }
  }
  return clipJsonStringToBytes(memory, maxJsonBytes);
}

interface PreviousMemory {
  summary: string;
  memory: string;
}

/**
 * Trims `previous.summary` and `previous.memory` so `JSON.stringify(result)`
 * fits within `maxBytes`.
 */
function fitPreviousMemory(
  previous: PreviousMemory,
  maxBytes: number,
): PreviousMemory {
  if (bytes(JSON.stringify(previous)) <= maxBytes) return previous;
  const emptyShell = bytes(JSON.stringify({ summary: "", memory: "" }));
  if (maxBytes <= emptyShell) return { summary: "", memory: "" };
  const contentBudget = maxBytes - emptyShell;
  const summaryBudget = Math.min(
    bytes(JSON.stringify(previous.summary)),
    Math.max(2, Math.floor(contentBudget / 4) + 2),
  );
  const summary = clipJsonStringToBytes(previous.summary, summaryBudget);
  const usedBySummary = bytes(JSON.stringify(summary)) - 2;
  const memoryJsonBudget = Math.max(2, contentBudget - usedBySummary + 2);
  const memory = clipMemoryToJsonBytes(previous.memory, memoryJsonBudget);
  return { summary, memory };
}

/**
 * Progressively clips a single history record's text fields until its
 * serialized JSON fits within maxBytes, or returns undefined if even the
 * record skeleton exceeds maxBytes.
 */
function fitRecordToBytes(
  record: RuntimeHistoryRecord,
  maxBytes: number,
): RuntimeHistoryRecord | undefined {
  if (maxBytes <= 0) return undefined;
  if (bytes(JSON.stringify(record)) <= maxBytes) return record;
  for (const limit of [2_000, 1_000, 500, 250, 128, 64, 0]) {
    const candidate: RuntimeHistoryRecord = {
      ...record,
      nativeRecord: clip(
        record.nativeRecord,
        limit,
      ) as RuntimeHistoryRecord["nativeRecord"],
    };
    if (bytes(JSON.stringify(candidate)) <= maxBytes) return candidate;
  }
  return undefined;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function snapBeforeSurrogate(value: string, index: number): number {
  if (index <= 0 || index >= value.length) return index;
  return isHighSurrogate(value.charCodeAt(index - 1)) &&
    isLowSurrogate(value.charCodeAt(index))
    ? index - 1
    : index;
}

interface RawMemorySplit {
  readonly head: string;
  readonly remaining: string;
}

/**
 * Splits `value` into a head prefix whose JSON representation fits within
 * `maxJsonBytes` and the unconsumed tail for the next consolidation. Prefers
 * paragraph (`\n\n`) and line (`\n`) boundaries without breaking UTF-16
 * surrogate pairs, and returns an empty head and tail when not even one code
 * point fits so consolidation still terminates.
 */
function splitRawMemoryToJsonBytes(
  value: string,
  maxJsonBytes: number,
): RawMemorySplit {
  if (bytes(JSON.stringify(value)) <= maxJsonBytes) {
    return { head: value, remaining: "" };
  }
  if (maxJsonBytes <= 2) {
    return { head: "", remaining: "" };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    let mid = Math.ceil((low + high) / 2);
    let step = 1;
    if (
      mid > 0 &&
      mid < value.length &&
      isHighSurrogate(value.charCodeAt(mid - 1)) &&
      isLowSurrogate(value.charCodeAt(mid))
    ) {
      if (mid - 1 > low) {
        mid -= 1;
      } else {
        mid += 1;
        step = 2;
      }
    }
    if (bytes(JSON.stringify(value.slice(0, mid))) <= maxJsonBytes) {
      low = mid;
    } else {
      high = snapBeforeSurrogate(value, mid - step);
    }
  }
  const maxEnd = low;
  if (maxEnd <= 0) {
    return { head: "", remaining: "" };
  }
  const minBoundary = Math.max(1, Math.floor(maxEnd / 2));
  let end = maxEnd;
  if (!value.startsWith("\n\n", maxEnd)) {
    const paraIdx = maxEnd >= 2 ? value.lastIndexOf("\n\n", maxEnd - 2) : -1;
    if (paraIdx >= minBoundary) {
      end = paraIdx;
    } else if (!value.startsWith("\n", maxEnd)) {
      const lineIdx = value.lastIndexOf("\n", maxEnd - 1);
      if (lineIdx >= minBoundary) {
        end =
          lineIdx > 1 && value.charCodeAt(lineIdx - 1) === 0x0d
            ? lineIdx - 1
            : lineIdx;
      }
    }
  }
  if (
    end === maxEnd &&
    end > 1 &&
    value.charCodeAt(end - 1) === 0x0d &&
    value.charCodeAt(end) === 0x0a
  ) {
    end -= 1;
  }
  return {
    head: value.slice(0, end),
    remaining: value.slice(end).trimStart(),
  };
}

interface ConsolidateExtraction {
  key: string;
  context_key: string;
  summary: string;
  raw_memory: string;
}

interface FittedExtraction {
  readonly extraction: ConsolidateExtraction;
  readonly clipped: boolean;
  readonly beforeBytes: number;
  readonly afterBytes: number;
  readonly remainingBytes: number;
}

function fitExtractionToBytes(
  extraction: ConsolidateExtraction,
  maxBytes: number,
): FittedExtraction {
  const beforeBytes = bytes(JSON.stringify(extraction));
  if (beforeBytes <= maxBytes) {
    return {
      extraction,
      clipped: false,
      beforeBytes,
      afterBytes: beforeBytes,
      remainingBytes: 0,
    };
  }
  const emptyShell = bytes(
    JSON.stringify({ ...extraction, summary: "", raw_memory: "" }),
  );
  if (maxBytes <= emptyShell) {
    const fitted: ConsolidateExtraction = {
      ...extraction,
      summary: "",
      raw_memory: "",
    };
    return {
      extraction: fitted,
      clipped: true,
      beforeBytes,
      afterBytes: emptyShell,
      remainingBytes: 0,
    };
  }
  const contentBudget = maxBytes - emptyShell;
  const summaryBudget = Math.min(
    bytes(JSON.stringify(extraction.summary)),
    Math.max(2, Math.floor(contentBudget / 3) + 2),
  );
  const summary = clipJsonStringToBytes(extraction.summary, summaryBudget);
  const usedBySummary = bytes(JSON.stringify(summary)) - 2;
  const rawMemoryBudget = Math.max(2, contentBudget - usedBySummary + 2);
  const split = splitRawMemoryToJsonBytes(
    extraction.raw_memory,
    rawMemoryBudget,
  );
  const fitted: ConsolidateExtraction = {
    ...extraction,
    summary,
    raw_memory: split.head,
  };
  return {
    extraction: fitted,
    clipped: true,
    beforeBytes,
    afterBytes: bytes(JSON.stringify(fitted)),
    remainingBytes: bytes(split.remaining),
  };
}

interface AdaptiveInputCap {
  readonly bytes: number;
  readonly window: number | undefined;
}

interface BuiltExtractBatch {
  readonly sourceKey: string;
  readonly threadId: string;
  readonly firstOrdinal: number;
  readonly recordCount: number;
}

/**
 * Narrow host capability the maintenance Coordinator needs: Ghost lookup for
 * Runtime placement and Meta Context history reads. Maintenance itself runs
 * as stateless model calls, never as a Context or Run.
 */
export interface AgentMemoryHost {
  getGhost(
    agentId: AgentId,
  ): Promise<Readonly<Ghost<LocalRuntimeSettings>> | null>;
  inspectDebugContextHistory(
    ref: ExecutionContextRef,
    options: RuntimeHistoryOptions,
  ): Promise<RuntimeHistoryInspection>;
}

/** Reconciles derived memory through stateless model calls; never a Run. */
export class AgentMemoryCoordinator {
  readonly #stop = new AbortController();
  readonly #running = new Map<string, Promise<void>>();
  readonly #backoff = new Map<string, { until: number; failures: number }>();
  // Learned per-Agent input byte ceiling after a confirmed invalid_request
  // context-overflow failure. Reset when contextWindow changes and gradually
  // relaxed after clean passes without shrinks.
  readonly #adaptiveInputBytes = new Map<string, AdaptiveInputCap>();
  // Meta Context input positions an Agent was last fully caught up to. A
  // scan skips the Agent until one of them receives new input.
  readonly #settled = new Map<string, string>();
  // Scheduling state is kept in process only. After a restart the Run count
  // starts from zero, and waiting candidates count from the first scan.
  // Succeeded Meta Runs since the Agent's last extracting pass.
  readonly #runs = new Map<string, number>();
  // When an Agent with unconsolidated work last finished a succeeded Run.
  readonly #lastRunAt = new Map<string, number>();
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(
    private readonly options: {
      host: AgentMemoryHost;
      runtimeState: TeamHubRuntimeStateClient;
      memory: MemoryClient;
      modelCall: ModelCall;
      logger: Pick<AgentLogger, "log">;
      /**
       * Whether a Local Computer is online and can serve this Runtime's
       * history now. Maintenance never wakes or waits for a Computer.
       */
      canReadHistory?: (
        computerId: string,
        runtimeType: "codex" | "claude" | "pi",
      ) => boolean;
      now?: () => number;
    },
  ) {
    // Run terminals (recordRun) and compaction starts (wake) arrive through
    // the Context feature ports; no self-managed subscription here.
    this.#timer = setInterval(() => {
      void this.reconcile();
    }, 30_000);
    this.#timer.unref();
  }

  async reconcile(): Promise<void> {
    if (this.#stop.signal.aborted) return;
    try {
      const contexts = await this.options.runtimeState.listContexts(
        undefined,
        this.#stop.signal,
      );
      const inputs = new Map<string, string[]>();
      for (const context of contexts) {
        const positions = inputs.get(context.ref.agent_id) ?? [];
        if (context.ref.kind === "meta" && !context.terminal_reason)
          positions.push(
            `${context.context_key}:${context.next_input_sequence}`,
          );
        inputs.set(context.ref.agent_id, positions);
      }
      await Promise.all(
        [...inputs].map(([id, positions]) => {
          const signature = positions.sort().join("\n");
          return this.#settled.get(id) === signature &&
            !this.#extractionDue(id) &&
            !this.#consolidationDue(id)
            ? Promise.resolve()
            : this.#wake(id, signature);
        }),
      );
    } catch (error) {
      this.#log(error);
    }
  }

  /**
   * Counts one succeeded Meta Run: extraction starts once enough add up, and
   * consolidation waits for the Agent to stay idle after it.
   */
  recordRun(agentId: string): Promise<void> {
    this.#runs.set(agentId, (this.#runs.get(agentId) ?? 0) + 1);
    this.#lastRunAt.set(agentId, this.#now());
    return this.#extractionDue(agentId)
      ? this.#wake(agentId)
      : Promise.resolve();
  }

  /** Extracts and consolidates now, without waiting for Runs or idleness. */
  wake(agentId: string): Promise<void> {
    return this.#wake(agentId, undefined, true);
  }

  #extractionDue(agentId: string): boolean {
    return (this.#runs.get(agentId) ?? 0) >= RUNS_PER_EXTRACTION;
  }

  #consolidationDue(agentId: string): boolean {
    const lastRunAt = this.#lastRunAt.get(agentId);
    return (
      lastRunAt !== undefined &&
      this.#now() - lastRunAt >= IDLE_BEFORE_CONSOLIDATION_MS
    );
  }

  #wake(agentId: string, signature?: string, force = false): Promise<void> {
    if (this.#stop.signal.aborted) return Promise.resolve();
    const running = this.#running.get(agentId);
    if (running) return running;
    const backoff = this.#backoff.get(agentId);
    if (backoff && backoff.until > this.#now()) return Promise.resolve();
    const runs = this.#runs.get(agentId) ?? 0;
    const lastRunAt = this.#lastRunAt.get(agentId);
    const mode: PassMode =
      force || this.#consolidationDue(agentId)
        ? "consolidate"
        : runs >= RUNS_PER_EXTRACTION
          ? "extract"
          : "resume";
    const work = this.#advance(agentId, mode)
      .then((settled) => {
        this.#backoff.delete(agentId);
        if (settled && signature !== undefined)
          this.#settled.set(agentId, signature);
        else this.#settled.delete(agentId);
        if (settled && mode !== "resume") {
          // Runs that finished during this pass count toward the next one.
          const left = (this.#runs.get(agentId) ?? 0) - runs;
          if (left > 0) this.#runs.set(agentId, left);
          else this.#runs.delete(agentId);
        }
        // History left unread by this pass waits for the next Run, so an
        // offline Computer is not retried every scan.
        if (
          mode === "consolidate" &&
          this.#lastRunAt.get(agentId) === lastRunAt
        )
          this.#lastRunAt.delete(agentId);
      })
      .catch((error) => {
        this.#settled.delete(agentId);
        const failures = (backoff?.failures ?? 0) + 1;
        this.#backoff.set(agentId, {
          failures,
          until:
            this.#now() +
            Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS),
        });
        this.#log(error, agentId);
      })
      .finally(() => this.#running.delete(agentId));
    this.#running.set(agentId, work);
    return work;
  }

  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#stop.abort();
    await Promise.all(this.#running.values());
  }

  /**
   * Resolves true only when every Meta Context was read and nothing is left to
   * do. An extracting pass reads every batch its Contexts held when it began;
   * a consolidating pass then merges the waiting candidates once.
   */
  async #advance(agentId: string, mode: PassMode): Promise<boolean> {
    const { host, runtimeState, memory } = this.options;
    const signal = this.#stop.signal;
    const ghost = await host.getGhost(agentId);
    if (!ghost) {
      // Ghost store maps only HTTP 404 to null (teamhub-ghost-store.ts get catch + isNotFound).
      this.options.logger.log("info", "agent_memory.settled_config_gone", {
        agentId,
        status: 404,
      });
      return true;
    }
    const runtime = ghost.runtime.placement.runtimeType;
    if (runtime !== "codex" && runtime !== "claude" && runtime !== "pi")
      return true;
    const computerId = ghost.runtime.placement.computerId;
    // Both stages run on the Agent's own Computer and Runtime.
    const placement = {
      tenantId: ghost.runtime.placement.tenantId,
      ownerActorId: ghost.runtime.placement.ownerActorId,
      agentId,
      computerId,
      runtimeType: runtime,
      ...(ghost.runtime.model ? { model: ghost.runtime.model } : {}),
    };
    // Looked up once per pass, and only when a stage is built or run. An
    // offline Computer fails the pass as the model call would, so no stage
    // is sized without the window.
    let resolvedWindow: { readonly value: number | undefined } | undefined;
    const budgetOf = async (): Promise<MemoryBudget> => {
      resolvedWindow ??= {
        value: await this.options.modelCall.contextWindow?.(
          { placement },
          signal,
        ),
      };
      const adaptive = this.#adaptiveInputBytes.get(agentId);
      if (adaptive && adaptive.window !== resolvedWindow.value) {
        this.#adaptiveInputBytes.delete(agentId);
      }
      return memoryBudget(
        resolvedWindow.value,
        this.#adaptiveInputBytes.get(agentId)?.bytes,
      );
    };
    let document = await memory.read(agentId, signal);
    // Candidates found waiting after a restart start their idle period now.
    if (
      !this.#lastRunAt.has(agentId) &&
      Object.values(document.sessions).some((session) => session.raw_memory)
    )
      this.#lastRunAt.set(agentId, this.#now());
    // Reading history is not an execution demand: an offline or sleeping
    // Computer is skipped. Pending stages and consolidation need no Computer.
    const readable = this.options.canReadHistory?.(computerId, runtime) ?? true;
    let settled = true;
    let completedStages = 0;
    let hadInvalidRequestShrink = false;
    let shrinkSteps = 0;
    let rebuildStage: "extract" | "consolidate" | undefined;
    let builtInPass = false;
    let lastBuiltExtract: BuiltExtractBatch | undefined;
    let maxRecordsInBatch: number | undefined;
    const relaxAdaptiveCap = (): void => {
      if (completedStages === 0 || hadInvalidRequestShrink) return;
      const adaptive = this.#adaptiveInputBytes.get(agentId);
      if (!adaptive) return;
      const baseInput = memoryBudget(adaptive.window).input;
      const nextBytes = adaptive.bytes * 2;
      if (nextBytes >= baseInput) this.#adaptiveInputBytes.delete(agentId);
      else
        this.#adaptiveInputBytes.set(agentId, {
          bytes: nextBytes,
          window: adaptive.window,
        });
    };
    // The newest record of each Context when this pass first read it. Records
    // written while the pass runs wait for the next one, so a busy
    // conversation cannot keep one pass going.
    const limits = new Map<string, number>();
    for (;;) {
      if (!document.pending) {
        // A pending stage always resumes; new work waits until it is due.
        if (mode === "resume" && rebuildStage === undefined) {
          relaxAdaptiveCap();
          return settled;
        }
        if (!readable) settled = false;
        const waiting = Object.entries(document.sessions).filter(
          ([, session]) => session.raw_memory,
        );
        const full =
          waiting.length >= MAX_SESSIONS ||
          waiting.reduce(
            (total, [, session]) => total + bytes(session.raw_memory),
            0,
          ) > MAX_WAITING_CANDIDATE_BYTES;
        let extracting = false;
        const shouldExtract =
          readable &&
          (rebuildStage === "extract" || (rebuildStage === undefined && !full));
        for (const context of shouldExtract
          ? await runtimeState.listContexts(agentId, signal)
          : []) {
          if (context.ref.kind !== "meta" || context.terminal_reason) continue;
          // No input yet means no history to read.
          if (context.next_input_sequence === "0") continue;
          if (
            (await runtimeState.getWorkState(context.context_key, signal))
              .has_pending_work
          ) {
            settled = false;
            continue;
          }
          const ref = decodeExecutionContextKey(context.context_key);
          const page = await host.inspectDebugContextHistory(ref, {
            limit: 200,
            signal,
          });
          // Unreadable history waits for the next due pass.
          if (page.status !== "available") continue;
          if (page.snapshot.tailState !== "clean") {
            settled = false;
            continue;
          }
          const sourceKey = sha256Hex(context.context_key);
          const previous = document.sessions[sourceKey]?.summary;
          const cursorState = document.cursors[sourceKey];
          const through =
            cursorState?.thread_id === page.snapshot.threadId
              ? cursorState.through
              : -1;
          const limit =
            limits.get(context.context_key) ??
            page.records.reduce(
              (newest, record) => Math.max(newest, record.ordinal),
              through,
            );
          limits.set(context.context_key, limit);
          let records: RuntimeHistoryRecord[] = [...page.records];
          let cursor = page.previousCursor;
          // Read backwards only as far as the saved watermark. Batches stay bounded;
          // a long session is consumed over several batches rather than silently skipped.
          while (
            cursor &&
            records.every((record) => record.ordinal > through)
          ) {
            const older = await host.inspectDebugContextHistory(ref, {
              cursor,
              limit: 200,
              signal,
            });
            if (
              older.status !== "available" ||
              older.snapshot.id !== page.snapshot.id
            )
              throw new Error("Memory history changed while reading");
            records = [...older.records, ...records];
            cursor = older.previousCursor;
          }
          // Developer and system messages carry the Agent's configuration.
          records = records
            .filter(
              (record) =>
                record.ordinal > through &&
                record.ordinal <= limit &&
                SOURCE_CATEGORIES.has(record.category) &&
                record.role !== "developer" &&
                record.role !== "system",
            )
            .map((record) => ({
              ...record,
              nativeRecord: clip(
                record.nativeRecord,
              ) as RuntimeHistoryRecord["nativeRecord"],
            }))
            .sort((a, b) => a.ordinal - b.ordinal);
          if (
            !records.some(
              (record) =>
                record.category === "message" ||
                record.category === "tool_result",
            )
          )
            continue;
          // The records share the input with the instructions, schema, and the
          // previous summary.
          const currentBudget = await budgetOf();
          const extractOverhead =
            bytes(memoryInstructions("extract", currentBudget.memory)) +
            bytes(JSON.stringify(memoryOutputSchema("extract")));
          const available = Math.max(0, currentBudget.input - extractOverhead);
          const clippedPrevious =
            previous === undefined
              ? null
              : clipStringToBytes(previous, Math.floor(available / 3));
          const wrapperBytes = bytes(
            JSON.stringify({
              source_context: context.context_key,
              previous: clippedPrevious,
              records: [],
            }),
          );
          const room = Math.min(
            MAX_EXTRACTION_RECORD_BYTES,
            Math.max(0, available - wrapperBytes),
          );
          const batch: RuntimeHistoryRecord[] = [];
          let size = 0;
          for (const record of records) {
            if (
              maxRecordsInBatch !== undefined &&
              batch.length >= maxRecordsInBatch
            )
              break;
            const recordBytes =
              bytes(JSON.stringify(record)) + (batch.length ? 1 : 0);
            if (size + recordBytes > room) break;
            batch.push(record);
            size += recordBytes;
          }
          if (!batch.length) {
            const fitted = fitRecordToBytes(records[0]!, room);
            if (fitted) batch.push(fitted);
          }
          if (!batch.length) {
            const skipped = records[0]!;
            this.options.logger.log(
              "warn",
              "agent_memory.record_skipped_oversized",
              {
                agentId,
                source_key: sourceKey,
                ordinal: skipped.ordinal,
                room_bytes: room,
              },
            );
            document = await memory.commit(
              agentId,
              {
                ...document,
                cursors: {
                  ...document.cursors,
                  [sourceKey]: {
                    thread_id: page.snapshot.threadId,
                    through: skipped.ordinal,
                  },
                },
              },
              signal,
            );
            maxRecordsInBatch = undefined;
            extracting = true;
            break;
          }
          const last = batch.at(-1)!.ordinal;
          const prompt = JSON.stringify({
            source_context: context.context_key,
            previous: clippedPrevious,
            records: batch,
          });
          document = await memory.commit(
            agentId,
            {
              ...document,
              pending: {
                stage: "extract",
                prompt,
                source_key: sourceKey,
                thread_id: page.snapshot.threadId,
                through: last,
              },
            },
            signal,
          );
          builtInPass = true;
          lastBuiltExtract = {
            sourceKey,
            threadId: page.snapshot.threadId,
            firstOrdinal: batch[0]!.ordinal,
            recordCount: batch.length,
          };
          rebuildStage = undefined;
          extracting = true;
          break;
        }
        if (!extracting) {
          // Every consolidation clears the candidates it took, so this ends.
          if (
            !waiting.length ||
            (rebuildStage !== "consolidate" && !full && mode !== "consolidate")
          ) {
            relaxAdaptiveCap();
            return settled;
          }
          const currentBudget = await budgetOf();
          const memoryLimit = consolidationMemoryLimit(
            currentBudget.memory,
            document.memory,
          );
          const memorySections = memorySectionHeadings(document.memory);
          const consolidateOverhead =
            bytes(memoryInstructions("consolidate", memoryLimit)) +
            bytes(JSON.stringify(memoryOutputSchema("consolidate")));
          const available = Math.max(
            0,
            currentBudget.input - consolidateOverhead,
          );
          const shellWithoutPrev = bytes(
            JSON.stringify({
              previous: { summary: "", memory: "" },
              memory_sections: memorySections,
              extractions: [],
            }),
          );
          const emptyPrevBytes = bytes(
            JSON.stringify({ summary: "", memory: "" }),
          );
          const previousBudget = Math.max(
            emptyPrevBytes,
            Math.floor(
              (Math.max(0, available - shellWithoutPrev + emptyPrevBytes) * 2) /
                3,
            ),
          );
          const previousMemory = fitPreviousMemory(
            { summary: document.summary, memory: document.memory },
            previousBudget,
          );
          let size =
            consolidateOverhead +
            bytes(
              JSON.stringify({
                previous: previousMemory,
                memory_sections: memorySections,
                extractions: [],
              }),
            );
          // Sessions least recently extracted go first. Those that do not fit
          // wait for the next consolidation of this pass. A consolidation
          // always takes at least one session; when a sole extraction exceeds
          // the current input budget, its raw_memory is sliced to fit and the
          // unconsumed tail stays in the session for the next consolidation.
          const extractions: ConsolidateExtraction[] = [];
          for (const [key, session] of waiting.sort(
            ([, a], [, b]) => a.updated_revision - b.updated_revision,
          )) {
            let extraction: ConsolidateExtraction = {
              key,
              context_key: session.context_key,
              summary: session.summary,
              raw_memory: session.raw_memory,
            };
            const extractionBytes =
              bytes(JSON.stringify(extraction)) + (extractions.length ? 1 : 0);
            if (
              extractions.length &&
              size + extractionBytes > currentBudget.input
            )
              break;
            let clipped = false;
            if (
              !extractions.length &&
              size + extractionBytes > currentBudget.input
            ) {
              const fitted = fitExtractionToBytes(
                extraction,
                Math.max(0, currentBudget.input - size),
              );
              extraction = fitted.extraction;
              clipped = fitted.clipped;
              if (fitted.clipped) {
                this.options.logger.log(
                  "warn",
                  "agent_memory.extraction_clipped",
                  {
                    agentId,
                    session_id: key,
                    before_bytes: fitted.beforeBytes,
                    after_bytes: fitted.afterBytes,
                    remaining_bytes: fitted.remainingBytes,
                  },
                );
              }
            }
            extractions.push(extraction);
            size +=
              bytes(JSON.stringify(extraction)) +
              (extractions.length > 1 ? 1 : 0);
            if (clipped) break;
          }
          const prompt = JSON.stringify({
            previous: previousMemory,
            memory_sections: memorySections,
            extractions,
          });
          document = await memory.commit(
            agentId,
            { ...document, pending: { stage: "consolidate", prompt } },
            signal,
          );
          builtInPass = true;
          lastBuiltExtract = undefined;
          rebuildStage = undefined;
        }
      }
      // Each pending stage runs to publication. The persisted pending stage is
      // the checkpoint across restarts and the bounded retry counter.
      for (
        let pending = document.pending;
        pending;
        pending = document.pending
      ) {
        const attempt = pending.attempt ?? 0;
        if (attempt >= MAX_STAGE_ATTEMPTS)
          throw new Error(
            `Memory ${pending.stage} produced no valid output in ${MAX_STAGE_ATTEMPTS} attempts`,
          );
        let output: Record<string, unknown>;
        let consolidated: string;
        const { stage } = pending;
        const currentBudget = await budgetOf();
        const previous = document.memory;
        const memoryLimit =
          stage === "consolidate"
            ? consolidationMemoryLimit(currentBudget.memory, previous)
            : currentBudget.memory;
        const instructions = memoryInstructions(stage, memoryLimit);
        const outputSchema = memoryOutputSchema(stage);
        // Drop and rebuild an oversized checkpoint persisted before a tighter
        // budget or model switch through the single stage builder.
        const maxPromptBytes = Math.max(
          0,
          currentBudget.input -
            bytes(instructions) -
            bytes(JSON.stringify(outputSchema)),
        );
        if (
          !builtInPass &&
          bytes(pending.prompt) > maxPromptBytes &&
          (stage === "consolidate" || readable)
        ) {
          const { pending: _dropped, ...rest } = document;
          this.options.logger.log("info", "agent_memory.batch_shrunk", {
            agentId,
            stage,
            before_bytes: bytes(pending.prompt),
            target_input_bytes: currentBudget.input,
            reason: "budget",
          });
          document = await memory.commit(agentId, rest, signal);
          rebuildStage = stage;
          break;
        }
        // Throws what the output schema cannot express; a consolidation
        // returns the memory its edits produce.
        const checked = (candidate: Record<string, unknown>): string => {
          if (stage === "extract") {
            outputText(candidate, "session_summary", 32_000);
            outputText(candidate, "raw_memory", 32_000);
            return "";
          }
          outputText(candidate, "summary", 8_000);
          const edited = applyMemoryEdits(previous, candidate.edits);
          if (bytes(edited) > memoryLimit)
            throw new InvalidMemoryOutputError("Memory exceeds its limit");
          return edited;
        };
        try {
          ({ output } = await this.options.modelCall.call({
            kind: "agent_memory",
            key: `agent-memory:${agentId}:${stage}`,
            placement,
            instructions,
            input: pending.prompt,
            schemaName: `memory_${stage}`,
            outputSchema,
            timeoutMs: STAGE_TIMEOUT_MS[stage],
            // The call corrects an output these checks reject, so a stage
            // fails only past its kind's attempts.
            validate: (candidate) => {
              try {
                checked(candidate);
                return undefined;
              } catch (error) {
                if (error instanceof InvalidMemoryOutputError)
                  return error.message;
                throw error;
              }
            },
            signal,
          }));
          consolidated = checked(output);
        } catch (error) {
          if (
            error instanceof ModelCallError &&
            error.kind === "invalid_request"
          ) {
            const promptBytes = bytes(pending.prompt);
            const totalSentBytes =
              bytes(instructions) +
              bytes(JSON.stringify(outputSchema)) +
              promptBytes;
            const currentCap = currentBudget.input;
            const nextCap = Math.max(
              MIN_ADAPTIVE_INPUT_BYTES,
              Math.min(
                currentCap - 1,
                Math.floor(Math.min(currentCap, totalSentBytes) / 2),
              ),
            );
            const canRebuild = stage === "consolidate" || readable;
            hadInvalidRequestShrink = true;
            if (canRebuild && nextCap < currentCap) {
              this.#adaptiveInputBytes.set(agentId, {
                bytes: nextCap,
                window: resolvedWindow?.value,
              });
              const { pending: _dropped, ...rest } = document;
              this.options.logger.log("warn", "agent_memory.batch_shrunk", {
                agentId,
                stage,
                before_bytes: promptBytes,
                target_input_bytes: nextCap,
                reason: error.kind,
              });
              document = await memory.commit(agentId, rest, signal);
              builtInPass = false;
              lastBuiltExtract = undefined;
              if (shrinkSteps < MAX_SHRINK_STEPS_PER_PASS) {
                shrinkSteps += 1;
                rebuildStage = stage;
                break;
              }
              throw error;
            }
            if (
              canRebuild &&
              stage === "extract" &&
              lastBuiltExtract &&
              lastBuiltExtract.recordCount > 1 &&
              shrinkSteps < MAX_SHRINK_STEPS_PER_PASS
            ) {
              shrinkSteps += 1;
              maxRecordsInBatch = Math.max(
                1,
                Math.floor(lastBuiltExtract.recordCount / 2),
              );
              const { pending: _dropped, ...rest } = document;
              this.options.logger.log("warn", "agent_memory.batch_shrunk", {
                agentId,
                stage,
                before_bytes: promptBytes,
                target_input_bytes: currentCap,
                reason: error.kind,
              });
              document = await memory.commit(agentId, rest, signal);
              builtInPass = false;
              lastBuiltExtract = undefined;
              rebuildStage = "extract";
              break;
            }
            if (
              canRebuild &&
              !builtInPass &&
              shrinkSteps < MAX_SHRINK_STEPS_PER_PASS
            ) {
              shrinkSteps += 1;
              this.#adaptiveInputBytes.set(agentId, {
                bytes: nextCap,
                window: resolvedWindow?.value,
              });
              const { pending: _dropped, ...rest } = document;
              document = await memory.commit(agentId, rest, signal);
              rebuildStage = stage;
              break;
            }
            if (
              stage === "extract" &&
              lastBuiltExtract &&
              lastBuiltExtract.recordCount === 1
            ) {
              const { pending: _dropped, ...rest } = document;
              this.options.logger.log(
                "warn",
                "agent_memory.record_skipped_oversized",
                {
                  agentId,
                  source_key: lastBuiltExtract.sourceKey,
                  ordinal: lastBuiltExtract.firstOrdinal,
                  prompt_bytes: promptBytes,
                },
              );
              document = await memory.commit(
                agentId,
                {
                  ...rest,
                  cursors: {
                    ...document.cursors,
                    [lastBuiltExtract.sourceKey]: {
                      thread_id: lastBuiltExtract.threadId,
                      through: lastBuiltExtract.firstOrdinal,
                    },
                  },
                },
                signal,
              );
              builtInPass = false;
              lastBuiltExtract = undefined;
              maxRecordsInBatch = undefined;
              rebuildStage = "extract";
              break;
            }
            await memory.commit(
              agentId,
              { ...document, pending: { ...pending, attempt: attempt + 1 } },
              signal,
            );
            throw error;
          }
          // Only an output the model produced, or a Runtime that ran out of
          // time producing one, counts against the attempt budget; an offline
          // Computer, a missing Runtime, or a generic failure backs off instead.
          // Either way the stage backs off, so it never holds the model back to back.
          if (
            !(error instanceof InvalidMemoryOutputError) &&
            !(
              error instanceof ModelCallError &&
              (error.kind === "invalid_output" ||
                error.kind === "timed_out" ||
                error.kind === "output_limited")
            )
          )
            throw error;
          await memory.commit(
            agentId,
            { ...document, pending: { ...pending, attempt: attempt + 1 } },
            signal,
          );
          throw error;
        }
        shrinkSteps = 0;
        builtInPass = false;
        lastBuiltExtract = undefined;
        maxRecordsInBatch = undefined;
        completedStages += 1;
        const { pending: _, ...published } = document;
        if (pending.stage === "extract") {
          const { source_key: key, thread_id, through } = pending;
          if (
            key === undefined ||
            thread_id === undefined ||
            through === undefined
          )
            throw new Error("Memory extraction checkpoint names no source");
          const source = JSON.parse(pending.prompt) as {
            source_context: string;
          };
          const waiting = document.sessions[key]?.raw_memory ?? "";
          const found = outputText(output, "raw_memory", 32_000);
          const sessions = { ...document.sessions };
          sessions[key] = {
            context_key: source.source_context,
            thread_id,
            through,
            summary: outputText(output, "session_summary", 32_000),
            // Candidates wait here until the next consolidation merges them.
            raw_memory:
              waiting && found ? `${waiting}\n\n${found}` : waiting || found,
            updated_revision: document.revision + 1,
          };
          // A session whose candidates still wait is never evicted.
          const oldest = Object.keys(sessions)
            .filter((other) => other === key || !sessions[other]!.raw_memory)
            .sort(
              (a, b) =>
                sessions[a]!.updated_revision - sessions[b]!.updated_revision,
            );
          for (const evicted of oldest.slice(
            0,
            Math.max(0, Object.keys(sessions).length - MAX_SESSIONS),
          ))
            delete sessions[evicted];
          document = await memory.commit(
            agentId,
            {
              ...published,
              sessions,
              cursors: { ...document.cursors, [key]: { thread_id, through } },
            },
            signal,
          );
          continue;
        }
        const { extractions } = JSON.parse(pending.prompt) as {
          extractions: readonly { key: string; raw_memory?: string }[];
        };
        const sessions = { ...document.sessions };
        for (const { key, raw_memory: sent } of extractions) {
          const session = sessions[key];
          if (!session) continue;
          const waiting = session.raw_memory;
          const remaining =
            typeof sent === "string" &&
            sent.length > 0 &&
            sent.length < waiting.length &&
            waiting.startsWith(sent)
              ? waiting.slice(sent.length).trimStart()
              : "";
          sessions[key] = { ...session, raw_memory: remaining };
        }
        document = await memory.commit(
          agentId,
          {
            ...published,
            sessions,
            summary: outputText(output, "summary", 8_000),
            memory: consolidated,
          },
          signal,
        );
      }
    }
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #log(error: unknown, agentId?: string): void {
    if (!this.#stop.signal.aborted)
      this.options.logger.log("warn", "agent_memory.reconcile_failed", {
        agentId,
        error: String(error),
      });
  }
}

function outputText(
  value: Record<string, unknown>,
  field: string,
  limit: number,
): string {
  const text = value[field];
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > limit)
    throw new InvalidMemoryOutputError(`Invalid memory output: ${field}`);
  return text;
}
