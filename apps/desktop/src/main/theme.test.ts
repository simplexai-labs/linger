import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { WINDOW_COLORS, type ThemeChoice } from "../shared/theme.js";
import { EventBus } from "./modules.js";
import { fakeNativeTheme, stubModule, testHost } from "./test-support.js";
import { ThemeModule } from "./theme.js";

const fixture = async (
  options: { systemDark?: boolean; stored?: ThemeChoice } = {},
) => {
  const bus = new EventBus();
  const changed = vi.fn();
  bus.on("theme.changed", changed);
  const native = fakeNativeTheme(options.systemDark);
  const theme = new ThemeModule({ native });
  const host = testHost(
    [stubModule("Config"), theme],
    options.stored ? { theme: options.stored } : {},
    bus,
  );
  await host.start();
  return { theme, native, host, bus, changed, config: host.ctx.config };
};

describe("ThemeModule", () => {
  it("stays light on a dark system until the Web client reports a theme", async () => {
    const f = await fixture({ systemDark: true });
    expect(f.theme.current()).toBe("light");
    expect(f.native.themeSource).toBe("light");
    expect(f.theme.colors()).toBe(WINDOW_COLORS.light);

    f.theme.choose("system");
    expect(f.theme.current()).toBe("dark");
    expect(f.native.themeSource).toBe("system");
    expect(f.config.get().theme).toBe("system");
    expect(f.changed).toHaveBeenCalledExactlyOnceWith("dark");
    await f.host.stop("quit");
  });

  it("opens in the theme kept from the last run", async () => {
    const pinned = await fixture({ stored: "dark" });
    expect(pinned.theme.current()).toBe("dark");
    expect(pinned.native.themeSource).toBe("dark");
    expect(pinned.theme.colors()).toBe(WINDOW_COLORS.dark);
    await pinned.host.stop("quit");

    const followed = await fixture({ stored: "system", systemDark: true });
    expect(followed.theme.current()).toBe("dark");
    await followed.host.stop("quit");
  });

  it("follows the system only while System is the choice", async () => {
    const f = await fixture({ stored: "system" });
    f.native.setSystemDark(true);
    expect(f.theme.current()).toBe("dark");
    expect(f.changed).toHaveBeenLastCalledWith("dark");

    f.theme.choose("light");
    expect(f.changed).toHaveBeenLastCalledWith("light");
    f.native.setSystemDark(false);
    f.native.setSystemDark(true);
    expect(f.theme.current()).toBe("light");
    expect(f.changed).toHaveBeenCalledTimes(2);
    await f.host.stop("quit");
  });

  it("announces a choice only when the theme on screen changes", async () => {
    const f = await fixture({ stored: "system", systemDark: true });
    // Pinning what the system already shows keeps the colors as they are.
    f.theme.choose("dark");
    expect(f.config.get().theme).toBe("dark");
    // The page reports its choice on every load; the same one is no news.
    f.theme.choose("dark");
    expect(f.changed).not.toHaveBeenCalled();
    await f.host.stop("quit");
  });

  it("goes back to light for another server until its page reports", async () => {
    const f = await fixture({ stored: "dark" });
    f.bus.emit("server.changed", "https://other.example.com");
    expect(f.config.get().theme).toBeUndefined();
    expect(f.theme.current()).toBe("light");
    expect(f.native.themeSource).toBe("light");
    expect(f.changed).toHaveBeenCalledExactlyOnceWith("light");
    await f.host.stop("quit");
  });

  it("stops following the system once stopped", async () => {
    const f = await fixture({ stored: "system" });
    expect(f.native.listeners()).toBe(1);
    await f.host.stop("quit");
    expect(f.native.listeners()).toBe(0);
    f.native.setSystemDark(true);
    expect(f.changed).not.toHaveBeenCalled();
  });
});

// The window paints `canvas` before a shell page does, so a page whose own
// canvas differs would flash on every start and resize.
describe("shell pages", () => {
  const canvas = (page: string, scheme: "light" | "dark"): string => {
    const html = readFileSync(
      new URL(`../shell/${page}.html`, import.meta.url),
      "utf8",
    );
    const dark = html.indexOf("@media (prefers-color-scheme: dark)");
    expect(dark).toBeGreaterThan(-1);
    const block = scheme === "dark" ? html.slice(dark) : html.slice(0, dark);
    return /--canvas:\s*(#[0-9a-f]{6});/i.exec(block)?.[1] ?? "";
  };

  it.each(["titlebar", "offline"])(
    "%s uses the window's canvas in both themes",
    (page) => {
      expect(canvas(page, "light")).toBe(WINDOW_COLORS.light.canvas);
      expect(canvas(page, "dark")).toBe(WINDOW_COLORS.dark.canvas);
    },
  );
});
