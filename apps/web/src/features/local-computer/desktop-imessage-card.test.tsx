import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopIMessageCard } from "./desktop-imessage-card";
import type {
  DesktopIMessageApi,
  DesktopIMessageStatus,
} from "./desktop-imessage";

const STATUS: DesktopIMessageStatus = {
  enabled: false,
  handles: [],
  runtime: "missing",
  fullDisk: "denied",
  messagesAutomation: "unknown",
  iMessageSignedIn: "unknown",
  ready: false,
  bridge: "stopped",
};

function install(status: Partial<DesktopIMessageStatus> = {}) {
  let push: (next: DesktopIMessageStatus) => void = () => {};
  const current = { ...STATUS, ...status };
  const api = {
    getStatus: vi.fn(async () => current),
    onStatus: vi.fn((callback: (next: DesktopIMessageStatus) => void) => {
      push = callback;
      return () => {};
    }),
    set: vi.fn(async (patch: { enabled?: boolean }) => ({
      ok: true as const,
      status: { ...current, ...patch },
    })),
    act: vi.fn(async () => current),
  } satisfies DesktopIMessageApi;
  (window as { lingerDesktop?: unknown }).lingerDesktop = { imessage: api };
  return { api, push: (next: DesktopIMessageStatus) => push(next) };
}

afterEach(() => {
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

describe("DesktopIMessageCard", () => {
  it("renders nothing without the desktop iMessage API", () => {
    (window as { lingerDesktop?: unknown }).lingerDesktop = {};
    const { container } = render(<DesktopIMessageCard />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows each setup step and its action", async () => {
    const { api } = install({
      enabled: true,
      runtime: "failed",
      runtimeError: "checksum_mismatch",
    });
    render(<DesktopIMessageCard />);
    expect(
      await screen.findByText(
        "Chat with Another Me from Messages on this Mac.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("The download was damaged. Retry.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.act).toHaveBeenCalledWith("retry_install");
    fireEvent.click(screen.getByRole("button", { name: "Open Settings" }));
    expect(api.act).toHaveBeenCalledWith("open_full_disk_settings");
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(api.act).toHaveBeenCalledWith("request_automation");
    expect(
      screen.getByText("Checked once Linger can control Messages"),
    ).toBeVisible();
  });

  it("follows pushed status and offers settings once control is denied", async () => {
    const { push } = install({ enabled: true });
    render(<DesktopIMessageCard />);
    await screen.findByText("Control Messages");
    act(() =>
      push({
        ...STATUS,
        enabled: true,
        runtime: "installing",
        fullDisk: "granted",
        messagesAutomation: "denied",
        iMessageSignedIn: "no",
      }),
    );
    expect(screen.getByText("Installing…")).toBeVisible();
    expect(
      screen.getByText("Turn on Messages for Linger under Automation"),
    ).toBeVisible();
    expect(
      screen.getByText("Sign in to iMessage in the Messages app"),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: "Allow" })).toBeNull();
  });

  it("turns iMessage on through the desktop API", async () => {
    const { api } = install();
    render(<DesktopIMessageCard />);
    const toggle = await screen.findByRole("switch", { name: "Use iMessage" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText("Setup")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(toggle);
    expect(api.set).toHaveBeenCalledWith({ enabled: true });
    await vi.waitFor(() =>
      expect(toggle).toHaveAttribute("aria-checked", "true"),
    );
    expect(screen.getByText("Setup")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Phone number or email" }),
    ).toBeVisible();
  });

  it("shows why a handle was rejected", async () => {
    const { api } = install({ enabled: true });
    api.set.mockResolvedValueOnce({
      ok: false,
      code: "invalid_handle",
      message:
        '"12345" is not a phone number with country code (+...) or an email address.',
    } as never);
    render(<DesktopIMessageCard />);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Phone number or email" }),
      { target: { value: "12345" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(api.set).toHaveBeenCalledWith({ handles: ["12345"] });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Enter a phone number with its country code",
    );
  });

  it("says whether the bridge is connected", async () => {
    const { push } = install({ enabled: true });
    render(<DesktopIMessageCard />);
    expect(await screen.findByText("Finish setup below")).toBeVisible();
    act(() => push({ ...STATUS, enabled: true, bridge: "signed_out" }));
    expect(screen.getByText("Sign in to Linger to use iMessage")).toBeVisible();
    act(() => push({ ...STATUS, enabled: true, bridge: "no_another_me" }));
    expect(screen.getByText("Another Me is not set up yet")).toBeVisible();
    act(() => push({ ...STATUS, enabled: true, bridge: "other_account" }));
    expect(
      screen.getByText(
        "Signed in to a different account. Turn iMessage off and on to use it with this account.",
      ),
    ).toBeVisible();
    act(() => push({ ...STATUS, enabled: true, bridge: "running" }));
    expect(screen.getByText("Connected")).toBeVisible();
  });

  it("checks again when the window regains focus", async () => {
    const { api } = install();
    render(<DesktopIMessageCard />);
    await screen.findByRole("switch", { name: "Use iMessage" });
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(api.getStatus).toHaveBeenCalledTimes(2);
  });
});
