import { useQuery } from "@tanstack/react-query";

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

export const reasoningEffortMessages: Readonly<Record<string, Message>> = {
  off: composerMessages.effortOff,
  none: composerMessages.effortNone,
  minimal: composerMessages.effortMinimal,
  low: composerMessages.effortLow,
  medium: composerMessages.effortMedium,
  high: composerMessages.effortHigh,
  xhigh: composerMessages.effortExtraHigh,
  max: composerMessages.effortMaximum,
  ultra: composerMessages.effortUltra,
};

/** The effort's name; a component passes its own `t` to follow the language. */
export function reasoningEffortLabel(
  value: TeamHubAgentReasoningEffort,
  t: Translate = translate,
) {
  const message = Object.hasOwn(reasoningEffortMessages, value)
    ? reasoningEffortMessages[value]
    : undefined;
  if (message) return t(message);
  const words = value.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : value;
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
  const catalogModel = computers.data?.items
    .find((item) => item.computer_id === computerId)
    ?.runtimes.find((item) => item.type === placement?.runtime_type)
    ?.models.find((item) => item.id === runtime?.model);
  const catalogLabel = catalogModel && runtimeModelLabel(catalogModel, t);
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
