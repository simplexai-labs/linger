import { describe, expect, it } from "vitest";

import zhCN from "../i18n/locales/zh-CN.json" with { type: "json" };
import { translator } from "../i18n/language.js";
import { trayMenu, updateNotice, type TrayMenuState } from "./tray-menu.js";
import type { AnnouncedUpdate } from "./updater.js";

const en = translator("en");
const menu = (state: TrayMenuState) => trayMenu(state, en);
const notice = (update: AnnouncedUpdate) => updateNotice(update, en);

describe("trayMenu", () => {
  it("leads with the status and ends with quit", () => {
    const items = menu({
      status: { tone: "busy", label: "Running 2 Tasks" },
      preventSleep: true,
      enrolled: true,
    });
    expect(items[0]).toEqual({ kind: "label", label: "Running 2 Tasks" });
    expect(items).toContainEqual({
      kind: "action",
      action: "toggle-prevent-sleep",
      label: "Prevent Sleep",
      checked: true,
    });
    const actions = items.flatMap((i) => (i.kind === "action" ? i.action : []));
    expect(actions).toEqual([
      "open",
      "enroll",
      "toggle-prevent-sleep",
      "show-logs",
      "save-diagnostics",
      "quit",
    ]);
  });

  it("offers Send Diagnostics only while a receiver is set up", () => {
    const actions = (canSendDiagnostics: boolean) =>
      menu({
        status: { tone: "error", label: "Offline" },
        preventSleep: false,
        enrolled: true,
        canSendDiagnostics,
      }).flatMap((i) => (i.kind === "action" ? i.action : []));
    expect(actions(false)).not.toContain("send-diagnostics");
    expect(actions(true)).toEqual(
      expect.arrayContaining(["save-diagnostics", "send-diagnostics"]),
    );
  });

  it("connects an unenrolled computer and reconnects an enrolled one", () => {
    const label = (enrolled: boolean) =>
      menu({
        status: { tone: "setup", label: "Not Connected" },
        preventSleep: false,
        enrolled,
      }).find((i) => i.kind === "action" && i.action === "enroll");
    expect(label(false)).toMatchObject({ label: "Connect This Computer…" });
    expect(label(true)).toMatchObject({ label: "Reconnect This Computer" });
  });

  it("offers a downloaded update and says when it waits for tasks", () => {
    const items = (waiting: boolean) =>
      menu({
        status: { tone: "busy", label: "Running 1 Task" },
        preventSleep: false,
        enrolled: true,
        update: { kind: waiting ? "waiting" : "ready", version: "0.17.0" },
      }).slice(0, 2);
    expect(items(false)[1]).toEqual({
      kind: "action",
      action: "install-update",
      label: "Restart to Update (0.17.0)",
    });
    expect(items(true)[1]).toEqual({
      kind: "label",
      label: "Updating to 0.17.0 When Tasks Finish",
    });
  });

  it("shows a download in progress", () => {
    const items = menu({
      status: { tone: "online", label: "Online" },
      preventSleep: false,
      enrolled: true,
      update: { kind: "downloading", version: "0.17.0" },
    });
    expect(items[1]).toEqual({
      kind: "label",
      label: "Downloading Update 0.17.0…",
    });
  });

  it("says why an update failed and offers to try again", () => {
    const items = menu({
      status: { tone: "online", label: "Online" },
      preventSleep: false,
      enrolled: true,
      update: { kind: "failed", error: `Couldn't unpack ${"x".repeat(200)}` },
    });
    expect(items[1]).toMatchObject({ kind: "label" });
    const label = (items[1] as { label: string }).label;
    expect(label.startsWith("Update Failed: Couldn't unpack")).toBe(true);
    expect(label.length).toBe("Update Failed: ".length + 80);
    expect(items[2]).toEqual({
      kind: "action",
      action: "check-update",
      label: "Try Updating Again",
    });
  });

  it("shows nothing while idle or checking", () => {
    for (const kind of ["idle", "checking"] as const) {
      const items = menu({
        status: { tone: "online", label: "Online" },
        preventSleep: false,
        enrolled: true,
        update: { kind },
      });
      expect(items[1]).toEqual({ kind: "separator" });
    }
  });

  it("links a release this installation cannot apply itself", () => {
    const item = menu({
      status: { tone: "online", label: "Online" },
      preventSleep: false,
      enrolled: true,
      update: {
        kind: "available",
        version: "0.17.0",
        url: "https://github.com/simplexai-labs/linger/releases/tag/desktop-v0.17.0",
      },
    })[1];
    expect(item).toEqual({
      kind: "action",
      action: "install-update",
      label: "Download Linger 0.17.0…",
    });
  });
});

