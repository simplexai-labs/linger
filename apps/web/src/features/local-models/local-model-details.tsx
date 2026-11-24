import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Copy01Icon,
  LinkSquare02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { NVIDIA_DRIVER_GUIDE_URL } from "@linger/service-kit/nvidia-driver";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  type AssignableLocalModelAgent,
  isAgentUsingModel,
  primaryLocalModelAgent,
  usedByAgentNames,
} from "./local-model-agents";
import {
  capabilityCopy,
  concurrencyCopy,
  engineBadgeCopy,
  engineHintCopy,
  modelErrorCopy,
  modelNoteCopy,
  unavailableCopy,
} from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
import type { LocalModelPool, LocalModelsView } from "./local-models-queries";
import {
  contextLabel,
  downloadStopped,
  formatGigabytes,
  isModelOnComputer,
  joinList,
  memoryReclaimable,
  modelCapabilities,
  modelSourceLabel,
  parametersLabel,
  placeName,
  poolFreeBytes,
  poolLabel,
  poolOf,
  poolOtherBytes,
  poolUnaccountedBytes,
  safeModelSourceUrl,
  speedLabel,
  type ModelEntry,
} from "./local-models-rules";

/** Category colors from the Nature palette, one per model holding memory. */
const segmentColors = ["bg-rain-500", "bg-lichen-500", "bg-sun-500"] as const;
/** Foundation components hold memory too, but are not models of the list. */
const componentColor = "bg-muted-foreground/40";

function Fact({
  bordered = true,
  children,
  className,
  label,
}: {
  bordered?: boolean;
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center gap-3 py-1.5 text-sm",
        bordered && "border-t border-border/70",
        className,
      )}
    >
      <span className="w-28 shrink-0 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 tabular-nums text-foreground">
        {children}
      </span>
    </div>
  );
}

function CopyEndpoint({ endpoint, name }: { endpoint: string; name: string }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);
  const codeRef = useRef<HTMLElement>(null);

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
    },
    [],
  );

  function markCopied() {
    window.clearTimeout(timerRef.current);
    setCopied(true);
    timerRef.current = window.setTimeout(() => setCopied(false), 1_500);
  }

  function copy() {
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(endpoint).then(
        () => markCopied(),
        () => selectCodeText(codeRef.current),
      );
      return;
    }
    selectCodeText(codeRef.current);
  }

  return (
    <span className="flex items-center gap-1.5">
      <code
        className="min-w-0 truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground"
        ref={codeRef}
      >
        {endpoint}
      </code>
      <Button
        aria-label={t(copied ? m.copiedEndpointOf : m.copyEndpointOf, { name })}
        className={copied ? "text-app-success" : undefined}
        onClick={copy}
        size="compactIcon"
        title={t(copied ? commonMessages.copied : m.copyEndpoint)}
        tone="ghost"
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
      </Button>
    </span>
  );
}

function selectCodeText(element: HTMLElement | null) {
  if (!element) return;
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function gatewayFactValue(
  entry: ModelEntry,
  view: LocalModelsView,
  computer: TeamHubLocalComputerPage["items"][number] | undefined,
  t: Translate,
): ReactNode {
  // The gateway's name alone, the same in every language.
  if (!computer || !entry.model.pi_model) return "Bifrost";
  const piRuntime = computer.runtimes.find((runtime) => runtime.type === "pi");
  if (!piRuntime) {
    return (
      <span className="text-muted-foreground">
        {t(m.gatewayPiNotInstalled)}
      </span>
    );
  }
  if (piRuntime.status === "ready") {
    if (piRuntime.models.some((item) => item.id === entry.model.pi_model)) {
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-full bg-app-success"
          />
          <span>{t(m.gatewayReady)}</span>
        </span>
      );
    }
    return (
      <span className="text-muted-foreground">{t(m.gatewayRegistering)}</span>
    );
  }
  if (piRuntime.status === "not_installed") {
    return (
      <span className="text-muted-foreground">
        {t(
          view.computer.status === "online"
            ? m.gatewaySettingUp
            : m.gatewayPiNotInstalled,
        )}
      </span>
    );
  }
  return <span className="text-app-warning">{t(m.gatewayPiUnavailable)}</span>;
}

