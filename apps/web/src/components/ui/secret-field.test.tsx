import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SecretField, SecretInput } from "./secret-field";

describe("SecretField", () => {
  it("toggles secret visibility with an accessible eye button", () => {
    render(
      <SecretField
        hint="Stored encrypted."
        label="API key"
        onChange={() => undefined}
        value="sk-secret-123"
      />,
    );

    const input = screen.getByLabelText("API key");
    expect(input).toHaveAttribute("type", "password");
    expect(screen.getByText("Stored encrypted.")).toBeVisible();

    const toggle = screen.getByRole("button", { name: "Show value" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(toggle);
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Mask value" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "Mask value" }));
    expect(input).toHaveAttribute("type", "password");
  });

  it("disables the toggle when the input is disabled", () => {
    render(
      <SecretInput
        aria-label="Token"
        disabled
        onChange={() => undefined}
        value="tok-123"
      />,
    );

    expect(screen.getByLabelText("Token")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show value" })).toBeDisabled();
  });
});
