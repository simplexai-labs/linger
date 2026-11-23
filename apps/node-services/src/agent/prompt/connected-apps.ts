/**
 * Names the catalog apps the Human can connect and routes a request that needs
 * the Human's account in one of them to the connected app commands, so an
 * unconnected app gets an authorization card instead of a browser session.
 * Public pages stay on the browser or fetch path, which needs no account.
 */
export function connectableAppsRule(keys: readonly string[]): string {
  return keys.length === 0
    ? ""
    : ` Apps the Human can connect: ${keys.join(", ")}. When a request needs the Human's account in one of these apps, to create or change something there or to read data that is not public, use teamhub apps, not the browser: with no account, run teamhub apps connect <app-key> to post an authorization card instead of asking for credentials, and end your turn; the card result wakes you. Then find the tool with teamhub apps search and run it with teamhub apps execute. Read a public page the usual way.${keys.includes("feishu_mail") ? FEISHU_MAIL_RULE : ""}`;
}

/**
 * Feishu Mail runs through the Human's own lark-cli, which an Agent on their
 * Computer could also call directly. Connecting it turns on watching their
 * inbox, and only teamhub feishu-mail holds a send for the Human's card.
 */
const FEISHU_MAIL_RULE = ` Connect feishu_mail only when the Human asks you to share their Feishu Mail with you, since connecting it also starts watching their inbox. Read and send Feishu Mail with teamhub feishu-mail, never with lark-cli mail commands, which skip the Human's confirmation card.`;

/**
 * The Connected apps line when no provider key is configured: no account or
 * app command applies yet, only the route to an authorization card.
 */
export function connectableAppsOnly(keys: readonly string[]): string {
  return keys.length === 0
    ? ""
    : `\n- Connected apps: no app has an account you can use yet.${connectableAppsRule(keys)}`;
}

/** Names the apps the Agent could use when the Run started, by app key. */
export function connectedAppsAtRunStart(keys: readonly string[]): string {
  return keys.length === 0
    ? "no app had an account you can use"
    : `these apps had an account you can use: ${keys.join(", ")}`;
}
