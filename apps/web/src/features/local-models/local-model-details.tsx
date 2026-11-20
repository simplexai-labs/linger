import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  Copy01Icon,
  InformationCircleIcon,
  LinkSquare02Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { relativeTime } from "@/features/local-computer/computer-relative-time";
import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { cn } from "@/lib/cn";

import {
  type AssignableLocalModelAgent,
  isAgentUsingModel,
  primaryLocalModelAgent,
  usedByAgentNames,
} from "./local-model-agents";
import {
  capabilityCopy,
  memoryPressureCopy,
  modelErrorCopy,
  modelNoteCopy,
  unavailableCopy,
} from "./local-models-copy";
import type { LocalModelPool, LocalModelsView } from "./local-models-queries";
import {
  contextLabel,
  downloadMemoryCheck,
  downloadStopped,
  formatGigabytes,
  isModelOnComputer,
  memoryReclaimable,
  modelCapabilities,
  modelSourceLabel,
  parametersLabel,
  placeName,
  poolFreeBytes,
  poolLabel,
  poolMemoryBreakdown,
  poolOf,
  poolOtherBytes,
  safeModelSourceUrl,
  speedLabel,
  type MemoryBreakdown,
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
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 tabular-nums text-foreground">
        {children}
      </span>
    </div>
  );
}

function CopyEndpoint({ endpoint, name }: { endpoint: string; name: string }) {
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
    <span className="flex items-center gap-1">
      <code className="min-w-0 truncate font-mono text-xs" ref={codeRef}>
        {endpoint}
      </code>
      <Button
        aria-label={
          copied ? `Copied ${name} endpoint` : `Copy ${name} endpoint`
        }
        onClick={copy}
        size="compactIcon"
        title={copied ? "Copied" : "Copy endpoint"}
        tone="ghost"
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
      </Button>
    </span>
  );
}

/** Hover/focus/click popover explaining how pool memory and macOS reclaimable space add up. */
export function MemoryBreakdownPopover({
  align = "left",
  breakdown,
  children,
  className,
}: {
  align?: "left" | "right";
  breakdown?: MemoryBreakdown;
  children: ReactNode;
  className?: string;
}) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const containerRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();
  const open = Boolean(breakdown) && (pinned || hoverOpen || focusOpen);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setPinned(false);
        setHoverOpen(false);
        setFocusOpen(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  if (!breakdown) return <>{children}</>;

  return (
    <span
      className={cn("relative inline-flex max-w-full items-center", className)}
      onMouseEnter={() => setHoverOpen(true)}
      onMouseLeave={() => setHoverOpen(false)}
      ref={containerRef}
    >
      <button
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        className="inline-flex max-w-full items-center gap-1 rounded-sm text-left underline decoration-border-hover decoration-dotted underline-offset-4 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onBlur={(event) => {
          if (!containerRef.current?.contains(event.relatedTarget)) {
            setFocusOpen(false);
          }
        }}
        onClick={() => {
          setPinned((current) => !current);
          setHoverOpen(false);
        }}
        onFocus={() => setFocusOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setPinned(false);
            setHoverOpen(false);
            setFocusOpen(false);
          }
        }}
        type="button"
      >
        {children}
        <Icon
          aria-hidden
          className="shrink-0 text-muted-foreground"
          icon={InformationCircleIcon}
          size={14}
        />
      </button>
      {open ? (
        <div
          aria-label={breakdown.title}
          className={cn(
            "absolute top-full z-30 mt-2 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-card p-3.5 text-left text-xs text-foreground shadow-lg",
            align === "right" ? "right-0" : "left-0",
          )}
          id={panelId}
          role="region"
        >
          <p className="font-medium text-foreground">{breakdown.title}</p>
          <dl className="mt-2 grid gap-1.5">
            {breakdown.rows.map((item) => (
              <div
                className="flex items-center justify-between gap-3"
                key={item.label}
              >
                <dt className="text-muted-foreground">{item.label}</dt>
                <dd
                  className={cn(
                    "font-medium tabular-nums",
                    item.tone === "danger"
                      ? "text-app-danger"
                      : item.tone === "warning"
                        ? "text-app-warning"
                        : "text-foreground",
                  )}
                >
                  {item.value}
                </dd>
              </div>
            ))}
          </dl>
          {breakdown.note ? (
            <p className="mt-2.5 border-t border-border/70 pt-2 leading-relaxed text-muted-foreground">
              {breakdown.note}
            </p>
          ) : null}
        </div>
      ) : null}
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
  computer?: TeamHubLocalComputerPage["items"][number],
): ReactNode {
  if (!computer || !entry.model.pi_model) return "Bifrost";
  const piRuntime = computer.runtimes.find((runtime) => runtime.type === "pi");
  if (!piRuntime) {
    return (
      <span className="text-muted-foreground">Bifrost · Pi not installed</span>
    );
  }
  if (piRuntime.status === "ready") {
    if (piRuntime.models.some((item) => item.id === entry.model.pi_model)) {
      return "Ready · Bifrost (Pi)";
    }
    return (
      <span className="text-muted-foreground">
        Bifrost · Registering with Pi…
      </span>
    );
  }
  if (piRuntime.status === "not_installed") {
    return (
      <span className="text-muted-foreground">
        {view.computer.status === "online"
          ? "Bifrost · Setting up Pi…"
          : "Bifrost · Pi not installed"}
      </span>
    );
  }
  return <span className="text-app-warning">Bifrost · Pi unavailable</span>;
}

