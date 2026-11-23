import { describe, expect, it, vi } from "vitest";

import type { IMessageStatus } from "../shared/api.js";
import { IMessageModule } from "./imessage.js";
import type { IMessageChecks } from "./imessage-permissions.js";
import { IMsgRuntimeError } from "./imsg-runtime.js";
import { EventBus } from "./modules.js";
import { testHost } from "./test-support.js";

const ALL_GRANTED: IMessageChecks = {
  fullDisk: "granted",
  messagesAutomation: "granted",
  iMessageSignedIn: "yes",
};

const setup = async (
  options: {
    installed?: boolean;
    ensure?: () => Promise<string>;
    checks?: IMessageChecks;
    enabled?: boolean;
  } = {},
) => {
  let installed = options.installed ?? false;
  const runtime = {
    installed: vi.fn(async () => installed),
    ensure: vi.fn(
      options.ensure ??
        (async () => {
          installed = true;
          return "/data/imessage/imsg/0.21.1/imsg";
        }),
    ),
    executable: () => "/data/imessage/imsg/0.21.1/imsg",
  };
  const checks = { current: options.checks ?? ALL_GRANTED };
  const permissions = {
    checks: vi.fn(async () => checks.current),
    requestAutomation: vi.fn(async () => {}),
  };
  const openExternal = vi.fn(async (_url: string) => {});
  const module = new IMessageModule({
    runtime,
    permissions,
    openExternal,
    channelState: { clear: () => {}, resetTarget: () => {} },
    createBridge: () => ({ start: () => {}, stop: async () => {} }),
  });
  const bus = new EventBus();
  const events: IMessageStatus[] = [];
  bus.on("imessage.changed", (status) => events.push(status));
  const host = testHost(
    [module],
    {
      imessage: {
        enabled: options.enabled ?? false,
        handles: [],
        automationAsked: false,
      },
    },
    bus,
  );
  await host.start();
  await module.refresh();
  return { module, runtime, permissions, openExternal, events, checks };
};

describe("IMessageModule", () => {
  it("is ready only when enabled, installed, allowed and with a handle", async () => {
    const f = await setup({ installed: true });
    expect(f.module.status().ready).toBe(false);
    f.module.set({ enabled: true });
    expect(f.module.status().ready).toBe(false);
    f.module.set({ handles: ["me@icloud.com"] });
    await vi.waitFor(() => expect(f.module.status().runtime).toBe("ready"));
    expect(f.module.status()).toMatchObject({
      enabled: true,
      handles: ["me@icloud.com"],
      runtime: "ready",
      ready: true,
    });
    f.checks.current = { ...ALL_GRANTED, iMessageSignedIn: "no" };
    expect((await f.module.refresh()).ready).toBe(false);
  });

  it("installs imsg when enabled", async () => {
    const f = await setup();
    expect(f.module.status().runtime).toBe("missing");
    f.module.set({ enabled: true });
    expect(f.module.status().runtime).toBe("installing");
    await vi.waitFor(() => expect(f.module.status().runtime).toBe("ready"));
    expect(f.runtime.ensure).toHaveBeenCalledOnce();
    expect(f.events.map((e) => e.runtime)).toEqual(
      expect.arrayContaining(["missing", "installing", "ready"]),
    );
  });

  it("installs on start when already enabled", async () => {
    const f = await setup({ enabled: true });
    await vi.waitFor(() => expect(f.module.status().runtime).toBe("ready"));
    expect(f.runtime.ensure).toHaveBeenCalledOnce();
  });

  it("reports a failed install by code and retries", async () => {
    const f = await setup({
      ensure: async () => {
        throw new IMsgRuntimeError("checksum_mismatch", "bad");
      },
    });
    f.module.set({ enabled: true });
    await vi.waitFor(() =>
      expect(f.module.status()).toMatchObject({
        runtime: "failed",
        runtimeError: "checksum_mismatch",
      }),
    );
    f.runtime.ensure.mockResolvedValueOnce("/x");
    await f.module.act("retry_install");
    await vi.waitFor(() => expect(f.module.status().runtime).toBe("ready"));
    expect(f.module.status().runtimeError).toBeUndefined();
  });

  it("rejects the whole handles patch on one invalid handle", async () => {
    const f = await setup();
    f.module.set({ handles: ["a@b.co"] });
    const result = f.module.set({ handles: ["c@d.co", "12345"] });
    expect(result).toMatchObject({ ok: false, code: "invalid_handle" });
    expect(f.module.status().handles).toEqual(["a@b.co"]);
  });

  it("emits only when the view changes", async () => {
    const f = await setup();
    const before = f.events.length;
    await f.module.refresh();
    expect(f.events.length).toBe(before);
    f.module.set({ handles: ["+8613800138000"] });
    expect(f.events.at(-1)?.handles).toEqual(["+8613800138000"]);
  });

  it("coalesces concurrent checks", async () => {
    const f = await setup();
    f.permissions.checks.mockClear();
    await Promise.all([f.module.refresh(), f.module.refresh()]);
    expect(f.permissions.checks).toHaveBeenCalledOnce();
  });

  it("asks to control Messages and opens settings panes", async () => {
    const f = await setup();
    await f.module.act("request_automation");
    expect(f.permissions.requestAutomation).toHaveBeenCalledOnce();
    await f.module.act("open_full_disk_settings");
    await f.module.act("open_automation_settings");
    expect(f.openExternal.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining("Privacy_AllFiles"),
      expect.stringContaining("Privacy_Automation"),
    ]);
  });
});

