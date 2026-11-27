import {
  Download04Icon,
  LinkSquare02Icon,
  Mic01Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ProviderKeyLink,
  useProviderKeyForm,
} from "@/features/apps/provider-key-form";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalSpeechModel,
  TeamHubVoiceMediaPolicy,
  TeamHubVoiceProvider,
  TeamHubVoiceProviderKeyStatus,
} from "@/features/teamhub/teamhub-types";
import { voiceSettingsMessages as vs } from "@/features/voice-settings/voice-settings.messages";
import {
  activateLocalSpeechModel,
  actOnLocalComputerSpeech,
  DEFAULT_VOICE_SETTINGS,
  localSpeechQueryKey,
  localSpeechQueryOptions,
  resolveSpeechComputer,
  voiceSettingsQueryOptions,
} from "@/features/voice-settings/voice-settings-queries";
import {
  formatLicenseDisplayName,
  formatSpeechDownloadPercent,
  formatSpeechDownloadStats,
  formatSpeechSize,
  requiresLicenseDisclosure,
  speechActionErrorCopy,
  speechModelDescription,
  speechModelQualityLabel,
} from "@/features/voice-settings/voice-speech-copy";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { publishVoiceMediaPolicy } from "./use-voice-media-policy";
import { voiceKeyMessages as m } from "./voice-key.messages";

// Where TeamHub keeps saved keys; a server without it can only read keys
// from its environment.
const STORAGE_VARIABLE = "TEAMHUB_SECRET_ENCRYPTION_KEY";
const QUICK_DOWNLOAD_POLL_MS = 1_500;

type DialogSelection = "local" | TeamHubVoiceProvider;

const CODE_TAGS = {
  code: (text: string) => <code className="font-mono">{text}</code>,
};

const providerDetails: Record<
  TeamHubVoiceProvider,
  {
    environmentVariable: string;
    href: string;
    name: string;
    purpose: Message<string>;
  }
> = {
  soniox: {
    environmentVariable: "SONIOX_API_KEY",
    href: "https://console.soniox.com/",
    name: "Soniox",
    purpose: m.sonioxPurpose,
  },
  xai: {
    environmentVariable: "XAI_API_KEY",
    href: "https://console.x.ai/",
    name: "xAI",
    purpose: m.xaiPurpose,
  },
};

function voiceProviderKeyStatus(
  policy: TeamHubVoiceMediaPolicy | undefined,
  provider: TeamHubVoiceProvider,
): TeamHubVoiceProviderKeyStatus | undefined {
  return provider === "soniox" ? policy?.soniox_key : policy?.xai_key;
}

/** Whether `policy` reports the voice that `provider`'s key turns on. */
function voiceReady(
  policy: TeamHubVoiceMediaPolicy,
  provider: TeamHubVoiceProvider,
) {
  return provider === "soniox"
    ? policy.voice_media_supported
    : policy.live_supported === true;
}

function describeSaveError(
  error: Error,
  provider: TeamHubVoiceProvider,
  t: Translate,
) {
  const { environmentVariable, name } = providerDetails[provider];
  switch (error instanceof TeamHubError ? error.code : undefined) {
    case "INVALID_REQUEST":
      return t(m.invalidKey);
    case "VOICE_KEY_REJECTED":
      return t(m.keyRejected, { provider: name });
    case "VOICE_KEY_NO_BALANCE":
      return t(m.noBalance, { provider: name });
    case "VOICE_KEY_NO_REALTIME_PERMISSION":
      return t(m.noRealtimePermission, { provider: name });
    case "VOICE_KEY_FROM_ENVIRONMENT":
      return t(m.keyFromEnvironment, {
        provider: name,
        variable: environmentVariable,
      });
    case "VOICE_KEY_STORAGE_UNAVAILABLE":
      return t(m.storageUnavailable, { storageVariable: STORAGE_VARIABLE });
    case "VOICE_PROVIDER_UNAVAILABLE":
      return t(m.providerUnreachable, { provider: name });
    case "VOICE_MEDIA_OFF":
      return t(m.voiceOff);
    default:
      return t(m.saveFailed);
  }
}

/**
 * Unified voice setup dialog: when local speech is available on an online
 * Computer and transcription is not yet configured, offers On this computer
 * (Recommended — free & private) alongside Cloud (Soniox / xAI) tabs.
 * Falls back gracefully to Cloud-only when no local-speech Computer is online.
 */
