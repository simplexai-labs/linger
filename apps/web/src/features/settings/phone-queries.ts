import type { components } from "@linger/wire-contracts/teamhub-public/types";
import { queryOptions } from "@tanstack/react-query";

import { teamHubData, teamHubDone } from "@/features/teamhub/teamhub-api";
import type { TeamHubClient } from "@/features/teamhub/teamhub-client";

export type PairedPhone = components["schemas"]["PairedPhone"];
export type PhonePairingCode = components["schemas"]["PhonePairingCode"];
export type RelayNode = components["schemas"]["MobileRelayNode"];

export function pairedPhonesQueryKey() {
  return ["teamhub", "me", "phones"] as const;
}

export function pairedPhonesQueryOptions(client: TeamHubClient) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(client.api.GET("/v0/me/phones", { signal })),
    queryKey: pairedPhonesQueryKey(),
    retry: false,
    staleTime: 2_000,
  });
}

/**
 * One pairing code per `attempt`: creating a code is a write, so it is never
 * refetched in the background, and a new attempt asks for a new code.
 */
export function phonePairingCodeQueryOptions(
  client: TeamHubClient,
  attempt: number,
) {
  return queryOptions({
    gcTime: 0,
    queryFn: () => teamHubData(client.api.POST("/v0/me/phone-pairings")),
    queryKey: ["teamhub", "me", "phone-pairing", attempt],
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
    staleTime: Infinity,
  });
}

export function removePairedPhone(client: TeamHubClient, phoneId: string) {
  return teamHubDone(
    client.api.DELETE("/v0/me/phones/{phoneId}", {
      params: { path: { phoneId } },
    }),
  );
}

export function approvePairedPhone(client: TeamHubClient, phoneId: string) {
  return teamHubDone(
    client.api.POST("/v0/me/phones/{phoneId}/approve", {
      params: { path: { phoneId } },
    }),
  );
}

export function relayNodesQueryKey() {
  return ["teamhub", "mobile", "relays"] as const;
}

/** The Relay nodes; refreshed while open so a link coming up shows. */
export function relayNodesQueryOptions(client: TeamHubClient) {
  return queryOptions({
    queryFn: ({ signal }) =>
      teamHubData(client.api.GET("/v0/mobile/relays", { signal })),
    queryKey: relayNodesQueryKey(),
    refetchInterval: 10_000,
    retry: false,
    staleTime: 2_000,
  });
}

export function addRelayNode(client: TeamHubClient, url: string) {
  return teamHubData(client.api.POST("/v0/mobile/relays", { body: { url } }));
}

export function setRelayNodeEnabled(
  client: TeamHubClient,
  relayId: string,
  enabled: boolean,
) {
  return teamHubData(
    client.api.PATCH("/v0/mobile/relays/{relayId}", {
      body: { enabled },
      params: { path: { relayId } },
    }),
  );
}

export function removeRelayNode(client: TeamHubClient, relayId: string) {
  return teamHubDone(
    client.api.DELETE("/v0/mobile/relays/{relayId}", {
      params: { path: { relayId } },
    }),
  );
}
