import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { localComputersQueryOptions } from "@/features/local-computer/local-computer-queries";
import { localModelsQueryOptions } from "@/features/local-models/local-models-queries";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import { translate, type Translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

import { composerMessages } from "../chat/composer.messages";
import { runtimeModelLabel } from "./runtime-model-label";

export interface RuntimeModelLabelEntry {
  id: string;
  label: string;
}

interface RuntimeModel extends RuntimeModelLabelEntry {
  allowed_reasoning_effort?: readonly TeamHubAgentReasoningEffort[];
  default_reasoning_effort?: TeamHubAgentReasoningEffort;
}

function baseRuntimeModelLabel(
  model: RuntimeModelLabelEntry,
  t: Translate = translate,
): string {
  return runtimeModelLabel(model, t).trim() || model.id;
}

/**
 * Builds unique display labels for one Runtime's model catalog, appending
 * `(<id>)` when two or more distinct model IDs resolve to the same label and
 * resolving any secondary collisions introduced by a suffix.
 */
export function runtimeModelLabels(
  models: readonly RuntimeModelLabelEntry[],
  t: Translate = translate,
): Map<string, string> {
  const uniqueIds: string[] = [];
  const resolved = new Map<string, string>();
  for (const model of models) {
    if (!resolved.has(model.id)) {
      uniqueIds.push(model.id);
      resolved.set(model.id, baseRuntimeModelLabel(model, t));
    }
  }

  for (let pass = 0; pass < uniqueIds.length; pass += 1) {
    const idsByLabel = new Map<string, string[]>();
    for (const id of uniqueIds) {
      const label = resolved.get(id) ?? id;
      let ids = idsByLabel.get(label);
      if (!ids) {
        ids = [];
        idsByLabel.set(label, ids);
      }
      ids.push(id);
    }

    let hadCollision = false;
    for (const [label, ids] of idsByLabel) {
      if (ids.length <= 1) continue;
      hadCollision = true;
      let changed = false;
      for (const id of ids) {
        if (label !== id && !label.endsWith(` (${id})`)) {
          resolved.set(id, `${label} (${id})`);
          changed = true;
        }
      }
      if (!changed) {
        for (const id of ids) {
          resolved.set(id, id);
        }
      }
    }

    if (!hadCollision) break;
  }

  return resolved;
}

/** Returns Runtime model entries with disambiguated display labels. */
export function withDisambiguatedModelLabels<T extends RuntimeModelLabelEntry>(
  models: readonly T[],
  t: Translate = translate,
): T[] {
  const labels = runtimeModelLabels(models, t);
  return models.map((model) => ({
    ...model,
    label: labels.get(model.id) ?? model.id,
  }));
}

/** Resolves one model's display label within its Runtime's model catalog. */
export function resolveRuntimeModelLabel(
  models: readonly RuntimeModelLabelEntry[] | undefined,
  modelId: string | undefined,
  t: Translate = translate,
): string | undefined {
  if (!models || !modelId) return undefined;
  return runtimeModelLabels(models, t).get(modelId);
}

/** The model and reasoning effort of a new Agent, chosen among the models the
 * selected Computer Runtime reports; the first model is the default. */
export function useAgentModelSelection(models: readonly RuntimeModel[]) {
  const t = useT();
  const [requestedModel, setRequestedModel] = useState("");
  const [requestedReasoningEffort, setRequestedReasoningEffort] = useState<
    TeamHubAgentReasoningEffort | ""
  >("");
  const selectedModel =
    models.find(({ id }) => id === requestedModel) ?? models[0];
  const reasoningEfforts = [...(selectedModel?.allowed_reasoning_effort ?? [])];
  const defaultReasoningEffort =
    selectedModel?.default_reasoning_effort &&
    reasoningEfforts.includes(selectedModel.default_reasoning_effort)
      ? selectedModel.default_reasoning_effort
      : reasoningEfforts[0];
  const reasoningEffort = reasoningEfforts.includes(
    requestedReasoningEffort as TeamHubAgentReasoningEffort,
  )
    ? (requestedReasoningEffort as TeamHubAgentReasoningEffort)
    : defaultReasoningEffort;
  const labels = runtimeModelLabels(models, t);

  return {
    items: models.map(({ id }) => ({
      value: id,
      label: labels.get(id) ?? id,
    })),
    model: selectedModel?.id ?? "",
    reasoningEffort,
    reasoningEfforts,
    selectModel: setRequestedModel,
    selectReasoningEffort: setRequestedReasoningEffort,
  };
}

export const reasoningEffortMessages = {
  none: composerMessages.effortNone,
  low: composerMessages.effortLow,
  medium: composerMessages.effortMedium,
  high: composerMessages.effortHigh,
  xhigh: composerMessages.effortExtraHigh,
  max: composerMessages.effortMaximum,
  ultra: composerMessages.effortUltra,
} satisfies Record<TeamHubAgentReasoningEffort, Message>;

/** The effort's name; a component passes its own `t` to follow the language. */
export function reasoningEffortLabel(
  value: TeamHubAgentReasoningEffort,
  t: Translate = translate,
) {
  return t(reasoningEffortMessages[value]);
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
  const t = useT();
  const placement = runtime?.placement;
  const computerId =
    placement?.type === "local" ? placement.computer_id : undefined;
  const computers = useQuery({
    ...localComputersQueryOptions(client, tenantId),
    enabled: Boolean(computerId),
  });
  const runtimeModels = computers.data?.items
    .find((item) => item.computer_id === computerId)
    ?.runtimes.find((item) => item.type === placement?.runtime_type)?.models;
  const catalogLabel = resolveRuntimeModelLabel(
    runtimeModels,
    runtime?.model,
    t,
  );
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
  return (
    catalogLabel ??
    localModelLabel ??
    (runtime?.model
      ? runtimeModelLabel({ id: runtime.model, label: runtime.model }, t)
      : undefined)
  );
}
