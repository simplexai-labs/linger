import { resolveDefaultReasoningEffort } from "@/features/rooms/members/use-agent-model-selection";
import type {
  TeamHubAgentReasoningEffort,
  TeamHubLocalComputerPage,
  TeamHubLocalRuntimeType,
  TeamHubTenantAgent,
  TeamHubTenantAgentAvailabilitySnapshot,
  TeamHubTenantAgentUpdateInput,
} from "@/features/teamhub/teamhub-types";

import type { ModelEntry } from "./local-models-rules";

/** A Sponsor-owned Agent eligible to run against a loaded Local Model on one Computer. */
export interface AssignableLocalModelAgent {
  actorId: string;
  agentManagementId: string;
  busy: boolean;
  configurationRevision: number;
  currentComputerId?: string;
  currentModel: string;
  currentReasoningEffort?: TeamHubAgentReasoningEffort;
  currentRuntimeType?: TeamHubLocalRuntimeType;
  grantId: string;
  isAnotherMe: boolean;
  name: string;
}

export interface AssignableLocalModelAgentsInput {
  agents?: readonly TeamHubTenantAgent[];
  anotherMeActorId?: string;
  availability?: readonly TeamHubTenantAgentAvailabilitySnapshot[];
  computer?: TeamHubLocalComputerPage["items"][number];
  computerId: string;
  currentActorId?: string;
}

/**
 * Lists Sponsor-owned Agents that can run on `computerId` with the Pi Runtime,
 * placing Another Me first so row actions prioritize it consistently.
 */
export function assignableLocalModelAgents(
  input: AssignableLocalModelAgentsInput,
): AssignableLocalModelAgent[] {
  if (
    !input.currentActorId ||
    !input.agents?.length ||
    input.computer?.upgrade_required
  ) {
    return [];
  }
  const busyByActorId = new Map(
    (input.availability ?? []).map((snapshot) => [
      snapshot.actor_id,
      (snapshot.availability.active_task_count ?? 0) > 0,
    ]),
  );
  const writableGrant = input.computer?.workspace_grants.find(
    (grant) => grant.mode === "workspace-write",
  );
  const result: AssignableLocalModelAgent[] = [];
  for (const agent of input.agents) {
    if (agent.created_by.id !== input.currentActorId) continue;
    const placement =
      agent.runtime.placement?.type === "local"
        ? agent.runtime.placement
        : undefined;
    let grantId: string | undefined;
    if (placement?.computer_id === input.computerId) {
      const existingGrantId = placement.workspace_grant_id;
      const grantStillPresent =
        !input.computer ||
        input.computer.workspace_grants.some(
          (grant) => grant.grant_id === existingGrantId,
        );
      grantId = grantStillPresent ? existingGrantId : writableGrant?.grant_id;
    } else {
      grantId = writableGrant?.grant_id;
    }
    if (!grantId) continue;
    result.push({
      actorId: agent.actor.id,
      agentManagementId: agent.agent_management_id,
      busy: busyByActorId.get(agent.actor.id) ?? false,
      configurationRevision: agent.configuration_revision,
      currentComputerId: placement?.computer_id,
      currentModel: agent.runtime.model,
      currentReasoningEffort: agent.runtime.reasoning_effort,
      currentRuntimeType: placement?.runtime_type,
      grantId,
      isAnotherMe:
        agent.actor.id === input.anotherMeActorId ||
        agent.agent_type === "anotherme",
      name: agent.actor.display_name,
    });
  }
  result.sort((a, b) => {
    if (a.isAnotherMe !== b.isAnotherMe) return a.isAnotherMe ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
}

/**
 * Whether `agent` already uses `entry` on `computerId`, combining the snapshot's
 * `used_by` list with live Agent placement so updates reflect before the next snapshot.
 */
export function isAgentUsingModel(
  entry: ModelEntry,
  agent: AssignableLocalModelAgent,
  computerId: string,
): boolean {
  if (entry.used_by.some((user) => user.agent_id === agent.agentManagementId)) {
    return true;
  }
  return (
    Boolean(entry.model.pi_model) &&
    agent.currentComputerId === computerId &&
    agent.currentRuntimeType === "pi" &&
    agent.currentModel === entry.model.pi_model
  );
}

/** Display names of all Agents currently using `entry` on `computerId`. */
export function usedByAgentNames(
  entry: ModelEntry,
  assignableAgents: readonly AssignableLocalModelAgent[],
  computerId: string,
): string[] {
  const names = entry.used_by.map((user) => user.name);
  for (const agent of assignableAgents) {
    if (
      isAgentUsingModel(entry, agent, computerId) &&
      !entry.used_by.some((user) => user.agent_id === agent.agentManagementId)
    ) {
      names.push(agent.name);
    }
  }
  return names;
}

/** The featured Agent for one-click row actions: Another Me, or the sole Agent. */
export function primaryLocalModelAgent(
  assignableAgents: readonly AssignableLocalModelAgent[],
): AssignableLocalModelAgent | undefined {
  return (
    assignableAgents.find((agent) => agent.isAnotherMe) ??
    (assignableAgents.length === 1 ? assignableAgents[0] : undefined)
  );
}

/**
 * Builds the `PATCH /agents/{agentId}` runtime payload that switches `agent` onto
 * a Bifrost-backed local model via Pi without carrying incompatible effort settings.
 */
export function buildLocalModelRuntimeUpdate(
  agent: AssignableLocalModelAgent,
  piModel: string,
  computerId: string,
  computer?: TeamHubLocalComputerPage["items"][number],
): NonNullable<TeamHubTenantAgentUpdateInput["runtime"]> {
  const piRuntime = computer?.runtimes.find((item) => item.type === "pi");
  const catalogModel = piRuntime?.models.find((item) => item.id === piModel);
  let reasoningEffort: TeamHubAgentReasoningEffort | undefined;
  if (catalogModel) {
    const allowed = catalogModel.allowed_reasoning_effort ?? [];
    if (
      agent.currentRuntimeType === "pi" &&
      agent.currentReasoningEffort &&
      allowed.includes(agent.currentReasoningEffort)
    ) {
      reasoningEffort = agent.currentReasoningEffort;
    } else {
      reasoningEffort = resolveDefaultReasoningEffort(
        allowed,
        catalogModel.default_reasoning_effort,
      );
    }
  }
  return {
    model: piModel,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    placement: {
      computer_id: computerId,
      runtime_type: "pi",
      type: "local",
      workspace_grant_id: agent.grantId,
    },
  };
}
