import {
  WINDOW_COLORS,
  type Theme,
  type ThemeChoice,
  type WindowColors,
} from "../shared/theme.js";
import type { Module, ModuleContext } from "./modules.js";

// The part of Electron's nativeTheme the shell uses.
export interface NativeTheme {
  themeSource: ThemeChoice;
  readonly shouldUseDarkColors: boolean;
  on(event: "updated", listener: () => void): unknown;
  off(event: "updated", listener: () => void): unknown;
}

/**
 * The theme of everything the shell draws around the Web client: the window
 * behind the page, native menus and dialogs, and the shell's own pages, which
 * read `prefers-color-scheme`. The choice is the Web client's: the page
 * reports it (desktop-ipc.ts) on every load and whenever the person picks one
 * in Settings › Appearance, and it is kept in the desktop settings so the
 * window opens in it before any page loads. Until a page has reported one the
 * shell stays light, which is what a server whose Web client has no dark
 * theme shows; another server starts from there again.
 */
export class ThemeModule implements Module {
  readonly name = "Theme";
  readonly dependsOn = ["Config"];
  readonly #native: NativeTheme;
  #ctx: ModuleContext | undefined;
  #shown: Theme = "light";
  #unsubscribe: (() => void) | undefined;

  constructor(options: { native: NativeTheme }) {
    this.#native = options.native;
  }

  async start(ctx: ModuleContext): Promise<void> {
    this.#ctx = ctx;
    this.#native.themeSource = this.#choice() ?? "light";
    this.#shown = this.current();
    // The system switched between light and dark while it is followed.
    this.#native.on("updated", this.#announce);
    this.#unsubscribe = ctx.bus.on("server.changed", () =>
      this.#set(undefined),
    );
  }

  async stop(): Promise<void> {
    this.#native.off("updated", this.#announce);
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#ctx = undefined;
  }

  /** The theme on screen: the pinned one, or the system's while followed. */
  current(): Theme {
    const choice = this.#choice() ?? "light";
    if (choice !== "system") return choice;
    return this.#native.shouldUseDarkColors ? "dark" : "light";
  }

  /** What the window paints before and behind its pages. */
  colors(): WindowColors {
    return WINDOW_COLORS[this.current()];
  }

  /** Keeps the Web client's choice; what shows colors redraws on the event. */
  choose(choice: ThemeChoice): void {
    if (this.#choice() !== choice) this.#set(choice);
  }

  #choice(): ThemeChoice | undefined {
    return this.#ctx?.config.get().theme;
  }

  #set(choice: ThemeChoice | undefined): void {
    const ctx = this.#ctx;
    if (!ctx || ctx.config.get().theme === choice) return;
    ctx.config.update({ theme: choice });
    this.#native.themeSource = choice ?? "light";
    this.#announce();
  }

  readonly #announce = (): void => {
    const theme = this.current();
    if (theme === this.#shown) return;
    this.#shown = theme;
    this.#ctx?.bus.emit("theme.changed", theme);
  };
}
