import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type KeyboardEvent, useState } from "react";

import { Button } from "@/components/ui/button";
import { FormFeedback } from "@/components/ui/form-feedback";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Hint } from "@/features/local-computer/computer-hint";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import {
  tenantAgentAvailabilityQueryKey,
  tenantAgentsQueryKey,
} from "@/features/rooms/room-queries";
import { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { useT } from "@/i18n/use-translation";
import { cn } from "@/lib/cn";

import {
  modelSourceFailureCopy,
  modelSourceModeLabels,
  modelSourceRuntimeLabels,
} from "./local-models-copy";
import { localModelsMessages as m } from "./local-models.messages";
import {
  invalidateOfflineComputer,
  tenantLocalModelsQueryKey,
} from "./local-models-queries";
import { joinList } from "./local-models-rules";
import {
  type ModelSourceMode,
  type ModelSourceStatus,
  type ModelSourceSwitchRequest,
  type ModelSourceView,
  modelSourceQueryKey,
  switchModelSource,
} from "./model-source-queries";

// Subscription is not offered: switching to it moves every Agent on the
// Computer to one Runtime without checking that Runtime is signed in, and
// unloads local models.
const modes: readonly ModelSourceMode[] = ["local", "byok"];

/** What the page says the Computer's Agents run on now. */
export function activeSourceLabel(status: ModelSourceStatus, t: Translate) {
  const runtime = modelSourceRuntimeLabels[status.runtime];
  if (status.mode === "byok")
    return t(m.sourceByok, { model: status.byok.model_id ?? runtime });
  if (status.mode === "subscription")
    return t(m.sourceSubscription, { runtime });
  return t(m.modeLocal);
}

export interface ModelSourceSwitcher {
  clearFeedback: () => void;
  failure: string | undefined;
  pending: ModelSourceSwitchRequest | undefined;
  request: (body: ModelSourceSwitchRequest) => void;
  saveRevision: number;
}

/**
 * Switching may take minutes while the Computer installs a Runtime or starts
 * its gateway. When Agents are working, the owner chooses whether to end
 * their tasks; nothing changes until they do. Work that starts during the
 * switch is asked about once the Computer has switched.
 */
export function useModelSourceSwitch({
  computerId,
  computerName,
  tenantId,
}: {
  computerId: string;
  computerName: string;
  tenantId: string;
}) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<{
    agents: string[];
    body: ModelSourceSwitchRequest;
  } | null>(null);
  // The answer to the last switch, kept so its notice follows the language.
  const [switched, setSwitched] = useState<ModelSourceView | null>(null);
  const [saveRevision, setSaveRevision] = useState(0);
  const mutation = useMutation({
    mutationFn: (body: ModelSourceSwitchRequest) =>
      switchModelSource(client, tenantId, computerId, body),
    onError: (error, body) => {
      if (
        error instanceof TeamHubError &&
        error.code === "LOCAL_COMPUTER_OFFLINE"
      ) {
        void invalidateOfflineComputer(queryClient, tenantId, computerId);
      } else {
        // A switch can fail after the Computer changed (work started meanwhile,
        // or no answer in time), so show what it serves now.
        void queryClient.invalidateQueries({
          queryKey: modelSourceQueryKey(tenantId, computerId),
        });
      }
      if (
        error instanceof TeamHubError &&
        error.code === "AGENT_HAS_ACTIVE_RUNS"
      )
        setBusy({
          agents: (error.details ?? []).map((detail) => detail.reason),
          body,
        });
    },
    onMutate: () => setSwitched(null),
    onSuccess: (view) => {
      queryClient.setQueryData(modelSourceQueryKey(tenantId, computerId), view);
      setSwitched(view);
      setSaveRevision((current) => current + 1);
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: tenantLocalModelsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: localComputersQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentsQueryKey(tenantId),
        }),
        queryClient.invalidateQueries({
          queryKey: tenantAgentAvailabilityQueryKey(tenantId),
        }),
      ]);
    },
  });
  const failureError =
    mutation.error instanceof TeamHubError ? mutation.error : undefined;
  const switcher: ModelSourceSwitcher = {
    clearFeedback: () => {
      setSwitched(null);
      if (mutation.isError) mutation.reset();
    },
    failure:
      mutation.isError && failureError?.code !== "AGENT_HAS_ACTIVE_RUNS"
        ? modelSourceFailureCopy(failureError, t)
        : undefined,
    pending: mutation.isPending ? mutation.variables : undefined,
    request: (body) => mutation.mutate(body),
    saveRevision,
  };
  const feedback = (
    <>
      {switched ? (
        <div className="mt-4">
          <FormFeedback tone="success">
            {switchedNotice(switched, t)}
          </FormFeedback>
        </div>
      ) : null}
      {busy ? (
        <TerminateTasksDialog
          agents={busy.agents}
          computerName={computerName}
          onClose={() => setBusy(null)}
          onConfirm={() => {
            mutation.mutate({ ...busy.body, force_terminate: true });
            setBusy(null);
          }}
        />
      ) : null}
    </>
  );
  return { feedback, switcher };
}

