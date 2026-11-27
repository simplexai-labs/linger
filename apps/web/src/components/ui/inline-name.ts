/**
 * A name edited in place (an Agent's, a Room's, the Account's). The name and
 * its field share one box with no fill of their own; pointing at either tints
 * it, so starting to edit adds only a caret. A long name stays on one line.
 * Callers add the text size and alignment.
 */
export const inlineNameButtonClassName =
  "block max-w-full truncate rounded-md px-2 py-0.5 transition-colors duration-150 hover:bg-sidebar-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-focus disabled:opacity-50 motion-reduce:transition-none";

/** The field takes the width of its text, as the name it replaces does. */
export const inlineNameInputClassName =
  "block min-w-[4ch] max-w-full rounded-md bg-transparent px-2 py-0.5 [field-sizing:content] outline-none transition-colors duration-150 hover:bg-sidebar-muted disabled:opacity-50 motion-reduce:transition-none";
