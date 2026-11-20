import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { localModelsQueryOptions } from "@/features/local-models/local-models-queries";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

interface RuntimeModel {
  id: string;
  label: string;
  allowed_reasoning_effort?: readonly TeamHubAgentReasoningEffort[];
  default_reasoning_effort?: TeamHubAgentReasoningEffort;
}

const PREFERRED_REASONING_EFFORTS: readonly TeamHubAgentReasoningEffort[] = [
  "medium",
  "low",
  "high",
];

/**
 * Picks the model's explicit default when allowed, else prefers
 * medium -> low -> high -> first non-none -> first allowed.
 */
export function resolveDefaultReasoningEffort(
  allowed: readonly TeamHubAgentReasoningEffort[] | undefined,
  explicitDefault?: TeamHubAgentReasoningEffort,
): TeamHubAgentReasoningEffort | undefined {
  if (!allowed || allowed.length === 0) return undefined;
  if (explicitDefault && allowed.includes(explicitDefault)) {
    return explicitDefault;
  }
  for (const preferred of PREFERRED_REASONING_EFFORTS) {
    if (allowed.includes(preferred)) return preferred;
  }
  return allowed.find((effort) => effort !== "none") ?? allowed[0];
}

/** The model and reasoning effort of a new Agent, chosen among the models the
 * selected Computer Runtime reports; the first model is the default. */
export function useAgentModelSelection(models: readonly RuntimeModel[]) {
  const [requestedModel, setRequestedModel] = useState("");
  const [requestedReasoningEffort, setRequestedReasoningEffort] = useState<
    TeamHubAgentReasoningEffort | ""
  >("");
  const selectedModel =
    models.find(({ id }) => id === requestedModel) ?? models[0];
  const reasoningEfforts = [...(selectedModel?.allowed_reasoning_effort ?? [])];
  const defaultReasoningEffort = resolveDefaultReasoningEffort(
    reasoningEfforts,
    selectedModel?.default_reasoning_effort,
  );
  const reasoningEffort = reasoningEfforts.includes(
    requestedReasoningEffort as TeamHubAgentReasoningEffort,
  )
    ? (requestedReasoningEffort as TeamHubAgentReasoningEffort)
    : defaultReasoningEffort;

  return {
    items: models.map(({ id, label }) => ({ value: id, label })),
    model: selectedModel?.id ?? "",
    reasoningEffort,
    reasoningEfforts,
    selectModel: setRequestedModel,
    selectReasoningEffort: setRequestedReasoningEffort,
  };
}

export function reasoningEffortLabel(value: TeamHubAgentReasoningEffort) {
  return (
    {
      none: "None",
      low: "Low",
      medium: "Medium",
      high: "High",
      xhigh: "Extra high",
      max: "Maximum",
      ultra: "Ultra",
    } satisfies Record<TeamHubAgentReasoningEffort, string>
  )[value];
}

/**
 * Resolves the human-readable model label for an Agent's current runtime,
 * falling back to the Computer's local-models catalog for Bifrost-backed Pi
 * models not yet reflected in the Computer runtime catalog.
 */
export function useResolvedAgentModelLabel(
  client: TeamHubClient,
  tenantId: string,
  runtime: TeamHubTenantAgent["runtime"],
): string;
export function useResolvedAgentModelLabel(
  client: TeamHubClient,
  tenantId: string,
  runtime: TeamHubTenantAgent["runtime"] | undefined,
): string | undefined;
export function useResolvedAgentModelLabel(
  client: TeamHubClient,
  tenantId: string,
  runtime: TeamHubTenantAgent["runtime"] | undefined,
): string | undefined {
  const placement = runtime?.placement;
  const computerId =
    placement?.type === "local" ? placement.computer_id : undefined;
  const computers = useQuery({
    ...localComputersQueryOptions(client, tenantId),
    enabled: Boolean(computerId),
  });
  const catalogLabel = computers.data?.items
    .find((item) => item.computer_id === computerId)
    ?.runtimes.find((item) => item.type === placement?.runtime_type)
    ?.models.find((item) => item.id === runtime?.model)?.label;
  const localModels = useQuery({
    ...localModelsQueryOptions(client, tenantId, computerId ?? ""),
    enabled: Boolean(
      placement?.runtime_type === "pi" &&
      computerId &&
      !catalogLabel &&
      runtime?.model?.startsWith("localmodels-library/"),
    ),
  });
  const localModelLabel = localModels.data?.available
    ? localModels.data.models.find(
        (item) => item.model.pi_model === runtime?.model,
      )?.model.name
    : undefined;
  return catalogLabel ?? localModelLabel ?? runtime?.model;
}
