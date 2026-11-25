import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubWorkItem } from "@/features/teamhub/teamhub-types";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

import { WorkItemsPage } from "./work-items-page";

const words = zhCN.workItems;

function renderPage(runtime: TestTeamHubRuntime, entry: string) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[entry]}>
          <Suspense fallback={null}>
            <Routes>
              <Route
                element={<WorkItemsPage />}
                path="/t/:tenantId/dashboard"
              />
              <Route
                element={<WorkItemsPage />}
                path="/t/:tenantId/dashboard/:workItemId"
              />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("the Dashboard in the language on screen", () => {
  afterEach(() => {
    resetLanguageForTest();
  });

  it("words the board in Chinese and keeps the Work Items as written", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    const human = runtime.seed.identity.actors[0]!;
    const agent = runtime.seed.actors.find(
      (actor) => actor.id === "actor-codex",
    )!;
    runtime.seed.workItems = [
      workItem(human, {
        assignees: [
          {
            actor: agent,
            assigned_at: "2026-07-30T00:00:00Z",
            assigned_by: human,
          },
        ],
        origin_room_id: "room-all",
        title: "Ship release",
      }),
      workItem(human, {
        id: "workitem-task",
        kind: "task",
        number: 7,
        resolution: "not_planned",
        state: "resolved",
        title: "Retire old release",
      }),
    ];

    renderPage(runtime, "/t/tenant-northstar/dashboard");

    expect(
      await screen.findByRole("heading", { name: words.dashboard }),
    ).toBeVisible();
    expect(
      screen.getByText(words.itemCount.other.replace("{count}", "2")),
    ).toBeVisible();
    expect(screen.getByRole("group", { name: words.filters })).toBeVisible();
    expect(screen.getByLabelText(words.room)).toBeVisible();
    for (const column of [
      words.columnTodo,
      words.columnInProgress,
      words.columnDone,
      words.columnClosed,
    ]) {
      expect(screen.getByRole("region", { name: column })).toBeVisible();
    }

    const card = await screen.findByRole("link", { name: /Ship release/ });
    // Priorities and people come from TeamHub as they are.
    expect(within(card).getByText("High")).toBeVisible();
    expect(
      within(card).getByRole("group", {
        name: words.assignedTo.replace("{names}", "Codex"),
      }),
    ).toBeVisible();
    expect(
      within(card).getByText(words.issueNumber.replace("{number}", "42")),
    ).toBeVisible();
    expect(
      within(card).getByText(
        new Intl.DateTimeFormat("zh-CN", {
          day: "numeric",
          month: "short",
          timeZone: "UTC",
          year: "numeric",
        }).format(new Date("2026-07-30T00:00:00Z")),
      ),
    ).toBeVisible();
    // Folding a column only changes the view, so it carries no marker.
    const expand = screen.getByRole("button", { name: words.expandClosed });
    expect(expand).not.toHaveAttribute("data-voice-risk");
    fireEvent.click(expand);
    const task = screen.getByRole("link", { name: /Retire old release/ });
    expect(
      within(task).getByText(words.taskNumber.replace("{number}", "7")),
    ).toBeVisible();
    const collapse = screen.getByRole("button", { name: words.collapseClosed });
    expect(collapse).not.toHaveAttribute("data-voice-risk");
    fireEvent.click(collapse);
    expect(
      screen.getByRole("button", { name: words.expandClosed }),
    ).toBeVisible();
  });

  it("counts the Work Items the Room filter shows in Chinese", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    const human = runtime.seed.identity.actors[0]!;
    runtime.seed.workItems = [
      workItem(human, { origin_room_id: "room-all", title: "Here" }),
      workItem(human, {
        id: "workitem-elsewhere",
        origin_room_id: "room-gtm-launch",
        title: "Elsewhere",
      }),
    ];

    renderPage(runtime, "/t/tenant-northstar/dashboard?room=room-all");

    expect(await screen.findByText("Here")).toBeVisible();
    expect(
      screen.getByText(
        words.filteredCount.replace("{shown}", "1").replace("{count}", "2"),
      ),
    ).toBeVisible();
  });

  it("shows an empty board in Chinese", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    runtime.seed.workItems = [];

    renderPage(runtime, "/t/tenant-northstar/dashboard");

    expect(await screen.findByText(words.noWorkItems)).toBeVisible();
    expect(
      screen.getByText(words.itemCount.other.replace("{count}", "0")),
    ).toBeVisible();
  });

  it("words the Work Item detail drawer and comments in Chinese with Voice Mode markers", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    const human = runtime.seed.identity.actors[0]!;
    runtime.seed.workItems = [
      workItem(human, {
        description: "",
        id: "workitem-detail-zh",
        kind: "task",
        number: 9,
        resolution: "not_planned",
        state: "resolved",
        task_execution: {
          control_revision: 1,
          control_settled_revision: 1,
          desired_control: "run",
          execution_revision: 2,
          execution_updated_at: "2026-07-30T01:00:00Z",
          generation: 1,
          pending_control: false,
          reason_code: "run_succeeded",
          status: "idle",
        },
        title: "Audit localized drawer",
      }),
    ];

    renderPage(runtime, "/t/tenant-northstar/dashboard/workitem-detail-zh");

    const detail = await screen.findByRole("complementary", {
      name: words.detailTitle,
    });
    expect(within(detail).getByText(words.noDescription)).toBeVisible();
    expect(within(detail).getByText(words.resolutionNotPlanned)).toBeVisible();
    expect(
      within(detail).getByText(words.executionFinishedAwaitingResolution),
    ).toBeVisible();
    expect(within(detail).getByText(words.unassigned)).toBeVisible();
    expect(await within(detail).findByText(words.noComments)).toBeVisible();
    expect(
      within(detail).getByRole("button", { name: words.closeDetail }),
    ).toHaveAttribute("data-voice-close");
    expect(
      within(detail).getByRole("button", { name: words.postComment }),
    ).toHaveAttribute("data-voice-risk", "never");
  });
});

function workItem(
  actor: TeamHubWorkItem["created_by"],
  override: Partial<TeamHubWorkItem> = {},
): TeamHubWorkItem {
  return {
    assignees: [],
    created_at: "2026-07-30T00:00:00Z",
    created_by: actor,
    description: "Email login returns 500.",
    explicit_access_grants: [],
    id: "workitem-login",
    kind: "issue",
    number: 42,
    priority: "high",
    referenced_actors: [],
    state: "open",
    tenant_id: "tenant-northstar",
    title: "Fix login failure",
    updated_at: "2026-07-30T00:00:00Z",
    updated_by: actor,
    version: 1,
    ...override,
  };
}
