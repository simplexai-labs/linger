import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AccountMenu } from "@/features/auth/account-menu";
import type { DesktopUpdateState } from "@/features/auth/desktop-update";
import type { TeamHubCurrentIdentity } from "@/features/teamhub/teamhub-types";

const identity = {
  account: { id: "account-1", email: "owner@linger.local" },
  actors: [{ id: "actor-1", tenant_id: "tenant-1", display_name: "owner" }],
} as unknown as TeamHubCurrentIdentity;

const desktop = window as { lingerDesktop?: unknown };

function installDesktop(state: DesktopUpdateState) {
  let listener: ((next: DesktopUpdateState) => void) | undefined;
  const off = vi.fn(() => {
    listener = undefined;
  });
  const update = {
    getState: vi.fn(async () => state),
    onState: vi.fn((callback: (next: DesktopUpdateState) => void) => {
      listener = callback;
      return off;
    }),
    install: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
  };
  desktop.lingerDesktop = { version: "0.1.3", update };
  return {
    update,
    off,
    push: (next: DesktopUpdateState) => act(() => listener?.(next)),
  };
}

function renderMenu() {
  return render(
    <AccountMenu
      identity={identity}
      tenantId="tenant-1"
      isPending={false}
      onLogout={vi.fn()}
      onNavigate={vi.fn()}
      onOpenSettings={vi.fn()}
    />,
  );
}

async function openMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
  return screen.getByRole("menu", { name: "Account menu" });
}

afterEach(() => {
  delete desktop.lingerDesktop;
});

describe("AccountMenu desktop update", () => {
  it("shows no version or update in a browser", async () => {
    renderMenu();
    const menu = await openMenu();
    expect(menu).not.toHaveTextContent("Version");
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Settings", "Log out"]);
  });

  it("shows only the version while there is no update", async () => {
    const { update } = installDesktop({ kind: "idle" });
    renderMenu();
    await vi.waitFor(() => expect(update.getState).toHaveBeenCalled());
    const menu = await openMenu();
    expect(menu).toHaveTextContent("Version 0.1.3");
    expect(screen.queryByTestId("account-update-dot")).toBeNull();
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Settings", "Log out"]);
  });

  it("follows the download to Restart to Update and marks the avatar", async () => {
    const { update, push } = installDesktop({
      kind: "downloading",
      version: "0.1.4",
    });
    renderMenu();
    const menu = await openMenu();
    await vi.waitFor(() =>
      expect(menu).toHaveTextContent("Downloading Linger 0.1.4…"),
    );
    expect(screen.queryByRole("menuitem", { name: "Restart to Update" })).toBe(
      null,
    );
    expect(screen.queryByTestId("account-update-dot")).toBeNull();

    push({ kind: "ready", version: "0.1.4" });
    expect(menu).toHaveTextContent("Linger 0.1.4 is ready to install");
    expect(screen.getByTestId("account-update-dot")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Restart to Update" }),
    );
    expect(update.install).toHaveBeenCalledOnce();
    expect(update.check).not.toHaveBeenCalled();
  });

  it("offers the download page for an update the app cannot apply", async () => {
    const { update } = installDesktop({ kind: "available", version: "0.1.4" });
    renderMenu();
    const menu = await openMenu();
    await vi.waitFor(() =>
      expect(menu).toHaveTextContent("Linger 0.1.4 is available"),
    );
    expect(screen.getByTestId("account-update-dot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Download Update" }));
    expect(update.install).toHaveBeenCalledOnce();
  });

  it("says why the update failed and checks again on Try Again", async () => {
    const { update } = installDesktop({
      kind: "failed",
      error: "Update package does not match its checksum",
    });
    renderMenu();
    const menu = await openMenu();
    await vi.waitFor(() =>
      expect(menu).toHaveTextContent(
        "Update failed: Update package does not match its checksum",
      ),
    );
    expect(screen.queryByTestId("account-update-dot")).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Try Again" }));
    expect(update.check).toHaveBeenCalledOnce();
    expect(update.install).not.toHaveBeenCalled();
  });

  it("shows the version of a desktop build without the update bridge", async () => {
    desktop.lingerDesktop = { version: "0.1.2" };
    renderMenu();
    const menu = await openMenu();
    expect(menu).toHaveTextContent("Version 0.1.2");
    expect(screen.queryByTestId("account-update-dot")).toBeNull();
  });

  it("subscribes once across rerenders and unsubscribes on unmount", async () => {
    const { update, off } = installDesktop({ kind: "idle" });
    const view = renderMenu();
    view.rerender(
      <AccountMenu
        identity={identity}
        tenantId="tenant-1"
        isPending
        onLogout={vi.fn()}
        onNavigate={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(update.onState).toHaveBeenCalledOnce();
    expect(off).not.toHaveBeenCalled();
    view.unmount();
    expect(off).toHaveBeenCalledOnce();
  });

  it("displays appVersion from update.getInfo and refreshes it after an update settles to idle", async () => {
    let appVersion = "0.1.10-v2test.0";
    const { update, push } = installDesktop({
      kind: "ready",
      version: "0.1.10-v2test.1",
    });
    (update as Record<string, unknown>).getInfo = vi.fn(async () => ({
      shellVersion: "0.1.10-v2test.0",
      appVersion,
      channel: "stable",
    }));

    renderMenu();
    const menu = await openMenu();
    await vi.waitFor(() =>
      expect(menu).toHaveTextContent("Version 0.1.10-v2test.0"),
    );

    appVersion = "0.1.10-v2test.1";
    push({ kind: "idle" });
    await vi.waitFor(() =>
      expect(menu).toHaveTextContent("Version 0.1.10-v2test.1"),
    );
  });

  it("distinguishes service updates (web/backend) from client major updates (shell)", async () => {
    const { update, push } = installDesktop({
      kind: "downloading",
      version: "0.1.10-v2test.1",
      scope: "web",
    });
    renderMenu();
    const menu = await openMenu();

    await vi.waitFor(() =>
      expect(menu).toHaveTextContent("Downloading service update…"),
    );

    push({ kind: "ready", version: "0.1.10-v2test.1", scope: "web" });
    expect(menu).toHaveTextContent("Service update available");
    expect(screen.getByTestId("account-update-dot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "Update Services" }));
    expect(update.install).toHaveBeenCalledOnce();

    const reopened = await openMenu();
    push({ kind: "waiting", version: "0.1.10-v2test.2", scope: "backend" });
    expect(reopened).toHaveTextContent(
      "Will update services when tasks finish",
    );

    push({ kind: "installing", version: "0.1.10-v2test.2", scope: "backend" });
    expect(reopened).toHaveTextContent("Updating services…");

    // Client major update (scope: "shell") keeps Restart to Update wording.
    push({ kind: "ready", version: "0.2.0", scope: "shell" });
    expect(reopened).toHaveTextContent("Linger 0.2.0 is ready to install");
    expect(
      screen.getByRole("menuitem", { name: "Restart to Update" }),
    ).toBeInTheDocument();
  });
});
