// Opens the drawer with the desktop's sidebar icon, where the web shows its
// own sidebar toggle.
import { tick } from "./haptics";
import { useNavigation } from "expo-router";
import { Pressable, StyleSheet } from "react-native";

import { useTranslation } from "../i18n/use-translation";
import { colors, radius } from "../theme";
import { Icon } from "./icon";
import { uiMessages } from "./ui.messages";

export function SidebarButton() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t(uiMessages.openMenu)}
      hitSlop={6}
      // expo-router owns the navigation tree; its drawer opens on this action.
      onPress={() => {
        tick();
        navigation.dispatch({ type: "OPEN_DRAWER" });
      }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}
    >
      <Icon name="sidebar" size={20} color={colors.secondary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    width: 40,
    height: 40,
    marginLeft: 8,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: { backgroundColor: colors.sidebarMuted },
});