function switchedNotice(view: ModelSourceView, t: Translate) {
  if (!view.status) return t(m.switched);
  const updated = view.updated_agent_count ?? 0;
  const ended = view.terminated_run_count ?? 0;
  const parts = [
    t(m.agentsNowUse, { source: activeSourceLabel(view.status, t) }),
  ];
  if (updated) parts.push(t(m.agentsMoved, { count: updated }));
  if (ended) parts.push(t(m.tasksEnded, { count: ended }));
  return parts.reduce((first, second) => t(m.sentences, { first, second }));
}

function TerminateTasksDialog({
  agents,
  computerName,
  onClose,
  onConfirm,
}: {
  agents: string[];
  computerName: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useT();
  return (
    <ModalDialog
      footer={
        <>
          <Button onClick={onClose}>{t(commonMessages.cancel)}</Button>
          <Button onClick={onConfirm} tone="danger">
            {t(m.terminateConfirm)}
          </Button>
        </>
      }
      onClose={onClose}
      size="md"
      title={t(m.terminateTitle)}
    >
      <p className="px-5 py-4 text-sm text-muted-foreground">
        {agents.length
          ? t(m.terminateDescription, {
              computer: computerName,
              count: agents.length,
              names: joinList(agents, t),
            })
          : t(m.terminateDescriptionSome, { computer: computerName })}
      </p>
    </ModalDialog>
  );
}

/** The offered model sources as a segmented control; a dot marks the one in use. */
export function ModelSourceTabs({
  active,
  onChange,
  value,
}: {
  active: ModelSourceMode;
  onChange: (mode: ModelSourceMode) => void;
  value: ModelSourceMode;
}) {
  const t = useT();

  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const step = event.key === "ArrowRight" ? 1 : -1;
    const nextIndex = (index + step + modes.length) % modes.length;
    const nextMode = modes[nextIndex];
    if (!nextMode) return;
    onChange(nextMode);
    const tabs = event.currentTarget
      .closest('[role="tablist"]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    tabs?.[nextIndex]?.focus();
  }

  return (
    <div className="mt-5 flex">
      <div
        aria-label={t(m.modelSource)}
        className="inline-flex max-w-full self-start items-center gap-0.5 rounded-xl bg-muted/75 p-1 shadow-[inset_0_1px_1px_rgba(0,0,0,0.04)]"
        role="tablist"
      >
        {modes.map((mode, index) => {
          const selected = mode === value;
          const tab = (
            <button
              aria-selected={selected}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition-[color,background-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                selected
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onChange(mode)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              role="tab"
              type="button"
            >
              {mode === active ? (
                <span
                  aria-label={t(m.inUse)}
                  className="size-1.5 rounded-full bg-app-success"
                  role="img"
                />
              ) : null}
              {t(modelSourceModeLabels[mode])}
            </button>
          );
          return (
            <span className="inline-flex shrink-0" key={mode}>
              {mode === "byok" ? (
                <Hint align="start" placement="top" text={t(m.byokExplanation)}>
                  {tab}
                </Hint>
              ) : (
                tab
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}
