import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { Suspense } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { anotherMeQueryKey } from "@/features/rooms/room-queries";
import { RoomShell } from "@/features/rooms/room-shell";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

type LocalComputer = TeamHubLocalComputerPage["items"][number];

const newMac: LocalComputer = {
  active_operations: 0,
  available_capacity: 2,
  capacity: 2,
  computer_id: "computer-new-mac",
  display_name: "New Mac",
  runtimes: [
    {
      models: [],
      status: "authentication_required",
      type: "claude",
      version: "2.1.0",
    },
  ],
  status: "online",
  upgrade_required: false,
  workspace_grants: [
    {
      grant_id: "grant-managed",
      label: "Linger managed workspace",
      mode: "workspace-write",
    },
  ],
};

describe("Local Computer gate", () => {
  it("covers the product until a Computer runs an AI app, then opens the Another Me Chat", async () => {
    const fixture = renderShell(newMac);

    const gate = await screen.findByRole("dialog", {
      name: "Connect your computer",
    });
    expect(await within(gate).findByText("New Mac is online.")).toBeVisible();
    expect(
      within(gate).getByText("Claude Code sign-in required"),
    ).toBeVisible();
    expect(within(gate).getByText("claude auth login")).toBeVisible();
    expect(screen.getByText("Shell content").closest("[inert]")).not.toBeNull();

    fixture.anotherMe = {
      agent_actor_id: "actor-anotherme",
      room_id: "room-another-me",
    };
    await act(() =>
      fixture.queryClient.invalidateQueries({
        queryKey: anotherMeQueryKey("tenant-northstar"),
      }),
    );

    await waitFor(() =>
      expect(fixture.router.state.location.pathname).toBe(
        "/t/tenant-northstar/rooms/room-another-me/chat",
      ),
    );
    expect(
      screen.queryByRole("dialog", { name: "Connect your computer" }),
    ).toBeNull();
    expect(screen.getByText("Shell content").closest("[inert]")).toBeNull();
  });

  it("lets a Computer with no ready app open Settings to load a local model", async () => {
    // Pi with no model yet: nothing can run Another Me until one is loaded.
    const fixture = renderShell({
      ...newMac,
      runtimes: [
        {
          models: [],
          status: "authentication_required",
          type: "pi",
          version: "1.4.0",
        },
      ],
    });

    const gate = await screen.findByRole("dialog", {
      name: "Connect your computer",
    });
    fireEvent.click(
      await within(gate).findByRole("link", { name: "Local models" }),
    );

    await waitFor(() =>
      expect(fixture.router.state.location.pathname).toBe(
        "/t/tenant-northstar/settings/local-models",
      ),
    );
    expect(fixture.router.state.location.search).toBe(
      "?computer=computer-new-mac",
    );
    expect(
      screen.queryByRole("dialog", { name: "Connect your computer" }),
    ).toBeNull();
    expect(screen.getByText("Shell content").closest("[inert]")).toBeNull();

    // Loading the model creates Another Me; the owner stays on Settings.
    fixture.anotherMe = {
      agent_actor_id: "actor-anotherme",
      room_id: "room-another-me",
    };
    await act(() =>
      fixture.queryClient.invalidateQueries({
        queryKey: anotherMeQueryKey("tenant-northstar"),
      }),
    );
    expect(fixture.router.state.location.pathname).toBe(
      "/t/tenant-northstar/settings/local-models",
    );
  });

  it("keeps covering the rest of the product while Another Me is missing", async () => {
    renderShell(newMac, "/t/tenant-northstar/rooms/room-1/chat");
    expect(
      await screen.findByRole("dialog", { name: "Connect your computer" }),
    ).toBeVisible();
    expect(screen.getByText("Shell content").closest("[inert]")).not.toBeNull();
  });

  it("waits for the CLI login while no Computer is connected", async () => {
    renderShell();

    const gate = await screen.findByRole("dialog", {
      name: "Connect your computer",
    });
    expect(within(gate).getByText(/Waiting for your computer/)).toBeVisible();
    expect(
      within(gate).getByText("Available once your computer is online."),
    ).toBeVisible();
    expect(
      within(gate).getByRole("button", { name: "Sign out" }),
    ).toBeEnabled();
  });
});

function renderShell(
  computer?: LocalComputer,
  path = "/t/tenant-northstar/rooms",
) {
  const runtime = createTestTeamHubRuntime();
  const fixture: {
    anotherMe: { agent_actor_id?: string; room_id?: string };
    queryClient: QueryClient;
    router: ReturnType<typeof createMemoryRouter>;
  } = {
    anotherMe: {},
    queryClient: new QueryClient({
      defaultOptions: { queries: { retry: false } },
    }),
    router: createMemoryRouter(
      [
        {
          path: "/t/:tenantId",
          element: <RoomShell />,
          children: [{ path: "*", element: <p>Shell content</p> }],
        },
      ],
      { initialEntries: [path] },
    ),
  };
  runtime.server
    .on("GET", "/v0/tenants/{tenantId}/another-me", () => fixture.anotherMe)
    .on("GET", "/v0/tenants/{tenantId}/local-computers", () => ({
      items: computer ? [computer] : [],
    }));
  render(
    <QueryClientProvider client={fixture.queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <Suspense fallback={<p>Loading</p>}>
          <RouterProvider router={fixture.router} />
        </Suspense>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return fixture;
}
