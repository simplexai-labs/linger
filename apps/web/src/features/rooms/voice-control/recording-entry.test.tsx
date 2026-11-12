import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordingEntry } from "./recording-entry";
import {
  VoiceCapabilitiesContext,
  VoiceConnectionRetryContext,
} from "./voice-control-context";

vi.mock("./recording-window-store", () => ({ openRecordingWindow: vi.fn() }));

afterEach(cleanup);

function renderEntry(retryConnection?: () => void) {
  return render(
    <VoiceCapabilitiesContext value={undefined}>
      <VoiceConnectionRetryContext value={retryConnection}>
        <RecordingEntry
          anotherMeRoomId="another-me"
          tenantId="tenant-northstar"
        />
      </VoiceConnectionRetryContext>
    </VoiceCapabilitiesContext>,
  );
}

describe("RecordingEntry voice connection", () => {
  it("spins without offering a retry while voice connects", () => {
    renderEntry();
    const button = screen.getByRole("button", { name: "Meetings" });
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
  });

  it("retries a failed connection from the Meetings entry", () => {
    const retry = vi.fn();
    renderEntry(retry);
    const button = screen.getByRole("button", {
      name: "Retry voice connection",
    });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
