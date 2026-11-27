import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConnectedAppsPage } from "@/features/apps/connected-apps-page";
import { DecisionCard } from "@/features/rooms/cards/decision-card";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import { resetLanguageForTest, setLanguage } from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import {
  createTestTeamHubRuntime,
  type TestTeamHubRuntime,
} from "@/test/teamhub-test-runtime";

const connectors = zhCN.connectors;
const cards = zhCN.cards;
const keyField = zhCN.webSearch;

function renderWith(runtime: TestTeamHubRuntime, children: ReactNode) {
  render(
    <MemoryRouter initialEntries={["/apps"]}>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <TeamHubRuntimeProvider runtime={runtime}>
          {children}
        </TeamHubRuntimeProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("web search in the language on screen", () => {
  afterEach(() => {
    resetLanguageForTest();
  });

  it("words the Connectors backends in Chinese and keeps their names", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    runtime.seed.webSearch = {
      ...runtime.seed.webSearch,
      backends: runtime.seed.webSearch.backends.map((backend) =>
        backend.id === "tavily"
          ? {
              ...backend,
              key_state: "verified",
              quota: {
                from: "provider",
                limit: 1000,
                remaining: 812,
                unit: "credits",
              },
              status: "ready",
            }
          : backend,
      ),
    };
    renderWith(runtime, <ConnectedAppsPage />);

    const section = await screen.findByRole("region", {
      name: connectors.filterWebSearch,
    });
    expect(
      within(
        screen.getByRole("group", { name: connectors.connectorCategories }),
      ).getByRole("button", { name: connectors.filterWebSearch }),
    ).toBeVisible();
    const tavily = within(section)
      .getByRole("button", { name: "Tavily" })
      .closest("article")!;
    expect(tavily).toHaveTextContent(
      connectors.connectedWithUsage.replace(
        "{usage}",
        connectors.usageCreditsLeft.replace("{amount}", "812 / 1,000"),
      ),
    );
    expect(
      within(section).getByRole("button", {
        name: connectors.connectApp.replace("{app}", "Exa"),
      }),
    ).toBeVisible();

    fireEvent.click(within(section).getByRole("button", { name: "Tavily" }));
    const dialog = await screen.findByRole("dialog", { name: "Tavily" });
    expect(dialog).toHaveTextContent(connectors.factDoes);
    expect(dialog).toHaveTextContent(connectors.keySaved);
    expect(
      within(dialog).getByLabelText(
        keyField.apiKey.replace("{backend}", "Tavily"),
      ),
    ).toBeVisible();
    expect(
      within(dialog).getByRole("button", { name: connectors.replaceKey }),
    ).toBeVisible();
    // Removing a key cannot be undone, so Voice Mode never clicks it.
    expect(
      within(dialog).getByRole("button", { name: connectors.removeKey }),
    ).toHaveAttribute("data-voice-risk", "never");
  });

  it("words the chat's search key card in Chinese", async () => {
    await setLanguage("zh-CN");
    const runtime = createTestTeamHubRuntime();
    renderWith(
      runtime,
      <DecisionCard
        card={{
          card_type: "personal_notice",
          intent: "decision_requested",
          version: 1,
          decision_id: "search-1",
          kind: "search_key",
          status: "pending",
          title: "Add a Tavily API key so I can search the web.",
          search_key: {
            backend: "tavily",
            origin: "requested",
            reason: "rejected",
          },
          decision_owner: { id: "alice", display_name: "Alice", kind: "human" },
          requester: { id: "writer", display_name: "Writer", kind: "agent" },
        }}
        currentActorId="alice"
        messageId="message-1"
        onDecision={vi.fn()}
        roomId="room-1"
        tenantId="tenant_one"
      />,
    );

    const box = await screen.findByRole("region", {
      name: cards.labelSearchKey,
    });
    expect(box).toHaveTextContent(cards.requested);
    expect(box).toHaveTextContent(
      cards.searchKeyNoLongerAccepted.replace("{backend}", "Tavily"),
    );
    expect(
      within(box).getByRole("button", { name: cards.notNow }),
    ).toBeVisible();
    const others = await within(box).findByRole("button", {
      name: (name) => name.startsWith(cards.otherProviders),
    });
    fireEvent.click(others);
    expect(
      within(box).getByRole("button", { name: cards.hideOtherProviders }),
    ).toBeVisible();
    expect(
      within(box).getByRole("list", { name: cards.otherProviders }),
    ).toBeInTheDocument();
  });
});
