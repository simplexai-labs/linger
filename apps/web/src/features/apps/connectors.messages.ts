import { defineMessages } from "@/i18n/messages";

/**
 * The Connectors page, the dialog that manages one app's accounts, the
 * connect and API key flow, and an Agent's connector access. App names,
 * account names and descriptions TeamHub sends are data and are shown as
 * they arrive.
 */
export const connectorMessages = defineMessages("connectors", {
  // Connectors page
  title: "Connectors",
  loadingConnectors: "Loading connectors...",
  connectorsUnavailable: "Connectors are unavailable.",
  filterAll: "All",
  connectorCategories: "Connector categories",
  connectedOnly: "Connected only",
  applicationConnections: "Application connections",
  noConnectedApps: "No connected apps yet.",

  // Groups of the catalog
  groupMailCalendar: "Mail & Calendar",
  groupMeetings: "Meetings",
  groupProductivity: "Productivity",
  groupMessaging: "Messaging",
  groupDesignCreative: "Design & Creative",
  groupMultimodal: "Multimodal",

  // What each app of the catalog holds
  summaryCalendly: "Scheduling links",
  summaryCanva: "Designs and presentations",
  summaryDiscord: "Servers and channels",
  summaryFalAi: "Generative media models",
  summaryFigma: "Design files",
  summaryGitHub: "Repositories and activity",
  summaryMail: "Email",
  summaryCalendar: "Calendars and events",
  summaryGoogleMeet: "Video call records",
  summaryGranola: "Meeting notes",
  summaryHiggsfield: "AI images and video",
  summaryLinear: "Issues and projects",
  summaryNotion: "Pages and databases",
  summarySlack: "Workspaces and channels",

  // App card
  connected: "Connected",
  accountCount: { one: "{count} account", other: "{count} accounts" },
  // {count} is how many of the app's accounts need reconnecting.
  connectedNeedsReconnecting: {
    one: "Connected, {count} needs reconnecting",
    other: "Connected, {count} need reconnecting",
  },
  // {accounts} is two or more.
  accountsNeedReconnecting: {
    one: "{accounts} accounts, {count} needs reconnecting",
    other: "{accounts} accounts, {count} need reconnecting",
  },
  unavailable: "Unavailable",
  authorizing: "Authorizing…",
  couldNotConfirm: "Couldn't confirm connection",
  connect: "Connect",
  connectApp: "Connect {app}",
  manage: "Manage",
  disconnect: "Disconnect",
  actionsFor: "Actions for {app}",
  appIcon: "{name} icon",

  // Dialog that manages one app's accounts
  addAnotherAccount: "Add another {app} account",
  addAccount: "Add account",
  authorizationInProgress: "Authorization in progress",
  needsReconnecting: "Needs reconnecting",
  statusActive: "Active",
  statusNotConfirmed: "Not confirmed",
  statusDisconnecting: "Disconnecting",
  checkAccountAgain: "Check again {account}",
  checkAccount: "Check {account}",
  checkAgain: "Check again",
  checkConnection: "Check connection",
  reconnectAccount: "Reconnect {account}",
  reconnect: "Reconnect",
  disconnectAccount: "Disconnect {account}",
  discordUnconfirmedInDialog:
    "Discord is authorized, but the Server couldn't be confirmed. Check again, or disconnect and reconnect.",
  connectionUnconfirmed:
    "The connection couldn't be confirmed yet. Check again.",
  connectionActionFailed: "Connection action failed.",
  accountAlreadyConnected: "This account is already connected.",
  // Shown when the account name is the sign-in name, not the mailbox.
  signedInAs: "Signed in as {account}",
  autoReminders: "Auto reminders",
  autoRemindersHint:
    "Agents check this account for things that need your attention.",
  autoRemindersFor: "Auto reminders for {account}",
  autoRemindersNotUpdated: "Auto reminders could not be updated.",

  // Disconnect account dialog
  disconnectTitle: "Disconnect account?",
  disconnectBody:
    "Agents lose access to this account. Content already imported is kept.",
  accessStopped: "App access stopped in Linger.",
  providerAuthorizationRevoked: "Provider authorization: revoked",
  providerAuthorizationRetrying: "Provider authorization: retrying",
  providerAuthorizationPending: "Provider authorization: pending",
  accountNotDisconnected: "Account could not be disconnected.",

  // Authorization errors
  insufficientPermission:
    "This app did not grant enough permission. Reconnect and approve all requested access.",
  discordUnconfirmedFromApps:
    "Discord is authorized, but the Server couldn't be confirmed. Check it again from Apps.",
  authorizationFailed:
    "Authorization failed. Reconnect this app and approve the requested access.",

  // Connect flow
  connectionNotStarted: "Connection could not be started.",
  reconnectNotStarted: "Reconnecting could not be started. Try again.",
  popupBlocked: "Your browser blocked the authorization popup.",
  openAuthorizationWindow: "Open authorization window",
  keyNoLongerAccepted:
    "Composio no longer accepts the saved API key. Save a new key to keep connecting apps.",
  keyRejected: "Composio rejected this deployment's API key.",
  connectThroughComposio:
    "Connect {app} securely through Composio. Add your API key once to enable your connectors.",
  updateServerKey:
    "Update <code>COMPOSIO_API_KEY</code> where the server reads it. When Linger is installed on this computer, that is <code>user.env</code>; reopen the Linger app afterwards.",
  notConfigured:
    "Connecting Gmail, GitHub, Slack, Notion and other apps needs a Composio API key. When Linger is installed on this computer, set <code>COMPOSIO_API_KEY</code> in <code>user.env</code>, then reopen the Linger app. On a server you run yourself, set it there, or set <code>TEAMHUB_SECRET_ENCRYPTION_KEY</code> to save the key here.",

  // API key guide and form. Read All and Write All are labels in Composio.
  getYourApiKey: "Get your API key",
  getAKey: "Get a key",
  composioKeyNote:
    "Permissions cannot be changed after a key is created. If Write All was not selected, create a new key. Read-only keys cannot create the authorization needed to connect apps.",
  composioStepOpen: "Open Composio and sign in or create an account.",
  composioStepCreate:
    "Create a project API key and select <strong>Read All</strong> and <strong>Write All</strong> before creating it.",
  composioStepPaste: "Copy the key, paste it below, and select Save key.",
  composioStepReturn:
    "Return to your app, select Connect, and complete authorization.",
  composioApiKey: "Composio API key",
  composioKeyHint:
    "Use a key with full read and write access (Read All and Write All). It is stored encrypted and never shown again.",
  checkingKey: "Checking key...",
  saveKey: "Save key",

  // Window the authorization returns to
  authorizationComplete: "Authorization complete",
  canCloseWindow: "You can close this window.",

  // Steps when the Feishu app behind lark-cli lacks the mail permissions
  feishuScopesTitle:
    "The Feishu app your lark-cli uses needs mail permissions first",
  feishuScopesStepOpen:
    "Open the app's permissions page in the Feishu developer console.",
  feishuScopesOpenConsole: "Open permissions page",
  feishuScopesStepAdd: "Add these as user permissions:",
  feishuScopesList: "Mail permissions to add",
  feishuScopesStepPublish:
    "Create a new version and publish it. Your admin may need to approve it.",

  // Steps when the Computer that runs Another Me cannot connect Feishu Mail
  feishuCliMissingTitle:
    "lark-cli is not installed on the Computer that runs your Another Me",
  feishuCliMissingStepInstall:
    "On that Computer, open a terminal and install lark-cli:",
  feishuCliNotSetUpTitle:
    "lark-cli on the Computer that runs your Another Me is not set up yet",
  feishuCliNotSetUpStepRun:
    "On that Computer, open a terminal and run this. It prints a link: open it in a browser to finish.",
  feishuComputerOfflineTitle:
    "The Computer that runs your Another Me is offline",
  feishuComputerOfflineStepOpen:
    "On that Computer, open Linger and make sure you are signed in.",
  feishuComputerUnavailableTitle:
    "The Computer that runs your Another Me could not check lark-cli",
  feishuComputerUnavailableStepCheck:
    "Make sure Linger on that Computer is online and up to date.",

  feishuCheckAgain: "Check again",

  // Web search backends, beside the app groups. Backend names, descriptions
  // and free tier text come from TeamHub.
  filterWebSearch: "Web search",
  loadingWebSearch: "Loading web search...",
  defaultBackend: "Default",
  searchKeyRejected: "Key rejected",
  // {usage} is what is left on the account, such as "1,000 credits left".
  connectedWithUsage: "Connected · {usage}",
  freeLimited: "Free, limited",
  factDoes: "Does",
  searchesAndReads: "Searches the web and reads pages",
  searches: "Searches the web",
  factFreeTier: "Free tier",
  factFreeUse: "Free use",
  factUsage: "Usage",
  apiKey: "API key",
  replaceKey: "Replace key",
  removeKey: "Remove key",
  savedKeyRefused: "{backend} refused the saved key. Paste a new one.",
  savedKeyUnverified:
    "A key is saved. {backend} has no key check, so the first search proves it.",
  keySaved: "A key is saved.",
  defaultSearchBackend: "Default search backend",
  defaultChosen: "Your Agents search with {backend} when they name no backend.",
  defaultFirstReady:
    "Your Agents search with {backend} when they name no backend, because it is the first ready one in the default order.",
  defaultOffer:
    "Make {backend} the backend your Agents search with when they name none.",
  defaultNeedsKey: "Add a key to make {backend} the default.",
  clearDefault: "Clear default",
  makeDefault: "Make default",
  usageAfterFirstSearch: "Usage shows after the first search",
  usageUnavailable: "Usage unavailable right now",
  // {amount} is a number or "remaining / limit", such as "40 / 1,000".
  usageLeft: "{amount} left",
  usageCreditsLeft: "{amount} credits left",
  usageRequestsLeft: "{amount} requests left",
  // {when} is relative, such as "2 hours ago".
  usageAsOf: "{left}, as of the last search {when}",

  // An Agent's connector access
  agentAccounts: "Accounts this Agent can use",
  noConnectedAccounts: "No connected accounts yet.",
  connectAnotherApp: "Connect another app",
  connectionPending: "Connection pending",
  connectionNeedsAttention: "Connection needs attention",
  accessUnavailable: "Access unavailable for this Agent",
  loadingAccess: "Loading access...",
  retryAccess: "Retry access",
  allowAgentAccess: "Allow Agent access to {account}",
});
