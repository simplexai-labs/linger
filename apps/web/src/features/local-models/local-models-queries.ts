import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

type Schemas = components["schemas"];
export type LocalModelsView = Schemas["LocalModelsView"];
export type LocalModelView = Schemas["LocalModelView"];
export type LocalModel = Schemas["LocalModel"];
export type LocalModelPool = Schemas["LocalModelPool"];
export type LocalModelHost = Schemas["LocalModelHost"];
export type LocalModelActionRequest = Schemas["LocalModelActionRequest"];
export type LocalModelAction = LocalModelActionRequest["action"];
export type LocalModelsRefreshAccepted = Schemas["LocalModelsRefreshAccepted"];

const localModelsPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models";
const localModelActionPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/{modelId}/actions";

/** Every Computer's local-models view of a Tenant: the prefix a computers hint refreshes. */
export function tenantLocalModelsQueryKey(tenantId: string) {
  return ["teamhub", tenantId, "local-models"] as const;
}

export function localModelsQueryKey(tenantId: string, computerId: string) {
  return [...tenantLocalModelsQueryKey(tenantId), computerId] as const;
}

/**
 * One Computer's model library as it last reported it. A local-models hint
 * with the Computer ID refreshes it while a download or load runs.
 */
export function localModelsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(localModelsPath, {
          params: { path: { computerId, tenantId } },
          signal,
        }),
      ),
    queryKey: localModelsQueryKey(tenantId, computerId),
    retry: false,
  });
}

/** Identifies pending memory/model refreshes for one Computer. */
export function localModelsRefreshMutationKey(
  tenantId: string,
  computerId: string,
) {
  return ["teamhub", tenantId, "local-models-refresh", computerId] as const;
}

/** Asks the Computer to recheck free memory and report a fresh snapshot. */
export function refreshLocalComputerModels(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return teamHubData(
    client.api.POST(localModelsPath, {
      params: { path: { computerId, tenantId } },
    }),
  );
}

/** Identifies pending actions of one Computer, so each row can show its own. */
export function localModelActionMutationKey(
  tenantId: string,
  computerId: string,
) {
  return ["teamhub", tenantId, "local-model-action", computerId] as const;
}

export interface LocalModelActionInput {
  action: LocalModelAction;
  modelId: string;
  noAutoload?: boolean;
  unloadFirst?: string[];
}

/** Asks the Computer to start an action; the outcome arrives as a new snapshot. */
export function actOnLocalComputerModel(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  { action, modelId, noAutoload, unloadFirst }: LocalModelActionInput,
) {
  return teamHubData(
    client.api.POST(localModelActionPath, {
      body: {
        action,
        ...(noAutoload ? { no_autoload: true } : {}),
        ...(unloadFirst?.length ? { unload_first: unloadFirst } : {}),
      },
      params: { path: { computerId, modelId, tenantId } },
    }),
  );
}
