import {
  AlertCircleIcon,
  Cancel01Icon,
  Clock01Icon,
  Loading03Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

import { Button } from "@/components/ui/button";
import type { IconSvgElement } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import {
  externalAppsQueryOptions,
  externalConnectionQueryOptions,
  externalConnectionsQueryKey,
  externalConnectionsQueryOptions,
} from "@/features/apps/connected-apps-queries";
import {
  externalConnectionNeedsAttention,
  openPendingExternalConnection,
  reauthorizationConnectUrl,
  startReauthorization,
  usableConnectUrl,
  accountIdentityText,
} from "@/features/apps/connection-state";
import {
  FeishuConnectGuide,
  isFeishuConnectError,
  useFeishuMailSetup,
} from "@/features/apps/feishu-connect-guide";
import { connectorMessages } from "@/features/apps/connectors.messages";
import { openOAuthUrl } from "@/features/apps/oauth-popup";
import type { TeamHubError } from "@/features/teamhub/teamhub-error";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";
import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";
import { commonMessages } from "@/i18n/common.messages";
import { translate } from "@/i18n/language";
import type { Message } from "@/i18n/messages";
import { useT } from "@/i18n/use-translation";

import { decisionCardHeading } from "./card-prompts";
import { CardActions, CardError, CardRow } from "./approval-card-parts";
import { CardBox, CardDone, type ReceiptTone } from "./card-shell";
import { cardsMessages } from "./cards.messages";
import { ConnectedAppIcon } from "./connected-app-identity";
import { connectedAppDisplayName } from "./connected-app-names";
import type { DecisionMessageCard } from "./decision-card";
import type { RoomCardDecision } from "./room-message-card-contract";

interface Props {
  card: DecisionMessageCard;
  currentActorId?: string;
  messageId: string;
  onDecision: (decision: RoomCardDecision) => Promise<void> | void;
}

/** The account picker value for a new account; never a connection id. */
const NEW_ACCOUNT = "__new_account__";

/**
 * A connection authorization: the Human picks or connects an account of the
 * app the Agent needs. Approving records their consent to that Connection
 * before OAuth starts; TeamHub settles the card once the Connection is
 * active, and that wakes the Agent.
 */
export function ConnectionAuthDecision({
  card,
  currentActorId,
  ...rest
}: Props) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const catalog = useQuery(externalAppsQueryOptions(client));
  const appKey = card.connection_auth?.app_key ?? "";
  const appName =
    catalog.data?.apps.find((app) => app.key === appKey)?.display_name ??
    connectedAppDisplayName(appKey);

  if (card.status !== "pending" && card.status !== "authorizing") {
    const result = authorizationResult(card);
    return (
      <ConnectionAuthCard
        appKey={appKey}
        appName={appName}
        card={card}
        done={
          <CardDone
            icon={result.icon}
            text={t(result.text)}
            tone={result.tone}
          />
        }
      />
    );
  }

  return currentActorId === card.decision_owner.id ? (
    <ConnectionAuthorizationActions
      appKey={appKey}
      appName={appName}
      card={card}
      {...rest}
    />
  ) : (
    <ConnectionAuthCard appKey={appKey} appName={appName} card={card} />
  );
}

/** The Agent's ask, then the app, its account picker, and the actions. */
function ConnectionAuthCard({
  actions,
  appKey,
  appName,
  card,
  children,
  done,
  error,
  guide,
}: {
  actions?: ReactNode;
  appKey: string;
  appName: string;
  card: DecisionMessageCard;
  children?: ReactNode;
  done?: ReactNode;
  error?: string;
  /** Steps that replace the error when the Human can fix it themselves. */
  guide?: ReactNode;
}) {
  const t = useT();
  return (
    <>
      <CardBox
        heading={decisionCardHeading(card, t, { app: appName })}
        label={t(cardsMessages.labelAppAuthorization)}
      >
        <CardRow
          icon={<ConnectedAppIcon appKey={appKey} size={16} />}
          title={appName}
        />
        {card.connection_auth?.account ? (
          <p className="pb-1 text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {t(cardsMessages.requestedAccount, {
              account: card.connection_auth.account,
            })}
          </p>
        ) : null}
        {children}
        {done ??
          (card.status === "authorizing" ? (
            <CardDone
              icon={Loading03Icon}
              text={t(cardsMessages.authorizing)}
              tone="muted"
            />
          ) : null)}
        {actions ? <CardActions>{actions}</CardActions> : null}
        {guide ?? (error ? <CardError>{error}</CardError> : null)}
      </CardBox>
    </>
  );
}

/** How a settled authorization ended, in a few words. */
function authorizationResult(card: DecisionMessageCard): {
  icon: IconSvgElement;
  text: Message<string>;
  tone: ReceiptTone;
} {
  switch (card.status) {
    case "succeeded":
      return {
        icon: Tick02Icon,
        text: cardsMessages.connected,
        tone: "success",
      };
    case "denied":
      return {
        icon: Cancel01Icon,
        text: cardsMessages.notConnected,
        tone: "muted",
      };
    case "expired":
      return { icon: Clock01Icon, text: cardsMessages.expired, tone: "muted" };
    default:
      return {
        icon: AlertCircleIcon,
        text: cardsMessages.signInFailed,
        tone: "danger",
      };
  }
}

