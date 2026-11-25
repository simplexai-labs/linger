// The menu the composer's + opens: Camera, Photos and Files. It grows out of
// the + from the bottom left, as Codex's does. On iOS it draws in a window
// overlay rather than a modal, so it opens even while the text field's edit
// menu (AutoFill, Paste) is up and the keyboard stays where it is.
import { useEffect } from "react";
import {
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { FullWindowOverlay } from "react-native-screens";

import { colors, radius, shadow, space, type } from "../theme";
import { tick } from "../ui/haptics";
import { Icon, type IconName } from "../ui/icon";
import { useReducedMotion } from "../ui/motion";
import { Text } from "../ui/text";

export type AttachSource = "camera" | "photos" | "files";

const SOURCES: readonly {
  source: AttachSource;
  label: string;
  icon: IconName;
}[] = [
  { source: "camera", label: "Camera", icon: "camera" },
  { source: "photos", label: "Photos", icon: "photo" },
  { source: "files", label: "Files", icon: "attachment" },
];

function Layer(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  if (Platform.OS === "ios")
    return props.visible ? (
      <FullWindowOverlay>{props.children}</FullWindowOverlay>
    ) : null;
  return (
    <Modal visible={props.visible} transparent onRequestClose={props.onClose}>
      {props.children}
    </Modal>
  );
}

/** `anchor` is the + button's top left in the window; undefined is closed. */
export function AttachMenu(props: {
  readonly anchor: { x: number; y: number } | undefined;
  readonly onChoose: (source: AttachSource) => void;
  readonly onClose: () => void;
}) {
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const open = useSharedValue(0);
  const visible = !!props.anchor;
  useEffect(() => {
    if (!visible) return;
    open.value = 0;
    open.value = reduced
      ? withTiming(1, { duration: 120 })
      : withSpring(1, { damping: 18, stiffness: 320, mass: 0.7 });
  }, [open, reduced, visible]);
  const grow = useAnimatedStyle(() => ({
    opacity: Math.min(1, open.value * 1.6),
    transform: [{ scale: reduced ? 1 : 0.4 + 0.6 * open.value }],
  }));

  return (
    <Layer visible={visible} onClose={props.onClose}>
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityLabel="Close"
        onPress={props.onClose}
      />
      {props.anchor ? (
        <Reanimated.View
          accessibilityRole="menu"
          style={[
            styles.menu,
            {
              left: props.anchor.x,
              bottom: window.height - props.anchor.y + space.sm,
            },
            grow,
          ]}
        >
          {SOURCES.map((item) => (
            <Pressable
              key={item.source}
              accessibilityRole="menuitem"
              onPress={() => {
                tick();
                props.onChoose(item.source);
              }}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={styles.icon}>
                <Icon name={item.icon} size={20} color={colors.ink} />
              </View>
              <Text style={styles.label}>{item.label}</Text>
            </Pressable>
          ))}
        </Reanimated.View>
      ) : null}
    </Layer>
  );
}

const styles = StyleSheet.create({
  menu: {
    position: "absolute",
    minWidth: 200,
    paddingVertical: space.xs,
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    // Grows from the corner over the +, the way the menu came from it.
    transformOrigin: "left bottom",
    ...StyleSheet.flatten(shadow.md),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 48,
    paddingHorizontal: space.md,
  },
  pressed: { backgroundColor: colors.sidebarMuted },
  icon: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sidebarMuted,
  },
  label: { ...StyleSheet.flatten(type.chat), color: colors.ink },
});
