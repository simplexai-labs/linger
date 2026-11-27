// Which Connected App account a card offers and how a Connection starts or
// resumes, as the web's connection-state.ts and its connection
// authorization card decide. The TeamHub calls are passed in, so these run
// in Node.
import type { ExternalApp, ExternalConnection } from "../api/types";

/** The Feishu Mail app, which the computer's lark-cli has to set up first. */
export const FEISHU_MAIL = "feishu_mail";

/** A Connection that is broken but can be repaired by signing in again. */
export function needsAttention(connection: ExternalConnection): boolean {
  return (
    (connection.status === "expired" || connection.status === "failed") &&
    connection.status_error_code !== "duplicate_remote_principal"
  );
}

/**
 * The pending Connection of an app whose sign-in can still be resumed, so a
 * new attempt reuses it instead of adding another.
 */
export function openPendingConnection(
  connections: readonly ExternalConnection[],
  appKey: string,
): ExternalConnection | undefined {
  return connections.find(
    (connection) =>
      connection.provider === appKey &&
      connection.status === "pending" &&
      !connection.status_error_code,
  );
}

/** The Connect Link of a pending sign-in while it can still be opened. */
export function usableConnectUrl(
  authorization: { connect_url?: string; connect_expires_at?: string } = {},
  now = Date.now(),
): string | undefined {
  const { connect_url: url, connect_expires_at: expires } = authorization;
  return url && (!expires || Date.parse(expires) > now) ? url : undefined;
}

/** The open Connect Link of a reauthorization in progress, if any. */
export function reauthorizationConnectUrl(
  connection: ExternalConnection | undefined,
  now = Date.now(),
): string | undefined {
  if (!connection?.reauthorizing) return undefined;
  return usableConnectUrl(
    {
      connect_url: connection.reauthorization_connect_url,
      connect_expires_at: connection.reauthorization_connect_expires_at,
    },
    now,
  );
}

/** Whether a new account of the app can be connected for an Agent. */
export function canConnectNewAccount(app: ExternalApp | undefined): boolean {
  return (
    app?.availability === "available" &&
    app.capabilities.includes("agent_tools")
  );
}

/**
 * The accounts a connection authorization offers: those the Human can use or
 * repair, plus the one this card just started while it is pending.
 * Abandoned pending attempts and rejected duplicates are not accounts.
 */
export function accountChoices(
  connections: readonly ExternalConnection[],
  appKey: string,
  started?: ExternalConnection,
): ExternalConnection[] {
  const ofApp = connections.filter((item) => item.provider === appKey);
  const choices = ofApp.filter(
    (item) => item.status === "active" || needsAttention(item),
  );
  const current =
    started && (ofApp.find((item) => item.id === started.id) ?? started);
  if (
    current?.status === "pending" &&
    !choices.some((item) => item.id === current.id)
  )
    choices.push(current);
  return choices;
}

/**
 * The account preselected: the one the Agent named when it is connected;
 * when it is not, a new account if one can be connected. Without a named
 * account, the first active one, else the first to repair.
 */
export function defaultAccount(
  choices: readonly ExternalConnection[],
  requestedAccount: string | undefined,
  canConnectNew: boolean,
): ExternalConnection | undefined {
  const fallback =
    choices.find((item) => item.status === "active") ??
    choices.find(needsAttention);
  const wanted = requestedAccount?.toLowerCase();
  if (!wanted) return fallback;
  const requested = choices.find(
    (item) => item.identity_label?.toLowerCase() === wanted,
  );
  return requested ?? (canConnectNew ? undefined : fallback);
}

export interface ConnectionCalls {
  get(connectionId: string): Promise<ExternalConnection>;
  create(appKey: string): Promise<ExternalConnection>;
  reauthorize(connection: ExternalConnection): Promise<ExternalConnection>;
}

/** The app cannot be connected for an Agent, so there is nothing to start. */
export class AppUnavailableForAgents extends Error {
  constructor() {
    super("This app is unavailable for Agent access");
    this.name = "AppUnavailableForAgents";
  }
}

export interface PreparedAuthorization {
  /** The Connection the approval names. */
  readonly connection: ExternalConnection;
  /** The sign-in to open after approving; none for an active Connection. */
  readonly connectUrl?: string;
  /** Whether the Connection was started for this card. */
  readonly started: boolean;
}

/**
 * The Connection a connection authorization approves, started or resumed
 * before the approval so the Human's consent names it: a pending choice
 * resumes its link, a broken one reauthorizes (or, for an app that cannot
 * verify the same account again, becomes a new one), and a new account
 * resumes an open attempt of the app before creating another.
 */
export async function prepareAuthorization(input: {
  readonly app: ExternalApp | undefined;
  readonly chosen: ExternalConnection | undefined;
  readonly connections: readonly ExternalConnection[];
  readonly calls: ConnectionCalls;
}): Promise<PreparedAuthorization> {
  const { app, calls } = input;
  let connection = input.chosen;
  let connectUrl: string | undefined;
  if (
    app?.supports_reauthorization === false &&
    connection &&
    (connection.status === "failed" || connection.status === "expired")
  )
    connection = undefined;
  // A pending sign-in whose link expired starts over.
  if (connection?.status === "pending") {
    connectUrl = usableConnectUrl(await calls.get(connection.id));
    if (!connectUrl) connection = undefined;
  }
  if (!connection) {
    if (!app || !app.capabilities.includes("agent_tools"))
      throw new AppUnavailableForAgents();
    const pending = openPendingConnection(input.connections, app.key);
    // A pending attempt that cannot be read is abandoned for a new one.
    const detail = pending
      ? await calls.get(pending.id).catch(() => undefined)
      : undefined;
    connectUrl = usableConnectUrl(detail);
    const started = detail && connectUrl ? detail : await calls.create(app.key);
    return {
      connection: started,
      connectUrl: connectUrl ?? started.connect_url,
      started: true,
    };
  }
  if (connection.status !== "active" && !connectUrl)
    connectUrl =
      reauthorizationConnectUrl(connection) ??
      reauthorizationConnectUrl(await calls.reauthorize(connection));
  return { connection, connectUrl, started: false };
}

/**
 * The Connect Link to open for an app outside a connection authorization:
 * the open attempt's when there is one, else a new Connection's.
 */
export async function connectLink(
  appKey: string,
  connections: readonly ExternalConnection[],
  calls: Pick<ConnectionCalls, "get" | "create">,
): Promise<{ connection: ExternalConnection; connectUrl?: string }> {
  const pending = openPendingConnection(connections, appKey);
  if (pending) {
    const detail = pending.connect_url
      ? pending
      : await calls.get(pending.id).catch(() => undefined);
    const connectUrl = usableConnectUrl(detail);
    if (detail && connectUrl) return { connection: detail, connectUrl };
  }
  const created = await calls.create(appKey);
  return { connection: created, connectUrl: created.connect_url };
}
