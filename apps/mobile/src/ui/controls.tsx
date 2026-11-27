// Shared controls: one button, list rows, notices and empty states, all with
// large touch targets and accessibility labels.
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { colors, radius, space, touchTarget, type } from "../theme";
import { PressScale } from "./press-scale";
import { Text } from "./text";

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: "primary" | "accent" | "secondary" | "quiet" | "danger";
  readonly disabled?: boolean;
  readonly busy?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityHint?: string;
  readonly style?: StyleProp<ViewStyle>;
  readonly compact?: boolean;
}

export function Button(props: ButtonProps) {
  const variant = props.variant ?? "primary";
  const disabled = props.disabled || props.busy;
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!props.busy }}
      disabled={disabled}
      onPress={props.onPress}
      hitSlop={props.compact ? 6 : 0}
      containerStyle={props.style}
      style={[
        styles.button,
        props.compact && styles.compact,
        buttonColors[variant],
        disabled && styles.disabled,
      ]}
    >
      {props.busy ? (
        <ActivityIndicator color={labelColors[variant]} />
      ) : (
        <Text style={[styles.buttonLabel, { color: labelColors[variant] }]}>
          {props.label}
        </Text>
      )}
    </PressScale>
  );
}

const buttonColors = StyleSheet.create({
  primary: { backgroundColor: colors.action },
  accent: { backgroundColor: colors.accent },
  secondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  quiet: { backgroundColor: "transparent" },
  danger: { backgroundColor: colors.danger },
});

const labelColors = {
  primary: colors.onAction,
  accent: colors.onAccent,
  secondary: colors.ink,
  quiet: colors.secondary,
  danger: colors.onAction,
} as const;

export interface RowProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly detail?: string;
  readonly onPress?: () => void;
  readonly accessibilityLabel?: string;
  readonly selected?: boolean;
  readonly trailing?: ReactNode;
}

export function Row(props: RowProps) {
  const content = (
    <>
      <View style={styles.rowText}>
        <Text style={type.label} numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text style={type.small} numberOfLines={2}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.detail ? <Text style={type.caption}>{props.detail}</Text> : null}
      {props.trailing}
    </>
  );
  if (!props.onPress) return <View style={styles.row}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.title}
      accessibilityState={{ selected: !!props.selected }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.row,
        props.selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
    >
      {content}
    </Pressable>
  );
}

export function Notice(props: {
  readonly tone: "neutral" | "warning" | "danger" | "info";
  readonly text: string;
  readonly action?: { label: string; onPress: () => void };
}) {
  return (
    <View
      style={[styles.notice, noticeTones[props.tone]]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Text style={[type.small, { color: noticeText[props.tone], flex: 1 }]}>
        {props.text}
      </Text>
      {props.action ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={props.action.label}
          onPress={props.action.onPress}
          hitSlop={10}
        >
          <Text style={[type.small, styles.noticeAction]}>
            {props.action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const noticeTones = StyleSheet.create({
  neutral: { backgroundColor: colors.surfaceSoft },
  warning: { backgroundColor: colors.warningSoft },
  danger: { backgroundColor: colors.dangerSoft },
  info: { backgroundColor: colors.infoSoft },
});

const noticeText = {
  neutral: colors.secondary,
  warning: colors.warning,
  danger: colors.danger,
  info: colors.info,
} as const;

export function EmptyState(props: {
  readonly title: string;
  readonly body?: string;
  readonly busy?: boolean;
  readonly action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={styles.empty}>
      {props.busy ? (
        <ActivityIndicator color={colors.muted} style={styles.emptySpinner} />
      ) : null}
      <Text style={[type.heading, styles.center]}>{props.title}</Text>
      {props.body ? (
        <Text style={[type.small, styles.center]}>{props.body}</Text>
      ) : null}
      {props.action ? (
        <Button
          label={props.action.label}
          onPress={props.action.onPress}
          variant="secondary"
          style={styles.emptyAction}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  // The web's large button (r8, 14px medium), at a phone's touch height;
  // compact is the web's pill.
  button: {
    minHeight: touchTarget,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  compact: {
    minHeight: 32,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
  },
  disabled: { opacity: 0.5 },
  buttonLabel: { fontSize: 15, fontWeight: "500" },
  row: {
    minHeight: 56,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
  },
  rowSelected: {
    backgroundColor: colors.sidebarMuted,
    borderRadius: radius.lg,
  },
  rowPressed: { backgroundColor: colors.surfaceSoft, borderRadius: radius.lg },
  rowText: { flex: 1, gap: 2 },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm + 2,
  },
  noticeAction: { fontWeight: "600", color: colors.ink },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: space.xxl,
    gap: space.sm,
  },
  emptySpinner: { marginBottom: space.sm },
  emptyAction: { marginTop: space.lg },
  center: { textAlign: "center" },
});
