import { describe, expect, it, vi } from "vitest";

// The pool is internal to @livekit/agents and absent from its export map; the
// repository patch changes it, so the test loads the patched file directly.
const { ProcPool } = (await import(
  new URL("./ipc/proc_pool.js", import.meta.resolve("@livekit/agents")).href
)) as {
  ProcPool: new (
    agent: string,
    numIdleProcesses: number,
    initializeTimeout: number,
    closeTimeout: number,
    inferenceExecutor: undefined,
    memoryWarnMB: number,
    memoryLimitMB: number,
  ) => {
    warmedProcQueue: {
      put(entry: { proc: unknown; unlock: () => void }): Promise<void>;
    };
    launchJob(info: unknown): Promise<void>;
  };
};

function warmedProcess(isAlive: boolean) {
  return { isAlive, launchJob: vi.fn(async () => undefined) };
}

describe("patched LiveKit process pool", () => {
  it("skips a warmed process that died while idle and releases its slot", async () => {
    const pool = new ProcPool("agent", 1, 1_000, 1_000, undefined, 0, 0);
    const dead = warmedProcess(false);
    const live = warmedProcess(true);
    const unlockDead = vi.fn();
    const unlockLive = vi.fn();
    await pool.warmedProcQueue.put({ proc: dead, unlock: unlockDead });
    await pool.warmedProcQueue.put({ proc: live, unlock: unlockLive });
    const job = { job: { id: "job" } };

    await pool.launchJob(job);

    expect(dead.launchJob).not.toHaveBeenCalled();
    expect(unlockDead).toHaveBeenCalledTimes(1);
    expect(live.launchJob).toHaveBeenCalledWith(job);
    expect(unlockLive).toHaveBeenCalledTimes(1);
  });
});
