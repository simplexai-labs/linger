import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { VoiceLiveDraftRow } from "./voice-live-draft";

const actor = {
  id: "human-1",
  display_name: "Chen Xiaoming",
  kind: "human" as const,
  tenant_id: "tenant-1",
};

describe("VoiceLiveDraftRow", () => {
  it("renders the live ASR text on the current user's side without repeating identity", () => {
    render(
      <VoiceLiveDraftRow
        draft={{
          actor,
          statusLabel: "Listening · Sends when you finish speaking",
          text: "Hello, can you hear me?",
        }}
      />,
    );
    const row = screen.getByRole("article", { name: "Live voice draft" });
    expect(row).toHaveAttribute("data-current-actor", "true");
    expect(row.querySelector(".room-message-content")).not.toHaveTextContent(
      "Chen Xiaoming",
    );
    expect(
      screen.getByRole("img", { name: "Chen Xiaoming avatar" }),
    ).toBeVisible();
    expect(row).toHaveTextContent("Hello, can you hear me?");
    expect(row).not.toHaveTextContent(
      "Listening · Sends when you finish speaking",
    );
    expect(row.hasAttribute("data-message-id")).toBe(false);
  });

  it("fades in each new phrase as the voice window does, keeping earlier words", () => {
    const draft = { actor, statusLabel: "Listening", text: "Hello" };
    const view = render(<VoiceLiveDraftRow draft={draft} />);
    const row = screen.getByRole("article", { name: "Live voice draft" });
    expect(row.querySelector(".room-message-bubble")).toHaveClass(
      "voice-live-fade-in",
    );
    view.rerender(
      <VoiceLiveDraftRow
        draft={{ ...draft, text: "Hello, can you hear me?" }}
      />,
    );
    const fading = row.querySelectorAll("p .voice-live-fade-in");
    expect([...fading].map((piece) => piece.textContent)).toEqual([
      ", can you hear me?",
    ]);
    expect(row).toHaveTextContent("Hello, can you hear me?");
  });

  it("does not render an empty listening row", () => {
    const { container } = render(
      <VoiceLiveDraftRow
        draft={{
          actor,
          statusLabel: "Listening · Sends when you finish speaking",
          text: "",
        }}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the bubble visible with an error while preserving the recognized text", () => {
    render(
      <VoiceLiveDraftRow
        draft={{
          actor,
          error: "Voice Runtime stopped before readiness",
          statusLabel: "Voice input stopped",
          text: "This text must stay",
        }}
      />,
    );
    expect(
      screen.getByRole("article", { name: "Live voice draft" }),
    ).toHaveTextContent("This text must stay");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Voice Runtime stopped before readiness",
    );
  });
});
