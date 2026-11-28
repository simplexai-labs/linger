import { queryOptions } from "@tanstack/react-query";

import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

const appGrantsPath =
  "/v0/tenants/{tenantId}/local-computers/{computerId}/app-grants";

export function computerAppGrantsQueryKey(
  tenantId: string,
  computerId: string,
) {
  return [
    "teamhub",
    tenantId,
    "local-computer-app-grants",
    computerId,
  ] as const;
}

export function computerAppGrantsQueryOptions(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(
        client.api.GET(appGrantsPath, {
          params: { path: { tenantId, computerId } },
          signal,
        }),
      ),
    queryKey: computerAppGrantsQueryKey(tenantId, computerId),
    retry: false,
    staleTime: 10_000,
  });
}

export function revokeComputerAppGrant(
  client: TeamHubClient,
  tenantId: string,
  computerId: string,
  grantId: string,
) {
  return teamHubDone(
    client.api.DELETE(
      "/v0/tenants/{tenantId}/local-computers/{computerId}/app-grants/{grantId}",
      {
        params: { path: { tenantId, computerId, grantId } },
      },
    ),
  );
}
