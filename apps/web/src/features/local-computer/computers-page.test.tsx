import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { Suspense } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { teamHubData } from "@/features/teamhub/teamhub-api";

import {
  acceptDirectRooms,
  acceptTenantAgentCreation,
  createTestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";
import {
  TeamHubRuntimeProvider,
  type TeamHubRuntime,
} from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalComputerPage,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
} from "@/features/teamhub/teamhub-types";

import {
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryOptions,
} from "@/features/rooms/room-queries";
import { tenantLocalModelsQueryKey } from "@/features/local-models/local-models-queries";

import { ComputersPage } from "./computers-page";
import {
  localComputersQueryKey,
  localComputersQueryOptions,
} from "./local-computer-queries";
import { publishLocalComputerEnrollment } from "./local-computer-enrollment-events";

describe("ComputersPage", () => {
  it("links a Computer to its Local models page without reading its models", async () => {
    const runtime = await authenticatedFixture();
    const queryClient = await renderPage(
      runtime,
      "/t/tenant-northstar/computers?computer=computer-offline-lab",
    );

    const detail = await screen.findByRole("region", {
      name: "Offline Lab Mac details",
    });
    expect(within(detail).getByRole("status")).toHaveTextContent("Offline");
    expect(
      within(detail).getByRole("link", { name: /Manage local models/ }),
    ).toHaveAttribute(
      "href",
      "/t/tenant-northstar/settings/models?computer=computer-offline-lab",
    );
    fireEvent.click(within(detail).getByRole("button", { name: "Advanced" }));
    fireEvent.click(within(detail).getByRole("button", { name: "Remove" }));
    expect(
      await screen.findByRole("dialog", { name: "Remove Local Computer" }),
    ).toBeVisible();

    // Model downloads and loads live on the Local models page only: the
    // Computers page neither reads nor shows them.
    expect(
      runtime.server.requestsTo(
        "GET",
        "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models",
      ),
    ).toHaveLength(0);
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: tenantLocalModelsQueryKey("tenant-northstar") }),
    ).toHaveLength(0);
    expect(
      screen.queryByRole("region", { name: "Background model services" }),
    ).not.toBeInTheDocument();
  });

  it("lists several Computers by readiness and opens each one's detail", async () => {
    const runtime = await authenticatedFixture();
    await renderPage(runtime);

    const directory = await screen.findByRole("list", {
      name: "Local computers directory",
    });
    expect(within(directory).getAllByRole("listitem")).toHaveLength(4);

    const open = async (name: string) => {
      fireEvent.click(
        within(
          await screen.findByRole("list", {
            name: "Local computers directory",
          }),
        ).getByRole("button", { name: new RegExp(name) }),
      );
      return screen.findByRole("region", { name: `${name} details` });
    };
    const back = () =>
      fireEvent.click(screen.getByRole("button", { name: "All computers" }));

    expect(await open("Jenny's Mac")).toHaveTextContent("Ready");
    back();
    expect(await open("Offline Lab Mac")).toHaveTextContent("Offline");
    back();

    const assigned = await open("Assigned Offline Mac");
    expect(
      within(assigned).getByRole("button", { name: /Offline Local Reviewer/ }),
    ).toBeVisible();
    fireEvent.click(within(assigned).getByRole("button", { name: "Advanced" }));
    fireEvent.click(within(assigned).getByRole("button", { name: "Remove" }));
    const removeDialog = await screen.findByRole("dialog", {
      name: "Remove Local Computer",
    });
    // The only online Computer with Codex ready is preselected as the target.
    expect(
      within(removeDialog).getByRole("combobox", {
        name: "Target for Offline Local Reviewer",
      }),
    ).toHaveTextContent("Jenny's Mac · Codex");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    back();

    const legacy = await open("Legacy Mac");
    expect(legacy).toHaveTextContent("Update required");
    expect(
      within(legacy).getAllByRole("button", { name: "Update" })[0],
    ).toBeVisible();
  });

  it("waits for the exact server when another user's Computer connects first", async () => {
    const runtime = await authenticatedFixture();
    const queryClient = await renderPage(runtime);
    fireEvent.click(
      await screen.findByRole("button", { name: "Connect a Local Computer" }),
    );
    act(() => {
      publishLocalComputerEnrollment({
        computerId: "expected-server",
        tenantId: "tenant-northstar",
      });
      queryClient.setQueryData(
        localComputersQueryKey("tenant-northstar"),
        replacementComputerInventory(),
      );
    });
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();
    const inventory = replacementComputerInventory();
    inventory.items[0]!.computer_id = "expected-server";
    act(() => {
      queryClient.setQueryData(
        localComputersQueryKey("tenant-northstar"),
        inventory,
      );
    });
    expect(await screen.findByText("Computer connected")).toBeVisible();
  });

  it("shows a ready Computer with its Agents, AI apps and folders, and opens an Agent's chat", async () => {
    const runtime = await authenticatedFixture();
    await teamHubData(
      runtime.client.api.POST("/v0/tenants/{tenantId}/agents", {
        params: { path: { tenantId: "tenant-northstar" } },
        body: {
          instructions: "Review the repository locally.",
          name: "Local Reviewer",
          runtime: {
            model: "openai/gpt-5.4",
            placement: {
              computer_id: "computer-jenny-mac",
              runtime_type: "codex",
              type: "local",
              workspace_grant_id: "grant-linger-workspace",
            },
          },
        },
      }),
    );

    await renderPage(
      runtime,
      "/t/tenant-northstar/computers?computer=computer-jenny-mac",
    );

    const detail = await screen.findByRole("region", {
      name: "Jenny's Mac details",
    });
    expect(within(detail).getByRole("status")).toHaveTextContent("Ready");
    expect(
      within(detail).getByRole("region", { name: "AI apps" }),
    ).toHaveTextContent("Codex");
    fireEvent.click(within(detail).getByRole("button", { name: "Access" }));
    expect(
      within(detail).getByRole("region", { name: "Access" }),
    ).toHaveTextContent("Linger Workspace");
    expect(detail).toHaveTextContent("Agents can edit here");

    fireEvent.click(
      within(detail).getByRole("button", { name: /Local Reviewer/ }),
    );
    await waitFor(() =>
      expect(
        runtime.server
          .requestsTo("POST", "/v0/tenants/{tenantId}/direct-rooms")
          .map((request) => new URL(request.url).pathname),
      ).toEqual(["/v0/tenants/tenant-northstar/direct-rooms"]),
    );
  });

  it("shows running tasks in the summary when Agents are working", async () => {
    const fixture = await authenticatedFixture();
    const inventory = replacementComputerInventory();
    inventory.items[0]!.active_operations = 3;
    const runtime: TeamHubRuntime = {
      ...fixture,
      client: {
        ...fixture.client,
        listTenantLocalComputers: vi.fn().mockResolvedValue(inventory),
      },
    };

    await renderPage(runtime);

    const detail = await screen.findByRole("region", {
      name: "New Build Mac details",
    });
    expect(within(detail).getByRole("status")).toHaveTextContent(
      "Ready · 3 running",
    );
  });

  it("keeps setup instructions out of the empty Computers surface until requested", async () => {
    const fixture = await authenticatedFixture();
    const runtime: TeamHubRuntime = {
      ...fixture,
      client: {
        ...fixture.client,
        listTenantLocalComputers: vi.fn().mockResolvedValue({ items: [] }),
      },
    };

    await renderPage(runtime);

    expect(
      await screen.findByRole("heading", {
        name: "Run Agents on your computer",
      }),
    ).toBeVisible();
    expect(
      screen.queryByText("linger-computer-local-3000 login"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Connect a computer" }));

    expect(
      await screen.findByRole("dialog", { name: "Connect Local Computer" }),
    ).toBeVisible();
    expect(screen.getByText("linger-computer-local-3000 login")).toBeVisible();
    expect(
      screen.getByText(
        'curl -fsSL "http://localhost:3000/install/linger-computer.sh" | bash',
      ),
    ).toBeVisible();
  });

  it("keeps a stale Computer URL explicit and leads back to the available Computer", async () => {
    const fixture = await authenticatedFixture();
    const runtime: TeamHubRuntime = {
      ...fixture,
      client: {
        ...fixture.client,
        listTenantLocalComputers: vi
          .fn()
          .mockResolvedValue(replacementComputerInventory()),
      },
    };

    await renderPage(runtime, "/t/tenant-northstar/computers?computer=missing");

    expect(await screen.findByText("Computer unavailable")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to computers" }));

    expect(
      await screen.findByRole("region", { name: "New Build Mac details" }),
    ).toHaveTextContent("Ready");
  });

  it("completes setup when polling finds a newly connected Computer from another browser", async () => {
    const runtime = await authenticatedFixture();
    const queryClient = await renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connect a Local Computer" }),
    );
    expect(
      screen.getByText("Checking for an online Local Computer..."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Done" })).toBeDisabled();

    act(() => {
      queryClient.setQueryData(
        localComputersQueryKey("tenant-northstar"),
        replacementComputerInventory(),
      );
    });

    expect(await screen.findByText("Computer connected")).toBeVisible();
    expect(
      screen.getByText(
        "Computer is online. Check its Runtime status before running tasks.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Done" })).toBeEnabled();
  });

  it("retains an offline Computer and shows its Agents as TeamHub reports them", async () => {
    const fixture = await authenticatedFixture();
    const inventory = replacementComputerInventory();
    inventory.items[0] = {
      ...inventory.items[0]!,
      available_capacity: 0,
      last_seen_at: "2026-07-31T10:00:00Z",
      status: "offline",
    };
    const runtime: TeamHubRuntime = {
      ...fixture,
      client: {
        ...fixture.client,
        listTenantLocalComputers: vi.fn().mockResolvedValue(inventory),
      },
    };
    fixture.server
      .on("GET", "/v0/tenants/{tenantId}/agents", () => ({
        items: [localAgentFixture("computer-new-build-mac")],
        page: { has_more: false },
      }))
      .on("GET", "/v0/tenants/{tenantId}/agent-availability", () => ({
        items: [
          {
            actor_id: "actor-local-reviewer",
            availability: {
              active_task_count: 0,
              current_activity: {
                summary: "Waiting for the computer to connect",
              },
              label: "Offline",
              status: "offline",
            },
          },
        ],
        page: { has_more: false },
      }));

    await renderPage(runtime);

    const detail = await screen.findByRole("region", {
      name: "New Build Mac details",
    });
    expect(within(detail).getByRole("status")).toHaveTextContent("Offline");
    expect(
      within(detail).getByRole("region", { name: "Agents" }),
    ).toHaveTextContent("1 offline");
    expect(
      within(detail).getByText(
        "Local Reviewer · Offline · Waiting for the computer to connect",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("linger-computer-local-3000 daemon start"),
    ).toBeInTheDocument();
  });

  it("asks for a required update and keeps the troubleshooting commands in Advanced", async () => {
    const fixture = await authenticatedFixture();
    const inventory = replacementComputerInventory();
    inventory.items[0]!.upgrade_required = true;
    inventory.items[0]!.platform = "darwin";
    const runtime: TeamHubRuntime = {
      ...fixture,
      client: {
        ...fixture.client,
        listTenantLocalComputers: vi.fn().mockResolvedValue(inventory),
      },
    };

    await renderPage(runtime);

    const detail = await screen.findByRole("region", {
      name: "New Build Mac details",
    });
    expect(within(detail).getByRole("status")).toHaveTextContent(
      "Update required",
    );
    fireEvent.click(
      within(detail).getAllByRole("button", { name: "Update" })[0]!,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Update required",
    });
    expect(dialog).toHaveTextContent("Your Agents stay connected");
    expect(dialog).toHaveTextContent(
      'curl -fsSL "http://localhost:3000/install/linger-computer.sh" | bash',
    );
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "Close" })[0]!,
    );

    expect(
      screen.queryByText("linger-computer-local-3000 daemon status"),
    ).not.toBeInTheDocument();
    fireEvent.click(within(detail).getByRole("button", { name: "Advanced" }));
    for (const command of [
      "daemon status",
      "daemon restart",
      "runtime check",
      "login",
      "daemon stop",
    ])
      expect(
        screen.getByText(`linger-computer-local-3000 ${command}`),
      ).toBeInTheDocument();
  });

  it("removes an unassigned offline Local Computer after confirmation", async () => {
    const fixture = await authenticatedFixture();
    const removeTenantLocalComputer = vi.fn(() => undefined);
    const inventory = replacementComputerInventory();
    inventory.items[0] = {
      ...inventory.items[0]!,
      available_capacity: 0,
      status: "offline",
    };
    const runtime: TeamHubRuntime = {
      ...fixture,
      client: {
        ...fixture.client,
        listTenantLocalComputers: vi.fn().mockResolvedValue(inventory),
      },
    };
    fixture.server
      .on("GET", "/v0/tenants/{tenantId}/agents", () => ({
        items: [],
        page: { has_more: false },
      }))
      .on(
        "DELETE",
        "/v0/tenants/{tenantId}/local-computers/{computerId}",
        removeTenantLocalComputer,
      );

    await renderPage(runtime);
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Remove Local Computer",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    await vi.waitFor(() =>
      expect(removeTenantLocalComputer).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            computerId: "computer-new-build-mac",
            tenantId: "tenant-northstar",
          },
        }),
      ),
    );
  });

  it("deletes an assigned Agent instead of moving it before removing the Computer", async () => {
    const fixture = await authenticatedFixture();
    const deleteTenantAgent = vi.fn(() => undefined);
    const removeTenantLocalComputer = vi.fn(() => undefined);
    fixture.server
      .on(
        "DELETE",
        "/v0/tenants/{tenantId}/agents/{agentId}",
        deleteTenantAgent,
      )
      .on("GET", "/v0/tenants/{tenantId}/agents", () => ({
        items: [localAgentFixture("computer-jenny-mac")],
        page: { has_more: false },
      }))
      .on(
        "DELETE",
        "/v0/tenants/{tenantId}/local-computers/{computerId}",
        removeTenantLocalComputer,
      );

    await renderPage(
      fixture,
      "/t/tenant-northstar/computers?computer=computer-jenny-mac",
    );

    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));
    const remove = screen.getByRole("button", { name: "Remove" });
    expect(remove).toBeEnabled();
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog", {
      name: "Remove Local Computer",
    });
    expect(dialog).toHaveTextContent("Local Reviewer");
    fireEvent.click(
      within(dialog).getByRole("combobox", {
        name: "Target for Local Reviewer",
      }),
    );
    fireEvent.click(
      await screen.findByRole("option", { name: "Delete this Agent instead" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete and remove" }),
    );

    await vi.waitFor(() =>
      expect(removeTenantLocalComputer).toHaveBeenCalledWith(
        expect.objectContaining({
          params: {
            computerId: "computer-jenny-mac",
            tenantId: "tenant-northstar",
          },
        }),
      ),
    );
    expect(deleteTenantAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          agentId: "actor-local-reviewer",
          tenantId: "tenant-northstar",
        },
      }),
    );
  });

  it("shows the active BYOK model-source runtime pill instead of defaulting to Claude Code", async () => {
    const fixture = await authenticatedFixture();
    const multiRuntime = replacementComputerInventory();
    multiRuntime.items[0]!.runtimes = [
      { models: [], status: "ready", type: "claude" },
      { models: [], status: "ready", type: "codex" },
      { models: [], status: "ready", type: "pi" },
    ];
    fixture.seed.localComputers = multiRuntime.items;
    fixture.server.on(
      "GET",
      "/v0/tenants/{tenantId}/local-computers/{computerId}/model-source",
      ({ params }) =>
        Response.json({
          computer_id: params.computerId,
          online: true,
          status: {
            byok: {
              base_url: "http://127.0.0.1:18100",
              configured: true,
              endpoint: "/chat/completions",
              key_saved: true,
              model_id: "Spark-X2.6-4B-Q8_0",
              path: "/v1",
              protocol: "openai-chat",
            },
            mode: "byok",
            runtime: "pi",
            runtime_model: "localmodels-byok",
          },
          viewer_is_owner: true,
        }),
    );

    await renderPage(fixture);

    const detail = await screen.findByRole("region", {
      name: "New Build Mac details",
    });
    expect(
      await within(detail).findByText("Agents use Pi here"),
    ).toBeInTheDocument();
    expect(
      within(detail).queryByText("Agents use Claude Code here"),
    ).not.toBeInTheDocument();
    expect(
      fixture.server.requestsTo(
        "GET",
        "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models",
      ),
    ).toHaveLength(0);
  });

  describe("CLI download visibility in the desktop app", () => {
    afterEach(() => {
      delete (window as { lingerDesktop?: unknown }).lingerDesktop;
    });

    it("hides CLI connect entries when showing the desktop app's own local server even while localAccount is not ready", async () => {
      const owned = vi.fn(async () => true);
      const available = vi.fn(async () => false);
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        localServer: { owned },
        localAccount: { available },
      };
      const fixture = await authenticatedFixture();
      fixture.seed.localComputers = [
        {
          ...fixture.seed.localComputers[0]!,
          status: "offline",
        },
      ];
      fixture.server.on("GET", "/v0/tenants/{tenantId}/agents", () => ({
        items: [localAgentFixture("computer-jenny-mac")],
        page: { has_more: false },
      }));

      await renderPage(fixture);

      const detail = await screen.findByRole("region", {
        name: "Jenny's Mac details",
      });
      await vi.waitFor(() => expect(owned).toHaveBeenCalled());
      expect(available).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "Connect a Local Computer" }),
      ).not.toBeInTheDocument();
      expect(
        within(detail).queryByRole("button", { name: "Reconnect" }),
      ).not.toBeInTheDocument();
      expect(
        within(detail).queryByText("Start the app"),
      ).not.toBeInTheDocument();

      fireEvent.click(within(detail).getByRole("button", { name: "Advanced" }));
      expect(
        within(detail).queryByText("Troubleshoot"),
      ).not.toBeInTheDocument();
      for (const tool of [
        "Status",
        "Restart",
        "Re-check",
        "Reconnect",
        "Stop",
      ]) {
        expect(
          within(detail).queryByRole("button", { name: tool }),
        ).not.toBeInTheDocument();
      }
      fireEvent.click(within(detail).getByRole("button", { name: "Remove" }));
      const removeDialog = await screen.findByRole("dialog", {
        name: "Remove Local Computer",
      });
      expect(removeDialog).toHaveTextContent("Local Reviewer");
      expect(
        within(removeDialog).queryByRole("button", {
          name: "Connect a computer",
        }),
      ).not.toBeInTheDocument();
    });

    it("hides CLI upgrade button and modal when upgrade_required is set on the desktop local server", async () => {
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        localServer: { owned: vi.fn(async () => true) },
      };
      const fixture = await authenticatedFixture();
      fixture.seed.localComputers = [
        {
          ...fixture.seed.localComputers[0]!,
          daemon_version: "0.1.0",
          recommended_version: "0.2.0",
          status: "online",
          upgrade_required: true,
        },
      ];

      await renderPage(fixture);

      const detail = await screen.findByRole("region", {
        name: "Jenny's Mac details",
      });
      expect(
        within(detail).queryByRole("button", { name: "Update" }),
      ).not.toBeInTheDocument();
      fireEvent.click(within(detail).getByRole("button", { name: "Advanced" }));
      expect(
        within(detail).queryByRole("button", {
          name: /0\.2\.0 available|Update/,
        }),
      ).not.toBeInTheDocument();
    });

    it("falls back to localAccount.available in older desktop builds without localServer.owned", async () => {
      const available = vi.fn(async () => true);
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        localAccount: { available },
      };
      const fixture = await authenticatedFixture();

      await renderPage(fixture);

      await vi.waitFor(() => expect(available).toHaveBeenCalled());
      expect(
        screen.queryByRole("button", { name: "Connect a Local Computer" }),
      ).not.toBeInTheDocument();
    });

    it("hides CLI setup button on the empty Computers view for the desktop local server", async () => {
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        localAccount: { available: vi.fn(async () => true) },
      };
      const emptyFixture = await authenticatedFixture();
      emptyFixture.seed.localComputers = [];

      await renderPage(emptyFixture);

      expect(
        await screen.findByText("Run Agents on your computer"),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Connect a computer" }),
      ).not.toBeInTheDocument();
    });

    it("hides CLI setup commands on an unavailable Computer view for the desktop local server", async () => {
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        localAccount: { available: vi.fn(async () => true) },
      };
      const unavailableFixture = await authenticatedFixture();
      await renderPage(
        unavailableFixture,
        "/t/tenant-northstar/computers?computer=computer-gone",
      );

      expect(await screen.findByText("Computer unavailable")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Setup commands" }),
      ).not.toBeInTheDocument();
    });

    it("keeps CLI connect entries when the desktop app points at a remote server", async () => {
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        localAccount: { available: vi.fn(async () => false) },
      };
      const fixture = await authenticatedFixture();

      await renderPage(fixture);

      const connect = await screen.findByRole("button", {
        name: "Connect a Local Computer",
      });
      fireEvent.click(connect);
      expect(
        await screen.findByRole("dialog", { name: "Connect Local Computer" }),
      ).toBeVisible();
    });
  });
});

