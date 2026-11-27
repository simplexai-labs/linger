import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  Building03Icon,
} from "@hugeicons/core-free-icons";
import { lazy, type ReactNode, Suspense, useMemo } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Icon } from "@/components/ui/icon";
import { useTabIndicator } from "@/components/ui/tab-indicator";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubDocument } from "@/features/teamhub/teamhub-types";
import { documentFileName } from "@/features/library/document-display-name";
import { commonMessages } from "@/i18n/common.messages";
import { type Translate, formatLocale, translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import { useWikiDocuments } from "./knowledge-sidebar-trees";
import { WikiDailyCard } from "./wiki-daily-card";
import {
  wikiEntries,
  type WikiEntry,
  wikiPreviewPages,
  type WikiPreviewPage,
} from "./wiki-preview-pages";
import { WikiProfileEditButton } from "./wiki-profile-edit-button";
import { usePersonalWikiRefresh, type WikiRefreshStatus } from "./wiki-refresh";
import { WikiRefreshBanner } from "./wiki-refresh-status";
import { useAnotherMeActorId } from "./wiki-working-card";
import { wikiPreviewPath } from "./wiki-preview-page";
import {
  useWikiDisplayState,
  wikiCollection,
  wikiPageKey,
  wikiPagePath,
  type WikiCollection,
} from "./wiki-display-state";
import { parseEmbeddedWikiGraph } from "@/features/memory/wiki-graph-model";
import {
  reportDate,
  usePeriodReports,
} from "@/features/memory/wiki-period-reports";
import { wikiMessages as m } from "./wiki.messages";
import "./wiki-home-page.css";

const entityHues = [
  "#1c509c",
  "#9c731c",
  "#4a1c9c",
  "#1c9c2f",
  "#9c2a1c",
  "#5e9c1c",
];

export function pageName(page: TeamHubDocument) {
  return documentFileName(page).replace(/\.md$/i, "");
}

export function initials(name: string) {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  return (
    words.length > 1
      ? `${words[0]![0]}${words[words.length - 1]![0]}`
      : (words[0] ?? "?").slice(0, 2)
  ).toUpperCase();
}

/** People and companies take the palette in order; a member keeps one hue. */
function entityColors(key: number | string) {
  let index = typeof key === "number" ? key : 0;
  if (typeof key === "string")
    for (const char of key) index = (index * 31 + char.codePointAt(0)!) | 0;
  const color = entityHues[Math.abs(index) % entityHues.length]!;
  return { background: `${color}1a`, color };
}

export function editedLabel(page: TeamHubDocument, t: Translate = translate) {
  const date = new Date(page.updated_at);
  return Number.isNaN(date.valueOf())
    ? ""
    : t(m.edited, {
        date: new Intl.DateTimeFormat(formatLocale(), {
          month: "short",
          day: "numeric",
        }).format(date),
      });
}

/** Graph nodes by Wiki page key; descriptions and links feed the cards. */
export function useWikiGraphNodes(tenantId: string, enabled = true) {
  const { client } = useTeamHubRuntime();
  const graph = useQuery({
    enabled,
    queryFn: () => client.getPersonalKnowledgeGraphVisualization(tenantId),
    queryKey: ["teamhub", tenantId, "personal-wiki", "graph"],
    retry: false,
  });
  return useMemo(
    () =>
      new Map(
        (graph.data ? parseEmbeddedWikiGraph(graph.data)?.nodes : [])?.map(
          (node) => [node.id, node],
        ),
      ),
    [graph.data],
  );
}

export function useWikiCollectionPages(tenantId: string) {
  const documents = useWikiDocuments(tenantId);
  const display = useWikiDisplayState(tenantId);
  const pages = (
    documents.data?.pages.flatMap((page) => page.items) ?? []
  ).filter(
    (page) =>
      page.from.some((source) => source.binding_kind === "wiki_page") &&
      !/\/index\.md$/i.test(wikiPagePath(page)) &&
      display.decisions[wikiPageKey(wikiPagePath(page))] !== "delete",
  );
  const of = (collection: WikiCollection) =>
    pages.filter((page) => wikiCollection(page) === collection);
  return {
    pending: documents.isPending,
    error: Boolean(documents.error),
    of,
    /** The collection's cards with the running refresh's pages in place. */
    entries: (collection: WikiCollection, previews: WikiPreviewPage[]) =>
      wikiEntries(
        of(collection),
        previews.filter((page) => display.decisions[page.key] !== "delete"),
        collection,
      ),
  };
}

const homeTabs = [
  { id: "profile", label: m.profileTab },
  { id: "wiki", label: m.title },
] as const;
type WikiHomeTab = (typeof homeTabs)[number]["id"];

const ProfilePage = lazy(async () => {
  const { WikiProfilePage } = await import("./wiki-profile-page");
  return { default: WikiProfilePage };
});

/**
 * Wiki opens on the reader's Profile; the Wiki tab holds the generated pages.
 */
export function WikiHomePage() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [searchParams, setSearchParams] = useSearchParams();
  const tab: WikiHomeTab =
    searchParams.get("tab") === "wiki" ? "wiki" : "profile";
  const refresh = usePersonalWikiRefresh(tenantId);
  const { tabRef, indicator } = useTabIndicator(tab);
  const t = useT();
  return (
    <main className="workspace-content-viewport workspace-scrollbar wiki-landing min-w-0 flex-1 overflow-y-auto bg-app-surface [scrollbar-gutter:stable]">
      {/* Same column, heading and tabs as the Library page. */}
      <div className="workspace-file-browser">
        <h1 className="sr-only">{t(m.title)}</h1>
        {/* Profile and Wiki tabs head the page in the Library column. */}
        <header className="wiki-home-header flex items-center gap-3">
          <div
            aria-label={t(m.views)}
            className="workspace-file-tabs relative flex max-w-full gap-1 overflow-x-auto"
            role="tablist"
          >
            {homeTabs.map((candidate) => (
              <button
                aria-selected={candidate.id === tab}
                className="workspace-view-tab inline-flex h-8 shrink-0 items-center rounded-md px-3 text-lg font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                key={candidate.id}
                onClick={() =>
                  setSearchParams(
                    candidate.id === "wiki" ? { tab: "wiki" } : {},
                  )
                }
                ref={tabRef(candidate.id)}
                role="tab"
                type="button"
              >
                {t(candidate.label)}
              </button>
            ))}
            {indicator}
          </div>
          {tab === "wiki" ? null : (
            <WikiProfileEditButton tenantId={tenantId} />
          )}
        </header>
        {tab === "wiki" ? (
          <WikiOverview refresh={refresh} tenantId={tenantId} />
        ) : (
          <div className="landing-profile-tab">
            <Suspense
              fallback={
                <p role="status" className="text-sm text-app-muted">
                  {t(m.loadingProfile)}
                </p>
              }
            >
              <ProfilePage />
            </Suspense>
          </div>
        )}
      </div>
    </main>
  );
}

