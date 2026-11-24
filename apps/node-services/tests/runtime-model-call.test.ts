import type { ModelLease } from "../src/model-tasks.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_OFFLINE_MESSAGE,
  createRuntimeModelCall,
  createTeamHubBackgroundOutcomeReporter,
  isComputerOffline,
  ModelCallError,
  ModelBudgetSpentError,
  ModelRunBudget,
  type BackgroundCallOutcome,
  type ModelPlacement,
  type RuntimeModelGateway,
  type RuntimeModelInfo,
} from "../src/runtime-model-call.js";
import { runtimeModelGateway } from "../src/agent/runner-gateway/runtime-model-gateway.js";
import { LocalComputerOfflineError } from "../src/agent/runner-gateway/local-computer-management.js";
import { RunnerModelInvokeUnavailableError } from "../src/agent/runner-gateway/runner-model-invocation.js";
import type { ModelCallLog } from "../src/model-call-log.js";

type Invoke = RuntimeModelGateway["invokeModel"];
type Outcome = Awaited<ReturnType<Invoke>>;

const alice: ModelPlacement = {
  tenantId: "tenant_1",
  ownerActorId: "alice",
  agentId: "agent_alice",
  computerId: "computer_alice",
  runtimeType: "codex",
  agentActorId: "another_me_alice",
};
const bob: ModelPlacement = {
  ...alice,
  ownerActorId: "bob",
  agentId: "agent_bob",
  computerId: "computer_bob",
  runtimeType: "claude",
  agentActorId: "another_me_bob",
};

const completed = (text: string, model?: string): Outcome => ({
  outcome: "completed",
  text,
  ...(model ? { model } : {}),
  duration_ms: 10,
});

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } },
};

