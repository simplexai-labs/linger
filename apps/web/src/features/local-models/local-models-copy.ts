import { minNvidiaDriverForCuda } from "@linger/service-kit/nvidia-driver";
import type { components } from "@linger/wire-contracts/teamhub-public/types";

import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";

import { localModelsMessages as m } from "./local-models.messages";
import {
  formatGigabytes,
  joinList,
  type HostBlockerReason,
  type MemoryGuidance,
} from "./local-models-rules";

type Schemas = components["schemas"];

/**
 * Every code the Local models page shows, as the message that words it. The
 * page branches on codes only; diagnostic `detail` text from the Computer is
 * shown only where the contract explicitly exposes it for the owner (BYOK
 * endpoint refusals and local BYOK gateway failures). Typing each map by its
 * generated code set makes a new code a type error here until it has copy.
 */

const actionRefusals: Record<
  Schemas["LocalModelsErrorCode"],
  Message<string>
> = {
  LOCAL_COMPUTER_OFFLINE: m.refusalOffline,
  LOCAL_MODEL_ACTION_FAILED: m.refusalActionFailed,
  LOCAL_MODEL_ACTION_UNCONFIRMED: m.refusalUnconfirmed,
  LOCAL_MODEL_ACTION_FORBIDDEN: m.refusalForbidden,
  LOCAL_MODEL_DISK_INSUFFICIENT: m.refusalDiskInsufficient,
  LOCAL_MODEL_DRIVER_UPDATE_REQUIRED: m.refusalDriverUpdateRequired,
  LOCAL_MODEL_GPU_UNSUPPORTED: m.refusalGpuUnsupported,
  LOCAL_MODEL_INVALID_STATE: m.refusalInvalidState,
  LOCAL_MODEL_JOB_RUNNING: m.refusalJobRunning,
  LOCAL_MODEL_MEMORY_INSUFFICIENT: m.refusalMemoryInsufficient,
  LOCAL_MODEL_NO_ROOM: m.refusalNoRoom,
  LOCAL_MODEL_PLATFORM_UNSUPPORTED: m.refusalPlatformUnsupported,
  LOCAL_MODEL_RUNTIME_DEPENDENCY_MISSING: m.refusalRuntimeDependencyMissing,
  LOCAL_MODEL_UNKNOWN: m.refusalModelUnknown,
  LOCAL_MODELS_SERVICE_UNAVAILABLE: m.refusalServiceUnavailable,
  LOCAL_MODELS_UNAVAILABLE: m.refusalToolsUnavailable,
};

/** Why an action or a read failed: a TeamHub error code, or anything else. */
export function actionErrorCopy(code: string | undefined, t: Translate) {
  if (code === "LOCAL_COMPUTER_NOT_FOUND") {
    return t(m.refusalComputerNotFound);
  }
  return t(
    code && Object.hasOwn(actionRefusals, code)
      ? actionRefusals[code as keyof typeof actionRefusals]
      : m.somethingWentWrong,
  );
}

const modelErrors: Record<Schemas["LocalModelErrorCode"], Message<string>> = {
  CANCELLED: m.errorCancelled,
  CHECKSUM_MISMATCH: m.errorChecksumMismatch,
  DISK_INSUFFICIENT: m.errorDiskInsufficient,
  DOWNLOAD_FAILED: m.errorDownloadFailed,
  DRIVER_UPDATE_REQUIRED: m.errorDriverUpdateRequired,
  ENGINE_START_FAILED: m.errorEngineStartFailed,
  GATEWAY_REGISTRATION_FAILED: m.errorGatewayRegistrationFailed,
  GPU_UNSUPPORTED: m.errorGpuUnsupported,
  HEALTH_CHECK_FAILED: m.errorHealthCheckFailed,
  INVALID_STATE: m.errorInvalidState,
  JOB_RUNNING: m.errorJobRunning,
  LOAD_NO_ROOM: m.errorLoadNoRoom,
  MEMORY_INSUFFICIENT: m.errorMemoryInsufficient,
  MODEL_FILES_MISSING: m.errorModelFilesMissing,
  MODEL_UNKNOWN: m.errorModelUnknown,
  NETWORK_UNAVAILABLE: m.errorNetworkUnavailable,
  OUT_OF_MEMORY: m.errorOutOfMemory,
  PLATFORM_UNSUPPORTED: m.refusalPlatformUnsupported,
  RUNTIME_DEPENDENCY_MISSING: m.errorRuntimeDependencyMissing,
  UNKNOWN_ERROR: m.errorUnknownError,
};

