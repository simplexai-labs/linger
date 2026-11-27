import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubWebSearchBackend } from "@/features/teamhub/teamhub-types";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

import { ConnectedAppsPage } from "./connected-apps-page";

describe("Web search connectors", () => {
  afterEach(() => vi.restoreAllMocks());

  it("lists every backend after the app groups and filters to them", async () => {
    const runtime = createTestTeamHubRuntime();
    renderPage(runtime);

    const section = await screen.findByRole("region", { name: "Web search" });
    // Direct only opens pages and has nothing to set up.
    expect(cardNames(section)).toEqual([
      "You.com",
      "Tavily",
      "Brave Search",
      "Firecrawl",
      "Exa",
      "DuckDuckGo",
    ]);
    // Like an app card: the free tiers show a status line, a backend that
    // needs a key shows the provider's description and Connect.
    expect(card(section, "DuckDuckGo")).toHaveTextContent(
      "DuckDuckGoDefaultFree, limited",
    );
    expect(
      within(card(section, "DuckDuckGo")).queryByRole("button", {
        name: "Connect DuckDuckGo",
      }),
    ).toBeNull();
    // You.com works without a key and still takes one.
    expect(card(section, "You.com")).toHaveTextContent("Free, limited");
    expect(
      within(card(section, "You.com")).getByRole("button", {
        name: "Connect You.com",
      }),
    ).toBeVisible();
    expect(card(section, "Tavily")).toHaveTextContent(
      "The real-time search engine for AI agents.",
    );

    fireEvent.click(
      within(
        screen.getByRole("tablist", { name: "Connector categories" }),
      ).getByRole("tab", { name: "Web search" }),
    );
    expect(
      screen.queryByRole("region", { name: "Application connections" }),
    ).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    const searchOnly = screen.getByRole("region", { name: "Web search" });
    expect(cardNames(searchOnly)).toHaveLength(6);
    fireEvent.click(
      within(card(searchOnly, "Exa")).getByRole("button", {
        name: "Connect Exa",
      }),
    );
    expect(await screen.findByRole("dialog", { name: "Exa" })).toBeVisible();
  });

  it("shows each provider's live quota on its card", async () => {
    const runtime = createTestTeamHubRuntime();
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    setBackends(runtime, {
      brave: saved({
        quota: {
          from: "last_response",
          limit: 1000,
          observed_at: twoHoursAgo,
          remaining: 986,
          unit: "requests",
        },
      }),
      firecrawl: saved({
        quota: { from: "unavailable", reason: "provider_unavailable" },
      }),
      tavily: saved({
        quota: {
          from: "provider",
          limit: 1000,
          remaining: 812,
          unit: "credits",
        },
      }),
      you: saved({
        key_state: "rejected",
        quota: { from: "unavailable", reason: "key_rejected" },
        status: "key_rejected",
      }),
    });
    renderPage(runtime);

    const section = await screen.findByRole("region", { name: "Web search" });
    expect(card(section, "Tavily")).toHaveTextContent(
      "Connected · 812 / 1,000 credits left",
    );
    expect(card(section, "Brave Search")).toHaveTextContent(
      "986 / 1,000 requests left, as of the last search 2 hours ago",
    );
    expect(card(section, "Firecrawl")).toHaveTextContent(
      "Usage unavailable right now",
    );
    expect(card(section, "You.com")).toHaveTextContent("Key rejected");
  });

  it("saves a key from the dialog without the Composio key flow", async () => {
    const runtime = createTestTeamHubRuntime();
    vi.spyOn(runtime.client, "listExternalApps").mockResolvedValue({
      ...(await runtime.client.listExternalApps()),
      provider_configured: false,
      provider_key: { can_save: true, source: "none" },
    });
    const composioKey = vi.spyOn(runtime.client, "saveExternalProviderKey");
    const bodies: unknown[] = [];
    runtime.server.on(
      "PUT",
      "/v0/web-search/backends/{backend}/key",
      ({ body }) => {
        bodies.push(body);
        setBackends(runtime, {
          tavily: saved({
            quota: {
              from: "provider",
              limit: 1000,
              remaining: 1000,
              unit: "credits",
            },
          }),
        });
        return backend(runtime, "tavily");
      },
    );
    renderPage(runtime);

    const section = await screen.findByRole("region", { name: "Web search" });
    fireEvent.click(within(section).getByRole("button", { name: "Tavily" }));
    const dialog = await screen.findByRole("dialog", { name: "Tavily" });
    expect(dialog).toHaveTextContent("DoesSearches the web and reads pages");
    expect(
      within(dialog).getByRole("link", { name: /app\.tavily\.com\/home/ }),
    ).toHaveAttribute("href", "https://app.tavily.com/home");
    expect(
      within(dialog).queryByRole("button", { name: "Make default" }),
    ).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Tavily API key"), {
      target: { value: " tvly-new " },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save key" }));

    expect(
      await within(dialog).findByRole("button", { name: "Replace key" }),
    ).toBeVisible();
    expect(bodies).toEqual([{ api_key: "tvly-new" }]);
    expect(
      within(dialog).getByRole("button", { name: "Remove key" }),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: "Make default" }),
    ).toBeVisible();
    expect(card(section, "Tavily")).toHaveTextContent(
      "Connected · 1,000 / 1,000 credits left",
    );
    expect(composioKey).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("dialog", { name: /Connect/ }),
    ).not.toBeInTheDocument();
  });

  it("makes a backend the default, clears it, and removes its key", async () => {
    const runtime = createTestTeamHubRuntime();
    setBackends(runtime, { tavily: saved() });
    const requests: string[] = [];
    runtime.server
      .on("PUT", "/v0/web-search/default", ({ body }) => {
        requests.push(`default ${JSON.stringify(body)}`);
        runtime.seed.webSearch = {
          ...runtime.seed.webSearch,
          chosen_default_search: "tavily",
          default_search: "tavily",
        };
        return { chosen_default_search: "tavily", default_search: "tavily" };
      })
      .on("DELETE", "/v0/web-search/default", () => {
        requests.push("clear default");
        const { chosen_default_search: _chosen, ...rest } =
          runtime.seed.webSearch;
        runtime.seed.webSearch = { ...rest, default_search: "you" };
        return { default_search: "you" };
      })
      .on("DELETE", "/v0/web-search/backends/{backend}/key", ({ params }) => {
        requests.push(`remove ${params.backend}`);
        setBackends(runtime, {
          tavily: {
            key_state: "none",
            quota: { from: "unavailable", reason: "no_key" },
            status: "key_required",
          },
        });
        return undefined;
      });
    renderPage(runtime);

    const section = await screen.findByRole("region", { name: "Web search" });
    fireEvent.click(within(section).getByRole("button", { name: "Tavily" }));
    const dialog = await screen.findByRole("dialog", { name: "Tavily" });

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Make default" }),
    );
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Clear default" }),
    );
    expect(
      await within(dialog).findByRole("button", { name: "Make default" }),
    ).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove key" }));
    expect(
      await within(dialog).findByRole("button", { name: "Save key" }),
    ).toBeVisible();
    expect(requests).toEqual([
      'default {"backend":"tavily"}',
      "clear default",
      "remove tavily",
    ]);
    expect(
      within(card(section, "Tavily")).getByRole("button", {
        name: "Connect Tavily",
      }),
    ).toBeVisible();
  });

  it("keeps backends with a saved key or a free tier under Connected only", async () => {
    const runtime = createTestTeamHubRuntime();
    setBackends(runtime, {
      firecrawl: saved({ key_state: "rejected", status: "key_rejected" }),
      tavily: saved(),
    });
    renderPage(runtime);

    await screen.findByRole("region", { name: "Web search" });
    fireEvent.click(screen.getByRole("switch", { name: "Connected only" }));
    expect(
      cardNames(
        screen.getByRole("region", { name: "Application connections" }),
      ),
    ).toEqual(["Gmail"]);
    expect(
      cardNames(screen.getByRole("region", { name: "Web search" })),
    ).toEqual(["You.com", "Tavily", "Firecrawl", "DuckDuckGo"]);
  });

  it("explains a server that cannot store keys instead of showing a field", async () => {
    const runtime = createTestTeamHubRuntime();
    runtime.seed.webSearch = {
      ...runtime.seed.webSearch,
      can_save_keys: false,
    };
    renderPage(runtime);

    const section = await screen.findByRole("region", { name: "Web search" });
    fireEvent.click(within(section).getByRole("button", { name: "Tavily" }));
    const dialog = await screen.findByRole("dialog", { name: "Tavily" });
    expect(dialog).toHaveTextContent("TEAMHUB_SECRET_ENCRYPTION_KEY");
    expect(within(dialog).queryByLabelText("Tavily API key")).toBeNull();
  });
});

function saved(
  change: Partial<TeamHubWebSearchBackend> = {},
): Partial<TeamHubWebSearchBackend> {
  return { key_state: "verified", status: "ready", ...change };
}

function setBackends(
  runtime: TestTeamHubRuntime,
  changes: Partial<Record<string, Partial<TeamHubWebSearchBackend>>>,
) {
  runtime.seed.webSearch = {
    ...runtime.seed.webSearch,
    backends: runtime.seed.webSearch.backends.map((entry) => ({
      ...entry,
      ...changes[entry.id],
    })),
  };
}

function backend(runtime: TestTeamHubRuntime, id: string) {
  return runtime.seed.webSearch.backends.find((entry) => entry.id === id);
}

function cardNames(region: HTMLElement) {
  return within(region)
    .getAllByRole("article")
    .map((entry) => within(entry).getAllByRole("button")[0]!.ariaLabel);
}

function card(region: HTMLElement, name: string) {
  return within(region).getByRole("button", { name }).closest("article")!;
}

function renderPage(runtime: TestTeamHubRuntime) {
  return render(
    <MemoryRouter initialEntries={["/apps"]}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          <ConnectedAppsPage />
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
