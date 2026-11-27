import { defineMessages } from "../i18n/messages";

export const voiceRecordMessages = defineMessages("voiceRecord", {
  gapMessage: "Full phone recording (the live copy has a gap)",
  speaker: "Speaker {number}",
  phoneCopyNotSaved:
    "The phone's copy of this meeting could not be saved, so the computer's copy has a gap.",
  sendingPhoneCopy: "Sending the phone's recording to {name}…",
  onItsWay:
    "The recording is on its way and stays on this phone until your computer has it.",
  computerHasRecording:
    "Your computer has the full recording. It is in your chat with {name}.",
  sendFailed:
    "The phone's recording could not be sent. It stays on this phone; try again when your computer is reachable.",
  reconnecting:
    "Reconnecting. The phone keeps every word until your computer has it.",
  computerCopyStopped:
    "The computer's copy stopped. The phone keeps recording and sends the whole meeting when you stop.",
  couldNotStart: "Your computer could not start the recording.",
  sendingLastSeconds: "Sending the last {seconds} seconds to your computer…",
  stillSaving:
    "Your computer is still saving the meeting. It lands in your chat with {name} when done.",
  saved: "Saved. The notes arrive in your chat with {name}.",
  gettingReady: "{name} is getting ready",
  connectToRecord: "Connect to your computer to record",
  close: "Close",
  headingIdle: "Record a meeting",
  headingStarting: "Starting…",
  headingRecording: "Recording",
  headingPaused: "Paused for a call",
  headingStopping: "Stopping…",
  headingSaving: "Saving on your computer…",
  headingDone: "Saved",
  headingFailed: "Recording stopped",
  recordedFor: "Recorded {time}",
  intro:
    "Notes land in your chat with {name}. Recording goes on with the screen locked.",
  liveTranscript: "Live transcript",
  transcriptHint: "The transcript appears as people speak.",
  startRecording: "Start recording",
  stop: "Stop",
  saving: "Saving…",
  sendAgain: "Send again",
  confirmStopTitle: "Stop recording?",
  keepRecording: "Keep recording",
});
