import { describe, expect, it } from "vitest";

import type { TeamHubLocalComputerPage } from "@/features/teamhub/teamhub-types";
import { createTeamHubTestSeed } from "@/test/teamhub-seed";

import {
  assignableLocalModelAgents,
  buildLocalModelRuntimeUpdate,
  isAgentUsingModel,
  primaryLocalModelAgent,
  usedByAgentNames,
} from "./local-model-agents";
import { localModel } from "./local-models-test-support";

describe("local-model-agents", () => {
  it("filters to Sponsor-owned Agents, places Another Me first, and keeps compatible workspace grants", () => {
    const seed = createTeamHubTestSeed();
    const computer = {
      ...seed.localComputers[0]!,
      computer_id: "computer-lab",
      workspace_grants: [
        {
          grant_id: "grant-ro",
          label: "Read only",
          mode: "read-only" as const,
        },
        {
          grant_id: "grant-rw",
          label: "Workspace",
          mode: "workspace-write" as const,
        },
        {
          grant_id: "grant-other",
          label: "Other workspace",
          mode: "workspace-write" as const,
        },
      ],
    };
    const [codex, lev8, delegate] = seed.tenantAgents;
    const codexOnLab = {
      ...codex!,
      runtime: {
        ...codex!.runtime,
        placement: {
          computer_id: "computer-lab",
          runtime_type: "codex" as const,
          type: "local" as const,
          workspace_grant_id: "grant-other",
        },
      },
    };
    const result = assignableLocalModelAgents({
      agents: [codexOnLab, lev8!, delegate!],
      anotherMeActorId: delegate!.actor.id,
      availability: [
        {
          actor_id: codexOnLab.actor.id,
          availability: {
            active_task_count: 1,
            label: "Busy",
            status: "online",
          },
        },
      ],
      computer,
      computerId: "computer-lab",
      currentActorId: seed.identity.actors[0]!.id,
    });

    // Lev8 GTM is sponsored by Maya, not Jenny.
    expect(result.map((agent) => agent.actorId)).toEqual([
      delegate!.actor.id,
      codexOnLab.actor.id,
    ]);
    expect(result[0]!).toMatchObject({
      agentManagementId: delegate!.agent_management_id,
      busy: false,
      grantId: "grant-rw",
      isAnotherMe: true,
      name: "Jenny's Delegate",
    });
    expect(result[1]!).toMatchObject({
      busy: true,
      grantId: "grant-other",
      isAnotherMe: false,
      name: "Codex",
    });
    expect(primaryLocalModelAgent(result)?.actorId).toBe(delegate!.actor.id);
  });

  it("excludes all Agents on an upgrade-required or read-only Computer", () => {
    const seed = createTeamHubTestSeed();
    const upgradeComputer = {
      ...seed.localComputers[0]!,
      computer_id: "computer-lab",
      upgrade_required: true,
    };
    expect(
      assignableLocalModelAgents({
        agents: seed.tenantAgents,
        anotherMeActorId: seed.tenantAgents[2]!.actor.id,
        computer: upgradeComputer,
        computerId: "computer-lab",
        currentActorId: seed.identity.actors[0]!.id,
      }),
    ).toEqual([]);

    const readOnlyComputer = {
      ...seed.localComputers[0]!,
      computer_id: "computer-lab",
      workspace_grants: [
        {
          grant_id: "grant-ro",
          label: "Read only",
          mode: "read-only" as const,
        },
      ],
    };
    expect(
      assignableLocalModelAgents({
        agents: seed.tenantAgents,
        anotherMeActorId: seed.tenantAgents[2]!.actor.id,
        computer: readOnlyComputer,
        computerId: "computer-lab",
        currentActorId: seed.identity.actors[0]!.id,
      }),
    ).toEqual([]);
  });

  it("matches Agents via either snapshot used_by or live Pi placement", () => {
    const seed = createTeamHubTestSeed();
    const delegate = {
      ...seed.tenantAgents[2]!,
      runtime: {
        model: "localmodels-library/qwen3-coder-30b",
        placement: {
          computer_id: "computer-lab",
          runtime_type: "pi" as const,
          type: "local" as const,
          workspace_grant_id: "grant-rw",
        },
      },
    };
    const [agent] = assignableLocalModelAgents({
      agents: [delegate],
      anotherMeActorId: delegate.actor.id,
      computerId: "computer-lab",
      currentActorId: seed.identity.actors[0]!.id,
    });
    const entry = {
      model: localModel({
        id: "qwen3-coder-30b:Q4_K_M",
        name: "Qwen3 Coder 30B",
        pi_model: "localmodels-library/qwen3-coder-30b",
        state: "loaded",
      }),
      status: "loaded" as const,
      used_by: [{ agent_id: "agent-research", name: "Research agent" }],
    };

    expect(isAgentUsingModel(entry, agent!, "computer-lab")).toBe(true);
    expect(isAgentUsingModel(entry, agent!, "computer-other")).toBe(false);
    expect(usedByAgentNames(entry, [agent!], "computer-lab")).toEqual([
      "Research agent",
      "Jenny's Delegate",
    ]);

    const sameNameAgent = { ...agent!, name: "Helper" };
    const sameNameEntry = {
      ...entry,
      used_by: [{ agent_id: "agent-other", name: "Helper" }],
    };
    expect(
      usedByAgentNames(sameNameEntry, [sameNameAgent], "computer-lab"),
    ).toEqual(["Helper", "Helper"]);

    const alreadyInSnapshot = {
      ...entry,
      used_by: [
        {
          agent_id: delegate.agent_management_id,
          name: delegate.actor.display_name,
        },
      ],
    };
    expect(
      usedByAgentNames(alreadyInSnapshot, [agent!], "computer-lab"),
    ).toEqual(["Jenny's Delegate"]);
    expect(
      isAgentUsingModel(
        {
          ...alreadyInSnapshot,
          model: { ...alreadyInSnapshot.model, pi_model: undefined },
        },
        agent!,
        "computer-lab",
      ),
    ).toBe(true);
  });

  it("omits incompatible Claude reasoning efforts when Pi has not listed the model yet, and preserves valid Pi efforts when listed", () => {
    const seed = createTeamHubTestSeed();
    const computerWithoutPiModel = {
      ...seed.localComputers[0]!,
      computer_id: "computer-lab",
      runtimes: [],
    };
    const baseAgent = {
      actorId: "actor-delegate",
      agentManagementId: "anotherme-jenny",
      busy: false,
      configurationRevision: 3,
      currentComputerId: "computer-lab",
      currentModel: "claude-opus-4-1",
      currentReasoningEffort: "ultra" as const,
      currentRuntimeType: "claude" as const,
      grantId: "grant-rw",
      isAnotherMe: true,
      name: "Jenny's Delegate",
    };

    expect(
      buildLocalModelRuntimeUpdate(
        baseAgent,
        "localmodels-library/qwen3-coder-30b",
        "computer-lab",
        computerWithoutPiModel,
      ),
    ).toEqual({
      model: "localmodels-library/qwen3-coder-30b",
      placement: {
        computer_id: "computer-lab",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-rw",
      },
    });

    const computerWithPiModel: TeamHubLocalComputerPage["items"][number] = {
      ...seed.localComputers[0]!,
      computer_id: "computer-lab",
      runtimes: [
        {
          models: [
            {
              allowed_reasoning_effort: ["low", "medium", "high"],
              default_reasoning_effort: "medium",
              id: "localmodels-library/qwen3-coder-30b",
              label: "Qwen3 Coder 30B",
            },
          ],
          status: "ready",
          type: "pi",
        },
      ],
    };

    expect(
      buildLocalModelRuntimeUpdate(
        baseAgent,
        "localmodels-library/qwen3-coder-30b",
        "computer-lab",
        computerWithPiModel,
      ),
    ).toEqual({
      model: "localmodels-library/qwen3-coder-30b",
      placement: {
        computer_id: "computer-lab",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-rw",
      },
      reasoning_effort: "medium",
    });

    expect(
      buildLocalModelRuntimeUpdate(
        {
          ...baseAgent,
          currentReasoningEffort: "high",
          currentRuntimeType: "pi",
        },
        "localmodels-library/qwen3-coder-30b",
        "computer-lab",
        computerWithPiModel,
      ),
    ).toEqual({
      model: "localmodels-library/qwen3-coder-30b",
      placement: {
        computer_id: "computer-lab",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-rw",
      },
      reasoning_effort: "high",
    });

    const computerWithSparkModel: TeamHubLocalComputerPage["items"][number] = {
      ...seed.localComputers[0]!,
      computer_id: "computer-lab",
      runtimes: [
        {
          models: [
            {
              allowed_reasoning_effort: ["none", "low", "high"],
              id: "localmodels-library/spark-x2-6-4b",
              label: "Spark X2.6 4B",
            },
          ],
          status: "ready",
          type: "pi",
        },
      ],
    };

    expect(
      buildLocalModelRuntimeUpdate(
        {
          ...baseAgent,
          currentReasoningEffort: "medium",
          currentRuntimeType: "pi",
        },
        "localmodels-library/spark-x2-6-4b",
        "computer-lab",
        computerWithSparkModel,
      ),
    ).toEqual({
      model: "localmodels-library/spark-x2-6-4b",
      placement: {
        computer_id: "computer-lab",
        runtime_type: "pi",
        type: "local",
        workspace_grant_id: "grant-rw",
      },
      reasoning_effort: "low",
    });
  });
});
