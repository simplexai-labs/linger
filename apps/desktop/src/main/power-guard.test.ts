import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_ACTIVITY_TAIL_MS,
  PowerGuardModule,
  type PowerApi,
  type PowerEventKind,
} from "./power-guard.js";
import { stubModule, testHost } from "./test-support.js";

afterEach(() => {
  vi.useRealTimers();
});

const setup = async (
  preventSleep = false,
  initial: {
    readonly running?: number;
    readonly modelInvokes?: number;
    readonly onBattery?: boolean;
  } = {},
) => {
  const blocks: number[] = [];
  let powerListener: ((kind: PowerEventKind) => void) | undefined;
  let onBattery = initial.onBattery ?? false;
  let next = 0;
  const power: PowerApi = {
    block: () => {
      next += 1;
      blocks.push(next);
      return next;
    },
    unblock: (id) => {
      blocks.splice(blocks.indexOf(id), 1);
    },
    isOnBattery: () => onBattery,
    onPowerEvent: (listener) => {
      powerListener = (kind) => {
        if (kind === "on-battery") onBattery = true;
        else if (kind === "on-ac") onBattery = false;
        listener(kind);
      };
      return () => (powerListener = undefined);
    },
  };
  const daemon = {
    ...stubModule("ComputerDaemon"),
    running: () => initial.running ?? 0,
    modelInvokes: () => initial.modelInvokes ?? 0,
  };
  const guard = new PowerGuardModule(power);
  const host = testHost([daemon, guard], {
    preventSleep,
  });
  await host.start();
  return { host, guard, blocks, power: () => powerListener };
};

