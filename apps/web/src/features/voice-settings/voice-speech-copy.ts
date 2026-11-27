import type {
  TeamHubLocalSpeechEffectiveDevice,
  TeamHubLocalSpeechErrorCode,
  TeamHubLocalSpeechFallbackReason,
  TeamHubLocalSpeechModel,
  TeamHubLocalSpeechView,
} from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";

import { voiceSettingsMessages as m } from "./voice-settings.messages";

const fallbackMessages: Record<
  TeamHubLocalSpeechFallbackReason,
  Message<string>
> = {
  cpu_optimal_for_int8: m.fallbackCpuOptimalForInt8,
  driver_update_required: m.fallbackDriverUpdateRequired,
  gpu_engine_unavailable: m.fallbackGpuEngineUnavailable,
  gpu_init_failed: m.fallbackGpuInitFailed,
  gpu_unsupported_platform: m.fallbackGpuUnsupportedPlatform,
  insufficient_unified_memory: m.fallbackInsufficientUnifiedMemory,
  insufficient_vram: m.fallbackInsufficientVram,
  memory_pressure_critical: m.fallbackMemoryPressureCritical,
  memory_pressure_warn: m.fallbackMemoryPressureWarn,
  no_supported_gpu: m.fallbackNoSupportedGpu,
  runtime_oom_fallback: m.fallbackRuntimeOomFallback,
  vulkan_unavailable: m.fallbackVulkanUnavailable,
  yielded_to_llm: m.fallbackYieldedToLlm,
};

const deviceMessages: Record<
  TeamHubLocalSpeechEffectiveDevice,
  Message<string>
> = {
  cpu: m.deviceCpu,
  cuda: m.deviceCuda,
  directml: m.deviceDirectml,
  metal: m.deviceMetal,
  vulkan: m.deviceVulkan,
};

const actionErrorMessages: Record<
  TeamHubLocalSpeechErrorCode,
  Message<string>
> = {
  LOCAL_COMPUTER_OFFLINE: m.errorComputerOffline,
  LOCAL_SPEECH_ACTION_FAILED: m.errorActionFailed,
  LOCAL_SPEECH_ACTION_FORBIDDEN: m.errorForbidden,
  LOCAL_SPEECH_ACTION_UNCONFIRMED: m.errorActionUnconfirmed,
  LOCAL_SPEECH_DISK_INSUFFICIENT: m.errorDiskInsufficient,
  LOCAL_SPEECH_INVALID_STATE: m.errorInvalidState,
  LOCAL_SPEECH_JOB_RUNNING: m.errorJobRunning,
  LOCAL_SPEECH_MEMORY_INSUFFICIENT: m.errorMemoryInsufficient,
  LOCAL_SPEECH_MODEL_UNKNOWN: m.errorModelUnknown,
  LOCAL_SPEECH_PLATFORM_UNSUPPORTED: m.errorPlatformUnsupported,
  LOCAL_SPEECH_SERVICE_UNAVAILABLE: m.errorServiceUnavailable,
  LOCAL_SPEECH_UNAVAILABLE: m.errorUnavailable,
};

type UnavailableCode = NonNullable<TeamHubLocalSpeechView["reason"]>["code"];

const unavailableMessages: Record<UnavailableCode, Message<string>> = {
  NOT_REPORTED: m.unavailableNotReported,
  SPEECH_UNSUPPORTED: m.unavailableSpeechUnsupported,
  TOOL_FAILED: m.unavailableToolFailed,
  TOOL_NOT_INSTALLED: m.unavailableToolNotInstalled,
};

export function fallbackReasonCopy(
  reason: TeamHubLocalSpeechFallbackReason,
  t: Translate,
): string {
  return t(fallbackMessages[reason]);
}

export function fallbackBannerTone(
  reason: TeamHubLocalSpeechFallbackReason,
): "info" | "warning" {
  return reason === "cpu_optimal_for_int8" ? "info" : "warning";
}

export function effectiveDeviceLabel(
  device: TeamHubLocalSpeechEffectiveDevice,
  t: Translate,
): string {
  return t(deviceMessages[device]);
}

export function isGpuDevice(
  device: TeamHubLocalSpeechEffectiveDevice | null | undefined,
): boolean {
  return Boolean(device && device !== "cpu");
}

export function speechActionErrorCopy(
  code: string | undefined,
  t: Translate,
): string {
  if (code && Object.hasOwn(actionErrorMessages, code)) {
    return t(actionErrorMessages[code as TeamHubLocalSpeechErrorCode]);
  }
  return t(m.errorActionFailed);
}

