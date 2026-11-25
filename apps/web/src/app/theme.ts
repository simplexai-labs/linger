/**
 * The interface theme: light, dark, or whatever the operating system uses.
 *
 * The choice is kept per browser, like the language choice: the sign-in page
 * and the desktop shell render before any account is known. No stored value
 * means the person has not pinned a theme, so the interface follows the
 * system (`prefers-color-scheme`).
 *
 * The theme on screen is `data-theme="dark"` on the document element, and no
 * attribute for light. The inline script in `index.html` sets it before the
 * first paint from the same key and by the same rule; `theme.test.ts` runs
 * that script against this module so the two cannot drift apart.
 */

export const THEME_CHOICES = ["system", "light", "dark"] as const;

export type ThemeChoice = (typeof THEME_CHOICES)[number];

export type Theme = Exclude<ThemeChoice, "system">;

export const THEME_STORAGE_KEY = "linger.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

// Kept in memory as well, so a switch holds for this session where storage
// cannot be written.
let choice: ThemeChoice = "system";
let following = false;
const listeners = new Set<() => void>();

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return THEME_CHOICES.some((candidate) => candidate === value);
}

function storedThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/** What the person chose on this device; "system" before any choice. */
export function getThemeChoice(): ThemeChoice {
  return choice;
}

/** The theme on screen right now: the pinned one, or the system's. */
export function currentTheme(): Theme {
  if (choice !== "system") return choice;
  return typeof window !== "undefined" && window.matchMedia(DARK_QUERY).matches
    ? "dark"
    : "light";
}

/** Called on every change of the choice or of the theme on screen. */
export function subscribeToTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function showTheme() {
  if (typeof document !== "undefined") {
    const root = document.documentElement;
    if (currentTheme() === "dark") root.setAttribute("data-theme", "dark");
    else root.removeAttribute("data-theme");
  }
  for (const listener of listeners) listener();
}

/**
 * Switches the interface to `next` and remembers it. "system" forgets the
 * pinned theme, so the interface follows the operating system again.
 */
export function setThemeChoice(next: ThemeChoice) {
  choice = next;
  try {
    if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // The switch still holds for this session without saved preferences.
  }
  showTheme();
}

/**
 * Takes up the remembered choice and keeps the interface in step with the
 * operating system and with other tabs from then on.
 */
export function restoreTheme() {
  choice = storedThemeChoice();
  showTheme();
  if (typeof window === "undefined" || following) return;
  following = true;
  // Both stay installed whatever the choice is now: it can go back to
  // "system" later, and each handler looks at the choice of the moment.
  window.matchMedia(DARK_QUERY).addEventListener("change", () => {
    if (choice === "system") showTheme();
  });
  // Another tab of this browser changed the theme: follow it.
  window.addEventListener("storage", (event) => {
    // A null key is the whole storage being cleared.
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    choice = storedThemeChoice();
    showTheme();
  });
}

/** Puts the interface back to the system's theme between tests. */
export function resetThemeForTest() {
  choice = "system";
  showTheme();
}
