import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { sourceCheckClassName } from "@/features/settings/provider-selection-picker";
import { cn } from "@/lib/cn";

import {
  type AssignableLocalModelAgent,
  isAgentUsingModel,
  usedByAgentNames,
} from "./local-model-agents";
import type { LocalModelsView } from "./local-models-queries";
import {
  formatGigabytes,
  makeRoomSelection,
  makesRoom,
  placeName,
  poolLabel,
  poolOf,
  poolOtherBytes,
  type DownloadMemoryCheck,
  type LoadCheck,
  type ModelEntry,
} from "./local-models-rules";

/** The amber notice naming the Agents that stop answering. */
function AffectedAgents({
  names,
  until,
}: {
  names: readonly string[];
  until: string;
}) {
  const count = names.length;
  return count ? (
    <FormFeedback tone="warning">
      {names.join(", ")} {count === 1 ? "uses" : "use"} this model and
      can&apos;t answer until {until}.
    </FormFeedback>
  ) : (
    <p className="text-sm text-muted-foreground">No Agent uses this model.</p>
  );
}

/** Soft live-memory warning before starting a download that cannot load yet. */
export function DownloadLowMemoryDialog({
  check,
  disabled,
  entry,
  onClose,
  onDownloadAndLoad,
  onDownloadOnly,
  onRecheck,
  rechecking = false,
  view,
}: {
  check: DownloadMemoryCheck | null;
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onDownloadAndLoad: () => void;
  onDownloadOnly: () => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  view: LocalModelsView;
}) {
  const poolName = check ? poolLabel(view, check.pool) : "memory";
  return (
    <ModalDialog
      description={
        check
          ? `${entry.model.name} needs ${formatGigabytes(check.needBytes)} free on ${poolName} to load right now, and ${formatGigabytes(check.freeBytes)} is free.`
          : `Enough memory is now free on ${view.computer.display_name} to download and load ${entry.model.name}.`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          {onRecheck ? (
            <Button
              disabled={disabled}
              loading={rechecking}
              onClick={onRecheck}
            >
              Recheck memory
            </Button>
          ) : null}
          {check ? (
            <Button disabled={disabled} onClick={onDownloadOnly} tone="primary">
              Download only
            </Button>
          ) : (
            <Button
              disabled={disabled}
              onClick={onDownloadAndLoad}
              tone="primary"
            >
              Download and load
            </Button>
          )}
        </>
      }
      onClose={onClose}
      size="md"
      title={
        check
          ? "Not enough free memory to load now"
          : "Ready to download and load"
      }
    >
      <div className="grid gap-3 px-5 py-4">
        {check ? (
          <FormFeedback tone="warning">
            You can download the weights now without loading them (
            {formatGigabytes(entry.model.download_bytes)} on disk), or close
            other apps on {view.computer.display_name} and click Recheck memory.
          </FormFeedback>
        ) : (
          <FormFeedback tone="info">
            Live memory now has enough room for {entry.model.name}.
          </FormFeedback>
        )}
      </div>
    </ModalDialog>
  );
}

