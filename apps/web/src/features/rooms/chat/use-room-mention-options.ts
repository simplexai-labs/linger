import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubRoomMemberPage } from "@/features/teamhub/teamhub-types";

import { roomCatalogRetry } from "./room-catalog-retry";

import {
  tenantAgentAvailabilityQueryOptions,
  tenantAgentsQueryOptions,
} from "../room-queries";

export function useRoomMentionOptions({
  client,
  currentActorId,
  members,
  tenantId,
}: {
  client: TeamHubClient;
  currentActorId?: string;
  members: TeamHubRoomMemberPage;
  tenantId: string;
}) {
  const agentDirectory = useQuery({
    ...tenantAgentsQueryOptions(client, tenantId),
    ...roomCatalogRetry,
  });
  const agentAvailability = useQuery({
    ...tenantAgentAvailabilityQueryOptions(client, tenantId),
    ...roomCatalogRetry,
  });
  const blockedAgentIds = useMemo(() => {
    const ids = new Set<string>();
    const agents = new Map(
      (agentDirectory.data?.items ?? []).map((agent) => [
        agent.actor.id,
        agent,
      ]),
    );
    const availabilityByActorId = new Map(
      (agentAvailability.data?.items ?? []).map((snapshot) => [
        snapshot.actor_id,
        snapshot,
      ]),
    );
    for (const member of members.items) {
      if (member.actor.kind !== "agent") continue;
      const agent = agents.get(member.actor.id);
      if (
        !agent ||
        (agent.runtime.placement?.type === "local" &&
          availabilityByActorId.get(agent.actor.id)?.local_runtime_status
            ?.status !== "ready")
      ) {
        ids.add(member.actor.id);
      }
    }
    return ids;
  }, [
    agentAvailability.data?.items,
    agentDirectory.data?.items,
    members.items,
  ]);
  const mentionOptions = useMemo(() => {
    const otherAgents = [];
    const otherHumans = [];
    const selfActors = [];
    for (const member of members.items) {
      if (blockedAgentIds.has(member.actor.id)) continue;
      if (currentActorId && member.actor.id === currentActorId) {
        selfActors.push(member.actor);
      } else if (member.actor.kind === "agent") {
        otherAgents.push(member.actor);
      } else {
        otherHumans.push(member.actor);
      }
    }
    return [...otherAgents, ...otherHumans, ...selfActors];
  }, [blockedAgentIds, currentActorId, members.items]);

  return {
    agentAvailability,
    agentDirectory,
    mentionOptions,
  };
}
