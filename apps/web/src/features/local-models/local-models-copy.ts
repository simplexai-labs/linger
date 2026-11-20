import type { components } from "@linger/wire-contracts/teamhub-public/types";

import { formatGigabytes, type MemoryGuidance } from "./local-models-rules";

type Schemas = components["schemas"];

/**
 * Every code the Local models page shows, as English copy. The page branches
 * on codes only; diagnostic `detail` text from the Computer is never shown.
 * Typing each map by its generated code set makes a new code a type error
 * here until it has copy.
 */

const actionRefusals: Record<Schemas["LocalModelsErrorCode"], string> = {
  LOCAL_COMPUTER_OFFLINE:
    "The computer is offline. Reconnect it in Computers, then try again.",
  LOCAL_MODEL_ACTION_FAILED: "The computer couldn't start this. Try again.",
  LOCAL_MODEL_ACTION_UNCONFIRMED:
    "The computer didn't confirm in time. Its models below show what it's doing.",
  LOCAL_MODEL_ACTION_FORBIDDEN:
    "Only the person who connected this computer can manage its models.",
  LOCAL_MODEL_DISK_INSUFFICIENT:
    "There isn't enough free disk on the computer for this model.",
  LOCAL_MODEL_INVALID_STATE:
    "The model changed on the computer. Check its status and try again.",
  LOCAL_MODEL_JOB_RUNNING:
    "The computer is still working on this model. Wait for it to finish.",
  LOCAL_MODEL_MEMORY_INSUFFICIENT:
    "The computer doesn't have enough memory for this model.",
  LOCAL_MODEL_NO_ROOM:
    "There isn't enough free memory to load it. Close memory-heavy apps or unload another model, then recheck memory.",
  LOCAL_MODEL_PLATFORM_UNSUPPORTED: "This model doesn't run on this computer.",
  LOCAL_MODEL_UNKNOWN: "The computer doesn't have this model anymore.",
  LOCAL_MODELS_SERVICE_UNAVAILABLE:
    "Linger couldn't reach the computer right now. Try again.",
  LOCAL_MODELS_UNAVAILABLE:
    "The local model tools on this computer aren't working.",
};

/** Why an action or a read failed: a TeamHub error code, or anything else. */
export function actionErrorCopy(code: string | undefined) {
  if (code === "LOCAL_COMPUTER_NOT_FOUND") {
    return "This computer wasn't found. It may have been removed.";
  }
  return code && Object.hasOwn(actionRefusals, code)
    ? actionRefusals[code as keyof typeof actionRefusals]
    : "Something went wrong. Try again.";
}

const modelErrors: Record<Schemas["LocalModelErrorCode"], string> = {
  CANCELLED: "Loading was stopped.",
  CHECKSUM_MISMATCH:
    "The downloaded files were damaged. Remove the model and download it again.",
  DISK_INSUFFICIENT: "There wasn't enough free disk.",
  DOWNLOAD_FAILED: "The download didn't finish.",
  ENGINE_START_FAILED: "The model engine didn't start.",
  GATEWAY_REGISTRATION_FAILED:
    "It loaded, but Agents couldn't be given access to it.",
  HEALTH_CHECK_FAILED: "The model started but didn't answer.",
  INVALID_STATE: "The model was busy with another step.",
  JOB_RUNNING: "Another step was still running.",
  LOAD_NO_ROOM: "There wasn't enough free memory to load it.",
  MEMORY_INSUFFICIENT: "The computer doesn't have enough memory for it.",
  MODEL_FILES_MISSING:
    "Its files are missing. Remove the model and download it again.",
  MODEL_UNKNOWN: "The computer doesn't know this model anymore.",
  NETWORK_UNAVAILABLE: "The computer couldn't reach the network.",
  OUT_OF_MEMORY: "It ran out of memory while loading.",
  PLATFORM_UNSUPPORTED: "This model doesn't run on this computer.",
};

const modelErrorCauses: Record<
  NonNullable<Schemas["LocalModelError"]["cause"]>,
  (path: string | undefined) => string
> = {
  GATEWAY_HOME_NOT_PRIVATE: (path) =>
    path
      ? `It loaded, but Agents couldn't be given access to it: the folder ${path} belongs to another account. Quit Linger, rename that folder, then open Linger and load the model again.`
      : "It loaded, but Agents couldn't be given access to it: a Linger folder on the computer belongs to another account.",
};

const modelErrorsShort: Record<
  Schemas["LocalModelErrorCode"],
  string | undefined
> = {
  CANCELLED: "loading stopped",
  CHECKSUM_MISMATCH: "files damaged",
  DISK_INSUFFICIENT: "not enough disk",
  DOWNLOAD_FAILED: undefined,
  ENGINE_START_FAILED: "engine didn't start",
  GATEWAY_REGISTRATION_FAILED: "Agents couldn't reach it",
  HEALTH_CHECK_FAILED: "model didn't answer",
  INVALID_STATE: "busy with another step",
  JOB_RUNNING: "busy with another step",
  LOAD_NO_ROOM: "not enough free memory",
  MEMORY_INSUFFICIENT: "not enough memory",
  MODEL_FILES_MISSING: "files missing",
  MODEL_UNKNOWN: "no longer on computer",
  NETWORK_UNAVAILABLE: "network unavailable",
  OUT_OF_MEMORY: "ran out of memory",
  PLATFORM_UNSUPPORTED: "not for this computer",
};

