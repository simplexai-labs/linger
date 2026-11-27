import { useState } from "react";

import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import {
  type AgentMoveTarget,
  findReadyRuntime,
  findWritableGrant,
  type LocalComputer,
  resolveModelOnRuntime,
} from "./agent-move-target";

/** The Computer, Runtime, model, and reasoning an Agent's Runtime settings
 * change to. Choosing another Computer applies the move defaults: the current
 * Runtime stays when it is ready there (model kept or first, reasoning kept
 * or default); otherwise the Runtime is left empty for an explicit choice. */
export function useAgentMoveTarget(
  registration: TeamHubTenantAgent,
  computers: readonly LocalComputer[] | undefined,
) {
  const current = registration.runtime.placement;
  const currentComputerId = current?.computer_id ?? "";
  const [computerId, setComputerId] = useState(currentComputerId);
  const [runtimeType, setRuntimeType] = useState<TeamHubLocalRuntimeType | "">(
    current?.runtime_type ?? "codex",
  );
  const [requestedModel, setModel] = useState(registration.runtime.model);
  const [requestedReasoningEffort, setRequestedReasoningEffort] =
    useState<TeamHubAgentReasoningEffort>(
      registration.runtime.reasoning_effort ?? "",
    );

  const moving = computerId !== currentComputerId;
  const computer = computers?.find((item) => item.computer_id === computerId);
  // Keep the Agent's current writable workspace on its Computer; if that
  // grant was removed or downgraded, fall back to a writable workspace on the
  // same Computer because Runtime settings does not offer a workspace picker.
  const grant = !computer
    ? undefined
    : moving
      ? findWritableGrant(computer)
      : (computer.workspace_grants.find(
          (item) =>
            item.grant_id === current?.workspace_grant_id &&
            item.mode === "workspace-write",
        ) ?? findWritableGrant(computer));
  const runtime = computer?.runtimes.find((item) => item.type === runtimeType);
  const modelOptions = runtime?.status === "ready" ? runtime.models : [];
  // A Runtime chosen before it was ready has no model yet; once the Computer
  // reports it ready, it gets the model it would have had if chosen then.
  const model =
    requestedModel ||
    (runtime?.status === "ready"
      ? resolveModelOnRuntime(registration, runtime).model
      : "");
  const selectedModel = modelOptions.find((item) => item.id === model);
  // The Runtime as the Computer last reported it; an offline Computer runs
  // the Agent once it connects.
  const localReady = runtime?.status === "ready" && !computer?.upgrade_required;
  const savedUnavailableEffort =
    !selectedModel && model === registration.runtime.model
      ? registration.runtime.reasoning_effort
      : undefined;
  const reasoningEffort = (() => {
    const allowed = selectedModel?.allowed_reasoning_effort ?? [];
    if (allowed.includes(requestedReasoningEffort)) {
      return requestedReasoningEffort;
    }
    const saved = registration.runtime.reasoning_effort;
    if (
      current?.runtime_type === runtimeType &&
      registration.runtime.model === model &&
      saved &&
      allowed.includes(saved)
    ) {
      return saved;
    }
    const selectedDefault = selectedModel?.default_reasoning_effort;
    if (selectedDefault && allowed.includes(selectedDefault)) {
      return selectedDefault;
    }
    return allowed[0];
  })();
  const target: AgentMoveTarget | undefined =
    computer && grant && runtimeType && model
      ? {
          computerId: computer.computer_id,
          model,
          reasoningEffort,
          runtimeType,
          workspaceGrantId: grant.grant_id,
        }
      : undefined;

  function selectComputer(nextComputerId: string) {
    if (nextComputerId === computerId) return;
    setComputerId(nextComputerId);
    if (nextComputerId === currentComputerId) {
      setRuntimeType(current?.runtime_type ?? "codex");
      setModel(registration.runtime.model);
      setRequestedReasoningEffort(registration.runtime.reasoning_effort ?? "");
      return;
    }
    const target = computers?.find(
      (item) => item.computer_id === nextComputerId,
    );
    const ready = target
      ? findReadyRuntime(target, current?.runtime_type)
      : undefined;
    if (!ready) {
      setRuntimeType("");
      setModel("");
      setRequestedReasoningEffort("");
      return;
    }
    const selection = resolveModelOnRuntime(registration, ready);
    setRuntimeType(ready.type);
    setModel(selection.model);
    setRequestedReasoningEffort(selection.reasoningEffort ?? "");
  }

  function selectRuntime(next: TeamHubLocalRuntimeType) {
    if (next === runtimeType) return;
    const nextRuntime = computer?.runtimes.find((item) => item.type === next);
    const options = nextRuntime?.status === "ready" ? nextRuntime.models : [];
    setRuntimeType(next);
    setModel(
      options.find((item) => item.id === model)?.id ?? options[0]?.id ?? "",
    );
    setRequestedReasoningEffort("");
  }

  return {
    computer,
    computerId,
    grant,
    localReady,
    model,
    modelOptions,
    moving,
    reasoningEffort,
    runtime,
    runtimeType,
    savedUnavailableEffort,
    selectComputer,
    selectModel: setModel,
    selectReasoningEffort: setRequestedReasoningEffort,
    selectRuntime,
    selectedModel,
    target,
  };
}
