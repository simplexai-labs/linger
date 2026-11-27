// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import { describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubMessage } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { RoomSettingsPanel } from "./room-settings-panel";

const tenantId = "tenant-northstar";
const roomId = "room-all";
const messagesPath = "/v0/rooms/{roomId}/messages";

function renderSettings(roomName = "all") {
  const runtime = createTestTeamHubRuntime();
  runtime.seed.rooms.find((room) => room.id === roomId)!.name = roomName;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <RoomSettingsPanel roomId={roomId} tenantId={tenantId} />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return runtime.server;
}

function message(
  id: string,
  displayName: string,
  createdAt: string,
  body: string,
): TeamHubMessage {
  return {
    id,
    tenant_id: tenantId,
    room_id: roomId,
    author: {
      id,
      tenant_id: tenantId,
      kind: "human",
      display_name: displayName,
    },
    message_kind: "conversation",
    raw_message: body,
    segments: [{ type: "text", content: body }],
    attachments: [],
    created_at: createdAt,
  };
}

describe("Room Markdown export", () => {
  it.each([
    [
      "  Planning / R&D: \u9879\u76ee?  ",
      "Planning-R&D-\u9879\u76ee-room-all.md",
    ],
    [" / : ? . ", "room-all.md"],
  ])("exports only the latest page for Room %j", async (roomName, filename) => {
    const server = renderSettings(roomName);
    const firstBody =
      "**First**\r\n\r\n## Inside the message\n\n```ts\ncut off\n~~~~~  \n";
    server.on("GET", messagesPath, ({ query }) => {
      expect([...query]).toEqual([["limit", "50"]]);
      return {
        items: [
          message("first", "A_[Team]", "2026-11-24T06:30:00Z", firstBody),
          message("second", "B", "2026-11-24T06:31:00Z", "Second"),
        ],
        page: { has_more: true, next_cursor: "first" },
        snapshot_room_seq: 53,
      };
    });
    const createUrl = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:room-export");
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);

    const exportButton = await screen.findByRole("button", {
      name: "Export recent messages (.md)",
    });
    expect(server.requestsTo("GET", messagesPath)).toHaveLength(0);
    fireEvent.click(exportButton);

    await waitFor(() => expect(click).toHaveBeenCalledOnce());
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.download).toBe(filename);
    const blob = createUrl.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe("text/markdown;charset=utf-8");
    const markdown = await blob.text();
    expect(markdown).toBe(
      `## A\\_\\[Team\\] · 2026-11-24T06:30:00Z\n\n~~~~~~\n${firstBody}~~~~~~\n\n` +
        "## B · 2026-11-24T06:31:00Z\n\n~~~\nSecond\n~~~\n",
    );
    const preview = render(<ReactMarkdown>{markdown}</ReactMarkdown>);
    const headings = within(preview.container).getAllByRole("heading", {
      level: 2,
    });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "A_[Team] · 2026-11-24T06:30:00Z",
      "B · 2026-11-24T06:31:00Z",
    ]);
    expect(server.requestsTo("GET", messagesPath)).toHaveLength(1);
    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith("blob:room-export"),
    );
  });

  it("gives feedback on a failed read and can retry an empty Room", async () => {
    const server = renderSettings();
    server.on("GET", messagesPath, () => {
      throw new Error("Connection closed.");
    });
    const createUrl = vi.spyOn(URL, "createObjectURL");
    const exportButton = await screen.findByRole("button", {
      name: "Export recent messages (.md)",
    });
    fireEvent.click(exportButton);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not export recent messages.",
    );

    server.on("GET", messagesPath, () => ({
      items: [],
      page: { has_more: false },
      snapshot_room_seq: 0,
    }));
    fireEvent.click(exportButton);
    expect(
      await screen.findByText("There are no recent messages to export."),
    ).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(createUrl).not.toHaveBeenCalled();
  });
});
