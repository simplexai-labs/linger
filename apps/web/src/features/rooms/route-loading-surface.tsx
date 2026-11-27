import { Skeleton } from "@/components/ui/skeleton";
import { LibraryOverviewSkeleton } from "@/features/library/library-loading-skeletons";
import {
  sectionHasSidebar,
  workspaceSection,
} from "@/features/library/library-section";
import type { TeamHubRoomListItem } from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";

import { navigationMessages } from "./room-navigation.messages";
import { roomSurfaceMessages } from "./room-surface.messages";

/**
 * The Room list inside the secondary navigation while it first loads. Mirrors
 * the room row (a 32px tile and two text lines) so the rail reads as pending
 * the same way the content column does, instead of a bare line of text.
 */
export function RoomNavigationLoading() {
  return (
    <section aria-hidden="true" className="space-y-1">
      <div className="flex h-7 items-center pl-2">
        <Skeleton className="h-3 w-14" />
      </div>
      {["w-28", "w-20", "w-32", "w-24", "w-16"].map((width) => (
        <div
          className="flex min-h-[56px] items-center gap-2 px-2 py-2.5"
          key={width}
        >
          <Skeleton className="size-8 shrink-0 rounded-[10px]" />
          <div className="min-w-0 flex-1 px-1">
            <Skeleton className={`h-3 ${width}`} />
            <Skeleton className="mt-2 h-2 w-2/3" />
          </div>
        </div>
      ))}
    </section>
  );
}

/**
 * The chat column while the lazy Room chat module loads (the header is already
 * painted by the Room surface). Mirrors {@link ChatLoading} so the conversation
 * reads as pending with message skeletons instead of a bare line of text.
 */
export function RoomChatLoading() {
  const t = useT();
  // Covers the whole Room surface, header included, so the real header does
  // not show its title and actions while the conversation is still loading;
  // everything appears together once the chat is ready.
  return (
    <div
      aria-busy="true"
      aria-label={t(roomSurfaceMessages.loadingConversation)}
      className="absolute inset-0 z-[12] flex min-h-0 flex-col bg-app-surface"
      role="status"
    >
      <span className="sr-only">
        {t(roomSurfaceMessages.loadingConversationStatus)}
      </span>
      <RoomHeaderLoading />
      <ChatLoading />
    </div>
  );
}

export function AuthenticatedRouteLoading({
  pathname,
  rooms,
}: {
  pathname: string;
  rooms: TeamHubRoomListItem[];
}) {
  const t = useT();
  const route = classifyRoute(pathname, rooms, t);

  return (
    <div
      aria-busy="true"
      aria-label={t(roomSurfaceMessages.loadingRoute, { name: route.label })}
      className="route-loading-surface flex min-h-0 flex-1 overflow-hidden bg-app-surface"
      data-loading-route={route.kind}
      role="status"
    >
      <span className="sr-only">
        {t(roomSurfaceMessages.loadingRouteStatus, { name: route.label })}
      </span>
      {route.kind === "room" ? (
        <RoomLoading />
      ) : route.kind === "dashboard" ? (
        <DashboardLoading />
      ) : route.kind === "library" ? (
        <LibraryLoading pathname={pathname} />
      ) : route.kind === "document" ? (
        <DocumentLoading />
      ) : (
        <PageLoading />
      )}
    </div>
  );
}

type LoadingRoute =
  | { kind: "dashboard"; label: string }
  | { kind: "document"; label: string }
  | { kind: "library"; label: string }
  | { kind: "page"; label: string }
  | { kind: "room"; label: string };