/** Short failure summary for a collapsed model row; undefined when the status label suffices. */
export function modelErrorShortCopy(
  error: Schemas["LocalModelError"] | undefined,
) {
  return error ? modelErrorsShort[error.code] : undefined;
}

/**
 * Why the last load or download of a model failed. A cause names the fix;
 * its path reaches only the Computer's owner.
 */
export function modelErrorCopy(error: Schemas["LocalModelError"]) {
  return error.cause
    ? modelErrorCauses[error.cause](error.path)
    : modelErrors[error.code];
}

const notes: Record<
  Schemas["LocalModelNote"]["code"],
  (place: string) => string
> = {
  NO_ROOM_TO_LOAD: (place) =>
    `It downloaded, but there wasn't enough free ${place} to load it. Load it when there is room.`,
};

/** Why a finished download did not load by itself; `place` names its memory. */
export function modelNoteCopy(
  code: Schemas["LocalModelNote"]["code"],
  place = "memory",
) {
  return notes[code](place);
}

type AvailabilityReason = Schemas["LocalModelAvailabilityReason"];

/** The short reason on a row that can't be downloaded. */
export function unavailableShortCopy(reason: AvailabilityReason | undefined) {
  if (reason?.code === "PLATFORM_UNSUPPORTED" || !reason)
    return "not for this computer";
  const need =
    reason.need_bytes === undefined ? "" : formatGigabytes(reason.need_bytes);
  if (!need)
    return reason.code === "DISK_INSUFFICIENT"
      ? "needs more disk"
      : "needs more memory";
  return reason.code === "DISK_INSUFFICIENT"
    ? `needs ${need} of disk`
    : `needs ${need}`;
}

/** The full reason a model can't be downloaded, shown in its details. */
export function unavailableCopy(
  reason: AvailabilityReason | undefined,
  reclaimable = false,
) {
  const need =
    reason?.need_bytes === undefined
      ? undefined
      : formatGigabytes(reason.need_bytes);
  const have =
    reason?.have_bytes === undefined
      ? undefined
      : formatGigabytes(reason.have_bytes);
  switch (reason?.code) {
    case "MEMORY_INSUFFICIENT": {
      const base =
        need && have
          ? `Needs ${need} of memory; this computer has ${have} for models.`
          : "This computer doesn't have enough memory for it.";
      return reclaimable
        ? `${base} Close memory-heavy apps and recheck memory.`
        : base;
    }
    case "DISK_INSUFFICIENT":
      return need && have
        ? `Needs ${need} of disk; ${have} is free.`
        : "There isn't enough free disk for it.";
    default:
      return "This model doesn't run on this computer.";
  }
}

const libraryUnavailable: Record<
  Schemas["LocalModelsViewUnavailableReason"]["code"],
  { body: string; title: (computer: string) => string }
> = {
  NOT_REPORTED: {
    body: "It reports them once it connects with an up-to-date Linger app.",
    title: (computer) => `${computer} hasn't reported local models yet`,
  },
  TOOL_FAILED: {
    body: "The local model tools on this computer didn't answer. Check that they're installed and working, then open this page again.",
    title: (computer) => `Couldn't read the local models on ${computer}`,
  },
  TOOL_NOT_INSTALLED: {
    body: "Run Quick Install in the Linger desktop app on that computer to add them.",
    title: (computer) => `Local models aren't set up on ${computer}`,
  },
};

/** Why a Computer reports no model library. */
export function libraryUnavailableCopy(
  code: Schemas["LocalModelsViewUnavailableReason"]["code"] | undefined,
  computer: string,
) {
  const copy = libraryUnavailable[code ?? "NOT_REPORTED"];
  return { body: copy.body, title: copy.title(computer) };
}

const capabilityLabels: Record<Schemas["LocalModelCapability"], string> = {
  coding: "Coding",
  multilingual: "Multilingual",
  reasoning: "Reasoning",
  tool_use: "Tool use",
  vision: "Vision",
};

/** Human-readable badge label for a verified model capability. */
export function capabilityCopy(capability: Schemas["LocalModelCapability"]) {
  return capabilityLabels[capability];
}

const architectureLabels: Record<Schemas["LocalModelArchitecture"], string> = {
  dense: "Dense",
  moe: "MoE",
};

/** Human-readable architecture label for display in model details. */
export function architectureCopy(
  architecture: Schemas["LocalModelArchitecture"],
) {
  return architectureLabels[architecture];
}

const pressureLabels: Record<Schemas["LocalModelMemoryPressure"], string> = {
  critical: "Critical",
  normal: "Normal",
  warn: "Warning",
};

/** Human-readable macOS memory pressure label. */
export function memoryPressureCopy(
  pressure: Schemas["LocalModelMemoryPressure"],
) {
  return pressureLabels[pressure];
}

