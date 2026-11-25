// The operating system's light or dark setting, for tests of code that reads
// `prefers-color-scheme`. jsdom has no `matchMedia`, and the stand-in from
// `setup.ts` never matches and never changes.

type Scheme = "light" | "dark";

let scheme: Scheme = "light";
const listeners = new Set<() => void>();

function mediaQueryList(query: string): MediaQueryList {
  const listen = (_type: string, listener: unknown) =>
    listeners.add(listener as () => void);
  const forget = (_type: string, listener: unknown) =>
    listeners.delete(listener as () => void);
  return {
    get matches() {
      return query.includes("dark") === (scheme === "dark");
    },
    media: query,
    onchange: null,
    addEventListener: listen,
    removeEventListener: forget,
    addListener: (listener: unknown) => listen("change", listener),
    removeListener: (listener: unknown) => forget("change", listener),
    dispatchEvent: () => false,
  } as MediaQueryList;
}

/** Puts the stand-in in place; call once, before the code under test runs. */
export function installSystemColorScheme() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: mediaQueryList,
  });
}

/** The system switches to `next`, and whoever follows it is told. */
export function setSystemColorScheme(next: Scheme) {
  if (scheme === next) return;
  scheme = next;
  for (const listener of [...listeners]) listener();
}
