import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useId } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { runtimeStatusLabels } from "@/features/local-computer/computer-readiness";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { LocalRuntimeInstallGuidance } from "@/features/local-computer/local-runtime-install-guidance";
import { localRuntimeMessage } from "@/features/local-computer/local-runtime-message";
import { localModelsQueryOptions } from "@/features/local-models/local-models-queries";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import type { Translate } from "@/i18n/language";
import { RichMessage, useT } from "@/i18n/use-translation";

import { createAgentMessages } from "../create-agent.messages";

import {
  agentRuntimeUpdate,
  describeMissingDefault,
  type LocalComputer,
  runtimeLabels,
} from "./agent-move-target";
import { agentRuntimeMessages } from "./agent-runtime.messages";
import { useAgentMoveTarget } from "./use-agent-move-target";
import { reasoningEffortLabel } from "./use-agent-model-selection";

type Runtime = NonNullable<TeamHubTenantAgentUpdateInput["runtime"]>;

/** The row that opened the dialog. Opened from Computer or Runtime, every
 * field is editable; opened from Model or Reasoning, the placement stays
 * locked, and Reasoning also locks the model. */
export type AgentRuntimeField = "computer" | "runtime" | "model" | "reasoning";

export interface AgentRuntimeUpdateInput {
  runtime: Runtime;
}

