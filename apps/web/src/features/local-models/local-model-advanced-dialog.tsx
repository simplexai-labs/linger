import {
  CommandLineIcon,
  Copy01Icon,
  Download04Icon,
  Folder01Icon,
  LinkSquare02Icon,
  Tick02Icon,
  ViewIcon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { useTabIndicator } from "@/components/ui/tab-indicator";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  desktopDiagnostics,
  desktopLocalGateway,
  type DesktopLocalGatewayInfo,
} from "./desktop-local-gateway";
import { CopyEndpoint, Fact } from "./local-model-details";
import { localModelsMessages as m } from "./local-models.messages";
import type { LocalModelPool, LocalModelsView } from "./local-models-queries";
import {
  formatGigabytes,
  gatewayAdminUrl,
  gatewayCurlSnippet,
  gatewayModelId,
  isLoopbackUrl,
  modelEntries,
  poolFreeBytes,
  poolLabel,
  poolOtherBytes,
  poolUnaccountedBytes,
  sharedGatewayEndpoint,
  type ModelEntry,
} from "./local-models-rules";

/** Category colors from the Nature palette, one per model holding memory. */
const segmentColors = ["bg-rain-500", "bg-lichen-500", "bg-sun-500"] as const;
/** Foundation components hold memory too, but are not models of the list. */
const componentColor = "bg-muted-foreground/40";

type AdvancedTab = "gateway" | "hardware" | "diagnostics";
const advancedTabs: readonly AdvancedTab[] = [
  "gateway",
  "hardware",
  "diagnostics",
];

function useCopiedFlag(durationMs = 1_500) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  function mark(key: string) {
    window.clearTimeout(timerRef.current);
    setCopiedKey(key);
    timerRef.current = window.setTimeout(() => setCopiedKey(null), durationMs);
  }

  function copyText(key: string, text: string) {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(text).then(
        () => mark(key),
        () => undefined,
      );
    }
  }

  return { copiedKey, copyText, mark };
}

function PoolBar({
  colorOf,
  pool,
  view,
}: {
  colorOf: (holderId: string) => string;
  pool: LocalModelPool;
  view: LocalModelsView;
}) {
  const t = useT();
  const label = poolLabel(view, pool, t);
  // used_bytes is the device's real use; on a shared card other processes
  // hold memory that no holder accounts for.
  const otherBytes = poolOtherBytes(pool);
  const unaccountedBytes = poolUnaccountedBytes(pool);
  const width = (bytes: number) =>
    `${pool.total_bytes ? Math.min(100, (bytes / pool.total_bytes) * 100) : 0}%`;
  return (
    <div className="flex min-h-10 items-center gap-3 py-2 text-sm">
      <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">
        {pool.kind === "gpu"
          ? t(m.gpuIndex, { index: String(pool.gpu_index) })
          : label}
      </span>
      <span
        aria-label={t(m.poolInUse, {
          pool: label,
          total: formatGigabytes(pool.total_bytes, t),
          used: formatGigabytes(pool.used_bytes, t),
        })}
        className="flex h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
      >
        {pool.holders
          .filter((holder) => holder.bytes > 0)
          .map((holder) => (
            <span
              className={cn(
                "h-full border-r-2 border-card last:border-r-0",
                colorOf(holder.id),
              )}
              key={holder.id}
              style={{ width: width(holder.bytes) }}
              title={`${holder.name} · ${formatGigabytes(holder.bytes, t)}`}
            />
          ))}
        {otherBytes ? (
          <span
            className="h-full bg-muted-foreground/30"
            style={{ width: width(otherBytes) }}
            title={t(m.otherAppsSize, {
              size: formatGigabytes(otherBytes, t),
            })}
          />
        ) : null}
        {unaccountedBytes ? (
          <span
            className="h-full bg-muted-foreground/15"
            style={{ width: width(unaccountedBytes) }}
            title={t(m.systemAndEngineSize, {
              size: formatGigabytes(unaccountedBytes, t),
            })}
          />
        ) : null}
      </span>
      <span className="w-24 shrink-0 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground">
        {t(m.memoryFree, { free: formatGigabytes(poolFreeBytes(pool), t) })}
      </span>
    </div>
  );
}