/** Loading would overfill the pool: offer to unload loaded models or recheck memory. */
export function MakeRoomDialog({
  assignableAgents = [],
  check,
  disabled,
  entry,
  onClose,
  onConfirm,
  onRecheck,
  rechecking = false,
  view,
}: {
  assignableAgents?: readonly AssignableLocalModelAgent[];
  check: LoadCheck;
  /** The model can no longer be loaded, or its Computer took no actions. */
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onConfirm: (unloadIds: string[], switchAgentIds: string[]) => void;
  onRecheck?: () => void;
  rechecking?: boolean;
  view: LocalModelsView;
}) {
  const [selected, setSelected] = useState(() => makeRoomSelection(check));
  const [switchAgents, setSwitchAgents] = useState(true);
  const roomFreeNow = check.freeBytes >= check.needBytes;
  const loadedIds = new Set(check.loaded.map((item) => item.model.id));
  const effectiveSelected = roomFreeNow
    ? []
    : selected.filter((id) => loadedIds.has(id));
  const chosen = new Set(effectiveSelected);
  const enough = roomFreeNow || makesRoom(check, chosen);
  const pool = poolLabel(view, check.pool);
  const otherBytes = poolOtherBytes(check.pool);
  const unifiedFitsHardware =
    check.pool.kind === "unified" &&
    (view.computer.host?.ram_total_bytes ?? 0) >= check.needBytes;
  // Whether unloading every model offered here frees enough; when not, what
  // else holds the memory is the thing to show.
  const reachable =
    roomFreeNow ||
    makesRoom(check, new Set(check.loaded.map((item) => item.model.id)));
  // Free memory never exceeds the pool's total, whatever else closes.
  const tooBig = check.needBytes > check.pool.total_bytes;
  const inUse = [
    ...(otherBytes ? [{ bytes: otherBytes, id: "", name: "Other apps" }] : []),
    ...check.kept,
  ];
  const computerId = view.computer.computer_id;
  const chosenLoaded = check.loaded.filter((item) => chosen.has(item.model.id));
  const selectedFreedBytes = chosenLoaded.reduce(
    (sum, item) => sum + item.model.memory_bytes,
    0,
  );
  const remainingShortfallBytes = Math.max(
    0,
    check.needBytes - (check.freeBytes + selectedFreedBytes),
  );
  const affected = [
    ...new Set(
      chosenLoaded.flatMap((item) =>
        usedByAgentNames(item, assignableAgents, computerId),
      ),
    ),
  ];
  const affectedAssignable = assignableAgents.filter(
    (agent) =>
      !agent.busy &&
      chosenLoaded.some((item) => isAgentUsingModel(item, agent, computerId)),
  );
  const canSwitchOnLoad =
    Boolean(entry.model.pi_model) && affectedAssignable.length > 0;

  return (
    <ModalDialog
      description={`${entry.model.name} needs ${formatGigabytes(check.needBytes)} on ${pool}; ${formatGigabytes(check.freeBytes)} is free.`}
      footer={
        <>
          {onRecheck ? (
            <Button
              disabled={disabled}
              loading={rechecking}
              onClick={onRecheck}
            >
              Recheck memory
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button
            disabled={disabled || !enough}
            onClick={() =>
              onConfirm(
                effectiveSelected,
                canSwitchOnLoad && switchAgents
                  ? affectedAssignable.map((agent) => agent.actorId)
                  : [],
              )
            }
            tone="primary"
          >
            {effectiveSelected.length ? "Unload and load" : "Load"}
          </Button>
        </>
      }
      onClose={onClose}
      size="md"
      title="Make room to load"
    >
      <div className="grid gap-3 px-5 py-4">
        {roomFreeNow ? (
          <FormFeedback tone="success">
            Enough memory is free now ({formatGigabytes(check.freeBytes)}{" "}
            available). Click Load to start.
          </FormFeedback>
        ) : check.loaded.length ? (
          <fieldset className="grid gap-0.5">
            <legend className="mb-1.5 text-sm text-muted-foreground">
              Unload these to free memory:
            </legend>
            {check.loaded.map((item) => (
              <label
                className={cn(
                  "flex min-h-10 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm transition-colors duration-150 motion-reduce:transition-none",
                  chosen.has(item.model.id)
                    ? "bg-app-selected text-app-ink"
                    : "text-app-body hover:bg-app-hover",
                )}
                key={item.model.id}
              >
                <input
                  checked={chosen.has(item.model.id)}
                  className={sourceCheckClassName}
                  onChange={(event) =>
                    setSelected((current) =>
                      event.target.checked
                        ? [...current, item.model.id]
                        : current.filter((id) => id !== item.model.id),
                    )
                  }
                  type="checkbox"
                />
                <span className="min-w-0 flex-1 truncate">
                  {item.model.name}
                </span>
                <span className="text-xs text-muted-foreground">
                  {(() => {
                    const names = usedByAgentNames(
                      item,
                      assignableAgents,
                      computerId,
                    );
                    return names.length
                      ? `Used by ${names.join(", ")}`
                      : "Not used";
                  })()}
                </span>
                <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                  {formatGigabytes(item.model.memory_bytes)}
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {tooBig ? (
          <FormFeedback tone="danger">
            {entry.model.name} needs more than all{" "}
            {formatGigabytes(check.pool.total_bytes)} of {pool}, so it
            can&apos;t load there.
          </FormFeedback>
        ) : reachable ? null : (
          <>
            {inUse.length ? (
              <ul aria-label="Also using this memory" className="grid gap-0.5">
                {inUse.map((holder) => (
                  <li
                    className="flex min-h-8 items-center gap-2 px-2 text-sm text-app-body"
                    key={holder.id}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {holder.name}
                    </span>
                    <span className="w-16 text-right text-xs tabular-nums text-muted-foreground">
                      {formatGigabytes(holder.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <FormFeedback tone="danger">
              {otherBytes > 0 || unifiedFitsHardware
                ? `${otherBytes > 0 ? `Other apps are using ${formatGigabytes(otherBytes)}. ` : ""}Close other apps that use ${placeName(view, check.pool.id)}, then ${onRecheck ? "click Recheck memory" : "try again"}.`
                : "Unloading models here doesn't free enough. Choose a smaller model."}
            </FormFeedback>
          </>
        )}
        {reachable && !enough && otherBytes > 0 ? (
          <FormFeedback tone="warning">
            Other apps are using {formatGigabytes(otherBytes)} on {pool}. Close
            unnecessary apps and click Recheck memory to free the remaining
            room.
          </FormFeedback>
        ) : reachable && !enough && remainingShortfallBytes > 0 ? (
          <FormFeedback tone="info">
            Select at least {formatGigabytes(remainingShortfallBytes)} more to
            unload before loading {entry.model.name}.
          </FormFeedback>
        ) : null}
        {affected.length ? (
          <FormFeedback tone="warning">
            {affected.join(", ")} can&apos;t answer until their model is loaded
            again.
          </FormFeedback>
        ) : null}
        {canSwitchOnLoad ? (
          <label className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm text-app-ink">
            <input
              checked={switchAgents}
              className={sourceCheckClassName}
              onChange={(event) => setSwitchAgents(event.target.checked)}
              type="checkbox"
            />
            <span>
              Switch {affectedAssignable.map((agent) => agent.name).join(", ")}{" "}
              to {entry.model.name} once loaded
            </span>
          </label>
        ) : null}
      </div>
    </ModalDialog>
  );
}

/** Unloading a model an Agent uses stops that Agent, so it asks first. */
export function UnloadModelDialog({
  assignableAgents = [],
  disabled,
  entry,
  onClose,
  onConfirm,
  view,
}: {
  assignableAgents?: readonly AssignableLocalModelAgent[];
  /** The action no longer applies, or its Computer takes no actions. */
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onConfirm: () => void;
  view: LocalModelsView;
}) {
  const pool = poolOf(view, entry.model.pool);
  const names = usedByAgentNames(
    entry,
    assignableAgents,
    view.computer.computer_id,
  );
  return (
    <ModalDialog
      description={`Frees ${formatGigabytes(entry.model.memory_bytes)} of ${
        pool ? poolLabel(view, pool) : "memory"
      }. It stays on disk, so you can load it again later.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={disabled} onClick={onConfirm} tone="primary">
            Unload
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={`Unload ${entry.model.name}?`}
    >
      <div className="px-5 py-4">
        <AffectedAgents names={names} until="it is loaded again" />
      </div>
    </ModalDialog>
  );
}

export function RemoveModelDialog({
  assignableAgents = [],
  disabled,
  entry,
  onClose,
  onConfirm,
  view,
}: {
  assignableAgents?: readonly AssignableLocalModelAgent[];
  /** The action no longer applies, or its Computer takes no actions. */
  disabled: boolean;
  entry: ModelEntry;
  onClose: () => void;
  onConfirm: () => void;
  view: LocalModelsView;
}) {
  const names = usedByAgentNames(
    entry,
    assignableAgents,
    view.computer.computer_id,
  );
  return (
    <ModalDialog
      description={`${
        entry.status === "loaded"
          ? "Unloads it, deletes its files"
          : "Deletes its files"
      } and frees ${formatGigabytes(entry.model.download_bytes)} of disk on ${view.computer.display_name}. You can download it again later.`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button disabled={disabled} onClick={onConfirm} tone="danger">
            Remove
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={`Remove ${entry.model.name}?`}
    >
      <div className="px-5 py-4">
        <AffectedAgents
          names={names}
          until={`you choose another model for ${names.length === 1 ? "it" : "them"}`}
        />
      </div>
    </ModalDialog>
  );
}
