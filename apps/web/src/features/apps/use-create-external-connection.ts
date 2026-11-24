import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalAppKey,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";
import { translate } from "@/i18n/language";

import { externalConnectionsQueryKey } from "./connected-apps-queries";
import { startReauthorization, usableConnectUrl } from "./connection-state";
import { connectorMessages as m } from "./connectors.messages";
import { openOAuthUrl } from "./oauth-popup";

/** Composio refused the project API key, so a new key is needed to connect. */
export function isComposioKeyRejected(error: unknown) {
  return (
    error instanceof TeamHubError && error.code === "COMPOSIO_KEY_REJECTED"
  );
}

export function useCreateExternalConnection({
  onKeyRejected,
}: {
  onKeyRejected?: (appKey: TeamHubExternalAppKey) => void;
} = {}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [blockedConnectUrl, setBlockedConnectUrl] = useState("");
  const createConnection = useMutation({
    mutationFn: (appKey: TeamHubExternalAppKey) =>
      client.createExternalConnection(appKey),
    onSuccess: async (connection) => {
      if (connection.connect_url && !openOAuthUrl(connection.connect_url)) {
        setBlockedConnectUrl(connection.connect_url);
      }
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
    onError: (error, appKey) => {
      if (isComposioKeyRejected(error)) onKeyRejected?.(appKey);
    },
  });

  const reauthorize = useMutation({
    mutationFn: async (connection: TeamHubExternalConnection) => {
      const connectUrl = await startReauthorization(client, connection);
      // Worded when it happens, like the errors TeamHub sends.
      if (!connectUrl) throw new Error(translate(m.reconnectNotStarted));
      resume(connectUrl);
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      }),
  });

  function resume(connectUrl: string) {
    setBlockedConnectUrl("");
    if (!openOAuthUrl(connectUrl)) setBlockedConnectUrl(connectUrl);
  }

  // Connect and reconnect share one error slot, so each clears the other's.
  function connect(appKey: TeamHubExternalAppKey) {
    setBlockedConnectUrl("");
    reauthorize.reset();
    createConnection.mutate(appKey);
  }

  async function connectOrResume(
    appKey: TeamHubExternalAppKey,
    pending?: TeamHubExternalConnection,
  ) {
    createConnection.reset();
    reauthorize.reset();
    if (pending) {
      try {
        const connectUrl = usableConnectUrl(
          pending.connect_url
            ? pending
            : await client.getExternalConnection(pending.id),
        );
        if (connectUrl) {
          resume(connectUrl);
          return;
        }
      } catch {
        // Fall through and start a new connection.
      }
    }
    connect(appKey);
  }

  return {
    blockedConnectUrl,
    connect,
    connectOrResume,
    error: createConnection.error ?? reauthorize.error,
    isPending: createConnection.isPending || reauthorize.isPending,
    /** Reauthorizes an existing connection in place. */
    reconnect(connection: TeamHubExternalConnection) {
      setBlockedConnectUrl("");
      createConnection.reset();
      reauthorize.mutate(connection);
    },
    resume,
    clearError() {
      createConnection.reset();
      reauthorize.reset();
    },
    clearBlockedConnectUrl() {
      setBlockedConnectUrl("");
    },
  };
}
