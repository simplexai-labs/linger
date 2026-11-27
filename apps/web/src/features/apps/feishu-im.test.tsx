import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import type {
  TeamHubExternalApp,
  TeamHubExternalAppList,
} from "@/features/teamhub/teamhub-types";

import { ConnectedAppsPage } from "./connected-apps-page";
import { FeishuConnectGuide } from "./feishu-connect-guide";

describe("Feishu IM", () => {
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
      screen.queryByRole("button", { name: "Connect Feishu IM" }),
    ).toBeNull();
    expect(screen.queryByText("App ID")).toBeNull();
  });

  it("opens its manage dialog from AnotherMe's link", async () => {
    const runtime = createTestTeamHubRuntime();
    const base = await runtime.client.listExternalApps();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue(
      catalog(base),
    );
    vi.spyOn(runtime.client, "listExternalConnections").mockResolvedValue({
      connections: [],
    });
    renderPage(runtime, "/apps?app=feishu_im");

    expect(
      await screen.findByRole("dialog", { name: /Feishu IM/ }),
    ).toBeVisible();
  });

  it("words missing chat scopes as message permissions to add", () => {
    render(
      <FeishuConnectGuide
        error={
          new TeamHubError({
            code: "FEISHU_SCOPES_NOT_ENABLED",
            status: 409,
            message: "The Feishu app your lark-cli uses does not enable them.",
            details: [
              { field: "scope", reason: "im:message" },
              { field: "scope", reason: "im:chat:readonly" },
              {
                field: "permissions_url",
                reason: "https://open.feishu.cn/app/cli_abc/auth",
              },
            ],
          })
        }
      />,
    );

    expect(
      screen.getByText(
        "The Feishu app your lark-cli uses needs message permissions first",
      ),
    ).toBeVisible();
    expect(
      within(screen.getByRole("list", { name: "Message permissions to add" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["im:message", "im:chat:readonly"]);
    expect(
      screen.getByRole("link", { name: /Open permissions page/ }),
    ).toHaveAttribute("href", "https://open.feishu.cn/app/cli_abc/auth");
  });
});

function catalog(base: TeamHubExternalAppList): TeamHubExternalAppList {
  const feishuIm: TeamHubExternalApp = {
    key: "feishu_im",
    display_name: "Feishu IM",
    description:
      "Let your Another Me read and send your Feishu or Lark messages through lark-cli on your Computer.",
    availability: "available",
    capabilities: ["connect", "agent_tools"],
    allows_multiple_connections: true,
    supports_reauthorization: true,
  };
  return {
    ...base,
    apps: [...base.apps.filter((app) => app.key !== "feishu_im"), feishuIm],
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
