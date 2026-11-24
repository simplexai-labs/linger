import { defineMessages } from "@/i18n/messages";

/** The Recording window of a meeting, and the microphone behind it. */
export const recordingMessages = defineMessages("recording", {
  // The window and its title bar.
  window: "Recording window",
  resizeWindow: "Resize recording window",
  meeting: "Meeting",
  minimize: "Minimize recording",
  minimizeHint: "Minimize; recording continues",
  open: "Open recording",
  float: "Float recording window",
  floatHint: "Float over other tabs and apps",
  returnToLinger: "Return recording to Linger",
  returnHint: "Back to Linger; recording continues",

  // The row with the live duration and the controls.
  surface: "Hardware voice focus",
  duration: "Recording duration",
  recording: "Recording",
  recordingPaused: "Recording paused",
  pauseRecording: "Pause recording",
  resumeRecording: "Resume recording",
  pause: "Pause",
  resume: "Resume",
  stopRecording: "Stop recording",
  closeRecording: "Close recording",
  stop: "Stop",
  confirmStopTitle: "Stop recording?",
  confirmStopBody:
    "The recording is saved and summarized. You can find it in Meetings.",
  stopAndSave: "Stop & save",
  keepRecording: "Keep recording",

  // The views under the row.
  views: "Recording views",
  transcriptTab: "Transcript",
  askTab: "Ask",
  transcript: "Voice focus transcript",
  transcriptScrollArea: "Transcript scroll area",
  followLatest: "Follow latest transcript",
  transcriptPlaceholder:
    "This recording’s transcript will appear here. View previous transcripts in the chat.",
  noTranscript: "No transcript is available yet.",
  listening: "Listening…",
  startNewRecording: "Start new recording",
  startRecording: "Start recording",
  speaker: "Speaker {number}",
  reconnectMicrophone: "Reconnect microphone",
  inputMissed: {
    one: "Input missed once ({seconds}s not recorded)",
    other: "Input missed {count} times ({seconds}s not recorded)",
  },

  // What the recording is doing, as the window's title.
  titleRecoveryPaused: "Recording saved. Transcript recovery paused",
  titleStopFailed: "Recording not stopped",
  titleInputInterrupted: "Recording input was interrupted",
  titleOtherTab: "Recording is continuing in another tab",
  titleListening: "I’m listening to the meeting...",
  titleSaveFailed: "Recording save failed",
  titleRecovering: "Recording saved; recovering transcript",
  titleSaving: "Saving recording...",
  titleStarting: "Starting recording…",
  titleNotStarted: "Recording did not start",
  titleReady: "Ready to start recording",

  // The line under the title.
  subtitleRecoveryPaused:
    "Retry transcription or download the original recording.",
  subtitleInputInterrupted: "Recorded content can still be saved.",
  subtitleSaveFailed: "Received transcript segments remain available here.",
  subtitleRecovering:
    "The microphone can be disconnected; recovery will continue in the background.",
  subtitleSaving: "Finishing the transcript and audio file.",
  subtitleAllowMicrophone: "Allow microphone access in the browser to begin.",
  subtitleConnecting: "Connecting the microphone…",
  subtitleNotStarted: "Check the error below, then start recording again.",
  subtitleReady: "Start recording to capture this meeting.",

  // Progress notes while the recording runs or saves.
  statusReconnectingMicrophone:
    "Reconnecting microphone; audio delivery is not yet confirmed",
  statusReconnectingTranscript:
    "Reconnecting transcript updates; saved text will sync after reconnection",
  statusReconnectingRecording:
    "Reconnecting recording status; waiting for server confirmation",
  statusAudioNotSaved:
    "Audio is not being saved yet; only the transcript is. Retrying the recording.",
  statusMicrophoneMuted:
    "Microphone muted. Your voice is not recorded until you resume.",
  statusUnconfirmedAfterStop:
    "Some transcript segments are unconfirmed. Recovery will be attempted after stopping.",
  statusUnconfirmed:
    "Some transcript segments are unconfirmed. Recording continues; recovery will be attempted after stopping.",
  statusGeneratingFiles: "Generating recording and transcript files",

  // A recording whose transcript is being recovered.
  recovery: "Recording transcript recovery",
  recordingSaved: "Recording saved",
  recoveryPausedBody:
    "Transcript recovery is paused. Please retry. You can start a new recording.",
  recoveringBody:
    "Recovering transcript {progress}%. It will appear in this Room when complete. You can start a new recording.",
  recoveringAttempt: "Attempt {attempt} of {max}",
  stopFailed:
    "Stop didn't reach the server after 3 tries, so the recording isn't saved yet. Retry to stop and save it.",
  retryStop: "Retry",
  downloadOriginal: "Download original recording",
  retryTranscription: "Retry transcription",
  downloadUnavailable: "Original recording download is temporarily unavailable",
  retryNotConfirmed:
    "The retry request was not confirmed. Check progress or try again later.",

  // Ask: questions about the recording and requests for Another Me.
  askLabel: "Ask about this recording",
  askPlaceholder: "Ask something or ask to do something",
  sendQuestion: "Send question",
  answers: "Answers about this recording",
  askEmpty:
    "Ask what was said, decided, or left open, or ask Another Me to do something, like drafting a follow-up email.",
  basedOnRecording: "Based on the recording up to {time}",
  answerFailed: "The answer could not be generated.",
  answering: "Answering…",
  sendingToAnotherMe: "Sending to Another Me…",
  notSent: "Not sent",
  sentToAnotherMe: "Sent to Another Me",

  // Why the recording or the microphone did not work.
  saveFailed: "The recording could not be saved.",
  microphoneBlocked:
    "Microphone access was blocked. Allow it in the browser, then start recording again.",
  noMicrophone:
    "No microphone is available. Connect one, then start recording again.",
  microphoneBusy: "The microphone is in use by another application.",
  microphoneDenied: "Microphone permission was denied",
  microphoneBlockedOnMac:
    "Linger can't use the microphone. Allow Linger in System Settings › Privacy & Security › Microphone, then try again.",
  microphoneInterrupted: "Microphone connection was interrupted",
  microphoneUnavailable: "Microphone access is unavailable",
  noAudioInput: "No audio input device is available",
  microphoneTimedOut: "Microphone connection timed out",
  connectMicrophone: "Connect a microphone before enabling voice",
  selectedMicrophoneUnavailable: "The selected microphone is unavailable",
  hardwareVoiceOtherTab: "Hardware voice is active in another tab",
  composerUsesMicrophone: "Composer is using the microphone",
  stopBeforeDisconnect:
    "Stop the recording before disconnecting the microphone",
  accessExpired:
    "Voice session access has expired. Sign in again or check your access to the target Agent.",
  inputNotReady: "Voice input did not become ready",
  requestTimedOut: "Voice request timed out.",
  selectTargetAgain:
    "Select the recording target again in the Agent direct chat",
  anotherMeNotReady: "Your AnotherMe is not ready for recording",
  switchingTarget: "Switching recording target. Please wait",
  stopBeforeSwitching: "Stop the current recording before switching targets",
  startInDirectChat: "Start recording in the Agent direct chat",
});
