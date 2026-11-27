import { teamHubData, type TeamHubApi } from "./teamhub-api";
import type { TeamHubClient } from "./teamhub-client";

export function createTeamHubAgentClient(
  api: TeamHubApi,
): Pick<TeamHubClient, "listTenantLocalComputers"> {
  return {
    listTenantLocalComputers: async (tenantId) => {
      const page = await teamHubData(
        api.GET("/v0/tenants/{tenantId}/local-computers", {
          params: { path: { tenantId } },
        }),
      );
      return {
        ...page,
        items: page.items.map((computer) => ({
          ...computer,
          runtimes: computer.runtimes.filter(
            ({ type }) =>
              type === "codex" ||
              type === "claude" ||
              type === "pi" ||
              type === "antigravity",
          ),
        })),
      };
    },
  };
}
