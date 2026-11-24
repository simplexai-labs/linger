import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endpointConcurrency,
  INTERACTIVE_STALL_MS,
  ModelQueue,
  type ModelEndpoint,
} from "../../../src/agent/runner-gateway/model-queue.js";
import { setAgentLogOptions } from "../../../src/agent/observability/agent-log.js";
import {
  COMPACTION_PRIORITY,
  modelCallPolicies,
  runPriorities,
  RunPriority,
  type ModelCallKind,
  type ModelLease,
} from "../../../src/model-tasks.js";

const codex: ModelEndpoint = {
  computerId: "runner-local",
  runtimeType: "codex",
};
const claude: ModelEndpoint = {
  computerId: "runner-local",
  runtimeType: "claude",
};
const done = { outcome: "completed" };

const call = (kind: ModelCallKind, key: string = kind) => ({
  priority: modelCallPolicies[kind].priority,
  kind,
  key,
});
const run = (key = "run") => ({
  priority: runPriorities.chat,
  kind: "chat",
  key,
});
const compaction = {
  priority: COMPACTION_PRIORITY,
  kind: "compaction",
  key: "context",
};

/** Tracks whether an acquire has resolved without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: { value?: T; error?: unknown } = {};
  void promise.then(
    (value) => (state.value = value),
    (error: unknown) => (state.error = error),
  );
  return state;
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const fixed = (limit: number) => ({ initial: limit, max: limit });
/** One finished Run request: so many ms per thousand prompt tokens. Time
 * stands still, so it is judged by the units running when it reports. */
const latency = (msPerThousand: number) => ({
  type: "latency" as const,
  source: "run" as const,
  latencyMs: msPerThousand * 4,
  endedMsAgo: 0,
  workTokens: 4_000,
});
const signal = new AbortController().signal;

describe("ModelQueue", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts queued units by priority, then arrival, one at a time on a gateway endpoint", async () => {
    const queue = new ModelQueue(() => fixed(1));
    const first = await queue.acquire(codex, call("wiki", "w1"), signal);
    const wiki = track(queue.acquire(codex, call("wiki", "w2"), signal));
    const memory = track(queue.acquire(codex, call("memory"), signal));
    const pack = track(queue.acquire(codex, compaction, signal));
    const chat = track(queue.acquire(codex, run(), signal));
    await flush();
    expect([wiki, memory, pack, chat].map(({ value }) => value)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);

    // A running unit is never interrupted; the Run goes next.
    first.release(done);
    await flush();
    expect(chat.value).toBeDefined();
    expect(pack.value).toBeUndefined();

    for (const [next, after] of [
      [chat, pack],
      [pack, memory],
      [memory, wiki],
    ] as const) {
      next.value!.release(done);
      await flush();
      expect(after.value).toBeDefined();
    }
  });

  it("runs as many units at once as the endpoint's concurrency, each endpoint on its own", async () => {
    const queue = new ModelQueue((endpoint) =>
      fixed(endpoint.runtimeType === "claude" ? 2 : 1),
    );
    await queue.acquire(codex, run("a"), signal);
    const codexWaits = track(queue.acquire(codex, run("b"), signal));
    const both = [
      track(queue.acquire(claude, run("c"), signal)),
      track(queue.acquire(claude, run("d"), signal)),
    ];
    const third = track(queue.acquire(claude, call("wiki"), signal));
    await flush();
    expect(codexWaits.value).toBeUndefined();
    expect(both.every(({ value }) => value)).toBe(true);
    expect(third.value).toBeUndefined();
  });

  it("drops a waiter whose caller stops waiting", async () => {
    const queue = new ModelQueue(() => fixed(1));
    const first = await queue.acquire(codex, call("memory"), signal);
    const stop = new AbortController();
    const dropped = track(queue.acquire(codex, call("memory"), stop.signal));
    const kept = track(queue.acquire(codex, call("wiki"), signal));
    stop.abort(new Error("caller left"));
    await flush();
    expect(dropped.error).toEqual(new Error("caller left"));

    first.release(done);
    await flush();
    expect(kept.value).toBeDefined();
  });

  it("rejects every waiter of a Computer that disconnects", async () => {
    const queue = new ModelQueue(() => fixed(1));
    await queue.acquire(codex, call("memory"), signal);
    await queue.acquire(claude, call("memory"), signal);
    const waiting = [
      track(queue.acquire(codex, run(), signal)),
      track(queue.acquire(claude, compaction, signal)),
    ];
    queue.rejectWaiters(codex.computerId, new Error("offline"));
    await flush();
    expect(waiting.map(({ error }) => error)).toEqual([
      new Error("offline"),
      new Error("offline"),
    ]);
  });

  it("frees a place once however often it is released", async () => {
    const queue = new ModelQueue(() => fixed(1));
    const first: ModelLease = await queue.acquire(codex, run(), signal);
    const second = track(queue.acquire(codex, call("wiki"), signal));
    const third = track(queue.acquire(codex, call("wiki"), signal));
    first.release(done);
    first.release(done);
    await flush();
    expect(second.value).toBeDefined();
    expect(third.value).toBeUndefined();
  });
});

