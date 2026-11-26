// Messages: every chat as a card, with who is in it, the latest words and
// what is unread. Another Me leads in a wide card of its own, on the
// sidebar's warm gray with a larger face, because it is the Human's own Agent;
// the rest keep TeamHub's order in two columns of fixed width.
import { router } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import type { RoomListItem } from "../../../api/types";
import { useTranslation } from "../../../i18n/use-translation";
import { roomsMessages as m } from "../../../screens/rooms.messages";
import { previewOf, when } from "../../../chat/room-preview";
import { useAnotherMe, useIdentity, useRooms } from "../../../state/queries";
import { colors, radius, space, type } from "../../../theme";
import { PressScale } from "../../../ui/press-scale";
import { ActorAvatar } from "../../../ui/avatar";
import { RoomAvatar } from "../../../ui/room-avatar";
import { EmptyState } from "../../../ui/controls";
import { StatusStrip } from "../../../ui/status-strip";
import { SidebarButton } from "../../../ui/sidebar-button";
import { Text } from "../../../ui/text";

function Faces(props: { readonly room: RoomListItem; readonly me?: string }) {
  const { room } = props;
  if (room.direct_peer)
    return <ActorAvatar actor={room.direct_peer} size={44} />;
  return (
    <RoomAvatar
      members={room.member_preview ?? []}
      size={44}
      ring={colors.surface}
    />
  );
}

function Badge(props: { readonly count: number }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>
        {props.count > 99 ? "99+" : props.count}
      </Text>
    </View>
  );
}

function AnotherMeCard(props: {
  readonly room: RoomListItem;
  readonly me?: string;
}) {
  const { t } = useTranslation();
  const { room } = props;
  const unread = room.unread_message_count ?? 0;
  const name = room.direct_peer?.display_name || "Another Me";
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? t(m.anotherMeUnread, { name, count: unread })
          : t(m.anotherMeLabel, { name })
      }
      onPress={() => router.navigate("/")}
      style={styles.hero}
    >
      {room.direct_peer ? (
        <ActorAvatar actor={room.direct_peer} size={64} />
      ) : null}
      <View style={styles.heroText}>
        <View style={styles.heroTitleLine}>
          <Text style={styles.heroTitle} numberOfLines={1}>
            {name}
          </Text>
          <View style={styles.tag}>
            <Text style={styles.tagText}>Another Me</Text>
          </View>
        </View>
        <Text style={[type.small, styles.heroPreview]} numberOfLines={2}>
          {previewOf(room, props.me)}
        </Text>
        <Text style={type.caption}>
          {when(room.latest_message?.created_at)}
        </Text>
      </View>
      {unread ? <Badge count={unread} /> : null}
    </PressScale>
  );
}

function RoomCard(props: {
  readonly room: RoomListItem;
  readonly width: number;
  readonly title: string;
  readonly me?: string;
  readonly href: string;
}) {
  const { t } = useTranslation();
  const { room } = props;
  const unread = room.unread_message_count ?? 0;
  const latest = room.latest_message;
  const preview = previewOf(room, props.me);
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? t(m.roomUnread, { title: props.title, count: unread })
          : props.title
      }
      onPress={() => router.navigate(props.href)}
      style={[styles.card, { width: props.width }]}
    >
      <View style={styles.cardTop}>
        <Faces room={room} me={props.me} />
        {unread ? <Badge count={unread} /> : null}
      </View>
      <Text style={styles.cardTitle} numberOfLines={1}>
        {props.title}
      </Text>
      <Text style={[type.small, styles.preview]} numberOfLines={2}>
        {preview}
      </Text>
      <Text style={type.caption}>{when(latest?.created_at)}</Text>
    </PressScale>
  );
}

export default function RoomsScreen() {
  const { t } = useTranslation();
  const rooms = useRooms();
  const anotherMe = useAnotherMe();
  const me = useIdentity().data?.actorId;
  const anotherMeRoom = anotherMe.data?.room_id;
  const lead = rooms.data?.find((room) => room.id === anotherMeRoom);
  const items = (rooms.data ?? []).filter((room) => room.id !== anotherMeRoom);
  // Both columns share the row after the grid's padding and gap, so an odd
  // last card keeps its column's width.
  const { width } = useWindowDimensions();
  const cardWidth = (width - space.md * 3) / 2;
  return (
    <SafeAreaView style={styles.screen} edges={["top"]}>
      <View style={styles.bar}>
        <SidebarButton />
      </View>
      <Text style={styles.title} accessibilityRole="header">
        {t(m.messages)}
      </Text>
      <StatusStrip />
      {rooms.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.muted} />
        </View>
      ) : items.length === 0 && !lead ? (
        <EmptyState title={t(m.noMessages)} />
      ) : (
        <FlatList
          data={items}
          numColumns={2}
          keyExtractor={(room) => room.id}
          columnWrapperStyle={styles.column}
          contentContainerStyle={styles.grid}
          ListHeaderComponent={
            lead ? <AnotherMeCard room={lead} me={me} /> : undefined
          }
          renderItem={({ item }) => (
            <RoomCard
              room={item}
              me={me}
              width={cardWidth}
              title={item.direct_peer?.display_name || item.name || t(m.room)}
              href={`/rooms/${item.id}`}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  bar: { minHeight: 48, justifyContent: "center" },
  title: {
    ...StyleSheet.flatten(type.title),
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
  },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  grid: {
    paddingHorizontal: space.md,
    paddingBottom: space.xxl,
    gap: space.md,
  },
  column: { gap: space.md },
  hero: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.sidebar,
    padding: space.lg,
  },
  heroText: { flex: 1, minWidth: 0, gap: 4 },
  heroTitleLine: { flexDirection: "row", alignItems: "center", gap: space.sm },
  heroTitle: { ...StyleSheet.flatten(type.headline), flexShrink: 1 },
  heroPreview: { color: colors.secondary },
  tag: {
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  tagText: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: "500",
    color: colors.secondary,
  },
  // A Work Item style card: white, r12, only the outline ring, no shadow.
  card: {
    minHeight: 160,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.lg,
    gap: 4,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: space.md,
  },
  cardTitle: {
    ...StyleSheet.flatten(type.chat),
    fontWeight: "600",
    color: colors.ink,
  },
  preview: { flex: 1 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    backgroundColor: colors.danger,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: colors.onAction, fontSize: 12, fontWeight: "600" },
});