export function speechUnavailableMessage(
  code: UnavailableCode | undefined,
): Message<string> {
  if (code && Object.hasOwn(unavailableMessages, code)) {
    return unavailableMessages[code];
  }
  return m.unavailableToolNotInstalled;
}

export function formatSpeechSize(bytes: number, t: Translate): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) {
    return t(m.sizeGb, { gb: (mb / 1024).toFixed(1) });
  }
  return t(m.sizeMb, { mb: Math.max(1, Math.round(mb)) });
}

export function formatSpeechDownloadPercent(
  download: TeamHubLocalSpeechModel["download"],
): number {
  if (!download) return 0;
  if (download.step === "verify" && download.total_bytes === 0) return 100;
  if (download.total_bytes <= 0) return 0;
  return Math.min(
    100,
    Math.max(0, Math.round((download.done_bytes / download.total_bytes) * 100)),
  );
}

export function formatSpeechDownloadStats(
  download: NonNullable<TeamHubLocalSpeechModel["download"]>,
  t: Translate,
): string {
  if (download.step === "verify") {
    return t(m.downloadStepVerify);
  }
  const percent = formatSpeechDownloadPercent(download);
  const done = formatSpeechSize(download.done_bytes, t);
  const total = formatSpeechSize(download.total_bytes, t);
  if (download.bytes_per_second > 0) {
    const speed = formatSpeechSize(download.bytes_per_second, t);
    return t(m.downloadProgressStatsWithSpeed, { done, percent, speed, total });
  }
  return t(m.downloadProgressStats, { done, percent, total });
}

export function speechModelDescription(
  model: TeamHubLocalSpeechModel,
  t: Translate,
): string {
  if (model.id === "sensevoice-small" || model.quality_rating === "fast-cjk") {
    return t(m.modelSensevoiceDescription);
  }
  if (
    model.id === "whisper-large-v3-turbo" ||
    model.quality_rating === "high-multilingual"
  ) {
    return t(m.modelWhisperDescription);
  }
  return t(m.modelLanguagesCount, { count: model.language_count });
}

export function speechModelQualityLabel(
  model: TeamHubLocalSpeechModel,
  t: Translate,
): string {
  return model.quality_rating === "fast-cjk"
    ? t(m.qualityFast)
    : t(m.qualityHighAccuracy);
}

/** Formats canonical license identifiers into human-readable display names. */
export function formatLicenseDisplayName(license: string): string {
  if (license === "FunASR-MODEL-LICENSE-1.1") {
    return "FunASR MODEL_LICENSE v1.1";
  }
  return license;
}

/** Whether a speech model requires prominent opt-in license disclosure. */
export function requiresLicenseDisclosure(
  model: TeamHubLocalSpeechModel,
): boolean {
  return (
    Boolean(model.commercial_notice) || model.license.toUpperCase() !== "MIT"
  );
}

export interface SelectOption<T extends string | number = string> {
  label: string;
  value: T;
}

export function speechLanguageOptions(t: Translate): readonly SelectOption[] {
  return [
    { label: t(m.languageAuto), value: "auto" },
    { label: t(m.languageZh), value: "zh" },
    { label: t(m.languageEn), value: "en" },
    { label: t(m.languageJa), value: "ja" },
    { label: t(m.languageKo), value: "ko" },
    { label: t(m.languageYue), value: "yue" },
    { label: t(m.languageEs), value: "es" },
    { label: t(m.languageFr), value: "fr" },
    { label: t(m.languageDe), value: "de" },
    { label: t(m.languagePt), value: "pt" },
    { label: t(m.languageRu), value: "ru" },
    { label: t(m.languageAr), value: "ar" },
    { label: t(m.languageHi), value: "hi" },
  ];
}

export function silenceTimeoutOptions(
  t: Translate,
): readonly SelectOption<number>[] {
  return [
    { label: t(m.silenceNever), value: 0 },
    { label: t(m.silence3s), value: 3 },
    { label: t(m.silence5s), value: 5 },
    { label: t(m.silence10s), value: 10 },
    { label: t(m.silence30s), value: 30 },
    { label: t(m.silence60s), value: 60 },
  ];
}

export function keepLoadedOptions(
  t: Translate,
): readonly SelectOption<number>[] {
  return [
    { label: t(m.keepLoadedImmediate), value: 0 },
    { label: t(m.keepLoaded5m), value: 300 },
    { label: t(m.keepLoaded15m), value: 900 },
    { label: t(m.keepLoaded30m), value: 1800 },
    { label: t(m.keepLoadedNever), value: -1 },
  ];
}
