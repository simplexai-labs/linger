import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { queryOptions } from "@tanstack/react-query";

import { teamHubData } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

type Schemas = components["schemas"];

export type CustomModelFormat = Schemas["LocalModelFormat"];
export type CustomModelHub = Schemas["LocalModelCustomHub"];
export type CustomModelSearchHub = Schemas["LocalModelCustomSearchHub"];
export type CustomModelSearchFormat = Schemas["LocalModelCustomSearchFormat"];
export type CustomModelSearchRequest = Schemas["LocalModelCustomSearchRequest"];
export type CustomModelSearchResponse =
  Schemas["LocalModelCustomSearchResponse"];
export type CustomModelSearchResultItem =
  Schemas["LocalModelCustomSearchResultItem"];
export type CustomModelProbeHub = Schemas["LocalModelCustomProbeHub"];
export type CustomModelProbeRequest = Schemas["LocalModelCustomProbeRequest"];
export type CustomModelProbeResponse = Schemas["LocalModelCustomProbeResponse"];
export type CustomModelProbeRepo = Schemas["LocalModelCustomProbeRepo"];
export type CustomModelProbeHost = Schemas["LocalModelCustomProbeHost"];
export type CustomModelQuantVariant = Schemas["LocalModelCustomQuantVariant"];
export type CustomModelDownloadInput = Schemas["LocalModelCustomDownloadInput"];
export type CustomModelDownloadAccepted =
  Schemas["LocalModelCustomDownloadAccepted"];
export type CustomModelInfo = Schemas["LocalModelCustomInfo"];
export type CustomModelVerification = Schemas["LocalModelVerification"];
export type CustomModelVerificationFailure =
  Schemas["LocalModelVerificationFailure"];
export type CustomModelIncompatibleReason =
  Schemas["LocalModelCustomIncompatibleReason"];

const customSearchPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/custom/search";
const customProbePath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/custom/probe";
const customDownloadPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/local-models/custom/download";

export interface CustomModelSearchParams {
  format: CustomModelSearchFormat;
  hub: CustomModelSearchHub;
  limit?: number;
  query: string;
}

export function customModelSearchQueryKey(
  tenantId: string,
  computerId: string,
  params: CustomModelSearchParams,
) {
  return [
    "teamhub",
    tenantId,
    "local-models-custom-search",
    computerId,
    params.hub,
    params.format,
    params.query,
    params.limit ?? 20,
  ] as const;
}

/** Searches Hugging Face / ModelScope repositories from the Computer. */
export function searchLocalComputerCustomModels(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  body: CustomModelSearchRequest,
  signal?: AbortSignal,
) {
  return teamHubData(
    client.api.POST(customSearchPath, {
      body,
      params: { path: { computerId, tenantId } },
      signal,
    }),
  );
}

/** React Query options for browsing and filtering community repositories. */
export function customModelSearchQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  params: CustomModelSearchParams,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      searchLocalComputerCustomModels(
        client,
        tenantId,
        computerId,
        {
          format: params.format,
          hub: params.hub,
          limit: params.limit ?? 20,
          query: params.query,
        },
        signal,
      ),
    queryKey: customModelSearchQueryKey(tenantId, computerId, params),
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: 30_000,
  });
}

/** Probes a Hugging Face or ModelScope repository without downloading weights. */
export function probeLocalComputerCustomModel(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  body: CustomModelProbeRequest,
) {
  return teamHubData(
    client.api.POST(customProbePath, {
      body,
      params: { path: { computerId, tenantId } },
    }),
  );
}

/** Starts a Standby-First custom model download on the Computer. */
export function downloadLocalComputerCustomModel(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  body: CustomModelDownloadInput,
) {
  return teamHubData(
    client.api.POST(customDownloadPath, {
      body,
      params: { path: { computerId, tenantId } },
    }),
  );
}
