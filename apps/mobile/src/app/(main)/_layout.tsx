// The signed-in shell. The sidebar is Messages: Another Me's card on top as
// on the desktop, the tools (the Library now) drawn as list rows, every other
// chat with its last words, and the computer with Settings at the foot. Without a paired computer it sends
// the phone to pairing; a computer whose key changed blocks everything until
// re-paired.
import { Redirect, router, usePathname } from "expo-router";
import { Drawer, type DrawerContentComponentProps } from "expo-router/drawer";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useComputer } from "../../computer/computer-context";
import type { ConnectionStatus } from "../../computer/connection";
import type { RoomListItem } from "../../api/types";
import type { Translate } from "../../i18n/language";
import { useTranslation } from "../../i18n/use-translation";
import { navigationMessages as m } from "../../screens/navigation.messages";
import { useAnotherMe, useIdentity, useRooms } from "../../state/queries";
import { tick } from "../../ui/haptics";
import { colors, radius, space, type } from "../../theme";
import { ActorAvatar, AgentAvatar, useAgentBrand } from "../../ui/avatar";
import { previewOf, when } from "../../chat/room-preview";
import { Button, EmptyState } from "../../ui/controls";
import { PressScale } from "../../ui/press-scale";
import { RoomAvatar } from "../../ui/room-avatar";
import { Icon, type IconName } from "../../ui/icon";
import { Text } from "../../ui/text";

function statusLabel(
  t: Translate,
  status: ConnectionStatus | undefined,
  route: string | undefined,
): string {
  switch (status?.kind) {
    case "connected":
      return route === "relay" ? t(m.throughRelay) : t(m.sameWifi);
    case "pending":
      return t(m.waitingApproval);
    case "offline":
      return t(m.offline);
    case "removed":
      return t(m.removed);
    case "keyChanged":
      return t(m.needsPairing);
    default:
      return t(m.connecting);
  }
}

/**
 * Another Me's card, as on the desktop: white with a hairline while another
 * chat is open, filled with its avatar's color and the face set flush to the
 * edge while its chat is the one on screen.
 */
function AnotherMeCard(props: {
  readonly room: RoomListItem;
  readonly active: boolean;
  readonly me?: string;
  readonly onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const agent = props.room.direct_peer;
  const brand = useAgentBrand(agent?.id) ?? colors.ink;
  const unread = props.room.unread_message_count ?? 0;
  const ink = props.active && isLight(brand) ? colors.ink : colors.onAction;
  const sub = props.active ? ink : colors.muted;
  if (!agent) return null;
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={t(m.anotherMeLabel, { name: agent.display_name })}
      accessibilityState={{ selected: props.active }}
      onPress={() => {
        tick();
        props.onNavigate();
        router.navigate("/");
      }}
      style={[
        styles.card,
        props.active ? { backgroundColor: brand } : styles.cardIdle,
      ]}
    >
      <AgentAvatar
        actorId={agent.id}
        size={props.active ? 64 : 44}
        radius={props.active ? 0 : undefined}
      />
      <View style={styles.cardText}>
        <Text
          style={[styles.cardTitle, { color: props.active ? ink : colors.ink }]}
          numberOfLines={1}
        >
          {agent.display_name}
        </Text>
        <Text style={[styles.cardSub, { color: sub }]} numberOfLines={1}>
          {previewOf(props.room, props.me)}
        </Text>
      </View>
      {unread ? (
        <Text style={[styles.count, { color: sub }]}>{unread}</Text>
      ) : null}
    </PressScale>
  );
}

