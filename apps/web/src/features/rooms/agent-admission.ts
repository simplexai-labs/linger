import type {
  TeamHubActor,
  TeamHubTenantAgent,
} from "@/features/teamhub/teamhub-types";

/**
 * The Agents TeamHub lets this Human add to a Room: Workspace Agents and the
 * Human's own. TeamHub admits an Agent whatever its availability, so one
 * whose Computer is offline or not ready stays a candidate.
 */
export function eligibleRoomAgents({
  agents,
  roomMemberIds,
  sponsorActorId,
}: {
  agents: TeamHubTenantAgent[];
  roomMemberIds: ReadonlySet<string>;
  sponsorActorId?: string;
}): TeamHubActor[] {
  return agents
    .filter(
      (agent) =>
        (agent.visibility_scope === "workspace" ||
          agent.created_by.id === sponsorActorId) &&
        !roomMemberIds.has(agent.actor.id),
    )
    .map((agent) => agent.actor);
}
