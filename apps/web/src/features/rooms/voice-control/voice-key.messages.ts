import { defineMessages } from "@/i18n/messages";

/** The dialog that takes the Soniox or xAI key a voice action needs. */
export const voiceKeyMessages = defineMessages("voiceKey", {
  title: "{provider} key",
  turnOnVoice: "Turn on voice",
  voiceProvider: "Voice provider",
  localModel: "Local model",
  localTitle: "Local speech model",
  localPurpose:
    "Dictation runs on the speech model downloaded to this server. Choose what then rewrites what you said.",
  rewriteWith: "Rewrite with",
  rewriteWithCli: "Claude CLI",
  rewriteWithApi: "My API key",
  apiPurpose:
    "Rewrites with an OpenAI-compatible API of your own, such as DeepSeek. Your words are sent to it.",
  apiBaseUrl: "API address",
  apiModel: "Model",
  listApiModels: "Get models from the API",
  apiModelHint:
    "Enter the address and key, then select the round button to pick a model from the API, or type a name.",
  apiModelsListing: "Getting models…",
  apiModelsListed: {
    one: "{count} model available. Pick it or type another name.",
    other: "{count} models available. Pick one or type another name.",
  },
  apiModelsNone:
    "This API does not list its models. Type the name of the model to use.",
  apiListInvalid: "Enter an https API address and its key.",
  apiKeyLabel: "API key",
  keyHint: "Stored encrypted and never shown again.",
  apiKeySavedHint: "A key is saved. Leave this empty to keep it.",
  apiKeyNewAddressHint:
    "Enter this address's own key. The saved key is used only at the address it was saved for.",
  apiRejected: "The API rejected this key. Check it and try again.",
  apiUnreachable: "Could not reach the API to check the key. Try again.",
  invalidApi: "Enter an https API address, a model and a key.",
  checkingApi: "Checking the API…",
  localReady: "The speech model is ready.",
  localDownloading:
    "The speech model is still downloading. Dictation starts once it is ready.",
  localUnavailable: "This server has no speech model.",
  rewriteModel: "Rewrite model",
  rewriteModelLabel: "Model that rewrites dictated text",
  rewriteModelHint:
    "Runs on the Claude CLI connected to each person's Another Me. Haiku is the fastest.",
  defaultRewriteModel: "Haiku (fastest, recommended)",
  rewriteModelSonnet: "Sonnet",
  rewriteModelOpus: "Opus",
  useLocalModel: "Use local model",
  localSavedButOff:
    "The choice is saved, but dictation could not be turned on yet. Try again.",
  localSaveFailed: "Could not save the choice. Try again.",
  sonioxPurpose:
    "Transcribes meetings, Pocket Notes dictation and Voice Mode dictation.",
  xaiPurpose: "Turns Voice Mode into a live conversation with Grok.",
  stepOpen: "Open the {provider} Console and sign in or create an account.",
  stepCreate: "Create an API key.",
  stepPaste: "Copy the key, paste it below, and select Save key.",
  apiKey: "{provider} API key",
  turningOn: "Turning on voice…",
  savedButOff: "The key is saved, but voice could not be turned on. Try again.",
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
