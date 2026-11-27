// The design system's UnderlineTabs: a page-level view switch in 14px
// medium, the unselected tabs in the muted text color, the selected one in
// ink with a 2px ink underline under its label that slides into place
// (300ms, cubic-bezier(0.16, 1, 0.3, 1)). Phone tabs keep the 44 touch height.
import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  View,
  type LayoutRectangle,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { colors, space, touchTarget } from "../theme";
import { Text } from "../ui/text";

/** The label's inset inside its tab; the underline spans the label only. */
const INSET = space.md;
const SLIDE = { duration: 300, easing: Easing.bezier(0.16, 1, 0.3, 1) };

export function UnderlineTabs<T extends string>(props: {
  readonly tabs: readonly { readonly id: T; readonly label: string }[];
  readonly selected: T;
  readonly onSelect: (id: T) => void;
  readonly style?: StyleProp<ViewStyle>;
}) {
  const [layouts, setLayouts] = useState<Partial<Record<T, LayoutRectangle>>>(
    {},
  );
  const left = useSharedValue(0);
  const width = useSharedValue(0);
  const placed = useRef(false);
  const layout = layouts[props.selected];

  useEffect(() => {
    if (!layout) return;
    const x = layout.x + INSET;
    const w = Math.max(0, layout.width - INSET * 2);
    if (placed.current) {
      left.value = withTiming(x, SLIDE);
      width.value = withTiming(w, SLIDE);
    } else {
      left.value = x;
      width.value = w;
      placed.current = true;
    }
  }, [layout, left, width]);

  const underline = useAnimatedStyle(() => ({
    transform: [{ translateX: left.value }],
    width: width.value,
  }));

  return (
    <View style={[styles.bar, props.style]} accessibilityRole="tablist">
      {props.tabs.map((tab) => {
        const selected = tab.id === props.selected;
        return (
          <Pressable
            key={tab.id}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            accessibilityLabel={tab.label}
            onPress={() => props.onSelect(tab.id)}
            onLayout={(event) => {
              const next = event.nativeEvent.layout;
              setLayouts((current) => ({ ...current, [tab.id]: next }));
            }}
            style={styles.tab}
          >
            <Text style={[styles.label, selected && styles.selected]}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
      <Animated.View
        pointerEvents="none"
        style={[styles.underline, underline, !layout && styles.hidden]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tab: {
    minHeight: touchTarget,
    paddingHorizontal: INSET,
    justifyContent: "center",
  },
  label: { fontSize: 14, fontWeight: "500", color: colors.muted },
  selected: { color: colors.ink },
  underline: {
    position: "absolute",
    left: 0,
    bottom: 0,
    height: 2,
    backgroundColor: colors.ink,
  },
  hidden: { opacity: 0 },
});