function classifyRoute(
  pathname: string,
  rooms: TeamHubRoomListItem[],
  t: Translate,
): LoadingRoute {
  const segments = pathname.split("/").filter(Boolean);
  const roomsIndex = segments.indexOf("rooms");
  const documentsIndex = segments.indexOf("documents");
  if (documentsIndex >= 0 && segments[documentsIndex + 1]) {
    return { kind: "document", label: t(roomSurfaceMessages.routeDocument) };
  }
  if (roomsIndex >= 0 && segments[roomsIndex + 1]) {
    const roomId = decodeURIComponent(segments[roomsIndex + 1]!);
    const room = rooms.find((candidate) => candidate.id === roomId);
    return {
      kind: "room",
      label: room?.name ?? t(roomSurfaceMessages.routeRoom),
    };
  }
  if (roomsIndex >= 0) {
    return { kind: "page", label: t(roomSurfaceMessages.routeRooms) };
  }
  if (segments.includes("computers")) {
    return { kind: "page", label: t(roomSurfaceMessages.routeLocalComputers) };
  }
  if (segments.includes("apps")) {
    return { kind: "page", label: t(roomSurfaceMessages.routeApps) };
  }
  if (segments.includes("dashboard")) {
    return { kind: "dashboard", label: t(roomSurfaceMessages.routeDashboard) };
  }
  if (segments.includes("library")) {
    return {
      kind: "library",
      label: segments.includes("wiki")
        ? t(navigationMessages.wiki)
        : t(navigationMessages.library),
    };
  }
  return { kind: "page", label: t(navigationMessages.library) };
}

/**
 * The Room surface while it loads: header and conversation as shapes only, so
 * no title, avatar or status text arrives ahead of the rest of the Room.
 */
function RoomLoading() {
  return (
    <section
      className="app-room-surface flex min-w-0 flex-1 flex-col border-r border-border/60"
      aria-hidden="true"
    >
      <RoomHeaderLoading />
      <div className="room-surface-card flex min-h-0 min-w-0 flex-1 flex-col">
        <ChatLoading />
      </div>
    </section>
  );
}

/** Mirrors the Room header's geometry: avatar, title, members and actions. */
function RoomHeaderLoading() {
  return (
    <header className="room-chat-header room-header flex h-(--app-header-height) shrink-0 items-center gap-3.5 bg-app-surface pl-2.5 pr-4">
      <Skeleton className="size-8 shrink-0 rounded-[10px]" />
      <Skeleton className="h-3.5 w-32" />
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <Skeleton className="h-[18px] w-16 rounded-full" />
        <Skeleton className="size-4" />
        <Skeleton className="size-4" />
      </div>
    </header>
  );
}

/** Enough message rows, with varied body lengths, to fill a typical viewport. */
const CHAT_LOADING_ROWS: ReadonlyArray<{ lines: string[] }> = [
  { lines: ["w-3/4", "w-2/5"] },
  { lines: ["w-11/12", "w-4/5", "w-1/3"] },
  { lines: ["w-2/5"] },
  { lines: ["w-5/6", "w-1/2"] },
  { lines: ["w-3/5"] },
  { lines: ["w-11/12", "w-3/4", "w-2/5"] },
  { lines: ["w-1/2"] },
  { lines: ["w-4/5", "w-1/3"] },
];

