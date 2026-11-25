import { createTeamHubAgentRuntimeStateClient } from "@linger/wire-contracts/teamhub-internal/client";
import type { components } from "@linger/wire-contracts/teamhub-internal/types";
import type { TeamHubCliConfigurationSource } from "../../executor/local-backend.js";

export type MemoryDocument = components["schemas"]["AgentMemoryDocument"];
export interface MemoryClient {
  read(agentId: string, signal?: AbortSignal): Promise<MemoryDocument>;
  commit(
    agentId: string,
    document: MemoryDocument,
    signal?: AbortSignal,
  ): Promise<MemoryDocument>;
}
export function createMemoryClient(
  options: TeamHubCliConfigurationSource,
): MemoryClient {
  const client = createTeamHubAgentRuntimeStateClient(options);
  async function read(response: Response): Promise<MemoryDocument> {
    if (!response.ok)
      throw new Error(`Agent memory request failed (${response.status})`);
    return (await response.json()) as MemoryDocument;
  }
  return {
    read: async (id, signal) => read(await client.getMemory(id, signal)),
    commit: async (id, document, signal) => {
      const response = await client.commitMemory(id, document, signal);
      // An older TeamHub rejects the optional pending.target field with 400;
      // drop it once so rolling upgrades keep committing memory checkpoints.
      if (response.status === 400 && document.pending?.target !== undefined) {
        await response.body?.cancel();
        const { target: _omitted, ...pendingWithoutTarget } = document.pending;
        return read(
          await client.commitMemory(
            id,
            { ...document, pending: pendingWithoutTarget },
            signal,
          ),
        );
      }
      return read(response);
    },
  };
}