describe("PowerGuard module", () => {
  it("blocks sleep only while operations run", async () => {
    const { host, guard, blocks } = await setup();
    expect(guard.active()).toBe(false);
    host.ctx.bus.emit("runtime.activity", 2);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.activity", 1);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.activity", 0);
    expect(blocks).toEqual([]);
  });

  it("blocks sleep during background model invocations and their release tail", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host, guard, blocks } = await setup();
    let changes = 0;
    host.ctx.bus.on("power.changed", () => {
      changes += 1;
    });
    // Zero before any model call does not arm a tail.
    host.ctx.bus.emit("runtime.model_activity", 0);
    expect(guard.active()).toBe(false);
    expect(changes).toBe(0);

    host.ctx.bus.emit("runtime.model_activity", 1);
    expect(guard.active()).toBe(true);
    expect(blocks).toEqual([1]);
    expect(changes).toBe(1);

    // Additional model calls do not re-emit power.changed while already active.
    host.ctx.bus.emit("runtime.model_activity", 2);
    expect(blocks).toEqual([1]);
    expect(changes).toBe(1);

    // Dropping to 0 keeps the blocker through the tail to bridge chained steps.
    host.ctx.bus.emit("runtime.model_activity", 0);
    vi.advanceTimersByTime(MODEL_ACTIVITY_TAIL_MS - 1);
    expect(guard.active()).toBe(true);
    expect(blocks).toEqual([1]);

    // A follow-up model call cancels the tail and shares the same blocker.
    host.ctx.bus.emit("runtime.model_activity", 1);
    vi.advanceTimersByTime(MODEL_ACTIVITY_TAIL_MS);
    expect(guard.active()).toBe(true);
    expect(blocks).toEqual([1]);

    host.ctx.bus.emit("runtime.model_activity", 0);
    vi.advanceTimersByTime(MODEL_ACTIVITY_TAIL_MS);
    expect(guard.active()).toBe(false);
    expect(blocks).toEqual([]);
    expect(changes).toBe(2);
    await host.stop("quit");
  });

  it("takes the union of model invocations, operations, and always-on mode", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host, guard, blocks } = await setup(true);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.model_activity", 1);
    host.ctx.bus.emit("runtime.activity", 1);
    expect(blocks).toEqual([1]);

    guard.setAlwaysOn(false);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.model_activity", 0);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.activity", 0);
    expect(guard.active()).toBe(true);

    vi.advanceTimersByTime(MODEL_ACTIVITY_TAIL_MS);
    expect(guard.active()).toBe(false);
    expect(blocks).toEqual([]);
    await host.stop("quit");
  });

  it("clears a pending model-activity tail and releases on stop", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host, guard, blocks } = await setup();
    host.ctx.bus.emit("runtime.model_activity", 1);
    host.ctx.bus.emit("runtime.model_activity", 0);
    expect(guard.active()).toBe(true);
    await host.stop("quit");
    expect(guard.active()).toBe(false);
    expect(blocks).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("seeds active background model invocations on start and arms the tail on completion", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { host, guard, blocks } = await setup(false, { modelInvokes: 1 });
    expect(guard.active()).toBe(true);
    expect(blocks).toEqual([1]);

    host.ctx.bus.emit("runtime.model_activity", 0);
    vi.advanceTimersByTime(MODEL_ACTIVITY_TAIL_MS - 1);
    expect(guard.active()).toBe(true);
    expect(blocks).toEqual([1]);

    vi.advanceTimersByTime(1);
    expect(guard.active()).toBe(false);
    expect(blocks).toEqual([]);
    await host.stop("quit");
  });

  it("blocks sleep while a local server installation or resume is busy", async () => {
    const { host, guard, blocks } = await setup();
    expect(guard.active()).toBe(false);
    host.ctx.bus.emit("local-server.busy", true);
    expect(guard.active()).toBe(true);
    expect(guard.alwaysOn()).toBe(false);
    expect(blocks).toEqual([1]);
    // Runtime activity overlapping an install shares the single blocker.
    host.ctx.bus.emit("runtime.activity", 1);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("local-server.busy", false);
    expect(blocks).toEqual([1]);
    host.ctx.bus.emit("runtime.activity", 0);
    expect(guard.active()).toBe(false);
    expect(blocks).toEqual([]);
    await host.stop("quit");
  });

  it("keeps blocking in always-on mode and saves the choice", async () => {
    const { host, guard, blocks } = await setup(true);
    expect(blocks).toHaveLength(1);
    guard.setAlwaysOn(false);
    expect(blocks).toHaveLength(0);
    expect(host.ctx.config.get().preventSleep).toBe(false);
    await host.stop("quit");
  });

  it("stops listening for power events when stopped", async () => {
    const { host, power } = await setup();
    expect(power()).toBeDefined();
    await host.stop("quit");
    expect(power()).toBeUndefined();
  });

  it("pauses always-on sleep prevention on battery while keeping active work protected", async () => {
    const { host, guard, blocks, power } = await setup(true, {
      onBattery: true,
    });
    expect(guard.alwaysOn()).toBe(true);
    expect(guard.active()).toBe(false);
    expect(guard.pausedOnBattery()).toBe(true);
    expect(blocks).toEqual([]);

    // Active work still acquires the sleep blocker even on battery.
    host.ctx.bus.emit("runtime.activity", 1);
    expect(guard.active()).toBe(true);
    expect(guard.pausedOnBattery()).toBe(false);
    expect(blocks).toEqual([1]);

    // Completing work releases the blocker again while still on battery.
    host.ctx.bus.emit("runtime.activity", 0);
    expect(guard.active()).toBe(false);
    expect(guard.pausedOnBattery()).toBe(true);
    expect(blocks).toEqual([]);

    // Plugging back into AC resumes the always-on blocker.
    power()?.("on-ac");
    expect(guard.active()).toBe(true);
    expect(guard.pausedOnBattery()).toBe(false);
    expect(blocks).toEqual([2]);

    // Switching back to battery releases the always-on blocker while idle.
    power()?.("on-battery");
    expect(guard.active()).toBe(false);
    expect(guard.pausedOnBattery()).toBe(true);
    expect(blocks).toEqual([]);
    await host.stop("quit");
  });
});