function ConnectionAuthorizationActions({
  appKey,
  appName: fallbackAppName,
  card,
  messageId,
  onDecision,
}: Omit<Props, "currentActorId"> & { appKey: string; appName: string }) {
  const t = useT();
  const { client } = useTeamHubRuntime();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState("");
  const [created, setCreated] = useState<TeamHubExternalConnection>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // A Feishu Mail connection the owner's Computer cannot make yet gets steps
  // instead of an error line.
  const [feishuError, setFeishuError] = useState<TeamHubError>();
  const [fallbackUrl, setFallbackUrl] = useState("");
  const authorizing = card.status === "authorizing";
  const boundConnectionId = card.connection_auth?.connection_id ?? "";
  const apps = useQuery(externalAppsQueryOptions(client));
  const connections = useQuery({
    ...externalConnectionsQueryOptions(client),
    enabled: !authorizing,
  });
  // The link is read once; the card itself settles from Room events.
  const bound = useQuery({
    ...externalConnectionQueryOptions(client, boundConnectionId),
    enabled: authorizing && Boolean(boundConnectionId),
  });
  const app = apps.data?.apps.find((item) => item.key === appKey);
  const appName = app?.display_name ?? fallbackAppName;
  const agentName = card.requester.display_name;
  const appConnections = (connections.data?.connections ?? []).filter(
    (item) => item.provider === appKey,
  );
  // Only accounts the Human can use or repair; abandoned pending attempts and
  // rejected duplicates are not accounts.
  const available = appConnections.filter(
    (item) =>
      item.status === "active" || externalConnectionNeedsAttention(item),
  );
  // The connection this card just started stays visible while it is pending.
  const createdNow =
    created &&
    (appConnections.find((item) => item.id === created.id) ?? created);
  if (
    createdNow?.status === "pending" &&
    !available.some((item) => item.id === createdNow.id)
  )
    available.push(createdNow);
  const canConnectNew =
    app?.availability === "available" &&
    app.capabilities.includes("agent_tools");
  // The account the Agent asked for is preselected; when it is not connected
  // yet, connecting a new account is. The Human may still choose another.
  const requestedAccount = card.connection_auth?.account?.toLowerCase();
  const requested = requestedAccount
    ? available.find(
        (item) => item.identity_label?.toLowerCase() === requestedAccount,
      )
    : undefined;
  const fallback =
    available.find((item) => item.status === "active") ??
    available.find(externalConnectionNeedsAttention);
  const defaultSelection = !requestedAccount
    ? fallback
    : (requested ?? (canConnectNew ? undefined : fallback));
  const selected =
    selectedId === NEW_ACCOUNT
      ? undefined
      : (available.find((item) => item.id === selectedId) ?? defaultSelection);
  const needsFeishuSetup =
    appKey === "feishu_mail" &&
    !authorizing &&
    !connections.isPending &&
    (selected ? selected.status !== "active" : canConnectNew);
  const setup = useFeishuMailSetup(needsFeishuSetup);
  const checkingSetup =
    needsFeishuSetup && (setup.isPending || setup.isFetching);
  const setupError = needsFeishuSetup
    ? (feishuError ?? setup.error)
    : undefined;
  const connectionError = setupError ?? feishuError;
  const guideError = isFeishuConnectError(connectionError)
    ? connectionError
    : undefined;
  const resumeUrl =
    fallbackUrl ||
    reauthorizationConnectUrl(bound.data) ||
    usableConnectUrl(bound.data);

  async function decide(decision: "approve" | "deny", connectionId?: string) {
    await onDecision({
      decision,
      connectionId,
      expectedVersion: card.version,
      messageId,
      requestId: card.decision_id,
    });
  }
  async function authorize(newAccount: boolean) {
    setBusy(true);
    setError("");
    setFeishuError(undefined);
    try {
      let connection = newAccount ? undefined : selected;
      let connectUrl = "";
      if (
        app?.supports_reauthorization === false &&
        connection &&
        ["failed", "expired"].includes(connection.status)
      )
        connection = undefined;
      // A pending authorization whose link expired starts over.
      if (connection?.status === "pending") {
        const detail = await client.getExternalConnection(connection.id);
        connectUrl = usableConnectUrl(detail) ?? "";
        if (!connectUrl) connection = undefined;
      }
      if (!connection) {
        if (!app || !app.capabilities.includes("agent_tools"))
          throw new Error(translate(cardsMessages.appUnavailableForAgents));
        // Resume an open pending attempt of this app instead of adding a row.
        const pending = openPendingExternalConnection(
          connections.data?.connections ?? [],
          app.key,
        );
        // A pending row that cannot be read is abandoned for a new one.
        const detail = pending
          ? await client
              .getExternalConnection(pending.id)
              .catch(() => undefined)
          : undefined;
        connectUrl = usableConnectUrl(detail) ?? "";
        connection =
          detail && connectUrl
            ? detail
            : await client.createExternalConnection(app.key);
        if (!connectUrl) connectUrl = connection.connect_url ?? "";
        setCreated(connection);
        setSelectedId(connection.id);
      } else if (connection.status !== "active" && !connectUrl) {
        connectUrl = (await startReauthorization(client, connection)) ?? "";
      }
      // Consent is durable before OAuth navigation; backend confirmation publishes the completion.
      await decide("approve", connection.id);
      if (connectUrl) {
        setFallbackUrl(connectUrl);
        if (openOAuthUrl(connectUrl)) setFallbackUrl("");
      }
      await queryClient.invalidateQueries({
        queryKey: externalConnectionsQueryKey(),
      });
    } catch (cause) {
      if (isFeishuConnectError(cause)) setFeishuError(cause);
      else
        setError(
          cause instanceof Error
            ? cause.message
            : translate(cardsMessages.authorizationNotStarted),
        );
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      await decide("deny");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate(cardsMessages.authorizationNotCancelled),
      );
    } finally {
      setBusy(false);
    }
  }
  const loadError = apps.error ?? connections.error ?? bound.error;
  const loading = !authorizing && (connections.isPending || apps.isPending);
  const showPicker =
    !authorizing &&
    available.length > 0 &&
    (canConnectNew || available.length > 1);
  const primaryAction = resumeUrl ? (
    <Button
      aria-label={t(cardsMessages.openAuthorizationWindow)}
      disabled={busy}
      size="large"
      tone="primary"
      onClick={() => {
        if (!openOAuthUrl(resumeUrl))
          setError(translate(cardsMessages.popupBlocked));
      }}
    >
      {t(commonMessages.open)}
    </Button>
  ) : authorizing ? null : setupError ? (
    <Button
      disabled={busy || setup.isFetching}
      onClick={() => {
        setFeishuError(undefined);
        void setup.refetch();
      }}
      size="large"
      tone="primary"
    >
      {t(connectorMessages.feishuCheckAgain)}
    </Button>
  ) : selected ? (
    <Button
      aria-label={
        selected.status === "active"
          ? t(cardsMessages.allowAgent, { name: agentName })
          : t(cardsMessages.connectApp, { name: appName })
      }
      disabled={busy || checkingSetup}
      onClick={() => void authorize(false)}
      size="large"
      tone="primary"
    >
      {t(
        selected.status === "active"
          ? cardsMessages.allow
          : cardsMessages.connect,
      )}
    </Button>
  ) : loading || canConnectNew ? (
    <Button
      aria-label={t(cardsMessages.connectApp, { name: appName })}
      disabled={busy || loading || checkingSetup}
      onClick={() => void authorize(true)}
      size="large"
      tone="primary"
    >
      {t(cardsMessages.connect)}
    </Button>
  ) : null;

  return (
    <ConnectionAuthCard
      actions={
        <>
          {primaryAction}
          <Button
            disabled={busy}
            onClick={() => void cancel()}
            size="large"
            tone="subtle"
          >
            {t(authorizing ? commonMessages.cancel : cardsMessages.notNow)}
          </Button>
        </>
      }
      appKey={appKey}
      appName={appName}
      card={card}
      guide={
        guideError ? (
          <FeishuConnectGuide className="mt-3" error={guideError} />
        ) : undefined
      }
      error={
        error ||
        (setupError instanceof Error && !guideError
          ? setupError.message
          : undefined) ||
        (loadError
          ? loadError instanceof Error
            ? loadError.message
            : t(cardsMessages.accountsNotLoaded)
          : undefined)
      }
    >
      {showPicker ? (
        <div className="pb-1">
          <Select
            aria-label={t(cardsMessages.appAccount, { app: appName })}
            className="h-8 w-full px-2.5 text-sm"
            disabled={busy}
            onValueChange={(id) => {
              setSelectedId(id);
              setFeishuError(undefined);
              setError("");
            }}
            value={selected?.id ?? (canConnectNew ? NEW_ACCOUNT : "")}
          >
            {available.map((connection) => {
              const account =
                accountIdentityText(
                  connection.provider,
                  connection.identity_label,
                ) || appName;
              return (
                <SelectItem key={connection.id} value={connection.id}>
                  {connection.status === "active"
                    ? account
                    : connection.status === "pending"
                      ? t(cardsMessages.accountPending, { account })
                      : t(cardsMessages.accountNeedsReconnecting, { account })}
                </SelectItem>
              );
            })}
            {canConnectNew ? (
              <SelectItem value={NEW_ACCOUNT}>
                {t(cardsMessages.connectNewAccount)}
              </SelectItem>
            ) : null}
          </Select>
        </div>
      ) : null}
    </ConnectionAuthCard>
  );
}
