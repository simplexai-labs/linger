import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { AgentInfoContent } from "./agent-info-content";

async function setup(
  options: {
    runtime?: ReturnType<typeof createTestTeamHubRuntime>;
    agentName?: string;
    roomId?: string;
    onSaveName?: (name: string) => Promise<unknown>;
    onEditIdentity?: () => void;
  } = {},
) {
  const {
    runtime = createTestTeamHubRuntime(),
    agentName = "Codex",
    roomId,
    onSaveName,
    onEditIdentity,
  } = options;
  const registration = (await readTenantAgents(runtime)).items.find(
    (item) => item.actor.display_name === agentName,
  )!;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const content = (nameBusy: boolean) => (
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter>
          <AgentInfoContent
            canEditIdentity={Boolean(onEditIdentity)}
            canEditName={Boolean(onSaveName)}
            onEditIdentity={onEditIdentity}
            nameBusy={nameBusy}
            onSaveName={onSaveName}
            tenantId="tenant-northstar"
            actor={registration.actor}
            registration={registration}
            availability={{
              status: "online",
              label: "Online",
              active_task_count: 0,
            }}
            details={<p>Read-only Agent details</p>}
            roomId={roomId}
          />
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>
  );
  const view = render(content(false));
  return {
    runtime,
    registration,
    setNameBusy: (busy: boolean) => view.rerender(content(busy)),
  };
}

