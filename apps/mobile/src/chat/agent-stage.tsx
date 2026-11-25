// The top of a chat. A direct chat puts the Agent on stage: its avatar
// breathes while it works, the line under it says what it is doing with a
// Stop beside it, and tapping the face opens the Agent's profile. A group chat shows its name and members.
// The stage folds down while the keyboard is up.
import { router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Easing,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import Reanimated, { FadeIn, FadeOut } from "react-native-reanimated";

import type { ActorRef } from "../api/types";
import { useRoomMembers } from "../state/queries";
import { colors, radius, space, type } from "../theme";
import { AgentAvatar } from "../ui/avatar";
import { Icon } from "../ui/icon";
import { isWorking } from "./run-status";
import { useRunViews, useStopRun } from "./run-status-bar";
import { useReducedMotion } from "../ui/motion";
import { RoomAvatar } from "../ui/room-avatar";
import { SidebarButton } from "../ui/sidebar-button";
import { Text } from "../ui/text";

function useKeyboardUp(): boolean {
  const [up, setUp] = useState(false);
  useEffect(() => {
    const show = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hide = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    const ease = () =>
      LayoutAnimation.configureNext(
        LayoutAnimation.create(260, "easeInEaseOut", "scaleXY"),
      );
    const a = Keyboard.addListener(show, () => {
      ease();
      setUp(true);
    });
    const b = Keyboard.addListener(hide, () => {
      ease();
      setUp(false);
    });
    return () => {
      a.remove();
      b.remove();
    };
  }, []);
  return up;
}

/** A slow breath while `active`, settling back to rest when it ends. */
function useBreath(active: boolean) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!active || reduced) {
      Animated.timing(value, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start();
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 1,
          duration: 1_300,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 1_300,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reduced, value]);
  return value;
}

/** Opens an Agent's read-only profile sheet. */
export function openAgent(agentId: string, roomId?: string): void {
  router.push({
    pathname: "/agent/[agentId]",
    params: roomId ? { agentId, roomId } : { agentId },
  });
}

