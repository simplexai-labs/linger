// Refreshes the push grant when a session opens, and opens the computer and
// Room a tapped notification names.
import * as Notifications from "expo-notifications";
import { router } from "expo-router";
import { useEffect, useRef } from "react";

import { useComputer } from "../computer/computer-context";
import { useTranslation } from "../i18n/use-translation";
import { documentFiles } from "../computer/store-expo";
import { notificationTarget } from "./grant";
import { syncPushGrant } from "./push";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function openTarget(
  response: Notifications.NotificationResponse | null,
  computers: readonly { hostId: string }[],
  switchTo: (hostId: string) => Promise<void>,
): void {
  const target = notificationTarget(
    response?.notification.request.content.data,
  );
  if (!target) return;
  if (!computers.some((computer) => computer.hostId === target.hostId)) return;
  void switchTo(target.hostId).then(() => {
    router.navigate({
      pathname: "/rooms/[roomId]",
      params: { roomId: target.roomId },
    });
    Notifications.clearLastNotificationResponse();
  });
}

export function PushSync() {
  const { active, session, computers, switchTo, loaded } = useComputer();
  const hostId = active?.hostId;
  // A new interface language renews the grant, so alerts follow it.
  const { language } = useTranslation();
  const computersRef = useRef(computers);
  const switchRef = useRef(switchTo);

  useEffect(() => {
    computersRef.current = computers;
    switchRef.current = switchTo;
  }, [computers, switchTo]);

  useEffect(() => {
    if (!session || !hostId) return;
    // Best effort: without a grant the phone simply gets no alerts.
    syncPushGrant({ session, hostId, files: documentFiles }).catch(
      () => undefined,
    );
  }, [hostId, session, language]);

  // A tap that launched the app: act once the paired computers are known.
  useEffect(() => {
    if (loaded)
      openTarget(
        Notifications.getLastNotificationResponse(),
        computersRef.current,
        switchRef.current,
      );
  }, [loaded]);

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(
      (response) =>
        openTarget(response, computersRef.current, switchRef.current),
    );
    return () => subscription.remove();
  }, []);

  return null;
}
