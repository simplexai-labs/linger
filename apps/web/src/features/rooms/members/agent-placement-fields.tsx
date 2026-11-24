import { RefreshIcon } from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { ComputerSetupInstructions } from "@/features/local-computer/computer-setup-instructions";
import { computersMessages } from "@/features/local-computer/computers.messages";
import { useCliInstallAvailable } from "@/features/local-computer/desktop-computer";
import { LocalRuntimeAuthenticationGuidance } from "@/features/local-computer/local-runtime-authentication-guidance";
import { commonMessages } from "@/i18n/common.messages";
import { type Translate, translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";

import { agentInfoMessages } from "./agent-info.messages";
import { agentRuntimeMessages } from "./agent-runtime.messages";

import type { useLocalRuntimeSelection } from "./use-local-runtime-selection";

export function AgentPlacementFields({
  disabled = false,
  invalid = false,
  onSelectionChange,
  selection,
}: {
  disabled?: boolean;
  invalid?: boolean;
  onSelectionChange: () => void;
  selection: ReturnType<typeof useLocalRuntimeSelection>;
}) {
  const t = useT();
  return (
    // eslint-disable-next-line jsx-a11y/role-supports-aria-props -- aria-description / aria-disabled / aria-invalid are valid ARIA 1.3 global or form-group attributes missing from the rule data
    <div
      aria-invalid={invalid || undefined}
      aria-label={t(agentInfoMessages.placementLabel)}
      className={`space-y-4 rounded-lg transition-shadow ${invalid ? "ring-1 ring-inset ring-app-danger" : ""}`}
      role="group"
      tabIndex={invalid ? -1 : undefined}
    >
      <LocalRuntimeFields
        disabled={disabled}
        onSelectionChange={onSelectionChange}
        selection={selection}
      />
    </div>
  );
}

export function LocalRuntimeFields({
  disabled,
  onSelectionChange,
  selection,
}: {
  disabled: boolean;
  onSelectionChange: () => void;
  selection: ReturnType<typeof useLocalRuntimeSelection>;
}) {
  const t = useT();
  if (selection.isPending) {
    return (
      <LocalRuntimeStatus>
        {t(agentInfoMessages.lookingForComputers)}
      </LocalRuntimeStatus>
    );
  }
  if (selection.error) {
    return (
      <LocalComputerSetupPrompt
        connected={false}
        disabled={disabled}
        onRetry={() => void selection.refetch()}
        title={t(agentInfoMessages.computersUnavailable)}
        titleTone="danger"
      />
    );
  }
  if (!selection.computer) {
    return (
      <LocalComputerSetupPrompt
        connected={false}
        disabled={disabled}
        onRetry={() => void selection.refetch()}
        title={t(agentInfoMessages.noComputerOnline)}
      />
    );
  }

  return (
    <div className="grid gap-3 rounded-lg bg-app-sidebar p-3">
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">
          {t(agentRuntimeMessages.computer)}
        </span>
        <Select
          aria-label={t(agentInfoMessages.localComputer)}
          className="ui-field-control w-full"
          disabled={disabled}
          onValueChange={(value) => {
            onSelectionChange();
            selection.selectComputer(value);
          }}
          value={selection.computer.computer_id}
        >
          {selection.computers.map((computer) => (
            <SelectItem key={computer.computer_id} value={computer.computer_id}>
              {computer.display_name}
            </SelectItem>
          ))}
        </Select>
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium">
          {t(agentRuntimeMessages.runtime)}
        </span>
        <Select
          aria-label={t(agentInfoMessages.localRuntime)}
          className="ui-field-control w-full capitalize"
          disabled={disabled}
          onValueChange={(value) => {
            onSelectionChange();
            selection.selectRuntime(value);
          }}
          value={selection.runtime}
        >
          {selection.computer.runtimes.map((runtime) => (
            <SelectItem
              disabled={
                runtime.status !== "ready" &&
                runtime.status !== "authentication_required"
              }
              key={runtime.type}
              value={runtime.type}
            >
              {runtimeLabel(runtime.type, runtime.status, t)}
            </SelectItem>
          ))}
        </Select>
      </label>
      {selection.runtimeDiagnostic?.status === "authentication_required" ? (
        <div
          className="rounded-lg border border-[var(--app-status-warning-border)] bg-[var(--app-status-warning-surface)] p-3 text-sm text-app-body"
          role="status"
        >
          <LocalRuntimeAuthenticationGuidance
            runtimeType={selection.runtimeDiagnostic.type}
            computerName={selection.computer.display_name}
            computer={selection.computer}
          />
        </div>
      ) : null}
      <p className="text-xs leading-4 text-app-muted">
        {t(agentInfoMessages.staysOnMachine)}
      </p>
    </div>
  );
}

type LocalRuntimeState =
  | "not_installed"
  | "authentication_required"
  | "ready"
  | "incompatible"
  | "error"
  | "unknown";

const runtimeStateLabels: Record<LocalRuntimeState, Message<string>> = {
  authentication_required: agentInfoMessages.statusSignInRequired,
  error: agentInfoMessages.statusDetectionFailed,
  unknown: computersMessages.statusUnavailable,
  incompatible: agentInfoMessages.statusUpgradeRequired,
  not_installed: computersMessages.notInstalled,
  ready: computersMessages.ready,
};

function runtimeLabel(
  type: string,
  status: LocalRuntimeState,
  t: Translate = translate,
) {
  return t(agentInfoMessages.runtimeOption, {
    runtime: type,
    status: t(runtimeStateLabels[status]),
  });
}

function LocalComputerSetupPrompt({
  connected,
  disabled,
  onRetry,
  title,
  titleTone,
}: {
  connected: boolean;
  disabled: boolean;
  onRetry: () => void;
  title: string;
  titleTone?: "danger";
}) {
  const t = useT();
  const cliInstallAvailable = useCliInstallAvailable();
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p
          className={`text-sm font-medium ${titleTone === "danger" ? "text-app-danger" : "text-app-body"}`}
        >
          {title}
        </p>
        <Button
          aria-label={t(agentInfoMessages.retryComputers)}
          disabled={disabled}
          onClick={onRetry}
          size="compact"
          type="button"
        >
          <Icon icon={RefreshIcon} size={14} />
          {t(commonMessages.retry)}
        </Button>
      </div>
      {cliInstallAvailable ? (
        <ComputerSetupInstructions connected={connected} />
      ) : null}
    </div>
  );
}

function LocalRuntimeStatus({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-border bg-muted/40 p-3 text-sm text-app-muted">
      {children}
    </p>
  );
}
