import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  COMPUTER_PICKER_SEARCH_THRESHOLD,
  ComputerPicker,
  filterComputerPickerOptions,
  orderComputerPickerOptions,
  type ComputerPickerOption,
} from "./computer-picker";

function makeFleet(
  count: number,
  offlineIndices: readonly number[] = [],
): ComputerPickerOption[] {
  const offlineSet = new Set(offlineIndices);
  return Array.from({ length: count }, (_, index) => ({
    computerId: `comp-${index + 1}`,
    displayName: `node-${String(index + 1).padStart(2, "0")}`,
    online: !offlineSet.has(index),
  }));
}

describe("ComputerPicker", () => {
  it("stays compact without search or filter controls at or below the threshold", () => {
    const onSelect = vi.fn();
    const options: ComputerPickerOption[] = [
      { computerId: "comp-off", displayName: "Old Laptop", online: false },
      { computerId: "comp-a", displayName: "Mac Studio", online: true },
      { computerId: "comp-b", displayName: "lab-241", online: true },
    ];
    render(
      <ComputerPicker onSelect={onSelect} options={options} value="comp-a" />,
    );

    const trigger = screen.getByRole("combobox", { name: "Computer" });
    expect(trigger).toHaveTextContent("Mac Studio");

    fireEvent.click(trigger);

    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      screen.queryByRole("group", { name: "Filter computers by status" }),
    ).toBeNull();

    // Online computers are ordered ahead of offline ones.
    const renderedOptions = screen.getAllByRole("option");
    expect(
      renderedOptions.map((node) => node.getAttribute("aria-label")),
    ).toEqual(["Mac Studio", "lab-241", "Old Laptop · Offline"]);

    fireEvent.click(screen.getByRole("option", { name: "lab-241" }));
    expect(onSelect).toHaveBeenCalledWith("comp-b");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("reveals search and All / Online / Offline filtering when more than 10 computers exist", () => {
    const options = makeFleet(COMPUTER_PICKER_SEARCH_THRESHOLD + 2, [1, 5, 9]);
    function Harness() {
      const [selected, setSelected] = useState("comp-1");
      return (
        <ComputerPicker
          onSelect={setSelected}
          options={options}
          value={selected}
        />
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("combobox", { name: "Computer" });
    fireEvent.click(trigger);

    const search = screen.getByRole("searchbox", { name: "Search computers" });
    const filters = screen.getByRole("group", {
      name: "Filter computers by status",
    });
    expect(
      within(filters).getByRole("button", { name: /All\s*12/u }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(filters).getByRole("button", { name: /Online\s*9/u }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      within(filters).getByRole("button", { name: /Offline\s*3/u }),
    ).toHaveAttribute("aria-pressed", "false");

    // Filter to offline computers only.
    fireEvent.click(
      within(filters).getByRole("button", { name: /Offline\s*3/u }),
    );
    expect(
      screen
        .getAllByRole("option")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["node-02 · Offline", "node-06 · Offline", "node-10 · Offline"]);

    // Filter to online computers and search by substring.
    fireEvent.click(
      within(filters).getByRole("button", { name: /Online\s*9/u }),
    );
    fireEvent.change(search, { target: { value: "node-11" } });
    expect(
      screen
        .getAllByRole("option")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["node-11"]);

    // Keyboard Enter commits the highlighted filtered option directly from search.
    fireEvent.keyDown(search, { key: "Enter" });
    expect(trigger).toHaveTextContent("node-11");
    expect(screen.queryByRole("listbox")).toBeNull();

    // Reopening resets search and status filter back to defaults.
    fireEvent.click(trigger);
    expect(
      screen.getByRole("searchbox", { name: "Search computers" }),
    ).toHaveValue("");
    expect(
      within(
        screen.getByRole("group", { name: "Filter computers by status" }),
      ).getByRole("button", { name: /All\s*12/u }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("supports keyboard navigation from the search box and clears empty filter results", () => {
    const onSelect = vi.fn();
    const options = [
      ...makeFleet(10),
      {
        computerId: "comp-win",
        displayName: "home-win-rtx4060ti",
        online: true,
      },
      {
        computerId: "comp-lab",
        displayName: "lab-241-gpu1-4090d",
        online: true,
      },
    ];
    render(
      <ComputerPicker onSelect={onSelect} options={options} value="comp-1" />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Computer" }));
    const search = screen.getByRole("searchbox", { name: "Search computers" });

    // Empty state offers a one-click reset.
    fireEvent.change(search, { target: { value: "does-not-exist" } });
    expect(
      screen.getByText('No computers match "does-not-exist".'),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(search).toHaveValue("");
    expect(screen.getAllByRole("option")).toHaveLength(12);

    // Search for "-gpu" or "rtx", then arrow through matching items.
    fireEvent.change(search, { target: { value: "comp-" } });
    fireEvent.change(search, { target: { value: "40" } });
    expect(
      screen
        .getAllByRole("option")
        .map((node) => node.getAttribute("aria-label")),
    ).toEqual(["home-win-rtx4060ti", "lab-241-gpu1-4090d"]);

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("comp-lab");
  });

  it("orders online computers first and filters by display name or computer id", () => {
    const ordered = orderComputerPickerOptions([
      { computerId: "c-1", displayName: "Alpha", online: false },
      { computerId: "c-2", displayName: "Beta", online: true },
      { computerId: "c-3", displayName: "Gamma", online: false },
      { computerId: "c-4", displayName: "Delta", online: true },
    ]);
    expect(ordered.map((item) => item.computerId)).toEqual([
      "c-2",
      "c-4",
      "c-1",
      "c-3",
    ]);

    expect(
      filterComputerPickerOptions(ordered, { query: "c-3", status: "all" }).map(
        (item) => item.computerId,
      ),
    ).toEqual(["c-3"]);
    expect(
      filterComputerPickerOptions(ordered, {
        query: "",
        status: "online",
      }).map((item) => item.computerId),
    ).toEqual(["c-2", "c-4"]);
  });

  it("closes on Escape and outside click without resubscribing listeners on callback rerender or filtering", () => {
    const options = makeFleet(12, [2]);
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    const origShow = HTMLElement.prototype.showPopover;
    const origHide = HTMLElement.prototype.hidePopover;
    HTMLElement.prototype.showPopover = showPopover;
    HTMLElement.prototype.hidePopover = hidePopover;

    const addDocListener = vi.spyOn(document, "addEventListener");
    const removeDocListener = vi.spyOn(document, "removeEventListener");
    const addWinListener = vi.spyOn(window, "addEventListener");
    const removeWinListener = vi.spyOn(window, "removeEventListener");

    try {
      const { rerender, unmount } = render(
        <ComputerPicker onSelect={vi.fn()} options={options} value="comp-1" />,
      );
      const trigger = screen.getByRole("combobox", { name: "Computer" });
      fireEvent.click(trigger);
      // jsdom does not implement :popover-open when showPopover is stubbed, so query with hidden: true.
      expect(screen.getByRole("listbox", { hidden: true })).toBeInTheDocument();
      expect(showPopover).toHaveBeenCalledTimes(1);
      expect(hidePopover).not.toHaveBeenCalled();

      addDocListener.mockClear();
      removeDocListener.mockClear();
      addWinListener.mockClear();
      removeWinListener.mockClear();
      showPopover.mockClear();

      rerender(
        <ComputerPicker onSelect={vi.fn()} options={options} value="comp-1" />,
      );
      // Typing a query that shrinks the list must not toggle the top-layer popover or resubscribe listeners.
      fireEvent.change(
        screen.getByRole("searchbox", {
          hidden: true,
          name: "Search computers",
        }),
        { target: { value: "node-11" } },
      );

      expect(showPopover).not.toHaveBeenCalled();
      expect(hidePopover).not.toHaveBeenCalled();
      expect(addDocListener).not.toHaveBeenCalledWith(
        "pointerdown",
        expect.any(Function),
        true,
      );
      expect(removeDocListener).not.toHaveBeenCalledWith(
        "pointerdown",
        expect.any(Function),
        true,
      );
      expect(addWinListener).not.toHaveBeenCalledWith(
        "resize",
        expect.any(Function),
      );
      expect(removeWinListener).not.toHaveBeenCalledWith(
        "resize",
        expect.any(Function),
      );

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByRole("listbox", { hidden: true })).toBeNull();
      expect(hidePopover).toHaveBeenCalledTimes(1);
      unmount();
    } finally {
      HTMLElement.prototype.showPopover = origShow;
      HTMLElement.prototype.hidePopover = origHide;
      addDocListener.mockRestore();
      removeDocListener.mockRestore();
      addWinListener.mockRestore();
      removeWinListener.mockRestore();
    }
  });

  it("dismisses on outside click and swallows the follow-up click without invoking an underlying button", () => {
    const onUnderlyingClick = vi.fn();
    const options: ComputerPickerOption[] = [
      { computerId: "comp-a", displayName: "Mac Studio", online: true },
      { computerId: "comp-b", displayName: "lab-241", online: true },
    ];
    render(
      <div>
        <ComputerPicker onSelect={vi.fn()} options={options} value="comp-a" />
        <button onClick={onUnderlyingClick} type="button">
          Recheck memory
        </button>
      </div>,
    );

    const trigger = screen.getByRole("combobox", { name: "Computer" });
    const recheck = screen.getByRole("button", { name: "Recheck memory" });

    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.pointerDown(recheck, { button: 0, pointerId: 1 });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.pointerUp(recheck, { button: 0, pointerId: 1 });
    fireEvent.click(recheck, { button: 0 });
    expect(onUnderlyingClick).not.toHaveBeenCalled();

    fireEvent.pointerDown(recheck, { button: 0, pointerId: 2 });
    fireEvent.pointerUp(recheck, { button: 0, pointerId: 2 });
    fireEvent.click(recheck, { button: 0 });
    expect(onUnderlyingClick).toHaveBeenCalledTimes(1);
  });
});
