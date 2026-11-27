// The Wiki tab's pages, chosen as the desktop's Wiki directory does
// (apps/web/src/features/wiki/wiki-directory.tsx): every generated page,
// meeting notes included, but no directory indexes. A page's place comes
// from its page key, the path the
// Wiki generator gave it, so a Session page reads as a dated conversation
// rather than the title TeamHub derives from its file name.
import type { TeamHubDocument } from "../api/types";
import type { Translate } from "../i18n/language";
import type { Message } from "../i18n/messages";
import { libraryWikiMessages as m } from "./wiki-pages.messages";

type WikiDocument = Pick<TeamHubDocument, "title" | "from">;

export type WikiCollection =
  | "projects"
  | "topics"
  | "contacts"
  | "clients"
  | "sessions"
  | "pages";

/** Section order and names; the directories are the generator's node types. */
export const WIKI_COLLECTIONS: readonly {
  readonly id: WikiCollection;
  readonly label: Message<string>;
}[] = [
  { id: "projects", label: m.projects },
  { id: "topics", label: m.topics },
  { id: "contacts", label: m.people },
  { id: "clients", label: m.companies },
  { id: "sessions", label: m.conversations },
  { id: "pages", label: m.pages },
];

const SESSION_PAGE = /^sessions\/(\d{4}-\d{2}-\d{2})\/([^/]+)\.md$/u;
const MEETING_SESSION_ID = /^capture_session_/u;

export function wikiPageKey(document: Pick<TeamHubDocument, "from">) {
  return document.from.find((source) => source.binding_kind === "wiki_page")
    ?.page_key;
}

export function isWikiPage(document: Pick<TeamHubDocument, "from">): boolean {
  return document.from.some((source) => source.binding_kind === "wiki_page");
}

export interface WikiEntry<T extends WikiDocument = TeamHubDocument> {
  readonly document: T;
  readonly title: string;
  readonly collection: WikiCollection;
  /** The day a Session page covers, `YYYY-MM-DD`. */
  readonly sessionDate?: string;
}

function collectionOf(pageKey: string): WikiCollection {
  const first = pageKey.split("/")[0] ?? "";
  return WIKI_COLLECTIONS.some((item) => item.id === first && first !== "pages")
    ? (first as WikiCollection)
    : "pages";
}

/** A reader's title for the page: meeting notes and conversations by kind. */
export function wikiPageTitle(document: WikiDocument, t: Translate): string {
  const session = SESSION_PAGE.exec(wikiPageKey(document) ?? "");
  if (session)
    return MEETING_SESSION_ID.test(session[2]!)
      ? t(m.meetingNotes)
      : t(m.conversation);
  return document.title.trim() || t(m.untitled);
}

/**
 * A Wiki entry for the page. `meetingTitles` maps a recording's Capture ID to
 * its meeting's title, so meeting notes read as the meeting they belong to.
 */
export function wikiEntry<T extends WikiDocument>(
  document: T,
  t: Translate,
  meetingTitles?: ReadonlyMap<string, string>,
): WikiEntry<T> | undefined {
  const pageKey = wikiPageKey(document);
  if (!pageKey) return undefined;
  if (pageKey.split("/").at(-1)?.toLowerCase() === "index.md") return undefined;
  const session = SESSION_PAGE.exec(pageKey);
  return {
    document,
    title:
      (session ? meetingTitles?.get(session[2]!) : undefined) ??
      wikiPageTitle(document, t),
    collection: collectionOf(pageKey),
    ...(session ? { sessionDate: session[1] } : {}),
  };
}

export interface WikiSection<T extends WikiDocument = TeamHubDocument> {
  readonly collection: WikiCollection;
  readonly label: string;
  readonly entries: WikiEntry<T>[];
}

/** Pages grouped by collection, each keeping the list's most-recent-first order. */
export function wikiSections<T extends WikiDocument>(
  documents: readonly T[],
  t: Translate,
  meetingTitles?: ReadonlyMap<string, string>,
): WikiSection<T>[] {
  const byCollection = new Map<WikiCollection, WikiEntry<T>[]>();
  for (const document of documents) {
    const entry = wikiEntry(document, t, meetingTitles);
    if (!entry) continue;
    const list = byCollection.get(entry.collection) ?? [];
    list.push(entry);
    byCollection.set(entry.collection, list);
  }
  return WIKI_COLLECTIONS.flatMap((collection) => {
    const entries = byCollection.get(collection.id);
    return entries?.length
      ? [
          {
            collection: collection.id,
            label: t(collection.label),
            entries,
          },
        ]
      : [];
  });
}
