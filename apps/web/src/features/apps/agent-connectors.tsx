import {
  ArrowRight01Icon,
  PlugSocketIcon,
  PlusSignIcon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/ui/icon";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowText,
} from "@/components/ui/settings-group";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type {
  TeamHubExternalApp,
  TeamHubExternalConnection,
  TeamHubExternalConnectionWritePolicy,
} from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { useT } from "@/i18n/use-translation";

import { AppLogo } from "./app-logo";
import {
  establishedExternalConnections,
  accountIdentityText,
} from "./connection-state";
import {
  externalAppsQueryOptions,
  externalConnectionsQueryOptions,
  externalConnectionAgentAccessQueryKey,
  externalConnectionAgentAccessQueryOptions,
} from "./connected-apps-queries";
import { connectorMessages as m } from "./connectors.messages";

export function AgentConnectors({
  agentActorId,
  tenantId,
}: {
  agentActorId: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const t = useT();
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery(externalConnectionsQueryOptions(client));
  const groupLabel = t(m.agentAccounts);
  if (apps.isPending || connections.isPending)
    return (
      <SettingsGroup ariaLabel={groupLabel}>
        <SettingsRow icon={<Icon icon={PlugSocketIcon} size={16} />}>
          <p className="flex-1 text-[14px] text-muted-foreground" role="status">
            {t(m.loadingConnectors)}
          </p>
        </SettingsRow>
      </SettingsGroup>
    );
  if (apps.error || connections.error)
    return (
      <SettingsGroup ariaLabel={groupLabel}>
        <SettingsRow icon={<Icon icon={PlugSocketIcon} size={16} />}>
          <p
            className="min-w-0 flex-1 text-[14px] text-app-danger"
            role="alert"
          >
            {apps.error?.message ?? connections.error?.message}
          </p>
          <Button
            size="compact"
            onClick={() =>
              void Promise.all([apps.refetch(), connections.refetch()])
            }
          >
            <Icon icon={RefreshIcon} size={14} />
            {t(commonMessages.retry)}
          </Button>
        </SettingsRow>
      </SettingsGroup>
    );
  const visible = establishedExternalConnections(
    connections.data?.connections ?? [],
  );
  const connected = (apps.data?.apps ?? []).flatMap((app) => {
    if (!app.capabilities.includes("agent_tools")) return [];
    const accounts = visible.filter(
      (connection) => connection.provider === app.key,
    );
    return accounts.length ? [{ app, accounts }] : [];
  });
  const appsPath = `/t/${tenantId}/apps`;
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup ariaLabel={groupLabel}>
        {connected.length ? (
          connected.map(({ app, accounts }) => (
            <section key={app.key} aria-label={app.display_name}>
              {accounts.map((connection) => (
                <AgentConnectionAccess
                  key={connection.id}
                  agentActorId={agentActorId}
                  app={app}
                  connection={connection}
                  managePath={`${appsPath}?app=${app.key}`}
                  tenantId={tenantId}
                />
              ))}
            </section>
          ))
        ) : (
          <SettingsRow icon={<Icon icon={PlugSocketIcon} size={16} />}>
            <SettingsRowText muted title={t(m.noConnectedAccounts)} />
          </SettingsRow>
        )}
      </SettingsGroup>
      <SettingsGroup>
        <Link
          to={appsPath}
          className="block transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
        >
          <SettingsRow icon={<Icon icon={PlusSignIcon} size={16} />}>
            <span className="flex-1 text-[14px] font-medium text-foreground">
              {t(m.connectAnotherApp)}
            </span>
            <Icon
              className="text-muted-foreground/70"
              icon={ArrowRight01Icon}
              size={14}
            />
          </SettingsRow>
        </Link>
      </SettingsGroup>
    </div>
  );
}

function AgentConnectionAccess({
  agentActorId,
  app,
  connection,
  managePath,
  tenantId,
}: {
  agentActorId: string;
  app: TeamHubExternalApp;
  connection: TeamHubExternalConnection;
  managePath: string;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const t = useT();
  const access = useQuery({
    ...externalConnectionAgentAccessQueryOptions(client, connection.id),
    enabled: connection.status === "active",
  });
  const update = useMutation({
    mutationFn: ({
      granted,
      writePolicy,
    }: {
      granted: boolean;
      writePolicy?: TeamHubExternalConnectionWritePolicy;
    }) =>
      writePolicy === undefined
        ? client.setExternalConnectionAgentAccess(
            connection.id,
            agentActorId,
            granted,
          )
        : client.setExternalConnectionAgentAccess(
            connection.id,
            agentActorId,
            granted,
            writePolicy,
          ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: externalConnectionAgentAccessQueryKey(connection.id),
      });
    },
  });
  const agent = access.data?.agents.find(
    (item) =>
      item.agent_actor_id === agentActorId && item.tenant_id === tenantId,
  );
  const inactive = connection.status !== "active";
  const failure = update.error ?? access.error;
  const description = failure ? (
    <span className="text-app-danger" role="alert">
      {failure.message}
    </span>
  ) : inactive ? (
    <span
      className={connection.status === "pending" ? "town-shimmer-text" : ""}
    >
      {t(
        connection.status === "pending"
          ? m.connectionPending
          : m.connectionNeedsAttention,
      )}
    </span>
  ) : access.data && !agent ? (
    t(m.accessUnavailable)
  ) : (
    accountIdentityText(connection.provider, connection.identity_label, t)
  );
  return (
    <SettingsRow
      icon={
        <AppLogo name={app.display_name} size="profile" url={app.logo_url} />
      }
    >
      <SettingsRowText
        description={description}
        muted={inactive}
        title={app.display_name}
      />
      {inactive ? (
        <Link
          className="shrink-0 text-xs font-medium text-app-link hover:underline"
          to={managePath}
        >
          {t(m.manage)}
        </Link>
      ) : access.isPending ? (
        <span className="shrink-0 text-xs text-muted-foreground" role="status">
          {t(m.loadingAccess)}
        </span>
      ) : access.error ? (
        <Button size="compact" onClick={() => void access.refetch()}>
          {t(m.retryAccess)}
        </Button>
      ) : (
        <div className="flex shrink-0 items-center gap-2">
          {agent?.granted ? (
            <select
              aria-label={t(m.writePolicyFor, {
                account: connection.identity_label || connection.provider,
              })}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-app-focus disabled:opacity-50"
              disabled={update.isPending}
              onChange={(event) =>
                update.mutate({
                  granted: true,
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
              <option value="always_ask">{t(m.writePolicyAlwaysAsk)}</option>
            </select>
          ) : null}
          <input
            type="checkbox"
            role="switch"
            aria-label={t(m.allowAgentAccess, {
              account: connection.identity_label || connection.provider,
            })}
            checked={agent?.granted ?? false}
            disabled={!agent || update.isPending}
            onChange={(event) =>
              update.mutate({ granted: event.target.checked })
            }
            className="agent-connector-switch"
          />
        </div>
      )}
    </SettingsRow>
  );
}