const modelSourceRefusals: Record<Schemas["ModelSourceErrorCode"], string> = {
  AGENT_HAS_ACTIVE_RUNS: "Agents on this computer are working on tasks.",
  BYOK_AUTH_FAILED: "The endpoint rejected the API key.",
  BYOK_INVALID_CONFIG:
    "The computer can't use this endpoint. An HTTPS endpoint needs an API key; plain HTTP works only on this computer or your local network.",
  BYOK_NOT_FOUND:
    "Nothing answered at the endpoint's address, or it doesn't serve this model ID.",
  BYOK_UNREACHABLE: "The computer couldn't reach the endpoint.",
  BYOK_UPSTREAM_REJECTED: "The endpoint rejected the test request.",
  LOCAL_COMPUTER_OFFLINE:
    "The computer is offline. Reconnect it in Computers, then try again.",
  LOCAL_MODEL_NO_ROOM:
    "There isn't enough free memory on the computer to load that model. Close memory-heavy apps or unload another model, recheck memory, and try again.",
  LOCAL_MODEL_UNKNOWN: "The computer doesn't have this model anymore.",
  MODEL_SOURCE_FAILED: "The computer couldn't switch. Try again.",
  MODEL_SOURCE_FORBIDDEN:
    "Only the person who connected this computer can change its models.",
  MODEL_SOURCE_SERVICE_UNAVAILABLE:
    "Linger couldn't reach the computer right now. Try again.",
  MODEL_SOURCE_UNAVAILABLE:
    "This computer can't switch models. Update Linger on it, then try again.",
  MODEL_SOURCE_UNCONFIRMED:
    "The computer didn't answer in time. It may still be switching; check again in a minute.",
  RUNTIME_NOT_ENABLED: "This AI runtime isn't set up on the computer.",
};

/** Why a model-source switch or endpoint test failed. */
export function modelSourceErrorCopy(code: string | undefined) {
  return code && Object.hasOwn(modelSourceRefusals, code)
    ? modelSourceRefusals[code as keyof typeof modelSourceRefusals]
    : "Something went wrong. Try again.";
}

// For these the Computer's own message names the address it sent to and the
// endpoint's HTTP status, so it is shown as it is.
const byokEndpointRefusals = new Set([
  "BYOK_AUTH_FAILED",
  "BYOK_NOT_FOUND",
  "BYOK_UNREACHABLE",
  "BYOK_UPSTREAM_REJECTED",
]);

/** Why a request to a BYOK endpoint (a test or a model listing) failed. */
export function byokFailureCopy(code: string | undefined, message: string) {
  return code && byokEndpointRefusals.has(code) && message
    ? message
    : modelSourceErrorCopy(code);
}

/** Why reading a Computer's model source failed. */
export function modelSourceReadErrorCopy(code: string | undefined) {
  if (code === "MODEL_SOURCE_SERVICE_UNAVAILABLE") {
    return modelSourceRefusals.MODEL_SOURCE_SERVICE_UNAVAILABLE;
  }
  if (code === "MODEL_SOURCE_UNCONFIRMED") {
    return "The computer didn't answer in time. Try again.";
  }
  return "Couldn't read how Agents on this computer get their model. Try again.";
}

export const modelSourceModeLabels: Record<Schemas["ModelSourceMode"], string> =
  { byok: "BYOK", local: "Local model", subscription: "Subscription" };

export const modelSourceRuntimeLabels: Record<
  Schemas["ModelSourceRuntime"],
  string
> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };

export const byokProtocolLabels: Record<Schemas["ByokProtocol"], string> = {
  anthropic: "Anthropic Messages",
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
};

/** Guidance telling the owner how freeing external memory unlocks larger models. */
export function memoryGuidanceCopy(guidance: MemoryGuidance) {
  const memoryKind = guidance.gpu ? "GPU memory" : "memory";
  const other = formatGigabytes(guidance.otherBytes);
  const free = formatGigabytes(guidance.freeBytes);
  const total = formatGigabytes(guidance.totalBytes);
  switch (guidance.kind) {
    case "blocked_load":
      return {
        body: `Other apps are holding ${other} of ${memoryKind} (${free} of ${total} free). Forcing a model into tight memory can freeze the computer. Close video players, games, browsers, or other memory-heavy apps, then click Recheck memory to load it.`,
        title: `Free ${memoryKind} before loading`,
      };
    case "blocked_download":
      return {
        body: `Other apps are holding ${other} of ${memoryKind} (${free} of ${total} free), so larger models look unavailable right now. Close unnecessary apps (such as video players, games, or browsers) and click Recheck memory to detect all free memory before installing.`,
        title: `Free ${memoryKind} to install a larger model`,
      };
    case "constrained_pool":
      return {
        body: `Other apps are using ${other} of ${memoryKind} (${free} of ${total} free). To avoid loading failures or system freezes, close unnecessary apps and click Recheck memory so you can load a better model.`,
        title: `Other apps are using ${memoryKind}`,
      };
  }
}