function setup(
  options: {
    placements?: readonly ModelPlacement[];
    ready?: (computerId: string, runtime: string) => boolean;
    outcomes?: (Outcome | Error)[];
    /** Answers every invocation instead of the outcome list. */
    invoke?: Invoke;
    lease?: ModelLease;
    callLog?: ModelCallLog;
    runtimeModels?: RuntimeModelGateway["runtimeModels"];
    onBackgroundOutcome?: (outcome: BackgroundCallOutcome) => void;
  } = {},
) {
  const outcomes = [...(options.outcomes ?? [completed('{"answer":"yes"}')])];
  const invokeModel = vi.fn<Invoke>(
    options.invoke ??
      (async () => {
        const next = outcomes.shift() ?? completed('{"answer":"yes"}');
        if (next instanceof Error) throw next;
        return next;
      }),
  );
  const supportsModelInvoke = vi.fn(options.ready ?? (() => true));
  const acquireModelCall = vi.fn<RuntimeModelGateway["acquireModelCall"]>(
    async () =>
      options.lease ?? {
        release: () => {},
        borrow: () => ({ release: () => {} }),
      },
  );
  const placements = vi.fn(async () => options.placements ?? [alice, bob]);
  let time = 0;
  const logger = { log: vi.fn() };
  const modelCall = createRuntimeModelCall({
    gateway: {
      invokeModel,
      supportsModelInvoke,
      runtimeModels: options.runtimeModels ?? (() => []),
      acquireModelCall,
    },
    placements,
    logger,
    ...(options.callLog ? { callLog: options.callLog } : {}),
    ...(options.onBackgroundOutcome
      ? { onBackgroundOutcome: options.onBackgroundOutcome }
      : {}),
    now: () => time,
  });
  return {
    modelCall,
    logger,
    invokeModel,
    acquireModelCall,
    supportsModelInvoke,
    placements,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

const work = { kind: "memory", key: "test" } as const;
const ask = {
  ...work,
  schemaName: "answer",
  outputSchema: schema,
  timeoutMs: 60_000,
};

describe("Runtime model call", () => {
  it("runs on the owner's Another Me Computer with its Runtime and low effort", async () => {
    const { modelCall, invokeModel } = setup();
    await expect(
      modelCall.call({
        ...ask,
        owner: { tenantId: "tenant_1", ownerActorId: "bob" },
        instructions: "Answer.",
        input: "Question?",
      }),
    ).resolves.toEqual({ output: { answer: "yes" }, model: "claude" });
    expect(invokeModel).toHaveBeenCalledWith(
      "computer_bob",
      expect.objectContaining({
        tenantId: "tenant_1",
        ownerActorId: "bob",
        agentId: "agent_bob",
        runtimeType: "claude",
        mode: "structured",
        reasoningEffort: "low",
        instructions: "Answer.",
        input: "Question?",
        outputSchema: schema,
        timeoutMs: 60_000,
        queue: { priority: 40, kind: "memory", key: "test" },
      }),
    );
    await modelCall.text({
      kind: "approval",
      key: "test",
      owner: { tenantId: "tenant_1", ownerActorId: "bob" },
      input: "Now?",
      timeoutMs: 1_000,
      runOperationId: "operation_1",
    });
    expect(invokeModel).toHaveBeenLastCalledWith(
      "computer_bob",
      expect.objectContaining({
        timeoutMs: 1_000,
        queue: {
          priority: 0,
          kind: "approval",
          key: "test",
          runOperationId: "operation_1",
        },
      }),
    );
    // A recording question goes before chat.
    await modelCall.text({
      kind: "voice_ask",
      key: "ask",
      owner: { tenantId: "tenant_1", ownerActorId: "bob" },
      input: "What did they say?",
    });
    expect(invokeModel.mock.lastCall![1].queue).toEqual({
      kind: "voice_ask",
      key: "ask",
      priority: 5,
    });
  });

  it("does not spend an interactive call's timeout while it waits for a place", async () => {
    let admit!: () => void;
    const admitted = new Promise<void>((resolve) => (admit = resolve));
    const { modelCall, invokeModel } = setup({
      invoke: async () => {
        await admitted;
        return completed("Notes");
      },
    });
    const notes = modelCall.text({
      kind: "meeting_notes",
      key: "recording",
      owner: { tenantId: "tenant_1", ownerActorId: "alice" },
      input: "Notes",
      timeoutMs: 25,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    admit();
    await expect(notes).resolves.toMatchObject({ output: "Notes" });
    expect(invokeModel.mock.lastCall![1]).toMatchObject({
      timeoutMs: 25,
      queue: { priority: 5, kind: "meeting_notes" },
    });
  });

  it("runs a workspace call on a named Another Me and returns its files", async () => {
    const { modelCall, invokeModel, placements } = setup({
      outcomes: [
        {
          outcome: "completed",
          workspace_files: [
            {
              path: "topics/a.json",
              content_base64: Buffer.from("{}").toString("base64"),
            },
          ],
          duration_ms: 10,
        },
      ],
    });
    const result = await modelCall.workspace({
      ...work,
      anotherMe: { tenantId: "tenant_1", agentActorId: "another_me_bob" },
      input: "Write the page.",
      files: [{ path: "inputs/a.md", content: Buffer.from("# A") }],
      timeoutMs: 1_000,
    });
    expect(placements).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
    expect(invokeModel).toHaveBeenCalledWith(
      "computer_bob",
      expect.objectContaining({
        mode: "workspace",
        agentId: "agent_bob",
        workspaceFiles: [
          {
            path: "inputs/a.md",
            content_base64: Buffer.from("# A").toString("base64"),
          },
        ],
      }),
    );
    expect(result.model).toBe("claude");
    expect(
      result.output.map((file) => [
        file.path,
        Buffer.from(file.content).toString(),
      ]),
    ).toEqual([["topics/a.json", "{}"]]);
    await expect(
      modelCall.workspace({
        ...work,
        anotherMe: { tenantId: "tenant_1", agentActorId: "another_me_carol" },
        input: "x",
        files: [],
        timeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });
  });

  it("reports the model the Runtime named", async () => {
    const { modelCall, invokeModel } = setup({
      outcomes: [completed("Hello.", "gpt-5-codex")],
    });
    await expect(
      modelCall.text({
        ...work,
        owner: { tenantId: "tenant_1", ownerActorId: "alice" },
        effort: "medium",
        input: "Say hello.",
        timeoutMs: 1_000,
      }),
    ).resolves.toEqual({ output: "Hello.", model: "gpt-5-codex" });
    expect(invokeModel.mock.calls[0]![1]).toMatchObject({
      mode: "text",
      reasoningEffort: "medium",
    });
  });

  it("resolves an ownerless call only in a deployment with exactly one Another Me", async () => {
    const single = setup({ placements: [alice] });
    await single.modelCall.call({ ...ask, input: "x" });
    expect(single.invokeModel.mock.calls[0]![0]).toBe("computer_alice");

    const shared = setup();
    await expect(
      shared.modelCall.call({ ...ask, input: "x" }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });
    await expect(
      shared.modelCall.call({
        ...ask,
        owner: { tenantId: "tenant_1", ownerActorId: "carol" },
        input: "x",
      }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });
    expect(shared.invokeModel).not.toHaveBeenCalled();
  });

  it("runs a placed call where the Agent runs without resolving an owner", async () => {
    const { modelCall, invokeModel, placements } = setup();
    await modelCall.call({ ...ask, placement: bob, input: "x" });
    expect(placements).not.toHaveBeenCalled();
    expect(invokeModel.mock.calls[0]![0]).toBe("computer_bob");
  });

  it("falls back to the other ready Runtime, and tries its own when none is ready", async () => {
    const fallback = setup({
      placements: [alice],
      ready: (_computer, runtime) => runtime === "claude",
    });
    await fallback.modelCall.call({ ...ask, input: "x" });
    expect(fallback.invokeModel.mock.calls[0]![1].runtimeType).toBe("claude");

    const ownPreferred = setup({
      placements: [bob],
      ready: () => true,
    });
    await ownPreferred.modelCall.call({ ...ask, input: "x" });
    expect(ownPreferred.invokeModel.mock.calls[0]![1].runtimeType).toBe(
      "claude",
    );

    const none = setup({
      placements: [alice],
      ready: () => false,
      outcomes: [
        new ModelCallError("runtime_unavailable", "Runtime codex is not ready"),
      ],
    });
    await expect(
      none.modelCall.call({ ...ask, input: "x" }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(none.invokeModel.mock.calls[0]![1].runtimeType).toBe("codex");
  });

  it("calls an Antigravity Agent's model through Claude, else Codex", async () => {
    const antigravity: ModelPlacement = {
      ...alice,
      runtimeType: "antigravity",
    };
    const claude = setup({ placements: [antigravity], ready: () => true });
    await claude.modelCall.call({ ...ask, input: "x" });
    expect(claude.invokeModel.mock.calls[0]![1].runtimeType).toBe("claude");

    const codex = setup({
      placements: [antigravity],
      ready: (_computer, runtime) => runtime === "codex",
    });
    await codex.modelCall.call({ ...ask, input: "x" });
    expect(codex.invokeModel.mock.calls[0]![1].runtimeType).toBe("codex");
  });

  it("caches an owner's placement for 30 seconds and drops it when the Computer is offline", async () => {
    const { modelCall, placements, advance } = setup({
      placements: [alice],
      outcomes: [
        completed('{"answer":"yes"}'),
        completed('{"answer":"yes"}'),
        { outcome: "unavailable", reason: "updating", duration_ms: 0 },
        completed('{"answer":"yes"}'),
      ],
    });
    const owner = { tenantId: "tenant_1", ownerActorId: "alice" };
    await modelCall.call({ ...ask, owner, input: "x" });
    await modelCall.call({ ...ask, owner, input: "x" });
    expect(placements).toHaveBeenCalledTimes(1);
    const offline = await modelCall
      .call({ ...ask, owner, input: "x" })
      .catch((error: unknown) => error);
    expect(offline).toMatchObject({ kind: "computer_offline" });
    expect(isComputerOffline(offline)).toBe(true);
    await modelCall.call({ ...ask, owner, input: "x" });
    expect(placements).toHaveBeenCalledTimes(2);
    advance(30_001);
    await modelCall.call({ ...ask, owner, input: "x" });
    expect(placements).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["unavailable", "computer_offline", undefined],
    ["runtime_unavailable", "runtime_unavailable", "runtime_unavailable"],
    ["auth_required", "runtime_unavailable", "auth_required"],
    ["runtime_incompatible", "runtime_unavailable", "runtime_incompatible"],
    ["timed_out", "timed_out", undefined],
    ["output_limited", "output_limited", undefined],
    ["failed", "failed", undefined],
  ] as const)(
    "maps a %s outcome to %s",
    async (outcome, kind, runtimeOutcome) => {
      const { modelCall } = setup({
        placements: [alice],
        outcomes: [{ outcome, duration_ms: 0 }],
      });
      await expect(
        modelCall.text({ ...work, kind: "approval", input: "x" }),
      ).rejects.toMatchObject({
        name: "ModelCallError",
        kind,
        ...(runtimeOutcome ? { runtimeOutcome } : {}),
      });
    },
  );

  it("corrects an answer that breaks the schema within the kind's attempts", async () => {
    const corrected = setup({
      placements: [alice],
      outcomes: [
        completed('{"answer":1}'),
        completed('```json\n{"answer":"ok"}\n```'),
      ],
    });
    await expect(
      corrected.modelCall.call({ ...ask, input: "Question?" }),
    ).resolves.toMatchObject({ output: { answer: "ok" } });
    const retry = corrected.invokeModel.mock.calls[1]![1].input;
    expect(retry).toMatch(/^Question\?\n\n## Required Correction/u);
    expect(retry).toContain("must be string");
    expect(retry).toContain('{\\"answer\\":1}');

    const invalid = setup({
      placements: [alice],
      outcomes: [completed("not json"), completed('{"answer":"ok","extra":1}')],
    });
    const error = await invalid.modelCall
      .call({ ...ask, kind: "profile", input: "Question?" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      kind: "invalid_output",
      output: '{"answer":"ok","extra":1}',
    });
    expect(invalid.invokeModel).toHaveBeenCalledTimes(2);
  });

  it("rejects an answer its check refuses and corrects it with the reason", async () => {
    const validate = vi.fn(({ answer }: Record<string, unknown>) =>
      answer === "yes" ? undefined : "the answer must be yes",
    );
    const corrected = setup({
      placements: [alice],
      outcomes: [completed('{"answer":"no"}'), completed('{"answer":"yes"}')],
    });
    await expect(
      corrected.modelCall.call({ ...ask, validate, input: "Question?" }),
    ).resolves.toMatchObject({ output: { answer: "yes" } });
    expect(validate).toHaveBeenCalledTimes(2);
    const retry = corrected.invokeModel.mock.calls[1]![1].input;
    expect(retry).toMatch(/^Question\?\n\n## Required Correction/u);
    expect(retry).toContain("rejected: the answer must be yes.");

    const refused = setup({
      placements: [alice],
      outcomes: [completed('{"answer":"no"}'), completed('{"answer":"no"}')],
    });
    await expect(
      refused.modelCall.call({
        ...ask,
        kind: "profile",
        validate,
        input: "Question?",
      }),
    ).rejects.toMatchObject({
      kind: "invalid_output",
      message: expect.stringContaining("the answer must be yes"),
    });
    expect(refused.invokeModel).toHaveBeenCalledTimes(2);
  });

  it("sends a session's call to its session and each retry to a fresh one", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [
        completed('{"answer":1}'),
        completed('{"answer":2}'),
        completed('{"answer":"ok"}'),
      ],
    });
    await expect(
      modelCall.call({ ...ask, sessionKey: "review:1", input: "Question?" }),
    ).resolves.toMatchObject({ output: { answer: "ok" } });
    const sessions = invokeModel.mock.calls.map(
      ([, request]) => request.sessionKey,
    );
    expect(sessions[0]).toBe("review:1");
    expect(sessions.slice(1)).toEqual([
      expect.stringMatching(/^retry:[0-9a-f]{64}$/u),
      expect.stringMatching(/^retry:[0-9a-f]{64}$/u),
    ]);
    expect(new Set(sessions).size).toBe(3);
  });

  it("does not correct a kind with one attempt", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [completed('{"answer":1}'), completed('{"answer":"ok"}')],
    });
    await expect(
      modelCall.call({ ...ask, kind: "approval", input: "Question?" }),
    ).rejects.toMatchObject({ kind: "invalid_output" });
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty answer as invalid output", async () => {
    const { modelCall } = setup({
      placements: [alice],
      outcomes: [completed("   ")],
    });
    await expect(
      modelCall.text({ ...work, kind: "approval", input: "x" }),
    ).rejects.toMatchObject({ kind: "invalid_output" });
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** An invocation that runs until its execution is stopped. */
const hanging: Invoke = (_computerId, request) =>
  new Promise((_resolve, reject) =>
    request.signal.addEventListener("abort", () =>
      reject(request.signal.reason),
    ),
  );

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("Model call executions", () => {
  afterEach(() => vi.useRealTimers());

  it("joins callers asking the same and runs other content as a new call", async () => {
    const answer = deferred<Outcome>();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: () => answer.promise,
    });
    const calls = [
      modelCall.text({ ...work, input: "x" }),
      modelCall.text({ ...work, input: "x" }),
      modelCall.text({ ...work, input: "y" }),
    ];
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(2));
    answer.resolve(completed("done"));
    await expect(Promise.all(calls)).resolves.toMatchObject([
      { output: "done" },
      { output: "done" },
      { output: "done" },
    ]);
  });

  it("keeps a background answer for the caller that comes back", async () => {
    const answer = deferred<Outcome>();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: () => answer.promise,
    });
    const leave = new AbortController();
    const first = modelCall.text({ ...work, input: "x", signal: leave.signal });
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    leave.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(false);

    answer.resolve(completed("kept"));
    await settled();
    await expect(
      modelCall.text({ ...work, input: "x" }),
    ).resolves.toMatchObject({ output: "kept" });
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("stops an interactive call once nobody waits", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: hanging,
    });
    const leave = new AbortController();
    const review = modelCall.text({
      kind: "approval",
      key: "review",
      input: "x",
      signal: leave.signal,
    });
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    leave.abort(new Error("caller left"));
    await expect(review).rejects.toThrow("caller left");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("retries a timed out attempt after a pause within the kind's attempts", async () => {
    vi.useFakeTimers();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [
        { outcome: "timed_out", duration_ms: 0 },
        { outcome: "failed", duration_ms: 0 },
        completed("third"),
      ],
    });
    const call = modelCall.text({ ...work, input: "x" });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(invokeModel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_001);
    await expect(call).resolves.toMatchObject({ output: "third" });
    expect(invokeModel).toHaveBeenCalledTimes(3);
  });

  it("fails an offline call at once", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [{ outcome: "unavailable", duration_ms: 0 }],
    });
    await expect(modelCall.text({ ...work, input: "x" })).rejects.toMatchObject(
      { kind: "computer_offline" },
    );
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("stops on close and drops every unfinished call", async () => {
    const { modelCall, invokeModel, logger } = setup({
      placements: [alice],
      invoke: hanging,
    });
    const memory = modelCall
      .text({ ...work, input: "x" })
      .catch((error: unknown) => error);
    const review = modelCall
      .text({ kind: "approval", key: "r", input: "y" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(2));

    modelCall.close();
    expect(logger.log).toHaveBeenCalledWith(
      "info",
      "model_call.shutdown_dropped",
      {
        calls: [
          { kind: "memory", key: "test" },
          { kind: "approval", key: "r" },
        ],
      },
    );
    expect(await memory).toMatchObject({ kind: "computer_offline" });
    expect(await review).toMatchObject({ kind: "computer_offline" });
    expect(
      invokeModel.mock.calls.every(([, request]) => request.signal.aborted),
    ).toBe(true);
    await expect(modelCall.text({ ...work, input: "z" })).rejects.toMatchObject(
      { kind: "computer_offline" },
    );
  });
});

describe("Model chains", () => {
  afterEach(() => vi.useRealTimers());
  const owner = { tenantId: "tenant_1", ownerActorId: "alice" };
  const lease = () => ({
    release: vi.fn(),
    borrow: () => ({ release: vi.fn() }),
  });

  it("takes a new place for each call on the same Runtime", async () => {
    const first = lease();
    const second = lease();
    const { modelCall, invokeModel, acquireModelCall } = setup({
      placements: [alice],
      lease: second,
      outcomes: [
        { ...completed("one"), usage: { input_tokens: 3 } } as Outcome,
        completed('{"answer":"two"}'),
      ],
    });
    acquireModelCall.mockResolvedValueOnce(first);
    const result = await modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:1", owner },
      async (task) => [
        (await task.text({ step: "a", input: "x" })).output,
        (
          await task.call({
            step: "b",
            input: "y",
            schemaName: "answer",
            outputSchema: schema,
          })
        ).output,
      ],
    );
    expect(result).toEqual(["one", { answer: "two" }]);
    expect(
      acquireModelCall.mock.calls.map(([endpoint, work]) => [
        endpoint.runtimeType,
        work.key,
      ]),
    ).toEqual([
      ["codex", "wiki:refresh:1"],
      ["codex", "wiki:refresh:1/b"],
    ]);
    expect(
      invokeModel.mock.calls.map(([, request]) => request.callLease),
    ).toEqual([first, second]);
    expect(first.release).toHaveBeenCalledExactlyOnceWith({
      outcome: "completed",
      usage: { input_tokens: 3 },
    });
    expect(second.release).toHaveBeenCalledExactlyOnceWith({
      outcome: "completed",
    });
  });

  it("releases a joined chain's unused place and keeps the shared call alive for the other waiter", async () => {
    const first = lease();
    const joined = lease();
    const { modelCall, acquireModelCall, invokeModel } = setup({
      placements: [alice],
      invoke: hanging,
    });
    acquireModelCall.mockResolvedValueOnce(first).mockResolvedValueOnce(joined);
    const left = new AbortController();
    const right = new AbortController();
    const execute = (signal: AbortSignal) =>
      modelCall.chain(
        { kind: "wiki", key: "wiki:duplicate", owner, signal },
        (chain) => chain.text({ step: "a", input: "one" }),
      );
    const a = execute(left.signal);
    const b = execute(right.signal);
    await vi.waitFor(() =>
      expect(joined.release).toHaveBeenCalledExactlyOnceWith({
        outcome: "joined",
      }),
    );
    expect(invokeModel).toHaveBeenCalledTimes(1);
    left.abort(new Error("left"));
    await expect(a).rejects.toThrow("left");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(false);
    right.abort(new Error("right"));
    await expect(b).rejects.toThrow("right");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("spends a step budget only while an attempt holds a place", async () => {
    vi.useFakeTimers();
    const { modelCall, invokeModel, acquireModelCall } = setup({
      placements: [alice],
      invoke: async () => {
        vi.setSystemTime(Date.now() + 600);
        return completed("x");
      },
    });
    // Every place, the chain's first included, comes after a long wait.
    acquireModelCall.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5_000);
      return lease();
    });
    const budget = new ModelRunBudget(1_000);
    const result = modelCall.chain(
      { kind: "wiki", key: "wiki:budget", owner },
      async (chain) => {
        await chain.text({ step: "first", input: "a", budget });
        await chain.text({ step: "second", input: "b", budget });
        return chain.text({ step: "third", input: "c", budget });
      },
    );
    await expect(result).rejects.toBeInstanceOf(ModelBudgetSpentError);
    expect(invokeModel).toHaveBeenCalledTimes(2);
  });

  it("counts overlapping attempts of one budget once", () => {
    let now = 0;
    const budget = new ModelRunBudget(100, { now: () => now });
    const first = budget.run();
    now = 40;
    const second = budget.run();
    now = 70;
    first();
    first();
    now = 90;
    second();
    now = 500;
    expect(budget.spent).toBe(false);
    const third = budget.run();
    now = 510;
    expect(budget.spent).toBe(true);
    third();
  });

  it("also spends a budget at its wall-clock cap however little ran", () => {
    let now = 0;
    const budget = new ModelRunBudget(100, {
      wallClockMs: 1_000,
      now: () => now,
    });
    budget.run()();
    now = 999;
    expect(budget.spent).toBe(false);
    now = 1_000;
    expect(budget.spent).toBe(true);
  });

  it("keeps its admitted Runtime when availability changes between steps", async () => {
    let codexReady = false;
    const { modelCall, invokeModel, acquireModelCall } = setup({
      placements: [alice],
      ready: (_computer, runtime) =>
        runtime === "codex" ? codexReady : !codexReady,
      outcomes: [completed("a"), completed("b")],
    });
    await modelCall.chain(
      { kind: "wiki", key: "wiki:pinned", owner },
      async (chain) => {
        await chain.text({ step: "first", input: "a" });
        codexReady = true;
        await chain.text({ step: "second", input: "b" });
      },
    );
    expect(
      acquireModelCall.mock.calls.map(([endpoint]) => endpoint.runtimeType),
    ).toEqual(["claude", "claude"]);
    expect(
      invokeModel.mock.calls.map(([, request]) => request.runtimeType),
    ).toEqual(["claude", "claude"]);
  });

  it("runs its calls one at a time in the order they are made", async () => {
    const answers: ((outcome: Outcome) => void)[] = [];
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: () => new Promise<Outcome>((resolve) => answers.push(resolve)),
    });
    const result = modelCall.chain(
      { kind: "memory", key: "memory:chain", owner },
      (chain) =>
        Promise.all(
          ["a", "b"].map(
            async (step) => (await chain.text({ step, input: step })).output,
          ),
        ),
    );
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(invokeModel).toHaveBeenCalledTimes(1);
    answers[0]!(completed("first"));
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(2));
    expect(invokeModel.mock.calls[1]![1].input).toBe("b");
    answers[1]!(completed("second"));
    await expect(result).resolves.toEqual(["first", "second"]);
  });

  it("sends a chain call's session to the Runtime", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [completed('{"answer":"ok"}')],
    });
    await modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:3", owner },
      (task) =>
        task.call({
          step: "batch:1/1",
          input: "x",
          schemaName: ask.schemaName,
          outputSchema: ask.outputSchema,
          sessionKey: "wiki:refresh:3/batch:1",
        }),
    );
    expect(invokeModel.mock.calls[0]![1]).toMatchObject({
      sessionKey: "wiki:refresh:3/batch:1",
    });
  });

  it("sends the output cap on every attempt and keeps what a stopped call streamed", async () => {
    vi.useFakeTimers();
    const limited = {
      outcome: "output_limited",
      text: '{"actions":[{"p',
      reason: "Model reply exceeded its output limit",
      duration_ms: 0,
    } as const;
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [limited, limited],
    });
    const stopped = modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:4", owner },
      (task) =>
        task
          .call({
            step: "batch:1",
            input: "x",
            schemaName: "answer",
            outputSchema: schema,
            maxOutputChars: 24_000,
          })
          .catch((caught: unknown) => caught as ModelCallError),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await stopped).toMatchObject({
      kind: "output_limited",
      output: '{"actions":[{"p',
    });
    expect(
      invokeModel.mock.calls.map(([, request]) => request.maxOutputChars),
    ).toEqual([24_000, 24_000]);
  });

  it("records each call's prompt and reply", async () => {
    const callLog = { started: vi.fn(), finished: vi.fn() };
    const { modelCall } = setup({
      placements: [alice],
      callLog,
      outcomes: [
        completed('{"answer":"yes"}', "gpt-test"),
        { outcome: "timed_out", text: "{", duration_ms: 0 },
      ],
    });
    await modelCall.call({
      ...ask,
      kind: "wiki",
      key: "wiki:refresh:5/route",
      instructions: "Route.",
      input: "Sources",
    });
    expect(callLog.started).toHaveBeenCalledWith({
      kind: "wiki",
      key: "wiki:refresh:5/route",
      attempt: 1,
      mode: "structured",
      instructions: "Route.",
      input: "Sources",
    });
    expect(callLog.finished).toHaveBeenCalledWith(
      expect.objectContaining({
        key: "wiki:refresh:5/route",
        outcome: "completed",
        model: "gpt-test",
        text: '{"answer":"yes"}',
      }),
    );
    await expect(
      modelCall.text({ ...work, kind: "approval", input: "x" }),
    ).rejects.toMatchObject({ kind: "timed_out" });
    expect(callLog.finished).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "timed_out",
        text: "{",
        error: "The Runtime did not answer in time",
      }),
    );
  });

  it("queues each retry and hands the final failure to the chain", async () => {
    vi.useFakeTimers();
    const timedOut = { outcome: "timed_out", duration_ms: 0 } as const;
    const { modelCall, invokeModel, acquireModelCall } = setup({
      placements: [alice],
      outcomes: [timedOut, timedOut, timedOut],
    });
    const kind = modelCall.chain(
      { kind: "memory", key: "memory:task", owner },
      (task) =>
        task
          .text({ step: "round-1", input: "x" })
          .then(() => "answered")
          .catch((error: unknown) => (error as ModelCallError).kind),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await kind).toBe("timed_out");
    expect(invokeModel).toHaveBeenCalledTimes(3);
    expect(acquireModelCall).toHaveBeenCalledTimes(3);
    expect(
      invokeModel.mock.calls.every(
        ([, request]) => request.callLease !== undefined,
      ),
    ).toBe(true);
  });

  it("stops its calls and frees its place when the caller stops it", async () => {
    const callLease = lease();
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      lease: callLease,
      invoke: hanging,
    });
    const stop = new AbortController();
    const task = modelCall.chain(
      { kind: "wiki", key: "wiki:refresh:2", owner, signal: stop.signal },
      (task) => task.text({ step: "a", input: "x" }),
    );
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    stop.abort(new Error("refresh canceled"));
    await expect(task).rejects.toThrow("refresh canceled");
    expect(invokeModel.mock.calls[0]![1].signal.aborted).toBe(true);
    expect(callLease.release).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "aborted" }),
    );
  });

  it("stops on close and drops its running call", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      invoke: hanging,
    });
    let taskSignal: AbortSignal | undefined;
    const task = modelCall
      .chain({ kind: "wiki", key: "wiki:refresh:3", owner }, (task) => {
        taskSignal = task.signal;
        return task.text({ step: "a", input: "x" });
      })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(invokeModel).toHaveBeenCalledTimes(1));
    modelCall.close();
    expect(await task).toMatchObject({ kind: "computer_offline" });
    expect(taskSignal?.aborted).toBe(true);
  });
});

