import { defineMessages } from "@/i18n/messages";

/** The dialog that takes the Soniox or xAI key a voice action needs. */
export const voiceKeyMessages = defineMessages("voiceKey", {
  title: "{provider} key",
  turnOnVoice: "Turn on voice",
  voiceProvider: "Voice provider",
  keyReplaceHint: "A key is active. Save a new key to replace it.",
  sonioxPurpose:
    "Transcribes meetings, Pocket Notes dictation and Voice Mode dictation.",
  xaiPurpose: "Turns Voice Mode into a live conversation with Grok.",
  apiKey: "{provider} API key",
  turningOn: "Turning on voice…",
  savedButOff: "The key is saved, but voice could not be turned on. Try again.",
  keyFromEnvironmentNotice:
    "This server sets the {provider} key with <code>{variable}</code>, so it cannot be changed here.",
  cannotSaveHere:
    "This server cannot save a {provider} key here. Whoever runs it must set <code>{variable}</code>, or set <code>{storageVariable}</code> so keys can be saved here.",
  invalidKey: "Enter a valid API key.",
  keyRejected: "{provider} rejected this key. Check it and try again.",
  noBalance:
    "Your {provider} account is out of balance or reached its monthly budget. Add funds or raise the budget in the {provider} Console, then try again.",
  noRealtimePermission:
    "This key cannot use {provider} real-time transcription. Allow it for the key in the {provider} Console, or use another key.",
  keyFromEnvironment:
    "This server sets the {provider} key with {variable}, so it cannot be changed here.",
  storageUnavailable:
    "This server cannot store keys. Whoever runs it must set {storageVariable}.",
  providerUnreachable:
    "Could not reach {provider} to check the key. Try again in a moment.",
  voiceOff: "Voice is turned off on this server.",
  saveFailed: "Could not save the key. Try again.",
});
