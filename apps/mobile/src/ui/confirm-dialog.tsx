// The design system's dialog, for a question the Human must answer: white,
// r8, shadow-lg, over the canvas washed light (never a dark scrim), a 16px
// semibold title, an optional 14px line, and the actions side by side with
// the main one last. Replaces the system alert so it matches the app.
import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";

import { useTranslation } from "../i18n/use-translation";
import { colors, radius, shadow, space } from "../theme";
import { Button } from "./controls";
import { Text } from "./text";
import { uiMessages } from "./ui.messages";

export function ConfirmDialog(props: {
  readonly visible: boolean;
  readonly title: string;
  readonly body?: string;
  readonly confirmLabel: string;
  readonly cancelLabel?: string;
  /** danger for an action that cannot be undone. */
  readonly tone?: "primary" | "danger";
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}) {
  const { t } = useTranslation();
  const cancelLabel = props.cancelLabel ?? t(uiMessages.cancel);
  const enter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!props.visible) {
      enter.setValue(0);
      return;
    }
    // The dialog enters from 95% in 100 ms (app-dialog-enter).
    Animated.timing(enter, {
      toValue: 1,
      duration: 100,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();
  }, [enter, props.visible]);
  return (
    <Modal
      transparent
      visible={props.visible}
      animationType="fade"
      onRequestClose={props.onCancel}
      statusBarTranslucent
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={cancelLabel}
        style={styles.scrim}
        onPress={props.onCancel}
      />
      <View style={styles.center} pointerEvents="box-none">
        <Animated.View
          accessibilityViewIsModal
          style={[
            styles.dialog,
            {
              opacity: enter,
              transform: [
                {
                  scale: enter.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.95, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <Text style={styles.title} accessibilityRole="header">
            {props.title}
          </Text>
          {props.body ? <Text style={styles.body}>{props.body}</Text> : null}
          <View style={styles.actions}>
            <Button
              label={cancelLabel}
              variant="secondary"
              onPress={props.onCancel}
              disabled={props.busy}
              style={styles.action}
            />
            <Button
              label={props.confirmLabel}
              variant={props.tone === "danger" ? "danger" : "primary"}
              onPress={props.onConfirm}
              busy={props.busy}
              style={styles.action}
            />
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(253, 253, 252, 0.72)",
  },
  center: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    paddingHorizontal: space.lg,
  },
  dialog: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    padding: space.xl - 4,
    gap: space.sm,
    ...shadow.lg,
  },
  title: { fontSize: 16, lineHeight: 24, fontWeight: "600", color: colors.ink },
  body: { fontSize: 14, lineHeight: 21, color: colors.muted },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.md },
  action: { flex: 1 },
});
