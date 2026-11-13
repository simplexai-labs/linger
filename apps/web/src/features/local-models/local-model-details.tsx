import { useState, type ReactNode } from "react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format-bytes";

import {
  modelErrorCopy,
  modelNoteCopy,
  unavailableCopy,
} from "./local-models-copy";
import type { LocalModelPool, LocalModelsView } from "./local-models-queries";
import {
  agentNames,
  contextLabel,
  placeName,
  poolFreeBytes,
  poolLabel,
  poolOf,
  type ModelEntry,
} from "./local-models-rules";

/** Category colors from the Nature palette, one per model holding memory. */
const segmentColors = ["bg-rain-500", "bg-lichen-500", "bg-sun-500"] as const;
/** Foundation components hold memory too, but are not models of the list. */
const componentColor = "bg-muted-foreground/40";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center gap-3 py-1.5 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 text-foreground">{children}</span>
    </div>
  );
}

function CopyEndpoint({ endpoint, name }: { endpoint: string; name: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-1">
      <code className="min-w-0 truncate font-mono text-xs">{endpoint}</code>
      <Button
        aria-label={`Copy ${name} endpoint`}
        onClick={() => {
          void navigator.clipboard
            ?.writeText(endpoint)
            .then(() => setCopied(true));
        }}
        size="compactIcon"
        tone="ghost"
      >
        <Icon icon={copied ? Tick02Icon : Copy01Icon} size={14} />
      </Button>
    </span>
  );
}

/** Everything about one model on one Computer, shown when its row expands. */
export function ModelFacts({
  entry,
  view,
}: {
  entry: ModelEntry;
  view: LocalModelsView;
}) {
  const { model, status } = entry;
  const onComputer = status !== "available" && status !== "unavailable";
  const pool = poolOf(view, model.pool);
  const plannedPlace =
    status === "available" ? placeName(view, model.pool) : undefined;
  return (
    <div className="divide-y divide-border">
      <Fact label="Version">{model.quant}</Fact>
      <Fact label="Memory">
        {formatBytes(model.memory_bytes)}
        {onComputer && pool
          ? ` on ${poolLabel(view, pool)}`
          : plannedPlace
            ? ` on ${plannedPlace}`
            : ""}
      </Fact>
      <Fact label={onComputer ? "On disk" : "Download"}>
        {formatBytes(model.download_bytes)}
      </Fact>
      <Fact label="Context">{contextLabel(model.context_tokens)}</Fact>
      {model.tokens_per_second ? (
        <Fact label="Speed">
          {Math.round(model.tokens_per_second)} tokens/s
        </Fact>
      ) : null}
      {onComputer ? (
        <Fact label="Used by">
          {entry.used_by.length ? agentNames(entry) : "No Agent yet"}
        </Fact>
      ) : null}
      {model.endpoint ? (
        <Fact label="Endpoint">
          <CopyEndpoint endpoint={model.endpoint.base_url} name={model.name} />
        </Fact>
      ) : null}
      {model.error ? (
        <Fact label="Last load">
          <span className="text-app-danger">
            {modelErrorCopy(model.error.code)}
          </span>
        </Fact>
      ) : null}
      {model.note ? (
        <Fact label="Note">
          <span className="text-app-warning">
            {modelNoteCopy(model.note.code, placeName(view, model.pool))}
          </span>
        </Fact>
      ) : null}
      {status === "unavailable" ? (
        <Fact label="Why not">
          <span className="text-app-danger">
            {unavailableCopy(model.availability.reason)}
          </span>
        </Fact>
      ) : null}
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
  const otherBytes = Math.max(
    0,
    pool.used_bytes -
      pool.holders.reduce((sum, holder) => sum + holder.bytes, 0),
  );
  const width = (bytes: number) =>
    `${pool.total_bytes ? Math.min(100, (bytes / pool.total_bytes) * 100) : 0}%`;
  return (
    <div className="flex min-h-10 items-center gap-3 py-1.5 text-sm">
      <span className="w-28 shrink-0 text-muted-foreground">
        {pool.kind === "gpu" ? `GPU ${pool.gpu_index}` : label}
      </span>
      <span
        aria-label={`${label}: ${formatBytes(pool.used_bytes)} of ${formatBytes(pool.total_bytes)} in use`}
        className="flex h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted"
        role="img"
      >
        {pool.holders.map((holder) => (
          <span
            className={cn(
              "h-full border-r-2 border-card last:border-r-0",
              colorOf(holder.id),
            )}
            key={holder.id}
            style={{ width: width(holder.bytes) }}
            title={`${holder.name} · ${formatBytes(holder.bytes)}`}
          />
        ))}
        {otherBytes ? (
          <span
            className="h-full bg-muted-foreground/30"
            style={{ width: width(otherBytes) }}
            title={`Other apps · ${formatBytes(otherBytes)}`}
          />
        ) : null}
      </span>
      <span className="w-24 shrink-0 text-right text-xs whitespace-nowrap tabular-nums text-muted-foreground">
        {formatBytes(poolFreeBytes(pool))} free
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
  const host = view.computer.host;
  const holders = view.pools.flatMap((pool) => pool.holders);
  const models = holders.filter((holder) => holder.kind === "model");
  const components = holders.filter((holder) => holder.kind === "component");
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
        <h3 className="mb-1 text-sm font-medium text-muted-foreground">
          Memory
        </h3>
        <div className="divide-y divide-border">
          {view.pools.map((pool) => (
            <PoolBar colorOf={colorOf} key={pool.id} pool={pool} view={view} />
          ))}
        </div>
        {holders.length ? (
          <p className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {[...models, ...components].map((holder) => (
              <span className="flex items-center gap-1.5" key={holder.id}>
                <span
                  aria-hidden
                  className={cn("size-1.5 rounded-full", colorOf(holder.id))}
                />
                {holder.name}
              </span>
            ))}
          </p>
        ) : null}
        {host ? (
          <>
            <h3 className="mt-5 mb-1 text-sm font-medium text-muted-foreground">
              Hardware
            </h3>
            <div className="divide-y divide-border">
              <Fact label="Memory">{formatBytes(host.ram_total_bytes)}</Fact>
              {host.gpus.map((gpu) => (
                <Fact key={gpu.index} label={`GPU ${gpu.index}`}>
                  {gpu.name} · {formatBytes(gpu.total_bytes)}
                </Fact>
              ))}
              <Fact label="Free disk">{formatBytes(host.disk_free_bytes)}</Fact>
            </div>
          </>
        ) : null}
      </div>
    </ModalDialog>
  );
}
