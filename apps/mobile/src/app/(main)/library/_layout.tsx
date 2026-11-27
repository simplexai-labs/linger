import { Stack } from "expo-router";

import { useTranslation } from "../../../i18n/use-translation";
import { libraryScreenMessages as m } from "../../../library/library-screen.messages";
import { colors } from "../../../theme";
import { SidebarButton } from "../../../ui/sidebar-button";

export default function LibraryLayout() {
  const { t } = useTranslation();
  return (
    <Stack
      screenOptions={{
        headerTintColor: colors.ink,
        headerStyle: { backgroundColor: colors.canvas },
        headerShadowVisible: false,
        headerBackTitle: t(m.library),
        contentStyle: { backgroundColor: colors.canvas },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: t(m.library),
          headerLeft: () => <SidebarButton />,
        }}
      />
      <Stack.Screen
        name="meetings/[entryId]"
        options={{ title: t(m.meeting) }}
      />
    </Stack>
  );
}
