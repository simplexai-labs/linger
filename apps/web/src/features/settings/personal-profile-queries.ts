import { queryOptions } from "@tanstack/react-query";
import type { TeamHubPersonalProfileClient } from "@/features/teamhub/teamhub-personal-profile-client";

export const personalProfileQueryKey = (tenantId: string) =>
  ["teamhub", "personal-profile", tenantId] as const;
export const personalProfileGenerationsQueryKey = (tenantId: string) =>
  ["teamhub", "personal-profile-generations", tenantId] as const;

export function personalProfileQueryOptions(
  client: TeamHubPersonalProfileClient,
  tenantId: string,
) {
  return queryOptions({
    queryKey: personalProfileQueryKey(tenantId),
    queryFn: () => client.getPersonalProfile(tenantId),
    // Follows a build an Agent is running, and notices one that starts.
    refetchInterval: (query) =>
      query.state.data?.building_since ? 3_000 : 15_000,
    retry: false,
    staleTime: 5_000,
  });
}