export function VoiceKeyDialog({
  onClose,
  onReady,
  policy,
  preferCloud = false,
  providers,
  tenantId,
}: {
  onClose: () => void;
  onReady: (
    provider: TeamHubVoiceProvider,
    policy: TeamHubVoiceMediaPolicy,
  ) => void;
  /** The policy the caller holds, read only for each key's status. */
  policy: TeamHubVoiceMediaPolicy | undefined;
  /** Opens directly on the Cloud API key form (e.g. from Settings → Security). */
  preferCloud?: boolean;
  providers: readonly TeamHubVoiceProvider[];
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const offerLocal =
    !preferCloud &&
    providers.includes("soniox") &&
    policy?.voice_media_supported === false &&
    policy?.local_speech_available === true;

  const options: readonly DialogSelection[] = offerLocal
    ? ["local", ...providers]
    : providers;
  const [selection, setSelection] = useState<DialogSelection>(
    offerLocal ? "local" : (providers[0] ?? "soniox"),
  );
  // Set when the key is saved but the fresh policy did not turn voice on.
  const [turnOnFailed, setTurnOnFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const cloudProvider: TeamHubVoiceProvider =
    selection === "local" ? "soniox" : selection;

  async function turnOn(targetProvider: TeamHubVoiceProvider) {
    const next = await teamHubData(
      client.api.GET("/v0/tenants/{tenantId}/voice-media-policy", {
        params: { path: { tenantId } },
      }),
    ).catch(() => undefined);
    if (next && voiceReady(next, targetProvider)) {
      setTurnOnFailed(false);
      publishVoiceMediaPolicy(tenantId, next);
      onReady(targetProvider, next);
      return;
    }
    setTurnOnFailed(true);
  }

  const details = providerDetails[cloudProvider];
  const status = voiceProviderKeyStatus(policy, cloudProvider);
  const canSaveForm =
    selection !== "local" &&
    !turnOnFailed &&
    status?.source !== "environment" &&
    status?.can_save !== false;
  // One form for every provider: switching starts a new draft instead of
  // remounting it, so focus stays on the provider switch.
  const keyForm = useProviderKeyForm({
    describeError: (error) => describeSaveError(error, cloudProvider, t),
    helper: t(details.purpose),
    label: t(m.apiKey, { provider: details.name }),
    labelAction: <ProviderKeyLink href={details.href} />,
    onCancel: onClose,
    // TeamHub answers the save once the voice workers are up.
    pendingLabel: t(m.turningOn),
    resetKey: cloudProvider,
    save: async (apiKey) => {
      await teamHubData(
        client.api.PUT("/v0/voice-provider-keys/{provider}", {
          body: { api_key: apiKey },
          params: { path: { provider: cloudProvider } },
        }),
      );
      // The Save button stays pending through this read.
      await turnOn(cloudProvider);
    },
  });
  const dialogTitle =
    options.length > 1
      ? t(m.turnOnVoice)
      : t(m.title, { provider: details.name });

  return (
    <ModalDialog
      closeOnBackdrop
      description={
        selection !== "local" &&
        !turnOnFailed &&
        status?.source === "stored" &&
        status.can_save !== false
          ? t(m.keyReplaceHint)
          : undefined
      }
      footer={
        turnOnFailed ? (
          <>
            <Button disabled={retrying} onClick={onClose} tone="secondary">
              {t(commonMessages.cancel)}
            </Button>
            <Button
              loading={retrying}
              onClick={() => {
                setRetrying(true);
                void turnOn(cloudProvider).finally(() => setRetrying(false));
              }}
              tone="primary"
            >
              {t(commonMessages.tryAgain)}
            </Button>
          </>
        ) : canSaveForm ? (
          keyForm.actions
        ) : undefined
      }
      onClose={onClose}
      size={offerLocal ? "md" : "sm"}
      title={dialogTitle}
    >
      <div className="space-y-4 px-5 py-4 text-sm text-app-body">
        {turnOnFailed ? (
          <p role="alert">{t(m.savedButOff)}</p>
        ) : (
          <>
            {options.length > 1 ? (
              <div
                aria-label={t(m.voiceProvider)}
                className="inline-flex w-fit flex-wrap gap-0.5 rounded-lg bg-muted p-0.5"
                role="radiogroup"
              >
                {options.map((option) => (
                  <button
                    aria-checked={option === selection}
                    className={`h-7 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none ${
                      option === selection
                        ? "bg-card text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    key={option}
                    onClick={() => setSelection(option)}
                    role="radio"
                    type="button"
                  >
                    {option === "local"
                      ? `${t(vs.quickSetupLocalTab)} (${t(vs.quickSetupRecommended)})`
                      : providerDetails[option].name}
                  </button>
                ))}
              </div>
            ) : null}

            {selection === "local" ? (
              <LocalQuickSetupPanel
                onClose={onClose}
                onEnabled={(nextPolicy) => onReady("soniox", nextPolicy)}
                tenantId={tenantId}
              />
            ) : status?.source === "environment" ? (
              <p className="text-muted-foreground">
                <RichMessage
                  message={m.keyFromEnvironmentNotice}
                  tags={CODE_TAGS}
                  values={{
                    provider: details.name,
                    variable: details.environmentVariable,
                  }}
                />
              </p>
            ) : status?.can_save === false ? (
              <p className="text-muted-foreground">
                <RichMessage
                  message={m.cannotSaveHere}
                  tags={CODE_TAGS}
                  values={{
                    provider: details.name,
                    storageVariable: STORAGE_VARIABLE,
                    variable: details.environmentVariable,
                  }}
                />
              </p>
            ) : (
              keyForm.fields
            )}
          </>
        )}
      </div>
    </ModalDialog>
  );
}

function LocalQuickSetupPanel({
  onClose,
  onEnabled,
  tenantId,
}: {
  onClose: () => void;
  onEnabled: (policy: TeamHubVoiceMediaPolicy) => void;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const desktop = useDesktopComputer();

  const [error, setError] = useState<string | null>(null);
  const [enablingModelId, setEnablingModelId] = useState<string | null>(null);
  const activatingRef = useRef(false);

  const computersQuery = useQuery(localComputersQueryOptions(client, tenantId));
  const settingsQuery = useQuery(voiceSettingsQueryOptions(client, tenantId));
  const settings = settingsQuery.data ?? DEFAULT_VOICE_SETTINGS;

  const targetComputer = useMemo(
    () =>
      resolveSpeechComputer({
        computers: computersQuery.data?.items ?? [],
        configuredComputerId: settings.local_computer_id,
        desktopComputerId: desktop?.status?.computerId,
      }),
    [
      computersQuery.data?.items,
      desktop?.status?.computerId,
      settings.local_computer_id,
    ],
  );

  const computerId =
    targetComputer?.status === "online"
      ? targetComputer.computer_id
      : undefined;

  const speechQuery = useQuery({
    ...localSpeechQueryOptions(client, tenantId, computerId ?? ""),
    enabled: Boolean(computerId),
    refetchInterval: (query) => {
      if (enablingModelId) return QUICK_DOWNLOAD_POLL_MS;
      if (
        query.state.data?.models.some(
          (model) => model.state === "downloading" || model.state === "loading",
        )
      ) {
        return QUICK_DOWNLOAD_POLL_MS;
      }
      return false;
    },
  });

  const activateModel = useMutation({
    mutationFn: async (modelId: string) => {
      if (!computerId) throw new Error("No online computer");
      const { policy } = await activateLocalSpeechModel(
        client,
        tenantId,
        computerId,
        modelId,
        queryClient,
      );
      return policy;
    },
    onError: (cause) => {
      activatingRef.current = false;
      setEnablingModelId(null);
      const code = cause instanceof TeamHubError ? cause.code : undefined;
      setError(code ? speechActionErrorCopy(code, t) : t(vs.errorSettingsSave));
    },
    onSuccess: (nextPolicy) => {
      activatingRef.current = false;
      if (nextPolicy?.voice_media_supported) {
        setEnablingModelId(null);
        onEnabled(nextPolicy);
      } else {
        setEnablingModelId(null);
        setError(t(m.savedButOff));
      }
    },
  });

  const downloadMutation = useMutation({
    mutationFn: async (model: TeamHubLocalSpeechModel) => {
      if (!computerId) throw new Error("No online computer");
      return actOnLocalComputerSpeech(client, tenantId, computerId, {
        action: "download",
        include_gpu_engine: settings.use_gpu && model.gpu_supported,
        model_id: model.id,
      });
    },
    onError: (cause) => {
      setEnablingModelId(null);
      const code = cause instanceof TeamHubError ? cause.code : undefined;
      setError(speechActionErrorCopy(code, t));
    },
    onMutate: (model) => {
      setError(null);
      setEnablingModelId(model.id);
    },
    onSettled: () => {
      if (computerId) {
        void queryClient.invalidateQueries({
          queryKey: localSpeechQueryKey(tenantId, computerId),
        });
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: async (modelId: string) => {
      if (!computerId) throw new Error("No online computer");
      return actOnLocalComputerSpeech(client, tenantId, computerId, {
        action: "cancel",
        model_id: modelId,
      });
    },
    onMutate: () => {
      setEnablingModelId(null);
      setError(null);
    },
    onSettled: () => {
      if (computerId) {
        void queryClient.invalidateQueries({
          queryKey: localSpeechQueryKey(tenantId, computerId),
        });
      }
    },
  });

  // Once the target model finishes downloading, automatically enable it.
  const watchedModel = enablingModelId
    ? speechQuery.data?.models.find((model) => model.id === enablingModelId)
    : undefined;
  const { mutate: triggerActivate } = activateModel;

  useEffect(() => {
    if (!watchedModel || !enablingModelId) return;
    if (
      (watchedModel.state === "idle" || watchedModel.state === "loaded") &&
      !activatingRef.current
    ) {
      activatingRef.current = true;
      triggerActivate(enablingModelId);
    } else if (watchedModel.state === "failed") {
      setEnablingModelId(null);
      setError(
        watchedModel.error?.message || speechActionErrorCopy(undefined, t),
      );
    }
  }, [enablingModelId, t, triggerActivate, watchedModel]);

  const models = speechQuery.data?.models ?? [];

  return (
    <div className="space-y-3.5">
      <p className="text-muted-foreground">{t(vs.quickSetupLocalSubtitle)}</p>

      {error ? <FormFeedback tone="danger">{error}</FormFeedback> : null}

      {computersQuery.isLoading || (computerId && speechQuery.isLoading) ? (
        <div className="space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : !computerId || !speechQuery.data?.available || models.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(vs.quickSetupNoOnlineComputer)}
        </p>
      ) : (
        <div className="space-y-2.5">
          {models.map((model) => {
            const isDownloading =
              model.state === "downloading" ||
              (downloadMutation.isPending && enablingModelId === model.id);
            const isReady = model.state === "idle" || model.state === "loaded";
            const isActivating =
              activateModel.isPending && enablingModelId === model.id;
            const percent = formatSpeechDownloadPercent(model.download);
            const needsDisclosure = requiresLicenseDisclosure(model);
            const licenseName = formatLicenseDisplayName(model.license);

            return (
              <div
                className="rounded-xl border border-border bg-card"
                data-quick-speech-model={model.id}
                key={model.id}
              >
                <div className="flex flex-col gap-2.5 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-start gap-2.5">
                    <span
                      aria-hidden="true"
                      className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                    >
                      <Icon icon={Mic01Icon} size={15} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="text-sm font-medium text-foreground">
                          {model.name}
                        </span>
                        <span className="inline-flex h-[18px] items-center rounded-sm bg-muted px-1.5 text-[11px] font-medium text-secondary-foreground">
                          {speechModelQualityLabel(model, t)}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatSpeechSize(model.disk_size_bytes, t)}
                        </span>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {speechModelDescription(model, t)}
                      </p>
                      {isDownloading ? (
                        <p className="mt-1 text-xs tabular-nums text-app-info">
                          {model.download
                            ? formatSpeechDownloadStats(model.download, t)
                            : t(vs.statusDownloading)}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2 pl-10 sm:pl-0">
                    {isDownloading ? (
                      <Button
                        loading={cancelMutation.isPending}
                        onClick={() => cancelMutation.mutate(model.id)}
                        size="compact"
                        tone="secondary"
                      >
                        {t(vs.actionCancel)}
                      </Button>
                    ) : isReady ? (
                      <Button
                        disabled={Boolean(enablingModelId)}
                        loading={isActivating}
                        onClick={() => {
                          setError(null);
                          setEnablingModelId(model.id);
                          activatingRef.current = true;
                          activateModel.mutate(model.id);
                        }}
                        size="compact"
                        tone="primary"
                      >
                        {isActivating
                          ? t(vs.quickSetupEnabling)
                          : t(vs.quickSetupUseModel)}
                      </Button>
                    ) : (
                      <Button
                        disabled={Boolean(enablingModelId)}
                        onClick={() => downloadMutation.mutate(model)}
                        size="compact"
                        tone={
                          model.id === "sensevoice-small"
                            ? "primary"
                            : "secondary"
                        }
                      >
                        <Icon icon={Download04Icon} size={14} />
                        {t(vs.quickSetupDownloadAndEnable)}
                      </Button>
                    )}
                  </div>
                </div>

                {isDownloading ? (
                  <div className="px-3.5 pb-3">
                    <div
                      aria-label={t(vs.downloadProgressLabel, {
                        name: model.name,
                      })}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={percent}
                      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                      role="progressbar"
                    >
                      <div
                        className="h-full rounded-full bg-app-info transition-[width] duration-200"
                        style={{ width: `${percent}%` }}
                      />
                    </div>
                  </div>
                ) : null}

                {needsDisclosure ? (
                  <div className="border-t border-border/70 bg-muted/25 px-3.5 py-2 text-xs text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <a
                        className="inline-flex items-center gap-1 font-medium text-foreground underline decoration-border underline-offset-2 hover:text-app-info"
                        href={model.license_url}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        {licenseName}
                        <Icon icon={LinkSquare02Icon} size={12} />
                      </a>
                      <span>{t(vs.modelLicenseOptInNotice)}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex justify-end pt-1">
        <Link
          className="text-xs font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={onClose}
          to={`/t/${tenantId}/settings/voice`}
        >
          {t(vs.openVoiceSettings)}
        </Link>
      </div>
    </div>
  );
}