export function EditAgentRuntimeDialog({
  busy = false,
  field = "runtime",
  client,
  error,
  isPending,
  onClose,
  onSave,
  registration,
  tenantId,
}: {
  busy?: boolean;
  client: Pick<TeamHubClient, "listTenantLocalComputers"> &
    Partial<Pick<TeamHubClient, "api">>;
  field?: AgentRuntimeField;
  error?: string;
  isPending: boolean;
  onClose: () => void;
  onSave: (input: AgentRuntimeUpdateInput) => void;
  registration: TeamHubTenantAgent;
  tenantId: string;
}) {
  const t = useT();
  const formId = useId();
  const computers = useQuery({
    queryFn: () => client.listTenantLocalComputers(tenantId),
    queryKey: localComputersQueryKey(tenantId),
    retry: false,
    refetchInterval: 5_000,
  });
  const selection = useAgentMoveTarget(registration, computers.data?.items);
  const { computer, grant, localReady, model, moving, runtime, target } =
    selection;
  const modelIsAvailable = Boolean(selection.selectedModel);
  const localModels = useQuery({
    ...localModelsQueryOptions(
      client as TeamHubClient,
      tenantId,
      selection.computerId,
    ),
    enabled: Boolean(
      client.api &&
      selection.runtimeType === "pi" &&
      selection.computerId &&
      model &&
      !modelIsAvailable &&
      model.startsWith("localmodels-library/"),
    ),
  });
  const unavailableModelLabel =
    (localModels.data?.available
      ? localModels.data.models.find((item) => item.model.pi_model === model)
          ?.model.name
      : undefined) ?? model;
  const loading = computers.isPending;
  const placementLocked = field === "model" || field === "reasoning";
  const noWritableGrant = moving && Boolean(computer) && !grant;
  const unavailable =
    computers.isError || (!loading && (!computer || (!moving && !grant)));
  const canSave = Boolean(modelIsAvailable && localReady && target);

  const modelsLink = (text: string) =>
    selection.computerId ? (
      <LocalModelsLink
        computerId={selection.computerId}
        onNavigate={onClose}
        tenantId={tenantId}
      >
        {text}
      </LocalModelsLink>
    ) : (
      text
    );

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave || !target || isPending || busy) return;
    onSave({ runtime: agentRuntimeUpdate(target) });
  }

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title={t(agentRuntimeMessages.title)}
      footer={
        <>
          <Button onClick={onClose} type="button">
            {t(commonMessages.cancel)}
          </Button>
          <Button
            disabled={busy || isPending || loading || unavailable || !canSave}
            form={formId}
            loading={isPending}
            tone="primary"
            type="submit"
          >
            {t(
              moving
                ? agentRuntimeMessages.moveAgent
                : agentRuntimeMessages.saveRuntime,
            )}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit}>
        <fieldset
          className="space-y-4 px-5 py-4"
          disabled={isPending || loading}
        >
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              {t(agentRuntimeMessages.computer)}
            </span>
            <Select
              aria-label={t(agentRuntimeMessages.computerLabel)}
              className="ui-field-control w-full"
              disabled={placementLocked}
              onValueChange={selection.selectComputer}
              placeholder={t(agentRuntimeMessages.chooseComputer)}
              value={selection.computerId}
            >
              {(computers.data?.items ?? []).map((item) => (
                <SelectItem
                  disabled={item.upgrade_required}
                  key={item.computer_id}
                  value={item.computer_id}
                >
                  {computerOptionLabel(item, t)}
                </SelectItem>
              ))}
            </Select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">
              {t(agentRuntimeMessages.runtime)}
            </span>
            <Select
              aria-label={t(agentRuntimeMessages.runtimeLabel)}
              className="ui-field-control w-full"
              disabled={placementLocked}
              onValueChange={(value) =>
                selection.selectRuntime(value as TeamHubLocalRuntimeType)
              }
              placeholder={t(agentRuntimeMessages.chooseRuntime)}
              value={selection.runtimeType}
            >
              {(computer?.runtimes ?? []).map((item) => (
                <SelectItem key={item.type} value={item.type}>
                  {item.status === "ready"
                    ? runtimeLabels[item.type]
                    : t(agentRuntimeMessages.runtimeNotReady, {
                        runtime: runtimeLabels[item.type],
                        status: t(runtimeStatusLabels[item.status]),
                      })}
                </SelectItem>
              ))}
            </Select>
          </label>
          <div className="space-y-1.5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium">
                {t(agentRuntimeMessages.model)}
              </span>
              <Select
                aria-label={t(agentRuntimeMessages.modelLabel)}
                className="ui-field-control w-full"
                disabled={field === "reasoning"}
                onValueChange={selection.selectModel}
                placeholder={t(agentRuntimeMessages.noModels)}
                value={model}
              >
                {model && !modelIsAvailable ? (
                  <SelectItem value={model} disabled>
                    {t(agentRuntimeMessages.unavailableOption, {
                      name: unavailableModelLabel,
                    })}
                  </SelectItem>
                ) : null}
                {selection.modelOptions.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.label}
                  </SelectItem>
                ))}
              </Select>
            </label>
            {selection.runtimeType === "pi" &&
            selection.computerId &&
            !loading &&
            !unavailable &&
            localReady &&
            selection.modelOptions.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                <RichMessage
                  message={createAgentMessages.manageModels}
                  tags={{ link: modelsLink }}
                />
              </p>
            ) : null}
          </div>
          <ReasoningField
            allowed={selection.selectedModel?.allowed_reasoning_effort}
            onChange={selection.selectReasoningEffort}
            savedUnavailableEffort={selection.savedUnavailableEffort}
            value={selection.reasoningEffort}
          />
          {busy ? (
            <p className="text-sm text-app-subtle" role="status">
              {t(agentRuntimeMessages.waitForAgent)}
            </p>
          ) : null}
          {moving && computer ? (
            <p className="text-sm text-app-subtle" role="status">
              {t(agentRuntimeMessages.moveHint)}
            </p>
          ) : null}
          {computer?.status === "offline" && !computer.upgrade_required ? (
            <p className="text-sm text-app-subtle" role="status">
              {t(createAgentMessages.offlineComputerHint)}
            </p>
          ) : null}
          {moving && computer && !selection.runtimeType ? (
            <p className="text-sm text-app-danger" role="alert">
              {describeMissingDefault(registration, [computer], t)}
            </p>
          ) : null}
          {noWritableGrant ? (
            <p className="text-sm text-app-danger" role="alert">
              {t(agentRuntimeMessages.noWritableWorkspace)}
            </p>
          ) : null}
          {!loading &&
          !unavailable &&
          !modelIsAvailable &&
          runtime?.status === "ready" ? (
            <p className="text-sm text-app-danger" role="alert">
              {t(
                selection.modelOptions.length
                  ? agentRuntimeMessages.currentModelUnavailable
                  : agentRuntimeMessages.noRuntimeModels,
              )}
            </p>
          ) : null}
          {!localReady && !loading && !unavailable && computer && runtime ? (
            <RuntimeSetupGuidance computer={computer} runtime={runtime} />
          ) : null}
          {selection.runtimeType === "pi" &&
          selection.computerId &&
          !loading &&
          !unavailable &&
          (!localReady || selection.modelOptions.length === 0) ? (
            <p className="text-xs text-muted-foreground">
              <RichMessage
                message={createAgentMessages.downloadModel}
                tags={{ link: modelsLink }}
              />
            </p>
          ) : null}
          {unavailable ? (
            <p className="text-sm text-app-danger" role="alert">
              {t(agentRuntimeMessages.optionsUnavailable)}
              <button
                className="ml-2 underline"
                type="button"
                onClick={() => void computers.refetch()}
              >
                {t(commonMessages.retry)}
              </button>
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-app-danger" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      </form>
    </ModalDialog>
  );
}

/* Desktop setup installs only the runtime the person chose, so the other
   runtimes usually show up here not installed or signed out. Say which, and
   give the command that fixes it on that computer. */
