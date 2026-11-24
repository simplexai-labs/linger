import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubMemoryEntry,
  TeamHubMessageMeetingNotesSegment,
  TeamHubVoiceCapture,
} from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { MessageMeetingNotes } from "./message-meeting-notes";

type QuickNotes = NonNullable<TeamHubVoiceCapture["quick_notes"]>;

const segment: TeamHubMessageMeetingNotesSegment = {
  type: "meeting_notes",
  content: "Meeting summary",
  capture_id: "capture_launch",
};

const ready: QuickNotes = {
  state: "ready",
  title: "Launch review",
  sections: [
    { heading: "Plan", bullets: ["Ship Friday", "Record the demo"] },
    { heading: "Open questions", bullets: ["Who owns pricing"] },
  ],
};

function capture(quickNotes: QuickNotes): TeamHubVoiceCapture {
  return {
    id: "capture_launch",
    voice_session_id: "voice_session_1",
    room_id: "room_1",
    status: "finalized",
    requested_start_offset_ms: 0,
    gap_count: 0,
    gap_duration_ms: 0,
    created_at: "2026-10-01T08:00:00Z",
    updated_at: "2026-10-01T08:30:00Z",
    quick_notes: quickNotes,
  };
}

function meeting(summaryReady: boolean): TeamHubMemoryEntry {
  return {
    id: "meeting_launch",
    kind: "meeting",
    title: "Meeting 17-41-02",
    path: "Meetings/2026/10/01/Meeting 17-41-02",
    content: "",
    summary: "",
    updated_at: "2026-10-01T08:00:00Z",
    meeting: {
      capture_id: "capture_launch",
      started_at: "2026-10-01T08:00:00Z",
      recording_document_id: "audio",
      recording_version_id: "audio_v1",
      recording_filename: "source.m4a",
      transcript_document_id: "transcript",
      transcript_version_id: "transcript_v1",
      summary_ready: summaryReady,
    },
  };
}

function renderNotes(
  state: { notes: QuickNotes; meetings: TeamHubMemoryEntry[] },
  onCapture = () => {},
) {
  const runtime = createTestTeamHubRuntime();
  runtime.server.on("GET", "/v0/voice-captures/{captureSessionId}", () => {
    onCapture();
    return capture(state.notes);
  });
  runtime.server.on("GET", "/v0/tenants/{tenantId}/memory", ({ query }) => ({
    items: query.get("kind") === "meeting" ? state.meetings : [],
  }));
  const router = createMemoryRouter(
    [
      {
        element: (
          <MessageMeetingNotes segment={segment} tenantId="tenant-northstar" />
        ),
        path: "/t/:tenantId/rooms/:roomId",
      },
    ],
    { initialEntries: ["/t/tenant-northstar/rooms/room_1"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <RouterProvider router={router} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MessageMeetingNotes", () => {
  it("shows progress while the notes are written and where the full notes appear", async () => {
    renderNotes({ notes: { state: "pending" }, meetings: [] });
    expect(
      await screen.findByText("Pulling the key points out of the transcript…"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Library › Meetings" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/library/meetings");
  });

  it("shows the notes once written and stops looking again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const state = {
      notes: { state: "pending" } as QuickNotes,
      meetings: [] as TeamHubMemoryEntry[],
    };
    let reads = 0;
    renderNotes(state, () => {
      reads += 1;
    });
    await screen.findByText("Pulling the key points out of the transcript…");
    state.notes = ready;
    await vi.advanceTimersByTimeAsync(3_500);
    expect(
      await screen.findByRole("heading", { name: "Launch review" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Record the demo")).toBeInTheDocument();
    expect(screen.getByText("Who owns pricing")).toBeInTheDocument();
    const onceReady = reads;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(onceReady);
  });

  it("stops waiting for notes that stay pending past the job's attempts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    renderNotes({ notes: { state: "pending" }, meetings: [] }, () => {
      reads += 1;
    });
    await screen.findByText("Pulling the key points out of the transcript…");
    await vi.advanceTimersByTimeAsync(305_000);
    await waitFor(() =>
      expect(
        screen.queryByText("Pulling the key points out of the transcript…"),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("link", { name: "Library › Meetings" }),
    ).toBeInTheDocument();
    const afterGivingUp = reads;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reads).toBe(afterGivingUp);
  });

  it("leaves out notes that could not be written", async () => {
    renderNotes({ notes: { state: "failed" }, meetings: [] });
    await waitFor(() =>
      expect(
        screen.queryByText("Pulling the key points out of the transcript…"),
      ).toBeNull(),
    );
    expect(screen.queryByText("Meeting summary")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Library › Meetings" }),
    ).toBeInTheDocument();
  });

  it("links to the full notes once they are written", async () => {
    renderNotes({ notes: ready, meetings: [meeting(true)] });
    expect(
      await screen.findByText("Full meeting notes are ready"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/t/tenant-northstar/library/meetings?entry=meeting_launch",
    );
  });
});
