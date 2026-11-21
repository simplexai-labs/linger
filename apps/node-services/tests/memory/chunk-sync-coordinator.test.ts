import { describe, expect, it, vi } from "vitest";
import { setImmediate } from "node:timers/promises";
import { ChunkSyncCoordinator } from "../../src/memory/chunk-sync-coordinator.js";

describe("ChunkSyncCoordinator", () => {
  it("keeps a failed snapshot exclusive until its active source writes finish", async () => {
    const coordinator = new ChunkSyncCoordinator(2);
    const failure = new Error("source could not be read");
    const fail = deferred();
    const finish = deferred();
    const events: string[] = [];
    let settled = false;
    const first = coordinator.runAgent("agent_a", "raw", () =>
      coordinator.mapSources([0, 1, 2], async (source) => {
        events.push(`source:${source}:start`);
        if (source === 0) {
          await fail.promise;
          throw failure;
        }
        await finish.promise;
        events.push(`source:${source}:write`);
        return source;
      }),
    );
    const observed = first.catch((error: unknown) => {
      settled = true;
      return error;
    });
    const next = coordinator.runAgent("agent_a", "raw", async () => {
      events.push("next:snapshot");
    });
    fail.resolve();
    await setImmediate();
    try {
      expect(settled).toBe(false);
      expect(events).not.toContain("next:snapshot");
    } finally {
      finish.resolve();
      await next;
      await coordinator.idle();
    }
    expect(await observed).toBe(failure);
    expect(events).toEqual([
      "source:0:start",
      "source:1:start",
      "source:1:write",
      "next:snapshot",
    ]);
  });

  it("preserves even an undefined rejection after other sources drain", async () => {
    const coordinator = new ChunkSyncCoordinator(2);
    const finish = deferred();
    const observed = coordinator
      .mapSources([0, 1, 2], async (source) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Rejection values can be absent at this boundary.
        if (source === 0) return Promise.reject(undefined);
        await finish.promise;
        return source;
      })
      .then(
        () => ({ status: "fulfilled" }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
    finish.resolve();
    expect(await observed).toEqual({ status: "rejected", reason: undefined });
  });

  it("serializes one Agent, coalesces duplicate triggers and runs other Agents concurrently", async () => {
    const coordinator = new ChunkSyncCoordinator(4);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const events: string[] = [];
    const first = coordinator.runAgent("agent_a", "full", async () => {
      events.push("a1:start");
      await firstGate;
      events.push("a1:end");
      return "a1";
    });
    const duplicate = coordinator.runAgent("agent_a", "full", async () => {
      events.push("a1:followup");
      return "a1-new";
    });
    const duplicateAgain = coordinator.runAgent("agent_a", "full", async () => {
      throw new Error("pending duplicate must be coalesced");
    });
    const second = coordinator.runAgent(
      "agent_a",
      "raw:2026-09-29",
      async () => {
        events.push("a2:start");
        return "a2";
      },
    );
    const other = coordinator.runAgent("agent_b", "full", async () => {
      events.push("b:start");
      return "b";
    });
    await vi.waitFor(() => expect(events).toContain("b:start"));
    expect(events).not.toContain("a2:start");
    releaseFirst();
    await expect(
      Promise.all([first, duplicate, duplicateAgain, second, other]),
    ).resolves.toEqual(["a1", "a1-new", "a1-new", "a2", "b"]);
    expect(events.filter((event) => event === "a1:followup")).toHaveLength(1);
    expect(events.indexOf("a2:start")).toBeGreaterThan(
      events.indexOf("a1:followup"),
    );
  });

  it("runs at most four Sources for one Agent", async () => {
    const coordinator = new ChunkSyncCoordinator(4);
    let active = 0;
    let maximum = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = coordinator.mapSources(
      [1, 2, 3, 4, 5, 6],
      async (source) => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate;
        active -= 1;
        return source;
      },
    );
    await vi.waitFor(() => expect(maximum).toBe(4));
    release();
    await expect(running).resolves.toEqual([1, 2, 3, 4, 5, 6]);
    expect(maximum).toBe(4);
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