function RuntimeSetupGuidance({
  computer,
  runtime,
}: {
  computer: LocalComputer;
  runtime: LocalComputer["runtimes"][number];
}) {
  const t = useT();
  if (computer.upgrade_required)
    return (
      <p className="text-sm text-app-danger" role="alert">
        {localRuntimeMessage(
          { error_code: "LOCAL_COMPUTER_UPGRADE_REQUIRED" },
          runtime.type,
          computer.display_name,
          t,
        )}
      </p>
    );
  if (runtime.status === "not_installed")
    return (
      <div role="status">
        <LocalRuntimeInstallGuidance
          computerName={computer.display_name}
          platform={computer.platform}
          runtimeTypes={[runtime.type]}
        />
      </div>
    );
  if (runtime.status === "incompatible")
    return (
      <div className="space-y-1.5" role="status">
        <p className="text-sm text-app-danger" title={runtime.message}>
          {localRuntimeMessage(
            runtime,
            runtime.type,
            computer.display_name,
            t,
          ) ?? t(agentRuntimeMessages.installAndSignIn)}
        </p>
        <LocalRuntimeInstallGuidance
          action="update"
          computerName={computer.display_name}
          platform={computer.platform}
          runtimeTypes={[runtime.type]}
        />
      </div>
    );
  if (runtime.status === "authentication_required")
    return (
      <div
        className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
        role="status"
      >
        <LocalRuntimeAuthenticationGuidance
          computer={computer}
          computerName={computer.display_name}
          runtimeType={runtime.type}
        />
        <p className="mt-1 text-muted-foreground">
          {t(agentRuntimeMessages.readyAfterSignIn)}
        </p>
      </div>
    );
  return (
    <p className="text-sm text-app-danger" role="alert" title={runtime.message}>
      {localRuntimeMessage(runtime, runtime.type, computer.display_name, t) ??
        t(agentRuntimeMessages.installAndSignIn)}
    </p>
  );
}

function computerOptionLabel(computer: LocalComputer, t: Translate) {
  const online = computer.status === "online";
  const message = computer.upgrade_required
    ? online
      ? agentRuntimeMessages.computerOnlineUpgrade
      : agentRuntimeMessages.computerOfflineUpgrade
    : online
      ? agentRuntimeMessages.computerOnline
      : agentRuntimeMessages.computerOffline;
  return t(message, { name: computer.display_name });
}

/* Model and Reasoning are separate choices. While the model's options can't
   be read, its saved Reasoning still shows, marked unavailable like the
   model. */
function ReasoningField({
  allowed,
  onChange,
  savedUnavailableEffort,
  value,
}: {
  allowed?: readonly TeamHubAgentReasoningEffort[];
  onChange: (value: TeamHubAgentReasoningEffort) => void;
  savedUnavailableEffort?: TeamHubAgentReasoningEffort;
  value?: TeamHubAgentReasoningEffort;
}) {
  const t = useT();
  if (!allowed?.length) {
    if (!savedUnavailableEffort) return null;
    return (
      <div>
        <span className="mb-1.5 block text-sm font-medium">
          {t(agentRuntimeMessages.reasoning)}
        </span>
        <Select
          aria-label={t(agentRuntimeMessages.reasoningLabel)}
          className="ui-field-control w-full"
          disabled
          onValueChange={() => {}}
          value={savedUnavailableEffort}
        >
          <SelectItem value={savedUnavailableEffort} disabled>
            {t(agentRuntimeMessages.unavailableOption, {
              name: reasoningEffortLabel(savedUnavailableEffort, t),
            })}
          </SelectItem>
        </Select>
      </div>
    );
  }
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">
        {t(agentRuntimeMessages.reasoning)}
      </span>
      <Select
        aria-label={t(agentRuntimeMessages.reasoningLabel)}
        className="ui-field-control w-full"
        onValueChange={(next) => onChange(next as TeamHubAgentReasoningEffort)}
        value={value ?? ""}
      >
        {allowed.map((effort) => (
          <SelectItem key={effort} value={effort}>
            {reasoningEffortLabel(effort, t)}
          </SelectItem>
        ))}
      </Select>
    </label>
  );
}

function LocalModelsLink({
  children,
  computerId,
  onNavigate,
  tenantId,
}: {
  children: string;
  computerId: string;
  onNavigate: () => void;
  tenantId: string;
}) {
  const to = `/t/${encodeURIComponent(tenantId)}/settings/models?computer=${encodeURIComponent(computerId)}`;
  return (
    <Link
      className="font-medium text-foreground underline underline-offset-2"
      onClick={onNavigate}
      to={to}
    >
      {children}
    </Link>
  );
}
