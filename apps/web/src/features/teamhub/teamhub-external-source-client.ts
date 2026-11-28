import { desktopConnectorOAuth } from "@/features/apps/desktop-connector-oauth";

import type {
  TeamHubDisconnectExternalConnectionInput,
  TeamHubExternalAppKey,
  TeamHubExternalAppList,
  TeamHubExternalConnection,
  TeamHubExternalConnectionAgentAccess,
  TeamHubExternalConnectionAgentAccessList,
  TeamHubExternalConnectionList,
  TeamHubExternalConnectionWritePolicy,
  TeamHubExternalProviderKeyStatus,
  TeamHubDiscordChannelList,
  TeamHubGoogleCalendarPage,
  TeamHubGitHubRepositoryPage,
  TeamHubNotionResourcePage,
  TeamHubPageInput,
  TeamHubSlackConversationPage,
} from "./teamhub-types";
import {
  teamHubData as data,
  teamHubDone as done,
  type TeamHubApi,
} from "./teamhub-api";

export interface TeamHubExternalSourceClient {
  /** Tells TeamHub an OAuth popup returned, so it checks the authorization at once. */
  completeExternalConnectionAuthorization(
    connectedAccountId?: string,
  ): Promise<void>;
  createExternalConnection(
    appKey: TeamHubExternalAppKey,
  ): Promise<TeamHubExternalConnection>;
  createExternalConnectionReauthorization(
    connectionId: string,
    expectedRevision: number,
  ): Promise<TeamHubExternalConnection>;
  createExternalConnectionStatusCheck(
    connectionId: string,
    expectedRevision: number,
  ): Promise<TeamHubExternalConnection>;
  disconnectExternalConnection(
    connectionId: string,
    input: TeamHubDisconnectExternalConnectionInput,
  ): Promise<TeamHubExternalConnection>;
  getExternalConnection(
    connectionId: string,
  ): Promise<TeamHubExternalConnection>;
  listExternalConnections(): Promise<TeamHubExternalConnectionList>;
  listExternalConnectionAgentAccess(
    connectionId: string,
  ): Promise<TeamHubExternalConnectionAgentAccessList>;
  listExternalApps(): Promise<TeamHubExternalAppList>;
  /** Saves the deployment's Composio API key; TeamHub checks it first. */
  saveExternalProviderKey(
    apiKey: string,
  ): Promise<TeamHubExternalProviderKeyStatus>;
  listDiscordChannels(connectionId: string): Promise<TeamHubDiscordChannelList>;
  listGoogleCalendars(
    connectionId: string,
    page?: { limit?: number; pageToken?: string },
  ): Promise<TeamHubGoogleCalendarPage>;
  listGitHubRepositories(
    connectionId: string,
    page?: TeamHubPageInput,
  ): Promise<TeamHubGitHubRepositoryPage>;
  listNotionResources(
    connectionId: string,
    page?: TeamHubPageInput,
  ): Promise<TeamHubNotionResourcePage>;
  listSlackConversations(
    connectionId: string,
    page?: TeamHubPageInput,
  ): Promise<TeamHubSlackConversationPage>;
  setExternalConnectionAgentAccess(
    connectionId: string,
    agentActorId: string,
    granted: boolean,
    writePolicy?: TeamHubExternalConnectionWritePolicy,
  ): Promise<TeamHubExternalConnectionAgentAccess>;
  setExternalConnectionAutoReminders(
    connectionId: string,
    enabled: boolean,
  ): Promise<TeamHubExternalConnection>;
}

