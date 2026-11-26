import type { TeamHubClient } from "@/features/teamhub/teamhub-client";
import type { TeamHubExternalConnection } from "@/features/teamhub/teamhub-types";
import { type Translate, translate } from "@/i18n/language";

import { connectorMessages as m } from "./connectors.messages";
import { desktopConnectorOAuth } from "./desktop-connector-oauth";

const NEEDS_ATTENTION = new Set<TeamHubExternalConnection["status"]>([
  "expired",
  "failed",
]);

export function externalConnectionNeedsAttention(
  connection: TeamHubExternalConnection,
) {
  return (
    NEEDS_ATTENTION.has(connection.status) &&
    connection.status_error_code !== "duplicate_remote_principal"
  );
}

/**
 * Whether an app's pending authorization link can be resumed in the current
 * environment. Composio-managed links bake in a single-use Desktop loopback
 * callback bound to an ephemeral port, so Desktop starts a fresh connection
 * instead of reusing an older link. Self-authorized apps such as Feishu Mail
 * use a device-login page with no loopback callback.
 */
export function canResumePendingExternalConnection(appKey: string) {
  return !desktopConnectorOAuth() || appKey === "feishu_mail";
}

/**
 * The pending connection of an app whose authorization can still be resumed,
 * so a new attempt reuses it instead of creating another row.
 */
export function openPendingExternalConnection(
  connections: TeamHubExternalConnection[],
  appKey: string,
) {
  if (!canResumePendingExternalConnection(appKey)) return undefined;
  return connections.find(
    (connection) =>
      connection.provider === appKey &&
      connection.status === "pending" &&
      !connection.status_error_code,
  );
}

export function externalConnectionEstablished(
  connection: TeamHubExternalConnection,
) {
  return ["active", "disconnecting", "revoke_pending"].includes(
    connection.status,
  );
}

export function establishedExternalConnections(
  connections: TeamHubExternalConnection[],
) {
  return connections.filter(externalConnectionEstablished);
}

/**
 * A pending connection whose identity check failed after authorization. It
 * stays listed so the user can check again or disconnect; a duplicate identity
 * is excluded because checking again cannot resolve it.
 */
export function externalConnectionUnconfirmed(
  connection: TeamHubExternalConnection,
) {
  return (
    connection.status === "pending" &&
    Boolean(connection.status_error_code) &&
    connection.status_error_code !== "duplicate_remote_principal"
  );
}

export function activeExternalConnections(
  connections: TeamHubExternalConnection[],
) {
  return connections.filter((connection) => connection.status === "active");
}

/**
 * Whether the Connect Link of a pending connection or reauthorization can
 * still be opened. An expired link needs a new authorization.
 */
export function connectLinkOpen(authorization: {
  connect_expires_at?: string;
}) {
  return (
    !authorization.connect_expires_at ||
    Date.parse(authorization.connect_expires_at) > Date.now()
  );
}

/** The Connect Link of a pending authorization while it can still be opened. */
export function usableConnectUrl(authorization?: {
  connect_url?: string;
  connect_expires_at?: string;
}) {
  return authorization?.connect_url && connectLinkOpen(authorization)
    ? authorization.connect_url
    : undefined;
}

/**
 * The Connect Link that reauthorizes a connection: the open link of one in
 * progress, otherwise a new reauthorization's.
 */
export async function startReauthorization(
  client: Pick<TeamHubClient, "createExternalConnectionReauthorization">,
  connection: TeamHubExternalConnection,
) {
  return (
    reauthorizationConnectUrl(connection) ??
    reauthorizationConnectUrl(
      await client.createExternalConnectionReauthorization(
        connection.id,
        connection.revision,
      ),
    )
  );
}

/** The open Connect Link of a reauthorization in progress, if any. */
export function reauthorizationConnectUrl(connection?: {
  reauthorizing?: boolean;
  reauthorization_connect_url?: string;
  reauthorization_connect_expires_at?: string;
}) {
  if (!connection?.reauthorizing) return undefined;
  return usableConnectUrl({
    connect_url: connection.reauthorization_connect_url,
    connect_expires_at: connection.reauthorization_connect_expires_at,
  });
}

/**
 * A connection's identity label as display text, or undefined when it has
 * none. An Outlook label is the Microsoft account's sign-in name, which can
 * belong to another mail provider, so it is never shown as the mailbox.
 */
export function accountIdentityText(
  provider: string,
  label: string | null | undefined,
  t: Translate = translate,
): string | undefined {
  if (!label) return undefined;
  return provider === "outlook" ? t(m.signedInAs, { account: label }) : label;
}
