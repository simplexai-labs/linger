import {
  Add01Icon,
  ArrowLeft01Icon,
  LaptopIcon,
} from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Spinner } from "@/components/ui/spinner";
import {
  appNames,
  runtimeStatusLabels,
} from "@/features/local-computer/computer-readiness";
import { ComputerSetupInstructions } from "@/features/local-computer/computer-setup-instructions";
import { computerSetupMessages } from "@/features/local-computer/computer-setup.messages";
import {
  useCliInstallAvailable,
  useDesktopComputer,
} from "@/features/local-computer/desktop-computer";
import { DesktopComputerSetup } from "@/features/local-computer/desktop-computer-setup";
import { subscribeLocalComputerEnrollment } from "@/features/local-computer/local-computer-enrollment-events";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { LocalRuntimeInstallGuidance } from "@/features/local-computer/local-runtime-install-guidance";
import { LocalRuntimeUpdateGuidance } from "@/features/local-computer/local-runtime-update-guidance";
import {
  classifyPiLocalModelsState,
  piAuthRequiredStatusMessage,
  PiRuntimeSetupGuidance,
} from "@/features/local-computer/pi-runtime-setup-guidance";
import { RuntimeLogo } from "@/features/local-computer/runtime-logo";
import { ServerConnection } from "@/features/local-computer/server-connection";
import { customModelsMessages } from "@/features/local-models/custom-models.messages";
import { localModelsQueryOptions } from "@/features/local-models/local-models-queries";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";
import { RichMessage, useT } from "@/i18n/use-translation";

import {
  QuickCreateGeneralAgent,
  type LocalAgentTarget,
} from "./quick-create-general-agent-page";
import { AgentCreationProgress } from "./agent-creation-progress";
import { createAgentMessages } from "./create-agent.messages";
import { runtimeModelLabel } from "./members/runtime-model-label";
import {
  ComputerStatus,
  EffortSegments,
  OptionList,
  Placeholder,
  SettingRow,
  StatusDot,
} from "./members/runtime-setting-rows";
import {
  customLocalModelIds,
  reasoningEffortLabel,
} from "./members/use-agent-model-selection";

const localRuntimeLabels: Record<TeamHubLocalRuntimeType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  antigravity: "Antigravity",
};

