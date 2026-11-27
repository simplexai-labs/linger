// A group chat's face, as the desktop draws it (apps/web room-avatar.tsx):
// the first member in a larger top-left tile and the next ones around it,
// up to four faces; from five members on, the bottom-right tile counts the
// members not shown. Laid out on a 40-unit square scaled to `size`.
import { StyleSheet, View } from "react-native";

import type { ActorRef } from "../api/types";
import { colors } from "../theme";
import { ActorAvatar } from "./avatar";
import { Icon } from "./icon";
import { Text } from "./text";

type Position = "solo" | "lead" | "lead-center" | "tr" | "bl" | "br";

const LAYOUTS: Record<number, readonly Position[]> = {
  1: ["solo"],
  2: ["lead", "br"],
  3: ["lead-center", "bl", "br"],
  4: ["lead", "tr", "bl", "br"],
};

/** Each tile's place and size in units of the 40-unit square. */
const BOXES: Record<Position, { top: number; left: number; side: number }> = {
  solo: { top: 0, left: 0, side: 40 },
  lead: { top: 0, left: 0, side: 26 },
  "lead-center": { top: 0, left: 7, side: 26 },
  tr: { top: 0, left: 22, side: 18 },
  bl: { top: 22, left: 0, side: 18 },
  br: { top: 22, left: 22, side: 18 },
};

function corner(position: Position, unit: number): number {
  if (position === "solo") return 10 * unit;
  return (position.startsWith("lead") ? 8 : 6) * unit;
}

export function RoomAvatar(props: {
  readonly members: readonly Pick<ActorRef, "id" | "kind" | "display_name">[];
  readonly size?: number;
  /** The color behind the stack, which rings each tile. */
  readonly ring?: string;
}) {
  const size = props.size ?? 40;
  const unit = size / 40;
  const ring = props.ring ?? colors.sidebar;
  if (props.members.length === 0)
    return (
      <View
        style={[
          styles.empty,
          { width: size, height: size, borderRadius: 10 * unit },
        ]}
      >
        <Icon name="messages" size={16} color={colors.muted} />
      </View>
    );
  const overflow = props.members.length > 4 ? props.members.length - 3 : 0;
  const faces = props.members.slice(0, overflow ? 3 : 4);
  const positions = LAYOUTS[overflow ? 4 : faces.length]!;
  const tile = (position: Position) => {
    const box = BOXES[position];
    return {
      position: "absolute" as const,
      top: box.top * unit,
      left: box.left * unit,
      width: box.side * unit,
      height: box.side * unit,
      borderRadius: corner(position, unit),
      borderWidth: position === "solo" ? 0 : 1.5 * unit,
      borderColor: ring,
      backgroundColor: ring,
      overflow: "hidden" as const,
    };
  };
  return (
    <View
      style={{ width: size, height: size }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {faces.map((member, index) => {
        const position = positions[index]!;
        const side = BOXES[position].side * unit;
        return (
          <View key={member.id} style={tile(position)}>
            <ActorAvatar actor={member} size={side} radius={0} />
          </View>
        );
      })}
      {overflow ? (
        <View style={[tile("br"), styles.more]}>
          <Text style={[styles.moreText, { fontSize: 9 * unit }]}>
            +{overflow}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sidebarMuted,
  },
  more: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.sidebarMuted,
  },
  moreText: { fontWeight: "600", color: colors.secondary },
});
