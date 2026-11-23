import { describe, expect, it } from "vitest";

import { IMessagePermissions } from "./imessage-permissions.js";
import type { PermissionProbes } from "./mac-permissions.js";

const errno = (code: string) => Object.assign(new Error(code), { code });

const setup = (
  probes: Partial<PermissionProbes>,
  asked = false,
  enabled = true,
) => {
  const calls: string[] = [];
  const state = { asked, enabled };
  const permissions = new IMessagePermissions({
    home: "/Users/me",
    asked: () => state.asked,
    markAsked: () => {
      state.asked = true;
    },
    enabled: () => state.enabled,
    probes: {
      openFile: async (file) => {
        calls.push(`open ${file}`);
        await probes.openFile?.(file);
      },
      listDirectory: async () => {},
      appleScript: async (script) => {
        calls.push("osascript");
        return (await probes.appleScript?.(script)) ?? "";
      },
    },
  });
  return { permissions, calls, state };
};

describe("IMessagePermissions", () => {
  it("reads the Messages database for Full Disk Access", async () => {
    const granted = setup({});
    expect((await granted.permissions.checks()).fullDisk).toBe("granted");
    expect(granted.calls).toContain("open /Users/me/Library/Messages/chat.db");

    const refused = setup({
      openFile: async () => {
        throw errno("EPERM");
      },
    });
    expect((await refused.permissions.checks()).fullDisk).toBe("denied");

    const missing = setup({
      openFile: async () => {
        throw errno("ENOENT");
      },
    });
    expect((await missing.permissions.checks()).fullDisk).toBe(
      "messagesNotSetUp",
    );
  });

  it("does not script Messages until the person asked", async () => {
    const { permissions, calls } = setup({ appleScript: async () => "1" });
    expect(await permissions.checks()).toEqual({
      fullDisk: "granted",
      messagesAutomation: "unknown",
      iMessageSignedIn: "unknown",
    });
    expect(calls).not.toContain("osascript");
  });

  it("never scripts Messages while iMessage is off", async () => {
    const { permissions, calls } = setup(
      { appleScript: async () => "1" },
      true,
      false,
    );
    expect(await permissions.checks()).toMatchObject({
      fullDisk: "granted",
      messagesAutomation: "unknown",
    });
    expect(calls).toEqual(["open /Users/me/Library/Messages/chat.db"]);
  });

  it("reports a refusal to control Messages", async () => {
    const { permissions, state } = setup({
      appleScript: async () => {
        throw new Error(
          "execution error: Not authorized to send Apple events to Messages. (-1743)",
        );
      },
    });
    await permissions.requestAutomation();
    expect(state.asked).toBe(true);
    expect(await permissions.checks()).toMatchObject({
      messagesAutomation: "denied",
      iMessageSignedIn: "unknown",
    });
  });

  it("tells whether an iMessage account is signed in", async () => {
    const none = setup({ appleScript: async () => "0\n" }, true);
    expect(await none.permissions.checks()).toMatchObject({
      messagesAutomation: "granted",
      iMessageSignedIn: "no",
    });
    const one = setup({ appleScript: async () => "1\n" }, true);
    expect(await one.permissions.checks()).toMatchObject({
      messagesAutomation: "granted",
      iMessageSignedIn: "yes",
    });
  });
});
