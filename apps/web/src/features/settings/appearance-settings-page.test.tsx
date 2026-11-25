import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  resetThemeForTest,
  restoreTheme,
  THEME_STORAGE_KEY,
} from "@/app/theme";
import { TeamHubRuntimeProvider } from "@/features/teamhub/teamhub-runtime";
import {
  installSystemColorScheme,
  setSystemColorScheme,
} from "@/test/system-color-scheme";
import { createTestTeamHubRuntime } from "@/test/teamhub-test-runtime";

import { AppearanceSettingsPage } from "./appearance-settings-page";
import { SettingsLayout } from "./settings-page";

describe("Appearance settings", () => {
  beforeAll(installSystemColorScheme);

  afterEach(() => {
    localStorage.removeItem(THEME_STORAGE_KEY);
    setSystemColorScheme("light");
    resetThemeForTest();
  });

  it("offers Light, Dark and System, with System chosen before any choice", async () => {
    restoreTheme();
    renderAppearanceSettings();
    const select = await screen.findByRole("combobox", { name: "Theme" });
    expect(select).toHaveValue("system");
    fireEvent.click(select);
    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "System",
      "Light",
      "Dark",
    ]);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("switches to dark without a reload and remembers the choice", async () => {
    restoreTheme();
    renderAppearanceSettings();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    await chooseTheme("Theme", "Dark");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Appearance" }),
    ).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue("dark");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await chooseTheme("Theme", "Light");
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("follows the system again once System is chosen", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    restoreTheme();
    renderAppearanceSettings();
    expect(await screen.findByRole("combobox", { name: "Theme" })).toHaveValue(
      "dark",
    );

    await chooseTheme("Theme", "System");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(document.documentElement).not.toHaveAttribute("data-theme");
    act(() => setSystemColorScheme("dark"));
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  });

  it("names the theme on screen, and keeps naming it as the system switches", async () => {
    restoreTheme();
    renderAppearanceSettings();
    const hint = () => document.getElementById("interface-theme-hint");
    await screen.findByRole("combobox", { name: "Theme" });
    expect(hint()).toHaveTextContent("it is Light now");

    act(() => setSystemColorScheme("dark"));
    expect(screen.getByRole("combobox", { name: "Theme" })).toHaveValue(
      "system",
    );
    expect(hint()).toHaveTextContent("it is Dark now");
  });

  it("opens in the theme chosen on an earlier visit", async () => {
    setSystemColorScheme("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    restoreTheme();
    renderAppearanceSettings();
    expect(await screen.findByRole("combobox", { name: "Theme" })).toHaveValue(
      "light",
    );
    expect(document.documentElement).not.toHaveAttribute("data-theme");
  });
});

async function chooseTheme(label: string, name: string) {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name }));
}

function renderAppearanceSettings() {
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
                  {
                    element: <AppearanceSettingsPage />,
                    path: "appearance",
                  },
                ],
                element: <SettingsLayout />,
                path: "/t/:tenantId/settings",
              },
            ],
            { initialEntries: ["/t/tenant-northstar/settings/appearance"] },
          )}
        />
      </TeamHubRuntimeProvider>
    </QueryClientProvider>,
  );
}