/** Everything about one model on one Computer, shown when its row expands. */
export function ModelFacts({
  assignableAgents = [],
  assigningAgentId,
  computer,
  disabled = false,
  entry,
  hasPrimaryAssignAction = false,
  onAssignAgent,
  view,
}: {
  assignableAgents?: readonly AssignableLocalModelAgent[];
  assigningAgentId?: string;
  computer?: TeamHubLocalComputerPage["items"][number];
  disabled?: boolean;
  entry: ModelEntry;
  hasPrimaryAssignAction?: boolean;
  onAssignAgent?: (agent: AssignableLocalModelAgent) => void;
  view: LocalModelsView;
}) {
  const { model, status } = entry;
  // A stopped download holds only a partial file, so it reads like a model
  // not yet on the Computer.
  const stopped = downloadStopped(model);
  const onComputer = isModelOnComputer(model, status);
  const pool = poolOf(view, model.pool);
  const plannedPlace =
    status === "available" || stopped ? placeName(view, model.pool) : undefined;
  const capabilities = modelCapabilities(model);
  const parameters = parametersLabel(model);
  const speed = speedLabel(model);
  const sourceUrl = safeModelSourceUrl(model.source_url);
  const reclaimable = memoryReclaimable(view, model);
  const lowMemory =
    status === "available" ? downloadMemoryCheck(view, model) : null;
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
  return (
    <div>
      {model.error || status === "unavailable" ? (
        <div className="my-1.5 rounded-lg border border-[var(--app-status-danger-border)] bg-[var(--app-status-danger-surface)] px-3 py-0.5">
          {model.error ? (
            <Fact
              bordered={false}
              label={stopped ? "Last download" : "Last load"}
            >
              <span className="text-app-danger">
                {modelErrorCopy(model.error)}
              </span>
            </Fact>
          ) : null}
          {status === "unavailable" ? (
            <Fact bordered={Boolean(model.error)} label="Why not">
              <span className="text-app-danger">
                {unavailableCopy(model.availability.reason, reclaimable)}
              </span>
            </Fact>
          ) : null}
        </div>
      ) : null}
      {model.note ? (
        <div className="my-1.5 rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] px-3 py-0.5">
          <Fact bordered={false} label="Note">
            <span className="text-app-warning">
              {modelNoteCopy(model.note.code, placeName(view, model.pool))}
            </span>
          </Fact>
        </div>
      ) : null}
      {idleUsedWarning ? (
        <div className="my-1.5">
          <FormFeedback tone="warning">
            {usedNames.join(", ")} {usedNames.length === 1 ? "uses" : "use"}{" "}
            this model. Load it so {usedNames.length === 1 ? "it" : "they"} can
            answer.
          </FormFeedback>
        </div>
      ) : null}
      {lowMemory ? (
        <div className="my-1.5">
          <FormFeedback tone="warning">
            This model can download now, but it needs{" "}
            {formatGigabytes(lowMemory.needBytes)} free and only{" "}
            {formatGigabytes(lowMemory.freeBytes)} is free on{" "}
            {poolLabel(view, lowMemory.pool)}. Close memory-heavy apps and
            recheck memory, or download it without loading.
          </FormFeedback>
        </div>
      ) : null}
      <div className="mt-1 grid grid-cols-1 gap-x-6 @xl:grid-cols-2">
        {capabilities.length ? (
          <Fact className="@xl:col-span-2" label="Capabilities">
            <span className="flex flex-wrap gap-1.5">
              {capabilities.map((capability) => (
                <span
                  className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-secondary-foreground"
                  key={capability}
                >
                  {capabilityCopy(capability)}
                </span>
              ))}
            </span>
          </Fact>
        ) : null}
        {model.publisher ? (
          <Fact label="Publisher">{model.publisher}</Fact>
        ) : null}
        {parameters ? <Fact label="Parameters">{parameters}</Fact> : null}
        <Fact label="Memory">
          {formatGigabytes(model.memory_bytes)}
          {onComputer && pool
            ? ` on ${poolLabel(view, pool)}`
            : plannedPlace
              ? ` on ${plannedPlace}`
              : ""}
        </Fact>
        <Fact label={onComputer ? "On disk" : "Download"}>
          {formatGigabytes(model.download_bytes)}
        </Fact>
        <Fact label="Context">{contextLabel(model.context_tokens)}</Fact>
        <Fact label="Version">
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-secondary-foreground">
            {model.quant}
          </code>
        </Fact>
        {speed ? <Fact label="Speed">{speed}</Fact> : null}
        {model.license ? <Fact label="License">{model.license}</Fact> : null}
        {onComputer ? (
          <Fact
            className={
              usedNames.length > 1 || showAgentPicker || primaryBusy
                ? "@xl:col-span-2"
                : undefined
            }
            label="Used by"
          >
            <span className="flex flex-wrap items-center gap-2">
              <span>
                {usedNames.length ? usedNames.join(", ") : "No Agent yet"}
              </span>
              {showAgentPicker && onAssignAgent ? (
                <Select
                  aria-label={`Switch an Agent to ${model.name}`}
                  disabled={disabled || Boolean(assigningAgentId)}
                  onValueChange={(actorId) => {
                    const target = unassigned.find(
                      (agent) => agent.actorId === actorId,
                    );
                    if (target) onAssignAgent(target);
                  }}
                  placeholder={
                    assigningAgentId ? "Switching…" : "Switch Agent…"
                  }
                  value=""
                  variant="pill"
                >
                  {unassigned.map((agent) => (
                    <SelectItem
                      disabled={agent.busy}
                      key={agent.actorId}
                      value={agent.actorId}
                    >
                      {agent.busy ? `${agent.name} · Working` : agent.name}
                    </SelectItem>
                  ))}
                </Select>
              ) : primaryBusy ? (
                <span className="text-xs text-muted-foreground">
                  Finish the current turn to switch
                </span>
              ) : null}
            </span>
          </Fact>
        ) : null}
        {sourceUrl ? (
          <Fact className="@xl:col-span-2" label="Source">
            <a
              className="inline-flex max-w-full items-center gap-1 text-foreground underline underline-offset-2"
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
          <Fact className="@xl:col-span-2" label="Gateway">
            {gatewayFactValue(entry, view, computer)}
          </Fact>
        ) : null}
        {model.endpoint ? (
          <Fact className="@xl:col-span-2" label="Endpoint">
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
  const label = poolLabel(view, pool);
  // used_bytes is the device's real use; on a shared card other processes
  // hold memory that no holder accounts for.
  const otherBytes = poolOtherBytes(pool);
  const width = (bytes: number) =>
    `${pool.total_bytes ? Math.min(100, (bytes / pool.total_bytes) * 100) : 0}%`;
  return (
    <div className="flex min-h-10 items-center gap-3 py-1.5 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">
        {pool.kind === "gpu" ? `GPU ${pool.gpu_index}` : label}
      </span>
      <span
        aria-label={`${label}: ${formatGigabytes(pool.used_bytes)} of ${formatGigabytes(pool.total_bytes)} in use`}
        className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
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
              title={`${holder.name} · ${formatGigabytes(holder.bytes)}`}
            />
          ))}
        {otherBytes ? (
          <span
            className="h-full bg-muted-foreground/30"
            style={{ width: width(otherBytes) }}
            title={`Other apps · ${formatGigabytes(otherBytes)}`}
          />
        ) : null}
      </span>
      <span className="w-28 shrink-0 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground">
        <MemoryBreakdownPopover
          align="right"
          breakdown={poolMemoryBreakdown(view, pool)}
        >
          <span>{formatGigabytes(poolFreeBytes(pool))} free</span>
        </MemoryBreakdownPopover>
      </span>
    </div>
  );
}