describe("Agent Info", () => {
  it("shows Details, Routines, and Connectors tabs", async () => {
    await setup();
    expect(await screen.findByRole("tab", { name: "Details" })).toBeVisible();
    const tabs = within(
      screen.getByRole("tablist", { name: "Agent settings" }),
    );
    expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Details",
      "Routines",
      "Connectors",
    ]);
    // Equal-width pills keep the middle tab under the name and do not stretch.
    for (const tab of tabs.getAllByRole("tab"))
      expect(tab).toHaveClass("rounded-full", "w-[92px]", "min-w-0");
    expect(tabs.getAllByRole("tab")[0]).not.toHaveClass("flex-1");
  });

  it("shows Connectors directly without a collapsible section", async () => {
    await setup();
    expect(await screen.findByText("Online")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(await screen.findByRole("region", { name: "Gmail" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connectors" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Runtime" })).toBeNull();
  });

  it("explains routines are per Room when opened outside a Room", async () => {
    await setup();
    fireEvent.click(await screen.findByRole("tab", { name: "Routines" }));
    expect(
      await screen.findByText(
        "Open this Agent from a Room to see its routines there.",
      ),
    ).toBeVisible();
  });

  it("reuses the Room routines panel scoped to routines the Agent created or executes", async () => {
    const runtime = createTestTeamHubRuntime();
    const registration = (await readTenantAgents(runtime)).items.find(
      (item) => item.actor.display_name === "Codex",
    )!;
    const routine = {
      cadence: { kind: "daily" as const, time: "09:00", timezone: "UTC" },
      created_at: "2026-10-14T00:00:00Z",
      created_by_actor_id: "human-1",
      enabled: true,
      instruction: "Do it",
      revision: 1,
      room_id: "room-1",
      updated_at: "2026-10-14T00:00:00Z",
    };
    const list = vi.fn(() => ({
      items: [
        {
          ...routine,
          id: "r1",
          name: "Created by agent",
          instruction: "Created by agent",
          created_by_actor_id: registration.actor.id,
        },
        {
          ...routine,
          id: "r2",
          name: "Executed by agent",
          instruction: "Executed by agent",
          mention_actor_id: registration.actor.id,
        },
        {
          ...routine,
          id: "r3",
          name: "Someone else",
          instruction: "Someone else",
          mention_actor_id: "agent-other",
        },
      ],
      page: { has_more: false },
    }));
    runtime.server.on("GET", "/v0/rooms/{roomId}/routines", list);
    await setup({ runtime, roomId: "room-1" });
    fireEvent.click(await screen.findByRole("tab", { name: "Routines" }));
    expect(await screen.findByText("Created by agent")).toBeVisible();
    expect(screen.getByText("Executed by agent")).toBeVisible();
    expect(screen.queryByText("Someone else")).toBeNull();
    expect(screen.queryByText("Showing routines in this Room")).toBeNull();
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ params: { roomId: "room-1" } }),
    );
    expect(
      screen.getAllByRole("switch", { name: "Pause routine" }),
    ).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    expect(screen.queryByRole("combobox", { name: "Mention" })).toBeNull();
  });

  it("keeps Skills out of Details and Connectors in their own tab", async () => {
    await setup();
    expect(await screen.findByText("Online")).toBeVisible();
    expect(screen.getByText("Read-only Agent details")).toBeVisible();
    expect(screen.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("region", { name: "Skills" })).toBeNull();
    expect(screen.queryByText("Review Changes")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Logs" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(screen.getByText("Read-only Agent details")).not.toBeVisible();
    expect(await screen.findByRole("region", { name: "Gmail" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Slack" })).toBeNull();
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(
      screen.getByRole("link", { name: "Connect another app" }),
    ).toHaveAttribute("href", "/t/tenant-northstar/apps");
    fireEvent.click(screen.getByRole("tab", { name: "Details" }));
    expect(screen.getByText("Read-only Agent details")).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Connectors" }));
    expect(screen.queryByRole("button", { name: "Activity" })).toBeNull();
  });
  it("marks an editable avatar with a pencil badge and a focusable hint", async () => {
    const onEditIdentity = vi.fn();
    await setup({ onEditIdentity });
    const edit = screen.getByRole("button", { name: "Edit avatar" });
    expect(edit.querySelector("[data-avatar-edit-badge]")).not.toBeNull();
    const hint = screen.getByRole("tooltip");
    expect(hint).toHaveTextContent("Edit avatar");
    // The hint wraps the button and opens on its keyboard focus, not only hover.
    expect(edit.parentElement).toContainElement(hint);
    expect(hint.className).toContain("group-has-[:focus-visible]/hint:visible");
    expect(edit.querySelector("[title]")).toBeNull();
    fireEvent.click(edit);
    expect(onEditIdentity).toHaveBeenCalledOnce();
  });

  it("shows no avatar edit badge without permission", async () => {
    await setup();
    expect(
      screen.queryByRole("button", { name: "Edit avatar" }),
    ).not.toBeInTheDocument();
    expect(document.querySelector("[data-avatar-edit-badge]")).toBeNull();
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it("returns keyboard focus after editing or cancelling the name", async () => {
    const onSaveName = vi.fn().mockResolvedValue(undefined);
    await setup({ onSaveName });
    const edit = await screen.findByRole("button", { name: "Edit name Codex" });
    fireEvent.click(edit);
    const name = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.keyDown(name, { key: "Escape" });
    expect(
      screen.getByRole("button", { name: "Edit name Codex" }),
    ).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Edit name Codex" }));
    const next = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(next, { target: { value: "Codex Reviewer" } });
    fireEvent.keyDown(next, { key: "Enter" });
    await waitFor(() =>
      expect(onSaveName).toHaveBeenCalledWith("Codex Reviewer"),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Edit name Codex" }),
      ).toHaveFocus(),
    );
  });

  it("restores focus only after a failed name save finishes", async () => {
    let rejectSave: (reason: Error) => void = () => {};
    const onSaveName = vi.fn(
      () =>
        new Promise((_, reject) => {
          rejectSave = reject;
        }),
    );
    const { setNameBusy } = await setup({ onSaveName });
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit name Codex" }),
    );
    const input = screen.getByRole("textbox", { name: "Agent name" });
    fireEvent.change(input, { target: { value: "New name" } });
    fireEvent.keyDown(input, { key: "Enter" });
    setNameBusy(true);
    expect(input).toBeDisabled();
    await act(async () => rejectSave(new Error("Save failed")));
    expect(input).toBeDisabled();
    setNameBusy(false);
    await waitFor(() => expect(input).toHaveFocus());
  });
});

function readTenantAgents(runtime: TestTeamHubRuntime) {
  return teamHubData(
    runtime.client.api.GET("/v0/tenants/{tenantId}/agents", {
      params: { path: { tenantId: "tenant-northstar" } },
    }),
  );
}
