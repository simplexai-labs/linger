// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  installSystemColorScheme,
  setSystemColorScheme,
} from "@/test/system-color-scheme";

import {
  currentTheme,
  getThemeChoice,
  resetThemeForTest,
  restoreTheme,
  setThemeChoice,
  subscribeToTheme,
  THEME_STORAGE_KEY,
} from "./theme";

const root = document.documentElement;

beforeAll(installSystemColorScheme);

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  setSystemColorScheme("light");
  resetThemeForTest();
});

describe("theme", () => {
  it("follows the system until a theme is pinned, and again once it is let go", () => {
    restoreTheme();
    expect(getThemeChoice()).toBe("system");
    expect(root).not.toHaveAttribute("data-theme");

    setSystemColorScheme("dark");
    expect(currentTheme()).toBe("dark");
    expect(root).toHaveAttribute("data-theme", "dark");

    setThemeChoice("light");
    expect(root).not.toHaveAttribute("data-theme");
    setSystemColorScheme("light");
    setSystemColorScheme("dark");
    expect(currentTheme()).toBe("light");
    expect(root).not.toHaveAttribute("data-theme");

    setThemeChoice("system");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root).toHaveAttribute("data-theme", "dark");
    setSystemColorScheme("light");
    expect(root).not.toHaveAttribute("data-theme");
  });

  it("keeps following the system after starting with a pinned theme", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    restoreTheme();
    expect(root).toHaveAttribute("data-theme", "dark");

    setThemeChoice("system");
    expect(root).not.toHaveAttribute("data-theme");
    setSystemColorScheme("dark");
    expect(root).toHaveAttribute("data-theme", "dark");
  });

  it("follows a choice made in another tab", () => {
    restoreTheme();
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    window.dispatchEvent(
      new StorageEvent("storage", { key: THEME_STORAGE_KEY }),
    );
    expect(getThemeChoice()).toBe("dark");
    expect(root).toHaveAttribute("data-theme", "dark");

    // Another key is not a theme choice.
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(getThemeChoice()).toBe("dark");

    // The other tab cleared the whole storage: no pinned theme is left.
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    expect(getThemeChoice()).toBe("system");
    expect(root).not.toHaveAttribute("data-theme");
  });

  it("tells subscribers of a new choice and of the system switching under System", () => {
    restoreTheme();
    const listener = vi.fn();
    const stop = subscribeToTheme(listener);
    setThemeChoice("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    // A pinned theme does not move with the system.
    setSystemColorScheme("dark");
    expect(listener).toHaveBeenCalledTimes(1);
    setThemeChoice("system");
    setSystemColorScheme("light");
    expect(listener).toHaveBeenCalledTimes(3);
    stop();
    setThemeChoice("dark");
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("holds a switch for the session when the choice cannot be saved", () => {
    restoreTheme();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setThemeChoice("dark");
    expect(getThemeChoice()).toBe("dark");
    expect(root).toHaveAttribute("data-theme", "dark");
  });
});

// index.html sets the theme before the first paint with a copy of the rule,
// because the module that owns it loads too late to prevent a flash.
describe("the pre-paint script in index.html", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(
    readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8"),
  )?.[1];

  function paintsDark() {
    root.removeAttribute("data-theme");
    // The page's own script, with the globals it reads.
    runInNewContext(script ?? "", {
      localStorage: window.localStorage,
      matchMedia: (query: string) => window.matchMedia(query),
      document,
    });
    return root.hasAttribute("data-theme");
  }

  it("is there to run", () => {
    expect(script).toContain(THEME_STORAGE_KEY);
  });

  it.each([
    [null, "light"],
    [null, "dark"],
    ["light", "dark"],
    ["dark", "light"],
    ["system", "dark"],
    ["sepia", "dark"],
  ] as const)(
    "paints what the app then shows: stored %s on a %s system",
    (stored, system) => {
      if (stored) localStorage.setItem(THEME_STORAGE_KEY, stored);
      setSystemColorScheme(system);
      const dark = paintsDark();
      restoreTheme();
      expect(currentTheme()).toBe(dark ? "dark" : "light");
      expect(root.hasAttribute("data-theme")).toBe(dark);
    },
  );

  it("follows the system, as the app does, when storage cannot be read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    setSystemColorScheme("dark");
    expect(paintsDark()).toBe(true);
    restoreTheme();
    expect(currentTheme()).toBe("dark");
  });
});