const modelErrorCauses = {
  GATEWAY_HOME_NOT_PRIVATE: {
    withPath: m.errorGatewayHomeNotPrivatePath,
    withoutPath: m.errorGatewayHomeNotPrivate,
  },
} satisfies Record<
  NonNullable<Schemas["LocalModelError"]["cause"]>,
  { withPath: Message; withoutPath: Message }
>;

const modelErrorsShort: Record<
  Schemas["LocalModelErrorCode"],
  Message<string> | undefined
> = {
  CANCELLED: m.shortCancelled,
  CHECKSUM_MISMATCH: m.shortChecksumMismatch,
  DISK_INSUFFICIENT: m.shortDiskInsufficient,
  DOWNLOAD_FAILED: undefined,
  DRIVER_UPDATE_REQUIRED: m.shortDriverUpdateRequired,
  ENGINE_START_FAILED: m.shortEngineStartFailed,
  GATEWAY_REGISTRATION_FAILED: m.shortGatewayRegistrationFailed,
  GPU_UNSUPPORTED: m.shortGpuUnsupported,
  HEALTH_CHECK_FAILED: m.shortHealthCheckFailed,
  INVALID_STATE: m.shortBusy,
  JOB_RUNNING: m.shortBusy,
  LOAD_NO_ROOM: m.shortLoadNoRoom,
  MEMORY_INSUFFICIENT: m.shortMemoryInsufficient,
  MODEL_FILES_MISSING: m.shortModelFilesMissing,
  MODEL_UNKNOWN: m.shortModelUnknown,
  NETWORK_UNAVAILABLE: m.shortNetworkUnavailable,
  OUT_OF_MEMORY: m.shortOutOfMemory,
  PLATFORM_UNSUPPORTED: m.shortNotForComputer,
  RUNTIME_DEPENDENCY_MISSING: m.shortRuntimeDependencyMissing,
  UNKNOWN_ERROR: m.shortUnknownError,
};

/** Short failure summary for a collapsed model row; undefined when the status label suffices. */
export function modelErrorShortCopy(
  error: Schemas["LocalModelError"] | undefined,
  t: Translate,
) {
  if (!error) return undefined;
  const message = Object.hasOwn(modelErrorsShort, error.code)
    ? modelErrorsShort[error.code]
    : m.shortUnknownError;
  return message ? t(message) : undefined;
}

/**
 * Why the last load or download of a model failed. A cause names the fix;
 * its path reaches only the Computer's owner.
 */
export function modelErrorCopy(
  error: Schemas["LocalModelError"],
  t: Translate,
) {
  if (error.cause && Object.hasOwn(modelErrorCauses, error.cause)) {
    const cause = modelErrorCauses[error.cause];
    return error.path
      ? t(cause.withPath, { path: error.path })
      : t(cause.withoutPath);
  }
  return t(
    Object.hasOwn(modelErrors, error.code)
      ? modelErrors[error.code]
      : m.errorUnknownError,
  );
}

const notes = {
  NO_ROOM_TO_LOAD: m.noteNoRoomToLoad,
} satisfies Record<Schemas["LocalModelNote"]["code"], Message>;

/** Why a finished download did not load by itself; `place` names its memory. */
export function modelNoteCopy(
  code: Schemas["LocalModelNote"]["code"],
  place: string | undefined,
  t: Translate,
) {
  if (!Object.hasOwn(notes, code)) return t(m.somethingWentWrong);
  return t(notes[code], { place: place ?? t(m.placeMemory) });
}

type AvailabilityReason = Schemas["LocalModelAvailabilityReason"];