/** The generated Wiki: Daily reports and the page collections. While a
 * refresh runs, the pages it has written appear in their collections. */
function WikiOverview({
  refresh,
  tenantId,
}: {
  refresh: WikiRefreshStatus;
  tenantId: string;
}) {
  const { preview, refreshing } = refresh;
  const navigate = useNavigate();
  const collections = useWikiCollectionPages(tenantId);
  const nodes = useWikiGraphNodes(tenantId, refresh.hasPublishedWiki);
  const reports = usePeriodReports(tenantId, "daily");
  const previews = useMemo(() => wikiPreviewPages(preview), [preview]);
  const anotherMe = useAnotherMeActorId(tenantId);
  const t = useT();
  const base = `/t/${encodeURIComponent(tenantId)}/library/wiki`;
  const documentPath = (page: TeamHubDocument) =>
    `/t/${encodeURIComponent(tenantId)}/documents/${encodeURIComponent(page.id)}`;
  const daily = [...(reports.data ?? [])]
    .filter(reportDate)
    .sort((a, b) => (reportDate(b) ?? "").localeCompare(reportDate(a) ?? ""));
  const projects = collections.entries("projects", previews);
  const topics = collections.entries("topics", previews);
  const people = collections.entries("contacts", previews);
  const companies = collections.entries("clients", previews);
  const peopleById = new Map(
    people.map((entry) => [entry.key, entryName(entry)]),
  );
  const description = (entry: WikiEntry) =>
    entry.preview
      ? entry.preview.description
      : nodes.get(entry.key)?.description;
  const subtitle = (entry: WikiEntry) =>
    description(entry) ||
    (entry.published ? editedLabel(entry.published, t) : "");
  const card = { documentPath, tenantId };
  const status = (empty: Message<string>) =>
    collections.pending ? (
      <p className="landing-empty">{t(commonMessages.loading)}</p>
    ) : collections.error ? (
      <p role="alert" className="landing-empty">
        {t(m.pagesUnavailable)}
      </p>
    ) : refreshing ? null : (
      <p className="landing-empty">{t(empty)}</p>
    );

  return (
    <>
      <div className="landing-notices">
        <WikiRefreshBanner {...refresh} agentActorId={anotherMe} />
      </div>
      <div className="landing-grid">
        <div className="landing-col landing-col-left">
          <section className="landing-section landing-daily">
            <SectionHeader title={t(m.dailyReport)} to={`${base}/graph`} />
            {reports.isPending ? (
              <p className="landing-empty">{t(m.loadingReports)}</p>
            ) : reports.error ? (
              <p role="alert" className="landing-empty">
                {t(m.reportsUnavailable)}
              </p>
            ) : daily.length ? (
              <div className="daily-list">
                {daily.slice(0, 2).map((entry) => {
                  const day = reportDate(entry)!;
                  const open = () =>
                    void navigate(
                      `${base}/graph?day=${encodeURIComponent(day)}`,
                    );
                  return (
                    <WikiDailyCard
                      key={entry.id}
                      tenantId={tenantId}
                      day={day}
                      entry={entry}
                      onOpen={open}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="landing-empty">{t(m.noDailyReports)}</p>
            )}
          </section>
          <EntryCards
            {...card}
            className="landing-projects"
            title={t(m.projects)}
            to={`${base}/projects`}
            entries={projects}
            empty={status(m.noProjects)}
            description={description}
            members={(entry) =>
              [
                ...new Set([
                  ...(nodes.get(entry.key)?.links ?? []),
                  ...(nodes.get(entry.key)?.backlinks ?? []),
                ]),
              ]
                .map((id) => peopleById.get(id))
                .filter((name): name is string => Boolean(name))
                .slice(0, 3)
            }
          />
          <EntryCards
            {...card}
            className="landing-topics"
            title={t(m.topics)}
            to={`${base}/topics`}
            entries={topics}
            empty={status(m.noTopics)}
            description={description}
            members={() => []}
          />
        </div>
        <div className="landing-col landing-col-right">
          <section className="landing-section landing-people">
            <SectionHeader title={t(m.people)} to={`${base}/contacts`} />
            {people.length ? (
              <div className="people-grid">
                {people.slice(0, 4).map((entry, index) => (
                  <WikiEntryLink
                    {...card}
                    className="person-card"
                    entry={entry}
                    key={entry.key}
                  >
                    <span className="person-avatar" style={entityColors(index)}>
                      {initials(entryName(entry))}
                    </span>
                    <span className="person-name">{entryName(entry)}</span>
                    <span className="person-role">{subtitle(entry)}</span>
                  </WikiEntryLink>
                ))}
              </div>
            ) : (
              status(m.noPeople)
            )}
          </section>
          <section className="landing-section landing-companies">
            <SectionHeader title={t(m.companies)} to={`${base}/clients`} />
            {companies.length ? (
              <div className="companies-grid">
                {companies.slice(0, 6).map((entry, index) => (
                  <WikiEntryLink
                    {...card}
                    className="company-card"
                    entry={entry}
                    key={entry.key}
                  >
                    <span className="company-icon" style={entityColors(index)}>
                      <Icon icon={Building03Icon} size={16} />
                    </span>
                    <span className="company-info">
                      <span className="company-name">{entryName(entry)}</span>
                      <span className="company-desc">{subtitle(entry)}</span>
                    </span>
                  </WikiEntryLink>
                ))}
              </div>
            ) : (
              status(m.noCompanies)
            )}
          </section>
        </div>
      </div>
    </>
  );
}

export function entryName(entry: WikiEntry) {
  return entry.preview ? entry.preview.name : pageName(entry.published);
}

/** A card opens its page: the published Document, or the page the running
 * refresh is writing, in the same page layout. */
export function WikiEntryLink({
  children,
  className,
  documentPath,
  entry,
  tenantId,
}: {
  children: ReactNode;
  className: string;
  documentPath: (page: TeamHubDocument) => string;
  entry: WikiEntry;
  tenantId: string;
}) {
  return (
    <Link
      className={className}
      to={
        entry.published
          ? documentPath(entry.published)
          : wikiPreviewPath(tenantId, entry.preview.path)
      }
    >
      {children}
    </Link>
  );
}

/** Projects and Topics: three cards with a description, edit date and members. */
function EntryCards({
  className,
  title,
  to,
  entries,
  empty,
  documentPath,
  tenantId,
  description,
  members,
}: {
  className: string;
  title: string;
  to: string;
  entries: WikiEntry[];
  empty: ReactNode;
  documentPath: (page: TeamHubDocument) => string;
  tenantId: string;
  description: (entry: WikiEntry) => string | undefined;
  members: (entry: WikiEntry) => string[];
}) {
  const t = useT();
  return (
    <section className={`landing-section ${className}`}>
      <SectionHeader title={title} to={to} />
      {entries.length ? (
        <div className="projects-grid">
          {entries.slice(0, 3).map((entry) => (
            <WikiEntryLink
              className="project-card"
              documentPath={documentPath}
              entry={entry}
              key={entry.key}
              tenantId={tenantId}
            >
              <span className="project-card-title">{entryName(entry)}</span>
              <span className="project-card-desc">{description(entry)}</span>
              <span className="project-card-meta">
                <span className="project-card-time">
                  {entry.published ? editedLabel(entry.published, t) : ""}
                </span>
                <span className="project-involvers">
                  {members(entry).map((name) => (
                    <span
                      className="project-involver"
                      key={name}
                      style={{
                        background: `color-mix(in srgb, ${entityColors(name).color} 22%, white)`,
                      }}
                      title={name}
                    >
                      {initials(name)}
                    </span>
                  ))}
                </span>
              </span>
            </WikiEntryLink>
          ))}
        </div>
      ) : (
        empty
      )}
    </section>
  );
}

function SectionHeader({ title, to }: { title: string; to: string }) {
  const t = useT();
  return (
    <header className="landing-section-header">
      <h2 className="landing-section-title">{title}</h2>
      <Link className="landing-view-all" to={to}>
        {t(m.viewAll)}
        <Icon icon={ArrowRight02Icon} size={14} />
      </Link>
    </header>
  );
}

export function WikiBack() {
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const t = useT();
  return (
    <Link
      aria-label={t(m.backToWiki)}
      className="wiki-back"
      to={`/t/${encodeURIComponent(tenantId)}/library/wiki?tab=wiki`}
    >
      <Icon icon={ArrowLeft02Icon} size={16} />
      {t(commonMessages.back)}
    </Link>
  );
}
