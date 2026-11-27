import { Mic01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
} from "react";
import { useParams, useSearchParams } from "react-router";

import { AutoHeight } from "@/components/ui/auto-height";
import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { StatusPill } from "@/components/ui/status-pill";
import { useTabIndicator } from "@/components/ui/tab-indicator";
import {
  ProviderKeyLink,
  useProviderKeyForm,
} from "@/features/apps/provider-key-form";
import { useDesktopComputer } from "@/features/local-computer/desktop-computer";
import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import {
  ComputerPicker,
  type ComputerPickerOption,
} from "@/features/local-models/computer-picker";
import { requireRoomRouteParam } from "@/features/rooms/room-route-params";
import {
  describeVoiceMediaError,
  discoverVoiceMicrophones,
  listVoiceMicrophones,
  type VoiceMicrophoneDevice,
} from "@/features/rooms/voice-control/microphone-devices";
import { useVoiceMediaPolicy } from "@/features/rooms/voice-control/use-voice-media-policy";
import { useOptionalVoiceControl } from "@/features/rooms/voice-control/voice-control-context";
import {
  deviceStorageKey,
  readDeviceBinding,
  removeStorage,
  writeStorage,
} from "@/features/rooms/voice-control/voice-control-storage";
import { voiceKeyMessages } from "@/features/rooms/voice-control/voice-key.messages";
import { accountSettingsMessages } from "@/features/settings/account-settings.messages";
import { SettingsPageHeading } from "@/features/settings/settings-page-heading";
import { teamHubData } from "@/features/teamhub/teamhub-api";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubUpdateVoiceSettingsRequest,
  TeamHubVoiceProviderKeyStatus,
  TeamHubVoiceSettings,
} from "@/features/teamhub/teamhub-types";
import type { Translate } from "@/i18n/language";
import { RichMessage, useT } from "@/i18n/use-translation";

import { useMicrophoneTest } from "./use-microphone-test";
import { VoiceLocalModelsSection } from "./voice-local-models-section";
import { voiceSettingsMessages as m } from "./voice-settings.messages";
import {
  configureLocalComputerSpeech,
  DEFAULT_VOICE_SETTINGS,
  localSpeechQueryOptions,
  refreshVoiceMediaPolicy,
  resolveSpeechComputer,
  updateVoiceSettings,
  voiceSettingsQueryKey,
  voiceSettingsQueryOptions,
} from "./voice-settings-queries";
import {
  keepLoadedOptions,
  silenceTimeoutOptions,
  speechLanguageOptions,
} from "./voice-speech-copy";

type SpeechTab = "local" | "cloud";

const SYSTEM_DEFAULT_DEVICE_VALUE = "__system_default__";
const SONIOX_CONSOLE_URL = "https://console.soniox.com/";
const STORAGE_VARIABLE = "TEAMHUB_SECRET_ENCRYPTION_KEY";

function describeSonioxSaveError(error: Error, t: Translate): string {
  switch (error instanceof TeamHubError ? error.code : undefined) {
    case "INVALID_REQUEST":
      return t(voiceKeyMessages.invalidKey);
    case "VOICE_KEY_REJECTED":
      return t(voiceKeyMessages.keyRejected, { provider: "Soniox" });
    case "VOICE_KEY_NO_BALANCE":
      return t(voiceKeyMessages.noBalance, { provider: "Soniox" });
    case "VOICE_KEY_NO_REALTIME_PERMISSION":
      return t(voiceKeyMessages.noRealtimePermission, { provider: "Soniox" });
    case "VOICE_KEY_FROM_ENVIRONMENT":
      return t(voiceKeyMessages.keyFromEnvironment, {
        provider: "Soniox",
        variable: "SONIOX_API_KEY",
      });
    case "VOICE_KEY_STORAGE_UNAVAILABLE":
      return t(voiceKeyMessages.storageUnavailable, {
        storageVariable: STORAGE_VARIABLE,
      });
    case "VOICE_PROVIDER_UNAVAILABLE":
      return t(voiceKeyMessages.providerUnreachable, { provider: "Soniox" });
    case "VOICE_MEDIA_OFF":
      return t(voiceKeyMessages.voiceOff);
    default:
      return t(voiceKeyMessages.saveFailed);
  }
}

