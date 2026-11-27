import { describe, expect, it, vi } from "vitest";

import { DesktopShutdownController } from "./app-lifecycle.js";
import type { StopReason } from "./modules.js";

function createHarness() {
  const order: string[] = [];
  let releaseStop: (() => void) | undefined;
  const stopHost = vi.fn((reason: StopReason) => {
    order.push(`stopHost:${reason}`);
    return new Promise<void>((resolve) => {
      releaseStop = () => {
        order.push(`stopHostDone:${reason}`);
        resolve();
      };
    });
  });
  const prepareQuit = vi.fn(() => {
    order.push("prepareQuit");
  });
  const stopLocalModelsNow = vi.fn(() => {
    order.push("stopLocalModelsNow");
  });
  const destroySessionWindow = vi.fn(() => {
    order.push("destroySessionWindow");
  });
  const relaunch = vi.fn(() => {
    order.push("relaunch");
  });
  const exit = vi.fn((code: number) => {
    order.push(`exit:${code}`);
  });
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const controller = new DesktopShutdownController({
    prepareQuit,
    stopLocalModelsNow,
    stopHost,
    destroySessionWindow,
    relaunch,
    exit,
    log,
  });
  return {
    controller,
    order,
    stopHost,
    prepareQuit,
    stopLocalModelsNow,
    destroySessionWindow,
    relaunch,
    exit,
    log,
    finishStop: async () => {
      releaseStop?.();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("DesktopShutdownController", () => {
  it("stops the host with quit on normal before-quit", async () => {
    const h = createHarness();
    const event = { preventDefault: vi.fn() };
    h.controller.onBeforeQuit(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(h.stopHost).toHaveBeenCalledWith("quit");
    expect(h.stopLocalModelsNow).not.toHaveBeenCalled();

    // Repeated before-quit while shutting down still holds Electron's quit
    // without starting a second host stop.
    const second = { preventDefault: vi.fn() };
    h.controller.onBeforeQuit(second);
    expect(second.preventDefault).toHaveBeenCalledOnce();
    expect(h.stopHost).toHaveBeenCalledTimes(1);

    await h.finishStop();
    expect(h.destroySessionWindow).toHaveBeenCalledOnce();
    expect(h.relaunch).not.toHaveBeenCalled();
    expect(h.exit).toHaveBeenCalledWith(0);
  });

  it("stops the host with update and relaunches when marked for relaunch", async () => {
    const h = createHarness();
    h.controller.markRelaunch();
    const event = { preventDefault: vi.fn() };
    h.controller.onBeforeQuit(event);
    expect(h.stopHost).toHaveBeenCalledWith("update");

    await h.finishStop();
    expect(h.order).toEqual([
      "prepareQuit",
      "stopHost:update",
      "stopHostDone:update",
      "destroySessionWindow",
      "relaunch",
      "exit:0",
    ]);
  });

  it.each(["updating", "replacing"] as const)(
    "stops the host with update without relaunch when marked %s",
    async (mode) => {
      const h = createHarness();
      if (mode === "updating") h.controller.markUpdating();
      else h.controller.markReplacing();
      h.controller.onBeforeQuit({ preventDefault: vi.fn() });
      expect(h.stopHost).toHaveBeenCalledWith("update");

      await h.finishStop();
      expect(h.relaunch).not.toHaveBeenCalled();
      expect(h.exit).toHaveBeenCalledWith(0);
    },
  );

  it("synchronously stops local models before awaiting host logout on Windows session-end", async () => {
    const h = createHarness();
    h.controller.onSessionEnd(["logoff"]);
    expect(h.log.info).toHaveBeenCalledWith("desktop.session_end", {
      reasons: ["logoff"],
    });
    // stopLocalModelsNow must execute synchronously before stopHost resolves
    // so Windows WM_ENDSESSION cannot terminate the app before spawning it.
    expect(h.order).toEqual([
      "prepareQuit",
      "stopLocalModelsNow",
      "stopHost:logout",
    ]);

    // A subsequent before-quit still calls preventDefault so Electron does not
    // exit before stopHost("logout") finishes, while neither event starts a
    // second stop.
    h.controller.onSessionEnd(["shutdown"]);
    const beforeQuit = { preventDefault: vi.fn() };
    h.controller.onBeforeQuit(beforeQuit);
    expect(beforeQuit.preventDefault).toHaveBeenCalledOnce();
    expect(h.stopLocalModelsNow).toHaveBeenCalledTimes(1);
    expect(h.stopHost).toHaveBeenCalledTimes(1);

    await h.finishStop();
    expect(h.order).toEqual([
      "prepareQuit",
      "stopLocalModelsNow",
      "stopHost:logout",
      "prepareQuit",
      "prepareQuit",
      "stopHostDone:logout",
      "destroySessionWindow",
      "exit:0",
    ]);
  });

  it("ignores session-end if a before-quit shutdown is already in progress", async () => {
    const h = createHarness();
    h.controller.markUpdating();
    h.controller.onBeforeQuit({ preventDefault: vi.fn() });
    h.controller.onSessionEnd(["shutdown"]);
    expect(h.stopLocalModelsNow).not.toHaveBeenCalled();
    expect(h.stopHost).toHaveBeenCalledTimes(1);
    expect(h.stopHost).toHaveBeenCalledWith("update");
    await h.finishStop();
  });
});