export function QuickCreateLocalAgentDialog({
  tenantId,
  onClose,
}: {
  tenantId: string;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const [computerId, setComputerId] = useState("");
  const [runtimeType, setRuntimeType] = useState<TeamHubLocalRuntimeType>();
  const [modelId, setModelId] = useState("");
  const [effort, setEffort] = useState<TeamHubAgentReasoningEffort>();
  const [target, setTarget] = useState<LocalAgentTarget>();
  const desktop = useDesktopComputer();
  const cliInstallAvailable = useCliInstallAvailable();
  const desktopComputerId = desktop?.status?.computerId;
  const [connection, setConnection] = useState<{
    knownIds: ReadonlySet<string>;
    expectedId?: string;
  }>();
  useEffect(
    () =>
      subscribeLocalComputerEnrollment((event) => {
        if (event.tenantId === tenantId)
          setConnection((current) =>
            current ? { ...current, expectedId: event.computerId } : current,
          );
      }),
    [tenantId],
  );
  const computers = useQuery({
    queryKey: localComputersQueryKey(tenantId),
    queryFn: () => client.listTenantLocalComputers(tenantId),
    retry: false,
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: (query) =>
      query.state.error ||
      target ||
      (!connection &&
        hasReadyLocalModel(
          query.state.data,
          computerId || desktopComputerId || "",
          runtimeType,
        ))
        ? false
        : 2_000,
  });
  // An offline Computer can take a new Agent; it runs once it connects.
  const selectableComputers =
    computers.isFetchedAfterMount && !computers.error
      ? (computers.data?.items.filter(
          (computer) => !computer.upgrade_required,
        ) ?? [])
      : [];
  const desktopComputer = selectableComputers.find(
    (computer) => computer.computer_id === desktopComputerId,
  );
  // In the desktop app the computer it runs on is chosen by default.
  const selectedComputerId = computerId || desktopComputer?.computer_id || "";
  const selectedComputer = selectableComputers.find(
    (computer) => computer.computer_id === selectedComputerId,
  );
  const selectedRuntime =
    selectedComputer?.runtimes.find(
      (runtime) => runtime.type === runtimeType,
    ) ??
    selectedComputer?.runtimes.find(
      (runtime) => runtime.status === "ready" && runtime.models.length > 0,
    ) ??
    selectedComputer?.runtimes[0];
  const modelOptions =
    selectedComputer?.workspace_grants.length &&
    selectedRuntime?.status === "ready"
      ? selectedRuntime.models
      : [];
  const selectedModel =
    modelOptions.find((model) => model.id === modelId) ?? modelOptions[0];
  const allowedEfforts = selectedModel?.allowed_reasoning_effort ?? [];
  const selectedEffort =
    effort && allowedEfforts.includes(effort)
      ? effort
      : selectedModel?.default_reasoning_effort &&
          allowedEfforts.includes(selectedModel.default_reasoning_effort)
        ? selectedModel.default_reasoning_effort
        : allowedEfforts[0];
  const pending =
    computers.isPending ||
    (!computers.isFetchedAfterMount && computers.isFetching);
  // The desktop app connects its own computer, so it never shows the CLI
  // setup until the user asks to connect another one.
  const desktopSetupOpen =
    !computers.error && !connection && Boolean(desktop) && !desktopComputer;
  const setupOpen =
    !computers.error &&
    (Boolean(connection) || desktopSetupOpen || !selectableComputers.length);
  const connectedComputer = connection
    ? selectableComputers.find(
        (computer) =>
          computer.status === "online" &&
          (connection.expectedId
            ? computer.computer_id === connection.expectedId
            : !connection.knownIds.has(computer.computer_id)),
      )
    : undefined;
  const connectedReady = connectedComputer
    ? hasReadyLocalModel(
        { items: [connectedComputer] },
        connectedComputer.computer_id,
      )
    : false;
  const loginComputer = setupOpen ? connectedComputer : selectedComputer;
  const loginRuntime = setupOpen
    ? loginComputer?.runtimes.find(
        (runtime) => runtime.status === "authentication_required",
      )
    : selectedRuntime?.status === "authentication_required"
      ? selectedRuntime
      : undefined;
  const hasLocalLibraryPiModels = Boolean(
    selectedRuntime?.type === "pi" &&
    selectedRuntime.models.some((item) =>
      item.id.startsWith("localmodels-library/"),
    ),
  );
  const localModels = useQuery({
    ...localModelsQueryOptions(client, tenantId, selectedComputerId),
    // The Runtime list words Pi's status from its local models, so they load
    // whenever Pi waits on them, not only once Pi is the chosen Runtime.
    enabled: Boolean(
      !setupOpen &&
      selectedComputerId &&
      (selectedComputer?.runtimes.some(
        (runtime) =>
          runtime.type === "pi" && runtime.status === "authentication_required",
      ) ||
        hasLocalLibraryPiModels),
    ),
  });
  const piModelsState = classifyPiLocalModelsState(localModels.data);
  const customModelIds = customLocalModelIds(localModels.data);

  // One row opens at a time; all start closed on the chosen defaults.
  const [openRow, setOpenRow] = useState<
    "computer" | "runtime" | "model" | "effort"
  >();
  function toggle(row: "computer" | "runtime" | "model" | "effort") {
    setOpenRow((current) => (current === row ? undefined : row));
  }

  function selectComputer(value: string) {
    setComputerId(value);
    setRuntimeType(undefined);
    setModelId("");
    setEffort(undefined);
  }

  // Where the downloaded models of the selected Computer are managed.
  const modelsLink = (text: string) => (
    <Link
      className="whitespace-nowrap font-medium text-foreground underline underline-offset-2"
      onClick={onClose}
      to={`/t/${encodeURIComponent(tenantId)}/settings/models?computer=${encodeURIComponent(selectedComputerId)}`}
    >
      {text}
    </Link>
  );

  if (target)
    return (
      <ModalDialog
        onClose={onClose}
        size="md"
        title={t(createAgentMessages.title)}
      >
        <div className="px-5 py-4">
          <QuickCreateGeneralAgent
            tenantId={tenantId}
            localTarget={target}
            onCreated={onClose}
          />
        </div>
      </ModalDialog>
    );

  return (
    <ModalDialog
      onClose={onClose}
      size="md"
      title={t(createAgentMessages.title)}
      footer={
        !pending ? (
          <>
            <Button
              onClick={connection ? () => setConnection(undefined) : onClose}
            >
              {t(
                connection
                  ? createAgentMessages.back
                  : createAgentMessages.cancel,
              )}
            </Button>
            {connection ? (
              <Button
                tone="primary"
                disabled={!connectedReady}
                onClick={() => {
                  if (!connectedComputer) return;
                  selectComputer(connectedComputer.computer_id);
                  setConnection(undefined);
                }}
              >
                {t(createAgentMessages.useThisComputer)}
              </Button>
            ) : !setupOpen ? (
              <Button
                tone="primary"
                disabled={
                  !selectedComputer || !selectedRuntime || !selectedModel
                }
                onClick={() => {
                  if (!selectedComputer || !selectedRuntime || !selectedModel)
                    return;
                  setTarget({
                    computerId: selectedComputer.computer_id,
                    workspaceGrantId:
                      selectedComputer.workspace_grants[0]!.grant_id,
                    runtimeType: selectedRuntime.type,
                    model: selectedModel.id,
                    reasoningEffort: selectedEffort,
                  });
                }}
              >
                {t(createAgentMessages.create)}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div
        className={`min-w-0 ${pending || computers.error || setupOpen ? "space-y-4 px-5 py-4" : "space-y-1 px-3 pb-2"}`}
      >
        {pending ? (
          <div className="flex justify-center px-4 py-3">
            <AgentCreationProgress stage="preparing" />
          </div>
        ) : computers.error ? (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 text-sm text-app-danger"
          >
            {t(createAgentMessages.computersUnavailable)}
            <Button onClick={() => void computers.refetch()} size="compact">
              {t(createAgentMessages.retry)}
            </Button>
          </div>
        ) : desktop && desktopSetupOpen ? (
          <DesktopComputerSetup desktop={desktop} />
        ) : setupOpen ? (
          <>
            {connection && selectableComputers.length > 0 ? (
              <Button
                size="compact"
                tone="ghost"
                onClick={() => setConnection(undefined)}
              >
                <Icon icon={ArrowLeft01Icon} size={14} />{" "}
                {t(createAgentMessages.backToComputers)}
              </Button>
            ) : null}
            <ComputerSetupInstructions
              connected={Boolean(connectedComputer)}
              waitingForNewComputer={Boolean(connection)}
            />
            {connectedComputer ? (
              <p className="text-sm" role="status">
                {t(createAgentMessages.connected, {
                  name: connectedComputer.display_name,
                })}
              </p>
            ) : null}
            {connectedComputer && !connectedComputer.workspace_grants.length ? (
              <p className="text-xs text-app-muted" role="status">
                {t(createAgentMessages.authorizeWorkspace)}
              </p>
            ) : null}
            <ServerConnection tenantId={tenantId} />
          </>
        ) : (
          <>
            <SettingRow
              label={t(createAgentMessages.computer)}
              onToggle={() => toggle("computer")}
              open={openRow === "computer"}
              value={
                selectedComputer ? (
                  <>
                    <span className="truncate">
                      {selectedComputer.display_name}
                    </span>
                    <ComputerStatus computer={selectedComputer} />
                  </>
                ) : (
                  <Placeholder>
                    {t(createAgentMessages.selectComputer)}
                  </Placeholder>
                )
              }
            >
              <OptionList
                label={t(createAgentMessages.computer)}
                onChange={(value) => {
                  selectComputer(value);
                  setOpenRow(undefined);
                }}
                options={selectableComputers.map((computer) => ({
                  description: <ComputerStatus computer={computer} labelled />,
                  label: computer.display_name,
                  leading: (
                    <Icon
                      className="shrink-0 text-muted-foreground"
                      icon={LaptopIcon}
                    />
                  ),
                  value: computer.computer_id,
                }))}
                value={selectedComputerId}
              />
              {cliInstallAvailable ? (
                <Button
                  className="mt-1"
                  size="compact"
                  tone="ghost"
                  onClick={() => {
                    setOpenRow(undefined);
                    setConnection({
                      knownIds: new Set(
                        computers.data?.items.map(
                          (computer) => computer.computer_id,
                        ),
                      ),
                    });
                  }}
                >
                  <span className="inline-flex items-center gap-1.5 text-app-info">
                    <Icon icon={Add01Icon} size={14} />{" "}
                    {t(createAgentMessages.connectNewComputer)}
                  </span>
                </Button>
              ) : null}
            </SettingRow>
            {selectedComputer?.status === "offline" ? (
              <p className="px-2.5 pb-1 text-xs text-app-muted" role="status">
                {t(createAgentMessages.offlineComputerHint)}
              </p>
            ) : null}
            {selectedComputer ? (
              <>
                <SettingRow
                  disabled={!selectedComputer.runtimes.length}
                  label={t(createAgentMessages.runtime)}
                  onToggle={() => toggle("runtime")}
                  open={openRow === "runtime"}
                  value={
                    selectedRuntime ? (
                      <>
                        <RuntimeLogo type={selectedRuntime.type} />
                        <span className="truncate">
                          {localRuntimeLabels[selectedRuntime.type]}
                        </span>
                      </>
                    ) : (
                      <Placeholder>
                        {t(createAgentMessages.noRuntimes)}
                      </Placeholder>
                    )
                  }
                >
                  <OptionList
                    label={t(createAgentMessages.runtime)}
                    onChange={(value) => {
                      setRuntimeType(value as TeamHubLocalRuntimeType);
                      setModelId("");
                      setEffort(undefined);
                      setOpenRow(undefined);
                    }}
                    options={selectedComputer.runtimes.map((runtime) => ({
                      description: (
                        <>
                          <StatusDot
                            tone={runtime.status === "ready" ? "ok" : "warn"}
                          />
                          {t(
                            runtime.type === "pi" &&
                              runtime.status === "authentication_required"
                              ? piAuthRequiredStatusMessage(piModelsState)
                              : runtimeStatusLabels[runtime.status],
                          )}
                        </>
                      ),
                      label: localRuntimeLabels[runtime.type],
                      leading: <RuntimeLogo type={runtime.type} />,
                      value: runtime.type,
                    }))}
                    value={selectedRuntime?.type ?? ""}
                  />
                </SettingRow>
                <SettingRow
                  disabled={!modelOptions.length}
                  label={t(createAgentMessages.model)}
                  onToggle={() => toggle("model")}
                  open={openRow === "model"}
                  value={
                    selectedModel ? (
                      <>
                        <span className="truncate">
                          {runtimeModelLabel(selectedModel, t)}
                        </span>
                        {customModelIds.has(selectedModel.id) ? (
                          <span className="shrink-0 rounded-sm border border-border bg-muted px-1 py-0.5 text-[10px] leading-none font-medium text-muted-foreground">
                            {t(customModelsMessages.customModelBadge)}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <Placeholder>
                        {t(createAgentMessages.noModels)}
                      </Placeholder>
                    )
                  }
                >
                  <OptionList
                    label={t(createAgentMessages.model)}
                    onChange={(value) => {
                      setModelId(value);
                      setEffort(undefined);
                      setOpenRow(undefined);
                    }}
                    options={modelOptions.map((model) => ({
                      description: customModelIds.has(model.id) ? (
                        <span className="rounded-sm border border-border bg-muted px-1 py-0.5 text-[10px] leading-none font-medium text-muted-foreground">
                          {t(customModelsMessages.customModelBadge)}
                        </span>
                      ) : undefined,
                      label: runtimeModelLabel(model, t),
                      value: model.id,
                    }))}
                    value={selectedModel?.id ?? ""}
                  />
                </SettingRow>
                {selectedRuntime?.type === "pi" && modelOptions.length > 0 ? (
                  <p className="px-2.5 pb-1 text-xs text-muted-foreground">
                    <RichMessage
                      message={createAgentMessages.manageModels}
                      tags={{ link: modelsLink }}
                    />
                  </p>
                ) : null}
                <SettingRow
                  disabled={!allowedEfforts.length}
                  label={t(createAgentMessages.thinkingEffort)}
                  onToggle={() => toggle("effort")}
                  open={openRow === "effort"}
                  value={
                    selectedEffort ? (
                      <span className="truncate">
                        {reasoningEffortLabel(selectedEffort, t)}
                      </span>
                    ) : (
                      <Placeholder>
                        {t(createAgentMessages.effortNotSupported)}
                      </Placeholder>
                    )
                  }
                >
                  <EffortSegments
                    efforts={allowedEfforts}
                    label={t(createAgentMessages.thinkingEffort)}
                    labelOf={(value) => reasoningEffortLabel(value, t)}
                    onChange={setEffort}
                    value={selectedEffort}
                  />
                </SettingRow>
                {!selectedModel && !loginRuntime ? (
                  selectedComputer &&
                  selectedRuntime?.status === "incompatible" ? (
                    <LocalRuntimeUpdateGuidance
                      computerName={selectedComputer.display_name}
                      diagnosticMessage={selectedRuntime.message}
                      platform={selectedComputer.platform}
                      runtimeType={selectedRuntime.type}
                    />
                  ) : selectedComputer &&
                    selectedRuntime?.status === "unknown" ? (
                    <div
                      className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
                      role="status"
                    >
                      <Spinner size={14} />
                      <span>
                        {t(computerSetupMessages.checkingRuntimeBody, {
                          app: appNames[selectedRuntime.type],
                          computer: selectedComputer.display_name,
                        })}
                      </span>
                    </div>
                  ) : selectedComputer &&
                    selectedRuntime?.status === "error" ? (
                    <div
                      className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-xs text-app-body"
                      role="alert"
                    >
                      <p className="font-medium text-foreground">
                        {t(computerSetupMessages.runtimeCheckFailedTitle, {
                          app: appNames[selectedRuntime.type],
                        })}
                      </p>
                      {selectedRuntime.message ? (
                        <p className="mt-1 font-mono text-muted-foreground">
                          {selectedRuntime.message}
                        </p>
                      ) : null}
                    </div>
                  ) : selectedRuntime?.type === "pi" ? (
                    <p className="text-xs text-muted-foreground" role="status">
                      <RichMessage
                        message={createAgentMessages.downloadModel}
                        tags={{ link: modelsLink }}
                      />
                    </p>
                  ) : selectedComputer &&
                    selectedRuntime?.status === "not_installed" ? (
                    <div role="status">
                      <LocalRuntimeInstallGuidance
                        computerName={selectedComputer.display_name}
                        platform={selectedComputer.platform}
                        runtimeTypes={[selectedRuntime.type]}
                      />
                    </div>
                  ) : (
                    <p className="text-xs text-app-muted" role="status">
                      {t(createAgentMessages.noRuntimeModels)}
                    </p>
                  )
                ) : null}
              </>
            ) : null}
          </>
        )}
        {loginComputer && loginRuntime ? (
          !setupOpen && loginRuntime.type === "pi" ? (
            <PiRuntimeSetupGuidance
              computer={loginComputer}
              computerName={loginComputer.display_name}
              isLoadingModels={localModels.isLoading}
              modelsLink={modelsLink}
              state={piModelsState}
            />
          ) : (
            <div className="text-xs text-app-muted" role="status">
              <LocalRuntimeAuthenticationGuidance
                computer={loginComputer}
                computerName={loginComputer.display_name}
                runtimeType={loginRuntime.type}
              />
            </div>
          )
        ) : null}
      </div>
    </ModalDialog>
  );
}

function hasReadyLocalModel(
  page: TeamHubLocalComputerPage | undefined,
  computerId: string,
  runtimeType?: TeamHubLocalRuntimeType,
) {
  return (
    page?.items.some(
      (computer) =>
        (!computerId || computer.computer_id === computerId) &&
        computer.status === "online" &&
        computer.workspace_grants.length > 0 &&
        computer.runtimes.some(
          (runtime) =>
            (!runtimeType || runtime.type === runtimeType) &&
            runtime.status === "ready" &&
            runtime.models.length > 0,
        ),
    ) ?? false
  );
}
