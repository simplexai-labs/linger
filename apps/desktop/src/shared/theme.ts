// The theme the Web client reports and the window colors that go with it.

export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

export type Theme = Exclude<ThemeChoice, "system">;

export interface WindowColors {
  // The window before any page paints, and the title bar where one is drawn.
  readonly canvas: string;
  // Behind the Web client until it paints: its own background.
  readonly page: string;
  // The caption buttons Windows draws over the title bar.
  readonly symbol: string;
}

// `page` follows the Web client's --town-background, and `canvas` the
// --canvas of the shell pages (titlebar.html, offline.html).
export const WINDOW_COLORS: Record<Theme, WindowColors> = {
  light: { canvas: "#f6f6f6", page: "#ffffff", symbol: "#404040" },
  dark: { canvas: "#1a1a17", page: "#131310", symbol: "#d6d6d0" },
};