describe("Model context window", () => {
  const catalogs: Record<string, Record<string, RuntimeModelInfo[]>> = {
    computer_alice: {
      codex: [
        { id: "gpt-large", runtimeModel: "gpt-large", contextWindow: 400_000 },
        {
          id: "gpt-default",
          runtimeModel: "gpt-default",
          contextWindow: 272_000,
          isDefault: true,
        },
        { id: "codex-default" },
      ],
      claude: [
        {
          id: "default",
          runtimeModel: "default",
          contextWindow: 65_536,
          isDefault: true,
        },
      ],
    },
    computer_bob: {
      claude: [
        { id: "opus", runtimeModel: "opus" },
        { id: "default", runtimeModel: "default", isDefault: true },
      ],
    },
  };
  const runtimeModels = (computerId: string, runtimeType: string) =>
    catalogs[computerId]?.[runtimeType] ?? [];

  it("is the window of the default model on the Runtime the calls run on", async () => {
    const { modelCall } = setup({ runtimeModels });
    await expect(
      modelCall.contextWindow!({
        anotherMe: {
          tenantId: alice.tenantId,
          agentActorId: "another_me_alice",
        },
      }),
    ).resolves.toBe(272_000);
    // Calls on a Computer whose own Runtime cannot run them move to the other.
    await expect(
      setup({
        runtimeModels,
        ready: (_computer, runtime) => runtime === "claude",
      }).modelCall.contextWindow!({ placement: alice }),
    ).resolves.toBe(65_536);
  });

  it("uses the placed Agent's configured model and its context window", async () => {
    const aliceCustom: ModelPlacement = { ...alice, model: "gpt-large" };
    const { modelCall, invokeModel } = setup({
      placements: [aliceCustom],
      runtimeModels,
    });
    await expect(
      modelCall.contextWindow!({
        anotherMe: {
          tenantId: aliceCustom.tenantId,
          agentActorId: "another_me_alice",
        },
      }),
    ).resolves.toBe(400_000);
    await modelCall.call({
      ...ask,
      owner: { tenantId: aliceCustom.tenantId, ownerActorId: "alice" },
      input: "Question?",
    });
    expect(invokeModel).toHaveBeenCalledWith(
      "computer_alice",
      expect.objectContaining({
        runtimeType: "codex",
        model: "gpt-large",
      }),
    );

    // Cross-Runtime fallback never leaks the source Runtime's model across a chain.
    const fallback = setup({
      placements: [aliceCustom],
      runtimeModels,
      ready: (_computer, runtime) => runtime === "claude",
    });
    await expect(
      fallback.modelCall.contextWindow!({ placement: aliceCustom }),
    ).resolves.toBe(65_536);
    await fallback.modelCall.chain(
      { kind: "wiki", key: "wiki:1", placement: aliceCustom },
      (chain) =>
        chain.call({
          step: "plan",
          schemaName: "answer",
          outputSchema: schema,
          input: "Plan?",
        }),
    );
    expect(fallback.invokeModel).toHaveBeenCalledWith(
      "computer_alice",
      expect.objectContaining({
        runtimeType: "claude",
        model: "default",
      }),
    );

    // Legacy default catalog entries (runtimeModel undefined) fall back to the Runtime's default.
    const legacy = setup({
      placements: [{ ...alice, model: "codex-default" }],
      runtimeModels,
    });
    await legacy.modelCall.call({
      ...ask,
      owner: { tenantId: alice.tenantId, ownerActorId: "alice" },
      input: "Legacy?",
    });
    expect(legacy.invokeModel).toHaveBeenCalledWith(
      "computer_alice",
      expect.objectContaining({
        runtimeType: "codex",
        model: "gpt-default",
      }),
    );
  });

  it("is unknown without a window or a placement", async () => {
    const { modelCall } = setup({ runtimeModels });
    await expect(
      modelCall.contextWindow!({ placement: bob }),
    ).resolves.toBeUndefined();
    await expect(
      setup({ runtimeModels, placements: [] }).modelCall.contextWindow!({
        owner: { tenantId: alice.tenantId, ownerActorId: "alice" },
      }),
    ).resolves.toBeUndefined();
  });

  it("fails while the Computer is offline", async () => {
    const { modelCall } = setup({ runtimeModels: () => undefined });
    await expect(
      modelCall.contextWindow!({ placement: alice }),
    ).rejects.toMatchObject({ kind: "computer_offline" });
  });
});

