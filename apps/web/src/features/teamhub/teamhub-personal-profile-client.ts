import type {
  TeamHubPersonalProfile,
  TeamHubPersonalProfileGeneration,
  TeamHubPersonalProfileGenerationCreateInput,
  TeamHubPersonalProfileGenerationList,
  TeamHubPersonalProfileReplaceInput,
  TeamHubPersonalProfileRevision,
} from "./teamhub-types";
import { teamHubData as data, type TeamHubApi } from "./teamhub-api";

export interface TeamHubPersonalProfileClient {
  getPersonalProfile(tenantId: string): Promise<TeamHubPersonalProfile>;
  replacePersonalProfile(
    tenantId: string,
    input: TeamHubPersonalProfileReplaceInput,
  ): Promise<TeamHubPersonalProfileRevision>;
  listPersonalProfileGenerations(
    tenantId: string,
  ): Promise<TeamHubPersonalProfileGenerationList>;
  createPersonalProfileGeneration(
    tenantId: string,
    input: TeamHubPersonalProfileGenerationCreateInput,
  ): Promise<TeamHubPersonalProfileGeneration>;
}

export function createHttpTeamHubPersonalProfileClient(
  api: TeamHubApi,
): TeamHubPersonalProfileClient {
  const tenant = (tenantId: string) => ({ path: { tenantId } });
  return {
    getPersonalProfile: (tenantId) =>
      data(
        api.GET("/v0/tenants/{tenantId}/personal-profile", {
          params: tenant(tenantId),
        }),
      ),
    replacePersonalProfile: (tenantId, body) =>
      data(
        api.POST("/v0/tenants/{tenantId}/personal-profile/revisions", {
          params: tenant(tenantId),
          body,
        }),
      ),
    listPersonalProfileGenerations: (tenantId) =>
      data(
        api.GET("/v0/tenants/{tenantId}/personal-profile-generations", {
          params: tenant(tenantId),
        }),
      ),
    createPersonalProfileGeneration: (tenantId, body) =>
      data(
        api.POST("/v0/tenants/{tenantId}/personal-profile-generations", {
          params: { ...tenant(tenantId) },
          body,
        }),
      ),
  };
}
