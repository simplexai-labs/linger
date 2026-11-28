// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { expect, test, vi } from "vitest";

import { ByokCombobox } from "./byok-combobox";

function combobox(onCommit: () => void, onOpenChange: (open: boolean) => void) {
  return render(
    <ByokCombobox
      disabled={false}
      id="endpoint"
      label="Endpoint"
      onCommit={onCommit}
      onOpenChange={onOpenChange}
      onValueChange={() => {}}
      open
      options={[]}
      placeholder="https://"
      value=""
    />,
  );
}

test("keeps an Enter that picks an input method candidate from settling the value", () => {
  const onCommit = vi.fn();
  const onOpenChange = vi.fn();
  const view = combobox(onCommit, onOpenChange);
  const field = view.getByRole("combobox");
  // Browsers report the Enter that picks a candidate as the 229 key code.
  fireEvent.keyDown(field, { key: "Enter", keyCode: 229 });
  expect(onCommit).not.toHaveBeenCalled();
  expect(onOpenChange).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledTimes(1);
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
