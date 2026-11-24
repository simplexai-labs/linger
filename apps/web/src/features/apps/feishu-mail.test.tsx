import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { teamHubErrorResponse } from "@/test/teamhub-test-server";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalAppList,
} from "@/features/teamhub/teamhub-types";

import { ConnectedAppsPage } from "./connected-apps-page";

describe("Feishu Mail", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is not offered on the Apps page; Agents ask for it in chat", async () => {
    const runtime = createTestTeamHubRuntime();
    const base = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      catalog(base),
    );
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [],
    });
    renderPage(runtime);

    expect(
      await screen.findByRole("button", { name: "Connect Gmail" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Connect Feishu Mail" }),
    ).toBeNull();
    expect(screen.queryByText("App ID")).toBeNull();
  });

  it("never shows on the Connectors page once connected; AnotherMe's link still opens it", async () => {
    const runtime = createTestTeamHubRuntime();
    const base = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      catalog(base),
    );
    const existing = (await runtime.client.listExternalConnections())
      .connections[0]!;
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [
        existing,
        {
          ...existing,
          id: "connection_feishu",
          provider: "feishu_mail",
          status: "active",
          identity_label: "owner@example.test",
        },
      ],
    });
    const { unmount } = renderPage(runtime);

    fireEvent.click(
      await screen.findByRole("button", { name: "Connected only" }),
    );
    const connected = screen.getByRole("region", {
      name: "Application connections",
    });
    await waitFor(() =>
      expect(within(connected).getAllByRole("article").length).toBeGreaterThan(
        0,
      ),
    );
    expect(
      within(connected).queryByRole("button", { name: "Feishu Mail" }),
    ).toBeNull();
    unmount();

    let computerOnline = false;
    runtime.server.on("GET", "/v0/external-apps/feishu-mail/setup", () =>
      computerOnline
        ? new Response(null, { status: 204 })
        : teamHubErrorResponse(409, "FEISHU_COMPUTER_OFFLINE"),
    );
    renderPage(runtime, "/apps?app=feishu_mail");
    const dialog = await screen.findByRole("dialog", { name: /Feishu Mail/ });
    expect(
      await within(dialog).findByText(
        "The Computer that runs your Another Me is offline",
      ),
    ).toBeVisible();
    expect(within(dialog).getByText("owner@example.test")).toBeVisible();
    computerOnline = true;
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Check again" }),
    );
    expect(
      await within(dialog).findByRole("button", {
        name: "Add another Feishu Mail account",
      }),
    ).toBeEnabled();
    expect(
      runtime.server.requestsTo("POST", "/v0/external-connections"),
    ).toHaveLength(0);
  });
});

function catalog(base: TeamHubExternalAppList): TeamHubExternalAppList {
  const feishuMail: TeamHubExternalApp = {
    key: "feishu_mail",
    display_name: "Feishu Mail",
    description:
      "Let your Another Me read and send your Feishu or Lark mail through lark-cli on your Computer; new mail syncs to your Wiki each night.",
    availability: "available",
    capabilities: ["connect", "agent_tools"],
    allows_multiple_connections: true,
    supports_reauthorization: true,
  };
  return {
    ...base,
    apps: [...base.apps.filter((app) => app.key !== "feishu_mail"), feishuMail],
  };
}

function renderPage(
  runtime: ReturnType<typeof createTestTeamHubRuntime>,
  path = "/apps",
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={queryClient}>
        <TeamHubRuntimeProvider runtime={runtime}>
          <ConnectedAppsPage />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
