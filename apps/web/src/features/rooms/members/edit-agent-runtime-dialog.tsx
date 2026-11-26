import { useQuery } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { Link } from "react-router";

import { LaptopIcon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  appNames,
  runtimeStatusLabels,
} from "@/features/local-computer/computer-readiness";
import { computerSetupMessages } from "@/features/local-computer/computer-setup.messages";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { LocalRuntimeInstallGuidance } from "@/features/local-computer/local-runtime-install-guidance";
import { localRuntimeMessage } from "@/features/local-computer/local-runtime-message";
import { LocalRuntimeUpdateGuidance } from "@/features/local-computer/local-runtime-update-guidance";
import { RuntimeLogo } from "@/features/local-computer/runtime-logo";
import {
  classifyPiLocalModelsState,
  piAuthRequiredStatusMessage,
  type PiLocalModelsState,
  PiRuntimeSetupGuidance,
} from "@/features/local-computer/pi-runtime-setup-guidance";
import { localModelsQueryOptions } from "@/features/local-models/local-models-queries";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import { createAgentMessages } from "../create-agent.messages";

import {
  agentRuntimeUpdate,
  describeMissingDefault,
  type LocalComputer,
  runtimeLabels,
} from "./agent-move-target";
import { agentRuntimeMessages } from "./agent-runtime.messages";
import {
  ComputerStatus,
  EffortSegments,
  ModelHeading,
  OptionList,
  Placeholder,
  SettingRow,
  StatusDot,
} from "./runtime-setting-rows";
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
  const piAuthRequiredOnComputer = Boolean(
    computer?.runtimes.some(
      (item) => item.type === "pi" && item.status === "authentication_required",
    ),
  );
  const localModels = useQuery({
    ...localModelsQueryOptions(
      client as TeamHubClient,
      tenantId,
      selection.computerId,
    ),
    enabled: Boolean(
      client.api &&
      selection.computerId &&
      (selection.runtimeType === "pi" || piAuthRequiredOnComputer),
    ),
  });
  const piModelsState = classifyPiLocalModelsState(localModels.data);
  const unavailableModelLabel =
    (localModels.data?.available
      ? localModels.data.models.find((item) => item.model.pi_model === model)
          ?.model.name
      : undefined) ?? model;
  const loading = computers.isPending;
  const placementLocked = field === "model" || field === "reasoning";
  const noWritableGrant = moving && Boolean(computer) && !grant;
  const unavailable =
    (computers.isError && !computers.data) ||
    (!loading && (!computer || (!moving && !grant)));
  const canSave = Boolean(modelIsAvailable && localReady && target);
  // The row the dialog was opened from starts open; one row opens at a time.
  const [openRow, setOpenRow] = useState<AgentRuntimeField | undefined>(field);
  const modelText = modelIsAvailable
    ? selection.selectedModel?.label
    : model && !loading
      ? t(agentRuntimeMessages.unavailableOption, {
          name: unavailableModelLabel,
        })
      : model || t(agentRuntimeMessages.noModels);

  function toggle(row: AgentRuntimeField) {
    setOpenRow((current) => (current === row ? undefined : row));
  }

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

  const computersLink = (text: string) => (
    <Link
      className="whitespace-nowrap font-medium text-foreground underline underline-offset-2"
      onClick={onClose}
      to={`/t/${encodeURIComponent(tenantId)}/settings/computers`}
    >
      {text}
    </Link>
  );

  const piGuidanceCoversLocalModels =
    runtime?.type === "pi" &&
    runtime.status === "authentication_required" &&
    (localModels.isLoading ||
      piModelsState.kind === "downloading" ||
      piModelsState.kind === "loading" ||
      piModelsState.kind === "download_stopped" ||
      piModelsState.kind === "no_local_model" ||
      piModelsState.kind === "models_installed");

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
        <fieldset className="min-w-0 px-3 pb-1" disabled={isPending || loading}>
          <ModelHeading>{modelText}</ModelHeading>
          <SettingRow
            disabled={placementLocked}
            label={t(agentRuntimeMessages.computer)}
            onToggle={() => toggle("computer")}
            open={openRow === "computer"}
            value={
              computer ? (
                <>
                  <span className="truncate">{computer.display_name}</span>
                  <ComputerStatus computer={computer} />
                </>
              ) : (
                <Placeholder>
                  {t(agentRuntimeMessages.chooseComputer)}
                </Placeholder>
              )
            }
          >
            <OptionList
              label={t(agentRuntimeMessages.computerLabel)}
              onChange={(value) => {
                selection.selectComputer(value);
                setOpenRow(undefined);
              }}
              options={(computers.data?.items ?? []).map((item) => ({
                description: <ComputerStatus computer={item} labelled />,
                disabled: item.upgrade_required,
                label: item.display_name,
                leading: (
                  <Icon
                    className="shrink-0 text-muted-foreground"
                    icon={LaptopIcon}
                  />
                ),
                value: item.computer_id,
              }))}
              value={selection.computerId}
            />
          </SettingRow>
          <SettingRow
            disabled={placementLocked}
            label={t(agentRuntimeMessages.runtime)}
            onToggle={() => toggle("runtime")}
            open={openRow === "runtime"}
            value={
              selection.runtimeType ? (
                <>
                  <RuntimeLogo type={selection.runtimeType} />
                  <span className="truncate">
                    {runtimeLabels[selection.runtimeType]}
                  </span>
                </>
              ) : (
                <Placeholder>
                  {t(agentRuntimeMessages.chooseRuntime)}
                </Placeholder>
              )
            }
          >
            <OptionList
              label={t(agentRuntimeMessages.runtimeLabel)}
              onChange={(value) => {
                selection.selectRuntime(value as TeamHubLocalRuntimeType);
                setOpenRow(undefined);
              }}
              options={(computer?.runtimes ?? []).map((item) => ({
                description: (
                  <>
                    <StatusDot tone={item.status === "ready" ? "ok" : "warn"} />
                    {t(
                      item.type === "pi" &&
                        item.status === "authentication_required"
                        ? piAuthRequiredStatusMessage(piModelsState)
                        : runtimeStatusLabels[item.status],
                    )}
                  </>
                ),
                label: runtimeLabels[item.type],
                leading: <RuntimeLogo size={22} type={item.type} />,
                value: item.type,
              }))}
              value={selection.runtimeType}
            />
          </SettingRow>
          <SettingRow
            disabled={field === "reasoning"}
            label={t(agentRuntimeMessages.model)}
            onToggle={() => toggle("model")}
            open={openRow === "model"}
            value={<span className="truncate">{modelText}</span>}
          >
            {model || selection.modelOptions.length ? (
              <OptionList
                label={t(agentRuntimeMessages.modelLabel)}
                onChange={(value) => {
                  selection.selectModel(value);
                  setOpenRow(undefined);
                }}
                options={[
                  ...(model && !modelIsAvailable
                    ? [
                        {
                          disabled: true,
                          label: t(agentRuntimeMessages.unavailableOption, {
                            name: unavailableModelLabel,
                          }),
                          value: model,
                        },
                      ]
                    : []),
                  ...selection.modelOptions.map((item) => ({
                    label: item.label,
                    value: item.id,
                  })),
                ]}
                value={model}
              />
            ) : (
              <p className="px-2.5 py-2 text-sm text-muted-foreground">
                {t(agentRuntimeMessages.noModels)}
              </p>
            )}
          </SettingRow>
          {selection.runtimeType === "pi" &&
          selection.computerId &&
          !loading &&
          !unavailable &&
          localReady &&
          selection.modelOptions.length > 0 ? (
            <p className="px-2.5 pb-1 text-xs text-muted-foreground">
              <RichMessage
                message={createAgentMessages.manageModels}
                tags={{ link: modelsLink }}
              />
            </p>
          ) : null}
          <ReasoningRow
            allowed={selection.selectedModel?.allowed_reasoning_effort}
            onChange={selection.selectReasoningEffort}
            onToggle={() => toggle("reasoning")}
            open={openRow === "reasoning"}
            savedUnavailableEffort={selection.savedUnavailableEffort}
            value={selection.reasoningEffort}
          />
          <div className="space-y-3 px-2.5 pb-2 pt-2 empty:hidden">
            <EditAgentRuntimeFeedback
              busy={busy}
              computer={computer}
              computersLink={computersLink}
              error={error}
              hasModelOptions={selection.modelOptions.length > 0}
              isLoadingLocalModels={localModels.isLoading}
              loading={loading}
              localModelsAvailable={localModels.data?.available}
              localReady={localReady}
              modelIsAvailable={modelIsAvailable}
              modelsLink={modelsLink}
              moving={moving}
              noWritableGrant={noWritableGrant}
              onRetryComputers={() => void computers.refetch()}
              piGuidanceCoversLocalModels={piGuidanceCoversLocalModels}
              piModelsState={piModelsState}
              registration={registration}
              runtime={runtime}
              runtimeType={selection.runtimeType}
              unavailable={unavailable}
            />
          </div>
        </fieldset>
      </form>
    </ModalDialog>
  );
}

