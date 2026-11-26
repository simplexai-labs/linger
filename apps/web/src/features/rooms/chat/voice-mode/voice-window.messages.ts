import { defineMessages } from "@/i18n/messages";

/** The floating Voice Mode window, and what the floating windows share. */
export const voiceWindowMessages = defineMessages("voiceWindow", {
  window: "Voice Mode window",
  title: "Voice Mode",
  openConversation: "Open this conversation",

  // The window's controls; named apart from the composer's own.
  retry: "Retry voice message from the voice window",
  mute: "Mute Voice Mode",
  unmute: "Unmute Voice Mode",
  replySoundOn: "Turn reply sound on from the voice window",
  replySoundOff: "Turn reply sound off from the voice window",
  showConversation: "Show Voice Mode conversation",
  hideConversation: "Hide Voice Mode conversation",
  end: "End Voice Mode",
  resize: "Resize Voice Mode window",
  dragHint: "Drag the floating window to move or resize it.",

  // The call's state, short enough for the window's one line.
  statusWakingUp: "Waking up",
  statusListening: "Listening",
  statusMicOff: "Mic off",
  statusSending: "Sending…",
  statusPaused: "Paused",
  statusFinishing: "Finishing…",
  statusStopped: "Stopped",

  // The conversation in the window.
  conversation: "Voice Mode conversation",
  empty: "Start speaking. Your words and replies appear here.",
  reply: "Reply",
  working: "Working…",
  pendingSelections: {
    one: "Next turn includes {count} selection",
    other: "Next turn includes {count} selections",
  },

  // Shared by the Voice Mode and recording windows.
  resizeHint: "Drag to resize, or use the arrow keys",
  /** The floating recording window's name on the desktop. */
  meetingTitle: "Meeting",
});