/** Everything about one model on one Computer, shown when its row expands. */
export function ModelFacts({
  assignableAgents = [],
  assigningAgentId,
  computer,
  disabled = false,
  entry,
  hasPrimaryAssignAction = false,
  hasReadyAlternatives = false,
  onAssignAgent,
  onRecheck,
  onUpdateDriver,
  rechecking = false,
  view,
}: {
  assignableAgents?: readonly AssignableLocalModelAgent[];
  assigningAgentId?: string;
  computer?: TeamHubLocalComputerPage["items"][number];
  disabled?: boolean;
  entry: ModelEntry;
  hasPrimaryAssignAction?: boolean;
  hasReadyAlternatives?: boolean;
  onAssignAgent?: (agent: AssignableLocalModelAgent) => void;
  onRecheck?: () => void;
  onUpdateDriver?: () => void;
  rechecking?: boolean;
  view: LocalModelsView;
}) {
  const t = useT();
  const { model, status } = entry;
  // A stopped download holds only a partial file, so it reads like a model
  // not yet on the Computer.
  const stopped = downloadStopped(model);
  const onComputer = isModelOnComputer(model, status);
  const pool = poolOf(view, model.pool);
  const plannedPlace =
    status === "available" || stopped
      ? placeName(view, model.pool, t)
      : undefined;
  const capabilities = modelCapabilities(model);
  const parameters = parametersLabel(model, t);
  const engineDisplay = model.engine_label ?? engineBadgeCopy(model.engine);
  const engineHint = engineHintCopy(model.engine, model.fit, t);
  const concurrency = concurrencyCopy(model.concurrency, t);
  const hostRam =
    model.host_ram_bytes && model.host_ram_bytes > 0
      ? formatGigabytes(model.host_ram_bytes, t)
      : undefined;
  const speed = speedLabel(model, t);
  const sourceUrl = safeModelSourceUrl(model.source_url);
  const reclaimable = memoryReclaimable(view, model);
  const availableNeedsRoom =
    status === "available" &&
    pool !== undefined &&
    poolOtherBytes(pool) > 0 &&
    poolFreeBytes(pool) < model.memory_bytes;
  const computerId = view.computer.computer_id;
  const usedNames = usedByAgentNames(entry, assignableAgents, computerId);
  const idleUsedWarning =
    status === "idle" && !model.note && usedNames.length > 0;
  const unassigned = assignableAgents.filter(
    (agent) => !isAgentUsingModel(entry, agent, computerId),
  );
  const primaryAgent = primaryLocalModelAgent(assignableAgents);
  const showAgentPicker =
    status === "loaded" &&
    Boolean(model.pi_model) &&
    Boolean(onAssignAgent) &&
    unassigned.length > 0 &&
    (!hasPrimaryAssignAction ||
      unassigned.some((agent) => !agent.isAnotherMe) ||
      unassigned.length > 1);
  const primaryBusy =
    status === "loaded" &&
    Boolean(model.pi_model) &&
    Boolean(onAssignAgent) &&
    primaryAgent !== undefined &&
    !isAgentUsingModel(entry, primaryAgent, computerId) &&
    primaryAgent.busy;
  const memorySize = formatGigabytes(model.memory_bytes, t);
  const memoryPlace =
    onComputer && pool ? poolLabel(view, pool, t) : plannedPlace;
  const driverUpdateBlocked =
    status === "unavailable" &&
    model.availability.reason?.code === "DRIVER_UPDATE_REQUIRED";
  const engineShortName = engineBadgeCopy(model.engine);
  return (
    <div>
      {model.error || status === "unavailable" ? (
        <div
          className={cn(
            "my-1.5 rounded-lg border px-3 py-0.5",
            driverUpdateBlocked && !model.error
              ? "border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)]"
              : "border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)]",
          )}
        >
          {model.error ? (
            <Fact
              bordered={false}
              label={t(stopped ? m.factLastDownload : m.factLastLoad)}
            >
              <span className="text-app-danger">
                {modelErrorCopy(model.error, t)}
              </span>
            </Fact>
          ) : null}
          {status === "unavailable" ? (
            <Fact bordered={Boolean(model.error)} label={t(m.factWhyNot)}>
              <div className="grid gap-2">
                <span
                  className={
                    driverUpdateBlocked ? "text-foreground" : "text-app-danger"
                  }
                >
                  {unavailableCopy(
                    model.availability.reason,
                    reclaimable,
                    t,
                    engineShortName,
                  )}
                </span>
                {driverUpdateBlocked ? (
                  <div className="grid gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      {onUpdateDriver ? (
                        <Button
                          onClick={onUpdateDriver}
                          size="compact"
                          tone="primary"
                        >
                          {t(m.updateDriverAction)}
                        </Button>
                      ) : null}
                      {onRecheck && !disabled ? (
                        <Button
                          loading={rechecking}
                          onClick={onRecheck}
                          size="compact"
                          tone="secondary"
                        >
                          {t(m.driverCheckAgain)}
                        </Button>
                      ) : null}
                      <a
                        className="inline-flex items-center gap-1 text-xs font-medium text-app-link underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        href={NVIDIA_DRIVER_GUIDE_URL}
                        rel="noopener noreferrer"
                        target="_blank"
                      >
                        <span>{t(m.driverGuide)}</span>
                        <Icon icon={LinkSquare02Icon} size={14} />
                      </a>
                    </div>
                    {hasReadyAlternatives ? (
                      <p className="text-xs text-muted-foreground">
                        {t(m.driverOtherModelsReady)}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Fact>
          ) : null}
        </div>
      ) : null}
      {model.note ? (
        <div className="my-1.5 rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] px-3 py-0.5">
          <Fact bordered={false} label={t(m.factNote)}>
            <span className="text-app-warning">
              {modelNoteCopy(
                model.note.code,
                placeName(view, model.pool, t),
                t,
              )}
            </span>
          </Fact>
        </div>
      ) : null}
      {idleUsedWarning ? (
        <div className="my-1.5">
          <FormFeedback tone="warning">
            {t(m.idleUsedWarning, {
              count: usedNames.length,
              names: joinList(usedNames, t),
            })}
          </FormFeedback>
        </div>
      ) : null}
      {availableNeedsRoom ? (
        <div className="my-1.5">
          <FormFeedback tone="warning">
            {t(m.downloadNeedsRoom, {
              free: formatGigabytes(poolFreeBytes(pool), t),
              pool: poolLabel(view, pool, t),
            })}
          </FormFeedback>
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-x-6 @xl:grid-cols-2">
        {capabilities.length ? (
          <Fact className="@xl:col-span-2" label={t(m.factCapabilities)}>
            <span className="flex flex-wrap gap-1.5">
              {capabilities.map((capability) => (
                <span
                  className="inline-flex h-[22px] items-center rounded-sm bg-muted px-2 text-xs font-medium text-secondary-foreground"
                  key={capability}
                >
                  {capabilityCopy(capability, t)}
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
        {model.publisher ? (
          <Fact label={t(m.factPublisher)}>{model.publisher}</Fact>
        ) : null}
        {parameters ? (
          <Fact label={t(m.factParameters)}>{parameters}</Fact>
        ) : null}
        {engineDisplay ? (
          <Fact label={t(m.factEngine)}>
            <span className="block">{engineDisplay}</span>
            {engineHint ? (
              <span className="block text-xs text-muted-foreground">
                {engineHint}
              </span>
            ) : null}
          </Fact>
        ) : null}
        {concurrency ? (
          <Fact label={t(m.factConcurrency)}>{concurrency}</Fact>
        ) : null}
        <Fact label={t(m.factMemory)}>
          {memoryPlace
            ? t(m.memoryOn, { place: memoryPlace, size: memorySize })
            : memorySize}
        </Fact>
        {hostRam ? <Fact label={t(m.factSystemMemory)}>{hostRam}</Fact> : null}
        <Fact label={t(onComputer ? m.factOnDisk : m.factDownload)}>
          {formatGigabytes(model.download_bytes, t)}
        </Fact>
        <Fact label={t(m.factContext)}>
          {contextLabel(model.context_tokens, t)}
        </Fact>
        <Fact label={t(m.factVersion)}>
          <code className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs text-secondary-foreground">
            {model.quant}
          </code>
        </Fact>
        {speed ? <Fact label={t(m.factSpeed)}>{speed}</Fact> : null}
        {model.license ? (
          <Fact label={t(m.factLicense)}>{model.license}</Fact>
        ) : null}
        {onComputer ? (
          <Fact
            className={
              usedNames.length > 1 || showAgentPicker || primaryBusy
                ? "@xl:col-span-2"
                : undefined
            }
            label={t(m.factUsedBy)}
          >
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {usedNames.length ? joinList(usedNames, t) : t(m.noAgentYet)}
              </span>
              {showAgentPicker && onAssignAgent ? (
                <Select
                  aria-label={t(m.switchAgentTo, { name: model.name })}
                  disabled={disabled || Boolean(assigningAgentId)}
                  onValueChange={(actorId) => {
                    const target = unassigned.find(
                      (agent) => agent.actorId === actorId,
                    );
                    if (target) onAssignAgent(target);
                  }}
                  placeholder={t(
                    assigningAgentId ? m.switchingAgent : m.switchAgent,
                  )}
                  value=""
                  variant="pill"
                >
                  {unassigned.map((agent) => (
                    <SelectItem
                      disabled={agent.busy}
                      key={agent.actorId}
                      value={agent.actorId}
                    >
                      {agent.busy
                        ? t(m.agentWorking, { name: agent.name })
                        : agent.name}
                    </SelectItem>
                  ))}
                </Select>
              ) : primaryBusy ? (
                <span className="text-xs text-muted-foreground">
                  {t(m.finishTurnToSwitch)}
                </span>
              ) : null}
            </span>
          </Fact>
        ) : null}
        {sourceUrl ? (
          <Fact className="@xl:col-span-2" label={t(m.factSource)}>
            <a
              className="inline-flex max-w-full items-center gap-1 text-app-link underline-offset-2 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={sourceUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <span className="truncate">{modelSourceLabel(sourceUrl)}</span>
              <Icon className="shrink-0" icon={LinkSquare02Icon} size={14} />
            </a>
          </Fact>
        ) : null}
        {status === "loaded" && model.endpoint ? (
          <Fact className="@xl:col-span-2" label={t(m.factGateway)}>
            {gatewayFactValue(entry, view, computer, t)}
          </Fact>
        ) : null}
        {model.endpoint ? (
          <Fact className="@xl:col-span-2" label={t(m.factEndpoint)}>
            <CopyEndpoint
              endpoint={model.endpoint.base_url}
              name={model.name}
            />
          </Fact>
        ) : null}
      </div>
    </div>
  );
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

/** Memory and hardware of one Computer, for people who want the numbers. */
export function AdvancedDialog({
  onClose,
  view,
}: {
  onClose: () => void;
  view: LocalModelsView;
}) {
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
    <ModalDialog
      closeOnBackdrop
      description={
        host
          ? [host.os_label, host.engine_label].filter(Boolean).join(" · ")
          : undefined
      }
      onClose={onClose}
      size="md"
      title={t(m.detailsOf, { name: view.computer.display_name })}
    >
      <div className="space-y-5 px-5 py-4">
        {view.pools.length ? (
          <section>
            <h3 className="mb-2 text-xs font-medium text-muted-foreground">
              {t(m.factMemory)}
            </h3>
            <div className="divide-y divide-border rounded-xl border border-border bg-app-canvas/40 px-3.5">
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
                      className={cn(
                        "size-1.5 rounded-full",
                        colorOf(holder.id),
                      )}
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
              <Fact bordered={false} label={t(m.factMemory)}>
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
    </ModalDialog>
  );
}