export function createHttpTeamHubExternalSourceClient(
  api: TeamHubApi,
): TeamHubExternalSourceClient {
  const connection = (externalConnectionId: string) => ({
    path: { externalConnectionId },
  });
  const desktopCallback = async () => {
    const url = await desktopConnectorOAuth()?.prepare();
    return url ? { desktop_callback_url: url } : {};
  };
  return {
    completeExternalConnectionAuthorization: (connectedAccountId) =>
      done(
        api.POST("/v0/external-connection-completions", {
          body: connectedAccountId
            ? { connected_account_id: connectedAccountId }
            : {},
        }),
      ),
    createExternalConnection: async (appKey) =>
      data(
        api.POST("/v0/external-connections", {
          body: { app_key: appKey, ...(await desktopCallback()) },
        }),
      ),
    createExternalConnectionReauthorization: async (
      externalConnectionId,
      expectedRevision,
    ) =>
      data(
        api.POST(
          "/v0/external-connections/{externalConnectionId}/reauthorizations",
          {
            params: connection(externalConnectionId),
            body: {
              expected_revision: expectedRevision,
              ...(await desktopCallback()),
            },
          },
        ),
      ),
    createExternalConnectionStatusCheck: (
      externalConnectionId,
      expectedRevision,
    ) =>
      data(
        api.POST(
          "/v0/external-connections/{externalConnectionId}/status-checks",
          {
            params: connection(externalConnectionId),
            body: { expected_revision: expectedRevision },
          },
        ),
      ),
    disconnectExternalConnection: (externalConnectionId, body) =>
      data(
        api.POST(
          "/v0/external-connections/{externalConnectionId}/disconnects",
          {
            params: connection(externalConnectionId),
            body,
          },
        ),
      ),
    getExternalConnection: (externalConnectionId) =>
      data(
        api.GET("/v0/external-connections/{externalConnectionId}", {
          params: connection(externalConnectionId),
        }),
      ),
    listExternalConnections: () => data(api.GET("/v0/external-connections")),
    listExternalConnectionAgentAccess: (externalConnectionId) =>
      data(
        api.GET(
          "/v0/external-connections/{externalConnectionId}/agent-grants",
          {
            params: connection(externalConnectionId),
          },
        ),
      ),
    listExternalApps: () => data(api.GET("/v0/external-apps")),
    saveExternalProviderKey: (apiKey) =>
      data(
        api.PUT("/v0/external-apps/provider-key", {
          body: { api_key: apiKey },
        }),
      ),
    listDiscordChannels: (externalConnectionId) =>
      data(
        api.GET(
          "/v0/external-connections/{externalConnectionId}/discord/channels",
          { params: connection(externalConnectionId) },
        ),
      ),
    listGoogleCalendars: (externalConnectionId, page) =>
      data(
        api.GET(
          "/v0/external-connections/{externalConnectionId}/google-calendar/calendars",
          {
            params: {
              ...connection(externalConnectionId),
              query: { limit: page?.limit, page_token: page?.pageToken },
            },
          },
        ),
      ),
    listGitHubRepositories: (externalConnectionId, query) =>
      data(
        api.GET(
          "/v0/external-connections/{externalConnectionId}/github/repositories",
          { params: { ...connection(externalConnectionId), query } },
        ),
      ),
    listNotionResources: (externalConnectionId, query) =>
      data(
        api.GET(
          "/v0/external-connections/{externalConnectionId}/notion/resources",
          { params: { ...connection(externalConnectionId), query } },
        ),
      ),
    listSlackConversations: (externalConnectionId, query) =>
      data(
        api.GET(
          "/v0/external-connections/{externalConnectionId}/slack/conversations",
          { params: { ...connection(externalConnectionId), query } },
        ),
      ),
    setExternalConnectionAgentAccess: (
      externalConnectionId,
      agentActorId,
      granted,
      writePolicy,
    ) =>
      data(
        api.PUT(
          "/v0/external-connections/{externalConnectionId}/agent-grants/{agentActorId}",
          {
            params: { path: { externalConnectionId, agentActorId } },
            body: writePolicy
              ? { granted, write_policy: writePolicy }
              : { granted },
          },
        ),
      ),
    setExternalConnectionAutoReminders: (externalConnectionId, enabled) =>
      data(
        api.PUT(
          "/v0/external-connections/{externalConnectionId}/auto-reminders",
          {
            params: connection(externalConnectionId),
            body: { enabled },
          },
        ),
      ),
  };
}
