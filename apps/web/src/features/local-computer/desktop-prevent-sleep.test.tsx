import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DesktopPreventSleep } from "./desktop-prevent-sleep";

function setDesktop(lingerDesktop: unknown) {
  Object.assign(window, { lingerDesktop });
}

afterEach(() => {
  cleanup();
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
});

describe("DesktopPreventSleep", () => {
  it("is absent in a browser", () => {
    const { container } = render(<DesktopPreventSleep />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is absent in an older desktop app without preventSleep in settings", async () => {
    const get = vi.fn(async () => ({
      serverUrl: "http://127.0.0.1:3000",
      displayName: "Desk",
    }));
    const set = vi.fn();
    setDesktop({ settings: { get, set } });
    const { container } = render(<DesktopPreventSleep />);
    await waitFor(() => expect(get).toHaveBeenCalledOnce());
    expect(container).toBeEmptyDOMElement();
  });

  it("reads, toggles, and reports failures without resubscribing on rerenders", async () => {
    let listener: ((settings: { preventSleep?: boolean }) => void) | undefined;
    const unsubscribe = vi.fn();
    const get = vi.fn(async () => ({ preventSleep: false }));
    const set = vi
      .fn<
        (patch: { preventSleep: boolean }) => Promise<{ preventSleep: boolean }>
      >()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce({ preventSleep: true });
    const onChange = vi.fn(
      (callback: (settings: { preventSleep?: boolean }) => void) => {
        listener = callback;
        return unsubscribe;
      },
    );
    setDesktop({ settings: { get, set, onChange } });

    const { rerender, unmount } = render(
      <DesktopPreventSleep
        renderGroup={(content) => <div data-render="1">{content}</div>}
      />,
    );
    const toggle = await screen.findByRole("switch", { name: "Prevent sleep" });
    expect(toggle).not.toBeChecked();
    expect(onChange).toHaveBeenCalledOnce();

    // Unrelated rerenders must not resubscribe or re-fetch.
    rerender(
      <DesktopPreventSleep
        renderGroup={(content) => <div data-render="2">{content}</div>}
      />,
    );
    expect(get).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledOnce();

    // A rejected update shows an error and leaves the switch unchanged.
    fireEvent.click(toggle);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not update sleep setting. Try again.",
    );
    expect(toggle).not.toBeChecked();

    // Retrying succeeds and clears the error.
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    expect(set).toHaveBeenLastCalledWith({ preventSleep: true });
    expect(screen.queryByRole("alert")).toBeNull();

    // Changes from the tray sync live into the Settings toggle.
    act(() => listener?.({ preventSleep: false }));
    expect(toggle).not.toBeChecked();

    unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("ignores a stale initial get response after a newer onChange update", async () => {
    let resolveGet!: (value: { preventSleep: boolean }) => void;
    let listener: ((settings: { preventSleep?: boolean }) => void) | undefined;
    const get = vi.fn(
      () =>
        new Promise<{ preventSleep: boolean }>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const set = vi.fn();
    const onChange = vi.fn(
      (callback: (settings: { preventSleep?: boolean }) => void) => {
        listener = callback;
        return () => {};
      },
    );
    setDesktop({ settings: { get, set, onChange } });

    render(<DesktopPreventSleep />);
    act(() => listener?.({ preventSleep: true }));
    const toggle = await screen.findByRole("switch", { name: "Prevent sleep" });
    expect(toggle).toBeChecked();

    await act(async () => {
      resolveGet({ preventSleep: false });
    });
    expect(toggle).toBeChecked();
  });
});
