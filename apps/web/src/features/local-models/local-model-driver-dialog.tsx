import {
  Copy01Icon,
  LinkSquare02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  NVIDIA_DRIVER_DOWNLOAD_URL,
  NVIDIA_DRIVER_GUIDE_URL,
  NVIDIA_SMI_VERIFY_COMMAND,
  classifyWindowsNvidiaGpu,
  linuxNvidiaDriverCommand,
  minNvidiaDriverForCuda,
  type DesktopDriverInstallState,
  type LinuxNvidiaDistro,
} from "@linger/service-kit/nvidia-driver";
import { useEffect, useRef, useState } from "react";

import { Button, buttonClassName } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format-bytes";

import { useDesktopDriverUpdate } from "./desktop-driver-update";
import { localModelsMessages as m } from "./local-models.messages";
import type { LocalModel, LocalModelsView } from "./local-models-queries";

export interface DriverUpdateReason {
  readonly required_cuda?: string;
  readonly detected_cuda?: string;
  readonly driver_version?: string;
}

const AUTO_RECHECK_COOLDOWN_MS = 3000;
const IDLE_DRIVER_INSTALL_STATE: DesktopDriverInstallState = { phase: "idle" };

function installFailureMessage(code: string) {
  switch (code) {
    case "UNSUPPORTED_GPU":
      return m.driverDialogErrorUnsupportedGpu;
    case "LOOKUP_FAILED":
      return m.driverDialogErrorLookupFailed;
    case "VERSION_TOO_OLD":
      return m.driverDialogErrorVersionTooOld;
    case "DOWNLOAD_FAILED":
      return m.driverDialogErrorDownloadFailed;
    case "SIGNATURE_INVALID":
      return m.driverDialogErrorSignatureInvalid;
    case "UAC_CANCELLED":
      return m.driverDialogErrorUacCancelled;
    default:
      return m.driverDialogErrorInstallFailed;
  }
}

function isDirectInstallBusy(state: DesktopDriverInstallState): boolean {
  return (
    state.phase === "downloading" ||
    state.phase === "verifying" ||
    state.phase === "installing"
  );
}

/**
 * Guides the owner through updating an outdated NVIDIA graphics driver:
 * supports signed one-click Windows installation when available on Linger
 * Desktop, launches NVIDIA App when installed, links to NVIDIA's official
 * download portal, shows copyable Linux distro commands, and auto-rechecks
 * when installation completes or the window regains focus.
 */
