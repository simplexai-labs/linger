import { useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { sourceCheckClassName } from "@/features/settings/provider-selection-picker";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  type AssignableLocalModelAgent,
  isAgentUsingModel,
  usedByAgentNames,
} from "./local-model-agents";
import { localModelsMessages as m } from "./local-models.messages";
import type { LocalModelsView } from "./local-models-queries";
import {
  formatGigabytes,
  joinList,
  makeRoomSelection,
  makesRoom,
  placeName,
  poolLabel,
  poolOf,
  poolOtherBytes,
  poolUnaccountedBytes,
  type LoadCheck,
  type ModelEntry,
} from "./local-models-rules";

/** The amber notice naming the Agents that stop answering. */
function AffectedAgents({
  kind,
  names,
}: {
  /** What ends the wait: loading the model again, or choosing another one. */
  kind: "remove" | "unload";
  names: readonly string[];
}) {
  const t = useT();
  const count = names.length;
  return count ? (
    <FormFeedback tone="warning">
      {t(kind === "unload" ? m.affectedUnload : m.affectedRemove, {
        count,
        names: joinList(names, t),
      })}
    </FormFeedback>
  ) : (
    <p className="text-sm text-muted-foreground">{t(m.noAgentUses)}</p>
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
  const t = useT();
  const [selected, setSelected] = useState(() => makeRoomSelection(check));
  const [switchAgents, setSwitchAgents] = useState(true);
  const roomFreeNow = check.freeBytes >= check.needBytes;
  const loadedIds = new Set(check.loaded.map((item) => item.model.id));
  const effectiveSelected = roomFreeNow
    ? []
    : selected.filter((id) => loadedIds.has(id));
  const chosen = new Set(effectiveSelected);
  const enough = roomFreeNow || makesRoom(check, chosen);
  const pool = poolLabel(view, check.pool, t);
  const place = placeName(view, check.pool.id, t);
  const otherBytes = poolOtherBytes(check.pool);
  const unaccountedBytes = poolUnaccountedBytes(check.pool);
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
    ...(otherBytes
      ? [{ bytes: otherBytes, id: "other-apps", name: t(m.otherApps) }]
      : []),
    ...(unaccountedBytes
      ? [
          {
            bytes: unaccountedBytes,
            id: "system-engine",
            name: t(m.systemAndEngine),
          },
        ]
      : []),
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
      description={t(m.makeRoomDescription, {
        free: formatGigabytes(check.freeBytes, t),
        name: entry.model.name,
        need: formatGigabytes(check.needBytes, t),
        pool,
      })}
      footer={
        <>
          {onRecheck ? (
            <Button
              disabled={disabled}
              loading={rechecking}
              onClick={onRecheck}
            >
              {t(m.recheckMemory)}
            </Button>
          ) : null}
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
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
            {t(effectiveSelected.length ? m.unloadAndLoad : m.actionLoad)}
          </Button>
        </>
      }
      onClose={onClose}
      size="md"
      title={t(m.makeRoomTitle)}
    >
      <div className="grid gap-3 px-5 py-4">
        {roomFreeNow ? (
          <FormFeedback tone="success">
            {t(m.roomFreeNow, {
              free: formatGigabytes(check.freeBytes, t),
            })}
          </FormFeedback>
        ) : check.loaded.length ? (
          <fieldset className="grid gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-muted-foreground">
              {t(m.unloadTheseLegend)}
            </legend>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {check.loaded.map((item) => (
                <label
                  className={cn(
                    "flex min-h-11 cursor-pointer items-center gap-2.5 px-3 py-2 text-sm transition-colors duration-150 motion-reduce:transition-none",
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
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {item.model.name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {(() => {
                      const names = usedByAgentNames(
                        item,
                        assignableAgents,
                        computerId,
                      );
                      return names.length
                        ? t(m.usedByNames, { names: joinList(names, t) })
                        : t(m.notUsed);
                    })()}
                  </span>
                  <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {formatGigabytes(item.model.memory_bytes, t)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ) : null}
        {tooBig ? (
          <FormFeedback tone="danger">
            {t(m.tooBig, {
              name: entry.model.name,
              pool,
              total: formatGigabytes(check.pool.total_bytes, t),
            })}
          </FormFeedback>
        ) : reachable ? null : (
          <>
            {inUse.length ? (
              <ul
                aria-label={t(m.alsoUsingMemory)}
                className="divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-muted/40"
              >
                {inUse.map((holder) => (
                  <li
                    className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-sm text-app-body"
                    key={holder.id}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {holder.name}
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                      {formatGigabytes(holder.bytes, t)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <FormFeedback tone="danger">
              {otherBytes > 0
                ? t(
                    onRecheck ? m.otherAppsCloseRecheck : m.otherAppsCloseRetry,
                    {
                      place: place ?? t(m.placeMemory),
                      size: formatGigabytes(otherBytes, t),
                    },
                  )
                : unifiedFitsHardware
                  ? t(
                      onRecheck
                        ? m.closeOtherAppsRecheck
                        : m.closeOtherAppsRetry,
                      { place: place ?? t(m.placeMemory) },
                    )
                  : t(m.unloadNotEnough)}
            </FormFeedback>
          </>
        )}
        {reachable && !enough && otherBytes > 0 ? (
          <FormFeedback tone="warning">
            {t(m.otherAppsOnPool, {
              pool,
              size: formatGigabytes(otherBytes, t),
            })}
          </FormFeedback>
        ) : reachable && !enough && remainingShortfallBytes > 0 ? (
          <FormFeedback tone="info">
            {t(m.selectMore, {
              name: entry.model.name,
              size: formatGigabytes(remainingShortfallBytes, t),
            })}
          </FormFeedback>
        ) : null}
        {affected.length ? (
          <FormFeedback tone="warning">
            {t(m.affectedUntilReload, { names: joinList(affected, t) })}
          </FormFeedback>
        ) : null}
        {canSwitchOnLoad ? (
          <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-app-canvas/50 px-3 py-2.5 text-sm text-app-ink transition-colors duration-150 hover:bg-app-hover motion-reduce:transition-none">
            <input
              checked={switchAgents}
              className={sourceCheckClassName}
              onChange={(event) => setSwitchAgents(event.target.checked)}
              type="checkbox"
            />
            <span>
              {t(m.switchOnceLoaded, {
                agents: joinList(
                  affectedAssignable.map((agent) => agent.name),
                  t,
                ),
                model: entry.model.name,
              })}
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
  const t = useT();
  const pool = poolOf(view, entry.model.pool);
  const names = usedByAgentNames(
    entry,
    assignableAgents,
    view.computer.computer_id,
  );
  return (
    <ModalDialog
      description={
        pool
          ? t(m.unloadDescriptionPool, {
              pool: poolLabel(view, pool, t),
              size: formatGigabytes(entry.model.memory_bytes, t),
            })
          : t(m.unloadDescription, {
              size: formatGigabytes(entry.model.memory_bytes, t),
            })
      }
      footer={
        <>
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button disabled={disabled} onClick={onConfirm} tone="primary">
            {t(m.actionUnload)}
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={t(m.unloadTitle, { name: entry.model.name })}
    >
      <div className="px-5 py-4">
        <AffectedAgents kind="unload" names={names} />
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
  const t = useT();
  const names = usedByAgentNames(
    entry,
    assignableAgents,
    view.computer.computer_id,
  );
  return (
    <ModalDialog
      description={t(
        entry.status === "loaded"
          ? m.removeDescriptionLoaded
          : m.removeDescription,
        {
          computer: view.computer.display_name,
          size: formatGigabytes(entry.model.download_bytes, t),
        },
      )}
      footer={
        <>
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button
            data-voice-risk="never"
            disabled={disabled}
            onClick={onConfirm}
            tone="danger"
          >
            {t(commonMessages.remove)}
          </Button>
        </>
      }
      onClose={onClose}
      size="sm"
      title={t(m.removeTitle, { name: entry.model.name })}
    >
      <div className="px-5 py-4">
        <AffectedAgents kind="remove" names={names} />
      </div>
    </ModalDialog>
  );
}