describe("IMessageModule bridge", () => {
  const bridgeSetup = async () => {
    const current = { checks: ALL_GRANTED };
    const events: string[] = [];
    const bridges: {
      handles: readonly string[];
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      onState: (state: "running" | "signed_out") => void;
    }[] = [];
    const module = new IMessageModule({
      runtime: {
        installed: async () => true,
        ensure: async () => "/imsg",
        executable: () => "/imsg",
      },
      permissions: {
        checks: async () => current.checks,
        requestAutomation: async () => {},
      },
      openExternal: async () => {},
      channelState: {
        clear: () => events.push("clear"),
        resetTarget: () => events.push("resetTarget"),
      },
      createBridge: ({ handles, onState }) => {
        const bridge = {
          handles,
          start: vi.fn(),
          stop: vi.fn(async () => {
            events.push(`stop ${String(bridges.indexOf(bridge))}`);
          }),
          onState,
        };
        bridges.push(bridge);
        return bridge;
      },
    });
    const bus = new EventBus();
    const host = testHost([module], {}, bus);
    await host.start();
    await module.refresh();
    return { module, bridges, bus, host, current, events };
  };

  it("runs the bridge only while ready", async () => {
    const f = await bridgeSetup();
    expect(f.bridges).toHaveLength(0);
    f.module.set({ enabled: true, handles: ["a@b.co"] });
    await vi.waitFor(() => expect(f.bridges).toHaveLength(1));
    expect(f.bridges[0]!.start).toHaveBeenCalledOnce();
    f.bridges[0]!.onState("running");
    expect(f.module.status().bridge).toBe("running");
    f.module.set({ enabled: false });
    await vi.waitFor(() => expect(f.bridges[0]!.stop).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(f.module.status().bridge).toBe("stopped"));
    // Off forgets the cursors, after the bridge stopped.
    await vi.waitFor(() =>
      expect(f.events).toEqual(["resetTarget", "stop 0", "clear"]),
    );
    await f.host.stop("quit");
    expect(f.bridges).toHaveLength(1);
  });

  it("restarts the bridge on a new server", async () => {
    const f = await bridgeSetup();
    f.module.set({ enabled: true, handles: ["a@b.co"] });
    await vi.waitFor(() => expect(f.bridges).toHaveLength(1));
    f.bus.emit("server.changed", "https://other.test");
    await vi.waitFor(() => expect(f.bridges).toHaveLength(2));
    expect(f.bridges[0]!.stop).toHaveBeenCalledOnce();
    expect(f.bridges[1]!.start).toHaveBeenCalledOnce();
    await f.host.stop("quit");
  });

  it("clears the cursors when turned off with no bridge", async () => {
    const f = await bridgeSetup();
    f.module.set({ enabled: true });
    f.module.set({ enabled: false });
    await vi.waitFor(() => expect(f.events).toEqual(["clear"]));
    await f.host.stop("quit");
  });

  it("keeps the bridge through a check that could not answer", async () => {
    const f = await bridgeSetup();
    f.module.set({ enabled: true, handles: ["a@b.co"] });
    await vi.waitFor(() => expect(f.bridges).toHaveLength(1));
    f.current.checks = {
      ...ALL_GRANTED,
      messagesAutomation: "unknown",
      iMessageSignedIn: "unknown",
    };
    expect((await f.module.refresh()).ready).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.bridges[0]!.stop).not.toHaveBeenCalled();
    f.current.checks = { ...ALL_GRANTED, messagesAutomation: "denied" };
    await f.module.refresh();
    await vi.waitFor(() => expect(f.bridges[0]!.stop).toHaveBeenCalledOnce());
    // Unknown again does not start it: starting needs every check passed.
    f.current.checks = { ...ALL_GRANTED, messagesAutomation: "unknown" };
    await f.module.refresh();
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.bridges).toHaveLength(1);
    await f.host.stop("quit");
  });

  it("restarts the bridge with new handles and stops it with the app", async () => {
    const f = await bridgeSetup();
    f.module.set({ enabled: true, handles: ["a@b.co"] });
    await vi.waitFor(() => expect(f.bridges).toHaveLength(1));
    f.module.set({ handles: ["a@b.co", "+14155550100"] });
    await vi.waitFor(() => expect(f.bridges).toHaveLength(2));
    expect(f.bridges[0]!.stop).toHaveBeenCalledOnce();
    expect(f.bridges[1]!.handles).toEqual(["a@b.co", "+14155550100"]);
    // The reply target is forgotten between the stop and the new start.
    expect(f.events).toEqual(["resetTarget", "stop 0", "resetTarget"]);
    await f.host.stop("quit");
    expect(f.bridges[1]!.stop).toHaveBeenCalledOnce();
    expect(f.bridges).toHaveLength(2);
  });
});
