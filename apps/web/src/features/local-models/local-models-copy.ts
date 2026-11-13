import type { components } from "@linger/wire-contracts/teamhub-public/types";

import { formatBytes } from "@/lib/format-bytes";

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
    "There isn't enough free memory to load it. Unload another model first.",
  LOCAL_MODEL_PLATFORM_UNSUPPORTED: "This model doesn't run on this computer.",
  LOCAL_MODEL_UNKNOWN: "The computer doesn't have this model anymore.",
  LOCAL_MODELS_SERVICE_UNAVAILABLE:
    "Linger couldn't reach the computer right now. Try again.",
  LOCAL_MODELS_UNAVAILABLE:
    "The local model tools on this computer aren't working.",
};

/** Why an action or a read failed: a TeamHub error code, or anything else. */
export function actionErrorCopy(code: string | undefined) {
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

/** Why the last load of a model failed. */
export function modelErrorCopy(code: Schemas["LocalModelErrorCode"]) {
  return modelErrors[code];
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
    reason.need_bytes === undefined ? "" : formatBytes(reason.need_bytes);
  if (!need)
    return reason.code === "DISK_INSUFFICIENT"
      ? "needs more disk"
      : "needs more memory";
  return reason.code === "DISK_INSUFFICIENT"
    ? `needs ${need} of disk`
    : `needs ${need}`;
}

/** The full reason a model can't be downloaded, shown in its details. */
export function unavailableCopy(reason: AvailabilityReason | undefined) {
  const need =
    reason?.need_bytes === undefined
      ? undefined
      : formatBytes(reason.need_bytes);
  const have =
    reason?.have_bytes === undefined
      ? undefined
      : formatBytes(reason.have_bytes);
  switch (reason?.code) {
    case "MEMORY_INSUFFICIENT":
      return need && have
        ? `Needs ${need} of memory; this computer has ${have} for models.`
        : "This computer doesn't have enough memory for it.";
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
