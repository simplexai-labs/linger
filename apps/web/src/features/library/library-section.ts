import type { LibrarySection } from "./library-sidebar";

/**
 * Which Library section a path shows. Kept apart from the lazy layout so the
 * route loading placeholder, on the initial graph, draws the same chrome.
 */
export function workspaceSection(pathname: string): LibrarySection | null {
  const rest = pathname.match(/^\/t\/[^/]+\/library(?=\/|$)(.*)$/)?.[1];
  if (rest === undefined) return null;
  if (rest.startsWith("/wiki")) return "wiki";
  // An open meeting keeps the Library sidebar beside it.
  if (rest.startsWith("/meetings")) return null;
  return "overview";
}

/** The overview and the Wiki fill the page; other sections keep the sidebar. */
export function sectionHasSidebar(section: LibrarySection | null) {
  return section !== "wiki" && section !== "overview";
}
