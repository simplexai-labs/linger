// When the phone asks the Push Service for a fresh grant, and what a tapped
// notification names. docs/mobile.md ("Push") is the specification.
import { computerDirectory, type TextFiles } from "../computer/store";

/** Grants last 30 days; refreshing weekly keeps a used phone well inside that. */
export const GRANT_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

export interface PushRecord {
  readonly enabled: boolean;
  /** When the computer last accepted a grant for this phone. */
  readonly grantedAt?: string;
  /** The Expo token that grant names. */
  readonly expoToken?: string;
  /** The interface language that grant's alert text is in. */
  readonly language?: string;
  /** Push was turned off while the computer could not be told. */
  readonly revokePending?: boolean;
  /** What to be alerted about; the computer's defaults until changed. */
  readonly preferences?: PushPreferences;
  /** The preferences changed while the computer could not be told. */
  readonly preferencesPending?: boolean;
}

export interface PushPreferences {
  /** An Agent's turn ended with a reply for the Human. */
  readonly replies: boolean;
  /** The Human must decide something. */
  readonly decisions: boolean;
  /** Also while the Human looks at the chat on another device. */
  readonly whenActive: boolean;
}

export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  replies: true,
  decisions: true,
  whenActive: false,
};

function preferencesFrom(value: unknown): PushPreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { replies, decisions, whenActive } = value as Record<string, unknown>;
  return typeof replies === "boolean" &&
    typeof decisions === "boolean" &&
    typeof whenActive === "boolean"
    ? { replies, decisions, whenActive }
    : undefined;
}

export interface PushSetup {
  readonly projectId: string;
  readonly serviceUrl: string;
}

/** Push needs both build-time values; a build without them has no push. */
export function pushSetupFrom(extra: unknown): PushSetup | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const { eas, pushServiceUrl } = extra as {
    eas?: { projectId?: unknown };
    pushServiceUrl?: unknown;
  };
  const projectId = eas?.projectId;
  if (typeof projectId !== "string" || !projectId) return undefined;
  if (
    typeof pushServiceUrl !== "string" ||
    !/^https?:\/\/[^/]+/.test(pushServiceUrl)
  )
    return undefined;
  return { projectId, serviceUrl: pushServiceUrl.replace(/\/+$/, "") };
}

/**
 * A grant is renewed weekly, for a new Expo token, and when the interface
 * language changes, since the Push Service writes alerts in the language the
 * grant names. A grant from before phones sent one counts as English.
 */
export function shouldRefreshGrant(
  record: PushRecord,
  expoToken: string,
  language: string,
  now: number,
): boolean {
  if (!record.enabled) return false;
  if (!record.grantedAt || record.expoToken !== expoToken) return true;
  if ((record.language ?? "en") !== language) return true;
  const grantedAt = Date.parse(record.grantedAt);
  return Number.isNaN(grantedAt) || now - grantedAt >= GRANT_REFRESH_MS;
}

export interface NotificationTarget {
  readonly hostId: string;
  readonly roomId: string;
}

/** Reads the handle the Push Service puts in a notification's data. */
export function notificationTarget(
  data: unknown,
): NotificationTarget | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const { host_id: hostId, room_id: roomId } = data as Record<string, unknown>;
  if (typeof hostId !== "string" || !/^[0-9a-f]{32}$/.test(hostId))
    return undefined;
  if (
    typeof roomId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(roomId)
  )
    return undefined;
  return { hostId, roomId };
}

function recordPath(hostId: string): string {
  return `${computerDirectory(hostId)}/push.json`;
}

/** Push is on by default once the Human allowed notifications. */
export async function readPushRecord(
  files: TextFiles,
  hostId: string,
): Promise<PushRecord> {
  const text = await files.read(recordPath(hostId));
  if (!text) return { enabled: true };
  try {
    const parsed = JSON.parse(text) as Partial<PushRecord>;
    return {
      enabled: parsed.enabled !== false,
      grantedAt: parsed.grantedAt,
      expoToken: parsed.expoToken,
      language:
        typeof parsed.language === "string" ? parsed.language : undefined,
      revokePending: parsed.revokePending === true,
      preferences: preferencesFrom(parsed.preferences),
      preferencesPending: parsed.preferencesPending === true,
    };
  } catch {
    return { enabled: true };
  }
}

/** Changes some fields of a computer's push record and keeps the rest. */
export async function updatePushRecord(
  files: TextFiles,
  hostId: string,
  change: Partial<PushRecord>,
): Promise<PushRecord> {
  const next = { ...(await readPushRecord(files, hostId)), ...change };
  await writePushRecord(files, hostId, next);
  return next;
}

export async function writePushRecord(
  files: TextFiles,
  hostId: string,
  record: PushRecord,
): Promise<void> {
  await files.write(recordPath(hostId), JSON.stringify(record));
}