describe("Model call invocation log", () => {
  function invokedLines(logger: { log: ReturnType<typeof vi.fn> }) {
    return logger.log.mock.calls
      .filter(([, event]) => event === "model_call.invoked")
      .map(([level, , fields]) => ({
        level: level as string,
        fields: fields as Record<string, unknown>,
      }));
  }

  it("carries a failed call's reason", async () => {
    const { modelCall, logger } = setup({
      placements: [alice],
      invoke: async () => ({
        outcome: "failed",
        reason: "model_not_found: The model gpt-x does not exist",
        duration_ms: 1,
      }),
    });
    await expect(
      modelCall.text({ kind: "approval", key: "r", input: "x" }),
    ).rejects.toThrow(ModelCallError);
    const [line] = invokedLines(logger);
    expect(line).toMatchObject({
      level: "warn",
      fields: {
        outcome: "failed",
        reason:
          "Model invocation failed: model_not_found: The model gpt-x does not exist",
      },
    });
  });

  it("redacts credentials in the reason and keeps 300 characters", async () => {
    const secret = `sk-${"A".repeat(40)}`;
    const { modelCall, logger } = setup({
      placements: [alice],
      invoke: async () => ({
        outcome: "failed",
        reason: `401 for key ${secret} with Authorization: Bearer fixture-token ${"é".repeat(400)}`,
        duration_ms: 1,
      }),
    });
    await expect(
      modelCall.text({ kind: "approval", key: "r", input: "x" }),
    ).rejects.toThrow(ModelCallError);
    const reason = String(invokedLines(logger)[0]!.fields.reason);
    expect(reason).not.toContain(secret);
    expect(reason).not.toContain("fixture-token");
    expect(reason).toContain("[Redacted]");
    expect(Array.from(reason)).toHaveLength(300);
  });

  it("adds no reason to a completed call", async () => {
    const { modelCall, logger } = setup({ placements: [alice] });
    await modelCall.call({ ...ask, input: "x" });
    const [line] = invokedLines(logger);
    expect(line!.level).toBe("info");
    expect(Object.keys(line!.fields).sort()).toEqual([
      "attempt",
      "computer_id",
      "duration_ms",
      "key",
      "kind",
      "mode",
      "model",
      "outcome",
      "runtime_type",
    ]);
  });
});

