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
  TeamHubExternalConnectionWritePolicy,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import {
  externalConnectionAgentAccessQueryKey,
  externalConnectionAgentAccessQueryOptions,
  externalConnectionQueryOptions,
  externalConnectionsQueryKey,
} from "./connected-apps-queries";
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
  const supportsAgentTools = app.capabilities.includes("agent_tools");

  return (
    <>
      <ModalDialog
        closeOnBackdrop
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
            <div className="mt-4">
              {rows.map((connection) => (
                <ConnectionRow
                  canReconnect={canAuthorize}
                  connection={connection}
                  key={connection.id}
                  supportsAgentTools={supportsAgentTools}
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
  supportsAgentTools,
  supportsAutoReminders,
  reconnecting,
  onReconnect,
  onDisconnect,
}: {
  canReconnect: boolean;
  connection: TeamHubExternalConnection;
  supportsAgentTools: boolean;
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
  const reauthorizationError =
    !connection.reauthorizing &&
    connection.reauthorization_error_code &&
    connection.reauthorization_error_code !== "stale_revision"
      ? connection.reauthorization_error_code
      : undefined;
  const authFailureMessage = !needsReconnecting
    ? null
    : connection.status_error_code === "provider_auth_failed" ||
        reauthorizationError === "provider_auth_failed"
      ? m.insufficientPermission
      : reauthorizationError === "duplicate_remote_principal"
        ? m.accountAlreadyConnected
        : connection.status === "failed" || Boolean(reauthorizationError)
          ? m.authorizationFailed
          : null;
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
      {authFailureMessage ? (
        <p className="basis-full text-xs text-app-danger" role="alert">
          {t(authFailureMessage)}
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
      {connection.status === "active" && supportsAgentTools ? (
        <ConnectionWritePolicies connection={connection} />
      ) : null}
    </div>
  );
}

function ConnectionWritePolicies({
  connection,
}: {
  connection: TeamHubExternalConnection;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const access = useQuery({
    ...externalConnectionAgentAccessQueryOptions(client, connection.id),
    enabled: expanded,
  });
  const update = useMutation({
    mutationFn: ({
      agentActorId,
      writePolicy,
    }: {
      agentActorId: string;
      writePolicy: TeamHubExternalConnectionWritePolicy;
    }) =>
      client.setExternalConnectionAgentAccess(
        connection.id,
        agentActorId,
        true,
        writePolicy,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: externalConnectionAgentAccessQueryKey(connection.id),
      });
    },
  });
  const grantedAgents = (access.data?.agents ?? []).filter(
    (item) => item.granted,
  );

  return (
    <div className="basis-full pt-2">
      <button
        aria-expanded={expanded}
        className="text-xs font-medium text-muted-foreground hover:text-foreground"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        {t(m.writePermissions)}
      </button>
      {expanded ? (
        <div className="mt-2 flex flex-col gap-2 rounded-lg border border-border/70 p-2.5">
          {access.isPending ? (
            <p className="text-xs text-muted-foreground" role="status">
              {t(m.loadingAccess)}
            </p>
          ) : access.error ? (
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-app-danger" role="alert">
                {errorMessage(access.error, t(m.connectionActionFailed))}
              </p>
              <Button size="compact" onClick={() => void access.refetch()}>
                {t(m.retryAccess)}
              </Button>
            </div>
          ) : grantedAgents.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {t(m.noAgentsWithAccess)}
            </p>
          ) : (
            grantedAgents.map((agent) => (
              <div
                className="flex items-center justify-between gap-2"
                key={agent.agent_actor_id}
              >
                <span className="truncate text-xs font-medium text-foreground">
                  {agent.agent_display_name}
                </span>
                <select
                  aria-label={t(m.writePolicyForAgent, {
                    agent: agent.agent_display_name,
                  })}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus disabled:opacity-50"
                  disabled={update.isPending}
                  onChange={(event) =>
                    update.mutate({
                      agentActorId: agent.agent_actor_id,
                      writePolicy: event.target
                        .value as TeamHubExternalConnectionWritePolicy,
                    })
                  }
                  value={agent.write_policy ?? "auto"}
                >
                  <option value="auto">{t(m.writePolicyAuto)}</option>
                  <option value="always_allow">
                    {t(m.writePolicyAlwaysAllow)}
                  </option>
                  <option value="always_ask">
                    {t(m.writePolicyAlwaysAsk)}
                  </option>
                </select>
              </div>
            ))
          )}
          {update.error ? (
            <p className="text-xs text-app-danger" role="alert">
              {errorMessage(update.error, t(m.connectionActionFailed))}
            </p>
          ) : null}
        </div>
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
    <div className="basis-full pt-2.5">
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
          <p className="mt-4 py-3 text-sm" role="status">
            {t(providerAuthorization(ended))}
          </p>
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