/**
 * Top-level Settings → Voice page (`/t/:tenantId/settings/voice`).
 * Combines local/cloud speech model management, browser-local microphone
 * selection with live level testing, dictation silence auto-stop, and
 * local execution controls (GPU + keep-loaded TTL).
 */
export function VoiceSettingsPage() {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const tenantId = requireRoomRouteParam(useParams().tenantId, "Tenant");
  const [searchParams, setSearchParams] = useSearchParams();
  const desktop = useDesktopComputer();

  const policy = useVoiceMediaPolicy(tenantId, true);
  const settingsQuery = useQuery(voiceSettingsQueryOptions(client, tenantId));
  const settings: TeamHubVoiceSettings =
    settingsQuery.data ?? DEFAULT_VOICE_SETTINGS;

  const computersQuery = useQuery(localComputersQueryOptions(client, tenantId));
  const computers = useMemo(
    () => computersQuery.data?.items ?? [],
    [computersQuery.data?.items],
  );

  const requestedTab = searchParams.get("tab");
  const [tabOverride, setTabOverride] = useState<SpeechTab | null>(() =>
    requestedTab === "cloud" || requestedTab === "local" ? requestedTab : null,
  );
  const defaultTab: SpeechTab =
    requestedTab === "cloud"
      ? "cloud"
      : requestedTab === "local"
        ? "local"
        : settings.speech_provider === "cloud" ||
            policy?.active_speech_provider === "cloud"
          ? "cloud"
          : "local";
  const activeTab: SpeechTab = tabOverride ?? defaultTab;

  const [selectedComputerOverride, setSelectedComputerOverride] = useState<
    string | null
  >(null);

  const resolvedComputer = useMemo(
    () =>
      resolveSpeechComputer({
        computers,
        configuredComputerId: settings.local_computer_id,
        desktopComputerId: desktop?.status?.computerId,
        selectedComputerId: selectedComputerOverride,
      }),
    [
      computers,
      desktop?.status?.computerId,
      selectedComputerOverride,
      settings.local_computer_id,
    ],
  );

  const computerId = resolvedComputer?.computer_id;
  const speechQuery = useQuery({
    ...localSpeechQueryOptions(client, tenantId, computerId ?? ""),
    enabled: Boolean(computerId),
  });

  const [saveError, setSaveError] = useState<string | null>(null);

  const settingsMutation = useMutation({
    mutationFn: async ({
      forwardConfigure,
      patch,
    }: {
      forwardConfigure?: boolean;
      patch: TeamHubUpdateVoiceSettingsRequest;
    }) => {
      const updated = await updateVoiceSettings(client, tenantId, patch);
      if (
        forwardConfigure &&
        computerId &&
        resolvedComputer?.status === "online" &&
        speechQuery.data?.available &&
        speechQuery.data.viewer_is_owner
      ) {
        await configureLocalComputerSpeech(
          client,
          tenantId,
          computerId,
          updated,
        );
      }
      return updated;
    },
    onError: () => setSaveError(t(m.errorSettingsSave)),
    onMutate: () => setSaveError(null),
    onSuccess: (updated) => {
      queryClient.setQueryData(voiceSettingsQueryKey(tenantId), updated);
      void refreshVoiceMediaPolicy(client, tenantId);
    },
  });

  function changeTab(next: SpeechTab) {
    setTabOverride(next);
    setSearchParams(
      (current) => {
        const updated = new URLSearchParams(current);
        updated.set("tab", next);
        return updated;
      },
      { replace: true },
    );
  }

  function handleSelectComputer(nextComputerId: string) {
    setSelectedComputerOverride(nextComputerId);
    settingsMutation.mutate({
      patch: { local_computer_id: nextComputerId },
    });
  }

  const computerPickerOptions: ComputerPickerOption[] = useMemo(
    () =>
      computers.map((item) => ({
        computerId: item.computer_id,
        displayName: item.display_name,
        online: item.status === "online",
      })),
    [computers],
  );

  const localActive =
    policy?.active_speech_provider === "local" &&
    Boolean(policy.local_speech_ready);
  const cloudActive =
    policy?.active_speech_provider === "cloud" &&
    Boolean(policy.soniox_key && policy.soniox_key.source !== "none");

  const languageList = useMemo(() => speechLanguageOptions(t), [t]);
  const silenceList = useMemo(() => silenceTimeoutOptions(t), [t]);
  const keepLoadedList = useMemo(() => keepLoadedOptions(t), [t]);

  const noSupportedGpu =
    speechQuery.data?.runtime?.fallback_reason === "no_supported_gpu";

  return (
    <main className="mx-auto flex min-h-0 w-full max-w-(--app-settings-width) flex-col gap-8 pb-6">
      <SettingsPageHeading description={t(m.description)} title={t(m.title)} />

      {saveError ? (
        <FormFeedback tone="danger">{saveError}</FormFeedback>
      ) : null}

      {/* Section 1: Speech model */}
      <section
        aria-labelledby="voice-speech-model-heading"
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            className="text-base font-medium text-foreground"
            id="voice-speech-model-heading"
          >
            {t(m.speechModelHeading)}
          </h2>
          {activeTab === "local" && computers.length > 1 && computerId ? (
            <ComputerPicker
              onSelect={handleSelectComputer}
              options={computerPickerOptions}
              value={computerId}
            />
          ) : null}
        </div>

        <SpeechProviderTabs
          cloudActive={cloudActive}
          localActive={localActive}
          onChange={changeTab}
          value={activeTab}
        />

        {activeTab === "local" ? (
          <VoiceLocalModelsSection
            computerId={computerId}
            computerName={resolvedComputer?.display_name}
            computerOffline={resolvedComputer?.status === "offline"}
            onSwitchToCloud={() => changeTab("cloud")}
            tenantId={tenantId}
          />
        ) : (
          <CloudSpeechSection
            cloudActive={cloudActive}
            localReady={Boolean(policy?.local_speech_ready)}
            onSelectProvider={(provider) =>
              settingsMutation.mutate({ patch: { speech_provider: provider } })
            }
            savingProvider={settingsMutation.isPending}
            sonioxKey={policy?.soniox_key}
            tenantId={tenantId}
          />
        )}

        {/* Shared Language row (applies to both local & cloud) */}
        <div className="rounded-xl border border-border bg-card px-5 py-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {t(m.languageLabel)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(m.languageDescription)}
              </p>
            </div>
            <div className="shrink-0 sm:w-48">
              <Select
                aria-label={t(m.languageLabel)}
                className="w-full"
                disabled={settingsMutation.isPending}
                onValueChange={(nextLanguage) =>
                  settingsMutation.mutate({
                    forwardConfigure: true,
                    patch: { language: nextLanguage },
                  })
                }
                value={settings.language}
              >
                {languageList.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>
        </div>
      </section>

      {/* Section 2: Microphone */}
      <section aria-labelledby="voice-microphone-heading" className="space-y-3">
        <h2
          className="text-base font-medium text-foreground"
          id="voice-microphone-heading"
        >
          {t(m.microphoneHeading)}
        </h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          <MicrophoneInputRow tenantId={tenantId} />
          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {t(m.silenceTimeoutLabel)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(m.silenceTimeoutDescription)}
              </p>
            </div>
            <div className="shrink-0 sm:w-48">
              <Select
                aria-label={t(m.silenceTimeoutLabel)}
                className="w-full"
                disabled={settingsMutation.isPending}
                onValueChange={(nextValue) =>
                  settingsMutation.mutate({
                    patch: { silence_timeout_seconds: Number(nextValue) },
                  })
                }
                value={String(settings.silence_timeout_seconds)}
              >
                {silenceList.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>
        </div>
      </section>

      {/* Section 3: Advanced */}
      <section aria-labelledby="voice-advanced-heading" className="space-y-3">
        <h2
          className="text-base font-medium text-foreground"
          id="voice-advanced-heading"
        >
          {t(m.advancedHeading)}
        </h2>
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          <div className="px-5 py-4">
            <label className="flex cursor-pointer items-center justify-between gap-4">
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-foreground">
                  {t(m.useGpuLabel)}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  {t(m.useGpuDescription)}
                </span>
              </span>
              <input
                aria-label={t(m.useGpuLabel)}
                checked={settings.use_gpu}
                className="agent-connector-switch shrink-0"
                disabled={settingsMutation.isPending}
                onChange={(event) =>
                  settingsMutation.mutate({
                    forwardConfigure: true,
                    patch: { use_gpu: event.target.checked },
                  })
                }
                role="switch"
                type="checkbox"
              />
            </label>
            {noSupportedGpu ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {t(m.useGpuNoGpuCaption)}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">
                {t(m.keepLoadedLabel)}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t(m.keepLoadedDescription)}
              </p>
            </div>
            <div className="shrink-0 sm:w-48">
              <Select
                aria-label={t(m.keepLoadedLabel)}
                className="w-full"
                disabled={settingsMutation.isPending}
                onValueChange={(nextValue) =>
                  settingsMutation.mutate({
                    forwardConfigure: true,
                    patch: { keep_loaded_seconds: Number(nextValue) },
                  })
                }
                value={String(settings.keep_loaded_seconds)}
              >
                {keepLoadedList.map((option) => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function SpeechProviderTabs({
  cloudActive,
  localActive,
  onChange,
  value,
}: {
  cloudActive: boolean;
  localActive: boolean;
  onChange: (tab: SpeechTab) => void;
  value: SpeechTab;
}) {
  const t = useT();
  const tabs: readonly { active: boolean; id: SpeechTab; label: string }[] = [
    { active: localActive, id: "local", label: t(m.tabLocal) },
    { active: cloudActive, id: "cloud", label: t(m.tabCloud) },
  ];
  const indicatorKey = `${value}:${localActive ? "1" : "0"}:${cloudActive ? "1" : "0"}`;
  const { indicator, tabRef } = useTabIndicator(indicatorKey);

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + step + tabs.length) % tabs.length;
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onChange(nextTab.id);
    const buttons = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[nextIndex]?.focus();
  }

  return (
    <div
      aria-label={t(m.speechProviderTabs)}
      className="relative -ml-3 inline-flex max-w-full self-start gap-1"
      role="tablist"
    >
      {tabs.map((tab, index) => (
        <span
          className="inline-flex shrink-0"
          key={tab.id}
          ref={tabRef(
            `${tab.id}:${localActive ? "1" : "0"}:${cloudActive ? "1" : "0"}`,
          )}
        >
          <button
            aria-selected={tab.id === value}
            className="workspace-view-tab inline-flex h-9 shrink-0 items-center gap-1.5 rounded-t-md px-3 text-sm font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            role="tab"
            type="button"
          >
            {tab.active ? (
              <span
                aria-label={t(m.tabInUse)}
                className="size-1.5 rounded-full bg-app-success"
                role="img"
              />
            ) : null}
            {tab.label}
          </button>
        </span>
      ))}
      {indicator}
    </div>
  );
}

function CloudSpeechSection({
  cloudActive,
  localReady,
  onSelectProvider,
  savingProvider,
  sonioxKey,
  tenantId,
}: {
  cloudActive: boolean;
  localReady: boolean;
  onSelectProvider: (provider: "cloud" | "local") => void;
  savingProvider: boolean;
  sonioxKey: TeamHubVoiceProviderKeyStatus | undefined;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const configured = Boolean(sonioxKey && sonioxKey.source !== "none");
  const [editingKey, setEditingKey] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);

  const showKeyForm =
    sonioxKey?.source !== "environment" &&
    sonioxKey?.can_save !== false &&
    (!configured || editingKey);

  const keyForm = useProviderKeyForm({
    describeError: (error) => describeSonioxSaveError(error, t),
    helper: t(voiceKeyMessages.sonioxPurpose),
    label: t(voiceKeyMessages.apiKey, { provider: "Soniox" }),
    labelAction: <ProviderKeyLink href={SONIOX_CONSOLE_URL} />,
    onCancel: configured ? () => setEditingKey(false) : undefined,
    pendingLabel: t(voiceKeyMessages.turningOn),
    save: async (apiKey) => {
      await teamHubData(
        client.api.PUT("/v0/voice-provider-keys/{provider}", {
          body: { api_key: apiKey },
          params: { path: { provider: "soniox" } },
        }),
      );
      await refreshVoiceMediaPolicy(client, tenantId);
      setEditingKey(false);
      setSavedNotice(true);
    },
  });

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">
              {t(m.cloudHeading)}
            </h3>
            {sonioxKey ? (
              <CloudKeySourcePill source={sonioxKey.source} />
            ) : null}
            {cloudActive ? (
              <StatusPill tone="success">{t(m.cloudUsingBadge)}</StatusPill>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(m.cloudDescription)}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {configured && !cloudActive ? (
            <Button
              loading={savingProvider}
              onClick={() => onSelectProvider("cloud")}
              size="compact"
              tone="primary"
            >
              {t(m.cloudUseButton)}
            </Button>
          ) : null}
          {cloudActive && localReady ? (
            <Button
              loading={savingProvider}
              onClick={() => onSelectProvider("local")}
              size="compact"
              tone="secondary"
            >
              {t(m.cloudSwitchToLocalButton)}
            </Button>
          ) : null}
          {configured && sonioxKey?.can_save && !editingKey ? (
            <Button
              onClick={() => {
                setSavedNotice(false);
                setEditingKey(true);
              }}
              size="compact"
              tone="secondary"
            >
              {t(m.cloudKeyReplace)}
            </Button>
          ) : null}
        </div>
      </div>

      {savedNotice ? (
        <p
          className="flex items-center gap-2 text-xs text-app-success"
          role="status"
        >
          <Icon icon={Tick02Icon} size={14} />
          {t(m.cloudKeySaved)}
        </p>
      ) : null}

      {sonioxKey?.source === "environment" ? (
        <p className="text-xs text-muted-foreground">
          <RichMessage
            message={voiceKeyMessages.keyFromEnvironmentNotice}
            tags={{
              code: (text) => <code className="font-mono">{text}</code>,
            }}
            values={{
              provider: "Soniox",
              variable: "SONIOX_API_KEY",
            }}
          />
        </p>
      ) : sonioxKey?.can_save === false ? (
        <p className="text-xs text-muted-foreground">
          <RichMessage
            message={voiceKeyMessages.cannotSaveHere}
            tags={{
              code: (text) => <code className="font-mono">{text}</code>,
            }}
            values={{
              provider: "Soniox",
              storageVariable: STORAGE_VARIABLE,
              variable: "SONIOX_API_KEY",
            }}
          />
        </p>
      ) : showKeyForm ? (
        <div className="space-y-4 border-t border-border/70 pt-4 text-sm text-app-body">
          {!configured ? (
            <p className="text-xs text-muted-foreground">
              {t(m.cloudNotConfiguredHint)}
            </p>
          ) : null}
          {keyForm.fields}
          <div className="flex justify-end gap-2">{keyForm.actions}</div>
        </div>
      ) : null}
    </div>
  );
}

function CloudKeySourcePill({
  source,
}: {
  source: TeamHubVoiceProviderKeyStatus["source"];
}) {
  const t = useT();
  return source === "environment" ? (
    <StatusPill>{t(accountSettingsMessages.keySetByServer)}</StatusPill>
  ) : source === "stored" ? (
    <StatusPill tone="success">
      {t(accountSettingsMessages.keyActive)}
    </StatusPill>
  ) : (
    <StatusPill>{t(accountSettingsMessages.keyNotSet)}</StatusPill>
  );
}

function MicrophoneInputRow({ tenantId }: { tenantId: string }) {
  const t = useT();
  const voiceControl = useOptionalVoiceControl();

  const [localDevices, setLocalDevices] = useState<VoiceMicrophoneDevice[]>([]);
  const [storedDeviceId, setStoredDeviceId] = useState<string>(
    () => readDeviceBinding(tenantId)?.deviceId ?? "",
  );
  const [permissionNeeded, setPermissionNeeded] = useState(false);
  const [grantingAccess, setGrantingAccess] = useState(false);
  const [deviceError, setDeviceError] = useState<string | null>(null);

  const devices = voiceControl?.devices.length
    ? voiceControl.devices
    : localDevices;
  const selectedDeviceId =
    voiceControl?.boundDevice?.deviceId ??
    voiceControl?.selectedDeviceId ??
    storedDeviceId;

  const refreshDeviceList = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setLocalDevices([]);
      return;
    }
    try {
      const raw = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = raw.filter((device) => device.kind === "audioinput");
      const hasLabeled = audioInputs.some(
        (device) =>
          Boolean(device.deviceId) &&
          device.deviceId !== "default" &&
          device.deviceId !== "communications" &&
          device.label.trim() !== "",
      );
      if (!hasLabeled) {
        setPermissionNeeded(true);
        setLocalDevices([]);
        return;
      }
      setPermissionNeeded(false);
      const listed = await listVoiceMicrophones(navigator.mediaDevices);
      setLocalDevices(listed);
    } catch {
      setLocalDevices([]);
    }
  }, []);

  useEffect(() => {
    void refreshDeviceList();
    if (!navigator.mediaDevices?.addEventListener) return;
    const onChange = () => {
      void refreshDeviceList();
    };
    navigator.mediaDevices.addEventListener("devicechange", onChange);
    return () =>
      navigator.mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshDeviceList]);

  const micTest = useMicrophoneTest(selectedDeviceId || undefined);

  async function handleGrantAccess() {
    setDeviceError(null);
    setGrantingAccess(true);
    try {
      if (voiceControl?.discoverDevices) {
        const discovered = await voiceControl.discoverDevices();
        setLocalDevices(discovered);
      } else {
        const result = await discoverVoiceMicrophones({
          preferredDeviceId: selectedDeviceId || undefined,
        });
        setLocalDevices(result.devices);
      }
      setPermissionNeeded(false);
    } catch (cause) {
      setDeviceError(describeVoiceMediaError(cause));
    } finally {
      setGrantingAccess(false);
    }
  }

  async function handleSelectDevice(nextValue: string) {
    setDeviceError(null);
    if (nextValue === SYSTEM_DEFAULT_DEVICE_VALUE) {
      setStoredDeviceId("");
      removeStorage(deviceStorageKey(tenantId));
      return;
    }
    const chosen = devices.find((item) => item.deviceId === nextValue);
    if (!chosen) return;
    setStoredDeviceId(chosen.deviceId);
    if (voiceControl?.selectDevice) {
      try {
        await voiceControl.selectDevice(chosen.deviceId);
      } catch (cause) {
        setDeviceError(describeVoiceMediaError(cause));
      }
    } else {
      writeStorage(deviceStorageKey(tenantId), JSON.stringify(chosen));
    }
  }

  const selectValue =
    selectedDeviceId &&
    devices.some((device) => device.deviceId === selectedDeviceId)
      ? selectedDeviceId
      : SYSTEM_DEFAULT_DEVICE_VALUE;

  const meterPercent = Math.round(
    Math.min(1, Math.max(0, micTest.level)) * 100,
  );

  return (
    <div className="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {t(m.inputLabel)}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(m.inputDescription)}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {permissionNeeded && devices.length === 0 ? (
            <Button
              data-voice-risk="confirm"
              loading={grantingAccess}
              onClick={() => void handleGrantAccess()}
              size="compact"
              tone="secondary"
            >
              {t(m.inputGrantAccess)}
            </Button>
          ) : (
            <div className="min-w-0 flex-1 sm:w-52 sm:flex-none">
              <Select
                aria-label={t(m.inputLabel)}
                className="w-full"
                onValueChange={(value) => void handleSelectDevice(value)}
                value={selectValue}
              >
                <SelectItem value={SYSTEM_DEFAULT_DEVICE_VALUE}>
                  {t(m.inputSystemDefault)}
                </SelectItem>
                {devices.map((device) => (
                  <SelectItem key={device.deviceId} value={device.deviceId}>
                    {device.label}
                  </SelectItem>
                ))}
              </Select>
            </div>
          )}

          <Button
            disabled={micTest.blockedByActiveSession}
            loading={micTest.starting}
            onClick={() => {
              if (micTest.testing) micTest.stopTest();
              else void micTest.startTest();
            }}
            size="compact"
            tone={micTest.testing ? "primary" : "secondary"}
          >
            {micTest.starting ? null : <Icon icon={Mic01Icon} size={14} />}
            {micTest.testing ? t(m.inputStopTest) : t(m.inputTest)}
          </Button>
        </div>
      </div>

      {micTest.blockedByActiveSession ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {t(m.inputActiveSessionHint)}
        </p>
      ) : null}

      <AutoHeight open={micTest.testing}>
        <div className="pt-3">
          <div className="rounded-lg border border-border/80 bg-muted/35 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{t(m.inputTestingHint)}</span>
              <span className="tabular-nums">{meterPercent}%</span>
            </div>
            <div
              aria-label={t(m.inputLevelLabel)}
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={meterPercent}
              className="mt-2 h-2 w-full overflow-hidden rounded-full bg-muted"
              role="meter"
            >
              <div
                className="h-full rounded-full bg-app-success transition-[width] duration-75"
                style={{ width: `${meterPercent}%` }}
              />
            </div>
          </div>
        </div>
      </AutoHeight>

      {micTest.timedOut ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status">
          {t(m.inputTestTimedOut)}
        </p>
      ) : null}

      {deviceError || micTest.error ? (
        <div className="mt-2.5">
          <FormFeedback tone="danger">
            {deviceError ?? micTest.error}
          </FormFeedback>
        </div>
      ) : null}
    </div>
  );
}