describe("Background call outcomes", () => {
  afterEach(() => vi.useRealTimers());

  function reported(options: Parameters<typeof setup>[0] = {}) {
    const onBackgroundOutcome =
      vi.fn<(outcome: BackgroundCallOutcome) => void>();
    return {
      ...setup({ placements: [alice], ...options, onBackgroundOutcome }),
      onBackgroundOutcome,
    };
  }

  it("reports a completed background call once for every caller it served", async () => {
    const { modelCall, onBackgroundOutcome } = reported({
      outcomes: [completed("done")],
    });
    await Promise.all([
      modelCall.text({ ...work, input: "x" }),
      modelCall.text({ ...work, input: "x" }),
    ]);
    expect(onBackgroundOutcome.mock.calls).toEqual([
      [
        {
          tenantId: "tenant_1",
          agentActorId: "another_me_alice",
          kind: "memory",
        },
      ],
    ]);
  });

  it.each([
    ["auth_required", "runtime_auth_required"],
    ["runtime_incompatible", "runtime_incompatible"],
    ["unsupported", "runtime_incompatible"],
    ["runtime_unavailable", "runtime_unavailable"],
  ] as const)(
    "reports a Runtime that answers %s as %s",
    async (outcome, failure) => {
      const { modelCall, onBackgroundOutcome } = reported({
        outcomes: [{ outcome, reason: "sk-secret", duration_ms: 0 }],
      });
      await expect(modelCall.text({ ...work, input: "x" })).rejects.toThrow();
      expect(onBackgroundOutcome.mock.calls).toEqual([
        [
          {
            tenantId: "tenant_1",
            agentActorId: "another_me_alice",
            kind: "memory",
            failure,
          },
        ],
      ]);
    },
  );

  it("reports a call that fails every attempt once, with an unknown reason", async () => {
    vi.useFakeTimers();
    const { modelCall, invokeModel, onBackgroundOutcome } = reported({
      outcomes: [
        { outcome: "failed", duration_ms: 0 },
        { outcome: "timed_out", duration_ms: 0 },
        { outcome: "failed", duration_ms: 0 },
      ],
    });
    const call = modelCall
      .text({ ...work, input: "x" })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await call).toBeInstanceOf(ModelCallError);
    expect(invokeModel).toHaveBeenCalledTimes(3);
    expect(onBackgroundOutcome.mock.calls).toEqual([
      [expect.objectContaining({ failure: "unknown" })],
    ]);
  });

  it("does not report an offline Computer, a missing Another Me or a stopped call", async () => {
    const offline = reported({
      outcomes: [{ outcome: "unavailable", duration_ms: 0 }],
    });
    await expect(
      offline.modelCall.text({ ...work, input: "x" }),
    ).rejects.toMatchObject({ kind: "computer_offline" });

    const unplaced = reported({ placements: [] });
    await expect(
      unplaced.modelCall.text({ ...work, input: "x" }),
    ).rejects.toMatchObject({ kind: "owner_unresolved" });

    const stopped = reported({ invoke: hanging });
    const memory = stopped.modelCall
      .text({ ...work, input: "x" })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(stopped.invokeModel).toHaveBeenCalled());
    stopped.modelCall.close();
    await memory;

    for (const { onBackgroundOutcome } of [offline, unplaced, stopped])
      expect(onBackgroundOutcome).not.toHaveBeenCalled();
  });

  it("does not report a call the background backoff held back", async () => {
    const { modelCall, invokeModel, onBackgroundOutcome } = reported({
      invoke: async () => ({ outcome: "auth_required", duration_ms: 0 }),
    });
    for (const input of ["a", "b", "c"])
      await expect(modelCall.text({ ...work, input })).rejects.toMatchObject({
        kind: "runtime_unavailable",
      });
    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(onBackgroundOutcome.mock.calls).toEqual([
      [expect.objectContaining({ failure: "runtime_auth_required" })],
      [expect.objectContaining({ failure: "runtime_auth_required" })],
    ]);
  });

  it("does not report a call the Daemon canceled on every attempt", async () => {
    vi.useFakeTimers();
    const { modelCall, invokeModel, onBackgroundOutcome } = reported({
      outcomes: [
        { outcome: "canceled", duration_ms: 0 },
        { outcome: "canceled", duration_ms: 0 },
      ],
    });
    const call = modelCall
      .text({ kind: "profile", key: "profile", input: "x" })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await call).toMatchObject({ kind: "failed", canceled: true });
    expect(invokeModel).toHaveBeenCalledTimes(2);
    expect(onBackgroundOutcome).not.toHaveBeenCalled();
  });

  it("does not report interactive calls or an Agent placed without its actor", async () => {
    const { modelCall, onBackgroundOutcome } = reported({
      outcomes: [
        { outcome: "runtime_incompatible", duration_ms: 0 },
        completed("done"),
      ],
    });
    await expect(
      modelCall.text({ kind: "approval", key: "r", input: "x" }),
    ).rejects.toThrow();
    const { agentActorId: _, ...placement } = alice;
    await modelCall.text({ ...work, input: "x", placement });
    expect(onBackgroundOutcome).not.toHaveBeenCalled();
  });
});

