import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalModelsSnapshot } from "@linger/wire-contracts/runner-gateway/types";
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
const latency = (
  msPerThousand: number,
  source: "run" | "call" = "run",
  endedMsAgo = 0,
) => ({
  type: "latency" as const,
  source,
  latencyMs: msPerThousand * 4,
  endedMsAgo,
  workTokens: 4_000,
});
const callLatency = (msPerThousand: number) => latency(msPerThousand, "call");
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
      1,
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
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.routine, 1);
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
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.chat, 1);
    asked.mockClear();

    priority.raise(runPriorities.chat);
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.chat, 1);
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

  it("promotes confirmed concurrency only through silent background probes, never on interactive work alone", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 3 }),
      () => now,
    );
    // Interactive work alone stays at the confirmed limit of one.
    const chatA = await queue.acquire(codex, run("a"), signal);
    const chatB = track(queue.acquire(codex, run("b"), signal));
    for (let i = 0; i < 4; i++) {
      now += 10_000;
      queue.observe(codex, latency(500));
    }
    await flush();
    expect(chatB.value).toBeUndefined();
    chatA.release(done);
    await flush();
    chatB.value!.release(done);
    await flush();

    // Three lone background calls establish the baseline.
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("wiki", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }

    // Two waiting background calls trigger a silent probe for two and promote
    // once both stay within 1.3x of the baseline.
    const p1 = await queue.acquire(codex, call("wiki", "p1"), signal);
    const p2 = track(queue.acquire(codex, call("wiki", "p2"), signal));
    await flush();
    expect(p2.value).toBeDefined();
    now += 10_000;
    queue.observe(codex, callLatency(550));
    p1.release(done);
    queue.observe(codex, callLatency(580));
    p2.value!.release(done);
    await flush();

    // Confirmed limit is now two: background alone still leaves the last place
    // free for chat, and chat starts right alongside one running background call.
    const bg1 = await queue.acquire(codex, call("wiki", "s1"), signal);
    const bg2 = track(queue.acquire(codex, call("wiki", "s2"), signal));
    const chat = track(queue.acquire(codex, run("c"), signal));
    await flush();
    expect(bg2.value).toBeUndefined();
    expect(chat.value).toBeDefined();
    bg1.release(done);
    await flush();
    // While chat holds the single slot at confirmed limit 2, background waits.
    expect(bg2.value).toBeUndefined();
    chat.value!.release(done);
    await flush();
    expect(bg2.value).toBeDefined();
    bg2.value!.release(done);
  });

  it("fast-fails a slow probe and keeps confirmed concurrency at one for a single-concurrency endpoint", async () => {
    let now = 0;
    const asked = vi.fn();
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 4 }),
      () => now,
      asked,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("memory", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }

    // Probe for two starts with two background calls.
    const p1 = await queue.acquire(codex, call("memory", "p1"), signal);
    const p2 = track(queue.acquire(codex, call("memory", "p2"), signal));
    const p3 = track(queue.acquire(codex, call("memory", "p3"), signal));
    await flush();
    expect(p2.value).toBeDefined();
    expect(p3.value).toBeUndefined();

    // First sample > 1.8x fails the probe immediately without waiting for more.
    now += 20_000;
    queue.observe(codex, callLatency(1_000));
    p1.release(done);
    await flush();
    // p3 does not start while p2 drains because the probe failed back to one.
    expect(p3.value).toBeUndefined();
    p2.value!.release(done);
    await flush();
    expect(p3.value).toBeDefined();

    // Chat arriving while p3 runs sees confirmed limit 1 and asks p3 to yield.
    const chat = track(queue.acquire(codex, run("chat"), signal));
    await flush();
    expect(chat.value).toBeUndefined();
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.chat, 1);
  });

  it("records a ceiling on a two-call FIFO burst where the second call drains alone at mean 1.5", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 3 }),
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("memory", `b${i}`), signal);
      now += 3_000;
      queue.observe(codex, {
        type: "latency",
        source: "call",
        latencyMs: 3_000,
        endedMsAgo: 0,
        workTokens: 3_000,
      });
      bg.release(done);
    }

    // Two calls start together on a single-slot FIFO server: the first finishes
    // fast at t=3s (mean 2.0), the second waits 3s then runs alone 3s (mean 1.5, 2.0x).
    const p1 = await queue.acquire(codex, call("memory", "p1"), signal);
    const p2 = track(queue.acquire(codex, call("memory", "p2"), signal));
    await flush();
    expect(p2.value).toBeDefined();
    now += 3_000;
    queue.observe(codex, {
      type: "latency",
      source: "call",
      latencyMs: 3_000,
      endedMsAgo: 0,
      workTokens: 3_000,
    });
    p1.release(done);
    now += 3_000;
    queue.observe(codex, {
      type: "latency",
      source: "call",
      latencyMs: 6_000,
      endedMsAgo: 0,
      workTokens: 3_000,
    });
    p2.value!.release(done);
    await flush();

    // Ceiling 2 must be recorded so the very next burst does not immediately re-probe.
    const next1 = await queue.acquire(codex, call("memory", "n1"), signal);
    const next2 = track(queue.acquire(codex, call("memory", "n2"), signal));
    await flush();
    expect(next2.value).toBeUndefined();
    next1.release(done);
  });

  it("rejects a gray-zone probe (1.3x to 1.8x) so confirmed concurrency stays at one", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 3 }),
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("memory", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }

    const p1 = await queue.acquire(codex, call("memory", "p1"), signal);
    const p2 = track(queue.acquire(codex, call("memory", "p2"), signal));
    await flush();
    expect(p2.value).toBeDefined();
    // Both samples are 1.5x slower (between 1.3 and 1.8): probe fails.
    now += 15_000;
    queue.observe(codex, callLatency(750));
    p1.release(done);
    queue.observe(codex, callLatency(750));
    p2.value!.release(done);
    await flush();

    // Confirmed limit stays one: two chats serialize.
    const c1 = await queue.acquire(codex, run("c1"), signal);
    const c2 = track(queue.acquire(codex, run("c2"), signal));
    await flush();
    expect(c2.value).toBeUndefined();
    c1.release(done);
  });

  it("aborts a probe at once when interactive work arrives and asks all extra probing calls to yield", async () => {
    let now = 0;
    const asked = vi.fn();
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 3 }),
      () => now,
      asked,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("memory", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }

    const p1 = await queue.acquire(codex, call("memory", "p1"), signal);
    const p2 = track(queue.acquire(codex, call("memory", "p2"), signal));
    await flush();
    expect(p2.value).toBeDefined();

    // Interactive chat arrives mid-probe: both probing calls are asked to yield.
    const chat = track(queue.acquire(codex, run("chat"), signal));
    await flush();
    expect(chat.value).toBeUndefined();
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.chat, 2);

    p1.release(done);
    await flush();
    expect(chat.value).toBeUndefined();
    p2.value!.release(done);
    await flush();
    expect(chat.value).toBeDefined();
    chat.value!.release(done);
    await flush();

    // Aborting for interactive work sets no ceiling, so background can probe right after.
    const q1 = await queue.acquire(codex, call("memory", "q1"), signal);
    const q2 = track(queue.acquire(codex, call("memory", "q2"), signal));
    await flush();
    expect(q2.value).toBeDefined();
    q1.release(done);
    q2.value!.release(done);
  });

  it("aborts a probe and trims calls above the confirmed limit when a Task or compaction arrives", async () => {
    let now = 0;
    const asked = vi.fn();
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 3 }),
      () => now,
      asked,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("memory", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }

    const p1 = await queue.acquire(codex, call("memory", "p1"), signal);
    const p2 = track(queue.acquire(codex, call("memory", "p2"), signal));
    await flush();
    expect(p2.value).toBeDefined();

    // Task (priority 12) aborts the probe and trims the one excess probing call,
    // leaving one call at the confirmed limit of one.
    const task = track(
      queue.acquire(
        codex,
        { kind: "task", priority: runPriorities.task, key: "t1" },
        signal,
      ),
    );
    await flush();
    expect(task.value).toBeUndefined();
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.task, 1);

    asked.mockClear();
    p2.value!.release(done);
    await flush();
    // At the confirmed limit of one, Task waits for the remaining call without yielding it.
    expect(task.value).toBeUndefined();
    expect(asked).not.toHaveBeenCalled();

    p1.release(done);
    await flush();
    expect(task.value).toBeDefined();
    task.value!.release(done);
    await flush();

    // Promote confirmed limit to 2, then abort a probe for 3 with a Task:
    // steady-state cap at confirmed 2 is softLimit(2) = 1, so two excess
    // probing calls are trimmed and Task enters once the single remaining call finishes.
    const a1 = await queue.acquire(codex, call("memory", "a1"), signal);
    const a2 = track(queue.acquire(codex, call("memory", "a2"), signal));
    await flush();
    now += 10_000;
    queue.observe(codex, callLatency(500));
    a1.release(done);
    queue.observe(codex, callLatency(500));
    a2.value!.release(done);
    await flush();

    const r1 = await queue.acquire(codex, call("wiki", "r1"), signal);
    const r2 = track(queue.acquire(codex, call("wiki", "r2"), signal));
    const r3 = track(queue.acquire(codex, call("wiki", "r3"), signal));
    await flush();
    expect(r2.value).toBeDefined();
    expect(r3.value).toBeDefined();

    asked.mockClear();
    const task2 = track(
      queue.acquire(
        codex,
        { kind: "task", priority: runPriorities.task, key: "t2" },
        signal,
      ),
    );
    await flush();
    expect(task2.value).toBeUndefined();
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.task, 2);

    asked.mockClear();
    r3.value!.release(done);
    await flush();
    expect(asked).toHaveBeenLastCalledWith(codex, runPriorities.task, 1);

    asked.mockClear();
    r2.value!.release(done);
    await flush();
    expect(task2.value).toBeUndefined();
    expect(asked).not.toHaveBeenCalled();

    r1.release(done);
    await flush();
    expect(task2.value).toBeDefined();
    task2.value!.release(done);
  });

  it("scales past two on pure background work via sequential probes and skips probing when calls cannot yield", async () => {
    let now = 0;
    const cannotYield = new ModelQueue(
      () => ({ initial: 1, max: 4 }),
      () => now,
      undefined,
      undefined,
      () => false,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await cannotYield.acquire(
        codex,
        call("wiki", `n${i}`),
        signal,
      );
      now += 10_000;
      cannotYield.observe(codex, callLatency(500));
      bg.release(done);
    }
    const n1 = await cannotYield.acquire(codex, call("wiki", "x1"), signal);
    const n2 = track(cannotYield.acquire(codex, call("wiki", "x2"), signal));
    await flush();
    expect(n2.value).toBeUndefined();
    n1.release(done);

    // When background calls can yield, pure background probes 1 -> 2 -> 3.
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 4 }),
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("wiki", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }
    // Probe 2 passes.
    const w1 = await queue.acquire(codex, call("wiki", "w1"), signal);
    const w2 = track(queue.acquire(codex, call("wiki", "w2"), signal));
    await flush();
    expect(w2.value).toBeDefined();
    now += 10_000;
    queue.observe(codex, callLatency(520));
    w1.release(done);
    queue.observe(codex, callLatency(520));
    w2.value!.release(done);
    await flush();

    // Probe 3 starts with three background calls and passes.
    const t1 = await queue.acquire(codex, call("wiki", "t1"), signal);
    const t2 = track(queue.acquire(codex, call("wiki", "t2"), signal));
    const t3 = track(queue.acquire(codex, call("wiki", "t3"), signal));
    await flush();
    expect(t2.value).toBeDefined();
    expect(t3.value).toBeDefined();
    now += 10_000;
    queue.observe(codex, callLatency(540));
    t1.release(done);
    queue.observe(codex, callLatency(540));
    t2.value!.release(done);
    queue.observe(codex, callLatency(540));
    t3.value!.release(done);
    await flush();

    // Confirmed limit is now 3: three interactive Runs start at once.
    const r1 = await queue.acquire(codex, run("r1"), signal);
    const r2 = track(queue.acquire(codex, run("r2"), signal));
    const r3 = track(queue.acquire(codex, run("r3"), signal));
    await flush();
    expect(r2.value).toBeDefined();
    expect(r3.value).toBeDefined();
    r1.release(done);
    r2.value!.release(done);
    r3.value!.release(done);
  });

  it("gives a place back when confirmed concurrency slows down and halves it when refused", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 2, max: 8 }),
      () => now,
    );
    // Establish run baseline at concurrency 1.
    const first = await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      queue.observe(codex, latency(500));
    }
    const second = await queue.acquire(codex, run("b"), signal);
    // Two at once take three times as long: back to one.
    for (let i = 0; i < 4; i++) {
      now += 10_000;
      queue.observe(codex, latency(1_500));
    }
    first.release(done);
    const third = track(queue.acquire(codex, run("c"), signal));
    await flush();
    expect(third.value).toBeUndefined();

    second.release(done);
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

  it("judges a lower limit only once the units above it have finished, placing each Run sample by when it was timed", async () => {
    let now = 0;
    const queue = new ModelQueue(
      () => ({ initial: 3, max: 4 }),
      () => now,
    );
    const a = await queue.acquire(codex, run("a"), signal);
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      queue.observe(codex, latency(500));
    }
    const b = await queue.acquire(codex, run("b"), signal);
    const c = await queue.acquire(codex, run("c"), signal);
    // A late-reporting Run timed before b and c started does not count at 3.
    now += 10_000;
    queue.observe(codex, latency(1_500, "run", 10_000));
    // Three at once are slow: drops to two. Three still run, so later slow
    // samples at concurrency 3 say nothing about two.
    for (let i = 0; i < 8; i++) {
      now += 10_000;
      queue.observe(codex, latency(1_500));
    }
    a.release(done);
    b.release(done);
    const d = track(queue.acquire(codex, run("d"), signal));
    await flush();
    expect(d.value).toBeDefined();
    c.release(done);
    d.value!.release(done);
  });

  it("keeps a failed probe as the ceiling and retries it later, waiting longer after each failed retry", async () => {
    let now = 0;
    const minutes = (count: number) => (now += count * 60_000);
    const seconds = (count: number) => (now += count * 1_000);
    const queue = new ModelQueue(
      () => ({ initial: 1, max: 4 }),
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("wiki", `b${i}`), signal);
      seconds(10);
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }

    // First probe of two is slow -> ceiling = 2, wait 5 minutes.
    const a = await queue.acquire(codex, call("wiki", "a"), signal);
    const b = track(queue.acquire(codex, call("wiki", "b"), signal));
    await flush();
    expect(b.value).toBeDefined();
    seconds(10);
    queue.observe(codex, callLatency(1_500));
    a.release(done);
    b.value!.release(done);
    await flush();

    // Before five minutes, waiting background calls stay at one.
    const c1 = await queue.acquire(codex, call("wiki", "c1"), signal);
    const c2 = track(queue.acquire(codex, call("wiki", "c2"), signal));
    await flush();
    expect(c2.value).toBeUndefined();
    minutes(5);
    seconds(10);
    queue.observe(codex, callLatency(500));
    await flush();
    expect(c2.value).toBeDefined();

    // Retry fails too: the next retry waits ten minutes.
    seconds(10);
    queue.observe(codex, callLatency(1_500));
    c1.release(done);
    c2.value!.release(done);
    await flush();

    const d1 = await queue.acquire(codex, call("wiki", "d1"), signal);
    const d2 = track(queue.acquire(codex, call("wiki", "d2"), signal));
    minutes(5);
    seconds(10);
    queue.observe(codex, callLatency(500));
    await flush();
    expect(d2.value).toBeUndefined();
    minutes(5);
    seconds(10);
    queue.observe(codex, callLatency(500));
    await flush();
    expect(d2.value).toBeDefined();

    // This retry holds: ceiling clears, confirmed becomes 2, and 3 can be probed.
    seconds(10);
    queue.observe(codex, callLatency(500));
    d1.release(done);
    queue.observe(codex, callLatency(500));
    d2.value!.release(done);
    await flush();

    const e1 = await queue.acquire(codex, call("wiki", "e1"), signal);
    const e2 = track(queue.acquire(codex, call("wiki", "e2"), signal));
    const e3 = track(queue.acquire(codex, call("wiki", "e3"), signal));
    await flush();
    expect(e2.value).toBeDefined();
    expect(e3.value).toBeDefined();
    e1.release(done);
    e2.value!.release(done);
    e3.value!.release(done);
  });

  it("keeps a learned limit while the endpoint is idle and starts over when its link changes", async () => {
    let now = 0;
    let range = { initial: 1, max: 4 };
    const queue = new ModelQueue(
      () => range,
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(codex, call("wiki", `b${i}`), signal);
      now += 10_000;
      queue.observe(codex, callLatency(500));
      bg.release(done);
    }
    const first = await queue.acquire(codex, call("wiki", "p1"), signal);
    const second = track(queue.acquire(codex, call("wiki", "p2"), signal));
    await flush();
    now += 10_000;
    queue.observe(codex, callLatency(500));
    first.release(done);
    queue.observe(codex, callLatency(500));
    second.value!.release(done);
    await flush();

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

  it("refreshes waiters when refreshEndpoint raises endpoint concurrency and skips background probing when fixed at 1", async () => {
    const minutes = (n: number) => vi.advanceTimersByTime(n * 60_000);
    const seconds = (n: number) => vi.advanceTimersByTime(n * 1_000);
    const pi: ModelEndpoint = { computerId: "runner-local", runtimeType: "pi" };
    let range = { initial: 1, max: 1 };
    const queue = new ModelQueue(
      () => range,
      () => Date.now(),
    );

    // Fast background calls with fixed range { initial: 1, max: 1 } never probe above 1.
    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(pi, call("wiki", `b${i}`), signal);
      seconds(10);
      queue.observe(pi, callLatency(200));
      bg.release(done);
    }

    const first = await queue.acquire(pi, call("wiki", "w1"), signal);
    const second = track(queue.acquire(pi, run("r2"), signal));
    await flush();
    expect(second.value).toBeUndefined();

    // Even after waiting longer than probe idle time, probing remains disabled when max is 1.
    minutes(1);
    expect(second.value).toBeUndefined();

    // Once probed concurrency rises to 2 and refreshEndpoint fires, interactive waiter is admitted at once.
    range = { initial: 2, max: 8 };
    queue.refreshEndpoint(pi);
    await flush();
    expect(second.value).toBeDefined();
    first.release(done);
    second.value!.release(done);
  });

  it("grows adaptively above probed concurrency 2 and preserves learned limit while another model loads", async () => {
    const seconds = (n: number) => vi.advanceTimersByTime(n * 1_000);
    const pi: ModelEndpoint = { computerId: "runner-local", runtimeType: "pi" };
    const piModelA = "localmodels-library/qwen3/Qwen3-4B";
    const piModelB = "localmodels-library/qwen3/Qwen3-8B";
    let snapshot = localModelsSnapshot([
      baseModel({ pi_model: piModelA, state: "loaded", concurrency: 2 }),
      baseModel({
        id: "qwen3-8b:Q4_K_M",
        pi_model: piModelB,
        state: "idle",
      }),
    ]);
    const queue = new ModelQueue(
      () =>
        endpointConcurrency(
          [
            { id: piModelA, link: "api", concurrency: 2 },
            { id: piModelB, link: "api" },
          ],
          snapshot,
        ),
      () => Date.now(),
    );

    for (let i = 0; i < 3; i++) {
      const bg = await queue.acquire(pi, call("wiki", `b${i}`), signal);
      seconds(10);
      queue.observe(pi, callLatency(500));
      bg.release(done);
    }

    // Probe 3 starts immediately from initial=2 and promotes confirmed limit to 3.
    const p1 = await queue.acquire(pi, call("wiki", "p1"), signal);
    const p2 = track(queue.acquire(pi, call("wiki", "p2"), signal));
    const p3 = track(queue.acquire(pi, call("wiki", "p3"), signal));
    await flush();
    expect(p2.value).toBeDefined();
    expect(p3.value).toBeDefined();
    seconds(10);
    queue.observe(pi, callLatency(520));
    p1.release(done);
    queue.observe(pi, callLatency(520));
    p2.value!.release(done);
    queue.observe(pi, callLatency(520));
    p3.value!.release(done);
    await flush();

    // Loading a second model does not change the range or reset learned concurrency 3.
    snapshot = localModelsSnapshot([
      baseModel({ pi_model: piModelA, state: "loaded", concurrency: 2 }),
      baseModel({
        id: "qwen3-8b:Q4_K_M",
        pi_model: piModelB,
        state: "loading",
        concurrency_probing: true,
      }),
    ]);
    queue.refreshEndpoint(pi);

    const r1 = await queue.acquire(pi, run("r1"), signal);
    const r2 = track(queue.acquire(pi, run("r2"), signal));
    const r3 = track(queue.acquire(pi, run("r3"), signal));
    await flush();
    expect(r2.value).toBeDefined();
    expect(r3.value).toBeDefined();
    r1.release(done);
    r2.value!.release(done);
    r3.value!.release(done);
  });
});

