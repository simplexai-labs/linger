import {
  ArrowRight01Icon,
  Delete02Icon,
  Download04Icon,
  LinkSquare02Icon,
  Mic01Icon,
  RefreshIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusPill } from "@/components/ui/status-pill";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubLocalSpeechActionRequest,
  TeamHubLocalSpeechModel,
  TeamHubLocalSpeechRuntime,
  TeamHubVoiceSettings,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import { voiceSettingsMessages as m } from "./voice-settings.messages";
import {
  activateLocalSpeechModel,
  actOnLocalComputerSpeech,
  DEFAULT_VOICE_SETTINGS,
  localSpeechActionMutationKey,
  localSpeechQueryKey,
  localSpeechQueryOptions,
  refreshLocalComputerSpeech,
  refreshVoiceMediaPolicy,
  voiceSettingsQueryKey,
  voiceSettingsQueryOptions,
} from "./voice-settings-queries";
import {
  effectiveDeviceLabel,
  fallbackBannerTone,
  fallbackReasonCopy,
  formatLicenseDisplayName,
  formatSpeechDownloadPercent,
  formatSpeechDownloadStats,
  formatSpeechSize,
  isGpuDevice,
  requiresLicenseDisclosure,
  speechActionErrorCopy,
  speechModelDescription,
  speechModelQualityLabel,
  speechUnavailableMessage,
} from "./voice-speech-copy";

export interface VoiceLocalModelsSectionProps {
  /** Compact mode for Settings → Models → Voice tab (adds Voice settings link). */
  compact?: boolean;
  computerId?: string;
  computerName?: string;
  computerOffline?: boolean;
  onSwitchToCloud?: () => void;
  tenantId: string;
}

const activeDownloadPollMs = 1_500;

/**
 * Shared local speech model library mounted in both Settings → Voice and
 * Settings → Models → Voice. Reads and mutates the same TanStack Query cache
 * so download progress, active model, and GPU/CPU runtime state stay synced.
 */
