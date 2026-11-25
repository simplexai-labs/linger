import { Stack } from "expo-router";

import { colors } from "../../../theme";
import { SidebarButton } from "../../../ui/sidebar-button";

/**
 * The bar holds only the sidebar button; the page draws its own title so it
 * lines up with the groups below, which the native large title does not.
 */
export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.ink,
        headerStyle: { backgroundColor: colors.sidebar },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.sidebar },
      }}
    >
      <Stack.Screen
        name="index"
        options={{ title: "", headerLeft: () => <SidebarButton /> }}
      />
    </Stack>
  );
}
