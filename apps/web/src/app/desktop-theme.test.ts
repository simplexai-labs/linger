// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  installSystemColorScheme,
  setSystemColorScheme,
} from "@/test/system-color-scheme";

import { reportThemeToDesktop } from "./desktop-theme";
import {
  resetThemeForTest,
  restoreTheme,
  setThemeChoice,
  THEME_STORAGE_KEY,
} from "./theme";

const desktop = (set = vi.fn(async () => {})) => {
  Object.assign(window, { lingerDesktop: { theme: { set } } });
  return set;
};

beforeAll(installSystemColorScheme);

afterEach(() => {
  delete (window as { lingerDesktop?: unknown }).lingerDesktop;
  localStorage.clear();
  setSystemColorScheme("light");
  resetThemeForTest();
});

describe("reportThemeToDesktop", () => {
  it("reports System too, so the app learns the page has a dark theme", () => {
    const set = desktop();
    restoreTheme();
    const stop = reportThemeToDesktop();
    expect(set).toHaveBeenCalledExactlyOnceWith("system");

    setThemeChoice("dark");
    expect(set).toHaveBeenLastCalledWith("dark");
    setThemeChoice("system");
    expect(set).toHaveBeenLastCalledWith("system");
    expect(set).toHaveBeenCalledTimes(3);
    stop();
  });

  it("reports the remembered choice when the page starts", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    const set = desktop();
    restoreTheme();
    const stop = reportThemeToDesktop();
    expect(set).toHaveBeenCalledExactlyOnceWith("dark");
    stop();
  });

  it("says nothing when only the system switches: the app follows that itself", () => {
    const set = desktop();
    restoreTheme();
    const stop = reportThemeToDesktop();
    setSystemColorScheme("dark");
    setSystemColorScheme("light");
    expect(set).toHaveBeenCalledOnce();
    stop();
  });

  it("keeps the page working when the app refuses or is absent", () => {
    desktop(vi.fn(async () => Promise.reject(new Error("Not allowed"))));
    restoreTheme();
    const stop = reportThemeToDesktop();
    expect(() => setThemeChoice("dark")).not.toThrow();
    stop();

    delete (window as { lingerDesktop?: unknown }).lingerDesktop;
    expect(() => reportThemeToDesktop()()).not.toThrow();
  });
});
