// The Library on the phone: meetings by day, documents by recency, and the
// Wiki by collection, each read-only and each in rows shaped for its kind.
import { useInfiniteQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, SectionList, StyleSheet, View } from "react-native";

import {
  listLibraryDocuments,
  listMeetings,
  listWikiDocuments,
} from "../../../api/teamhub";
import type { MemoryEntry, TeamHubDocument } from "../../../api/types";
import { useTranslation } from "../../../i18n/use-translation";
import { groupByDay } from "../../../library/library-items";
import { libraryScreenMessages as m } from "../../../library/library-screen.messages";
import {
  DocumentRow,
  LibrarySectionHeader,
  MeetingRow,
  WikiRow,
} from "../../../library/library-rows";
import { UnderlineTabs } from "../../../library/underline-tabs";
import { wikiSections, type WikiEntry } from "../../../library/wiki-pages";
import {
  NotConnected,
  teamHubKey,
  useIdentity,
  useTeamHub,
} from "../../../state/queries";
import { colors, space } from "../../../theme";
import { EmptyState } from "../../../ui/controls";
import { StatusStrip } from "../../../ui/status-strip";

type Tab = "meetings" | "documents" | "wiki";

function useListQuery<T>(
  name: Tab,
  fetch: (cursor: string | undefined) => Promise<{ items: T[]; next?: string }>,
) {
  const teamHub = useTeamHub();
  const identity = useIdentity();
  return useInfiniteQuery({
    queryKey: teamHubKey(
      teamHub.hostId,
      name === "meetings" ? "meetings" : "documents",
      name,
    ),
    enabled: teamHub.connected && !!identity.data,
    // Meetings and the Wiki come from the computer's Memory service, which
    // takes a while to come back when the computer's services restart.
    retry: (failures, error) =>
      !(error instanceof NotConnected) && failures < 5,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 15_000),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetch(pageParam),
    getNextPageParam: (page) => page.next,
  });
}

/** What a list needs from its query, whatever the items are. */
interface ListQuery {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly refetch: () => Promise<unknown>;
  readonly fetchNextPage: () => Promise<unknown>;
}

interface Section<T> {
  readonly key: string;
  readonly title?: string;
  readonly data: readonly T[];
}

function List<T>(props: {
  readonly query: ListQuery;
  readonly sections: readonly Section<T>[];
  readonly keyOf: (item: T) => string;
  readonly render: (item: T) => React.ReactElement;
  readonly empty: string;
  readonly emptyBody?: string;
}) {
  const { t } = useTranslation();
  const { query } = props;
  // The spinner follows only the Human's pull: background refetches would
  // set it too, and iOS can leave a spinner set from code stuck on screen.
  const [pulling, setPulling] = useState(false);
  // Pages the list leaves out (meeting Sessions in the Wiki) can fill a whole
  // page; keep reading until something shows or nothing is left.
  const exhausted = props.sections.length > 0 || !query.hasNextPage;
  useEffect(() => {
    if (
      !exhausted &&
      !query.isPending &&
      !query.isError &&
      !query.isFetchingNextPage
    )
      void query.fetchNextPage();
  }, [exhausted, query]);
  if (query.isError)
    return (
      <EmptyState
        title={t(m.listFailed)}
        action={{ label: t(m.tryAgain), onPress: () => void query.refetch() }}
      />
    );
  if (query.isPending || !exhausted)
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  if (props.sections.length === 0)
    return <EmptyState title={props.empty} body={props.emptyBody} />;
  return (
    <SectionList<T, Section<T>>
      sections={props.sections}
      keyExtractor={props.keyOf}
      renderItem={({ item }) => props.render(item)}
      renderSectionHeader={({ section }) =>
        section.title ? <LibrarySectionHeader title={section.title} /> : null
      }
      stickySectionHeadersEnabled={false}
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage)
          void query.fetchNextPage();
      }}
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator style={styles.more} color={colors.muted} />
        ) : undefined
      }
      onRefresh={() => {
        setPulling(true);
        void query.refetch().finally(() => setPulling(false));
      }}
      refreshing={pulling}
      contentContainerStyle={styles.list}
    />
  );
}

