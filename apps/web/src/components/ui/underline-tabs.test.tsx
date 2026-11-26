import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  MeetingReader,
  type MeetingTab,
} from "@/features/memory/meeting-reader";
import { RoomInfoPanel } from "@/features/rooms/task-sidebar/room-info-panel";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMemoryEntry } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { UnderlineTabs } from "./underline-tabs";

function ControlledUnderlineTabs({
  includeDisabled = false,
}: {
  includeDisabled?: boolean;
}) {
  const [value, setValue] = useState<"files" | "members" | "settings">("files");
  return (
    <UnderlineTabs
      items={[
        { id: "files", label: "Files" },
        { disabled: includeDisabled, id: "members", label: "Members" },
        { id: "settings", label: "Settings" },
      ]}
      label="Workspace sections"
      onChange={setValue}
      value={value}
    />
  );
}

describe("UnderlineTabs", () => {
  it("supports roving tabindex and Arrow/Home/End keyboard navigation with wrapping", () => {
    render(<ControlledUnderlineTabs />);

    const files = screen.getByRole("tab", { name: "Files" });
    const members = screen.getByRole("tab", { name: "Members" });
    const settings = screen.getByRole("tab", { name: "Settings" });

    expect(files).toHaveAttribute("tabindex", "0");
    expect(members).toHaveAttribute("tabindex", "-1");
    expect(settings).toHaveAttribute("tabindex", "-1");

    files.focus();
    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(members).toHaveAttribute("aria-selected", "true");
    expect(members).toHaveAttribute("tabindex", "0");
    expect(files).toHaveAttribute("tabindex", "-1");
    expect(members).toHaveFocus();

    fireEvent.keyDown(members, { key: "End" });
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();

    fireEvent.keyDown(settings, { key: "ArrowRight" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveFocus();

    fireEvent.keyDown(files, { key: "ArrowLeft" });
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();

    fireEvent.keyDown(settings, { key: "Home" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveFocus();
  });

  it("skips disabled tabs during keyboard navigation", () => {
    render(<ControlledUnderlineTabs includeDisabled />);

    const files = screen.getByRole("tab", { name: "Files" });
    const members = screen.getByRole("tab", { name: "Members" });
    const settings = screen.getByRole("tab", { name: "Settings" });

    expect(members).toBeDisabled();
    files.focus();
    fireEvent.keyDown(files, { key: "ArrowRight" });
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();

    fireEvent.keyDown(settings, { key: "ArrowLeft" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveFocus();
  });
});

describe("custom tablists WAI-ARIA keyboard navigation", () => {
  it("navigates RoomInfoPanel tabs with roving tabindex and arrow keys", () => {
    render(<RoomInfoPanel documents={[]} members={[]} roomName="Design" />);

    const agents = screen.getByRole("tab", { name: /^agents$/i });
    const files = screen.getByRole("tab", { name: /^files$/i });

    expect(agents).toHaveAttribute("tabindex", "0");
    expect(files).toHaveAttribute("tabindex", "-1");

    agents.focus();
    fireEvent.keyDown(agents, { key: "ArrowRight" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveAttribute("tabindex", "0");
    expect(agents).toHaveAttribute("tabindex", "-1");
    expect(files).toHaveFocus();

    fireEvent.keyDown(files, { key: "Home" });
    expect(agents).toHaveAttribute("aria-selected", "true");
    expect(agents).toHaveFocus();

    fireEvent.keyDown(agents, { key: "End" });
    expect(files).toHaveAttribute("aria-selected", "true");
    expect(files).toHaveFocus();
  });

  it("navigates MeetingReader tabs with roving tabindex and arrow keys", () => {
    const runtime = createTestTeamHubRuntime();
    const entry: TeamHubMemoryEntry = {
      content: "# Meeting\n\nSummary body",
      id: "mem_meeting_1",
      kind: "meeting",
      meeting: {
        capture_id: "cap_1",
        recording_document_id: "doc_rec",
        recording_filename: "recording.webm",
        recording_version_id: "ver_rec",
        started_at: "2026-06-15T09:30:00Z",
        summary_ready: false,
        transcript_document_id: "doc_tr",
        transcript_version_id: "ver_tr",
      },
      path: "meetings/2026-06-15-0930.md",
      summary: "Morning sync summary",
      title: "Morning sync",
      updated_at: "2026-06-15T09:30:00Z",
    };

    function Harness() {
      const [file, setFile] = useState<MeetingTab>("summary");
      return (
        <TeamHubRuntimeProvider runtime={runtime}>
          <MeetingReader
            entry={entry}
            file={file}
            onHidden={vi.fn()}
            onSelectTab={setFile}
            tenantId="tenant-northstar"
          />
        </TeamHubRuntimeProvider>
      );
    }

    render(<Harness />);

    const summary = screen.getByRole("tab", { name: "Summary" });
    const transcript = screen.getByRole("tab", { name: "Transcript" });

    expect(summary).toHaveAttribute("tabindex", "0");
    expect(transcript).toHaveAttribute("tabindex", "-1");

    summary.focus();
    fireEvent.keyDown(summary, { key: "ArrowRight" });
    expect(transcript).toHaveAttribute("aria-selected", "true");
    expect(transcript).toHaveAttribute("tabindex", "0");
    expect(summary).toHaveAttribute("tabindex", "-1");
    expect(transcript).toHaveFocus();

    fireEvent.keyDown(transcript, { key: "ArrowLeft" });
    expect(summary).toHaveAttribute("aria-selected", "true");
    expect(summary).toHaveFocus();
  });
});
