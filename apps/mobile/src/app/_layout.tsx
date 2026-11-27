import { useFonts } from "expo-font";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { OutboxProvider } from "../chat/outbox-context";
import { ComputerProvider } from "../computer/computer-context";
import { useTranslation } from "../i18n/use-translation";
import { startAppLog } from "../lib/app-log-expo";
import { PushSync } from "../push/push-sync";
import { RealtimeProvider } from "../realtime/realtime-context";
import { documentMessages } from "../screens/document.messages";
import { createQueryClient, QueryProvider } from "../state/queries";
import { colors } from "../theme";
import { GEIST_FONTS } from "../ui/fonts";

// The log starts with the app, before any screen.
startAppLog();

export default function RootLayout() {
  const { t } = useTranslation();
  const [queryClient] = useState(createQueryClient);
  // The splash stays up until Geist is ready, so no screen draws in the
  // system font first; a font that fails to load falls back to it.
  const [fontsLoaded, fontError] = useFonts(GEIST_FONTS);
  if (!fontsLoaded && !fontError) return null;
  return (
    <GestureHandlerRootView style={styles.root}>
      <KeyboardProvider>
        <SafeAreaProvider>
          <ComputerProvider>
            <QueryProvider client={queryClient}>
              <RealtimeProvider>
                <OutboxProvider>
                  <PushSync />
                  <StatusBar style="dark" />
                  <Stack
                    screenOptions={{
                      headerShown: false,
                      contentStyle: { backgroundColor: colors.canvas },
                      headerTitleStyle: { fontFamily: "Geist-SemiBold" },
                      headerBackTitleStyle: { fontFamily: "Geist-Regular" },
                    }}
                  >
                    <Stack.Screen name="(main)" />
                    <Stack.Screen
                      name="pair"
                      options={{ gestureEnabled: false }}
                    />
                    {/* A voice screen ends through its own End or Stop, never a
                      swipe that would leave the microphone running. */}
                    <Stack.Screen
                      name="voice/[mode]"
                      options={{
                        presentation: "fullScreenModal",
                        gestureEnabled: false,
                      }}
                    />
                    {/* An Agent's profile slides up as a native page sheet. */}
                    <Stack.Screen
                      name="agent/[agentId]"
                      options={{ presentation: "modal" }}
                    />
                    <Stack.Screen
                      name="document/[documentId]"
                      options={{
                        headerShown: true,
                        title: t(documentMessages.title),
                        headerBackTitle: t(documentMessages.back),
                        headerTintColor: colors.ink,
                        headerStyle: { backgroundColor: colors.canvas },
                        headerShadowVisible: false,
                      }}
                    />
                  </Stack>
                </OutboxProvider>
              </RealtimeProvider>
            </QueryProvider>
          </ComputerProvider>
        </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.canvas },
});