const localModelsSnapshot = (
  models: LocalModelsSnapshot["models"],
): LocalModelsSnapshot => ({
  available: true,
  observed_at: "2026-11-24T00:00:00.000Z",
  pools: [],
  models,
});

const baseModel = (
  overrides: Partial<LocalModelsSnapshot["models"][number]>,
): LocalModelsSnapshot["models"][number] => ({
  id: "qwen3-4b:Q4_K_M",
  name: "Qwen3 4B",
  description: "",
  quant: "Q4_K_M",
  context_tokens: 32_768,
  vision: false,
  download_bytes: 4_000,
  memory_bytes: 5_000,
  fit: "gpu",
  recommended: false,
  availability: { downloadable: true },
  state: "loaded",
  ...overrides,
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

  it("caps single-slot verified models at 1, allows adaptive growth from 2, and leaves loaded concurrency intact while another model loads", () => {
    const piModel = "localmodels-library/qwen3/Qwen3-4B";
    expect(
      endpointConcurrency([{ id: piModel, link: "api", concurrency: 2 }]),
    ).toEqual({ initial: 2, max: 8 });
    expect(
      endpointConcurrency([
        { id: piModel, link: "api", concurrency: 2 },
        { id: "other", link: "api", concurrency: 1 },
      ]),
    ).toEqual({ initial: 1, max: 1 });

    const probingSnapshot = localModelsSnapshot([
      baseModel({
        pi_model: piModel,
        state: "loading",
        concurrency_probing: true,
      }),
    ]);
    expect(
      endpointConcurrency([{ id: piModel, link: "api" }], probingSnapshot),
    ).toEqual({ initial: 1, max: 8 });
    expect(
      endpointConcurrency(
        [{ id: "byok/gpt-4o", link: "api" }],
        probingSnapshot,
      ),
    ).toEqual({ initial: 1, max: 8 });
    expect(endpointConcurrency(undefined, probingSnapshot)).toEqual({
      initial: 1,
      max: 8,
    });

    const mixedSnapshot = localModelsSnapshot([
      baseModel({
        pi_model: piModel,
        state: "loaded",
        concurrency: 2,
      }),
      baseModel({
        id: "qwen3-8b:Q4_K_M",
        pi_model: "localmodels-library/qwen3/Qwen3-8B",
        state: "loading",
      }),
    ]);
    expect(
      endpointConcurrency(
        [
          { id: piModel, link: "api", concurrency: 2 },
          { id: "localmodels-library/qwen3/Qwen3-8B", link: "api" },
        ],
        mixedSnapshot,
      ),
    ).toEqual({ initial: 2, max: 8 });
    expect(endpointConcurrency(undefined, mixedSnapshot)).toEqual({
      initial: 2,
      max: 8,
    });

    const loadedTwoSnapshot = localModelsSnapshot([
      baseModel({
        pi_model: piModel,
        state: "loaded",
        concurrency: 2,
      }),
    ]);
    expect(endpointConcurrency(undefined, loadedTwoSnapshot)).toEqual({
      initial: 2,
      max: 8,
    });

    const legacyLoadedSnapshot = localModelsSnapshot([
      baseModel({
        pi_model: piModel,
        state: "loaded",
      }),
    ]);
    expect(
      endpointConcurrency([{ id: piModel, link: "api" }], legacyLoadedSnapshot),
    ).toEqual({ initial: 1, max: 8 });
  });
});
