// Push on the device: permission, the Expo token, the grant from the Push
// Service, and handing that grant (never the token) to the computer.
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import {
  deletePushGrant,
  putPushGrant,
  putPushPreferences,
} from "../api/teamhub";
import type { TextFiles } from "../computer/store";
import type { PhoneSession } from "../session/session";
import {
  pushSetupFrom,
  readPushRecord,
  shouldRefreshGrant,
  updatePushRecord,
  type PushPreferences,
  type PushSetup,
} from "./grant";

export function pushSetup(): PushSetup | undefined {
  return pushSetupFrom(Constants.expoConfig?.extra);
}

async function ensureChannel(): Promise<void> {
  // Android 13+ shows the permission prompt only once a channel exists.
  if (Platform.OS === "android")
    await Notifications.setNotificationChannelAsync("default", {
      name: "Linger",
      importance: Notifications.AndroidImportance.HIGH,
    });
}

export async function pushPermissionGranted(): Promise<boolean> {
  return (await Notifications.getPermissionsAsync()).granted;
}

/** Asks once; a denied prompt is not asked again by the system. */
export async function requestPushPermission(): Promise<boolean> {
  await ensureChannel();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!current.canAskAgain) return false;
  return (await Notifications.requestPermissionsAsync()).granted;
}

async function requestGrant(
  setup: PushSetup,
  expoToken: string,
  hostId: string,
): Promise<string> {
  const response = await fetch(`${setup.serviceUrl}/v1/push/grants`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ expo_token: expoToken, host_id: hostId }),
  });
  if (!response.ok) throw new Error(`Push Service answered ${response.status}`);
  const body = (await response.json()) as { grant?: unknown };
  if (typeof body.grant !== "string")
    throw new Error("Push Service sent no grant");
  return body.grant;
}

/**
 * Gives the computer a fresh grant when push is on, allowed, and the last
 * grant is missing, older than a week, or names another token.
 */
export async function syncPushGrant(input: {
  session: PhoneSession;
  hostId: string;
  files: TextFiles;
}): Promise<void> {
  const setup = pushSetup();
  if (!setup) return;
  const record = await readPushRecord(input.files, input.hostId);
  if (!record.enabled) {
    // The computer keeps a grant until told; tell it on the next session.
    if (record.revokePending) {
      await deletePushGrant(input.session);
      await updatePushRecord(input.files, input.hostId, {
        revokePending: false,
      });
    }
    return;
  }
  if (record.preferencesPending && record.preferences) {
    await putPushPreferences(
      input.session,
      wirePreferences(record.preferences),
    );
    await updatePushRecord(input.files, input.hostId, {
      preferencesPending: false,
    });
  }
  if (!(await pushPermissionGranted())) return;
  await ensureChannel();
  const expoToken = (
    await Notifications.getExpoPushTokenAsync({ projectId: setup.projectId })
  ).data;
  if (!shouldRefreshGrant(record, expoToken, Date.now())) return;
  const grant = await requestGrant(setup, expoToken, input.hostId);
  await putPushGrant(input.session, { grant, service_url: setup.serviceUrl });
  await updatePushRecord(input.files, input.hostId, {
    enabled: true,
    grantedAt: new Date().toISOString(),
    expoToken,
  });
}

function wirePreferences(preferences: PushPreferences) {
  return {
    replies: preferences.replies,
    decisions: preferences.decisions,
    when_active: preferences.whenActive,
  };
}

/**
 * Records what this phone wants to hear about from one computer and tells
 * the computer, now or on the next session.
 */
export async function setPushPreferences(input: {
  session: PhoneSession | undefined;
  hostId: string;
  files: TextFiles;
  preferences: PushPreferences;
}): Promise<void> {
  await updatePushRecord(input.files, input.hostId, {
    preferences: input.preferences,
    preferencesPending: true,
  });
  if (!input.session) return;
  await putPushPreferences(input.session, wirePreferences(input.preferences));
  await updatePushRecord(input.files, input.hostId, {
    preferencesPending: false,
  });
}

/** Turns push off for one computer: it forgets the grant, the phone remembers the choice. */
export async function disablePush(input: {
  session: PhoneSession | undefined;
  hostId: string;
  files: TextFiles;
}): Promise<void> {
  // The computer forgets the grant, so turning push on again needs a new one.
  await updatePushRecord(input.files, input.hostId, {
    enabled: false,
    revokePending: true,
    grantedAt: undefined,
    expoToken: undefined,
  });
  if (!input.session) return;
  await deletePushGrant(input.session);
  await updatePushRecord(input.files, input.hostId, { revokePending: false });
}

export async function enablePush(input: {
  session: PhoneSession | undefined;
  hostId: string;
  files: TextFiles;
}): Promise<boolean> {
  const granted = await requestPushPermission();
  await updatePushRecord(input.files, input.hostId, { enabled: true });
  if (granted && input.session)
    await syncPushGrant({ ...input, session: input.session });
  return granted;
}