export function UpdateDriverDialog({
  isLocalDesktop,
  model,
  offline = false,
  onClose,
  onRecheck,
  reason,
  rechecking = false,
  view,
}: {
  isLocalDesktop: boolean;
  model?: LocalModel;
  offline?: boolean;
  onClose: () => void;
  onRecheck?: () => void;
  reason: DriverUpdateReason;
  rechecking?: boolean;
  view: LocalModelsView;
}) {
  const t = useT();
  const host = view.computer.host;
  const platform = host?.platform ?? "windows";
  const gpuName = host?.gpus[0]?.name;
  const requiredDriver = minNvidiaDriverForCuda(reason.required_cuda);
  const desktopBridge = useDesktopDriverUpdate(isLocalDesktop);
  const nvidiaApp = desktopBridge?.capabilities?.nvidiaApp ?? "none";
  const installState = desktopBridge?.installState ?? IDLE_DRIVER_INSTALL_STATE;
  const directInstallBusy = isDirectInstallBusy(installState);
  const canDirectInstall =
    isLocalDesktop &&
    platform === "windows" &&
    Boolean(desktopBridge?.capabilities?.directInstallSupported) &&
    classifyWindowsNvidiaGpu(gpuName) !== "unsupported";

  const [distro, setDistro] = useState<LinuxNvidiaDistro>("ubuntu");
  const [copiedTarget, setCopiedTarget] = useState<"command" | "gpu" | null>(
    null,
  );
  const [copyError, setCopyError] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launchedApp, setLaunchedApp] = useState<string | null>(null);

  const didOpenExternalRef = useRef(false);
  const lastAutoRecheckRef = useRef(0);
  const completedRecheckedVersionRef = useRef<string | null>(null);
  const onRecheckRef = useRef(onRecheck);
  useEffect(() => {
    onRecheckRef.current = onRecheck;
  }, [onRecheck]);

  // Re-probe automatically when the user switches back from NVIDIA App or a
  // browser download, matching how desktop permission flows pick up changes.
  useEffect(() => {
    if (offline) return;
    function handleFocus() {
      if (!didOpenExternalRef.current || !onRecheckRef.current) return;
      const now = Date.now();
      if (now - lastAutoRecheckRef.current < AUTO_RECHECK_COOLDOWN_MS) return;
      lastAutoRecheckRef.current = now;
      onRecheckRef.current();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [offline]);

  // Trigger an automatic recheck once a direct Windows install completes.
  useEffect(() => {
    if (offline || installState.phase !== "completed") return;
    if (completedRecheckedVersionRef.current === installState.version) return;
    completedRecheckedVersionRef.current = installState.version;
    onRecheckRef.current?.();
  }, [installState, offline]);

  useEffect(() => {
    if (!copiedTarget) return;
    const timer = window.setTimeout(() => setCopiedTarget(null), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedTarget]);

  const liveModel = model
    ? view.models.find((item) => item.model.id === model.id)?.model
    : undefined;
  const resolved = liveModel
    ? liveModel.availability.downloadable ||
      liveModel.state !== "absent" ||
      liveModel.availability.reason?.code !== "DRIVER_UPDATE_REQUIRED"
    : view.models.some(
        (item) =>
          item.model.availability.downloadable || item.model.state !== "absent",
      );

  const currentVersion =
    reason.driver_version && reason.detected_cuda
      ? t(m.driverDialogCurrentDriverCuda, {
          cuda: reason.detected_cuda,
          driver: reason.driver_version,
        })
      : reason.detected_cuda
        ? t(m.driverDialogCurrentCudaOnly, { cuda: reason.detected_cuda })
        : t(m.driverDialogCurrentUnknown);

  const requiredVersion =
    requiredDriver && reason.required_cuda
      ? t(m.driverDialogRequiredDriverCuda, {
          cuda: reason.required_cuda,
          driver: requiredDriver,
        })
      : reason.required_cuda
        ? t(m.driverDialogRequiredCudaOnly, { cuda: reason.required_cuda })
        : t(m.driverDialogRequiredLatest);

  const nvidiaAppLabel =
    nvidiaApp === "geforce_experience" ? "GeForce Experience" : "NVIDIA App";

  async function copyText(text: string, target: "command" | "gpu") {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTarget(target);
    } catch {
      setCopyError(true);
    }
  }

  async function handleStartDirectInstall() {
    if (!desktopBridge) return;
    setLaunchError(null);
    setLaunchedApp(null);
    const result = await desktopBridge.api.startInstall({
      ...(gpuName ? { gpuName } : {}),
      ...(reason.required_cuda ? { requiredCuda: reason.required_cuda } : {}),
      ...(model ? { resumeModelId: model.id } : {}),
    });
    if (!result.ok && result.reason === "failed") {
      setLaunchError(t(m.driverDialogErrorInstallFailed));
    }
  }

  async function handleOpenNvidiaApp() {
    if (!desktopBridge) return;
    setLaunchError(null);
    didOpenExternalRef.current = true;
    const result = await desktopBridge.api.openNvidiaApp();
    if (result.ok) {
      setLaunchedApp(nvidiaAppLabel);
    } else {
      setLaunchError(t(m.driverDialogLaunchFailed, { app: nvidiaAppLabel }));
    }
  }

  async function handleOpenOfficialDownload() {
    setLaunchError(null);
    didOpenExternalRef.current = true;
    if (desktopBridge) {
      const result = await desktopBridge.api.openOfficialDownload();
      if (result.ok) return;
    }
    window.open(NVIDIA_DRIVER_DOWNLOAD_URL, "_blank", "noopener,noreferrer");
  }

  async function handleOpenGuide() {
    didOpenExternalRef.current = true;
    if (desktopBridge) {
      const result = await desktopBridge.api.openGuide();
      if (result.ok) return;
    }
    window.open(NVIDIA_DRIVER_GUIDE_URL, "_blank", "noopener,noreferrer");
  }

  const linuxCommand = linuxNvidiaDriverCommand(distro, requiredDriver);
  const downloadPercent =
    installState.phase === "downloading" &&
    installState.totalBytes &&
    installState.totalBytes > 0
      ? Math.min(
          100,
          Math.round(
            (installState.completedBytes / installState.totalBytes) * 100,
          ),
        )
      : undefined;

  return (
    <ModalDialog
      description={
        model
          ? t(m.driverDialogDescriptionForModel, {
              computer: view.computer.display_name,
              model: model.name,
            })
          : t(m.driverDialogDescriptionHost, {
              computer: view.computer.display_name,
            })
      }
      footer={
        <>
          {onRecheck && !offline ? (
            <Button
              disabled={directInstallBusy}
              loading={rechecking}
              onClick={onRecheck}
              size="default"
              tone="secondary"
            >
              {t(m.driverCheckAgain)}
            </Button>
          ) : null}
          <Button
            data-voice-close
            onClick={onClose}
            size="default"
            tone={
              resolved ||
              installState.phase === "reboot_required" ||
              installState.phase === "completed"
                ? "primary"
                : "secondary"
            }
          >
            {t(commonMessages.done)}
          </Button>
        </>
      }
      onClose={onClose}
      size="md"
      title={t(m.driverDialogTitle)}
    >
      <div className="grid gap-4 px-5 py-4">
        {resolved ? (
          <FormFeedback tone="success">
            {t(m.driverDialogReadyBanner)}
          </FormFeedback>
        ) : null}

        <div className="rounded-xl border border-border bg-muted/60 px-3.5 py-3">
          <dl className="grid gap-1.5 text-sm">
            {gpuName ? (
              <div className="flex items-center justify-between gap-2">
                <dt className="text-muted-foreground">
                  {t(m.driverDialogGpuLabel)}
                </dt>
                <dd className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
                  <span className="truncate">{gpuName}</span>
                  <Button
                    aria-label={t(m.driverDialogCopyGpu)}
                    onClick={() => void copyText(gpuName, "gpu")}
                    size="compactIcon"
                    title={t(m.driverDialogCopyGpu)}
                    tone="ghost"
                  >
                    <Icon
                      icon={copiedTarget === "gpu" ? Tick02Icon : Copy01Icon}
                      size={14}
                    />
                  </Button>
                </dd>
              </div>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t(m.driverDialogCurrentLabel)}
              </dt>
              <dd className="font-mono text-xs text-foreground">
                {currentVersion}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-2">
              <dt className="text-muted-foreground">
                {t(m.driverDialogRequiredLabel)}
              </dt>
              <dd className="font-mono text-xs font-medium text-foreground">
                {requiredVersion}
              </dd>
            </div>
          </dl>
          <p className="mt-2.5 border-t border-border/70 pt-2 text-xs text-muted-foreground">
            {t(m.driverDialogNoToolkitNote)}
          </p>
        </div>

        {installState.phase === "downloading" ? (
          <div className="grid gap-2 rounded-xl border border-border bg-card px-3.5 py-3">
            <p className="text-xs font-medium text-foreground tabular-nums">
              {installState.totalBytes && downloadPercent !== undefined
                ? t(m.driverDialogDownloadingProgress, {
                    done: formatBytes(installState.completedBytes),
                    percent: String(downloadPercent),
                    total: formatBytes(installState.totalBytes),
                    version: installState.version,
                  })
                : t(m.driverDialogDownloading, {
                    version: installState.version,
                  })}
            </p>
            <div
              aria-valuemax={100}
              aria-valuemin={0}
              aria-valuenow={downloadPercent ?? 0}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
            >
              <div
                className="h-full rounded-full bg-foreground transition-[width] duration-200 motion-reduce:transition-none"
                style={{ width: `${downloadPercent ?? 12}%` }}
              />
            </div>
          </div>
        ) : installState.phase === "verifying" ? (
          <FormFeedback tone="info">
            {t(m.driverDialogVerifying, { version: installState.version })}
          </FormFeedback>
        ) : installState.phase === "installing" ? (
          <FormFeedback tone="info">
            {t(m.driverDialogInstalling, { version: installState.version })}
          </FormFeedback>
        ) : installState.phase === "reboot_required" ? (
          <FormFeedback tone="warning">
            {t(m.driverDialogRebootRequired, { version: installState.version })}
          </FormFeedback>
        ) : installState.phase === "completed" && !resolved ? (
          <FormFeedback tone="success">
            {t(m.driverDialogInstallComplete, {
              version: installState.version,
            })}
          </FormFeedback>
        ) : installState.phase === "failed" ? (
          <FormFeedback tone="warning">
            {t(installFailureMessage(installState.code))}
          </FormFeedback>
        ) : null}

        {resolved ||
        installState.phase === "reboot_required" ||
        installState.phase === "completed" ? null : platform === "linux" ? (
          <div className="grid gap-2.5">
            <p className="text-sm text-muted-foreground">
              {t(m.driverDialogLinuxHint, {
                computer: view.computer.display_name,
              })}
            </p>
            <div className="flex flex-wrap items-center gap-1.5" role="tablist">
              {(
                [
                  ["ubuntu", m.driverDialogLinuxUbuntuTab],
                  ["fedora", m.driverDialogLinuxFedoraTab],
                ] as const
              ).map(([id, label]) => (
                <button
                  aria-selected={distro === id}
                  className={cn(
                    "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    distro === id
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-secondary-foreground hover:bg-accent",
                  )}
                  key={id}
                  onClick={() => setDistro(id)}
                  role="tab"
                  type="button"
                >
                  {t(label)}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-foreground">
                {linuxCommand}
              </code>
              <Button
                aria-label={t(m.driverDialogCopyCommand)}
                className="shrink-0"
                onClick={() => void copyText(linuxCommand, "command")}
                size="compact"
                tone="secondary"
              >
                <Icon
                  icon={copiedTarget === "command" ? Tick02Icon : Copy01Icon}
                  size={14}
                />
                <span>
                  {t(
                    copiedTarget === "command"
                      ? commonMessages.copied
                      : commonMessages.copy,
                  )}
                </span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {t(m.driverDialogVerifyHint)}{" "}
              <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-foreground">
                {NVIDIA_SMI_VERIFY_COMMAND}
              </code>
            </p>
          </div>
        ) : (
          <div className="grid gap-2.5">
            {canDirectInstall ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    disabled={directInstallBusy}
                    loading={directInstallBusy}
                    onClick={() => void handleStartDirectInstall()}
                    size="default"
                    tone="primary"
                  >
                    {t(m.driverDialogInstallUpdate)}
                  </Button>
                  {nvidiaApp !== "none" ? (
                    <Button
                      disabled={directInstallBusy}
                      onClick={() => void handleOpenNvidiaApp()}
                      size="default"
                      tone="secondary"
                    >
                      {t(
                        nvidiaApp === "geforce_experience"
                          ? m.driverDialogOpenGfe
                          : m.driverDialogOpenNvidiaApp,
                      )}
                    </Button>
                  ) : (
                    <Button
                      disabled={directInstallBusy}
                      onClick={() => void handleOpenOfficialDownload()}
                      size="default"
                      tone="secondary"
                    >
                      <span>{t(m.driverDialogDownloadOfficial)}</span>
                      <Icon icon={LinkSquare02Icon} size={14} />
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(m.driverDialogDirectInstallHint)}
                </p>
              </>
            ) : isLocalDesktop && nvidiaApp !== "none" ? (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={() => void handleOpenNvidiaApp()}
                    size="default"
                    tone="primary"
                  >
                    {t(
                      nvidiaApp === "geforce_experience"
                        ? m.driverDialogOpenGfe
                        : m.driverDialogOpenNvidiaApp,
                    )}
                  </Button>
                  <Button
                    onClick={() => void handleOpenOfficialDownload()}
                    size="default"
                    tone="secondary"
                  >
                    <span>{t(m.driverDialogDownloadOfficial)}</span>
                    <Icon icon={LinkSquare02Icon} size={14} />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(m.driverDialogNvidiaAppSteps, { app: nvidiaAppLabel })}
                </p>
              </>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  {desktopBridge ? (
                    <Button
                      onClick={() => void handleOpenOfficialDownload()}
                      size="default"
                      tone="primary"
                    >
                      <span>{t(m.driverDialogDownloadOfficial)}</span>
                      <Icon icon={LinkSquare02Icon} size={14} />
                    </Button>
                  ) : (
                    <a
                      className={buttonClassName({
                        size: "default",
                        tone: "primary",
                      })}
                      href={NVIDIA_DRIVER_DOWNLOAD_URL}
                      onClick={() => {
                        didOpenExternalRef.current = true;
                      }}
                      rel="noopener noreferrer"
                      target="_blank"
                    >
                      <span>{t(m.driverDialogDownloadOfficial)}</span>
                      <Icon icon={LinkSquare02Icon} size={14} />
                    </a>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t(m.driverDialogWindowsManualHint)}
                </p>
              </>
            )}
            <p className="text-xs text-muted-foreground">
              {t(m.driverDialogWindowsRestartNote)}
            </p>
          </div>
        )}

        {launchedApp ? (
          <FormFeedback tone="info">
            {t(m.driverDialogNvidiaAppSteps, { app: launchedApp })}
          </FormFeedback>
        ) : null}
        {launchError ? (
          <FormFeedback tone="warning">{launchError}</FormFeedback>
        ) : null}
        {copyError ? (
          <FormFeedback tone="warning">
            {t(m.driverDialogCopyFailed)}
          </FormFeedback>
        ) : null}

        <div className="flex items-center justify-between border-t border-border/70 pt-2.5 text-xs">
          {desktopBridge ? (
            <button
              className="inline-flex items-center gap-1 font-medium text-app-link underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => void handleOpenGuide()}
              type="button"
            >
              <span>{t(m.driverDialogReadGuide)}</span>
              <Icon icon={LinkSquare02Icon} size={14} />
            </button>
          ) : (
            <a
              className="inline-flex items-center gap-1 font-medium text-app-link underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={NVIDIA_DRIVER_GUIDE_URL}
              onClick={() => {
                didOpenExternalRef.current = true;
              }}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span>{t(m.driverDialogReadGuide)}</span>
              <Icon icon={LinkSquare02Icon} size={14} />
            </a>
          )}
        </div>
      </div>
    </ModalDialog>
  );
}
