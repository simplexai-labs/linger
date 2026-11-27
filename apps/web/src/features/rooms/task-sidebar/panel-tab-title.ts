/**
 * The name a Message tab is saved with: the start of its text. An empty name
 * is worded as "Untitled" when the tab is shown.
 *
 * Counted in code points, not UTF-16 units, so a cut never leaves half of a
 * surrogate pair. A sequence that several code points make up — a ZWJ family, a
 * flag — can still be cut shorter, which keeps the name well-formed.
 */
export function panelTabTitle(body: string) {
  const normalized = body.trim().replace(/\s+/g, " ");
  const characters = [...normalized];
  return characters.length > MAX_PANEL_TAB_CHARACTERS
    ? `${characters
        .slice(0, MAX_PANEL_TAB_CHARACTERS)
        .join("")
        .trimEnd()}\u2026`
    : normalized;
}

/** How much of a Message names its tab. */
const MAX_PANEL_TAB_CHARACTERS = 24;