/** Whether ink reads better than white on a color (WCAG luminance). */
function isLight(hex: string): boolean {
  const luminance = [0.2126, 0.7152, 0.0722].reduce((sum, weight, index) => {
    const channel = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255;
    return (
      sum +
      weight *
        (channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
  return luminance > 0.179;
}

/**
 * A tool in the sidebar, drawn like a chat row so it sits in the list
 * instead of on it: a quiet tile where the face goes, a name and one line.
 */
function ToolRow(props: {
  readonly label: string;
  readonly detail: string;
  readonly icon: IconName;
  readonly href: string;
  readonly active: boolean;
  readonly onNavigate: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.active }}
      onPress={() => {
        tick();
        props.onNavigate();
        router.navigate(props.href);
      }}
      style={({ pressed }) => [
        styles.chat,
        (props.active || pressed) && styles.chatActive,
      ]}
    >
      <View style={styles.toolTile}>
        <Icon name={props.icon} size={20} color={colors.secondary} />
      </View>
      <View style={styles.chatText}>
        <View style={styles.chatTop}>
          <Text style={styles.chatTitle} numberOfLines={1}>
            {props.label}
          </Text>
        </View>
        <View style={styles.chatTop}>
          <Text style={styles.chatPreview} numberOfLines={1}>
            {props.detail}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** One chat, as a Messages row: face, name, last words, time, unread. */
function ChatRow(props: {
  readonly room: RoomListItem;
  readonly title: string;
  readonly href: string;
  readonly active: boolean;
  readonly me?: string;
  readonly onNavigate: () => void;
}) {
  const { t } = useTranslation();
  const { room } = props;
  const unread = room.unread_message_count ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? t(m.chatUnread, { title: props.title, count: unread })
          : props.title
      }
      accessibilityState={{ selected: props.active }}
      onPress={() => {
        tick();
        props.onNavigate();
        router.navigate(props.href);
      }}
      style={({ pressed }) => [
        styles.chat,
        (props.active || pressed) && styles.chatActive,
      ]}
    >
      {room.direct_peer ? (
        <ActorAvatar actor={room.direct_peer} size={36} />
      ) : (
        <RoomAvatar members={room.member_preview ?? []} size={36} />
      )}
      <View style={styles.chatText}>
        <View style={styles.chatTop}>
          <Text
            style={[styles.chatTitle, unread > 0 && styles.unread]}
            numberOfLines={1}
          >
            {props.title}
          </Text>
          <Text style={styles.chatTime}>
            {when(room.latest_message?.created_at)}
          </Text>
        </View>
        <View style={styles.chatTop}>
          <Text style={styles.chatPreview} numberOfLines={1}>
            {previewOf(room, props.me)}
          </Text>
          {unread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {unread > 99 ? "99+" : unread}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function DrawerMenu(props: DrawerContentComponentProps) {
  const { t } = useTranslation();
  const { active, status, route } = useComputer();
  const pathname = usePathname();
  const rooms = useRooms();
  const anotherMe = useAnotherMe();
  const me = useIdentity().data?.actorId;
  const close = () => props.navigation.closeDrawer();
  const anotherMeRoomId = anotherMe.data?.room_id;
  const lead = rooms.data?.find((room) => room.id === anotherMeRoomId);
  const chats = (rooms.data ?? []).filter(
    (room) => room.id !== anotherMeRoomId,
  );
  const dot =
    status?.kind === "connected"
      ? colors.success
      : status?.kind === "offline"
        ? colors.warning
        : colors.borderStrong;

  return (
    <SafeAreaView style={styles.menu} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.head}>
          <Text style={styles.title} accessibilityRole="header">
            {t(m.messages)}
          </Text>
        </View>
        {lead ? (
          <AnotherMeCard
            room={lead}
            me={me}
            active={pathname === "/"}
            onNavigate={close}
          />
        ) : null}
        <View style={styles.chats}>
          <ToolRow
            label={t(m.library)}
            detail={t(m.libraryDetail)}
            icon="library"
            href="/library"
            active={pathname.startsWith("/library")}
            onNavigate={close}
          />
          <View style={styles.divider} />
          {chats.map((room) => (
            <ChatRow
              key={room.id}
              room={room}
              me={me}
              title={room.direct_peer?.display_name || room.name || t(m.chat)}
              href={`/rooms/${room.id}`}
              active={pathname === `/rooms/${room.id}`}
              onNavigate={close}
            />
          ))}
          {rooms.isPending ? (
            <ActivityIndicator
              style={styles.loadingRooms}
              color={colors.muted}
            />
          ) : null}
        </View>
      </ScrollView>
      {/* The computer and Settings sit at the foot, as a profile row does. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t(m.settings)}
        onPress={() => {
          tick();
          close();
          router.navigate("/settings");
        }}
        style={({ pressed }) => [
          styles.foot,
          (pressed || pathname.startsWith("/settings")) && styles.footActive,
        ]}
      >
        <Icon name="laptop" size={20} color={colors.secondary} />
        <View style={styles.footText}>
          <Text style={styles.footName} numberOfLines={1}>
            {active?.name ?? t(m.yourComputer)}
          </Text>
          <View style={styles.statusLine}>
            <View style={[styles.dot, { backgroundColor: dot }]} />
            <Text style={type.caption} numberOfLines={1}>
              {statusLabel(t, status, route)}
            </Text>
          </View>
        </View>
        <Icon name="settings" size={20} color={colors.secondary} />
      </Pressable>
    </SafeAreaView>
  );
}

function KeyChanged() {
  const { t } = useTranslation();
  const { active, computers, unpair, switchTo } = useComputer();
  const others = computers.filter(
    (computer) => computer.hostId !== active?.hostId,
  );
  return (
    <SafeAreaView style={styles.blocked}>
      <EmptyState
        title={t(m.keyChangedTitle, {
          name: active?.name ?? t(m.yourComputer),
        })}
        body={t(m.keyChangedBody)}
      />
      <View style={styles.blockedActions}>
        <Button
          label={t(m.pairAgain)}
          onPress={() => {
            if (active)
              void unpair(active.hostId).then(() => router.replace("/pair"));
          }}
        />
        {others[0] ? (
          <Button
            label={t(m.switchTo, { name: others[0].name })}
            variant="secondary"
            onPress={() => void switchTo(others[0]?.hostId ?? "")}
          />
        ) : null}
      </View>
    </SafeAreaView>
  );
}

export default function MainLayout() {
  const { t } = useTranslation();
  const { loaded, active, status } = useComputer();
  if (!loaded)
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={colors.muted} />
      </View>
    );
  if (!active) return <Redirect href="/pair" />;
  if (status?.kind === "keyChanged") return <KeyChanged />;
  return (
    <Drawer
      drawerContent={(props) => <DrawerMenu {...props} />}
      screenOptions={{
        headerTintColor: colors.ink,
        headerTitleStyle: { fontFamily: "Geist-SemiBold", color: colors.ink },
        headerStyle: { backgroundColor: colors.canvas },
        headerShadowVisible: false,
        drawerStyle: { backgroundColor: colors.sidebar },
        sceneStyle: { backgroundColor: colors.canvas },
      }}
    >
      {/* Chat screens draw their own header so the keyboard can lift the
          whole screen from the top edge. */}
      <Drawer.Screen
        name="index"
        options={{ title: "Linger", headerShown: false }}
      />
      <Drawer.Screen
        name="rooms/index"
        options={{ title: t(m.messages), headerShown: false }}
      />
      <Drawer.Screen
        name="rooms/[roomId]"
        options={{ title: t(m.room), headerShown: false }}
      />
      <Drawer.Screen
        name="library"
        options={{ headerShown: false, title: t(m.library) }}
      />
      <Drawer.Screen
        name="settings"
        options={{ headerShown: false, title: t(m.settings) }}
      />
    </Drawer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.canvas,
  },
  menu: { flex: 1 },
  scroll: { paddingHorizontal: space.md, paddingBottom: space.lg },
  head: {
    paddingHorizontal: space.xs,
    paddingTop: space.md,
    paddingBottom: space.md,
  },
  title: {
    fontSize: 30,
    lineHeight: 36,
    fontWeight: "700",
    letterSpacing: -0.6,
    color: colors.ink,
  },
  card: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.lg,
    overflow: "hidden",
    paddingRight: space.md,
  },
  cardIdle: {
    paddingLeft: space.sm + 2,
    paddingVertical: space.sm + 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  cardText: { flex: 1, minWidth: 0, gap: 2 },
  cardTitle: { fontSize: 17, lineHeight: 22, fontWeight: "600" },
  cardSub: { fontSize: 13, lineHeight: 18 },
  toolTile: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sidebarMuted,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: space.sm + 36 + space.md,
    marginVertical: space.xs,
    backgroundColor: colors.borderStrong,
  },
  chats: { paddingTop: space.md, gap: 2 },
  chat: {
    minHeight: 60,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.sm,
    borderRadius: 10,
  },
  chatActive: { backgroundColor: colors.sidebarMuted },
  chatText: { flex: 1, minWidth: 0, gap: 2 },
  chatTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  chatTitle: { flex: 1, fontSize: 16, lineHeight: 21, color: colors.ink },
  unread: { fontWeight: "600" },
  chatTime: {
    ...StyleSheet.flatten(type.caption),
    fontVariant: ["tabular-nums"],
  },
  chatPreview: { flex: 1, fontSize: 14, lineHeight: 19, color: colors.muted },
  badge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: colors.onAction, fontSize: 12, fontWeight: "600" },
  count: { ...StyleSheet.flatten(type.small), fontVariant: ["tabular-nums"] },
  loadingRooms: { paddingVertical: space.lg },
  foot: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    marginHorizontal: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: 10,
  },
  footActive: { backgroundColor: colors.sidebarMuted },
  footText: { flex: 1, minWidth: 0, gap: 2 },
  footName: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "500",
    color: colors.ink,
  },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  blocked: { flex: 1, backgroundColor: colors.canvas },
  blockedActions: { padding: space.xl, gap: space.md },
});
