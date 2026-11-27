// Opening and closing the VoiceSession a voice feature publishes into. A
// login session holds one open VoiceSession, so the phone remembers the one
// it opened (computers/<hostId>/voice-session.json) and closes it if the app
// died before it could.
import {
  closeVoiceSession,
  createVoiceCredential,
  createVoiceSession,
} from "../api/teamhub";
import type {
  VoiceConnectionCredential,
  VoiceSession,
  VoiceSessionPurpose,
} from "../api/types";
import { computerDirectory, type TextFiles } from "../computer/store";
import { HttpError } from "../session/http";
import type { PhoneSession } from "../session/session";

export interface OpenedVoice {
  readonly voice: VoiceSession;
  readonly credential: VoiceConnectionCredential;
}

function rememberedPath(hostId: string): string {
  return `${computerDirectory(hostId)}/voice-session.json`;
}

async function remembered(
  files: TextFiles,
  hostId: string,
): Promise<string | undefined> {
  const text = await files.read(rememberedPath(hostId));
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** Creates the VoiceSession and its publisher grant. */
export async function openVoiceSession(input: {
  readonly session: PhoneSession;
  readonly files: TextFiles;
  readonly hostId: string;
  readonly roomId: string;
  readonly purpose: VoiceSessionPurpose;
}): Promise<OpenedVoice> {
  const { session, files, hostId } = input;
  let voice: VoiceSession;
  try {
    voice = await createVoiceSession(session, input.roomId, input.purpose);
  } catch (error) {
    const stale = await remembered(files, hostId);
    if (
      !(error instanceof HttpError) ||
      error.code !== "VOICE_CAPTURE_CONFLICT" ||
      !stale
    )
      throw error;
    // The phone's own session from before a crash still holds the slot.
    await closeVoiceSession(session, stale).catch(() => undefined);
    voice = await createVoiceSession(session, input.roomId, input.purpose);
  }
  await files.write(rememberedPath(hostId), JSON.stringify({ id: voice.id }));
  try {
    const credential = await createVoiceCredential(session, voice.id);
    return { voice, credential };
  } catch (error) {
    await closeVoice({ session, files, hostId, voiceSessionId: voice.id });
    throw error;
  }
}

/** Closes the VoiceSession; a failure leaves it remembered for the next open. */
export async function closeVoice(input: {
  readonly session: PhoneSession | undefined;
  readonly files: TextFiles;
  readonly hostId: string;
  readonly voiceSessionId: string;
}): Promise<void> {
  if (!input.session) return;
  try {
    await closeVoiceSession(input.session, input.voiceSessionId);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 404) return;
  }
  if ((await remembered(input.files, input.hostId)) === input.voiceSessionId)
    await input.files.write(rememberedPath(input.hostId), "{}");
}

export class VoiceNotReady extends Error {
  constructor(readonly code?: string) {
    super(
      code
        ? `Voice is unavailable on your computer (${code}).`
        : "Voice did not get ready on your computer in time.",
    );
    this.name = "VoiceNotReady";
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}

/**
 * Waits the way a browser does: reads the VoiceSession until its Runtime
 * reports input ready for this publisher generation. `activity` ends the
 * wait early once the Runtime already spoke.
 */
export async function waitForInputReady(input: {
  read(signal: AbortSignal): Promise<VoiceSession>;
  readonly generation: number;
  readonly signal: AbortSignal;
  readonly timeoutMs?: number;
  activity?(): boolean;
}): Promise<void> {
  const deadline = Date.now() + (input.timeoutMs ?? 15_000);
  for (;;) {
    input.signal.throwIfAborted();
    if (input.activity?.()) return;
    try {
      const current = await input.read(input.signal);
      if (current.last_failure_code)
        throw new VoiceNotReady(current.last_failure_code);
      if (current.input_ready_generation === input.generation) return;
    } catch (error) {
      if (error instanceof VoiceNotReady) throw error;
      input.signal.throwIfAborted();
    }
    if (Date.now() >= deadline) throw new VoiceNotReady();
    await delay(250, input.signal);
  }
}