/** The short reason on a row that can't be downloaded. */
export function unavailableShortCopy(
  reason: AvailabilityReason | undefined,
  t: Translate,
) {
  if (!reason || reason.code === "PLATFORM_UNSUPPORTED")
    return t(m.shortNotForComputer);
  switch (reason.code) {
    case "GPU_UNSUPPORTED":
      return t(m.shortGpuUnsupported);
    case "DRIVER_UPDATE_REQUIRED":
      return t(m.shortDriverUpdateRequired);
    case "RUNTIME_DEPENDENCY_MISSING":
      return t(m.shortRuntimeDependencyMissing);
    case "UNAVAILABLE":
      return t(m.shortUnavailable);
    case "DISK_INSUFFICIENT":
      return reason.need_bytes === undefined
        ? t(m.shortNeedsDisk)
        : t(m.shortNeedsDiskSize, {
            need: formatGigabytes(reason.need_bytes, t),
          });
    case "MEMORY_INSUFFICIENT":
      if (reason.memory_kind === "ram") {
        return reason.need_bytes === undefined
          ? t(m.shortNeedsSystemMemory)
          : t(m.shortNeedsSystemMemorySize, {
              need: formatGigabytes(reason.need_bytes, t),
            });
      }
      if (reason.memory_kind === "vram") {
        return reason.need_bytes === undefined
          ? t(m.shortNeedsVram)
          : t(m.shortNeedsVramSize, {
              need: formatGigabytes(reason.need_bytes, t),
            });
      }
      return reason.need_bytes === undefined
        ? t(m.shortNeedsMemory)
        : t(m.shortNeedsSize, { need: formatGigabytes(reason.need_bytes, t) });
    default:
      return t(m.shortUnavailable);
  }
}

/** The full reason a model can't be downloaded, shown in its details. */
export function unavailableCopy(
  reason: AvailabilityReason | undefined,
  reclaimable: boolean,
  t: Translate,
  engine?: string,
) {
  const sizes =
    reason?.need_bytes === undefined || reason.have_bytes === undefined
      ? undefined
      : {
          have: formatGigabytes(reason.have_bytes, t),
          need: formatGigabytes(reason.need_bytes, t),
        };
  switch (reason?.code) {
    case "MEMORY_INSUFFICIENT":
      if (reason.memory_kind === "ram") {
        if (sizes)
          return t(
            reclaimable
              ? m.unavailableSystemMemorySizesReclaimable
              : m.unavailableSystemMemorySizes,
            sizes,
          );
        return t(
          reclaimable
            ? m.unavailableSystemMemoryReclaimable
            : m.unavailableSystemMemory,
        );
      }
      if (reason.memory_kind === "vram") {
        if (sizes)
          return t(
            reclaimable
              ? m.unavailableVramSizesReclaimable
              : m.unavailableVramSizes,
            sizes,
          );
        return t(
          reclaimable ? m.unavailableVramReclaimable : m.unavailableVram,
        );
      }
      if (sizes)
        return t(
          reclaimable
            ? m.unavailableMemorySizesReclaimable
            : m.unavailableMemorySizes,
          sizes,
        );
      return t(
        reclaimable ? m.unavailableMemoryReclaimable : m.unavailableMemory,
      );
    case "DISK_INSUFFICIENT":
      return sizes ? t(m.unavailableDiskSizes, sizes) : t(m.unavailableDisk);
    case "GPU_UNSUPPORTED":
      if (reason.gpu_vendor === "amd") return t(m.unavailableGpuAmd);
      if (reason.gpu_vendor === "intel") return t(m.unavailableGpuIntel);
      return t(m.unavailableGpuNone);
    case "DRIVER_UPDATE_REQUIRED": {
      const driver = minNvidiaDriverForCuda(reason.required_cuda);
      if (engine) {
        if (reason.detected_cuda && reason.required_cuda) {
          if (driver) {
            return t(m.unavailableDriverEngineVersionsDriver, {
              detected: reason.detected_cuda,
              driver,
              engine,
              required: reason.required_cuda,
            });
          }
          return t(m.unavailableDriverEngineVersions, {
            detected: reason.detected_cuda,
            engine,
            required: reason.required_cuda,
          });
        }
        if (reason.required_cuda) {
          if (driver) {
            return t(m.unavailableDriverEngineRequiredDriver, {
              driver,
              engine,
              required: reason.required_cuda,
            });
          }
          return t(m.unavailableDriverEngineRequiredOnly, {
            engine,
            required: reason.required_cuda,
          });
        }
      }
      if (reason.detected_cuda && reason.required_cuda) {
        if (driver) {
          return t(m.unavailableDriverUpdateVersionsDriver, {
            detected: reason.detected_cuda,
            driver,
            required: reason.required_cuda,
          });
        }
        return t(m.unavailableDriverUpdateVersions, {
          detected: reason.detected_cuda,
          required: reason.required_cuda,
        });
      }
      if (reason.required_cuda) {
        return t(m.unavailableDriverUpdateRequiredOnly, {
          required: reason.required_cuda,
        });
      }
      return t(m.unavailableDriverUpdateUnknown);
    }
    case "RUNTIME_DEPENDENCY_MISSING":
      if (reason.missing_libraries?.length) {
        return t(m.unavailableMissingLibraries, {
          libraries: joinList(reason.missing_libraries, t),
        });
      }
      if (reason.detected_glibc && reason.required_glibc) {
        return t(m.unavailableGlibcVersions, {
          detected: reason.detected_glibc,
          required: reason.required_glibc,
        });
      }
      return t(m.unavailableRuntimeDependency);
    case "UNAVAILABLE":
      return t(m.unavailableGeneric);
    case "PLATFORM_UNSUPPORTED":
    case undefined:
      return t(m.refusalPlatformUnsupported);
    default:
      return t(m.unavailableGeneric);
  }
}

