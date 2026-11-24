import { Add01Icon, ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { Select, SelectItem } from "@/components/ui/select";
import { ComputerSetupInstructions } from "@/features/local-computer/computer-setup-instructions";
import {
  useCliInstallAvailable,
  useDesktopComputer,
} from "@/features/local-computer/desktop-computer";
import { DesktopComputerSetup } from "@/features/local-computer/desktop-computer-setup";
import { subscribeLocalComputerEnrollment } from "@/features/local-computer/local-computer-enrollment-events";
import { localComputersQueryKey } from "@/features/local-computer/local-computer-queries";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { LocalRuntimeInstallGuidance } from "@/features/local-computer/local-runtime-install-guidance";
import { ServerConnection } from "@/features/local-computer/server-connection";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
} from "@/features/teamhub/teamhub-types";
import type { Message } from "@/i18n/messages";
import { RichMessage, useT } from "@/i18n/use-translation";

import {
  QuickCreateGeneralAgent,
  type LocalAgentTarget,
} from "./quick-create-general-agent-page";
import { AgentCreationProgress } from "./agent-creation-progress";
import { createAgentMessages } from "./create-agent.messages";
import { runtimeModelLabel } from "./members/runtime-model-label";

const localRuntimeLabels: Record<TeamHubLocalRuntimeType, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "Pi",
  antigravity: "Antigravity",
};

const effortLabels: Record<TeamHubAgentReasoningEffort, Message<string>> = {
  none: createAgentMessages.effortNone,
  low: createAgentMessages.effortLow,
  medium: createAgentMessages.effortMedium,
  high: createAgentMessages.effortHigh,
  xhigh: createAgentMessages.effortExtraHigh,
  max: createAgentMessages.effortMaximum,
  ultra: createAgentMessages.effortUltra,
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

  function selectComputer(value: string) {
    setComputerId(value);
    setRuntimeType(undefined);
    setModelId("");
    setEffort(undefined);
  }

  // Where the downloaded models of the selected Computer are managed.
  const modelsLink = (text: string) => (
    <Link
      className="font-medium text-foreground underline underline-offset-2"
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
      description={t(
        setupOpen
          ? createAgentMessages.connectDescription
          : createAgentMessages.chooseDescription,
      )}
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
      <div className="space-y-4 px-5 py-4">
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
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <label
                  className="text-sm font-medium"
                  htmlFor="local-agent-computer"
                >
                  {t(createAgentMessages.computer)}
                </label>
                {cliInstallAvailable ? (
                  <Button
                    size="compact"
                    tone="ghost"
                    onClick={() =>
                      setConnection({
                        knownIds: new Set(
                          computers.data?.items.map(
                            (computer) => computer.computer_id,
                          ),
                        ),
                      })
                    }
                  >
                    <span className="inline-flex items-center gap-1.5 text-app-info">
                      <Icon icon={Add01Icon} size={14} />{" "}
                      {t(createAgentMessages.connectNewComputer)}
                    </span>
                  </Button>
                ) : null}
              </div>
              <Select
                id="local-agent-computer"
                aria-label={t(createAgentMessages.computer)}
                className="min-w-0 w-full"
                onValueChange={selectComputer}
                placeholder={t(createAgentMessages.selectComputer)}
                value={selectedComputerId}
              >
                {selectableComputers.map((computer) => (
                  <SelectItem
                    key={computer.computer_id}
                    value={computer.computer_id}
                  >
                    {computer.status === "online"
                      ? computer.display_name
                      : t(createAgentMessages.offlineComputer, {
                          name: computer.display_name,
                        })}
                  </SelectItem>
                ))}
              </Select>
              {selectedComputer?.status === "offline" ? (
                <p className="mt-1.5 text-xs text-app-muted" role="status">
                  {t(createAgentMessages.offlineComputerHint)}
                </p>
              ) : null}
            </div>
            {selectedComputer ? (
              <>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    {t(createAgentMessages.runtime)}
                  </span>
                  <Select
                    aria-label={t(createAgentMessages.runtime)}
                    className="min-w-0 w-full"
                    disabled={!selectedComputer.runtimes.length}
                    placeholder={t(createAgentMessages.noRuntimes)}
                    value={selectedRuntime?.type ?? ""}
                    onValueChange={(value) => {
                      setRuntimeType(value as TeamHubLocalRuntimeType);
                      setModelId("");
                      setEffort(undefined);
                    }}
                  >
                    {selectedComputer.runtimes.map((runtime) => (
                      <SelectItem key={runtime.type} value={runtime.type}>
                        {localRuntimeLabels[runtime.type]}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                <div className="space-y-1.5">
                  <label className="block">
                    <span className="mb-1.5 block text-sm font-medium">
                      {t(createAgentMessages.model)}
                    </span>
                    <Select
                      aria-label={t(createAgentMessages.model)}
                      className="min-w-0 w-full"
                      disabled={!modelOptions.length}
                      placeholder={t(createAgentMessages.noModels)}
                      value={selectedModel?.id ?? ""}
                      onValueChange={(value) => {
                        setModelId(value);
                        setEffort(undefined);
                      }}
                    >
                      {modelOptions.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {runtimeModelLabel(model, t)}
                        </SelectItem>
                      ))}
                    </Select>
                  </label>
                  {selectedRuntime?.type === "pi" && modelOptions.length > 0 ? (
                    <p className="text-xs text-muted-foreground">
                      <RichMessage
                        message={createAgentMessages.manageModels}
                        tags={{ link: modelsLink }}
                      />
                    </p>
                  ) : null}
                </div>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium">
                    {t(createAgentMessages.thinkingEffort)}
                  </span>
                  <Select
                    aria-label={t(createAgentMessages.thinkingEffort)}
                    className="min-w-0 w-full"
                    disabled={!allowedEfforts.length}
                    placeholder={t(createAgentMessages.effortNotSupported)}
                    value={selectedEffort ?? ""}
                    onValueChange={(value) =>
                      setEffort(value as TeamHubAgentReasoningEffort)
                    }
                  >
                    {allowedEfforts.map((value) => (
                      <SelectItem key={value} value={value}>
                        {t(effortLabels[value])}
                      </SelectItem>
                    ))}
                  </Select>
                </label>
                {!selectedModel && !loginRuntime ? (
                  selectedRuntime?.type === "pi" &&
                  selectedRuntime.status !== "incompatible" ? (
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
                  ) : selectedComputer &&
                    selectedRuntime?.status === "incompatible" ? (
                    <div role="status">
                      <LocalRuntimeInstallGuidance
                        action="update"
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
          <div className="text-xs text-app-muted" role="status">
            <LocalRuntimeAuthenticationGuidance
              computer={loginComputer}
              computerName={loginComputer.display_name}
              runtimeType={loginRuntime.type}
            />
          </div>
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
