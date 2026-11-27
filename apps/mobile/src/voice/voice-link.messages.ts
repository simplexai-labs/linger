import { defineMessages } from "../i18n/messages";

export const voiceErrorMessages = defineMessages("voiceErrors", {
  tooManySessions: "Your computer is already serving its most voice sessions.",
  connectFailed: "Your computer could not start voice. Try again.",
  roomClosed: "The voice session ended on your computer.",
  holdExpired: "The phone was away from your computer for too long.",
  shuttingDown: "Voice is restarting on your computer. Try again.",
  bridgeStopped: "Voice stopped ({code}).",
  liveUnavailable: "Live needs Another Me to be ready on your computer.",
  captureConflict:
    "Another voice session from this phone is still open. Try again in a moment.",
  mediaUnavailable: "Voice is not available on your computer right now.",
  notAvailableOnMobile:
    "Update Linger on your computer to use voice from the phone.",
  refused: "Your computer refused voice ({code}).",
  notConnected: "Connect to your computer to use voice.",
  microphoneBusy: "The microphone is already in use by another voice feature.",
  voiceUnavailable: "Voice is unavailable on your computer ({code}).",
  notReadyInTime: "Voice did not get ready on your computer in time.",
  couldNotStart: "Voice could not start. Try again.",
});
