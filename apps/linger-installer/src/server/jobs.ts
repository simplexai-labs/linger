import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { components } from "@linger/wire-contracts/linger-installer/types";
import { reasonCodeList } from "@linger/local-installation/local-models";
import { publicComputer } from "./public.js";
import { privateDirectory, privateRead, privateWrite } from "./storage.js";
type Input = components["schemas"]["InstallationInput"];
type Job = components["schemas"]["InstallationJob"];
type Event = components["schemas"]["InstallationEvent"];
type CoreEvent = Pick<Event, "kind" | "message"> &
  Partial<Pick<Event, "stage" | "state" | "progress">>;
export type RunInstallation = (
  input: Input,
  signal: AbortSignal,
  emit: (event: CoreEvent) => void,
  publishRuntime?: (runtime: NonNullable<Job["runtime"]>) => void,
) => Promise<unknown>;
const PROGRESS_PERSIST_MS = 1_000;
// Two events of the same step and message, differing only in progress.
const sameStep = (a: Event, b: Event) =>
  a.kind === b.kind &&
  a.stage === b.stage &&
  a.state === b.state &&
  a.message === b.message &&
  a.progress?.unit === b.progress?.unit;
const active = (job: Job) =>
  ["queued", "running", "waiting_user"].includes(job.state);
// What the person chose to install: a runtime, the local model
// ("local-models"), or a runtime behind their own key.
const choiceOf = (input: Input) =>
  input.byok
    ? `byok:${input.byok.runtime ?? input.setupChoice ?? ""}`
    : input.setupChoice;