function openDocument(document: TeamHubDocument) {
  router.push({
    pathname: "/document/[documentId]",
    params: { documentId: document.id },
  });
}

export default function LibraryScreen() {
  const translation = useTranslation();
  const { t } = translation;
  const [tab, setTab] = useState<Tab>("meetings");
  const teamHub = useTeamHub();
  const tenantId = useIdentity().data?.tenantId ?? "";

  const meetings = useListQuery<MemoryEntry>("meetings", async (cursor) => {
    const page = await teamHub.run((session) =>
      listMeetings(session, tenantId, cursor),
    );
    return { items: page.items, next: page.next_cursor };
  });
  const documents = useListQuery<TeamHubDocument>(
    "documents",
    async (cursor) => {
      const page = await teamHub.run((session) =>
        listLibraryDocuments(session, cursor),
      );
      return {
        items: page.items,
        next: page.page.has_more ? page.page.next_cursor : undefined,
      };
    },
  );
  const wiki = useListQuery<TeamHubDocument>("wiki", async (cursor) => {
    const page = await teamHub.run((session) =>
      listWikiDocuments(session, tenantId, cursor),
    );
    return {
      items: page.items,
      next: page.page.has_more ? page.page.next_cursor : undefined,
    };
  });

  const meetingSections = useMemo(
    () =>
      groupByDay(
        meetings.data?.pages.flatMap((page) => page.items) ?? [],
        (entry) => entry.meeting?.started_at ?? entry.updated_at,
        translation,
      ),
    [meetings.data, translation],
  );
  const documentSections = useMemo(() => {
    const items = documents.data?.pages.flatMap((page) => page.items) ?? [];
    return items.length ? [{ key: "all", data: items }] : [];
  }, [documents.data]);
  const wikiPageSections = useMemo(
    () =>
      wikiSections(
        wiki.data?.pages.flatMap((page) => page.items) ?? [],
        translation.t,
        new Map(
          (meetings.data?.pages.flatMap((page) => page.items) ?? []).flatMap(
            (entry) =>
              entry.meeting?.capture_id
                ? [[entry.meeting.capture_id, entry.title] as const]
                : [],
          ),
        ),
      ).map((section) => ({
        key: section.collection,
        title: section.label,
        data: section.entries,
      })),
    [meetings.data, translation.t, wiki.data],
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: "meetings", label: t(m.meetings) },
    { id: "documents", label: t(m.documents) },
    { id: "wiki", label: t(m.wiki) },
  ];

  return (
    <View style={styles.screen}>
      <StatusStrip />
      <UnderlineTabs
        tabs={tabs}
        selected={tab}
        onSelect={setTab}
        style={styles.tabs}
      />
      {!teamHub.connected ? (
        <EmptyState title={t(m.waitingForComputer)} />
      ) : tab === "meetings" ? (
        <List<MemoryEntry>
          query={meetings}
          sections={meetingSections}
          keyOf={(entry) => entry.id}
          empty={t(m.noMeetings)}
          emptyBody={t(m.noMeetingsBody)}
          render={(entry) => (
            <MeetingRow
              entry={entry}
              onPress={() =>
                router.push({
                  pathname: "/library/meetings/[entryId]",
                  params: { entryId: entry.id },
                })
              }
            />
          )}
        />
      ) : tab === "documents" ? (
        <List<TeamHubDocument>
          query={documents}
          sections={documentSections}
          keyOf={(document) => document.id}
          empty={t(m.noDocuments)}
          emptyBody={t(m.noDocumentsBody)}
          render={(document) => (
            <DocumentRow
              document={document}
              onPress={() => openDocument(document)}
            />
          )}
        />
      ) : (
        <List<WikiEntry>
          query={wiki}
          sections={wikiPageSections}
          keyOf={(entry) => entry.document.id}
          empty={t(m.noWikiPages)}
          emptyBody={t(m.noWikiPagesBody)}
          render={(entry) => (
            <WikiRow
              entry={entry}
              onPress={() => openDocument(entry.document)}
            />
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  tabs: { paddingHorizontal: space.xs },
  list: {
    paddingHorizontal: space.sm,
    paddingTop: space.xs,
    paddingBottom: space.xxl,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  more: { marginVertical: space.lg },
});
