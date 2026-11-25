import { getThemeChoice, subscribeToTheme } from "./theme";

// The desktop app's side of the theme choice (`window.lingerDesktop.theme`);
// absent in a browser and in desktop builds whose own windows are light only.
interface DesktopTheme {
  set(choice: string): Promise<void>;
}

function desktopTheme(): DesktopTheme | undefined {
  return typeof window === "undefined"
    ? undefined
    : (window as { lingerDesktop?: { theme?: DesktopTheme } }).lingerDesktop
        ?.theme;
}

/**
 * Tells the desktop app the theme the person chose, now and on every change,
 * so its window, native menus and own pages match the page. "system" is
 * reported too: it is how the app learns that this page has a dark theme at
 * all, and how a theme pinned earlier is let go. Call after `restoreTheme`.
 */
export function reportThemeToDesktop(): () => void {
  const api = desktopTheme();
  if (!api) return () => {};
  let reported: string | undefined;
  const report = () => {
    const choice = getThemeChoice();
    // The operating system switching under "system" changes no choice.
    if (choice === reported) return;
    reported = choice;
    // An app that cannot take it keeps the theme it has.
    api.set(choice).catch(() => {});
  };
  report();
  return subscribeToTheme(report);
}
