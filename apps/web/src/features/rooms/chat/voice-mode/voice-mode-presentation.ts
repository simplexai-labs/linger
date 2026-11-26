import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import type { VoiceModeState } from "./voice-mode-controller";
import { voiceModeMessages } from "./voice-mode.messages";
import { voiceWindowMessages } from "./voice-window.messages";

export interface VoiceModePresentation {
  entered: boolean;
  text: string;
  status?: VoiceModeState["status"];
  sending?: boolean;
  flushing?: boolean;
  microphoneActive?: boolean;
  error?: string;
  expectedText?: string;
  sourceId?: string;
  /** The draft that preceded dictation; lets a remounted composer resume. */
  prefix?: string;
}

/**
 * Describes actual state only; the browser does not invent a VAD countdown.
 * A translated surface passes its `t`; the others read it in English.
 */
export function voiceModeStatusLabel(
  state: VoiceModePresentation,
  t?: Translate,
): string {
  const text = (message: Message<string>) => (t ? t(message) : message.source);
  if (state.error) return state.error;
  if (state.status === "closing") return text(voiceModeMessages.statusClosing);
  if (state.status === "connecting")
    return state.microphoneActive
      ? text(voiceModeMessages.statusConnectingTranscription)
      : text(voiceModeMessages.statusConnectingMicrophone);
  if (state.status === "error") return text(voiceModeMessages.statusStopped);
  if (!state.entered || state.status === "paused")
    return text(voiceModeMessages.statusPaused);
  if (state.flushing) return text(voiceModeMessages.statusFlushing);
  if (state.sending) return text(voiceModeMessages.statusSending);
  return text(voiceModeMessages.statusListening);
}

/**
 * The window's one-line state. A live call says it is waking up until the
 * live model itself is connected, though the microphone may already be heard.
 */
export function voiceWindowStatus(
  state: VoiceModePresentation,
  call: { muted: boolean; waking?: boolean },
): Message<string> {
  if (state.error || state.status === "error")
    return voiceWindowMessages.statusStopped;
  if (state.status === "closing") return voiceWindowMessages.statusFinishing;
  if (state.status === "connecting" || state.status === "idle" || call.waking)
    return voiceWindowMessages.statusWakingUp;
  if (!state.entered || state.status === "paused")
    return voiceWindowMessages.statusPaused;
  if (call.muted) return voiceWindowMessages.statusMicOff;
  if (state.sending || state.flushing) return voiceWindowMessages.statusSending;
  return voiceWindowMessages.statusListening;
}