describe("updateNotice", () => {
  it("names what clicking it does", () => {
    expect(notice({ kind: "ready", version: "0.17.0" })).toEqual({
      title: "Update ready",
      body: "Linger 0.17.0 is downloaded. Click to restart Linger and update.",
    });
    expect(
      notice({ kind: "available", version: "0.17.0", url: "https://x" }),
    ).toEqual({
      title: "Update available",
      body: "Linger 0.17.0 is available. Click to open its download page.",
    });
  });
});

describe("the tray in Chinese", () => {
  it("labels the menu and the notifications from the catalog", () => {
    const zh = translator("zh-CN");
    const items = trayMenu(
      {
        status: { tone: "online", label: zhCN.status.idle },
        preventSleep: false,
        enrolled: true,
        update: { kind: "ready", version: "0.17.0" },
      },
      zh,
    );
    expect(items).toContainEqual({
      kind: "action",
      action: "quit",
      label: zhCN.tray.quit,
    });
    expect(items).toContainEqual({
      kind: "action",
      action: "install-update",
      label: zhCN.tray.restartToUpdate.replace("{version}", "0.17.0"),
    });
    expect(updateNotice({ kind: "ready", version: "0.17.0" }, zh)).toEqual({
      title: zhCN.tray.readyTitle,
      body: zhCN.tray.ready.replace("{version}", "0.17.0"),
    });
  });

  it("distinguishes service updates (web/backend) from client major updates (shell) in EN and zh-CN", () => {
    const zh = translator("zh-CN");
    for (const scope of ["web", "backend"] as const) {
      expect(
        menu({
          status: { tone: "online", label: "Online" },
          preventSleep: false,
          enrolled: true,
          update: { kind: "ready", version: "0.1.10-v2test.1", scope },
        })[1],
      ).toEqual({
        kind: "action",
        action: "install-update",
        label: "Update Services",
      });
      expect(
        menu({
          status: { tone: "online", label: "Online" },
          preventSleep: false,
          enrolled: true,
          update: { kind: "downloading", version: "0.1.10-v2test.1", scope },
        })[1],
      ).toEqual({
        kind: "label",
        label: "Downloading Service Update…",
      });
      expect(
        menu({
          status: { tone: "busy", label: "Running 1 Task" },
          preventSleep: false,
          enrolled: true,
          update: { kind: "waiting", version: "0.1.10-v2test.1", scope },
        })[1],
      ).toEqual({
        kind: "label",
        label: "Will Update Services When Tasks Finish",
      });
      expect(
        menu({
          status: { tone: "online", label: "Online" },
          preventSleep: false,
          enrolled: true,
          update: { kind: "installing", version: "0.1.10-v2test.1", scope },
        })[1],
      ).toEqual({
        kind: "label",
        label: "Updating Services…",
      });
      expect(
        trayMenu(
          {
            status: { tone: "online", label: zhCN.status.idle },
            preventSleep: false,
            enrolled: true,
            update: { kind: "ready", version: "0.1.10-v2test.1", scope },
          },
          zh,
        )[1],
      ).toEqual({
        kind: "action",
        action: "install-update",
        label: zhCN.tray.updateServices,
      });
    }

    // Shell major updates keep Restart to Update wording.
    expect(
      menu({
        status: { tone: "online", label: "Online" },
        preventSleep: false,
        enrolled: true,
        update: { kind: "ready", version: "0.2.0", scope: "shell" },
      })[1],
    ).toEqual({
      kind: "action",
      action: "install-update",
      label: "Restart to Update (0.2.0)",
    });
  });
});
