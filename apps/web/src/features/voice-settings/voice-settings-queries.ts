import { type QueryClient, queryOptions } from "@tanstack/react-query";

import { publishVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubLocalComputerPage,
  TeamHubLocalSpeechActionRequest,
  TeamHubUpdateVoiceSettingsRequest,
  TeamHubVoiceSettings,
} from "@/features/teamhub/teamhub-types";

const voiceSettingsPath = "/v0/tenants/{tenantId}/voice-settings";
const localSpeechPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-speech";
const localSpeechActionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-speech/actions";

export const DEFAULT_VOICE_SETTINGS: TeamHubVoiceSettings = {
  keep_loaded_seconds: 900,
  language: "auto",
  silence_timeout_seconds: 0,
  speech_provider: "auto",
  use_gpu: true,
};

export type SpeechInventoryComputer = TeamHubLocalComputerPage["items"][number];

export interface ResolveSpeechComputerInput {
  computers: readonly SpeechInventoryComputer[];
  configuredComputerId?: string | null;
  desktopComputerId?: string | null;
  selectedComputerId?: string | null;
}

/**
 * Picks the target Computer for local speech using consistent online-preferred
 * rules across Settings → Voice and the voice quick-setup dialog:
 * 1. Explicit picker selection (when present in inventory)
 * 2. Online Computer: configured -> desktop -> first online
 * 3. Offline fallback (configured -> desktop -> first) only when none are online
 */
export function resolveSpeechComputer({
  computers,
  configuredComputerId,
  desktopComputerId,
  selectedComputerId,
}: ResolveSpeechComputerInput): SpeechInventoryComputer | undefined {
  if (selectedComputerId) {
    const selected = computers.find(
      (item) => item.computer_id === selectedComputerId,
    );
    if (selected) return selected;
  }
  const online = computers.filter((item) => item.status === "online");
  if (online.length > 0) {
    if (configuredComputerId) {
      const configured = online.find(
        (item) => item.computer_id === configuredComputerId,
      );
      if (configured) return configured;
    }
    if (desktopComputerId) {
      const desktop = online.find(
        (item) => item.computer_id === desktopComputerId,
      );
      if (desktop) return desktop;
    }
    return online[0];
  }
  if (configuredComputerId) {
    const configured = computers.find(
      (item) => item.computer_id === configuredComputerId,
    );
    if (configured) return configured;
  }
  if (desktopComputerId) {
    const desktop = computers.find(
      (item) => item.computer_id === desktopComputerId,
    );
    if (desktop) return desktop;
  }
  return computers[0];
}

export function voiceSettingsQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "voice-settings"] as const;
}

export function tenantLocalSpeechQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "local-speech"] as const;
}

export function localSpeechQueryKey(tenantId: string, computerId: string) {
  return [...tenantLocalSpeechQueryKey(tenantId), computerId] as const;
}

export function localSpeechActionMutationKey(
  tenantId: string,
  computerId: string,
) {
  return ["teamhub", tenantId, "local-speech-action", computerId] as const;
}

export function voiceSettingsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(voiceSettingsPath, {
          params: { path: { tenantId } },
          signal,
        }),
      ),
    queryKey: voiceSettingsQueryKey(tenantId),
    refetchOnWindowFocus: true,
    retry: false,
    staleTime: 30_000,
  });
}

export function updateVoiceSettings(
  client: TeamHubClient,
  tenantId: string,
  body: TeamHubUpdateVoiceSettingsRequest,
) {
  return teamHubData(
    client.api.PUT(voiceSettingsPath, {
      body,
      params: { path: { tenantId } },
    }),
  );
}

export function localSpeechQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(localSpeechPath, {
          params: { path: { computerId, tenantId } },
          signal,
        }),
      ),
    queryKey: localSpeechQueryKey(tenantId, computerId),
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
    retry: false,
  });
}

export function refreshLocalComputerSpeech(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return teamHubData(
    client.api.POST(localSpeechPath, {
      params: { path: { computerId, tenantId } },
    }),
  );
}

export function actOnLocalComputerSpeech(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  body: TeamHubLocalSpeechActionRequest,
) {
  return teamHubData(
    client.api.POST(localSpeechActionPath, {
      body,
      params: { path: { computerId, tenantId } },
    }),
  );
}

/**
 * Forwards persisted voice settings to an online Computer's local speech
 * runtime. Transport errors are ignored because the Computer reconciles from
 * TeamHub settings on reconnect.
 */
export async function configureLocalComputerSpeech(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  settings: TeamHubVoiceSettings,
  modelId?: string,
) {
  const resolvedModelId = modelId ?? settings.local_model_id;
  await actOnLocalComputerSpeech(client, tenantId, computerId, {
    action: "configure",
    keep_loaded_seconds: settings.keep_loaded_seconds,
    language: settings.language,
    ...(resolvedModelId ? { model_id: resolvedModelId } : {}),
    use_gpu: settings.use_gpu,
  }).catch(() => undefined);
}

/**
 * Persists a local speech model as active, forwards the runtime configure
 * action to the target Computer, updates the shared React Query settings cache,
 * and refreshes the workspace VoiceMediaPolicy.
 */
export async function activateLocalSpeechModel(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  modelId: string,
  queryClient?: QueryClient,
) {
  const settings = await updateVoiceSettings(client, tenantId, {
    local_computer_id: computerId,
    local_model_id: modelId,
    speech_provider: "local",
  });
  queryClient?.setQueryData(voiceSettingsQueryKey(tenantId), settings);
  await configureLocalComputerSpeech(
    client,
    tenantId,
    computerId,
    settings,
    modelId,
  );
  const policy = await refreshVoiceMediaPolicy(client, tenantId);
  return { policy, settings };
}

/**
 * Reads the latest VoiceMediaPolicy and broadcasts it to every in-tab
 * subscriber so Voice Mode, Pocket Notes, and Meeting Recording reflect
 * local/cloud speech changes immediately.
 */
export async function refreshVoiceMediaPolicy(
  client: TeamHubClient,
  tenantId: string,
) {
  const policy = await teamHubData(
    client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
      params: { path: { tenantId } },
    }),
  ).catch(() => undefined);
  if (policy) publishVoiceMediaPolicy(tenantId, policy);
  return policy;
}