/** Banner explaining a host-wide requirement blocking local model downloads. */
export function hostBlockerCopy(blocker: HostBlockerReason, t: Translate) {
  switch (blocker.code) {
    case "GPU_UNSUPPORTED":
      return {
        body: t(
          blocker.gpu_vendor === "amd"
            ? m.hostBlockerGpuAmdBody
            : blocker.gpu_vendor === "intel"
              ? m.hostBlockerGpuIntelBody
              : m.hostBlockerGpuNoneBody,
        ),
        title: t(m.hostBlockerGpuTitle),
      };
    case "DRIVER_UPDATE_REQUIRED":
      return {
        body:
          blocker.detected_cuda && blocker.required_cuda
            ? t(m.hostBlockerDriverBody, {
                detected: blocker.detected_cuda,
                required: blocker.required_cuda,
              })
            : blocker.required_cuda
              ? t(m.hostBlockerDriverRequiredOnlyBody, {
                  required: blocker.required_cuda,
                })
              : t(m.hostBlockerDriverUnknownBody),
        title: t(m.hostBlockerDriverTitle),
      };
    case "RUNTIME_DEPENDENCY_MISSING":
      return {
        body: blocker.missing_libraries?.length
          ? t(m.hostBlockerRuntimeLibrariesBody, {
              libraries: joinList(blocker.missing_libraries, t),
            })
          : blocker.detected_glibc && blocker.required_glibc
            ? t(m.hostBlockerRuntimeGlibcBody, {
                detected: blocker.detected_glibc,
                required: blocker.required_glibc,
              })
            : t(m.hostBlockerRuntimeGenericBody),
        title: t(m.hostBlockerRuntimeTitle),
      };
  }
}

/** Warning banner explaining that localmodels debug mode is overriding the catalog. */
export function debugBannerCopy(
  debug: Schemas["LocalModelsDebugInfo"],
  t: Translate,
) {
  const title = t(
    debug.mode === "simulate"
      ? m.debugBannerSimulateTitle
      : m.debugBannerTinyTitle,
  );
  if (debug.source === "env") {
    return { body: t(m.debugBannerEnvBody), title };
  }
  return {
    body: debug.config_path
      ? t(m.debugBannerConfigBody, { path: debug.config_path })
      : t(m.debugBannerConfigBodyHidden),
    title,
  };
}

const libraryUnavailable = {
  NOT_REPORTED: {
    body: m.libraryNotReportedBody,
    title: m.libraryNotReportedTitle,
  },
  TOOL_FAILED: {
    body: m.libraryToolFailedBody,
    title: m.libraryToolFailedTitle,
  },
  TOOL_NOT_INSTALLED: {
    body: m.libraryToolNotInstalledBody,
    title: m.libraryToolNotInstalledTitle,
  },
} satisfies Record<
  Schemas["LocalModelsViewUnavailableReason"]["code"],
  { body: Message<string>; title: Message }
>;

/** Why a Computer reports no model library. */
export function libraryUnavailableCopy(
  code: Schemas["LocalModelsViewUnavailableReason"]["code"] | undefined,
  computer: string,
  t: Translate,
) {
  const copy =
    code && Object.hasOwn(libraryUnavailable, code)
      ? libraryUnavailable[code]
      : libraryUnavailable.NOT_REPORTED;
  return { body: t(copy.body), title: t(copy.title, { computer }) };
}

const capabilityLabels: Record<
  Schemas["LocalModelCapability"],
  Message<string>
