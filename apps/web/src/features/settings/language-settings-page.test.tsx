import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import {
  LANGUAGE_STORAGE_KEY,
  LANGUAGES,
  restoreLanguage,
} from "@/i18n/language";
import zhCN from "@/i18n/locales/zh-CN.json";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { LanguageSettingsPage } from "./language-settings-page";
import { SettingsLayout } from "./settings-page";

const chinese = zhCN.settings;
const chineseName = LANGUAGES.find(({ tag }) => tag === "zh-CN")!.name;

describe("Language settings", () => {
  it("offers each language under its own name, with English chosen", async () => {
    renderLanguageSettings();
    const select = await screen.findByRole("combobox", {
      name: "Interface language",
    });
    expect(select).toHaveValue("en");
    expect(select).toHaveTextContent("English");
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      LANGUAGES.map(({ name }) => name),
    );
    expect(options[1]!.querySelector("[lang]")).toHaveAttribute(
      "lang",
      "zh-CN",
    );
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBeNull();
  });

  it("switches the page and the Settings navigation without a reload", async () => {
    renderLanguageSettings();
    await chooseLanguage("Interface language", chineseName);

    expect(
      await screen.findByRole("heading", { level: 1, name: chinese.language }),
    ).toBeVisible();
    const sections = screen.getByRole("navigation", { name: chinese.sections });
    expect(
      within(sections).getByRole("link", { name: chinese.account }),
    ).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: chinese.interfaceLanguage }),
    ).toHaveAccessibleDescription(chinese.interfaceLanguageHint);
    expect(screen.queryByText("Interface language")).not.toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("zh-CN");

    await chooseLanguage(chinese.interfaceLanguage, "English");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Language" }),
    ).toBeVisible();
    expect(document.documentElement).toHaveAttribute("lang", "en");
    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("en");
  });

  it("opens in the language chosen on an earlier visit", async () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, "zh-CN");
    await restoreLanguage();
    renderLanguageSettings();
    expect(
      await screen.findByRole("combobox", { name: chinese.interfaceLanguage }),
    ).toHaveValue("zh-CN");
    expect(
      screen.getByRole("heading", { level: 1, name: chinese.language }),
    ).toBeVisible();
  });
});

async function chooseLanguage(label: string, name: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

function renderLanguageSettings() {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TeamHubRuntimeProvider runtime={createTestTeamHubRuntime()}>
        <RouterProvider
          router={createMemoryRouter(
            [
              {
                children: [
                  { element: <LanguageSettingsPage />, path: "language" },
                ],
                element: <SettingsLayout />,
                path: "/t/:tenantId/settings",
              },
            ],
            { initialEntries: ["/t/tenant-northstar/settings/language"] },
          )}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}