async function authenticatedFixture() {
  const runtime = createTestTeamHubRuntime();
  acceptTenantAgentCreation(runtime);
  acceptDirectRooms(runtime);
  return runtime;
}

// Loading the suspending queries first skips React's Suspense reveal
// throttle, which otherwise costs every test a fixed delay.
async function renderPage(
  runtime: TeamHubRuntime,
  initialEntry = "/t/tenant-northstar/computers",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await Promise.all([
    queryClient.ensureQueryData(
      localComputersQueryOptions(runtime.client, "tenant-northstar"),
    ),
    queryClient.ensureQueryData(
      tenantAgentsQueryOptions(runtime.client, "tenant-northstar"),
    ),
    queryClient.ensureQueryData(
      tenantAgentAvailabilityQueryOptions(runtime.client, "tenant-northstar"),
    ),
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <TeamHubRuntimeProvider runtime={runtime}>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Suspense fallback={<p>Loading computers</p>}>
            <Routes>
              <Route
                element={<p>Agent DM opened</p>}
                path="/t/:tenantId/rooms/:roomId/chat"
              />
              <Route
                element={<ComputersPage />}
                path="/t/:tenantId/computers"
              />
            </Routes>
          </Suspense>
        </MemoryRouter>
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

function replacementComputerInventory(): TeamHubLocalComputerPage {
  return {
    items: [
      {
        active_operations: 0,
        available_capacity: 1,
        capacity: 1,
        display_name: "New Build Mac",
        computer_id: "computer-new-build-mac",
        runtimes: [
          {
            models: [{ id: "openai/gpt-5.4", label: "GPT-5.4" }],
            status: "ready",
            type: "codex",
          },
        ],
        status: "online",
        upgrade_required: false,
        workspace_grants: [],
      },
    ],
  };
}

function localAgentFixture(
  computerId: string,
  availability: TeamHubTenantAgentAvailabilitySnapshot["availability"] = {
    active_task_count: 0,
    label: "Online",
    status: "online",
  },
): TeamHubTenantAgent & {
  availability: TeamHubTenantAgentAvailabilitySnapshot["availability"];
} {
  const timestamp = "2026-07-31T09:00:00Z";
  return {
    actor: {
      created_at: timestamp,
      display_name: "Local Reviewer",
      handle: "@local_reviewer",
      id: "actor-local-reviewer",
      kind: "agent" as const,
      tenant_id: "tenant-northstar",
    },
    agent_management_id: "agent-local-reviewer",
    agent_type: "general",
    availability,
    configuration_revision: 1,
    created_at: timestamp,
    created_by: {
      id: "actor-jenny",
      kind: "human" as const,
      tenant_id: "tenant-northstar",
      display_name: "Jenny Bin",
    },
    description: "",
    instructions: "Review locally.",
    runtime: {
      model: "openai/gpt-5.4",
      placement: {
        computer_id: computerId,
        runtime_type: "codex" as const,
        type: "local" as const,
        workspace_grant_id: "grant-workspace",
      },
    },
    skill_bindings: [],
    updated_at: timestamp,
    visibility_scope: "workspace",
  };
}
