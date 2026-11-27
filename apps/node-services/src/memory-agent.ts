import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { isRecord } from "@linger/service-kit";

import { packageRoot } from "./paths.js";
import {
  ModelBudgetSpentError,
  schemaProblem,
  type ModelCallEffort,
  type ModelCallResult,
  type ModelChain,
  type ModelRunBudget,
} from "./runtime-model-call.js";

/**
 * The memory Agent: one controlled loop for every kind of memory upkeep
 * (Wiki pages, memory.md, Tracking Items, ...). A task runs a bounded number
 * of steps. Each step is one structured model call that returns a group of
 * actions, like one turn of a deep agent that calls several tools. The
 * application runs the actions, checks every write as a proposal of a
 * registered object type, and feeds the results to the next step. Nothing
 * here stores anything: the caller's environment stages accepted proposals.
 */

/** A kind of memory a task may write. */
export interface AgentObjectType {
  /** Registry name, for example `wiki.client`. */
  readonly type: string;
  /** Rules for this type only; the shared principles come with the task. */
  readonly instructions: string;
  /** Strict JSON schema of one proposal's payload. */
  readonly payloadSchema: Readonly<Record<string, unknown>>;
}

/** A read or flow tool the environment runs for the model. */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  /** Strict JSON schema of the arguments object. */
  readonly argumentsSchema: Readonly<Record<string, unknown>>;
}

/** One task's configuration. Its limits keep every step within the budget. */
export interface AgentTask {
  /** Names the task in logs, for example `wiki.entity`. */
  readonly name: string;
  readonly instructions: string;
  readonly objects: readonly AgentObjectType[];
  readonly tools: readonly AgentTool[];
  readonly maxSteps: number;
  /** Actions one step may return. */
  readonly maxActions: number;
  /** Characters of one step's results that the next step reads. */
  readonly maxResultChars: number;
  readonly effort: ModelCallEffort;
  /** One step's model call. */
  readonly timeoutMs: number;
  /** Stops one step's reply past this many characters; omitted, no cap. */
  readonly maxOutputChars?: number;
}

/** What one action did, as the next step reads it. */
export interface AgentObservation {
  readonly ok: boolean;
  readonly content: string;
}

/** Runs the task's tools and checks its proposals. */
export interface AgentEnvironment {
  runTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    signal: AbortSignal,
  ): Promise<AgentObservation>;
  /** Validates one write and stages it when it passes. */
  propose(
    object: string,
    target: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<AgentObservation>;
  /** What the task still owes; a finish waits while it says anything. */
  unfinished?(): string | undefined;
}

export interface AgentStepRecord {
  /** Each action as the model wrote it, a proposal without its payload. */
  readonly calls: readonly string[];
  readonly observations: readonly AgentObservation[];
  /** By position, the payload of each rejected proposal, so the next step
   * can fix its draft instead of writing it again from nothing. */
  readonly drafts?: readonly (string | undefined)[];
}

export interface AgentRunResult {
  readonly steps: readonly AgentStepRecord[];
  /** The model finished the task within its step limit. */
  readonly finished: boolean;
  readonly summary?: string;
  /** Proposals the environment accepted. */
  readonly accepted: number;
  /** Proposals the environment rejected; later steps may have fixed them. */
  readonly rejected: number;
}

type ParsedAction =
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly args: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "propose";
      readonly object: string;
      readonly target: string;
      readonly payload: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "finish"; readonly summary: string };

const STEP_SCHEMA_NAME = "memory_agent_step";