/** Memory and hardware of one Computer, for people who want the numbers. */
export function AdvancedDialog({
  canRecheck = false,
  onClose,
  onRecheck,
  rechecking = false,
  view,
}: {
  canRecheck?: boolean;
  onClose: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  view: LocalModelsView;
}) {
  const host = view.computer.host;
  const unifiedPool = view.pools.find((pool) => pool.kind === "unified");
  type PoolHolder = LocalModelPool["holders"][number];
  const seenHolderIds = new Set<string>();
  const models: PoolHolder[] = [];
  const components: PoolHolder[] = [];
  let hasOtherApps = false;
  for (const pool of view.pools) {
    if (poolOtherBytes(pool) > 0) hasOtherApps = true;
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
      title={`${view.computer.display_name} details`}
    >
      <div className="px-5 py-4">
        {view.pools.length ? (
          <>
            <div className="mb-1 flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <h3 className="text-sm font-medium text-muted-foreground">
                  Memory
                </h3>
                {view.observed_at ? (
                  <span className="text-xs text-muted-foreground">
                    · Checked {relativeTime(view.observed_at)}
                  </span>
                ) : null}
              </div>
              {canRecheck && onRecheck ? (
                <Button
                  loading={rechecking}
                  onClick={onRecheck}
                  size="compact"
                  tone="ghost"
                >
                  Recheck memory
                </Button>
              ) : null}
            </div>
            <div className="divide-y divide-border">
              {view.pools.map((pool) => (
                <PoolBar
                  colorOf={colorOf}
                  key={pool.id}
                  pool={pool}
                  view={view}
                />
              ))}
            </div>
            {seenHolderIds.size > 0 || hasOtherApps ? (
              <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
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
                    Other apps
                  </span>
                ) : null}
              </p>
            ) : null}
          </>
        ) : null}
        {host ? (
          <>
            <h3
              className={cn(
                "mb-1 text-sm font-medium text-muted-foreground",
                view.pools.length > 0 && "mt-5",
              )}
            >
              Hardware
            </h3>
            <div>
              <Fact bordered={false} label="Memory">
                {formatGigabytes(host.ram_total_bytes)}
              </Fact>
              {host.ram_available_bytes !== undefined ? (
                <Fact label="Reclaimable">
                  {formatGigabytes(host.ram_available_bytes)} reclaimable & free
                </Fact>
              ) : null}
              {unifiedPool?.reserve_bytes !== undefined &&
              unifiedPool.reserve_bytes > 0 ? (
                <Fact label="System reserve">
                  {formatGigabytes(unifiedPool.reserve_bytes)} kept for macOS &
                  Linger
                </Fact>
              ) : null}
              {host.metal_working_set_bytes !== undefined ? (
                <Fact label="Metal GPU limit">
                  {formatGigabytes(host.metal_working_set_bytes)} per model
                </Fact>
              ) : null}
              {host.memory_pressure && host.memory_pressure !== "normal" ? (
                <Fact label="Memory pressure">
                  <span
                    className={
                      host.memory_pressure === "critical"
                        ? "text-app-danger"
                        : "text-app-warning"
                    }
                  >
                    {memoryPressureCopy(host.memory_pressure)}
                  </span>
                </Fact>
              ) : null}
              {host.gpus.map((gpu) => (
                <Fact key={gpu.index} label={`GPU ${gpu.index}`}>
                  {gpu.name} · {formatGigabytes(gpu.total_bytes)}
                </Fact>
              ))}
              <Fact label="Free disk">
                {formatGigabytes(host.disk_free_bytes)}
              </Fact>
            </div>
          </>
        ) : null}
      </div>
    </ModalDialog>
  );
}