/** The bar above a stage; only Another Me's chat offers Record. */
function TopBar(props: { readonly record?: boolean }) {
  return (
    <View style={styles.bar}>
      <SidebarButton />
      <View style={styles.barSpacer} />
      {props.record ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Record a meeting"
          hitSlop={8}
          onPress={() => router.push("/voice/record")}
          style={({ pressed }) => [styles.barButton, pressed && styles.pressed]}
        >
          <Icon name="record" size={20} color={colors.secondary} />
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The Agent's current work and its Stop, the one place a direct chat shows
 * them. It fades in and out inside a slot of fixed height, so the stage and
 * the conversation under it never jump when a Run starts or ends.
 */
function WorkLine(props: {
  readonly roomId: string;
  readonly runId: string;
  readonly line: string;
  readonly agentName: string;
}) {
  const { stopping, stop } = useStopRun(props.roomId);
  const isStopping = stopping.has(props.runId);
  return (
    <Reanimated.View
      entering={FadeIn.duration(160)}
      exiting={FadeOut.duration(160)}
      style={styles.work}
    >
      <ActivityIndicator
        size="small"
        color={colors.muted}
        style={styles.spinner}
      />
      <Text
        style={[type.small, styles.workText]}
        numberOfLines={1}
        accessibilityLiveRegion="polite"
      >
        {isStopping ? "Stopping…" : props.line}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Stop ${props.agentName}`}
        disabled={isStopping}
        hitSlop={10}
        onPress={() => stop(props.runId)}
        style={({ pressed }) => [
          styles.stop,
          pressed && styles.stopPressed,
          isStopping && styles.stopDisabled,
        ]}
      >
        <View style={styles.stopSquare} />
      </Pressable>
    </Reanimated.View>
  );
}

/**
 * The stage while the keyboard is up: a bar like a navigation bar, the face
 * and name centered over one line of work, and Stop where Record sits so the
 * name never shifts. Tapping the name opens the Agent's sheet.
 */
function FoldedStage(props: {
  readonly roomId: string;
  readonly agent: Pick<ActorRef, "id" | "display_name">;
  readonly record?: boolean;
  readonly working?: { readonly runId: string; readonly line: string };
}) {
  const { stopping, stop } = useStopRun(props.roomId);
  const working = props.working;
  const isStopping = !!working && stopping.has(working.runId);
  return (
    <View style={styles.folded}>
      <View style={styles.foldedSide}>
        <SidebarButton />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`About ${props.agent.display_name}`}
        onPress={() => openAgent(props.agent.id, props.roomId)}
        style={({ pressed }) => [
          styles.foldedCenter,
          pressed && styles.facePressed,
        ]}
      >
        <View style={styles.foldedName}>
          <AgentAvatar actorId={props.agent.id} size={20} />
          <Text style={styles.foldedTitle} numberOfLines={1}>
            {props.agent.display_name}
          </Text>
        </View>
        {working ? (
          <Reanimated.View
            entering={FadeIn.duration(160)}
            exiting={FadeOut.duration(160)}
            style={styles.foldedLineBox}
          >
            <Text
              style={[type.small, styles.foldedLine]}
              numberOfLines={1}
              accessibilityLiveRegion="polite"
            >
              {isStopping ? "Stopping…" : working.line}
            </Text>
          </Reanimated.View>
        ) : null}
      </Pressable>
      <View style={[styles.foldedSide, styles.foldedTrailing]}>
        {working ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${props.agent.display_name}`}
            disabled={isStopping}
            hitSlop={10}
            onPress={() => stop(working.runId)}
            style={({ pressed }) => [
              styles.stop,
              pressed && styles.stopPressed,
              isStopping && styles.stopDisabled,
            ]}
          >
            <View style={styles.stopSquare} />
          </Pressable>
        ) : props.record ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Record a meeting"
            hitSlop={8}
            onPress={() => router.push("/voice/record")}
            style={({ pressed }) => [
              styles.barButton,
              pressed && styles.pressed,
            ]}
          >
            <Icon name="record" size={20} color={colors.secondary} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export function AgentStage(props: {
  readonly roomId: string;
  readonly agent: Pick<ActorRef, "id" | "display_name">;
  readonly idleLine?: string;
  /** Another Me's chat: the bar offers Record. */
  readonly record?: boolean;
}) {
  const views = useRunViews(props.roomId);
  const working = Object.values(views).find(
    (view) => view.run.agent.id === props.agent.id && isWorking(view.run),
  );
  const keyboard = useKeyboardUp();
  const breath = useBreath(!!working);
  const scale = breath.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06],
  });
  const lift = breath.interpolate({ inputRange: [0, 1], outputRange: [0, -2] });
  const line = working ? working.line || "Working…" : (props.idleLine ?? "");

  if (keyboard)
    return (
      <FoldedStage
        roomId={props.roomId}
        agent={props.agent}
        record={props.record}
        working={working ? { runId: working.run.run_id, line } : undefined}
      />
    );

  return (
    <View>
      <TopBar record={props.record} />
      <View style={styles.stage}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`About ${props.agent.display_name}`}
          onPress={() => openAgent(props.agent.id, props.roomId)}
          style={({ pressed }) => pressed && styles.facePressed}
        >
          <Animated.View
            style={[
              styles.face,
              { transform: [{ translateY: lift }, { scale }] },
            ]}
          >
            <AgentAvatar actorId={props.agent.id} size={72} />
          </Animated.View>
        </Pressable>
        <Text style={styles.name} numberOfLines={1}>
          {props.agent.display_name}
        </Text>
        {/* A fixed slot: work fades in and out without moving anything. */}
        <View style={styles.slot}>
          {working ? (
            <WorkLine
              key={working.run.run_id}
              roomId={props.roomId}
              runId={working.run.run_id}
              line={line}
              agentName={props.agent.display_name}
            />
          ) : line ? (
            <Text style={[type.small, styles.idle]} numberOfLines={1}>
              {line}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function GroupStage(props: {
  readonly roomId: string;
  readonly title: string;
}) {
  const members = useRoomMembers(props.roomId).data ?? [];
  return (
    <View>
      <TopBar />
      <View style={styles.group}>
        <RoomAvatar
          members={members.map((member) => member.actor)}
          size={64}
          ring={colors.canvas}
        />
        <Text style={styles.name} numberOfLines={1}>
          {props.title}
        </Text>
        {members.length > 0 ? (
          <Text style={type.small}>
            {members.length === 1 ? "1 member" : `${members.length} members`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingRight: space.md,
  },
  barButton: {
    width: 40,
    height: 40,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: colors.sidebarMuted },
  stage: { alignItems: "center", paddingBottom: space.lg, gap: 2 },
  // Resting content casts no shadow; the breath alone says it is working.
  face: { borderRadius: 14 },
  facePressed: { opacity: 0.85, transform: [{ scale: 0.96 }] },
  name: { ...type.headline, marginTop: space.sm, maxWidth: "80%" },
  folded: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
  },
  // Both sides are as wide, so the name stays centered on the screen.
  foldedSide: { width: 64, flexDirection: "row", alignItems: "center" },
  foldedTrailing: { justifyContent: "flex-end", paddingRight: space.md },
  foldedCenter: { flex: 1, alignItems: "center", gap: 1 },
  foldedName: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    maxWidth: "100%",
  },
  foldedTitle: { ...type.headline, flexShrink: 1 },
  foldedLineBox: { maxWidth: "100%" },
  foldedLine: { color: colors.secondary },
  barSpacer: { flex: 1 },
  idle: { maxWidth: "80%", textAlign: "center" },
  slot: { height: 28, justifyContent: "center", maxWidth: "86%" },
  work: { flexDirection: "row", alignItems: "center", gap: space.sm },
  spinner: { transform: [{ scale: 0.75 }] },
  workText: { flexShrink: 1, color: colors.secondary },
  // A quiet round Stop, as a media control: a filled circle, an ink square.
  stop: {
    width: 24,
    height: 24,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sidebarMuted,
  },
  stopPressed: { transform: [{ scale: 0.92 }] },
  stopDisabled: { opacity: 0.5 },
  stopSquare: {
    width: 8,
    height: 8,
    borderRadius: 1.5,
    backgroundColor: colors.ink,
  },
  group: { alignItems: "center", paddingBottom: space.lg, gap: 2 },
});