function validOutcome(value: unknown): value is {
  state: string;
  code: number;
  message: string;
  details?: unknown;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.state === "string" &&
    [
      "ready",
      "action_required",
      "prerequisite_unavailable",
      "failed",
      "busy",
      "cancelled",
    ].includes(result.state) &&
    Number.isSafeInteger(result.code) &&
    typeof result.message === "string" &&
    (result.state === "ready" ? result.code === 0 : result.code !== 0)
  );
}
function publicLocalModelsPlan(
  value: unknown,
  clean: (text: string) => string,
): Job["localModelsPlan"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const plan = value as Record<string, unknown>;
  if (typeof plan.planId !== "string" || !/^[a-f0-9]{64}$/.test(plan.planId))
    return;
  for (const key of [
    "gpuIndex",
    "contextWindow",
    "downloadBytes",
    "diskBytes",
    "memoryBytes",
  ])
    if (!Number.isSafeInteger(plan[key]) || Number(plan[key]) < 0) return;
  const safe = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 2000 &&
    clean(value) === value &&
    // eslint-disable-next-line no-control-regex -- Public plan text must exclude terminal control bytes.
    !/[\r\n\x00-\x1f]|(?:^|\s)(?:\/|[A-Z]:\\)|https?:\/\//i.test(value);
  if (
    !safe(plan.gpuName) ||
    !safe(plan.llm) ||
    !Array.isArray(plan.components) ||
    !Array.isArray(plan.warnings) ||
    plan.components.length > 50 ||
    plan.warnings.length > 50
  )
    return;
  // Tool review text can carry license URLs or paths; omit just those lines so the plan stays approvable.
  return {
    planId: plan.planId,
    gpuIndex: Number(plan.gpuIndex),
    gpuName: plan.gpuName,
    llm: plan.llm,
    contextWindow: Number(plan.contextWindow),
    downloadBytes: Number(plan.downloadBytes),
    diskBytes: Number(plan.diskBytes),
    memoryBytes: Number(plan.memoryBytes),
    components: plan.components.filter(safe),
    warnings: plan.warnings.filter(safe),
  };
}
export class JobManager {
  private records = new Map<
    string,
    {
      job: Job;
      runtime?: Job["runtime"];
      events: Event[];
      input: Input;
      controller: AbortController;
      starting?: Promise<void>;
      task?: Promise<void>;
      cancelRequested?: boolean;
      executing?: boolean;
      // Queued behind the job it replaced, until that one has ended.
      waiting?: boolean;
    }
  >();
  private listeners = new Map<string, Set<(event: Event) => void>>();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(
    private directory: string,
    private run: RunInstallation,
  ) {}
  async load() {
    await privateDirectory(this.directory);
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const saved = (await privateRead(path.join(this.directory, file))) as {
        job: Job;
        events: Event[];
      };
      const input = (await privateRead(
        path.join(this.directory, `${saved.job.id}.input.json`),
      )) as Input;
      if (
        active(saved.job) &&
        !(
          saved.job.state === "waiting_user" &&
          (saved.job.errorCode?.startsWith("LOCAL_MODELS_") ||
            saved.job.errorCode === "RUNTIME_AUTH_REQUIRED" ||
            saved.job.errorCode === "SETUP_SELECTION_REQUIRED")
        )
      ) {
        saved.job.state = "interrupted";
        saved.job.message =
          "The installer restarted. Retry to check the actual installation state.";
        saved.job.updatedAt = new Date().toISOString();
      }
      this.records.set(saved.job.id, {
        ...saved,
        input,
        controller: new AbortController(),
      });
      await this.persist(saved.job.id);
    }
  }
  list() {
    return [...this.records.values()]
      .map((record) => structuredClone(record.job))
      .sort(
        (a, b) =>
          Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          b.id.localeCompare(a.id),
      );
  }

  get(id: string) {
    const record = this.records.get(id);
    if (!record) return undefined;
    const job = structuredClone(record.job);
    // Only a client following this live job gets its runtime. History and disk omit the handoff.
    if (job.state === "succeeded" && record.runtime)
      job.runtime = structuredClone(record.runtime);
    return job;
  }
  get busy() {
    return [...this.records.values()].some(
      (record) =>
        record.starting ||
        record.waiting ||
        (active(record.job) && record.executing),
    );
  }
  private timers = new Map<string, NodeJS.Timeout>();
  private persistSoon(id: string, failed: () => void) {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      void this.persist(id).catch(failed);
    }, PROGRESS_PERSIST_MS);
    timer.unref();
    this.timers.set(id, timer);
  }
  private pending = new Set<string>();
  private writing = false;
  private persist(id: string) {
    this.pending.add(id);
    if (!this.writing) {
      this.writing = true;
      this.writes = (async () => {
        while (this.pending.size) {
          const next = this.pending.values().next().value!;
          this.pending.delete(next);
          const record = this.records.get(next)!;
          await privateWrite(path.join(this.directory, `${next}.json`), {
            job: structuredClone(record.job),
            events: structuredClone(record.events),
          });
        }
      })().finally(() => {
        this.writing = false;
      });
    }
    return this.writes;
  }
  private redact(input: Input, message: string) {
    let clean = message;
    for (const secret of [
      input.password,
      input.model?.apiKey,
      input.runtimeModel?.apiKey,
      input.byok?.apiKey,
    ])
      if (secret) clean = clean.split(secret).join("[hidden]");
    clean = clean
      .replace(/(?:Bearer\s+)[^\s]+/gi, "Bearer [hidden]")
      .replace(
        /((?:password|api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi,
        "$1[hidden]",
      )
      // eslint-disable-next-line no-control-regex -- Strip terminal control bytes from public installation logs.
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
    // A long failure names its step first and its cause last; keep both.
    return clean.length <= 2000
      ? clean
      : `${clean.slice(0, 400)}\n…\n${clean.slice(-1595)}`;
  }
  private emit(id: string, value: CoreEvent) {
    const record = this.records.get(id)!;
    const event: Event = {
      jobId: id,
      sequence: ++record.job.lastSequence,
      at: new Date().toISOString(),
      kind: value.kind,
      message: this.redact(record.input, value.message),
      ...(value.stage ? { stage: value.stage } : {}),
      ...(value.state ? { state: value.state } : {}),
      ...(value.progress ? { progress: value.progress } : {}),
    };
    if (value.stage) {
      record.job.stage = value.stage;
      const stage = record.job.stages.find((item) => item.id === value.stage);
      if (stage && value.progress)
        stage.progress = structuredClone(value.progress);
      // A step update without a counter ends the counted part, so a finished
      // download's bytes do not stay on the step.
      else if (stage && value.kind === "stage") delete stage.progress;
      if (stage && value.kind === "stage") {
        stage.state = (value.state ?? "running") as typeof stage.state;
        stage.message = event.message;
        stage.at = event.at;
      }
    }
    record.job.updatedAt = event.at;
    record.job.message = event.message;
    // A copy or download reports progress per chunk. Each update replaces the
    // previous one of the same step, so progress cannot push the log lines
    // out of the 500 retained events. Replay is by sequence, so a client that
    // saw the replaced update still gets this one.
    const last = record.events.at(-1);
    if (event.progress && last?.progress && sameStep(last, event))
      record.events[record.events.length - 1] = event;
    else record.events.push(event);
    if (record.events.length > 500)
      record.events.splice(0, record.events.length - 500);
    const failed = () => {
      record.controller.abort();
    };
    // Windows protects every job file with a PowerShell call, so progress
    // is saved at most once a second; any other event is saved at once.
    // start() saves these events once the private input is durable. Publishing
    // a job first would leave an unreadable record if that initial save fails.
    if (!record.starting) {
      if (event.progress) this.persistSoon(id, failed);
      else {
        clearTimeout(this.timers.get(id));
        this.timers.delete(id);
        void this.persist(id).catch(failed);
      }
    }
    for (const listener of this.listeners.get(id) ?? [])
      listener(structuredClone(event));
  }
  async start(input: Input): Promise<Job> {
    const current = [...this.records.values()].filter(
      (record) =>
        record.job.instance === input.instance &&
        record.job.preparation === input.preparation &&
        active(record.job),
    );
    // One still stopping for a replacement is not the current job.
    const existing =
      current.find((record) => !record.cancelRequested) ?? current[0];
    // A job that ran to the end and now waits for the person mutates
    // nothing; a new start is their answer, so it replaces that job and
    // checks the computer again instead of returning the stale outcome.
    // A start that chooses another runtime (or the local model) is the
    // person's latest choice too: it stops the running job, which keeps the
    // download of a local model chosen before, and runs once that has ended
    // and left the instance. A start without a choice follows the running job.
    // cancel() marks it canceled before its first await and the new record
    // is set in the same step, so a concurrent start gets the new job back.
    const stopping =
      existing &&
      ((existing.job.state === "waiting_user" && !existing.executing) ||
        (choiceOf(input) !== undefined &&
          choiceOf(input) !== choiceOf(existing.input)))
        ? this.cancel(existing.job.id)
        : undefined;
    if (existing && !stopping) return structuredClone(existing.job);
    const id = randomUUID(),
      // Preserve successor order even when jobs are created within one clock tick.
      at = new Date(
        Math.max(
          Date.now(),
          ...[...this.records.values()].map(
            ({ job }) => Date.parse(job.createdAt) + 1,
          ),
        ),
      ).toISOString();
    const job: Job = {
      id,
      instance: input.instance,
      ...(input.setupChoice ? { setupChoice: input.setupChoice } : {}),
      ...(input.shareGpu !== undefined ? { shareGpu: input.shareGpu } : {}),
      ...(input.preparation ? { preparation: input.preparation } : {}),
      state: "queued",
      createdAt: at,
      updatedAt: at,
      lastSequence: 0,
      stages: (input.preparation
        ? (["runtime"] as const)
        : ([
            "preflight",
            "release",
            "runtime",
            "images",
            "services",
            "account",
            "computer",
          ] as const)
      ).map((id) => ({
        id,
        state: "pending",
        message: "Waiting to start",
        at,
      })),
      message: "Waiting to start installation.",
    };
    const record = {
      job,
      input: structuredClone(input),
      events: [] as Event[],
      controller: new AbortController(),
      starting: undefined as Promise<void> | undefined,
      task: undefined as Promise<void> | undefined,
      cancelRequested: false,
      executing: false,
      waiting: false,
    };
    this.records.set(id, record);
    record.starting = (async () => {
      await stopping;
      await privateWrite(path.join(this.directory, `${id}.input.json`), input);
      await this.persist(id);
    })();
    try {
      await record.starting;
    } catch (error) {
      this.records.delete(id);
      throw error;
    } finally {
      record.starting = undefined;
    }
    // The replaced job may be in a step that only stops at its end (services,
    // account or computer), which can take minutes, so the caller gets the
    // queued job now and it runs once that job has ended and left the
    // instance. The task covers the wait, so a start that replaces this job
    // in turn also waits for the earlier one.
    record.task = (async () => {
      if (existing) {
        record.waiting = true;
        await existing.task;
        record.waiting = false;
      }
      if (record.cancelRequested) return;
      record.executing = true;
      await this.execute(id);
    })().catch(() => {
      record.executing = false;
      record.job.state = "failed";
      record.job.errorCode = "STORAGE_UNAVAILABLE";
      record.job.message =
        "Could not save the installation state. Check the data directory and free space.";
    });
    return structuredClone(job);
  }
  private async execute(id: string) {
    const record = this.records.get(id)!;
    record.job.state = "running";
    this.emit(id, {
      kind: "state",
      state: "running",
      message: "Checking the installation state.",
    });
    try {
      const result = await this.run(
        record.input,
        record.controller.signal,
        (event) => {
          if (
            record.cancelRequested &&
            !["services", "account", "computer"].includes(
              event.stage ?? record.job.stage ?? "",
            )
          )
            record.controller.abort();
          this.emit(id, event);
        },
        (runtime) => {
          record.runtime = runtime;
        },
      );
      const outcome = validOutcome(result) ? result : undefined;
      const state = outcome?.state;
      record.job.state =
        record.cancelRequested || state === "cancelled"
          ? "canceled"
          : state === "action_required"
            ? "waiting_user"
            : state === "prerequisite_unavailable" ||
                state === "failed" ||
                state === "busy"
              ? "failed"
              : state === "ready"
                ? "succeeded"
                : "failed";
      if (record.job.state === "failed")
        record.job.errorCode = !outcome
          ? "INSTALL_RESULT_INVALID"
          : state === "busy"
            ? "INSTANCE_BUSY"
            : "INSTALL_FAILED";
      if (outcome?.details && typeof outcome.details === "object") {
        const details = outcome.details as {
          origin?: string;
          services?: Job["services"];
          computer?: Job["computer"];
          knowledge?: string;
          code?: unknown;
          causeCode?: unknown;
          reasons?: unknown;
          stage?: unknown;
          localModelsPlan?: unknown;
          runtime?: unknown;
          loginCommand?: unknown;
          loginInstructions?: unknown;
        };
        if (record.job.state === "failed") {
          // The outcome names the cause when parallel work or cleanup
          // reported its own progress after the step that failed.
          const failedStage = record.job.stages.find(
            ({ id }) => id === details.stage,
          );
          if (failedStage) record.job.stage = failedStage.id;
        }
        if (
          [
            "RUNTIME_AUTH_REQUIRED",
            "SETUP_SELECTION_REQUIRED",
            "LOCAL_MODELS_UNAVAILABLE",
            "LOCAL_MODELS_APPROVAL_REQUIRED",
            "LOCAL_MODELS_RECOVERY_REQUIRED",
          ].includes(String(details.code)) ||
          // Why the runtime could not be installed, in place of INSTALL_FAILED.
          (record.job.state === "failed" &&
            [
              "RUNTIME_PLAN_REFUSED",
              "RUNTIME_ACTION_FAILED",
              "RUNTIME_EXTENSIONS_FAILED",
            ].includes(String(details.code)))
        ) {
          record.job.errorCode = String(details.code);
          if (
            typeof details.causeCode === "string" &&
            /^[A-Z][A-Z0-9_]{0,63}$/.test(details.causeCode)
          )
            record.job.errorCauseCode = details.causeCode;
          const reasons = reasonCodeList(details.reasons);
          if (reasons.length) record.job.errorReasons = reasons;
          if (details.code === "LOCAL_MODELS_APPROVAL_REQUIRED") {
            const plan = publicLocalModelsPlan(
              details.localModelsPlan,
              (text) => this.redact(record.input, text),
            );
            if (plan) record.job.localModelsPlan = plan;
          }
        }
        if (
          details.code === "RUNTIME_AUTH_REQUIRED" &&
          ["codex", "claude", "pi"].includes(String(details.runtime)) &&
          typeof details.loginCommand === "string"
        ) {
          record.job.runtimeAuth = {
            runtime: details.runtime as "codex" | "claude" | "pi",
            loginCommand: this.redact(record.input, details.loginCommand),
            ...(typeof details.loginInstructions === "string"
              ? {
                  loginInstructions: this.redact(
                    record.input,
                    details.loginInstructions,
                  ),
                }
              : {}),
          };
        }
        if (details.origin) record.job.origin = details.origin;
        if (details.services)
          record.job.services = details.services.map((item) => ({
            service: item.service,
            ready: item.ready,
          }));
        if (details.computer)
          record.job.computer = publicComputer({
            ...details.computer,
            detail: this.redact(record.input, details.computer.detail),
          });
        if (details.knowledge) record.job.knowledge = details.knowledge;
      }
      this.emit(id, {
        kind: "state",
        state: record.job.state,
        message: record.cancelRequested
          ? "Installation stopped. Existing data was kept."
          : (outcome?.message ??
            "The installation result could not be confirmed. Check again."),
      });
    } catch {
      record.job.state =
        record.controller.signal.aborted || record.cancelRequested
          ? "canceled"
          : "failed";
      this.emit(id, {
        kind: "state",
        state: record.job.state,
        message:
          record.job.state === "canceled"
            ? "Installation stopped. Existing data was kept."
            : "Installation did not finish. Check the environment and retry.",
      });
    }
    record.executing = false;
    await this.writes;
  }
  async cancel(id: string) {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (active(record.job)) {
      record.cancelRequested = true;
      record.job.cancelRequested = true;
      if (!record.executing) {
        record.job.state = "canceled";
        this.emit(id, {
          kind: "state",
          state: "canceled",
          message: "Installation stopped. Existing data was kept.",
        });
        await record.starting;
        // The first snapshot may have been captured before this cancellation.
        await this.persist(id);
        return this.get(id);
      }
      if (
        ["services", "account", "computer"].includes(record.job.stage ?? "")
      ) {
        record.job.state = "waiting_user";
        this.emit(id, {
          kind: "state",
          state: "waiting_user",
          message: "Stopping after the current step.",
        });
      } else record.controller.abort();
    }
    return this.get(id);
  }
  async retry(
    id: string,
    authority: components["schemas"]["LocalModelsAuthority"] = {},
  ) {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.executing) return this.get(id);
    if (active(record.job)) await this.cancel(id);
    const input = { ...record.input };
    delete input.localModelsApproval;
    delete input.localModelsReplan;
    return this.start({ ...input, ...authority });
  }
  async shutdown() {
    const running = [...this.records.values()].filter(
      (record) => record.starting || record.waiting || record.executing,
    );
    const cancellations = await Promise.allSettled(
      running.map((record) => this.cancel(record.job.id)),
    );
    await Promise.all(
      running.map(async (record) => {
        // start() reports a failed initial write to its caller.
        await record.starting?.catch(() => {});
        await record.task;
      }),
    );
    await this.writes;
    // A failed start removes its record and reports the error to its caller.
    for (const [index, result] of cancellations.entries())
      if (
        result.status === "rejected" &&
        this.records.has(running[index]!.job.id)
      )
        throw result.reason;
  }
  async wait(id: string) {
    const record = this.records.get(id);
    await record?.starting;
    await record?.task;
    await this.writes;
  }
  replay(id: string, after: number): Event[] {
    const record = this.records.get(id);
    if (!record) return [];
    const oldest = record.events[0]?.sequence ?? 0;
    if (after < oldest - 1 || after > record.job.lastSequence)
      return [
        {
          jobId: id,
          sequence: record.job.lastSequence,
          at: new Date().toISOString(),
          kind: "snapshot",
          message: "Restored the current installation state.",
          job: this.get(id)!,
        },
      ];
    return structuredClone(
      record.events.filter((event) => event.sequence > after),
    );
  }
  subscribe(id: string, listener: (event: Event) => void) {
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(id);
    };
  }
}
