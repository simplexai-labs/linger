import { describe, expect, it } from "vitest";

import {
  runDesktopPermissionStep,
  SYSTEM_SETTINGS_URL,
  SystemPermissions,
  type SystemPermissionApi,
} from "./system-permissions.js";

const setup = (screen: string, trusted = false) => {
  const calls: string[] = [];
  const api: SystemPermissionApi & { screen: string } = {
    screen,
    screenAccessStatus: () => api.screen,
    isTrustedAccessibilityClient: (prompt) => {
      calls.push(`trusted ${prompt}`);
      return trusted;
    },
    captureScreens: async () => {
      calls.push("capture");
      return [{ id: "screen" }];
    },
    openExternal: async (url) => {
      calls.push(`open ${url}`);
    },
  };
  return { api, calls, permissions: new SystemPermissions(api) };
};

describe("SystemPermissions", () => {
  it("maps the Electron statuses", () => {
    const states = (screen: string, trusted: boolean) =>
      setup(screen, trusted)
        .permissions.status()
        .map((p) => p.state);
    expect(states("granted", true)).toEqual(["granted", "granted"]);
    expect(states("not-determined", false)).toEqual([
      "not_determined",
      "denied",
    ]);
    expect(states("restricted", false)[0]).toBe("denied");
    expect(states("denied", false)[0]).toBe("denied");
    expect(states("unknown", false)[0]).toBe("unknown");
  });

  it("checks Accessibility without prompting", () => {
    const { permissions, calls } = setup("granted");
    permissions.status();
    expect(calls).toEqual(["trusted false"]);
  });

  it("prompts through a screen capture and the accessibility check", async () => {
    const { permissions, calls } = setup("not-determined");
    await permissions.prompt("screen_recording");
    await permissions.prompt("accessibility");
    expect(calls.filter((c) => c !== "trusted false")).toEqual([
      "capture",
      "trusted true",
    ]);
  });

  it("opens the System Settings pane of each permission", async () => {
    const { permissions, calls } = setup("denied");
    await permissions.openSettings("accessibility");
    await permissions.openSettings("screen_recording");
    expect(calls.filter((c) => c !== "trusted false")).toEqual([
      `open ${SYSTEM_SETTINGS_URL.accessibility}`,
      "capture",
      `open ${SYSTEM_SETTINGS_URL.screen_recording}`,
    ]);
  });

  it("needs a relaunch once this process asked for Screen Recording", async () => {
    const { api, permissions } = setup("not-determined");
    expect(permissions.status()[0]!.relaunch_required).toBe(false);
    const after = await permissions.prompt("screen_recording");
    expect(after[0]).toEqual({
      id: "screen_recording",
      state: "not_determined",
      relaunch_required: true,
    });
    api.screen = "granted";
    expect(permissions.status()[0]!.relaunch_required).toBe(false);
  });

  it("keeps the Settings action when macOS returns no screen sources", async () => {
    const { api, permissions } = setup("denied");
    api.captureScreens = async () => [];
    const [screen] = await permissions.prompt("screen_recording");
    expect(screen?.relaunch_required).toBe(false);
  });

  it("keeps the settings action after macOS rejects a capture", async () => {
    const { api, calls, permissions } = setup("denied");
    api.captureScreens = async () => {
      throw new Error("Capture denied");
    };
    for (const action of ["prompt", "openSettings"] as const) {
      expect(
        (await permissions[action]("screen_recording"))[0]?.relaunch_required,
      ).toBe(false);
    }
    expect(calls.filter((call) => call.startsWith("open"))).toEqual(
      Array(2).fill(`open ${SYSTEM_SETTINGS_URL.screen_recording}`),
    );
  });

  it("keeps Settings available when opening it with screen access denied", async () => {
    const { permissions } = setup("denied");
    await permissions.openSettings("accessibility");
    expect(permissions.status()[0]!.relaunch_required).toBe(false);
    const after = await permissions.openSettings("screen_recording");
    expect(after[0]!.relaunch_required).toBe(false);
    expect(after[1]!.relaunch_required).toBe(false);
  });
});

describe("runDesktopPermissionStep", () => {
  const fixture = () => {
    const { calls, permissions } = setup("not-determined");
    return {
      calls,
      permissions,
      host: {
        permissions,
        openExternal: async (url: string) => {
          calls.push(`cua ${url}`);
        },
        relaunch: () => calls.push("relaunch"),
      },
    };
  };

  it("prompts and opens Settings for Linger itself", async () => {
    const { calls, host } = fixture();
    await runDesktopPermissionStep(host, {
      action: "prompt",
      subject: "linger",
      permission: "screen_recording",
    });
    await runDesktopPermissionStep(host, {
      action: "open_settings",
      subject: "linger",
      permission: "accessibility",
    });
    // Each step reads the status after it, which checks trust unprompted.
    expect(calls.filter((call) => call !== "trusted false")).toEqual([
      "capture",
      `open ${SYSTEM_SETTINGS_URL.accessibility}`,
    ]);
  });

  it("opens CuaDriver's pane without counting it as Linger asking", async () => {
    const { calls, host, permissions } = fixture();
    await runDesktopPermissionStep(host, {
      action: "open_settings",
      subject: "computer_use",
      permission: "screen_recording",
    });
    expect(calls).toEqual([`cua ${SYSTEM_SETTINGS_URL.screen_recording}`]);
    expect(permissions.status()[0]!.relaunch_required).toBe(false);
  });

  it("relaunches only after the step answered", async () => {
    const { calls, host } = fixture();
    await runDesktopPermissionStep(host, {
      action: "relaunch",
      subject: "linger",
    });
    expect(calls).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toEqual(["relaunch"]);
  });
});
