// The settings page as iOS lays one out (inset grouped): white r12 groups
// on the warm gray, a small label above a group, rows with a highlight while
// pressed and hairlines that start after the icon, and at most one short
// note under a group. Rows are 46pt; nothing scales on press, as in Settings.
import { tick } from "./haptics";
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Switch, View } from "react-native";

import { colors, radius, space, type } from "../theme";
import { Icon, type IconName } from "./icon";
import { Text } from "./text";

export function SettingsGroup(props: {
  readonly label?: string;
  /** Quiet text after the label, such as a count. */
  readonly meta?: string;
  /** A short note under the group; a string renders as the muted 12px note. */
  readonly footer?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <View style={styles.group}>
      {props.label ? (
        <View style={styles.labelRow}>
          <Text style={styles.label} accessibilityRole="header">
            {props.label}
          </Text>
          {props.meta ? <Text style={styles.meta}>{props.meta}</Text> : null}
        </View>
      ) : null}
      <View style={styles.box}>
        {/* Pulls the first row's hairline under the group's top edge. */}
        <View style={styles.pullUp}>{props.children}</View>
      </View>
      {typeof props.footer === "string" ? (
        <SettingsNote>{props.footer}</SettingsNote>
      ) : (
        props.footer
      )}
    </View>
  );
}

/** The one-line note under a group; warning for a change that failed. */
export function SettingsNote(props: {
  readonly children: string;
  readonly tone?: "muted" | "warning";
}) {
  return (
    <Text
      style={[styles.note, props.tone === "warning" && styles.noteWarning]}
      accessibilityLiveRegion={props.tone === "warning" ? "polite" : undefined}
    >
      {props.children}
    </Text>
  );
}

export interface SettingsRowProps {
  /** null keeps the icon column empty so the text lines up with other rows. */
  readonly icon?: IconName | null;
  readonly title: string;
  /** A second line under the title, or a node such as a status line. */
  readonly subtitle?: ReactNode;
  /** Quiet text at the right, such as a version. */
  readonly detail?: string;
  readonly trailing?: ReactNode;
  /** Shows the › that says the row opens something. */
  readonly chevron?: boolean;
  /**
   * danger draws the title in red for a destructive row; accent in the link
   * blue for a row that adds something.
   */
  readonly tone?: "danger" | "accent";
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly accessibilityState?: { readonly selected?: boolean };
}

export function SettingsRow(props: SettingsRowProps) {
  const content = (
    <>
      {props.icon !== undefined ? (
        <View style={styles.icon}>
          {props.icon ? (
            <Icon name={props.icon} size={20} color={colors.muted} />
          ) : null}
        </View>
      ) : null}
      <View style={styles.content}>
        <View style={styles.text}>
          <Text
            style={[
              styles.title,
              props.tone === "danger" && styles.danger,
              props.tone === "accent" && styles.accent,
            ]}
            numberOfLines={1}
          >
            {props.title}
          </Text>
          {typeof props.subtitle === "string" ? (
            <Text style={styles.subtitle}>{props.subtitle}</Text>
          ) : (
            props.subtitle
          )}
        </View>
        {props.detail ? (
          <Text style={styles.detail}>{props.detail}</Text>
        ) : null}
        {props.trailing}
        {props.chevron ? (
          <Icon name="chevron" size={16} color={colors.muted} />
        ) : null}
      </View>
    </>
  );
  if (!props.onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={props.accessibilityState}
      onPress={() => {
        tick();
        props.onPress?.();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {content}
    </Pressable>
  );
}

/** A colored 6px dot before a short status, as in the StatusPill. */
export function StatusLine(props: {
  readonly tone: "success" | "warning" | "muted";
  readonly text: string;
}) {
  return (
    <View style={styles.statusLine}>
      <View style={[styles.dot, { backgroundColor: dotColors[props.tone] }]} />
      <Text style={styles.subtitle} numberOfLines={1}>
        {props.text}
      </Text>
    </View>
  );
}

const dotColors = {
  success: colors.success,
  warning: colors.warning,
  muted: colors.borderStrong,
} as const;

export function SettingsSwitch(props: {
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
}) {
  return (
    <Switch
      value={props.value}
      onValueChange={props.onValueChange}
      disabled={props.disabled}
      trackColor={{ true: colors.ink, false: colors.borderStrong }}
      ios_backgroundColor={colors.borderStrong}
      thumbColor={colors.surface}
      accessibilityLabel={props.accessibilityLabel}
    />
  );
}

const styles = StyleSheet.create({
  group: { paddingHorizontal: space.md, paddingTop: space.xl },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 28,
    paddingHorizontal: 6,
    paddingBottom: space.xs,
  },
  label: type.sectionLabel,
  meta: {
    fontSize: 12,
    color: colors.muted,
    opacity: 0.8,
    fontVariant: ["tabular-nums"],
  },
  box: {
    borderRadius: radius.xl,
    backgroundColor: colors.surface,
    overflow: "hidden",
  },
  pullUp: { marginTop: -StyleSheet.hairlineWidth },
  note: {
    fontSize: 12,
    lineHeight: 18,
    color: colors.muted,
    paddingHorizontal: 6,
    paddingTop: 6,
  },
  noteWarning: { color: colors.warning },
  row: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: space.md,
    paddingLeft: space.lg,
  },
  rowPressed: { backgroundColor: colors.sidebarMuted },
  icon: { width: 22, alignItems: "center", justifyContent: "center" },
  content: {
    flex: 1,
    minWidth: 0,
    minHeight: 46,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.sm + 2,
    paddingRight: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderStrong,
  },
  text: { flex: 1, minWidth: 0, gap: 2 },
  title: { fontSize: 16, lineHeight: 21, color: colors.ink },
  danger: { color: colors.danger },
  accent: { color: colors.accent },
  subtitle: { fontSize: 13, lineHeight: 18, color: colors.muted },
  detail: { fontSize: 15, color: colors.muted, fontVariant: ["tabular-nums"] },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: radius.pill },
});
