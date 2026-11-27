import { defineMessages } from "@/i18n/messages";

/** Settings › Computers: the list, one Computer's detail, and its dialogs. */
export const computersMessages = defineMessages("computers", {
  // The page and the list of Computers.
  pageTitle: "Computers",
  allComputers: "All computers",
  connect: "Connect",
  directoryLabel: "Local computers directory",
  computersSummary: {
    one: "{count} computer",
    other: "{count} computers",
  },
  onlineCount: "{count} online",
  thisComputer: "This computer",
  reconnecting: "Reconnecting…",
  offline: "Offline",
  offlineSince: "Offline · {time}",
  updateRequired: "Update required",
  signInToApp: "Sign in to {app}",
  updateApp: "Update {app}",
  couldNotCheckApp: "Couldn't check {app}",
  setUpApp: "Set up {app}",
  ready: "Ready",
  readyRunning: "Ready · {count} running",

  // Empty and unavailable states.
  unavailableTitle: "Computer unavailable",
  unavailableBody:
    "This Computer is offline or no longer available to your account.",
  backToComputers: "Back to computers",
  setupCommands: "Setup commands",
  connectDialogTitle: "Connect a computer",
  noComputersTitle: "Run Agents on your computer",
  noComputersBody: "About 2 minutes to set up.",

  // One Computer's detail.
  detailsLabel: "{computer} details",
  agents: "Agents",
  aiApps: "Harness",
  aiAppsHint: "One ready harness is enough.",
  inUse: "In use",
  scrollLeft: "Scroll left",
  scrollRight: "Scroll right",
  systemSection: "System",
  manageLocalModels: "Manage local models",
  manageLocalModelsHint: "Download and load models that run on this computer",
  preventSleep: "Prevent sleep",
  preventSleepHint:
    "Keeps this computer awake for overnight Memory and Wiki tasks.",
  preventSleepFailed: "Could not update sleep setting. Try again.",
  access: "Access",
  accessDescription: "Browser & folders",
  foldersCount: {
    one: "{count} folder",
    other: "{count} folders",
  },
  advanced: "Advanced",
  update: "Update",
  updateTo: "Update to {version}",
  updateLingerComputer: "Update Linger Computer",
  updateInstructions:
    "Wait for running tasks to finish, then run this on {computer}. Your Agents stay connected.",
  checkAgain: "Check again",
  appVersion: "App {version}",
  lingerTooOld: "This app version is too old to run Agents",
  lingerRunning: "The Linger app is running",
  connected: "Connected",
  agentsUseApp: "Agents use {app} here",
  appSignedOut: "{app} is installed",
  signIn: "Sign in",
  appTooOld: "{app} is too old to run Agents",
  needAiApp: "Agents need Claude Code, Codex or Pi on this computer",
  turnOn: "Turn it on",
  turnOnHint: "It usually reconnects by itself.",
  startApp: "Start the app",
  stillOffline: "Still offline after a minute?",
  runInTerminalOn: "Run in Terminal on {computer}:",
  reconnect: "Reconnect",
  reconnectHint: "For a reset or replaced computer.",
  add: "Add",
  notInstalled: "Not installed",
  needsNewerLinger: "Needs a newer Linger",
  needsNewerLingerHint: "Update Linger on {computer} to add {app}",
  lastSeenSignedOut: "Last seen signed out",
  lastCheckFailed: "Last check failed",
  lastSeenOutdated: "Last seen outdated",
  lastSeenReady: "Last seen ready",
  notCheckedYet: "Not checked yet",
  signedOut: "Signed out",
  couldNotCheck: "Couldn't check",
  updateNeeded: "Update needed",
  checkAgainOn: "Check again in Terminal on {computer}:",
  workspaceHint: "Where Agents keep their work on this computer",
  agentsCanView: "Agents can view here",
  agentsCanEdit: "Agents can edit here",
  app: "App",
  notReported: "Not reported",
  versionAvailable: "{version} available",
  computerId: "Computer ID",
  troubleshoot: "Troubleshoot",
  toolStatus: "Status",
  toolRestart: "Restart",
  toolRecheck: "Re-check",
  toolStop: "Stop",
  removeComputer: "Remove computer",
  runInPowerShellWindows: "Run in PowerShell on this Windows computer.",

  // AI apps and their state, as other pages list them too.
  descriptionClaude: "Anthropic's coding agent",
  descriptionCodex: "OpenAI's coding agent",
  descriptionPi: "Open-source coding agent",
  descriptionAntigravity: "Google's coding agent",
  statusSignInRequired: "Sign-in required",
  statusCouldNotCheck: "Could not check",
  statusChecking: "Checking",
  statusDownloadingModel: "Downloading model",
  statusLoadingModel: "Loading model",
  statusModelNeeded: "Model needed",

  // The Agents on a Computer.
  noAgents: "No Agents on this computer yet. Create one from Chats.",
  tasksRunning: {
    one: "{count} task running",
    other: "{count} tasks running",
  },
  appSignInNeeded: "{app} sign-in needed",
  statusUnavailable: "Status unavailable",
  agentsNeedAttention: {
    one: "{count} needs attention",
    other: "{count} need attention",
  },
  agentsOffline: "{count} offline",
  agentsStatusUnavailable: "{count} status unavailable",

  // Setting up one AI app.
  computerOffline: "{computer} is offline",
  appReady: "{app} is ready",
  checkingApp: "Checking {app}…",
  setupAccountHint:
    "On {computer}, in the same account you used to connect it.",
  stepInstall: "Install",
  piLoginHint: "Then type /login in Pi",
  signInPageHint: "A sign-in page opens in your browser",
  pasteIntoTerminal: "Paste into Terminal on {computer}",
  runThenSignIn: "Run this, then sign in on the page that opens",

  // The page the CLI opens to connect a Computer.
  connectName: "Connect {computer}",
  reconnectName: "Reconnect {computer}",
  localRuntimeAccess: "Local runtime access",
  localRuntimeAccessBody: "Your Agents can run on this computer.",
  loadingSpaces: "Loading spaces...",
  spacesUnavailable: "Spaces are unavailable.",
  noSpace: "No space is available for this account.",
  space: "Space",
  signedInAs: "Signed in as <email>{email}</email>",
  confirmReplacement: "Confirm Local Computer replacement",
  replacementRemoved:
    "This Computer was removed from the signed-in account. The old Computer and its Agents stay on the server.",
  replacementWrongAccount:
    "This Computer can't be renewed by the signed-in account. The old Computer and its Agents stay on the server.",
  keepCurrentSetup: "Keep current setup",
  replaceLocalIdentity: "Replace local identity",
  connectFailed: "The Computer could not be connected. Run setup again.",
  signingOut: "Signing out...",
  useAnotherAccount: "Use another account",
  connectingRequest: "Connecting...",
  reconnectComputer: "Reconnect computer",
  invalidRequestTitle: "Connection request is invalid",
  invalidRequestBody: "Return to the terminal and run setup again.",
  couldNotConnect: "Could not connect",

  // The gate shown until a Computer can run Another Me.
  gateTitle: "Connect your computer",
  gateIntro:
    "Your Agents run on your own computer with Claude Code, Codex or Pi. Connect one to start.",
  gateReady: "Your computer is ready. Creating your Another Me...",
  installTheCli: "Install the CLI",
  setUpAiApp: "Set up an AI app",
  availableOnceOnline: "Available once your computer is online.",
  signOut: "Sign out",
  waitingForComputer:
    "Waiting for your computer. Approve the request when it opens in your browser.",
  computerNeedsUpdate:
    "{computer} needs an update. Run the command in step 1 again on it.",
  computerOfflineStart:
    "{computer} is offline. Start it with <code>{command}</code>.",
  computerOnline: "{computer} is online.",
  orRunLocalModel:
    "Or run a model on {computer} itself: load one in <link>Settings › Models</link>.",
  checkingComputer: "Checking {computer}. Changes show up within a minute.",

  // Removing a Computer.
  removeTitle: "Remove Local Computer",
  removeDescription:
    "This revokes <strong>{computer}</strong> and removes it from this workspace.",
  noOtherComputer:
    "No other computer can take these Agents. Connect your new computer first.",
  moveAndRemove: {
    one: "Move {count} Agent and remove",
    other: "Move {count} Agents and remove",
  },
  moveDeleteAndRemove: "Move, delete and remove",
  deleteAndRemove: "Delete and remove",
  deleteAgentHint:
    "Removes this Agent from every Room and deletes your direct chat with it.",
  anotherMeNeedsComputer:
    "Another Me can't be deleted. Connect another computer to move it.",
  agentNeedsComputer:
    "Connect another computer to move this Agent, or delete it.",
  assignedAgents: "Assigned Agents",
  assignedAgentsMoveFirst: "Assigned Agents move first",
  targetFor: "Target for {name}",
  chooseTarget: "Choose a target",
  deleteAgentInstead: "Delete this Agent instead",
  moveFailed: "Failed: {message}",
  deleted: "Deleted",
  deleting: "Deleting…",
  moved: "Moved",
  moving: "Moving…",

  // Connecting the user's Chrome to a Computer.
  connectChromeIntro: "Let Agents on <name>{computer}</name> use your Chrome.",
  loadingComputers: "Loading your Computers…",
  cannotLoadComputers: "Can't load your Computers right now.",
  computerNoLongerConnected:
    "This Computer is no longer connected to your account.",
  noLocalComputerYet:
    "You don't have a Local Computer yet. Connect one in Settings > Computers first. Cloud Computers can't use your browser.",
  computer: "Computer",
  computerOfflineOption: "{computer} (offline)",
  replaceToken: "Replace token",
  disconnect: "Disconnect",
  disconnecting: "Disconnecting…",
  extensionToken: "Extension token",
  pasteTokenFromExtension: "Paste the token from Playwright Extension",
  noExtensionYet: "No extension yet? <link>Install Playwright Extension</link>",
  connectingUpToMinute: "Connecting, up to 1 minute…",
  checkingBrowserStatus: "Checking browser status…",
  browserComputerOffline:
    "This Computer is offline. Make sure it's on and running Linger Computer.",
  browserUnavailableOffline: "Unavailable while this computer is offline.",
  agentsCanUseChrome: "Agents can use your Chrome",
  chromeOptional: "Optional · let Agents use your Chrome",
  connectChrome: "Connect Chrome",
  manage: "Manage",
  agentsUseSignIns: "Agents use your sign-ins.",
  agentsBrowseWithoutSignIns: "Agents browse without your sign-ins.",
  agentsAskBeforeBrowsing: "Agents ask before browsing.",

  // What a Computer reports about its browser.
  browserConnectedLabel: "Browser tasks use your Chrome and its sign-ins.",
  tokenExpired: "Token expired",
  tokenExpiredLabel: "Copy a new token from the extension, then reconnect.",
  chromeUnavailable: "Chrome unavailable",
  chromeUnavailableLabel: "Open Chrome on this Computer, then reconnect.",
  extensionUnavailable: "Extension unavailable",
  extensionNotFound:
    "Playwright Extension not found. Install and enable it in Chrome, then reconnect.",
  notConnected: "Not connected",
  notConnectedLabel:
    "Agent browser tasks wait until you connect your everyday Chrome.",
  isolatedLabel: "Agents use a separate browser without your sign-ins.",
  notSupported: "Not supported",
  unsupportedLabel:
    "This Computer can't use your browser. Agents use a separate browser without your sign-ins.",
  browserStatus: "Browser status",
  browserStatusUnknown: "Browser status unknown",

  // Why connecting the browser failed.
  browserInvalidToken:
    "Can't read this token. Copy the full line that starts with PLAYWRIGHT_MCP_EXTENSION_TOKEN=, or only the token after the equals sign.",
  browserComputerNotFound:
    "Can't find this Computer. It may have been removed.",
  browserOutdated:
    "Linger Computer on this Computer is out of date. Update it, then connect your browser.",
  browserTimeout:
    "Connection timed out. Make sure Chrome is open and the extension is enabled, then try again.",
  browserTokenRejected:
    "The extension didn't accept this token. Copy the current token from the extension, then reconnect.",
  chromeNotInstalled:
    "Google Chrome isn't installed on this Computer. Install Chrome first.",
  browserBusy: "An Agent task is using this Chrome. Connect after it finishes.",
  browserConnectionDamaged:
    "The saved browser connection on this Computer is damaged. Paste a token to reconnect.",
  browserConnectFailed:
    "This Computer couldn't connect to your browser. Try again later.",
  browserConnectUnavailable:
    "Can't connect to the browser right now. Try again later.",
});
