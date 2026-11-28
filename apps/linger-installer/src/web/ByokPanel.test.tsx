// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { ByokPanel, emptyByokDraft } from "./ByokPanel.js";

function panel(onDraftChange: (value: unknown) => void) {
  return render(
    <ByokPanel draft={emptyByokDraft} onDraftChange={onDraftChange} />,
  );
}

test("keeps an Enter that picks an input method candidate from committing the path", () => {
  const onDraftChange = vi.fn();
  const view = panel(onDraftChange);
  const path = view.getByRole("combobox", { name: "Path" });
  // ArrowDown opens the suggestion menu; commit closes it.
  fireEvent.keyDown(path, { key: "ArrowDown" });
  expect(path.getAttribute("aria-expanded")).toBe("true");
  // Browsers report the Enter that picks a candidate as the 229 key code.
  fireEvent.keyDown(path, { key: "Enter", keyCode: 229 });
  expect(path.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(path, { key: "Enter" });
  expect(path.getAttribute("aria-expanded")).toBe("false");
});