function GatewayTabPanel({
  computerId,
  computerName,
  desktopGatewayInfo,
  gatewayEndpoint,
  adminUrl,
  isLocalDesktop,
  loadedEntries,
}: {
  adminUrl?: string;
  computerId: string;
  computerName: string;
  desktopGatewayInfo?: DesktopLocalGatewayInfo;
  gatewayEndpoint?: string;
  isLocalDesktop: boolean;
  loadedEntries: readonly ModelEntry[];
}) {
  const t = useT();
  const [localGateway] = useState(desktopLocalGateway);
  const [revealedPassword, setRevealedPassword] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [copyingPassword, setCopyingPassword] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const { copiedKey, copyText, mark } = useCopiedFlag(2_000);

  // Clear revealed secrets when switching computers or unmounting this tab.
  useEffect(() => {
    setRevealedPassword(null);
    setCredentialError(null);
    return () => setRevealedPassword(null);
  }, [computerId]);

  const effectiveAdminUrl = adminUrl ?? desktopGatewayInfo?.adminUrl;
  const loopback = isLoopbackUrl(gatewayEndpoint ?? effectiveAdminUrl);
  const inferenceAuthDisabled =
    desktopGatewayInfo?.inferenceAuthDisabled ?? true;
  const gatewayModels = loadedEntries
    .map((entry) => ({
      entry,
      modelId: gatewayModelId(entry.model),
    }))
    .filter((item): item is { entry: ModelEntry; modelId: string } =>
      Boolean(item.modelId),
    );
  const canUseDesktopGateway = Boolean(
    isLocalDesktop && localGateway && desktopGatewayInfo?.available,
  );
  const canOpenDesktopAdmin = Boolean(
    canUseDesktopGateway && desktopGatewayInfo?.adminUrl,
  );

  function toggleRevealPassword() {
    if (!localGateway) return;
    if (revealedPassword !== null) {
      setRevealedPassword(null);
      return;
    }
    setCredentialError(null);
    setRevealing(true);
    void localGateway
      .revealPassword(computerId)
      .then((result) => setRevealedPassword(result.password))
      .catch(() => setCredentialError(t(m.gatewayCredentialReadFailed)))
      .finally(() => setRevealing(false));
  }

  function copyDesktopPassword() {
    if (!localGateway) return;
    setCredentialError(null);
    setCopyingPassword(true);
    void localGateway
      .copyPassword(computerId)
      .then(() => mark("password"))
      .catch(() => setCredentialError(t(m.gatewayCredentialReadFailed)))
      .finally(() => setCopyingPassword(false));
  }

  function openDesktopAdmin() {
    if (!localGateway) return;
    setCredentialError(null);
    void localGateway
      .openAdmin(computerId)
      .catch(() => setCredentialError(t(m.gatewayOpenAdminFailed)));
  }

  function openDesktopFolder() {
    if (!localGateway) return;
    setCredentialError(null);
    void localGateway
      .openFolder(computerId)
      .catch(() => setCredentialError(t(m.gatewayOpenFolderFailed)));
  }

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          {t(m.gatewaySection)}
        </h3>
        {gatewayEndpoint || effectiveAdminUrl ? (
          <>
            <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
              {gatewayEndpoint ? (
                <Fact
                  className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
                  label={t(m.gatewayApiEndpoint)}
                >
                  <CopyEndpoint
                    ariaLabel={t(m.copyGatewayEndpoint)}
                    copiedAriaLabel={t(m.copiedGatewayEndpoint)}
                    endpoint={gatewayEndpoint}
                    title={t(m.copyGatewayEndpoint)}
                  />
                </Fact>
              ) : null}
              {effectiveAdminUrl ? (
                <Fact
                  className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
                  label={t(m.gatewayAdminConsole)}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <CopyEndpoint
                      ariaLabel={t(m.copyGatewayAdminUrl)}
                      copiedAriaLabel={t(m.copiedGatewayAdminUrl)}
                      endpoint={effectiveAdminUrl}
                      title={t(m.copyGatewayAdminUrl)}
                    />
                    {canOpenDesktopAdmin ? (
                      <Button
                        onClick={openDesktopAdmin}
                        size="compact"
                        tone="ghost"
                      >
                        <Icon icon={LinkSquare02Icon} size={14} />
                        {t(m.gatewayOpenConsole)}
                      </Button>
                    ) : null}
                  </span>
                </Fact>
              ) : null}
              <Fact
                className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
                label={t(m.gatewayAccessScope)}
              >
                <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                    <span
                      aria-hidden
                      className="size-1.5 shrink-0 rounded-full bg-app-success"
                    />
                    {t(loopback ? m.gatewayScopeLocal : m.gatewayScopeNetwork)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(
                      inferenceAuthDisabled
                        ? m.gatewayInferenceNoAuth
                        : m.gatewayInferenceKeyRequired,
                    )}
                  </span>
                </span>
              </Fact>
            </div>
            <p className="mt-2 px-0.5 text-xs text-muted-foreground">
              {t(m.gatewaySharedNote)}
            </p>
          </>
        ) : (
          <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5 py-3 text-sm text-muted-foreground">
            {t(m.gatewayNotActive)}
          </div>
        )}
      </section>

      {gatewayEndpoint && gatewayModels.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t(m.gatewayLoadedModels)}
          </h3>
          <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
            {gatewayModels.map(({ entry, modelId }) => {
              const idKey = `model-id:${entry.model.id}`;
              const curlKey = `curl:${entry.model.id}`;
              const copiedId = copiedKey === idKey;
              const copiedCurl = copiedKey === curlKey;
              return (
                <div className="py-2.5" key={entry.model.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">
                      {entry.model.name}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Button
                        aria-label={t(
                          copiedId
                            ? m.copiedGatewayModelId
                            : m.copyGatewayModelId,
                          { name: entry.model.name },
                        )}
                        className={copiedId ? "text-app-success" : undefined}
                        onClick={() => copyText(idKey, modelId)}
                        size="compact"
                        tone="ghost"
                      >
                        <Icon
                          icon={copiedId ? Tick02Icon : Copy01Icon}
                          size={14}
                        />
                        {t(copiedId ? commonMessages.copied : m.copyModelId)}
                      </Button>
                      <Button
                        aria-label={t(
                          copiedCurl ? m.copiedGatewayCurl : m.copyGatewayCurl,
                          { name: entry.model.name },
                        )}
                        className={copiedCurl ? "text-app-success" : undefined}
                        onClick={() =>
                          copyText(
                            curlKey,
                            gatewayCurlSnippet(gatewayEndpoint, modelId),
                          )
                        }
                        size="compact"
                        tone="secondary"
                      >
                        <Icon
                          icon={copiedCurl ? Tick02Icon : CommandLineIcon}
                          size={14}
                        />
                        {t(copiedCurl ? commonMessages.copied : m.copyCurl)}
                      </Button>
                    </div>
                  </div>
                  <code className="mt-1.5 block break-all rounded-sm bg-muted px-2 py-1 font-mono text-xs text-foreground">
                    {modelId}
                  </code>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      <section>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          {t(m.gatewayAdminCredentials)}
        </h3>
        {canUseDesktopGateway ? (
          <div className="space-y-2.5">
            <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
              <Fact
                className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
                label={t(m.gatewayUsername)}
              >
                <CopyEndpoint
                  ariaLabel={t(m.copyGatewayUsername)}
                  copiedAriaLabel={t(m.copiedGatewayUsername)}
                  endpoint={desktopGatewayInfo?.username ?? "localmodels"}
                  title={t(m.copyGatewayUsername)}
                />
              </Fact>
              <Fact
                className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
                label={t(m.gatewayPassword)}
              >
                {desktopGatewayInfo?.hasPassword ? (
                  <span className="flex flex-wrap items-center gap-1.5">
                    <code className="max-w-full break-all rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                      {revealedPassword ?? "••••••••••••"}
                    </code>
                    <Button
                      aria-label={t(
                        revealedPassword !== null
                          ? m.hideGatewayPassword
                          : m.showGatewayPassword,
                      )}
                      data-voice-risk="never"
                      loading={revealing}
                      onClick={toggleRevealPassword}
                      size="compactIcon"
                      title={t(
                        revealedPassword !== null
                          ? m.hideGatewayPassword
                          : m.showGatewayPassword,
                      )}
                      tone="ghost"
                    >
                      <Icon
                        icon={
                          revealedPassword !== null
                            ? ViewOffSlashIcon
                            : ViewIcon
                        }
                        size={14}
                      />
                    </Button>
                    <Button
                      aria-label={t(
                        copiedKey === "password"
                          ? m.copiedGatewayPassword
                          : m.copyGatewayPassword,
                      )}
                      className={
                        copiedKey === "password"
                          ? "text-app-success"
                          : undefined
                      }
                      data-voice-risk="never"
                      loading={copyingPassword}
                      onClick={copyDesktopPassword}
                      size="compact"
                      tone="ghost"
                    >
                      <Icon
                        icon={
                          copiedKey === "password" ? Tick02Icon : Copy01Icon
                        }
                        size={14}
                      />
                      {t(
                        copiedKey === "password"
                          ? m.copiedClearsSoon
                          : commonMessages.copy,
                      )}
                    </Button>
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    {t(m.gatewayPasswordUnavailable)}
                  </span>
                )}
              </Fact>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
              <p className="text-xs text-muted-foreground">
                {t(m.gatewayCredentialsLocalOnlyHint)}
              </p>
              <Button onClick={openDesktopFolder} size="compact" tone="ghost">
                <Icon icon={Folder01Icon} size={14} />
                {t(m.gatewayOpenFolder)}
              </Button>
            </div>
            {credentialError ? (
              <FormFeedback tone="danger">{credentialError}</FormFeedback>
            ) : null}
          </div>
        ) : (
          <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5 py-3 text-xs leading-relaxed text-muted-foreground">
            {t(m.gatewayCredentialsDesktopOnly, { computer: computerName })}
          </div>
        )}
      </section>
    </div>
  );
}

function HardwareTabPanel({ view }: { view: LocalModelsView }) {
  const t = useT();
  const host = view.computer.host;
  type PoolHolder = LocalModelPool["holders"][number];
  const seenHolderIds = new Set<string>();
  const models: PoolHolder[] = [];
  const components: PoolHolder[] = [];
  let hasOtherApps = false;
  let hasUnaccounted = false;
  for (const pool of view.pools) {
    if (poolOtherBytes(pool) > 0) hasOtherApps = true;
    if (poolUnaccountedBytes(pool) > 0) hasUnaccounted = true;
    for (const holder of pool.holders) {
      if (seenHolderIds.has(holder.id)) continue;
      seenHolderIds.add(holder.id);
      if (holder.kind === "model") models.push(holder);
      else components.push(holder);
    }
  }
  const colorOf = (holderId: string) => {
    const index = models.findIndex((holder) => holder.id === holderId);
    return index < 0
      ? componentColor
      : segmentColors[index % segmentColors.length]!;
  };

  return (
    <div className="space-y-5">
      {view.pools.length ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t(m.factMemory)}
          </h3>
          <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
            {view.pools.map((pool) => (
              <PoolBar
                colorOf={colorOf}
                key={pool.id}
                pool={pool}
                view={view}
              />
            ))}
          </div>
          {seenHolderIds.size > 0 || hasOtherApps || hasUnaccounted ? (
            <p className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 px-0.5 text-xs text-muted-foreground">
              {[...models, ...components].map((holder) => (
                <span className="flex items-center gap-1.5" key={holder.id}>
                  <span
                    aria-hidden
                    className={cn("size-1.5 rounded-full", colorOf(holder.id))}
                  />
                  {holder.name}
                </span>
              ))}
              {hasOtherApps ? (
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-muted-foreground/30"
                  />
                  {t(m.otherApps)}
                </span>
              ) : null}
              {hasUnaccounted ? (
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-muted-foreground/15"
                  />
                  {t(m.systemAndEngine)}
                </span>
              ) : null}
            </p>
          ) : null}
        </section>
      ) : null}
      {host ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t(m.hardware)}
          </h3>
          <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
            <Fact label={t(m.factMemory)}>
              {formatGigabytes(host.ram_total_bytes, t)}
            </Fact>
            {host.gpus.map((gpu) => (
              <Fact
                key={gpu.index}
                label={t(m.gpuIndex, { index: String(gpu.index) })}
              >
                {gpu.name} · {formatGigabytes(gpu.total_bytes, t)}
              </Fact>
            ))}
            <Fact label={t(m.factFreeDisk)}>
              {formatGigabytes(host.disk_free_bytes, t)}
            </Fact>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function DiagnosticsTabPanel({
  computerId,
  desktopGatewayInfo,
  isLocalDesktop,
  loadedEntries,
  view,
}: {
  computerId: string;
  desktopGatewayInfo?: DesktopLocalGatewayInfo;
  isLocalDesktop: boolean;
  loadedEntries: readonly ModelEntry[];
  view: LocalModelsView;
}) {
  const t = useT();
  const [diagnosticsApi] = useState(desktopDiagnostics);
  const [localGateway] = useState(desktopLocalGateway);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const host = view.computer.host;
  const loadedServers = loadedEntries.filter((entry) =>
    Boolean(entry.model.endpoint?.base_url),
  );
  const canOpenFolder = Boolean(
    isLocalDesktop && localGateway && desktopGatewayInfo?.available,
  );

  function saveDiagnostics() {
    if (!diagnosticsApi) return;
    setActionError(null);
    setSaving(true);
    void diagnosticsApi
      .save()
      .catch(() => setActionError(t(m.saveDiagnosticsFailed)))
      .finally(() => setSaving(false));
  }

  function openDesktopFolder() {
    if (!localGateway) return;
    setActionError(null);
    void localGateway
      .openFolder(computerId)
      .catch(() => setActionError(t(m.gatewayOpenFolderFailed)));
  }

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          {t(m.diagnosticsRuntime)}
        </h3>
        <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
          {host?.os_label ? (
            <Fact label={t(m.factOs)}>{host.os_label}</Fact>
          ) : null}
          {host?.engine_label ? (
            <Fact label={t(m.factEngine)}>{host.engine_label}</Fact>
          ) : null}
          {view.tool_version ? (
            <Fact label={t(m.factLocalModelsTool)}>
              <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                {view.tool_version}
              </code>
            </Fact>
          ) : null}
          <Fact
            className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
            label={t(m.factComputerId)}
          >
            <CopyEndpoint
              ariaLabel={t(m.copyComputerId)}
              copiedAriaLabel={t(m.copiedComputerId)}
              endpoint={computerId}
              title={t(m.copyComputerId)}
            />
          </Fact>
          {view.debug ? (
            <Fact label={t(m.factDebugMode)}>
              <span className="text-app-warning">
                {t(m.debugModeValue, { mode: view.debug.mode })}
              </span>
            </Fact>
          ) : null}
        </div>
      </section>

      {loadedServers.length > 0 ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t(m.diagnosticsModelServers)}
          </h3>
          <div className="rounded-xl border border-border bg-app-canvas/40 px-3.5">
            {loadedServers.map((entry) => (
              <Fact
                className="flex-col items-start gap-1 py-2 sm:flex-row sm:items-center sm:gap-3 sm:py-1.5"
                key={entry.model.id}
                label={entry.model.name}
              >
                <CopyEndpoint
                  ariaLabel={t(m.copyEndpointOf, { name: entry.model.name })}
                  copiedAriaLabel={t(m.copiedEndpointOf, {
                    name: entry.model.name,
                  })}
                  endpoint={entry.model.endpoint!.base_url}
                  title={t(m.copyEndpoint)}
                />
              </Fact>
            ))}
          </div>
        </section>
      ) : null}

      {diagnosticsApi || canOpenFolder ? (
        <section>
          <h3 className="mb-2 text-xs font-medium text-muted-foreground">
            {t(m.diagnosticsActions)}
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            {diagnosticsApi ? (
              <Button
                loading={saving}
                onClick={saveDiagnostics}
                size="compact"
                tone="secondary"
              >
                <Icon icon={Download04Icon} size={14} />
                {t(m.saveDiagnostics)}
              </Button>
            ) : null}
            {canOpenFolder && localGateway ? (
              <Button onClick={openDesktopFolder} size="compact" tone="ghost">
                <Icon icon={Folder01Icon} size={14} />
                {t(m.gatewayOpenFolder)}
              </Button>
            ) : null}
          </div>
          {actionError ? (
            <div className="mt-2">
              <FormFeedback tone="danger">{actionError}</FormFeedback>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Advanced modal for one Computer: shared Bifrost gateway access & local
 * desktop credentials, memory/hardware breakdown, and runtime diagnostics.
 */
export function AdvancedDialog({
  gatewayUrl,
  isLocalDesktop = false,
  onClose,
  view,
}: {
  gatewayUrl?: string;
  isLocalDesktop?: boolean;
  onClose: () => void;
  view: LocalModelsView;
}) {
  const t = useT();
  const host = view.computer.host;
  const computerId = view.computer.computer_id;
  const gatewayEndpoint = sharedGatewayEndpoint(gatewayUrl);
  const adminUrl = gatewayAdminUrl(gatewayUrl);
  const [activeTab, setActiveTab] = useState<AdvancedTab>(() =>
    gatewayEndpoint ? "gateway" : "hardware",
  );
  const [desktopGatewayInfo, setDesktopGatewayInfo] = useState<
    DesktopLocalGatewayInfo | undefined
  >();
  const { indicator, tabRef } = useTabIndicator(activeTab);

  useEffect(() => {
    const api = desktopLocalGateway();
    if (!isLocalDesktop || !api) {
      setDesktopGatewayInfo(undefined);
      return;
    }
    let active = true;
    void api
      .getInfo(computerId)
      .then((info) => {
        if (active) setDesktopGatewayInfo(info);
      })
      .catch(() => {
        if (active) setDesktopGatewayInfo({ available: false });
      });
    return () => {
      active = false;
    };
  }, [computerId, isLocalDesktop]);

  const loadedEntries = modelEntries(view).filter(
    (entry) => entry.status === "loaded",
  );

  const tabLabels: Record<AdvancedTab, string> = {
    diagnostics: t(m.advancedTabDiagnostics),
    gateway: t(m.advancedTabGateway),
    hardware: t(m.advancedTabHardware),
  };

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex =
      (index + step + advancedTabs.length) % advancedTabs.length;
    const nextTab = advancedTabs[nextIndex];
    if (!nextTab) return;
    setActiveTab(nextTab);
    const tabs = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  }

  return (
    <ModalDialog
      closeOnBackdrop
      description={
        host
          ? [host.os_label, host.engine_label].filter(Boolean).join(" · ")
          : undefined
      }
      onClose={onClose}
      size="lg"
      title={t(m.advancedOf, { name: view.computer.display_name })}
    >
      <div className="border-b border-border px-4 sm:px-5">
        <div
          aria-label={t(m.advanced)}
          className="relative -ml-1.5 inline-flex max-w-full gap-0.5 overflow-x-auto sm:-ml-2 sm:gap-1"
          role="tablist"
        >
          {advancedTabs.map((tab, index) => (
            <button
              aria-selected={activeTab === tab}
              className="workspace-view-tab inline-flex h-9 shrink-0 items-center rounded-t-md px-1.5 text-xs font-medium text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none sm:px-2.5 sm:text-sm"
              key={tab}
              onClick={() => setActiveTab(tab)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              ref={tabRef(tab)}
              role="tab"
              type="button"
            >
              {tabLabels[tab]}
            </button>
          ))}
          {indicator}
        </div>
      </div>

      <div className="px-5 py-4" role="tabpanel">
        {activeTab === "gateway" ? (
          <GatewayTabPanel
            adminUrl={adminUrl}
            computerId={computerId}
            computerName={view.computer.display_name}
            desktopGatewayInfo={desktopGatewayInfo}
            gatewayEndpoint={gatewayEndpoint}
            isLocalDesktop={isLocalDesktop}
            loadedEntries={loadedEntries}
          />
        ) : activeTab === "hardware" ? (
          <HardwareTabPanel view={view} />
        ) : (
          <DiagnosticsTabPanel
            computerId={computerId}
            desktopGatewayInfo={desktopGatewayInfo}
            isLocalDesktop={isLocalDesktop}
            loadedEntries={loadedEntries}
            view={view}
          />
        )}
      </div>
    </ModalDialog>
  );
}
