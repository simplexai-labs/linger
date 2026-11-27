// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import {
  formatLocale,
  resetLanguageForTest,
  setLanguage,
} from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import { formatDateTime } from "@/lib/date-format";
import {
  acceptRoomUpdates,
  createTestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

import { RoomSettingsPanel } from "./room-settings-panel";
import { RoomHistoryShareDialog } from "./sharing/room-history-share-dialog";

const words = zhCN.roomSettings;

describe("Room settings in the language on screen", () => {
  afterEach(() => {
    resetLanguageForTest();
  });

  it("says in one sentence that a rename was not confirmed", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    acceptRoomUpdates(runtime);
    runtime.server.on("PATCH", "/v0/rooms/{roomId}", () => {
      throw new Error("Connection closed before confirmation.");
    });

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <RoomSettingsPanel roomId="room-all" tenantId="tenant-northstar" />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", {
        name: words.renameRoom.replace("{name}", "all"),
      }),
    );
    const name = screen.getByRole("textbox", { name: words.name });
    fireEvent.change(name, { target: { value: "release-room" } });
    fireEvent.blur(name);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      words.saveUnconfirmed,
    );
  });

  it("counts messages and dates a shared snapshot", async () => {
    await setLanguage("zh-CN");
    const createdAt = "2026-09-22T06:30:03.000Z";
    const client = {
      roomHistory: {
        list: vi.fn().mockResolvedValue({
          items: [
            {
              id: "share_1",
              room_name: "Room",
              created_at: createdAt,
              message_count: 2,
              snapshot_room_seq: 4,
            },
          ],
        }),
        create: vi.fn(),
        link: vi.fn(),
        revoke: vi.fn(),
      },
    } as unknown as TeamHubClient;

    render(
      <QueryClientProvider client={new QueryClient()}>
        <TeamHubRuntimeProvider runtime={{ client } as never}>
          <RoomHistoryShareDialog onClose={vi.fn()} roomId="room_1" />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("dialog", { name: words.shareConversation }),
    ).toBeVisible();
    expect(
      await screen.findByText(words.messageCount.other.replace("{count}", "2")),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: words.revoke })).toBeVisible();
    const date = formatDateTime(createdAt, undefined, formatLocale("zh-CN"));
    expect(
      screen.getByRole("button", {
        name: words.openSharedLinkFrom.replace("{date}", date),
      }),
    ).toBeVisible();
  });
});
