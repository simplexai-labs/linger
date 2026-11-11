import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  endpointConcurrency,
  ModelQueue,
  type ModelEndpoint,
  type ModelLease,
} from "../../../src/agent/runner-gateway/model-queue.js";
import {
  COMPACTION_PRIORITY,
  modelCallPolicies,
  RUN_PRIORITY,
  type ModelCallKind,
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
const run = (key = "run") => ({ priority: RUN_PRIORITY, kind: "chat", key });
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
/** One finished Run request: so many ms per thousand prompt tokens. */
const latency = (msPerThousand: number) => ({
  type: "latency" as const,
  source: "run" as const,
  latencyMs: msPerThousand * 4,
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

    // The retry is slow too: the next one waits ten minutes.
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

    // This retry holds: the ceiling is gone and the limit grows past it.
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