> = {
  coding: m.capabilityCoding,
  multilingual: m.capabilityMultilingual,
  reasoning: m.capabilityReasoning,
  tool_use: m.capabilityToolUse,
  vision: m.capabilityVision,
};

/** Human-readable badge label for a verified model capability. */
export function capabilityCopy(
  capability: Schemas["LocalModelCapability"],
  t: Translate,
) {
  return Object.hasOwn(capabilityLabels, capability)
    ? t(capabilityLabels[capability])
    : capability;
}

const architectureLabels: Record<
  Schemas["LocalModelArchitecture"],
  Message<string>
> = {
  dense: m.architectureDense,
  moe: m.architectureMoe,
};

/** Human-readable architecture label for display in model details. */
export function architectureCopy(
  architecture: Schemas["LocalModelArchitecture"],
  t: Translate,
) {
  return Object.hasOwn(architectureLabels, architecture)
    ? t(architectureLabels[architecture])
    : architecture;
}

/** Inference engine names read the same in every language. */
const engineBadgeLabels: Record<Schemas["LocalModelEngine"], string> = {
  "llama.cpp": "llama.cpp",
  polystrata: "PolyStrata",
  strata: "Strata",
};

/** Compact engine pill label from the structured `engine` field. */
export function engineBadgeCopy(
  engine: Schemas["LocalModelEngine"] | undefined,
): string | undefined {
  if (!engine) return undefined;
  return Object.hasOwn(engineBadgeLabels, engine)
    ? engineBadgeLabels[engine]
    : undefined;
}

/** Concise explanation of how this inference engine uses memory, for details. */
export function engineHintCopy(
  engine: Schemas["LocalModelEngine"] | undefined,
  fit: Schemas["LocalModelFit"],
  t: Translate,
): string | undefined {
  switch (engine) {
    case "polystrata":
      return t(m.engineHintPolystrata);
    case "strata":
      return t(m.engineHintStrata);
    case "llama.cpp":
      if (fit === "gpu") return t(m.engineHintLlamaCpp);
      if (fit === "unified") return t(m.engineHintLlamaCppUnified);
      if (fit === "system") return t(m.engineHintLlamaCppSystem);
      return undefined;
    default:
      return undefined;
  }
}

/** Human-readable concurrency slot summary from the structured `concurrency` field. */
export function concurrencyCopy(
  concurrency: number | undefined,
  t: Translate,
): string | undefined {
  if (concurrency === undefined || concurrency < 1) return undefined;
  return concurrency === 1
    ? t(m.concurrencySingle)
    : t(m.concurrencyMultiple, { count: concurrency });
}

const modelSourceRefusals: Record<
  Schemas["ModelSourceErrorCode"],
  Message<string>
> = {
  AGENT_HAS_ACTIVE_RUNS: m.sourceAgentsWorking,
  BYOK_AUTH_FAILED: m.sourceByokAuthFailed,
  BYOK_GATEWAY_FAILED: m.sourceByokGatewayFailed,
  BYOK_INVALID_CONFIG: m.sourceByokInvalidConfig,
  BYOK_NOT_FOUND: m.sourceByokNotFound,
  BYOK_UNREACHABLE: m.sourceByokUnreachable,
  BYOK_UPSTREAM_REJECTED: m.sourceByokUpstreamRejected,
  LOCAL_COMPUTER_OFFLINE: m.refusalOffline,
  LOCAL_MODEL_NO_ROOM: m.sourceNoRoom,
  LOCAL_MODEL_UNKNOWN: m.refusalModelUnknown,
  MODEL_SOURCE_FAILED: m.sourceSwitchFailed,
  MODEL_SOURCE_FORBIDDEN: m.sourceForbidden,
  MODEL_SOURCE_SERVICE_UNAVAILABLE: m.refusalServiceUnavailable,
  MODEL_SOURCE_UNAVAILABLE: m.sourceUnavailable,
  MODEL_SOURCE_UNCONFIRMED: m.sourceUnconfirmed,
  RUNTIME_NOT_ENABLED: m.sourceRuntimeNotEnabled,
};

/** Why a model-source switch or endpoint test failed. */
export function modelSourceErrorCopy(code: string | undefined, t: Translate) {
  return t(
    code && Object.hasOwn(modelSourceRefusals, code)
      ? modelSourceRefusals[code as keyof typeof modelSourceRefusals]
      : m.somethingWentWrong,
  );
}