function ChatLoading() {
  return (
    <div
      className="room-chat-column flex min-h-0 flex-1 flex-col"
      aria-hidden="true"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-3">
        {/* Fill the column from the bottom with a full conversation's worth of
            rows (the top overflows and clips) so the loaded timeline — usually
            a screen full of messages — does not pop in above an empty gap. */}
        <div className="room-readable mt-auto space-y-3 pt-3 pb-5">
          {CHAT_LOADING_ROWS.map((row, index) => (
            <div className="room-message-card" key={index}>
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 pt-1 pl-2">
                <div className="flex h-[18px] items-center gap-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-2 w-10" />
                </div>
                {row.lines.map((width, lineIndex) => (
                  <Skeleton
                    className={`${lineIndex === 0 ? "mt-3" : "mt-2"} h-3 ${width}`}
                    key={lineIndex}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="room-composer-dock shrink-0 px-3">
        <div className="room-readable flex h-[50px] items-center gap-4 rounded-[var(--composer-radius)] border border-app-border px-2">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <Skeleton className="h-3 w-28 max-w-[40%]" />
          <Skeleton className="ml-auto size-8 shrink-0 rounded-full" />
        </div>
      </div>
    </div>
  );
}

function DashboardLoading() {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-hidden="true">
      <header className="shrink-0 px-5 py-4 sm:px-8">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="mt-2 h-3 w-20" />
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-hidden p-4 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((column) => (
          <section
            className="min-w-0 rounded-xl bg-app-sidebar p-3"
            key={column}
          >
            <Skeleton className="h-4 w-20" />
            <Skeleton className="mt-4 h-20 w-full" />
            <Skeleton className="mt-2 h-16 w-full" />
          </section>
        ))}
      </div>
    </div>
  );
}

/**
 * The Library sidebar is chrome, so it stays in place while the route module
 * loads and only the content column reads as pending.
 */
function WorkspaceSidebarLoading() {
  const t = useT();
  return (
    <>
      <aside
        aria-hidden="true"
        className="hidden w-[220px] shrink-0 bg-app-sidebar px-2 py-3 sm:block"
      >
        <div className="space-y-0.5 text-sm text-app-body">
          {[
            roomSurfaceMessages.libraryOverview,
            commonMessages.search,
            navigationMessages.wiki,
          ].map((item) => (
            <div className="flex h-9 items-center px-2" key={item.id}>
              {t(item)}
            </div>
          ))}
        </div>
        <div className="mt-4 space-y-0.5 text-sm font-medium text-app-body">
          <div className="flex h-9 items-center px-2">
            {t(roomSurfaceMessages.libraryMyPages)}
          </div>
          <div className="flex h-9 items-center px-2">
            {t(roomSurfaceMessages.librarySharedWithMe)}
          </div>
        </div>
      </aside>
      <div className="hidden w-px shrink-0 bg-border/60 sm:block" />
    </>
  );
}

/**
 * The Library overview and Wiki have no sidebar; an open meeting keeps it.
 * The overview mirrors its page so the content lands where its shapes were.
 */
function LibraryLoading({ pathname }: { pathname: string }) {
  const section = workspaceSection(pathname);
  if (section === "overview") {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden" aria-hidden="true">
        <LibraryOverviewSkeleton />
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden" aria-hidden="true">
      {sectionHasSidebar(section) ? <WorkspaceSidebarLoading /> : null}
      <section className="workspace-content-viewport min-w-0 flex-1 px-6 py-7">
        <Skeleton className="h-5 w-32" />
        <div className="mt-5 flex gap-3">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-40" />
        </div>
        <div className="mt-6 space-y-2">
          {["w-full", "w-[92%]", "w-[96%]", "w-[84%]"].map((width) => (
            <Skeleton className={`h-12 ${width}`} key={width} />
          ))}
        </div>
      </section>
    </div>
  );
}

function DocumentLoading() {
  const t = useT();
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <WorkspaceSidebarLoading />
      <main className="workspace-content-viewport flex min-w-0 flex-1 flex-col bg-app-surface">
        <header
          aria-hidden="true"
          className="flex h-(--app-header-height) shrink-0 items-center gap-2 px-3 sm:px-5"
        >
          <span className="text-sm font-medium text-foreground">
            {t(roomSurfaceMessages.routeDocument)}
          </span>
        </header>
        <div
          aria-label={t(roomSurfaceMessages.loadingDocumentBody)}
          className="workspace-content px-5 py-12 sm:px-0"
          role="status"
        >
          <Skeleton className="h-10 w-3/5" />
          <Skeleton className="mt-4 h-4 w-2/5" />
          <div className="mt-12 space-y-3">
            {["w-full", "w-[94%]", "w-[86%]", "w-[98%]", "w-[72%]"].map(
              (width) => (
                <Skeleton className={`h-4 ${width}`} key={width} />
              ),
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function PageLoading() {
  return (
    <div className="min-w-0 flex-1 px-6 py-7" aria-hidden="true">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="workspace-content mt-6 h-24" />
      <Skeleton className="workspace-content mt-3 h-24" />
    </div>
  );
}
