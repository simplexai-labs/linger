import { defineMessages } from "@/i18n/messages";

export const voiceSettingsMessages = defineMessages("voiceSettings", {
  title: "Voice",
  description:
    "Choose where speech transcription runs, configure your microphone, and tune local performance.",
  speechModelHeading: "Speech model",
  speechProviderTabs: "Speech model source",
  tabLocal: "On this computer",
  tabCloud: "Cloud",
  tabInUse: "In use",
  voiceSettingsLink: "Voice settings",
  openVoiceSettings: "More voice settings",
  modelsTabVoice: "Voice",

  runtimeDeviceLabel: "Execution device",
  deviceCuda: "GPU · CUDA",
  deviceMetal: "GPU · Metal",
  deviceVulkan: "GPU · Vulkan",
  deviceDirectml: "GPU · DirectML",
  deviceCpu: "CPU",
  badgeGpu: "GPU",
  badgeCpu: "CPU",
  runtimeStandby: "Standby",
  runtimeLoading: "Loading…",
  runtimeError: "Runtime error",

  fallbackInsufficientVram:
    "Running on CPU because available GPU memory (VRAM) is not enough for this speech model.",
  fallbackInsufficientUnifiedMemory:
    "Running on CPU because available unified memory is not enough for GPU acceleration.",
  fallbackMemoryPressureWarn:
    "Running on CPU to reduce system memory pressure.",
  fallbackMemoryPressureCritical:
    "Running on CPU because system memory pressure is critical.",
  fallbackDriverUpdateRequired:
    "Running on CPU because the GPU driver needs an update for speech acceleration.",
  fallbackVulkanUnavailable:
    "Running on CPU because Vulkan GPU support is unavailable on this computer.",
  fallbackGpuEngineUnavailable:
    "Running on CPU because the GPU speech engine is not installed on this computer.",
  fallbackGpuUnsupportedPlatform:
    "Running on CPU because GPU acceleration is not supported on this platform.",
  fallbackCpuOptimalForInt8:
    "Running on CPU — this INT8 speech model is optimized for fast CPU execution with zero GPU memory.",
  fallbackGpuInitFailed:
    "GPU initialization failed, so speech recognition automatically fell back to CPU.",
  fallbackRuntimeOomFallback:
    "GPU ran out of memory during transcription and automatically fell back to CPU.",
  fallbackYieldedToLlm:
    "Speech recognition yielded GPU memory to the active local LLM and is running on CPU.",
  fallbackNoSupportedGpu:
    "No supported GPU was detected on this computer; running on CPU automatically.",

  qualityFast: "Fast",
  qualityHighAccuracy: "High accuracy",
  modelSensevoiceDescription:
    "Fast recognition for Chinese, English, Japanese, Korean, and Cantonese.",
  modelWhisperDescription:
    "High multilingual accuracy across ~99 languages. Faster with a GPU.",
  modelLanguagesCount: "~{count} languages",
  modelLicensePrefix: "License:",
  modelLicenseOptInNotice:
    "Custom license — opt-in download only. Review the license before downloading.",
  sizeMb: "{mb} MB",
  sizeGb: "{gb} GB",
  downloadProgressLabel: "{name} download progress",
  downloadStepVerify: "Verifying…",
  downloadProgressStats: "{percent}% · {done} / {total}",
  downloadProgressStatsWithSpeed: "{percent}% · {done} / {total} · {speed}/s",

  statusNotDownloaded: "Not downloaded",
  statusDownloaded: "Downloaded",
  statusDownloading: "Downloading…",
  statusLoading: "Loading…",
  statusInUse: "In use",
  statusFailed: "Failed",
  endingCancel: "Cancelling…",
  endingRemove: "Deleting…",

  actionDownload: "Download",
  actionCancel: "Cancel",
  actionUse: "Use",
  actionDelete: "Delete",
  actionRetry: "Retry",
  actionRefresh: "Refresh",
  actionSwitchToCloud: "Switch to Cloud",

  deleteDialogTitle: "Delete speech model?",
  deleteDialogBody:
    "Remove {name} from this computer to free {size} of disk space. You can download it again later.",
  deleteDialogConfirm: "Delete",

  unavailableNoComputerTitle: "No local Computer connected",
  unavailableNoComputerBody:
    "Connect a Computer in <link>Settings → Computers</link> to run speech recognition on your own machine, or switch to Cloud.",
  unavailableOfflineTitle: "{name} is offline",
  unavailableOfflineBody:
    "Reconnect {name} in <link>Settings → Computers</link> to download or manage local speech models, or switch to Cloud.",
  unavailableToolNotInstalled:
    "Local speech tools are not installed on this Computer yet. Check <link>Settings → Computers</link> or switch to Cloud.",
  unavailableSpeechUnsupported:
    "This Computer's local models tool does not support local speech yet. Update it in <link>Settings → Computers</link> or switch to Cloud.",
  unavailableToolFailed:
    "The local speech runtime reported an error on this Computer. Try refreshing or switch to Cloud.",
  unavailableNotReported:
    "Waiting for this Computer to report its local speech status. Try refreshing or switch to Cloud.",
  unavailableReadOnly:
    "Only this Computer's owner can download or remove local speech models.",
  loadFailedTitle: "Could not load local speech models",

  errorComputerOffline: "This Computer is offline. Reconnect it and try again.",
  errorForbidden:
    "Only this Computer's owner can change its local speech models.",
  errorUnavailable: "Local speech is currently unavailable on this Computer.",
  errorModelUnknown: "This Computer does not recognize that speech model.",
  errorInvalidState:
    "That action is not available in the model's current state.",
  errorJobRunning:
    "Another speech model task is already running on this Computer.",
  errorDiskInsufficient:
    "Not enough free disk space on this Computer to download this model.",
  errorMemoryInsufficient:
    "Not enough free memory on this Computer to load this model.",
  errorPlatformUnsupported:
    "This speech model is not supported on this Computer's platform.",
  errorActionFailed:
    "The Computer could not complete that speech model action.",
  errorActionUnconfirmed:
    "The Computer did not confirm the action in time. Try again.",
  errorServiceUnavailable:
    "Local speech management is temporarily unavailable. Try again.",
  errorSettingsSave: "Could not save voice settings. Try again.",

  languageLabel: "Language",
  languageDescription:
    "The language you speak. Applies to both local and cloud transcription.",
  languageAuto: "Auto-detect",
  languageZh: "Chinese",
  languageEn: "English",
  languageJa: "Japanese",
  languageKo: "Korean",
  languageYue: "Cantonese",
  languageEs: "Spanish",
  languageFr: "French",
  languageDe: "German",
  languagePt: "Portuguese",
  languageRu: "Russian",
  languageAr: "Arabic",
  languageHi: "Hindi",

  cloudHeading: "Soniox Cloud",
  cloudDescription:
    "Cloud speech transcription powered by Soniox, including automatic speaker separation in Meeting Recordings.",
  cloudUseButton: "Use Cloud for transcription",
  cloudUsingBadge: "Using Cloud",
  cloudSwitchToLocalButton: "Use On this computer",
  cloudKeyReplace: "Replace key",
  cloudKeyAdd: "Add key",
  cloudKeySaved: "Soniox key saved.",
  cloudNotConfiguredHint:
    "Add a Soniox API key below to transcribe meetings and dictation in the cloud.",

  microphoneHeading: "Microphone",
  inputLabel: "Input",
  inputDescription:
    "Follows your system setting unless you pick one. Saved only in this browser.",
  inputSystemDefault: "System default",
  inputGrantAccess: "Grant microphone access",
  inputTest: "Test",
  inputStopTest: "Stop test",
  inputActiveSessionHint:
    "Microphone is currently in use by an active recording or Voice Mode session.",
  inputLevelLabel: "Microphone input level",
  inputTestingHint: "Speak to test your microphone.",
  inputTestTimedOut: "Microphone test stopped automatically after 60 seconds.",
  inputNoDevices: "No microphone found.",

  silenceTimeoutLabel: "Stop after silence",
  silenceTimeoutDescription:
    "Automatically stop dictation after a pause in speech. Does not affect meeting recordings.",
  silenceNever: "Never",
  silence3s: "3 seconds",
  silence5s: "5 seconds",
  silence10s: "10 seconds",
  silence30s: "30 seconds",
  silence60s: "1 minute",

  advancedHeading: "Advanced",
  useGpuLabel: "Use GPU",
  useGpuDescription:
    "Accelerate local speech models on GPU when available; falls back to CPU automatically.",
  useGpuNoGpuCaption:
    "No supported GPU detected on the selected Computer. Local models will run on CPU.",
  keepLoadedLabel: "Keep model loaded",
  keepLoadedDescription:
    "Keep the local speech model in memory so dictation starts immediately.",
  keepLoadedImmediate: "Unload immediately",
  keepLoaded5m: "5 minutes",
  keepLoaded15m: "15 minutes",
  keepLoaded30m: "30 minutes",
  keepLoadedNever: "Never unload",

  quickSetupLocalTab: "On this computer",
  quickSetupRecommended: "Recommended",
  quickSetupCloudTab: "Cloud",
  quickSetupLocalSubtitle:
    "Free & private — runs speech recognition locally on your Computer with no API key.",
  quickSetupDownloadAndEnable: "Download & enable",
  quickSetupUseModel: "Use model",
  quickSetupEnabling: "Enabling…",
  quickSetupNoOnlineComputer:
    "No online Computer with local speech was found. You can still use Cloud transcription.",
});
