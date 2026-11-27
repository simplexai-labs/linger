// Voice entry points: Live and meeting recording open full-screen voice
// routes (docs/mobile.md, "Voice").

/** The voice screens on the root stack. */
export type VoiceMode = "live" | "record";

export const voiceModes: readonly VoiceMode[] = ["live", "record"];

export function isVoiceMode(value: unknown): value is VoiceMode {
  return (
    typeof value === "string" &&
    (voiceModes as readonly string[]).includes(value)
  );
}

/**
 * Live starts listening at once only when the app itself opened it, such as
 * the composer's Live button; a `linger://voice/live` link from elsewhere
 * asks first, so no link turns the microphone on by itself.
 */
let liveArmed = false;

export function armLive(): void {
  liveArmed = true;
}

export function takeLiveArm(): boolean {
  const armed = liveArmed;
  liveArmed = false;
  return armed;
}