describe("ModelQueue limit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("leaves the last place to a Run once background work could take it", async () => {
    const queue = new ModelQueue(() => fixed(2));
    await queue.acquire(codex, call("wiki", "w1"), signal);
    const wiki = track(queue.acquire(codex, call("wiki", "w2"), signal));
    const chat = track(queue.acquire(codex, run(), signal));
    await flush();
    expect(wiki.value).toBeUndefined();
    expect(chat.value).toBeDefined();

    // With one place, background work still runs.
    const single = new ModelQueue(() => fixed(1));
    expect(await single.acquire(claude, call("wiki"), signal)).toBeDefined();
  });

  it("admits only interactive work above soft, including when chat occupies an ordinary place", async () => {
    const queue = new ModelQueue(() => fixed(3));
    const routine = await queue.acquire(
      codex,
      { kind: "routine", priority: runPriorities.routine, key: "r" },
      signal,
    );
    const chat = await queue.acquire(codex, run(), signal);
    const task = track(
      queue.acquire(
        codex,
        { kind: "task", priority: runPriorities.task, key: "t" },
        signal,
      ),
    );
    const doc = track(
      queue.acquire(
        codex,
        { kind: "document", priority: runPriorities.document, key: "d" },
        signal,
      ),
    );
    const ask = await queue.acquire(codex, call("voice_ask"), signal);
    const next = track(queue.acquire(codex, run(), signal));
    await flush();
    expect([task.value, doc.value, next.value]).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    ask.release(done);
    await flush();
    expect(next.value).toBeDefined();
    chat.release(done);
    await flush();
    expect(task.value).toBeUndefined();
    routine.release(done);
    await flush();
    expect(task.value).toBeDefined();
    expect(doc.value).toBeUndefined();
  });

  it("asks a lower Run to yield whenever interactive work first in line cannot start", async () => {
    const asked = vi.fn();
    const queue = new ModelQueue(() => fixed(2), Date.now, asked);
    const task = await queue.acquire(
      codex,
      { kind: "task", priority: runPriorities.task, key: "t" },
      signal,
    );
    const chat = await queue.acquire(codex, run(), signal);
    const wiki = track(queue.acquire(codex, call("wiki"), signal));
    await flush();
    expect(asked).not.toHaveBeenCalled();
    const notes = track(queue.acquire(codex, call("meeting_notes"), signal));
    await flush();
    expect(asked).toHaveBeenLastCalledWith(
      codex,
      modelCallPolicies.meeting_notes.priority,
    );
    task.release(done);
    await flush();
    expect(notes.value).toBeDefined();
    expect(wiki.value).toBeUndefined();
    asked.mockClear();
    notes.value!.release(done);
    chat.release(done);
    await flush();
    expect(wiki.value).toBeDefined();
    expect(asked).not.toHaveBeenCalled();
  });

  it("lets every Meta Run take the last place before Tasks and Documents", async () => {
    const asked = vi.fn();
    const queue = new ModelQueue(() => fixed(2), Date.now, asked);
    await queue.acquire(
      codex,
      { kind: "task", priority: runPriorities.task, key: "t1" },
      signal,
    );
    const task = track(
      queue.acquire(
        codex,
        { kind: "task", priority: runPriorities.task, key: "t2" },
        signal,
      ),
    );
    const followUp = track(
      queue.acquire(
        codex,
        { kind: "follow_up", priority: runPriorities.follow_up, key: "f" },
        signal,
      ),
    );
    await flush();
    expect(task.value).toBeUndefined();
    expect(followUp.value).toBeDefined();
    const routine = track(
      queue.acquire(
        codex,
        { kind: "routine", priority: runPriorities.routine, key: "r" },
        signal,
      ),
    );
    await flush();
    expect(routine.value).toBeUndefined();
    // Waiting Meta work asks for a yield; only a lower Run gives one.
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.routine);
  });

  it("moves a waiting Run up when its priority rises, in arrival order within it", async () => {
    const asked = vi.fn();
    const queue = new ModelQueue(() => fixed(1), Date.now, asked);
    const holder = await queue.acquire(
      codex,
      { kind: "proactive", priority: runPriorities.proactive, key: "p" },
      signal,
    );
    const routine = track(
      queue.acquire(
        codex,
        { kind: "routine", priority: runPriorities.routine, key: "r" },
        signal,
      ),
    );
    const priority = new RunPriority(runPriorities.follow_up);
    const followUp = track(
      queue.acquire(codex, { kind: "follow_up", priority, key: "f" }, signal),
    );
    const chat = track(queue.acquire(codex, run("c"), signal));
    await flush();
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.chat);
    asked.mockClear();

    priority.raise(runPriorities.chat);
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.chat);
    holder.release(done);
    await flush();
    expect(followUp.value).toBeDefined();
    expect([routine.value, chat.value]).toEqual([undefined, undefined]);
    followUp.value!.release(done);
    await flush();
    expect(chat.value).toBeDefined();
    expect(routine.value).toBeUndefined();

    // A raise after admission changes nothing in the queue.
    priority.raise(0);
    chat.value!.release(done);
    await flush();
    expect(routine.value).toBeDefined();
  });

  it("logs once who holds the places when interactive work waits too long", async () => {
    vi.stubEnv("AGENT_LOG_LEVEL", "info");
    setAgentLogOptions({ format: "json" });
    const output = vi.spyOn(console, "warn").mockImplementation(() => {});
    const holders = [{ operation_id: "op-task", yield_blocker: "interaction" }];
    const queue = new ModelQueue(
      () => fixed(1),
      Date.now,
      () => undefined,
      () => holders,
    );
    try {
      const task = await queue.acquire(
        codex,
        { kind: "task", priority: runPriorities.task, key: "t" },
        signal,
      );
      const priority = new RunPriority(runPriorities.task);
      const waiting = track(
        queue.acquire(codex, { kind: "task", priority, key: "w" }, signal),
      );
      await vi.advanceTimersByTimeAsync(INTERACTIVE_STALL_MS);
      const stalls = () =>
        output.mock.calls
          .map(([line]) => JSON.parse(String(line)))
          .filter((entry) => entry.event === "model_queue.interactive_waiting");
      expect(stalls()).toEqual([]);
      priority.raise(runPriorities.chat);
      await vi.advanceTimersByTimeAsync(INTERACTIVE_STALL_MS * 3);
      expect(stalls()).toEqual([
        expect.objectContaining({
          kind: "task",
          priority: runPriorities.chat,
          waited_ms: INTERACTIVE_STALL_MS * 2,
          active: 1,
          holders,
        }),
      ]);
      task.release(done);
      await flush();
      waiting.value!.release(done);
    } finally {
      setAgentLogOptions();
      vi.unstubAllEnvs();
      output.mockRestore();
    }
  });

  it("tries one more unit while work waits and requests stay as fast", async () => {
    const queue = new ModelQueue(() => ({ initial: 1, max: 3 }));
    await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(500));
    // Nothing waited, so nothing showed a second place was needed.
    const waiting = track(queue.acquire(codex, run("b"), signal));
    await flush();
    expect(waiting.value).toBeUndefined();

    queue.observe(codex, latency(520));
    await flush();
    expect(waiting.value).toBeDefined();
  });

  it("does not raise a limit on background work running alone under it", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 3 }),
      () => now,
    );
    const alone = {
      type: "latency" as const,
      source: "call" as const,
      latencyMs: 10_000,
      endedMsAgo: 0,
      workTokens: 4_000,
    };
    let running = await queue.acquire(codex, call("wiki", "w0"), signal);
    for (let i = 1; i <= 12; i++) {
      const next = track(queue.acquire(codex, call("wiki", `w${i}`), signal));
      now += 10_000;
      queue.observe(codex, alone);
      await flush();
      // Two places leave background work one; three would start the next.
      expect(next.value).toBeUndefined();
      running.release(done);
      await flush();
      running = next.value!;
    }
    // Calls alone did try two, whose last place chat can take.
    const chat = track(queue.acquire(codex, run(), signal));
    await flush();
    expect(chat.value).toBeDefined();
  });

  it("raises a limit once requests that ran at it stay as fast, each placed by when it was timed", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 2, max: 3 }),
      () => now,
    );
    const request = (endedMsAgo = 0) => ({
      type: "latency" as const,
      source: "run" as const,
      latencyMs: 10_000,
      endedMsAgo,
      workTokens: 4_000,
    });
    await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      queue.observe(codex, request());
    }
    await queue.acquire(codex, run("b"), signal);
    const c = track(queue.acquire(codex, run("c"), signal));
    // Its first item came before b started, though it reports after.
    now += 10_000;
    queue.observe(codex, request(10_000));
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      queue.observe(codex, request());
    }
    await flush();
    expect(c.value).toBeUndefined();
    now += 10_000;
    queue.observe(codex, request());
    await flush();
    expect(c.value).toBeDefined();
  });

  it("gives a place back when requests slow down and halves it when refused", async () => {
    const queue = new ModelQueue(() => ({ initial: 1, max: 8 }));
    const first = await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) queue.observe(codex, latency(500));
    const second = track(queue.acquire(codex, run("b"), signal));
    queue.observe(codex, latency(500));
    await flush();
    expect(second.value).toBeDefined();

    // Two at once take three times as long: back to one.
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(1_500));
    first.release(done);
    const third = track(queue.acquire(codex, run("c"), signal));
    await flush();
    expect(third.value).toBeUndefined();

    second.value!.release(done);
    await flush();
    expect(third.value).toBeDefined();

    const busy = new ModelQueue(() => fixed(10));
    const held = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        busy.acquire(claude, run(`h${i}`), signal),
      ),
    );
    busy.observe(claude, { type: "overload" });
    const refused = track(busy.acquire(claude, run("r"), signal));
    await flush();
    // Halved to five, all of them running.
    expect(refused.value).toBeUndefined();
    held[0]!.release(done);
    await flush();
    expect(refused.value).toBeDefined();
  });

  it("judges a lower limit only once the units above it have finished", async () => {
    const queue = new ModelQueue(() => ({ initial: 1, max: 4 }));
    const a = await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) queue.observe(codex, latency(500));
    const b = track(queue.acquire(codex, run("b"), signal));
    queue.observe(codex, latency(500));
    const c = track(queue.acquire(codex, run("c"), signal));
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(500));
    await flush();
    expect(c.value).toBeDefined();

    // Three at once are slow: two. Three still run, so their slow requests
    // say nothing about two.
    for (let i = 0; i < 8; i++) queue.observe(codex, latency(1_500));
    a.release(done);
    b.value!.release(done);
    const d = track(queue.acquire(codex, run("d"), signal));
    await flush();
    expect(d.value).toBeDefined();
  });

  it("keeps a limit it came down from as the ceiling and retries it later, waiting longer after each failed retry", async () => {
    let now = 0;
    const minutes = (count: number) => (now += count * 60_000);
    const seconds = (count: number) => (now += count * 1_000);
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 4 }),
      () => now,
    );
    const a = await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) queue.observe(codex, latency(500));
    const b = track(queue.acquire(codex, run("b"), signal));
    queue.observe(codex, latency(500));
    await flush();
    expect(b.value).toBeDefined();
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(1_500));
    a.release(done);

    // One unit running looks fast, but two were just too slow.
    const c = track(queue.acquire(codex, run("c"), signal));
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(500));
    await flush();
    expect(c.value).toBeUndefined();
    minutes(5);
    queue.observe(codex, latency(500));
    await flush();
    expect(c.value).toBeDefined();

    // Both run a while and the retry is slow too: the next one waits ten
    // minutes.
    seconds(10);
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(1_500));
    b.value!.release(done);
    const d = track(queue.acquire(codex, run("d"), signal));
    minutes(5);
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(500));
    await flush();
    expect(d.value).toBeUndefined();
    minutes(5);
    queue.observe(codex, latency(500));
    await flush();
    expect(d.value).toBeDefined();

    // Both run a while and this retry holds: the ceiling is gone and the
    // limit grows past it.
    seconds(10);
    const e = track(queue.acquire(codex, run("e"), signal));
    for (let i = 0; i < 4; i++) queue.observe(codex, latency(500));
    await flush();
    expect(e.value).toBeDefined();
  });

  it("keeps a learned limit while the endpoint is idle and starts over when its link changes", async () => {
    let range = { initial: 1, max: 4 };
    const queue = new ModelQueue(() => range);
    const first = await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) queue.observe(codex, latency(500));
    const second = track(queue.acquire(codex, run("b"), signal));
    queue.observe(codex, latency(500));
    await flush();
    first.release(done);
    second.value!.release(done);

    const again = await queue.acquire(codex, run("c"), signal);
    const alongside = track(queue.acquire(codex, run("d"), signal));
    await flush();
    expect(alongside.value).toBeDefined();
    again.release(done);
    alongside.value!.release(done);

    range = { initial: 1, max: 8 };
    await queue.acquire(codex, run("e"), signal);
    const reset = track(queue.acquire(codex, run("f"), signal));
    await flush();
    expect(reset.value).toBeUndefined();
  });
});

describe("endpointConcurrency", () => {
  it("starts high only when every model is on the signed-in account", () => {
    const subscription = { initial: 10, max: 10 };
    const api = { initial: 1, max: 8 };
    expect(
      endpointConcurrency([{ link: "subscription" }, { link: "subscription" }]),
    ).toEqual(subscription);
    expect(
      endpointConcurrency([{ link: "subscription" }, { link: "api" }]),
    ).toEqual(api);
    expect(endpointConcurrency([{}])).toEqual(api);
    expect(endpointConcurrency([])).toEqual(api);
    expect(endpointConcurrency(undefined)).toEqual(api);
  });
});