// For these the Computer's own message names the address it sent to and the
// endpoint's HTTP status, so it is shown as it is.
const byokEndpointRefusals = new Set([
  "BYOK_AUTH_FAILED",
  "BYOK_NOT_FOUND",
  "BYOK_UNREACHABLE",
  "BYOK_UPSTREAM_REJECTED",
]);

/** Structured failure returned by TeamHub's model-source endpoints. */
export interface ModelSourceFailure {
  code?: string;
  details?: readonly { field: string; reason: string }[];
  message?: string;
}

/**
 * Why a model-source switch failed, preserving owner-visible Computer detail
 * when the contract provides it.
 */
export function modelSourceFailureCopy(
  error: ModelSourceFailure | undefined,
  t: Translate,
) {
  if (error?.code === "BYOK_GATEWAY_FAILED") {
    const detail = error.details
      ?.find((entry) => entry.field === "gateway")
      ?.reason.trim();
    return detail
      ? t(m.sourceByokGatewayFailedDetail, { detail })
      : t(m.sourceByokGatewayFailed);
  }
  if (error?.code === "MODEL_SOURCE_UNCONFIRMED") {
    return modelSourceErrorCopy(error.code, t);
  }
  return byokFailureCopy(error?.code, error?.message ?? "", t);
}

/** Why a request to a BYOK endpoint (a test or a model listing) failed. */
export function byokFailureCopy(
  code: string | undefined,
  message: string,
  t: Translate,
) {
  if (code === "MODEL_SOURCE_UNCONFIRMED") {
    return t(m.sourceByokProbeUnconfirmed);
  }
  return code && byokEndpointRefusals.has(code) && message
    ? message
    : modelSourceErrorCopy(code, t);
}

/** Why reading a Computer's model source failed. */
export function modelSourceReadErrorCopy(
  code: string | undefined,
  t: Translate,
) {
  if (code === "MODEL_SOURCE_SERVICE_UNAVAILABLE") {
    return t(modelSourceRefusals.MODEL_SOURCE_SERVICE_UNAVAILABLE);
  }
  if (code === "MODEL_SOURCE_UNCONFIRMED") {
    return t(m.sourceReadUnconfirmed);
  }
  return t(m.sourceReadFailed);
}

export const modelSourceModeLabels: Record<
  Schemas["ModelSourceMode"],
  Message<string>
> = {
  byok: m.modeByok,
  local: m.modeLocal,
  subscription: m.modeSubscription,
};

/** Product and protocol names read the same in every language. */
export const modelSourceRuntimeLabels: Record<
  Schemas["ModelSourceRuntime"],
  string
> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

export const byokProtocolLabels: Record<Schemas["ByokProtocol"], string> = {
  anthropic: "Anthropic Messages",
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

const memoryGuidanceMessages = {
  blocked_download: {
    body: m.guidanceBlockedDownloadBody,
    bodyGpu: m.guidanceBlockedDownloadBodyGpu,
    title: m.guidanceBlockedDownloadTitle,
    titleGpu: m.guidanceBlockedDownloadTitleGpu,
  },
  blocked_load: {
    body: m.guidanceBlockedLoadBody,
    bodyGpu: m.guidanceBlockedLoadBodyGpu,
    title: m.guidanceBlockedLoadTitle,
    titleGpu: m.guidanceBlockedLoadTitleGpu,
  },
  constrained_pool: {
    body: m.guidanceConstrainedBody,
    bodyGpu: m.guidanceConstrainedBodyGpu,
    title: m.guidanceConstrainedTitle,
    titleGpu: m.guidanceConstrainedTitleGpu,
  },
} satisfies Record<
  MemoryGuidance["kind"],
  Record<"body" | "bodyGpu", Message> &
    Record<"title" | "titleGpu", Message<string>>
>;

/** Guidance telling the owner how freeing external memory unlocks larger models. */
export function memoryGuidanceCopy(guidance: MemoryGuidance, t: Translate) {
  const copy = memoryGuidanceMessages[guidance.kind];
  return {
    body: t(guidance.gpu ? copy.bodyGpu : copy.body, {
      free: formatGigabytes(guidance.freeBytes, t),
      other: formatGigabytes(guidance.otherBytes, t),
      total: formatGigabytes(guidance.totalBytes, t),
    }),
    title: t(guidance.gpu ? copy.titleGpu : copy.title),
  };
}
