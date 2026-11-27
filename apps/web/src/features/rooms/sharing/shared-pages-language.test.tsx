// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

import { SharedRoomHistoryPage } from "./shared-room-history-page";

function open(
  runtime: TestTeamHubRuntime,
  path: string,
  page: React.ReactNode,
) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("pages opened from a shared link, in the language on screen", () => {
  afterEach(() => {
    resetLanguageForTest();
  });

  it("words a shared conversation and dates it in that language", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    const createdAt = "2026-09-21T00:00:00Z";
    vi.spyOn(runtime.client.roomHistory, "read").mockResolvedValue({
      share: {
        room_name: "Snapshot Room",
        message_count: 1,
        created_at: createdAt,
      },
      items: [
        {
          id: "message_1",
          position: 1,
          author: {
            id: "actor_1",
            tenant_id: "tenant_1",
            kind: "human",
            display_name: "Alice",
          },
          body: "Kept as sent",
          segments: [],
          created_at: createdAt,
          attachments: [],
        },
      ],
      next_after: 0,
    } as never);
    open(
      runtime,
      `/shared-room-history#room_share_${"a".repeat(43)}`,
      <SharedRoomHistoryPage />,
    );

    expect(
      await screen.findByRole("article", {
        name: zhCN.sharedConversation.messageFrom.replace("{name}", "Alice"),
      }),
    ).toBeVisible();
    const date = new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(createdAt));
    expect(
      screen.getByText(
        zhCN.sharedConversation.snapshotFrom.replace("{date}", date),
      ),
    ).toBeVisible();
    expect(screen.getByText("Kept as sent")).toBeVisible();
  });
});
