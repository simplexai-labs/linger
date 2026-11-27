// The start every voice feature shares: a VoiceSession and its grant, the
// microphone, and a Bridge stream that publishes it. Audio captured before
// the Runtime is ready stays on the phone and goes out once released, so the
// first words are not lost while the computer gets ready.
import { getVoiceSession } from "../api/teamhub";
import type { VoiceSession, VoiceSessionPurpose } from "../api/types";
import { documentFiles } from "../computer/store-expo";
import { t } from "../i18n/language";
import type { Message } from "../i18n/messages";
import { HttpError } from "../session/http";
import { SessionClosed } from "../session/session";
import {
  MicrophoneBusy,
  openMicrophone,
  type AudioUse,
  type Microphone,
  type MicrophoneOptions,
} from "./audio";
import {
  BridgeClient,
  BridgeFailed,
  type BridgeListener,
} from "./bridge-client";
import type { SessionSource } from "./use-session-source";
import { voiceErrorMessages } from "./voice-link.messages";
import {
  VoiceNotReady,
  closeVoice,
  openVoiceSession,
  waitForInputReady,
} from "./voice-session";

const PUBLISH_TIMEOUT_MS = 20_000;

export interface VoiceLink {
  readonly voice: VoiceSession;
  readonly bridge: BridgeClient;
  readonly microphone: Microphone;
  /** Resolves once the Bridge published and the Runtime is ready; audio is still held. */
  readonly ready: Promise<void>;
  /** Stops the Bridge and closes the VoiceSession; the microphone stops separately. */
  close(): Promise<void>;
}

const uses: Record<VoiceSessionPurpose, AudioUse> = {
  chat_dictation: "dictate",
  chat_live: "live",
  hardware_control: "record",
};

/** An open session within a few seconds, or undefined. */
async function sessionSoon(source: SessionSource, ms: number) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await source(abort.signal);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export async function openVoiceLink(input: {
  readonly purpose: VoiceSessionPurpose;
  readonly roomId: string;
  readonly hostId: string;
  readonly sessions: SessionSource;
  readonly signal: AbortSignal;
  readonly listener?: BridgeListener;
  readonly microphone?: Omit<MicrophoneOptions, "use" | "onFrame">;
  /** True once the Runtime already spoke, which proves it listens. */
  activity?(): boolean;
}): Promise<VoiceLink> {
  const { sessions, signal } = input;
  const session = await sessions(signal);
  const opened = await openVoiceSession({
    session,
    files: documentFiles,
    hostId: input.hostId,
    roomId: input.roomId,
    purpose: input.purpose,
  });
  const voice = opened.voice;
  let published!: (value: { generation: number }) => void;
  let refused!: (error: Error) => void;
  const publishing = new Promise<{ generation: number }>((resolve, reject) => {
    published = resolve;
    refused = reject;
  });
  publishing.catch(() => undefined);
  const listener = input.listener ?? {};
  const bridge = new BridgeClient({
    voiceSessionId: voice.id,
    credential: opened.credential.credential,
    purpose: input.purpose,
    held: true,
    session: sessions,
    listener: {
      ...listener,
      published(value) {
        published(value);
        listener.published?.(value);
      },
      failed(code) {
        refused(new BridgeFailed(code));
        listener.failed?.(code);
      },
    },
  });
  const close = async () => {
    bridge.stop();
    await closeVoice({
      session: await sessionSoon(sessions, 5_000),
      files: documentFiles,
      hostId: input.hostId,
      voiceSessionId: voice.id,
    });
  };
  let microphone: Microphone;
  try {
    microphone = await openMicrophone({
      ...input.microphone,
      use: uses[input.purpose],
      onFrame: (frame) => bridge.sendAudio(frame),
    });
  } catch (error) {
    await close();
    throw error;
  }
  bridge.start();
  const ready = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { generation } = await Promise.race([
      publishing,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new VoiceNotReady()),
          PUBLISH_TIMEOUT_MS,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    await waitForInputReady({
      read: async (readSignal) =>
        getVoiceSession(await sessions(readSignal), voice.id, readSignal),
      generation,
      signal,
      activity: input.activity,
    });
  })();
  ready.catch(() => undefined);
  return { voice, bridge, microphone, ready, close };
}

const m = voiceErrorMessages;

const bridgeMessages: Record<string, Message<string>> = {
  TOO_MANY_SESSIONS: m.tooManySessions,
  CONNECT_FAILED: m.connectFailed,
  ROOM_CLOSED: m.roomClosed,
  HOLD_EXPIRED: m.holdExpired,
  SHUTTING_DOWN: m.shuttingDown,
};

const httpMessages: Record<string, Message<string>> = {
  LIVE_UNAVAILABLE: m.liveUnavailable,
  VOICE_CAPTURE_CONFLICT: m.captureConflict,
  VOICE_MEDIA_UNAVAILABLE: m.mediaUnavailable,
  NOT_AVAILABLE_ON_MOBILE: m.notAvailableOnMobile,
};

/** A sentence for the screen; the code decides it, never an error's prose. */
export function describeVoiceError(error: unknown): string {
  if (error instanceof BridgeFailed) {
    const known = bridgeMessages[error.code];
    return known ? t(known) : t(m.bridgeStopped, { code: error.code });
  }
  if (error instanceof HttpError) {
    const known = httpMessages[error.code];
    return known ? t(known) : t(m.refused, { code: error.code });
  }
  if (error instanceof SessionClosed) return t(m.notConnected);
  if (error instanceof MicrophoneBusy) return t(m.microphoneBusy);
  if (error instanceof VoiceNotReady)
    return error.code
      ? t(m.voiceUnavailable, { code: error.code })
      : t(m.notReadyInTime);
  return t(m.couldNotStart);
}