function EditAgentRuntimeFeedback({
  busy,
  computer,
  computersLink,
  error,
  hasModelOptions,
  isLoadingLocalModels,
  loading,
  localModelsAvailable,
  localReady,
  modelIsAvailable,
  modelsLink,
  moving,
  noWritableGrant,
  onRetryComputers,
  piGuidanceCoversLocalModels,
  piModelsState,
  registration,
  runtime,
  runtimeType,
  unavailable,
}: {
  busy: boolean;
  computer: LocalComputer | undefined;
  computersLink: (text: string) => ReactNode;
  error?: string;
  hasModelOptions: boolean;
  isLoadingLocalModels: boolean;
  loading: boolean;
  localModelsAvailable?: boolean;
  localReady: boolean;
  modelIsAvailable: boolean;
  modelsLink: (text: string) => ReactNode;
  moving: boolean;
  noWritableGrant: boolean;
  onRetryComputers: () => void;
  piGuidanceCoversLocalModels: boolean;
  piModelsState: PiLocalModelsState;
  registration: TeamHubTenantAgent;
  runtime: LocalComputer["runtimes"][number] | undefined;
  runtimeType: TeamHubLocalRuntimeType | "";
  unavailable: boolean;
}) {
  const t = useT();
  const missingDefault = moving && computer && !runtimeType;
  const modelMissing =
    !loading &&
    !unavailable &&
    !modelIsAvailable &&
    runtime?.status === "ready";
  const showsError =
    Boolean(missingDefault) ||
    noWritableGrant ||
    modelMissing ||
    unavailable ||
    Boolean(error);
  const piHasNoModels =
    modelMissing &&
    !hasModelOptions &&
    !missingDefault &&
    !noWritableGrant &&
    !error;
  // One muted hint at most, and none while an error explains the state.
  const hint = showsError
    ? undefined
    : busy
      ? agentRuntimeMessages.waitForAgent
      : computer?.status === "offline" && !computer.upgrade_required
        ? createAgentMessages.offlineComputerHint
        : moving && computer
          ? agentRuntimeMessages.moveHint
          : undefined;
  return (
    <>
      {hint ? (
        <p className="text-sm text-app-subtle" role="status">
          {t(hint)}
        </p>
      ) : null}
      {missingDefault ? (
        <p className="text-sm text-app-danger" role="alert">
          {describeMissingDefault(registration, [computer], t)}
        </p>
      ) : null}
      {noWritableGrant ? (
        <p className="text-sm text-app-danger" role="alert">
          {t(agentRuntimeMessages.noWritableWorkspace)}
        </p>
      ) : null}
      {modelMissing ? (
        <p className="text-sm text-app-danger" role="alert">
          {t(
            hasModelOptions
              ? agentRuntimeMessages.currentModelUnavailable
              : agentRuntimeMessages.noRuntimeModels,
          )}
        </p>
      ) : null}
      {!localReady && !loading && !unavailable && computer && runtime ? (
        <RuntimeSetupGuidance
          computer={computer}
          computersLink={computersLink}
          isLoadingLocalModels={isLoadingLocalModels}
          modelsLink={modelsLink}
          piModelsState={piModelsState}
          runtime={runtime}
        />
      ) : null}
      {runtimeType === "pi" &&
      computer &&
      !loading &&
      !unavailable &&
      (!localReady || !hasModelOptions) &&
      !computer.upgrade_required &&
      runtime?.status !== "incompatible" &&
      runtime?.status !== "unknown" &&
      localModelsAvailable !== false &&
      !piGuidanceCoversLocalModels &&
      !hint &&
      // An empty Pi model list is only fixable from Settings › Models, so
      // its link stays beside that error.
      (!showsError || piHasNoModels) ? (
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
            onClick={onRetryComputers}
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
    </>
  );
}

/* Desktop setup installs only the runtime the person chose, so the other
   runtimes usually show up here not installed or signed out. Say which, and
   give the command that fixes it on that computer. */
function RuntimeSetupGuidance({
  computer,
  computersLink,
  isLoadingLocalModels,
  modelsLink,
  piModelsState,
  runtime,
}: {
  computer: LocalComputer;
  computersLink: (text: string) => ReactNode;
  isLoadingLocalModels: boolean;
  modelsLink: (text: string) => ReactNode;
  piModelsState: PiLocalModelsState;
  runtime: LocalComputer["runtimes"][number];
}) {
  const t = useT();
  if (computer.upgrade_required)
    return (
      <div
        className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
        role="alert"
      >
        <RichMessage
          message={computerSetupMessages.computerUpgradeRequired}
          tags={{ link: computersLink }}
          values={{ computer: computer.display_name }}
        />
      </div>
    );
  if (runtime.status === "incompatible")
    return (
      <LocalRuntimeUpdateGuidance
        computerName={computer.display_name}
        diagnosticMessage={runtime.message}
        platform={computer.platform}
        runtimeType={runtime.type}
      />
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
  if (runtime.status === "authentication_required") {
    if (runtime.type === "pi")
      return (
        <PiRuntimeSetupGuidance
          computer={computer}
          computerName={computer.display_name}
          isLoadingModels={isLoadingLocalModels}
          modelsLink={modelsLink}
          state={piModelsState}
        />
      );
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
      </div>
    );
  }
  if (runtime.status === "unknown")
    return (
      <div
        className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-app-body"
        role="status"
      >
        <p className="flex items-center gap-2 font-medium text-foreground">
          <Spinner size={14} />
          {t(computerSetupMessages.checkingRuntimeTitle, {
            app: appNames[runtime.type],
          })}
        </p>
        <p className="mt-1 text-muted-foreground">
          {t(computerSetupMessages.checkingRuntimeBody, {
            app: appNames[runtime.type],
            computer: computer.display_name,
          })}
        </p>
      </div>
    );
  if (runtime.status === "error")
    return (
      <div
        className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
        role="alert"
      >
        <p className="font-medium text-foreground">
          {t(computerSetupMessages.runtimeCheckFailedTitle, {
            app: appNames[runtime.type],
          })}
        </p>
        {runtime.message ? (
          <p className="mt-1.5 rounded-md bg-background/60 px-2.5 py-1.5 font-mono text-xs text-muted-foreground">
            {runtime.message}
          </p>
        ) : null}
        <p className="mt-2 text-xs text-muted-foreground">
          <RichMessage
            message={computerSetupMessages.runtimeCheckFailedBody}
            tags={{ link: computersLink }}
            values={{
              app: appNames[runtime.type],
              computer: computer.display_name,
            }}
          />
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

/* Model and Reasoning are separate choices. While the model's options can't
   be read, its saved Reasoning still shows, marked unavailable like the
   model. */
function ReasoningRow({
  allowed,
  onChange,
  onToggle,
  open,
  savedUnavailableEffort,
  value,
}: {
  allowed?: readonly TeamHubAgentReasoningEffort[];
  onChange: (value: TeamHubAgentReasoningEffort) => void;
  onToggle: () => void;
  open: boolean;
  savedUnavailableEffort?: TeamHubAgentReasoningEffort;
  value?: TeamHubAgentReasoningEffort;
}) {
  const t = useT();
  const available = Boolean(allowed?.length);
  if (!available && !savedUnavailableEffort) return null;
  const text = available
    ? value && reasoningEffortLabel(value, t)
    : t(agentRuntimeMessages.unavailableOption, {
        name: reasoningEffortLabel(savedUnavailableEffort!, t),
      });
  return (
    <SettingRow
      disabled={!available}
      label={t(agentRuntimeMessages.reasoning)}
      onToggle={onToggle}
      open={open}
      value={<span className="truncate">{text}</span>}
    >
      <EffortSegments
        efforts={allowed ?? []}
        label={t(agentRuntimeMessages.reasoningLabel)}
        labelOf={(effort) => reasoningEffortLabel(effort, t)}
        onChange={onChange}
        value={value}
      />
    </SettingRow>
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
      className="whitespace-nowrap font-medium text-foreground underline underline-offset-2"
      onClick={onNavigate}
      to={to}
    >
      {children}
    </Link>
  );
}