export function VoiceLocalModelsSection({
  compact = false,
  computerId,
  computerName,
  computerOffline = false,
  onSwitchToCloud,
  tenantId,
}: VoiceLocalModelsSectionProps) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();

  const [actionError, setActionError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<TeamHubLocalSpeechModel | null>(null);
  const [pendingByModel, setPendingByModel] = useState<{
    action: TeamHubLocalSpeechActionRequest["action"] | "use";
    modelId: string;
  } | null>(null);

  const settingsQuery = useQuery(voiceSettingsQueryOptions(client, tenantId));
  const settings: TeamHubVoiceSettings =
    settingsQuery.data ?? DEFAULT_VOICE_SETTINGS;

  const speechQuery = useQuery({
    ...localSpeechQueryOptions(client, tenantId, computerId ?? ""),
    enabled: Boolean(computerId),
    refetchInterval: (query) => {
      const models = query.state.data?.models;
      if (
        models?.some(
          (model) => model.state === "downloading" || model.state === "loading",
        )
      ) {
        return activeDownloadPollMs;
      }
      return false;
    },
  });

  const view = speechQuery.data;
  const resolvedComputerName =
    computerName ?? view?.computer.display_name ?? "";
  const isOffline =
    computerOffline || (view ? view.computer.status === "offline" : false);
  const canAct = Boolean(computerId && view?.viewer_is_owner && !isOffline);

  const actionMutation = useMutation({
    mutationFn: async (request: TeamHubLocalSpeechActionRequest) => {
      if (!computerId) throw new Error("No computer selected");
      return actOnLocalComputerSpeech(client, tenantId, computerId, request);
    },
    mutationKey: localSpeechActionMutationKey(tenantId, computerId ?? ""),
    onError: (error) => {
      const code = error instanceof TeamHubError ? error.code : undefined;
      setActionError(speechActionErrorCopy(code, t));
    },
    onMutate: (request) => {
      setActionError(null);
      if (request.model_id) {
        setPendingByModel({
          action: request.action,
          modelId: request.model_id,
        });
      }
    },
    onSettled: () => {
      setPendingByModel(null);
      if (computerId) {
        void queryClient.invalidateQueries({
          queryKey: localSpeechQueryKey(tenantId, computerId),
        });
      }
      void refreshVoiceMediaPolicy(client, tenantId);
    },
  });

  const useModelMutation = useMutation({
    mutationFn: async (model: TeamHubLocalSpeechModel) => {
      if (!computerId) throw new Error("No computer selected");
      return activateLocalSpeechModel(
        client,
        tenantId,
        computerId,
        model.id,
        queryClient,
      );
    },
    onError: (error) => {
      const code = error instanceof TeamHubError ? error.code : undefined;
      setActionError(
        code ? speechActionErrorCopy(code, t) : t(m.errorSettingsSave),
      );
    },
    onMutate: (model) => {
      setActionError(null);
      setPendingByModel({ action: "use", modelId: model.id });
    },
    onSettled: () => {
      setPendingByModel(null);
      void queryClient.invalidateQueries({
        queryKey: voiceSettingsQueryKey(tenantId),
      });
      if (computerId) {
        void queryClient.invalidateQueries({
          queryKey: localSpeechQueryKey(tenantId, computerId),
        });
      }
    },
  });

  const refreshMutation = useMutation({
    mutationFn: async () => {
      if (!computerId) throw new Error("No computer selected");
      return refreshLocalComputerSpeech(client, tenantId, computerId);
    },
    onError: (error) => {
      const code = error instanceof TeamHubError ? error.code : undefined;
      setActionError(speechActionErrorCopy(code, t));
    },
    onMutate: () => setActionError(null),
    onSettled: () => {
      if (computerId) {
        void queryClient.invalidateQueries({
          queryKey: localSpeechQueryKey(tenantId, computerId),
        });
      }
    },
  });

  function handleDownload(model: TeamHubLocalSpeechModel) {
    actionMutation.mutate({
      action: "download",
      include_gpu_engine: settings.use_gpu && model.gpu_supported,
      model_id: model.id,
    });
  }

  function handleCancel(model: TeamHubLocalSpeechModel) {
    actionMutation.mutate({ action: "cancel", model_id: model.id });
  }

  function handleUse(model: TeamHubLocalSpeechModel) {
    useModelMutation.mutate(model);
  }

  function handleConfirmDelete() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    actionMutation.mutate({ action: "remove", model_id: target.id });
  }

  const runtime = view?.runtime;
  const showFallbackNotice = Boolean(
    view?.available &&
    runtime?.fallback_reason &&
    (settings.use_gpu || runtime.requested_device === "gpu"),
  );

  const selectedForLocal =
    settings.speech_provider !== "cloud" &&
    (!settings.local_computer_id || settings.local_computer_id === computerId);

  const compactHeader = compact ? (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium text-foreground">
          {t(m.speechModelHeading)}
        </h2>
        {view?.available && runtime ? (
          <RuntimeDevicePill runtime={runtime} />
        ) : null}
      </div>
      <Link
        className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        to={`/t/${tenantId}/settings/voice`}
      >
        {t(m.voiceSettingsLink)}
        <Icon icon={ArrowRight01Icon} size={14} />
      </Link>
    </div>
  ) : null;

  if (!computerId) {
    return (
      <div className="space-y-3">
        {compactHeader}
        <UnavailableCard
          onSwitchToCloud={onSwitchToCloud}
          tenantId={tenantId}
          title={t(m.unavailableNoComputerTitle)}
        >
          <RichMessage
            message={m.unavailableNoComputerBody}
            tags={{
              link: (text: ReactNode) => (
                <ComputersSettingsLink tenantId={tenantId}>
                  {text}
                </ComputersSettingsLink>
              ),
            }}
          />
        </UnavailableCard>
      </div>
    );
  }

  if (speechQuery.isLoading && !view) {
    return (
      <div className="space-y-3">
        {compactHeader}
        <div
          aria-busy="true"
          className="space-y-2.5 rounded-xl border border-border bg-card p-4"
          role="status"
        >
          <Skeleton className="h-5 w-44" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      </div>
    );
  }

  if (speechQuery.isError && !view) {
    const errorCode =
      speechQuery.error instanceof TeamHubError
        ? speechQuery.error.code
        : undefined;
    return (
      <div className="space-y-3">
        {compactHeader}
        <UnavailableCard
          actions={
            <Button onClick={() => void speechQuery.refetch()} size="compact">
              {t(commonMessages.tryAgain)}
            </Button>
          }
          onSwitchToCloud={onSwitchToCloud}
          tenantId={tenantId}
          title={t(m.loadFailedTitle)}
        >
          {speechActionErrorCopy(errorCode, t)}
        </UnavailableCard>
      </div>
    );
  }

  if (isOffline && (!view || !view.available || view.models.length === 0)) {
    return (
      <div className="space-y-3">
        {compactHeader}
        <UnavailableCard
          onSwitchToCloud={onSwitchToCloud}
          tenantId={tenantId}
          title={t(m.unavailableOfflineTitle, {
            name: resolvedComputerName || t(m.tabLocal),
          })}
        >
          <RichMessage
            message={m.unavailableOfflineBody}
            tags={{
              link: (text: ReactNode) => (
                <ComputersSettingsLink tenantId={tenantId}>
                  {text}
                </ComputersSettingsLink>
              ),
            }}
            values={{ name: resolvedComputerName || t(m.tabLocal) }}
          />
        </UnavailableCard>
      </div>
    );
  }

  if (view && !view.available) {
    const message = speechUnavailableMessage(view.reason?.code);
    return (
      <div className="space-y-3">
        {compactHeader}
        <UnavailableCard
          actions={
            canAct ? (
              <Button
                loading={refreshMutation.isPending}
                onClick={() => refreshMutation.mutate()}
                size="compact"
              >
                {refreshMutation.isPending ? null : (
                  <Icon icon={RefreshIcon} size={14} />
                )}
                {t(m.actionRefresh)}
              </Button>
            ) : null
          }
          onSwitchToCloud={onSwitchToCloud}
          tenantId={tenantId}
          title={t(m.speechModelHeading)}
        >
          <RichMessage
            message={message}
            tags={{
              link: (text: ReactNode) => (
                <ComputersSettingsLink tenantId={tenantId}>
                  {text}
                </ComputersSettingsLink>
              ),
            }}
          />
        </UnavailableCard>
      </div>
    );
  }

  const models = view?.models ?? [];

  return (
    <div className="space-y-3">
      {compactHeader}

      {!compact && view?.available ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {runtime ? <RuntimeDevicePill runtime={runtime} /> : null}
            {isOffline ? (
              <StatusPill tone="warning">
                {t(m.unavailableOfflineTitle, { name: resolvedComputerName })}
              </StatusPill>
            ) : null}
          </div>
          {canAct ? (
            <Button
              loading={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate()}
              size="compact"
              tone="ghost"
            >
              {refreshMutation.isPending ? null : (
                <Icon icon={RefreshIcon} size={14} />
              )}
              {t(m.actionRefresh)}
            </Button>
          ) : null}
        </div>
      ) : null}

      {isOffline && view?.models.length ? (
        <FormFeedback tone="warning">
          <RichMessage
            message={m.unavailableOfflineBody}
            tags={{
              link: (text: ReactNode) => (
                <ComputersSettingsLink tenantId={tenantId}>
                  {text}
                </ComputersSettingsLink>
              ),
            }}
            values={{ name: resolvedComputerName || t(m.tabLocal) }}
          />
        </FormFeedback>
      ) : null}

      {view && !view.viewer_is_owner ? (
        <FormFeedback tone="info">{t(m.unavailableReadOnly)}</FormFeedback>
      ) : null}

      {showFallbackNotice && runtime?.fallback_reason ? (
        <FormFeedback tone={fallbackBannerTone(runtime.fallback_reason)}>
          {fallbackReasonCopy(runtime.fallback_reason, t)}
        </FormFeedback>
      ) : null}

      {actionError ? (
        <FormFeedback tone="danger">{actionError}</FormFeedback>
      ) : null}

      <div className="space-y-2.5">
        {models.map((model) => {
          const isSelected =
            selectedForLocal &&
            (model.active ||
              (settings.local_model_id !== null &&
                settings.local_model_id === model.id &&
                (model.state === "idle" ||
                  model.state === "loading" ||
                  model.state === "loaded")));
          const isPending = pendingByModel?.modelId === model.id;
          return (
            <SpeechModelRow
              canAct={canAct}
              isSelected={isSelected}
              key={model.id}
              model={model}
              onCancel={() => handleCancel(model)}
              onDelete={() => setDeleteTarget(model)}
              onDownload={() => handleDownload(model)}
              onUse={() => handleUse(model)}
              pendingAction={isPending ? pendingByModel.action : undefined}
              runtime={runtime}
            />
          );
        })}
      </div>

      {deleteTarget ? (
        <ModalDialog
          closeOnBackdrop
          footer={
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => setDeleteTarget(null)}
                size="compact"
                tone="secondary"
              >
                {t(commonMessages.cancel)}
              </Button>
              <Button
                data-voice-risk="never"
                onClick={handleConfirmDelete}
                size="compact"
                tone="danger"
              >
                {t(m.deleteDialogConfirm)}
              </Button>
            </div>
          }
          onClose={() => setDeleteTarget(null)}
          size="sm"
          title={t(m.deleteDialogTitle)}
        >
          <p className="px-5 py-4 text-sm text-muted-foreground">
            {t(m.deleteDialogBody, {
              name: deleteTarget.name,
              size: formatSpeechSize(deleteTarget.disk_size_bytes, t),
            })}
          </p>
        </ModalDialog>
      ) : null}
    </div>
  );
}

