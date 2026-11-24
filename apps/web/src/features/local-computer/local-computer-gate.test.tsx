import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  anotherMeQueryKey,
  teamHubIdentityQueryOptions,
  teamHubTenantQueryOptions,
} from "@/features/rooms/room-queries";
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
    const fixture = await renderShell(newMac);

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
    const fixture = await renderShell({
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
      await within(gate).findByRole("link", { name: "Settings › Models" }),
    );

    await waitFor(() =>
      expect(fixture.router.state.location.pathname).toBe(
        "/t/tenant-northstar/settings/models",
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
      "/t/tenant-northstar/settings/models",
    );
  });

  it("keeps covering the rest of the product while Another Me is missing", async () => {
    await renderShell(newMac, "/t/tenant-northstar/rooms/room-1/chat");
    expect(
      await screen.findByRole("dialog", { name: "Connect your computer" }),
    ).toBeVisible();
    expect(screen.getByText("Shell content").closest("[inert]")).not.toBeNull();
  });

  it("keeps polling while the page is hidden so a preloaded desktop window leaves the gate", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fixture = await renderShell({
      ...newMac,
      runtimes: [
        {
          models: [{ id: "claude-sonnet", label: "Claude Sonnet" }],
          status: "ready",
          type: "claude",
          version: "2.1.0",
        },
      ],
    });
    expect(await screen.findByText(/Creating your Another Me/)).toBeVisible();
    act(() => focusManager.setFocused(false));
    const server = fixture.runtime.server;
    const anotherMeGets = () =>
      server.requestsTo("GET", "/v0/tenants/{tenantId}/another-me").length;
    const computerGets = () =>
      server.requestsTo("GET", "/v0/tenants/{tenantId}/local-computers").length;
    const before = { anotherMe: anotherMeGets(), computers: computerGets() };

    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await act(() => vi.advanceTimersByTimeAsync(3_100));

    expect(anotherMeGets()).toBeGreaterThanOrEqual(before.anotherMe + 2);
    expect(computerGets()).toBeGreaterThanOrEqual(before.computers + 2);

    fixture.anotherMe = {
      agent_actor_id: "actor-anotherme",
      room_id: "room-another-me",
    };
    await act(() => vi.advanceTimersByTimeAsync(3_100));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Connect your computer" }),
      ).toBeNull(),
    );
  });

  it("waits for the CLI login while no Computer is connected", async () => {
    await renderShell();

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

  describe("in the desktop app's local server", () => {
    afterEach(() => {
      delete (window as { lingerDesktop?: unknown }).lingerDesktop;
    });

    const stubDesktopLocalServer = (
      computerId?: string,
      bridge = "connecting",
    ) => {
      (window as { lingerDesktop?: unknown }).lingerDesktop = {
        computer: {
          getStatus: async () => ({
            bridge,
            runtime: "ready",
            activeOperations: 0,
            ...(computerId ? { computerId } : {}),
          }),
          onStatus: () => () => {},
          enroll: vi.fn(async () => ({ computerId: computerId ?? "c-mac" })),
        },
        localAccount: { available: async () => true },
      };
    };

    it("hides CLI install commands when the enrolled desktop Computer is offline", async () => {
      stubDesktopLocalServer(newMac.computer_id, "connecting");
      await renderShell({ ...newMac, status: "offline" });

      const gate = await screen.findByRole("dialog", {
        name: "Connect your computer",
      });
      expect(
        await within(gate).findByText(/Looking for Codex and Claude Code/),
      ).toBeVisible();
      expect(
        within(gate).queryByText(/install\/linger-computer\.sh/),
      ).toBeNull();
      expect(within(gate).queryByText(/linger-computer-local/)).toBeNull();
    });

    it("shows the Computer online without CLI install commands while waiting for an AI app", async () => {
      stubDesktopLocalServer(newMac.computer_id, "online");
      await renderShell(newMac);

      const gate = await screen.findByRole("dialog", {
        name: "Connect your computer",
      });
      expect(await within(gate).findByText("New Mac is online.")).toBeVisible();
      expect(
        within(gate).queryByText(/install\/linger-computer\.sh/),
      ).toBeNull();
    });
  });

  it("shows update guidance when an installed AI app is incompatible", async () => {
    await renderShell({
      ...newMac,
      platform: "darwin",
      runtimes: [
        {
          error_code: "RUNTIME_INCOMPATIBLE",
          message: "antigravity version 1.5.9 is below minimum 1.5.12",
          models: [],
          status: "incompatible",
          type: "antigravity",
          version: "1.5.9",
        },
      ],
    });

    const gate = await screen.findByRole("dialog", {
      name: "Connect your computer",
    });
    expect(await within(gate).findByText("agy update")).toBeVisible();
    expect(
      within(gate).getByText(
        "Update a Runtime on New Mac as the OS user that runs Local Computer. It appears here within a minute.",
      ),
    ).toBeVisible();
  });

  it("shows the Node.js hint once when both outdated and missing npm runtimes are listed", async () => {
    await renderShell({
      ...newMac,
      platform: "darwin",
      runtimes: [
        {
          error_code: "RUNTIME_INCOMPATIBLE",
          message: "codex version 0.90.0 is below minimum 0.100.0",
          models: [],
          status: "incompatible",
          type: "codex",
          version: "0.90.0",
        },
        {
          error_code: "RUNTIME_NOT_INSTALLED",
          message: "Runtime executable not found",
          models: [],
          status: "not_installed",
          type: "pi",
        },
      ],
    });

    const gate = await screen.findByRole("dialog", {
      name: "Connect your computer",
    });
    expect(
      await within(gate).findByText("npm install -g @openai/codex"),
    ).toBeVisible();
    expect(
      within(gate).getByText("npm install -g @earendil-works/pi-coding-agent"),
    ).toBeVisible();
    expect(
      within(gate).getAllByText("The npm commands need Node.js."),
    ).toHaveLength(1);
  });
});

async function renderShell(
  computer?: LocalComputer,
  path = "/t/tenant-northstar/rooms",
) {
  const runtime = createTestTeamHubRuntime();
  const fixture: {
    anotherMe: { agent_actor_id?: string; room_id?: string };
    runtime: typeof runtime;
    queryClient: QueryClient;
    router: ReturnType<typeof createMemoryRouter>;
  } = {
    anotherMe: {},
    runtime,
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
  // Loading what RoomShell suspends on before rendering skips React's
  // Suspense reveal throttle, which otherwise costs every test a fixed delay.
  await Promise.all([
    fixture.queryClient.ensureQueryData(
      teamHubIdentityQueryOptions(runtime.client),
    ),
    fixture.queryClient.ensureQueryData(
      teamHubTenantQueryOptions(runtime.client, "tenant-northstar"),
    ),
  ]);
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
