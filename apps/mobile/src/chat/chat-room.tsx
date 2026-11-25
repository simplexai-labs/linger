// A Room's conversation: header, timeline, run status, composer, with the
// keyboard pushing the composer up on both platforms.
import { now, record } from "../lib/timing";
import {
  useInfiniteQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useIsFocused } from "expo-router";
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  ActivityIndicator,
  AppState,
  FlatList,
  StyleSheet,
  View,
} from "react-native";
import { useRoomPresence } from "./use-room-presence";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { SafeAreaView } from "react-native-safe-area-context";

import { listMessages, updateReadState } from "../api/teamhub";
import type { Message, MessagePage } from "../api/types";
import {
  messagesKey,
  useAppliedSeq,
  useRealtime,
} from "../realtime/realtime-context";
import {
  teamHubKey,
  useDirectAgent,
  useIdentity,
  useTeamHub,
} from "../state/queries";
import { colors, space, type } from "../theme";
import { EmptyState } from "../ui/controls";
import { StatusStrip } from "../ui/status-strip";
import { presentDirectMessage } from "./compose-message";
import { Composer } from "./composer";
import { newestFirst, type MessagePages } from "./message-cache";
import { MessageRow, PendingRow } from "./message-row";
import { useOutbox, useOutboxEntries } from "./outbox-context";
import type { OutboxEntry } from "./outbox";
import { RunStatusBar } from "./run-status-bar";
import { SidebarButton } from "../ui/sidebar-button";
import { Text } from "../ui/text";

type Item =
  | { kind: "message"; message: Message }
  | { kind: "pending"; entry: OutboxEntry };

/** The bar every chat screen draws instead of the drawer's header. */
export function ChatHeader(props: {
  readonly title: string;
  readonly subtitle?: string;
}) {
  return (
    <View style={styles.header}>
      <SidebarButton />
      <View style={styles.headerText}>
        <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={type.caption} numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

/** Advances the Room's read state while it is on screen. */
function useReadState(roomId: string) {
  const teamHub = useTeamHub();
  const client = useQueryClient();
  const focused = useIsFocused();
  const seq = useAppliedSeq(roomId);
  const sent = useRef(0);

  useEffect(() => {
    if (
      !focused ||
      seq === undefined ||
      seq <= sent.current ||
      !teamHub.connected
    )
      return;
    if (AppState.currentState !== "active") return;
    const target = seq;
    const timer = setTimeout(() => {
      void teamHub
        .run((session) => updateReadState(session, roomId, target))
        .then(() => {
          sent.current = Math.max(sent.current, target);
          void client.invalidateQueries({
            queryKey: teamHubKey(teamHub.hostId, "rooms"),
          });
        })
        .catch(() => undefined);
    }, 800);
    return () => clearTimeout(timer);
  }, [client, focused, roomId, seq, teamHub]);
}

export function ChatRoom(props: {
  readonly roomId: string;
  readonly header: ReactNode;
  readonly placeholder: string;
  readonly emptyTitle: string;
  /** The header shows the Agent's work and Stop, so no bar above the composer. */
  readonly runsInHeader?: boolean;
}) {
  const { roomId } = props;
  const teamHub = useTeamHub();
  const identity = useIdentity();
  const realtime = useRealtime();
  const outbox = useOutbox();
  const pending = useOutboxEntries(roomId);
  const myActorId = identity.data?.actorId;
  const directAgentId = useDirectAgent(roomId)?.id;

  const messages = useInfiniteQuery<
    MessagePage,
    Error,
    MessagePages,
    QueryKey,
    string | undefined
  >({
    queryKey: messagesKey(teamHub.hostId, roomId),
    enabled: teamHub.connected,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      teamHub.run((session) => listMessages(session, roomId, pageParam)),
    getNextPageParam: (page) =>
      page.page.has_more ? page.page.next_cursor : undefined,
  });

  // Room open to its first page of messages on screen.
  const openedAt = useRef(now());
  const painted = useRef(false);
  useEffect(() => {
    if (painted.current || !messages.data) return;
    painted.current = true;
    record("room.open_to_first_paint", now() - openedAt.current);
  }, [messages.data]);

  const snapshotSeq = messages.data?.pages[0]?.snapshot_room_seq;
  useEffect(() => {
    if (snapshotSeq !== undefined) realtime.watchRoom(roomId, snapshotSeq);
  }, [realtime, roomId, snapshotSeq, teamHub.session]);

  useReadState(roomId);
  useRoomPresence(roomId);

  const items = useMemo<Item[]>(() => {
    const delivered = newestFirst(messages.data);
    return [
      ...[...pending]
        .reverse()
        .map((entry): Item => ({ kind: "pending", entry })),
      ...delivered.map(
        (message): Item => ({
          kind: "message",
          message: presentDirectMessage(message, directAgentId),
        }),
      ),
    ];
  }, [directAgentId, messages.data, pending]);

  const loading = messages.isPending && items.length === 0;

  return (
    <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
      {/* The keyboard controller follows the keyboard frame by frame, also
          while it is dragged down, and reads its height afresh each time the
          screen appears, so a screen left with the keyboard up comes back
          laid out for a closed one. */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {props.header}
        <StatusStrip />
        {loading ? (
          teamHub.connected ? (
            <View style={styles.center}>
              <ActivityIndicator color={colors.muted} />
            </View>
          ) : (
            <EmptyState
              title="Waiting for your computer"
              body="Messages appear once the phone is connected."
            />
          )
        ) : items.length === 0 ? (
          <EmptyState title={props.emptyTitle} />
        ) : (
          <FlatList
            style={styles.flex}
            data={items}
            inverted
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            keyExtractor={(item) =>
              item.kind === "message"
                ? item.message.id
                : `pending:${item.entry.key}`
            }
            renderItem={({ item, index }) => {
              if (item.kind === "pending")
                return (
                  <PendingRow
                    entry={item.entry}
                    directAgentId={directAgentId}
                    onRetry={() => outbox.retry(item.entry.key)}
                    onDiscard={() => outbox.discard(item.entry.key)}
                  />
                );
              const older = items[index + 1];
              const continued =
                older?.kind === "message" &&
                older.message.author.id === item.message.author.id &&
                older.message.message_kind !== "room_notice";
              return (
                <MessageRow
                  message={item.message}
                  myActorId={myActorId}
                  continued={continued}
                  showAuthor={!directAgentId}
                />
              );
            }}
            onEndReachedThreshold={0.4}
            onEndReached={() => {
              if (messages.hasNextPage && !messages.isFetchingNextPage)
                void messages.fetchNextPage();
            }}
            ListFooterComponent={
              messages.isFetchingNextPage ? (
                <ActivityIndicator style={styles.older} color={colors.muted} />
              ) : undefined
            }
            contentContainerStyle={styles.list}
          />
        )}
        {props.runsInHeader ? null : <RunStatusBar roomId={roomId} />}
        <Composer roomId={roomId} placeholder={props.placeholder} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  flex: { flex: 1 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingRight: space.lg,
    minHeight: 52,
    gap: space.xs,
  },
  headerText: { flex: 1 },
  title: type.headline,
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  // The list is inverted: paddingTop is the gap above the composer.
  list: { paddingTop: space.xl, paddingBottom: space.md },
  older: { paddingVertical: space.lg },
});