function RuntimeDevicePill({
  runtime,
}: {
  runtime: TeamHubLocalSpeechRuntime;
}) {
  const t = useT();
  if (runtime.effective_device) {
    const gpu = isGpuDevice(runtime.effective_device);
    return (
      <span
        className={cn(
          "inline-flex h-[22px] items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
          gpu
            ? "bg-[var(--app-status-success-surface)] text-app-success"
            : "bg-muted text-secondary-foreground",
        )}
        data-speech-device={runtime.effective_device}
      >
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 rounded-full",
            gpu ? "bg-app-success" : "bg-muted-foreground/70",
          )}
        />
        {effectiveDeviceLabel(runtime.effective_device, t)}
      </span>
    );
  }
  if (runtime.state === "loading") {
    return (
      <StatusPill tone="info">
        <span className="town-shimmer-text">{t(m.runtimeLoading)}</span>
      </StatusPill>
    );
  }
  if (runtime.state === "error") {
    return <StatusPill tone="danger">{t(m.runtimeError)}</StatusPill>;
  }
  return <StatusPill>{t(m.runtimeStandby)}</StatusPill>;
}

function SpeechModelRow({
  canAct,
  isSelected,
  model,
  onCancel,
  onDelete,
  onDownload,
  onUse,
  pendingAction,
  runtime,
}: {
  canAct: boolean;
  isSelected: boolean;
  model: TeamHubLocalSpeechModel;
  onCancel: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onUse: () => void;
  pendingAction?: TeamHubLocalSpeechActionRequest["action"] | "use";
  runtime?: TeamHubLocalSpeechRuntime;
}) {
  const t = useT();
  const isDownloading =
    model.state === "downloading" || pendingAction === "download";
  const isLoading = model.state === "loading";
  const isLoaded = model.state === "loaded";
  const isIdle = model.state === "idle";
  const isFailed = model.state === "failed";
  const isAbsent = model.state === "absent" && pendingAction !== "download";
  const isInUse = isLoaded || (isSelected && (isIdle || isLoading));

  const needsDisclosure = requiresLicenseDisclosure(model);
  const licenseName = formatLicenseDisplayName(model.license);
  const progressPercent = formatSpeechDownloadPercent(model.download);
  const sizeLabel = formatSpeechSize(model.disk_size_bytes, t);
  const qualityLabel = speechModelQualityLabel(model, t);

  const deviceBadge =
    isInUse && runtime?.active_model === model.id && runtime.effective_device
      ? isGpuDevice(runtime.effective_device)
        ? t(m.badgeGpu)
        : t(m.badgeCpu)
      : isInUse && !model.gpu_supported
        ? t(m.badgeCpu)
        : null;

  const statusDotClass = isInUse
    ? "bg-app-success"
    : isDownloading || isLoading
      ? "bg-app-info"
      : isFailed
        ? "bg-app-danger"
        : isIdle
          ? "bg-muted-foreground/60"
          : undefined;

  const statusLabel =
    pendingAction === "cancel"
      ? t(m.endingCancel)
      : pendingAction === "remove"
        ? t(m.endingRemove)
        : isDownloading
          ? model.download
            ? formatSpeechDownloadStats(model.download, t)
            : t(m.statusDownloading)
          : isLoading
            ? t(m.statusLoading)
            : isInUse
              ? t(m.statusInUse)
              : isIdle
                ? t(m.statusDownloaded)
                : isFailed
                  ? t(m.statusFailed)
                  : t(m.statusNotDownloaded);

  const cardClasses = cn(
    "rounded-xl border transition-colors",
    isFailed
      ? "border-[var(--app-status-danger-border)] bg-card"
      : isInUse
        ? "border-border-hover bg-muted/35"
        : "border-border bg-card hover:border-border-hover",
  );

  return (
    <div className={cardClasses} data-speech-model={model.id}>
      <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            aria-hidden="true"
            className={cn(
              "mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg",
              isInUse
                ? "bg-[var(--app-status-success-surface)] text-app-success"
                : "bg-muted text-muted-foreground",
            )}
          >
            <Icon icon={Mic01Icon} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium text-foreground">
                {model.name}
              </span>
              <span className="inline-flex h-[20px] items-center rounded-sm bg-muted px-1.5 text-[11px] font-medium text-secondary-foreground">
                {qualityLabel}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                {sizeLabel}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {speechModelDescription(model, t)}
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5 tabular-nums">
                {statusDotClass ? (
                  <span
                    aria-hidden="true"
                    className={cn("size-1.5 rounded-full", statusDotClass)}
                  />
                ) : null}
                <span
                  className={cn(
                    isInUse && "font-medium text-app-success",
                    isFailed && "text-app-danger",
                    (isDownloading || isLoading) && "town-shimmer-text",
                  )}
                >
                  {statusLabel}
                </span>
              </span>
              {!needsDisclosure ? (
                <a
                  className="inline-flex items-center gap-1 text-muted-foreground underline decoration-border underline-offset-2 hover:text-foreground"
                  href={model.license_url}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {t(m.modelLicensePrefix)} {licenseName}
                  <Icon icon={LinkSquare02Icon} size={12} />
                </a>
              ) : null}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 pl-12 sm:pl-0">
          {isAbsent ? (
            <Button
              disabled={!canAct || pendingAction !== undefined}
              onClick={onDownload}
              size="compact"
              tone="secondary"
            >
              <Icon icon={Download04Icon} size={14} />
              {t(m.actionDownload)}
            </Button>
          ) : null}

          {isDownloading ? (
            <Button
              disabled={!canAct || pendingAction === "cancel"}
              loading={pendingAction === "cancel"}
              onClick={onCancel}
              size="compact"
              tone="secondary"
            >
              {t(m.actionCancel)}
            </Button>
          ) : null}

          {isIdle && !isInUse ? (
            <>
              <Button
                disabled={!canAct || pendingAction !== undefined}
                loading={pendingAction === "use"}
                onClick={onUse}
                size="compact"
                tone="primary"
              >
                {t(m.actionUse)}
              </Button>
              <Button
                aria-label={`${t(m.actionDelete)} ${model.name}`}
                data-voice-risk="never"
                disabled={!canAct || pendingAction !== undefined}
                onClick={onDelete}
                size="compact"
                tone="ghost"
              >
                <Icon icon={Delete02Icon} size={14} />
                {t(m.actionDelete)}
              </Button>
            </>
          ) : null}

          {isInUse ? (
            <>
              <span className="inline-flex h-[26px] items-center gap-1.5 rounded-md bg-[var(--app-status-success-surface)] px-2.5 text-xs font-medium text-app-success">
                <Icon icon={Tick02Icon} size={14} />
                {t(m.statusInUse)}
              </span>
              {deviceBadge ? (
                <span className="inline-flex h-[26px] items-center rounded-md border border-border bg-card px-2 text-xs font-medium text-secondary-foreground">
                  {deviceBadge}
                </span>
              ) : null}
              <Button
                aria-label={`${t(m.actionDelete)} ${model.name}`}
                data-voice-risk="never"
                disabled={!canAct || pendingAction !== undefined}
                onClick={onDelete}
                size="compact"
                tone="ghost"
              >
                <Icon icon={Delete02Icon} size={14} />
                {t(m.actionDelete)}
              </Button>
            </>
          ) : null}

          {isFailed ? (
            <Button
              disabled={!canAct || pendingAction !== undefined}
              onClick={onDownload}
              size="compact"
              tone="secondary"
            >
              {t(m.actionRetry)}
            </Button>
          ) : null}
        </div>
      </div>

      {isDownloading ? (
        <div className="px-4 pb-3.5">
          <div
            aria-label={t(m.downloadProgressLabel, { name: model.name })}
            aria-valuemax={100}
            aria-valuemin={0}
            aria-valuenow={progressPercent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="progressbar"
          >
            <div
              className="h-full rounded-full bg-app-info transition-[width] duration-200"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      ) : null}

      {isFailed && model.error?.message ? (
        <div className="px-4 pb-3.5">
          <p className="text-xs text-app-danger" role="alert">
            {model.error.message}
          </p>
        </div>
      ) : null}

      {needsDisclosure ? (
        <div className="border-t border-border/70 bg-muted/25 px-4 py-2 text-xs text-muted-foreground">
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
            <span>{t(m.modelLicenseOptInNotice)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function UnavailableCard({
  actions,
  children,
  onSwitchToCloud,
  tenantId,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  onSwitchToCloud?: () => void;
  tenantId: string;
  title: string;
}) {
  const t = useT();
  return (
    <div
      className="rounded-xl border border-border bg-card p-5"
      data-tenant-id={tenantId}
    >
      <h3 className="text-sm font-medium text-foreground">{title}</h3>
      <p className="mt-1.5 text-sm text-muted-foreground">{children}</p>
      {actions || onSwitchToCloud ? (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {onSwitchToCloud ? (
            <Button onClick={onSwitchToCloud} size="compact" tone="primary">
              {t(m.actionSwitchToCloud)}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}

function ComputersSettingsLink({
  children,
  tenantId,
}: {
  children: ReactNode;
  tenantId: string;
}) {
  return (
    <Link
      className="font-medium text-foreground underline underline-offset-2 hover:text-app-info"
      to={`/t/${tenantId}/settings/computers`}
    >
      {children}
    </Link>
  );
}
