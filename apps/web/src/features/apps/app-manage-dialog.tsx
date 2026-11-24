import {
  Delete02Icon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { ModalDialog } from "@/components/ui/modal-dialog";
import { StatusPill } from "@/components/ui/status-pill";
import { TeamHubError } from "@/features/teamhub/teamhub-client";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalConnection,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import {
  externalConnectionQueryOptions,
  externalConnectionsQueryKey,
} from "./connected-apps-queries";
import { appDescription } from "./app-groups";
import { ConnectAppStatus, useConnectAppFlow } from "./connect-app-flow";
import {
  establishedExternalConnections,
  externalConnectionNeedsAttention,
  openPendingExternalConnection,
  accountIdentityText,
  externalConnectionEstablished,
  externalConnectionUnconfirmed,
} from "./connection-state";
import { connectorMessages as m } from "./connectors.messages";

import {
  FeishuConnectGuide,
  isFeishuConnectError,
  useFeishuMailSetup,
} from "./feishu-connect-guide";

export function AppManageDialog({
  app,
  connections,
  onClose,
}: {
  app: TeamHubExternalApp;
  connections: TeamHubExternalConnection[];
  onClose: () => void;
}) {
  const t = useT();
  const [disconnecting, setDisconnecting] =
    useState<TeamHubExternalConnection | null>(null);
  // Without a Composio key, Connect opens the key dialog on top of this one.
  const connectFlow = useConnectAppFlow();
  const established = establishedExternalConnections(connections);
  // Accounts that need reconnecting or confirming stay listed so the Human
  // can repair them.
  const rows = connections.filter(
    (connection) =>
      externalConnectionEstablished(connection) ||
      externalConnectionUnconfirmed(connection) ||
      externalConnectionNeedsAttention(connection),
  );
  const canConnect = connectFlow.canStart(app);
  const checksFeishuSetup = app.key === "feishu_mail" && canConnect;
  const setup = useFeishuMailSetup(checksFeishuSetup);
  const connectionError = connectFlow.connection.error;
  const failedConnect =
    checksFeishuSetup && isFeishuConnectError(connectionError);
  const setupError = checksFeishuSetup ? setup.error : undefined;
  const canAuthorize =
    canConnect &&
    (!checksFeishuSetup ||
      (!setup.isFetching && !setup.isPending && !setupError && !failedConnect));
  const supportsAutoReminders = app.capabilities.includes(
    "proactive_reminders",
  );

  return (
    <>
      <ModalDialog
        closeOnBackdrop
        description={appDescription(app, t)}
        onClose={onClose}
        size="md"
        title={app.display_name}
      >
        <div className="px-5 py-4">
          {setupError || failedConnect ? (
            <Button
              disabled={setup.isFetching || connectFlow.connection.isPending}
              onClick={() => {
                connectFlow.connection.clearError();
                void setup.refetch();
              }}
              size="compact"
              tone="secondary"
            >
              {t(m.feishuCheckAgain)}
            </Button>
          ) : canConnect ? (
            <Button
              aria-label={
                established.length
                  ? t(m.addAnotherAccount, { app: app.display_name })
                  : t(m.connectApp, { app: app.display_name })
              }
              disabled={!canAuthorize || connectFlow.connection.isPending}
              onClick={() =>
                connectFlow.start(
                  app,
                  openPendingExternalConnection(connections, app.key),
                )
              }
              size="compact"
              tone="secondary"
            >
              <Icon icon={PlusSignIcon} size={14} />
              {established.length ? t(m.addAccount) : t(m.connect)}
            </Button>
          ) : (
            <Button disabled size="compact">
              {t(m.connect)}
            </Button>
          )}
          {setupError && !failedConnect ? (
            isFeishuConnectError(setupError) ? (
              <FeishuConnectGuide className="mt-3" error={setupError} />
            ) : (
              <p className="mt-3 text-xs text-app-danger" role="alert">
                {setupError.message}
              </p>
            )
          ) : null}
          <ConnectAppStatus className="mt-3" flow={connectFlow} />
          {rows.length ? (
            <div className="mt-4 divide-y divide-border border-t border-border">
              {rows.map((connection) => (
                <ConnectionRow
                  canReconnect={canAuthorize}
                  connection={connection}
                  key={connection.id}
                  supportsAutoReminders={supportsAutoReminders}
                  reconnecting={connectFlow.connection.isPending}
                  onDisconnect={() => setDisconnecting(connection)}
                  onReconnect={() =>
                    app.supports_reauthorization === false
                      ? connectFlow.start(
                          app,
                          openPendingExternalConnection(connections, app.key),
                        )
                      : connectFlow.reconnect(connection)
                  }
                />
              ))}
            </div>
          ) : null}
        </div>
      </ModalDialog>
      {disconnecting ? (
        <DisconnectConnectionDialog
          connection={disconnecting}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
    </>
  );
}

function ConnectionRow({
  canReconnect,
  connection,
  supportsAutoReminders,
  reconnecting,
  onReconnect,
  onDisconnect,
}: {
  canReconnect: boolean;
  connection: TeamHubExternalConnection;
  supportsAutoReminders: boolean;
  reconnecting: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  const needsReconnecting = externalConnectionNeedsAttention(connection);
  const statusCheck = useMutation({
    mutationFn: () =>
      client.createExternalConnectionStatusCheck(
        connection.id,
        connection.revision,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      }),
  });
  // TeamHub clears the request once the check writes its result.
  const checking = Boolean(connection.status_check_requested_at);
  const duplicateIdentity =
    connection.status_error_code === "duplicate_remote_principal";
  const unconfirmed = externalConnectionUnconfirmed(connection);
  const account = connection.identity_label ?? connection.provider;

  return (
    <div className="flex min-h-[58px] flex-wrap items-center gap-3 py-2.5">
      <div className="min-w-[180px] flex-1">
        <p className="truncate text-sm font-medium text-foreground">
          {accountIdentityText(
            connection.provider,
            connection.identity_label,
            t,
          ) ?? t(m.authorizationInProgress)}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {needsReconnecting ? (
            <StatusPill tone="warning">{t(m.needsReconnecting)}</StatusPill>
          ) : (
            <ConnectionStatus
              status={connection.status}
              unconfirmed={unconfirmed}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {connection.status === "active" || unconfirmed ? (
          <Button
            aria-label={t(unconfirmed ? m.checkAccountAgain : m.checkAccount, {
              account,
            })}
            disabled={statusCheck.isPending || checking}
            onClick={() => statusCheck.mutate()}
            size="compactIcon"
            title={t(unconfirmed ? m.checkAgain : m.checkConnection)}
            tone="ghost"
          >
            <Icon
              icon={RefreshIcon}
              className={
                statusCheck.isPending || checking ? "animate-spin" : ""
              }
              size={14}
            />
          </Button>
        ) : null}
        {needsReconnecting && canReconnect ? (
          <Button
            aria-label={t(m.reconnectAccount, { account })}
            disabled={reconnecting}
            onClick={onReconnect}
            size="compact"
            tone="secondary"
          >
            {t(m.reconnect)}
          </Button>
        ) : null}
        {!["disconnecting", "revoke_pending"].includes(connection.status) ? (
          <Button
            aria-label={t(m.disconnectAccount, { account })}
            onClick={onDisconnect}
            size="compactIcon"
            title={t(m.disconnect)}
            tone="ghost"
          >
            <Icon icon={Delete02Icon} size={14} />
          </Button>
        ) : null}
      </div>
      {unconfirmed ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {t(
            connection.status_error_code === "discord_guild_required"
              ? m.discordUnconfirmedInDialog
              : m.connectionUnconfirmed,
          )}
        </p>
      ) : null}
      {connection.status_error_code === "provider_auth_failed" ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {t(m.insufficientPermission)}
        </p>
      ) : null}
      {statusCheck.error ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {errorMessage(statusCheck.error, t(m.connectionActionFailed))}
        </p>
      ) : null}
      {duplicateIdentity ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {t(m.accountAlreadyConnected)}
        </p>
      ) : null}
      {connection.status === "active" && supportsAutoReminders ? (
        <AutoReminders connection={connection} />
      ) : null}
    </div>
  );
}

function AutoReminders({
  connection,
}: {
  connection: TeamHubExternalConnection;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  const update = useMutation({
    mutationFn: (enabled: boolean) =>
      client.setExternalConnectionAutoReminders(connection.id, enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
  });
  const enabled = update.isPending
    ? update.variables
    : connection.auto_reminders;

  return (
    <div className="basis-full border-t border-border pt-2.5">
      <label className="flex min-h-8 items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">
            {t(m.autoReminders)}
          </span>
          <span className="block text-xs text-muted-foreground">
            {t(m.autoRemindersHint)}
          </span>
        </span>
        <input
          aria-label={t(m.autoRemindersFor, {
            account: connection.identity_label ?? connection.provider,
          })}
          checked={enabled}
          className="agent-connector-switch"
          disabled={update.isPending}
          onChange={(event) => update.mutate(event.target.checked)}
          role="switch"
          type="checkbox"
        />
      </label>
      {update.error ? (
        <p className="mt-1 text-xs text-app-danger" role="alert">
          {errorMessage(update.error, t(m.autoRemindersNotUpdated))}
        </p>
      ) : null}
    </div>
  );
}

export function DisconnectConnectionDialog({
  connection,
  onClose,
}: {
  connection: TeamHubExternalConnection;
  onClose: () => void;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  const [disconnected, setDisconnected] = useState(false);
  const disconnect = useMutation({
    mutationFn: () =>
      client.disconnectExternalConnection(connection.id, {
        expected_revision: connection.revision,
      }),
    onSuccess: async () => {
      setDisconnected(true);
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    },
  });
  // The connection is disconnecting until TeamHub revokes the provider
  // account, then revoked; account change events refresh it.
  const current = useQuery({
    ...externalConnectionQueryOptions(client, connection.id),
    enabled: disconnected,
  });
  const ended = current.data ?? disconnect.data;

  useEffect(() => {
    if (current.data?.status !== "revoked") return;
    void queryClient.invalidateQueries({
      queryKey: externalConnectionsQueryKey(),
    });
  }, [current.data?.status, queryClient]);

  return (
    <ModalDialog
      description={
        accountIdentityText(
          connection.provider,
          connection.identity_label,
          t,
        ) ?? connection.provider
      }
      onClose={onClose}
      size="md"
      title={t(m.disconnectTitle)}
      footer={
        <>
          <Button
            data-voice-close={disconnected ? "" : undefined}
            disabled={disconnect.isPending}
            onClick={onClose}
          >
            {t(disconnected ? commonMessages.close : commonMessages.cancel)}
          </Button>
          {!disconnected ? (
            <Button
              loading={disconnect.isPending}
              onClick={() => disconnect.mutate()}
              tone="danger"
            >
              {t(m.disconnect)}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="px-5 py-4">
        <p className="text-sm text-muted-foreground">{t(m.disconnectBody)}</p>
        {ended ? (
          <div
            className="mt-4 space-y-1 border-y border-border py-3 text-sm"
            role="status"
          >
            <p>{t(m.accessStopped)}</p>
            <p className="text-muted-foreground">
              {t(providerAuthorization(ended))}
            </p>
          </div>
        ) : null}
        {disconnect.error || current.error ? (
          <p className="mt-3 text-sm text-app-danger" role="alert">
            {errorMessage(
              disconnect.error ?? current.error,
              t(m.accountNotDisconnected),
            )}
          </p>
        ) : null}
      </div>
    </ModalDialog>
  );
}

function ConnectionStatus({
  status,
  unconfirmed,
}: {
  status: TeamHubExternalConnection["status"];
  unconfirmed: boolean;
}) {
  const t = useT();
  return (
    <StatusPill tone={status === "active" ? "success" : "warning"}>
      {t(
        status === "active"
          ? m.statusActive
          : unconfirmed
            ? m.statusNotConfirmed
            : m.statusDisconnecting,
      )}
    </StatusPill>
  );
}

function errorMessage(error: unknown, fallback: string) {
  if (error instanceof TeamHubError || error instanceof Error)
    return error.message;
  return fallback;
}

/** How far the provider is with taking the authorization back. */
function providerAuthorization(connection: TeamHubExternalConnection) {
  if (connection.status === "revoked") return m.providerAuthorizationRevoked;
  if (connection.status_error_code?.startsWith("provider_revoke_"))
    return m.providerAuthorizationRetrying;
  return m.providerAuthorizationPending;
}