/** A strict object schema: every property required, nothing else allowed. */
export function strictObject(
  properties: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

/** Up to `maxActions` actions of this task, as an array. */
function agentActionsSchema(task: AgentTask): Record<string, unknown> {
  const branches = [
    ...task.tools.map((tool) =>
      strictObject({
        tool: { type: "string", enum: [tool.name] },
        arguments: tool.argumentsSchema,
      }),
    ),
    ...task.objects.map((object) =>
      strictObject({
        tool: { type: "string", enum: ["propose"] },
        object: { type: "string", enum: [object.type] },
        target: { type: "string", minLength: 1, maxLength: 300 },
        payload: object.payloadSchema,
      }),
    ),
    strictObject({
      tool: { type: "string", enum: ["finish"] },
      summary: { type: "string", maxLength: 1_000 },
    }),
  ];
  return {
    type: "array",
    maxItems: task.maxActions,
    items: { anyOf: branches },
  };
}

/** The schema of one step: up to `maxActions` actions of this task. */
export function agentStepSchema(
  task: AgentTask,
  actions: Record<string, unknown> = agentActionsSchema(task),
): Record<string, unknown> {
  return strictObject({
    // Claude's structured output can send a long array as its JSON text and
    // then fail validation on every retry; parseActions reads either form,
    // and the step checks the text against the array schema.
    actions: { anyOf: [actions, { type: "string" }] },
  });
}

/** The fixed part of every step; the task input and history follow it. */
export function agentInstructions(task: AgentTask): string {
  const objects = task.objects
    .map((object) => `### ${object.type}\n\n${object.instructions.trim()}`)
    .join("\n\n");
  const tools = task.tools
    .map((tool) => `- \`${tool.name}\`: ${tool.description}`)
    .join("\n");
  return `${sharedPrinciples()}

${task.instructions.trim()}

## Objects you may write

${objects || "This task writes no objects."}

## Tools

${tools}
${task.objects.length ? "- `propose`: submit one write of an object above. `target` names the object (for a page, its path). The application checks it at once; an accepted proposal is kept, a rejected one comes back with its issues and must be resent in full.\n" : ""}- \`finish\`: end the task with a one-line summary. It may share a step with other actions.

## Step protocol

- Each reply is one JSON object \`{"actions": [...]}\` with at most ${task.maxActions} actions. Reads run first and together, then proposals in order, then finish.
- The results of a step come back with the next step. You have at most ${task.maxSteps} steps; when they run out the task ends, keeping only accepted proposals. A finish waits while a proposal of its step was rejected or the task still owes work; the next step says what is left.
- Do everything a step allows: read several things at once, submit several proposals at once, and finish in the same step as your last proposals.
- Never repeat a read that an earlier step already returned.`;
}

/** Runs one task to its end: finish, its step limit, or a model failure. */
export async function runAgentTask(request: {
  /** The queued model task every step runs in. */
  readonly model: ModelChain;
  /** Names this agent task's steps within the model task; unique per run. */
  readonly step: string;
  readonly task: AgentTask;
  /** The task's own evidence and context. A Codex run keeps its steps in one
   * Runtime thread and sends only the previous step's results after the
   * first; every other Runtime, and every retry, gets the whole prompt with
   * the compacted history. */
  readonly input: string;
  /** Tokens one step's call may hold; past 85% of it, older steps are
   * shortened. Omitted, half the default context window. */
  readonly maxInputTokens?: number;
  /** Once spent, no further step starts; the task then ends unfinished,
   * keeping its accepted proposals. */
  readonly budget?: ModelRunBudget;
  readonly environment: AgentEnvironment;
  readonly signal?: AbortSignal;
}): Promise<AgentRunResult> {
  const { task, environment } = request;
  const instructions = agentInstructions(task);
  const actionsSchema = agentActionsSchema(task);
  const schema = agentStepSchema(task, actionsSchema);
  const signal = request.signal ?? new AbortController().signal;
  // Session keys of this run never meet a thread an earlier run left open.
  const session = randomUUID();
  const steps: AgentStepRecord[] = [];
  /** Tool calls already run, by their text, with the step that ran them. */
  const ran = new Map<string, number>();
  let accepted = 0;
  let rejected = 0;
  // Codex keeps one session's turns in a thread; other Runtimes start empty,
  // so the call layer sends the full prompt to them and on every retry.
  let sessionKey = session;
  let threadTokens = estimateTokens(instructions);
  // A retried or corrected step leaves its failed answer in the Daemon's
  // thread, so the next step starts a fresh one with the full prompt.
  let rotateNext = false;
  const threadBudget = Math.min(
    Math.floor(
      (request.maxInputTokens ?? taskTokens(undefined)) * HISTORY_COMPACT_SHARE,
    ),
    CODEX_SESSION_INPUT_LIMIT,
  );
  for (let index = 0; index < task.maxSteps; index += 1) {
    signal.throwIfAborted();
    if (request.budget?.spent) break;
    const fullInput = stepInput(request, instructions, steps, index);
    const delta = index === 0 ? fullInput : stepDelta(request, steps, index);
    let input = delta;
    if (
      index > 0 &&
      (rotateNext || threadTokens + estimateTokens(delta) > threadBudget)
    ) {
      // The thread is as long as this run allows, or the last step failed an
      // attempt: start a new one with the compacted history.
      sessionKey = `${session}/${index + 1}`;
      input = fullInput;
      rotateNext = false;
      threadTokens = estimateTokens(instructions) + estimateTokens(fullInput);
    } else {
      threadTokens += estimateTokens(input);
    }
    const step = await callStep(
      request,
      index,
      sessionKey,
      input,
      fullInput,
      instructions,
      schema,
      actionsSchema,
    ).catch((error: unknown) => {
      if (error instanceof ModelBudgetSpentError) return undefined;
      throw error;
    });
    if (step === undefined) break;
    // A retry or correction leaves the failed answer in the thread; the next
    // step must not continue it.
    if ((step.attempts ?? 1) > 1) rotateNext = true;
    // The thread also carries the model's own turns, not only our inputs.
    threadTokens += estimateTokens(JSON.stringify(step.output));
    const actions = parseActions(step.output, task);
    const calls: string[] = [];
    const results: AgentObservation[] = [];
    const drafts: (string | undefined)[] = [];
    const tools = actions.filter((action) => action.kind === "tool");
    const toolResults = await Promise.all(
      tools.map(async (action): Promise<AgentObservation> => {
        const call = `${action.name} ${JSON.stringify(action.args)}`;
        const earlier = ran.get(call);
        if (earlier !== undefined)
          return {
            ok: true,
            content: `Same as in step ${earlier + 1}; its result is above.`,
          };
        ran.set(call, index);
        return environment.runTool(action.name, action.args, signal).catch(
          (error: unknown): AgentObservation => ({
            ok: false,
            content: errorText(error),
          }),
        );
      }),
    );
    tools.forEach((action, position) => {
      calls.push(`${action.name} ${JSON.stringify(action.args)}`);
      results.push(toolResults[position]!);
      drafts.push(undefined);
    });
    for (const action of actions) {
      if (action.kind !== "propose") continue;
      const result = await environment
        .propose(action.object, action.target, action.payload)
        .catch(
          (error: unknown): AgentObservation => ({
            ok: false,
            content: errorText(error),
          }),
        );
      if (result.ok) accepted += 1;
      else rejected += 1;
      calls.push(`propose ${action.object} ${action.target}`);
      results.push(result);
      drafts.push(result.ok ? undefined : JSON.stringify(action.payload));
    }
    // A rejected proposal or owed work gets the next step, even after finish.
    const more = index + 1 < task.maxSteps;
    const fixable =
      more &&
      results.some(
        (result, position) =>
          !result.ok && calls[position]!.startsWith("propose "),
      );
    const finish = actions.find((action) => action.kind === "finish");
    const owed =
      more && !fixable && (finish || actions.length === 0)
        ? environment.unfinished?.()
        : undefined;
    if (owed) {
      calls.push("finish");
      results.push({ ok: false, content: `Not done yet: ${owed}` });
    } else if (fixable && finish) {
      calls.push("finish");
      results.push({
        ok: false,
        content: "Not done yet: resend the rejected proposals above, fixed",
      });
    }
    steps.push({
      calls,
      observations: fitResults(results, task.maxResultChars),
      drafts,
    });
    if (fixable || owed) continue;
    // A task that reports what it owes ends once nothing is owed; waiting for
    // the model to say finish would cost another call.
    if (environment.unfinished && !environment.unfinished())
      return {
        steps,
        finished: true,
        ...(finish ? { summary: finish.summary } : {}),
        accepted,
        rejected,
      };
    if (finish)
      return {
        steps,
        finished: true,
        summary: finish.summary,
        accepted,
        rejected,
      };
    if (actions.length === 0)
      return { steps, finished: true, accepted, rejected };
  }
  return { steps, finished: false, accepted, rejected };
}

/** One step's call; the chain's kind retries and corrects it. */
async function callStep(
  request: Parameters<typeof runAgentTask>[0],
  index: number,
  sessionKey: string,
  input: string,
  retryInput: string,
  instructions: string,
  schema: Record<string, unknown>,
  actionsSchema: Record<string, unknown>,
): Promise<ModelCallResult<Record<string, unknown>>> {
  return await request.model.call({
    step: `${request.step}/${index + 1}`,
    effort: request.task.effort,
    instructions,
    input,
    retryInput,
    schemaName: STEP_SCHEMA_NAME,
    outputSchema: schema,
    validate: (output) => {
      if (typeof output.actions !== "string") return undefined;
      const actions = actionList(output.actions);
      if (actions === undefined)
        return "`actions` is text that is not a JSON array; send `actions` as an array of action objects";
      const problem = schemaProblem(actionsSchema, actions);
      return problem
        ? `\`actions\` text does not match the action schema: ${problem}; send \`actions\` as an array of action objects`
        : undefined;
    },
    timeoutMs: request.task.timeoutMs,
    ...(request.budget ? { budget: request.budget } : {}),
    ...(request.task.maxOutputChars === undefined
      ? {}
      : { maxOutputChars: request.task.maxOutputChars }),
    sessionKey,
  });
}

/** Share of a step's token budget past which older steps are shortened. */
const HISTORY_COMPACT_SHARE = 0.85;

/** The Daemon retires a Codex thread at 150k input tokens, so the run rotates
 * below it with room for Codex's own preamble and the final turn. */
const CODEX_SESSION_INPUT_LIMIT = 120_000;

/**
 * One step's input: the task input, the steps so far, and where it stands.
 * Older steps lose their results, then their actions, while the call would
 * pass 85% of its budget; the latest step stays whole, and a rejected draft
 * stays until its object is proposed again.
 */
function stepInput(
  request: Parameters<typeof runAgentTask>[0],
  instructions: string,
  steps: readonly AgentStepRecord[],
  index: number,
): string {
  const budget = Math.floor(
    (request.maxInputTokens ?? taskTokens(undefined)) * HISTORY_COMPACT_SHARE,
  );
  const compose = (detail: HistoryDetail) =>
    `${request.input.trim()}

${renderHistory(steps, detail)}

${stepTail(request, steps, index)}`;
  let input = compose("full");
  for (const detail of ["calls", "latest"] as const) {
    if (estimateTokens(instructions) + estimateTokens(input) <= budget) break;
    input = compose(detail);
  }
  return input;
}

/**
 * What a Codex session needs after its first turn: the previous step's
 * actions and results. The thread already holds the task input, the
 * instructions and the earlier steps.
 *
 * Node cannot see the Daemon's thread lifecycle: an idle restart, a busy
 * thread or a turn the Daemon retired starts a new one, and this delta would
 * arrive without the task. The run rotates after any retried step and below
 * the Daemon's 150k retirement, but that window stays open.
 */
function stepDelta(
  request: Parameters<typeof runAgentTask>[0],
  steps: readonly AgentStepRecord[],
  index: number,
): string {
  const previous = renderStep(steps, index - 1, "full") ?? "";
  // A rejected draft older than the latest step stays visible: the session may
  // have rotated, and the model must still fix it in full.
  const older = pendingDrafts(steps.slice(0, -1));
  const pending = older.length
    ? `## Drafts still to fix\n\n${older.join("\n\n")}\n\n`
    : "";
  return `## Results of step ${index}

${previous}

${pending}The task input and earlier steps are in this session's thread; this message adds the latest results.

${stepTail(request, steps, index)}`;
}

/** Rejected drafts no later step has proposed again, oldest first. */
function pendingDrafts(steps: readonly AgentStepRecord[]): string[] {
  const drafts: string[] = [];
  steps.forEach((step, index) => {
    step.calls.forEach((call, position) => {
      if (!call.startsWith("propose ")) return;
      if (step.observations[position]?.ok) return;
      const resent = steps.findIndex(
        (later, laterIndex) => laterIndex > index && later.calls.includes(call),
      );
      if (resent >= 0) return;
      const draft = step.drafts?.[position];
      if (draft)
        drafts.push(
          `- ${call}\n  Your rejected draft, to fix and resend in full: ${draft}`,
        );
    });
  });
  return drafts;
}

/** Where the task stands after the steps so far. */
function stepTail(
  request: Parameters<typeof runAgentTask>[0],
  steps: readonly AgentStepRecord[],
  index: number,
): string {
  const step =
    index + 1 < request.task.maxSteps
      ? `This is step ${index + 1} of at most ${request.task.maxSteps}.`
      : `This is the last step (${index + 1} of ${request.task.maxSteps}). Results of reads would come too late, so act now on what you already have.`;
  // What the task still owes after the steps so far, so the model need not
  // infer it from the history. A task owing nothing has already ended.
  const owed = steps.length ? request.environment.unfinished?.() : undefined;
  const status = owed ? `Still to do: ${owed}.\n\n` : "";
  return `${status}${step}`;
}

/** How much of the steps before the latest one the history keeps. */
type HistoryDetail = "full" | "calls" | "latest";

function renderStep(
  steps: readonly AgentStepRecord[],
  index: number,
  detail: HistoryDetail,
): string | undefined {
  const last = steps.length - 1;
  if (index < last && detail === "latest") return undefined;
  const step = steps[index]!;
  /** The later step that proposed the same object again, if any. */
  const resentIn = (call: string) => {
    if (!call.startsWith("propose ")) return -1;
    return steps.findIndex(
      (later, position) => position > index && later.calls.includes(call),
    );
  };
  const results = index === last || detail === "full";
  const actions = step.calls.length
    ? step.calls
        .map((call, position) => {
          const observation = step.observations[position];
          const status = observation?.ok ? "ok" : "rejected";
          // A rejected draft stays until its object is proposed again; the
          // later proposal's result supersedes the older issues.
          const resent = resentIn(call);
          if (!observation?.ok && resent >= 0)
            return `- ${call}\n  rejected; resent in step ${resent + 1}`;
          const draft = step.drafts?.[position];
          return `- ${call}\n  ${results ? `${status}: ${indent(observation?.content ?? "")}` : `${status} (result shortened to fit the context)`}${draft ? `\n  Your rejected draft, to fix and resend in full: ${draft}` : ""}`;
        })
        .join("\n")
    : "- (no actions)";
  return `### Step ${index + 1}\n\n${actions}`;
}

function renderHistory(
  steps: readonly AgentStepRecord[],
  detail: HistoryDetail,
): string {
  if (steps.length === 0) return "## Previous steps\n\nNone yet.";
  const rendered = steps.map((_, index) => renderStep(steps, index, detail));
  const omitted = rendered.filter((step) => step === undefined).length;
  return `## Previous steps\n\n${[
    ...(omitted
      ? [
          `Steps 1 to ${omitted} are omitted to fit the context; their accepted proposals are kept.`,
        ]
      : []),
    ...rendered.filter((step): step is string => step !== undefined),
  ].join("\n\n")}`;
}

function parseActions(
  output: Readonly<Record<string, unknown>>,
  task: AgentTask,
): ParsedAction[] {
  const actions = actionList(output.actions) ?? [];
  const tools = new Set(task.tools.map((tool) => tool.name));
  const objects = new Set(task.objects.map((object) => object.type));
  const parsed: ParsedAction[] = [];
  for (const value of actions.slice(0, task.maxActions)) {
    if (!isRecord(value) || typeof value.tool !== "string") continue;
    if (value.tool === "finish") {
      parsed.push({
        kind: "finish",
        summary: typeof value.summary === "string" ? value.summary : "",
      });
    } else if (value.tool === "propose") {
      if (
        typeof value.object === "string" &&
        objects.has(value.object) &&
        typeof value.target === "string" &&
        isRecord(value.payload)
      )
        parsed.push({
          kind: "propose",
          object: value.object,
          target: value.target,
          payload: value.payload,
        });
    } else if (tools.has(value.tool) && isRecord(value.arguments)) {
      parsed.push({ kind: "tool", name: value.tool, args: value.arguments });
    }
  }
  return parsed;
}

/** A step's actions, given as an array or as the JSON text of one;
 * undefined when the text is not a JSON array. */
function actionList(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Cuts a step's results to one shared character budget. */
function fitResults(
  results: readonly AgentObservation[],
  maxChars: number,
): AgentObservation[] {
  if (results.length === 0) return [];
  const each = Math.max(400, Math.floor(maxChars / results.length));
  return results.map((result) =>
    result.content.length <= each
      ? result
      : {
          ...result,
          content: `${result.content.slice(0, each)}\n…[${result.content.length - each} more characters cut; read a narrower range]`,
        },
  );
}

function indent(text: string): string {
  return text.trim().replaceAll("\n", "\n  ");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let principles: string | undefined;

/** The rules every memory task shares (evidence, what not to keep, conflicts). */
export function sharedPrinciples(): string {
  principles ??= readFileSync(
    path.join(packageRoot, "prompts", "memory-agent", "principles.md"),
    "utf8",
  ).trim();
  return principles;
}

/** The context window assumed when the Agent model's is unknown. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** What one model task may hold: half the model's context window. The other
 * half stays free for the Runtime's own prompt, the reply and estimation
 * error. */
export function taskTokens(contextWindow: number | undefined): number {
  return Math.floor((contextWindow ?? DEFAULT_CONTEXT_WINDOW) / 2);
}

/** UTF-8 bytes / 3: conservative for mixed Chinese and English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 3);
}