describe("TeamHub background outcome reporter", () => {
  function reporter(fetch: typeof globalThis.fetch) {
    const logger = { log: vi.fn() };
    const report = createTeamHubBackgroundOutcomeReporter({
      baseUrl: "http://teamhub.test",
      serviceToken: "service-token",
      logger,
      fetch,
    });
    return { report, logger };
  }

  it("posts a failed call's reason code for its Another Me", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(null, { status: 204 }),
    );
    const { report, logger } = reporter(fetch);
    report({
      tenantId: "tenant_1",
      agentActorId: "another_me_alice",
      kind: "wiki",
      failure: "runtime_incompatible",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const [url, init] = fetch.mock.calls[0]!;
    expect((url as URL).href).toBe(
      "http://teamhub.test/v0/agent-runtime/another-me/background-calls",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({
      tenant_id: "tenant_1",
      agent_actor_id: "another_me_alice",
      outcome: "failed",
      reason: "runtime_incompatible",
    });
    await settled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it("only warns when TeamHub predates the route or cannot be reached", async () => {
    const answers = [
      async () => new Response("{}", { status: 404 }),
      async () => {
        throw new TypeError("fetch failed");
      },
    ];
    const fetch = vi.fn<typeof globalThis.fetch>(() => answers.shift()!());
    const { report, logger } = reporter(fetch);
    const outcome = {
      tenantId: "tenant_1",
      agentActorId: "another_me_alice",
      kind: "memory",
    } as const;
    report(outcome);
    report(outcome);
    await vi.waitFor(() => expect(logger.log).toHaveBeenCalledTimes(2));
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string)).toEqual({
      tenant_id: "tenant_1",
      agent_actor_id: "another_me_alice",
      outcome: "completed",
    });
    expect(logger.log.mock.calls).toEqual(
      expect.arrayContaining([
        [
          "warn",
          "model_call.background_report_failed",
          expect.objectContaining({ kind: "memory", status: 404 }),
        ],
        [
          "warn",
          "model_call.background_report_failed",
          expect.objectContaining({ error: expect.any(TypeError) }),
        ],
      ]),
    );
  });

  it("only warns when the refused answer's body has already errored", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const fetch = vi.fn<typeof globalThis.fetch>(async () => {
        const body = new ReadableStream({
          start: (controller) => controller.error(new Error("socket reset")),
        });
        return new Response(body, { status: 404 });
      });
      const { report, logger } = reporter(fetch);
      report({
        tenantId: "tenant_1",
        agentActorId: "another_me_alice",
        kind: "memory",
      });
      await vi.waitFor(() =>
        expect(logger.log).toHaveBeenCalledWith(
          "warn",
          "model_call.background_report_failed",
          expect.objectContaining({ status: 404 }),
        ),
      );
      await settled();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("Runner Gateway model invocation adapter", () => {
  it.each([
    [
      new LocalComputerOfflineError("Local Computer is updating"),
      "computer_offline",
    ],
    [
      new RunnerModelInvokeUnavailableError("upgrade the Local Computer"),
      "runtime_unavailable",
    ],
    [
      new RangeError("Model invocation prompt exceeds 3 MiB"),
      "invalid_request",
    ],
  ] as const)("maps %s", async (thrown, kind) => {
    const gateway = runtimeModelGateway({
      supportsModelInvoke: () => true,
      runtimeModels: () => [],
      invokeModel: async () => {
        throw thrown;
      },
      acquireModelCall: async () => {
        throw thrown;
      },
    });
    const error = await gateway
      .invokeModel("computer", {
        tenantId: "t",
        ownerActorId: "o",
        agentId: "a",
        runtimeType: "codex",
        mode: "text",
        reasoningEffort: "low",
        queue: { priority: 40, kind: "memory", key: "k" },
        input: "x",
        timeoutMs: 1_000,
        signal: new AbortController().signal,
      })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ name: "ModelCallError", kind });
    if (kind === "computer_offline")
      expect(
        (error as Error).message.startsWith(COMPUTER_OFFLINE_MESSAGE),
      ).toBe(true);
  });
});

describe("Structured model invoke outcomes and interactive-isolated background breaker", () => {
  it("maps structured context_too_long outcome to invalid_request without wasting retries", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [
        {
          outcome: "context_too_long",
          reason: "Model invocation prompt exceeds the model context window",
          duration_ms: 12,
        },
      ],
    });
    await expect(
      modelCall.text({
        kind: "agent_memory",
        key: "agent-memory:overflow",
        placement: alice,
        input: "huge prompt",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
    expect(invokeModel).toHaveBeenCalledTimes(1);
  });

  it("backs off repeated background runtime_unavailable failures while admitting interactive approval and voice_ask calls", async () => {
    const { modelCall, invokeModel } = setup({
      placements: [alice],
      outcomes: [
        {
          outcome: "runtime_unavailable",
          reason: "local server down",
          duration_ms: 5,
        },
        {
          outcome: "runtime_unavailable",
          reason: "local server down",
          duration_ms: 5,
        },
        {
          outcome: "completed",
          text: "voice answer",
          model: "fixture",
          duration_ms: 5,
        },
        {
          outcome: "runtime_unavailable",
          reason: "local server down",
          duration_ms: 5,
        },
        {
          outcome: "runtime_unavailable",
          reason: "local server down",
          duration_ms: 5,
        },
        {
          outcome: "completed",
          text: "approved",
          model: "fixture",
          duration_ms: 5,
        },
        {
          outcome: "completed",
          text: "extracted",
          model: "fixture",
          duration_ms: 5,
        },
      ],
    });

    // Two background runtime_unavailable failures open the background breaker.
    await expect(
      modelCall.text({
        kind: "agent_memory",
        key: "bg:1",
        placement: alice,
        input: "a",
      }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await expect(
      modelCall.text({
        kind: "wiki",
        key: "bg:2",
        placement: alice,
        input: "b",
      }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(invokeModel).toHaveBeenCalledTimes(2);

    // Follow-up background call is backed off immediately without invoking the Daemon.
    await expect(
      modelCall.text({
        kind: "agent_memory",
        key: "bg:3",
        placement: alice,
        input: "c",
      }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(invokeModel).toHaveBeenCalledTimes(2);

    // Interactive voice_ask bypasses the open background breaker and succeeds.
    const voice = await modelCall.text({
      kind: "voice_ask",
      key: "voice:1",
      placement: alice,
      input: "status",
    });
    expect(voice.output).toBe("voice answer");
    expect(invokeModel).toHaveBeenCalledTimes(3);

    // Re-open the background breaker and verify interactive approval is also admitted.
    await expect(
      modelCall.text({
        kind: "agent_memory",
        key: "bg:4",
        placement: alice,
        input: "d",
      }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await expect(
      modelCall.text({
        kind: "wiki",
        key: "bg:5",
        placement: alice,
        input: "e",
      }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    await expect(
      modelCall.text({
        kind: "agent_memory",
        key: "bg:6",
        placement: alice,
        input: "f",
      }),
    ).rejects.toMatchObject({ kind: "runtime_unavailable" });
    expect(invokeModel).toHaveBeenCalledTimes(5);

    const approval = await modelCall.text({
      kind: "approval",
      key: "approval:1",
      placement: alice,
      input: "check",
    });
    expect(approval.output).toBe("approved");
    expect(invokeModel).toHaveBeenCalledTimes(6);

    // A successful interactive call resets the background breaker immediately.
    const bgAfterRecovery = await modelCall.text({
      kind: "agent_memory",
      key: "bg:7",
      placement: alice,
      input: "g",
    });
    expect(bgAfterRecovery.output).toBe("extracted");
    expect(invokeModel).toHaveBeenCalledTimes(7);
  });

  it("does not trip background breaker on structured unsupported outcomes", async () => {
    const piPlacement: ModelPlacement = { ...alice, runtimeType: "pi" };
    const { modelCall, invokeModel } = setup({
      placements: [piPlacement],
      outcomes: [
        {
          outcome: "unsupported",
          reason: "Pi background calls do not run file tools",
          duration_ms: 1,
        },
        {
          outcome: "unsupported",
          reason: "Pi background calls do not run file tools",
          duration_ms: 1,
        },
        {
          outcome: "completed",
          text: "ok",
          model: "localmodels/spark",
          duration_ms: 5,
        },
      ],
    });
    for (let i = 1; i <= 2; i += 1) {
      await expect(
        modelCall.workspace({
          kind: "wiki",
          key: `ws:${i}`,
          placement: piPlacement,
          input: "edit",
          files: [],
        }),
      ).rejects.toMatchObject({
        kind: "runtime_unavailable",
        runtimeOutcome: "unsupported",
      });
    }
    const textReply = await modelCall.text({
      kind: "agent_memory",
      key: "text:1",
      placement: piPlacement,
      input: "extract",
    });
    expect(textReply.output).toBe("ok");
    expect(invokeModel).toHaveBeenCalledTimes(3);
  });
});
